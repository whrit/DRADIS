// SPDX-License-Identifier: AGPL-3.0-only
//
// DRADIS — autonomous trading engine for crypto prediction markets.
// Copyright (C) 2026 Michael Bordash
//
// This file is part of DRADIS. DRADIS is free software: you can redistribute it
// and/or modify it under the terms of the GNU Affero General Public License,
// version 3, as published by the Free Software Foundation.
//
// DRADIS is distributed in the hope that it will be useful, but WITHOUT ANY
// WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR
// A PARTICULAR PURPOSE. See the GNU Affero General Public License for details.
//
// You should have received a copy of the GNU Affero General Public License along
// with this program. If not, see <https://www.gnu.org/licenses/>.

//! Venue latency probe.
//!
//! Periodically times a lightweight unauthenticated GET against the trading
//! venue (Polymarket CLOB `/time` on intl builds, Polymarket US `/v1/health`
//! on US builds) and keeps a small rolling window of round-trip samples.
//!
//! The Control Tower footer surfaces the result so an operator can instantly
//! see whether their server is deployed too far from the venue — the first
//! thing to check when fills look slow. The probe measures latency **from the
//! engine host**, not from the operator's browser, which is what actually
//! matters for order execution.
//!
//! `run_latency_probe` is spawned once from `run_api_server`; `snapshot()` is
//! read by the `GET /api/latency` handler.
//!
//! The same snapshot also carries execution timing measured where it happens
//! (see [`TickGuard`] and [`record_placement`]): strategy-tick service time and
//! scheduler lateness, and order-POST round trips. Those are process-lifetime
//! histograms that reset on restart; compare two snapshots to get an interval.

use std::collections::VecDeque;
use std::sync::atomic::{AtomicU64, Ordering::Relaxed};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde::Serialize;
use tracing::debug;

/// Rolling window size — at one probe per [`PROBE_INTERVAL`] this covers the
/// last ~5 minutes.
const SAMPLE_CAP: usize = 20;
/// Seconds between probes. Cheap enough to be invisible in venue rate limits.
const PROBE_INTERVAL: Duration = Duration::from_secs(15);
/// Per-request timeout; anything slower is recorded as a failed probe.
const PROBE_TIMEOUT: Duration = Duration::from_secs(5);

struct ProbeState {
    /// Round-trip times of recent successful probes, oldest → newest, in ms.
    samples: VecDeque<u64>,
    /// Whether the most recent probe succeeded.
    last_ok: bool,
    /// Whether at least one probe has completed (success or failure).
    probed: bool,
}

static STATE: OnceLock<Mutex<ProbeState>> = OnceLock::new();

fn state() -> &'static Mutex<ProbeState> {
    STATE.get_or_init(|| Mutex::new(ProbeState {
        samples: VecDeque::with_capacity(SAMPLE_CAP),
        last_ok: false,
        probed: false,
    }))
}

/// Short venue label + probe URL for the active build.
#[cfg(feature = "intl_clob")]
fn probe_target() -> (&'static str, String) {
    ("CLOB", format!("{}/time", crate::config::CLOB_API_BASE))
}

/// Kalshi build probes the Kalshi REST exchange status (public, no auth).
#[cfg(feature = "kalshi")]
fn probe_target() -> (&'static str, String) {
    let base = crate::venues::kalshi::base_url();
    ("Kalshi API", format!("{}/exchange/status", base))
}

/// US retail build probes the venue REST health endpoint (public, no auth).
#[cfg(not(any(feature = "intl_clob", feature = "kalshi")))]
fn probe_target() -> (&'static str, String) {
    let base = std::env::var("POLYMARKET_US_BASE_URL")
        .unwrap_or_else(|_| "https://api.polymarket.us".to_string());
    ("US API", format!("{}/v1/health", base.trim_end_matches('/')))
}

/// Snapshot returned by `GET /api/latency`.
#[derive(Serialize)]
pub struct LatencySnapshot {
    /// Short label for the probed venue ("CLOB" or "US API").
    pub venue: &'static str,
    /// Whether the most recent probe succeeded.
    pub ok: bool,
    /// Whether at least one probe has completed since startup.
    pub probed: bool,
    /// Most recent successful round-trip, ms.
    pub last_ms: Option<u64>,
    /// Median of the rolling window, ms.
    pub p50_ms: Option<u64>,
    /// Number of successful samples currently in the window.
    pub samples: usize,
    /// Execution timing measured on the trading path, not by the probe.
    pub timing: ExecutionTiming,
    /// Live fill prices against the prices strategies evaluated.
    pub slippage: SlippageReport,
}

/// Current probe state for the API handler.
pub fn snapshot() -> LatencySnapshot {
    let (venue, _) = probe_target();
    let st = match state().lock() {
        Ok(s) => s,
        Err(poisoned) => poisoned.into_inner(),
    };
    let last_ms = st.samples.back().copied();
    let p50_ms = if st.samples.is_empty() {
        None
    } else {
        let mut sorted: Vec<u64> = st.samples.iter().copied().collect();
        sorted.sort_unstable();
        Some(sorted[sorted.len() / 2])
    };
    LatencySnapshot {
        venue, ok: st.last_ok, probed: st.probed, last_ms, p50_ms, samples: st.samples.len(),
        timing: timing_snapshot(),
        slippage: slippage_snapshot(),
    }
}

fn record(sample_ms: Option<u64>) {
    let mut st = match state().lock() {
        Ok(s) => s,
        Err(poisoned) => poisoned.into_inner(),
    };
    st.probed = true;
    match sample_ms {
        Some(ms) => {
            st.last_ok = true;
            if st.samples.len() == SAMPLE_CAP {
                st.samples.pop_front();
            }
            st.samples.push_back(ms);
        }
        None => st.last_ok = false,
    }
}

// ── Execution timing ─────────────────────────────────────────────────────────
//
// Capture is one relaxed atomic add per sample: no lock, no allocation, so it
// is always on and can neither slow nor gate trading. These are host-observed
// times: placement RTT is request start to parsed response, not the venue's
// matching-engine time.

/// Inclusive bucket upper bounds in microseconds; one overflow bucket follows.
const BOUNDS_US: [u64; 16] = [
    100, 250, 500, 1_000, 2_500, 5_000, 10_000, 25_000, 50_000, 100_000,
    250_000, 500_000, 1_000_000, 5_000_000, 15_000_000, 60_000_000,
];

struct Histogram {
    counts: [AtomicU64; BOUNDS_US.len() + 1],
}

/// A histogram as served by the API. Percentiles are the upper bound of the
/// bucket the rank falls in, not interpolated values; `null` with a non-zero
/// `count` means the rank is in the overflow bucket (over 60 s).
#[derive(Serialize)]
pub struct HistogramSnapshot {
    pub count: u64,
    pub p50_ms: Option<f64>,
    pub p95_ms: Option<f64>,
    pub p99_ms: Option<f64>,
    /// Per-bucket counts, aligned with `ExecutionTiming::bucket_le_us` plus overflow.
    pub counts: Vec<u64>,
}

impl Histogram {
    const fn new() -> Self {
        Self { counts: [const { AtomicU64::new(0) }; BOUNDS_US.len() + 1] }
    }

    fn record(&self, d: Duration) {
        let us = u64::try_from(d.as_micros()).unwrap_or(u64::MAX);
        self.counts[BOUNDS_US.partition_point(|&b| b < us)].fetch_add(1, Relaxed);
    }

    fn snapshot(&self) -> HistogramSnapshot {
        let counts: Vec<u64> = self.counts.iter().map(|c| c.load(Relaxed)).collect();
        let pct = |q| rank_bucket(&counts, q).and_then(|i| BOUNDS_US.get(i)).map(|&b| b as f64 / 1000.0);
        HistogramSnapshot { count: counts.iter().sum(), p50_ms: pct(0.50), p95_ms: pct(0.95), p99_ms: pct(0.99), counts }
    }
}

/// Index of the bucket holding the `q` quantile's rank, `None` when empty.
fn rank_bucket(counts: &[u64], q: f64) -> Option<usize> {
    let count: u64 = counts.iter().sum();
    let rank = ((q * count as f64).ceil() as u64).max(1);
    let mut seen = 0;
    counts.iter().position(|c| { seen += c; seen >= rank })
}

struct PlacementStats {
    acked: Histogram,
    failed: AtomicU64,
    timed_out: AtomicU64,
}

impl PlacementStats {
    const fn new() -> Self {
        Self { acked: Histogram::new(), failed: AtomicU64::new(0), timed_out: AtomicU64::new(0) }
    }
}

static TICK_SERVICE: Histogram = Histogram::new();
static TICK_LATENESS: Histogram = Histogram::new();
static TICK_OVERRUNS: AtomicU64 = AtomicU64::new(0);
static PLACE_SINGLE: PlacementStats = PlacementStats::new();
static REST_FILL_EVENT: Histogram = Histogram::new();
static REST_FILL_POLL: Histogram = Histogram::new();
static PLACE_BATCH: PlacementStats = PlacementStats::new();

/// Times one strategy tick: lateness when created, service time when dropped.
///
/// Create it first thing in the tick arm, so the drop also covers every early
/// `continue`, error return and cancellation of the tick body. Idle waiting for
/// the next tick is never inside it.
pub struct TickGuard {
    started: Instant,
    period: Duration,
}

impl TickGuard {
    /// `scheduled` is the instant `Interval::tick` returned: when the tick was
    /// due. With `MissedTickBehavior::Skip` that is the missed deadline, so a
    /// stall shows up here as lateness rather than as a burst of ticks.
    pub fn start(scheduled: tokio::time::Instant, period: Duration) -> Self {
        let started = Instant::now();
        TICK_LATENESS.record(started.saturating_duration_since(scheduled.into_std()));
        Self { started, period }
    }
}

impl Drop for TickGuard {
    fn drop(&mut self) {
        let service = self.started.elapsed();
        TICK_SERVICE.record(service);
        if service > self.period {
            TICK_OVERRUNS.fetch_add(1, Relaxed);
        }
    }
}

#[derive(Clone, Copy)]
pub enum Placement {
    /// One order per request.
    Single,
    /// A two-leg batch request.
    Batch,
}

#[derive(Clone, Copy)]
pub enum PlacementOutcome {
    /// The venue answered success and the body parsed.
    Acked,
    /// Any error: a venue refusal, transport failure or unparseable reply.
    Failed,
    /// Our own deadline expired; the order may still have landed.
    TimedOut,
}

impl PlacementOutcome {
    /// Acked for `Ok`, Failed for `Err`.
    pub fn of<T, E>(r: &Result<T, E>) -> Self {
        if r.is_ok() { Self::Acked } else { Self::Failed }
    }
}

/// Record one order POST attempt that started at `sent`. Only acknowledged
/// attempts enter the RTT histogram; the others are counted.
pub fn record_placement(kind: Placement, sent: Instant, outcome: PlacementOutcome) {
    let stats = match kind {
        Placement::Single => &PLACE_SINGLE,
        Placement::Batch => &PLACE_BATCH,
    };
    match outcome {
        PlacementOutcome::Acked => stats.acked.record(sent.elapsed()),
        PlacementOutcome::Failed => { stats.failed.fetch_add(1, Relaxed); }
        PlacementOutcome::TimedOut => { stats.timed_out.fetch_add(1, Relaxed); }
    }
}

/// How a resting order's fill was first seen.
#[derive(Clone, Copy)]
pub enum FillObserved {
    /// A venue fill event matched to the order by its id.
    Event,
    /// A positions poll found the holding: an upper bound, not the fill time.
    Poll,
}

/// Record placement → first observed fill for a resting order.
pub fn record_resting_fill(placed: Instant, how: FillObserved) {
    match how {
        FillObserved::Event => REST_FILL_EVENT.record(placed.elapsed()),
        FillObserved::Poll => REST_FILL_POLL.record(placed.elapsed()),
    }
}

// ── Slippage ────────────────────────────────────────────────────────────────

/// Signed adverse-slippage bucket upper bounds in bps, inclusive; the first
/// bucket also takes everything below it, and one overflow bucket follows.
/// Negative is price improvement.
const SLIP_BOUNDS_BPS: [i64; 13] = [-1000, -500, -250, -100, -50, -10, 0, 10, 50, 100, 250, 500, 1000];

struct SlipCohort {
    strategy: String,
    buy: bool,
    maker: bool,
    counts: [u64; SLIP_BOUNDS_BPS.len() + 1],
    adverse_usd: rust_decimal::Decimal,
    unmeasured: u64,
}

// ponytail: linear cohort lookup under one lock; fine at a few dozen
// strategy × side × intent cohorts and one update per order.
static SLIPPAGE: Mutex<Vec<SlipCohort>> = Mutex::new(Vec::new());

/// Record one execution's slippage against the price the strategy evaluated.
///
/// Adverse movement is `fill − intended` for a buy and `intended − fill` for a
/// sell, so positive always costs money. A fill whose price the venue did not
/// report (`verified == false`) equals what was asked for by construction and
/// is counted as unmeasured rather than as a perfect fill.
pub fn record_slippage(
    strategy: &str,
    buy: bool,
    maker: bool,
    intended: rust_decimal::Decimal,
    fill: rust_decimal::Decimal,
    shares: rust_decimal::Decimal,
    verified: bool,
) {
    let mut cohorts = SLIPPAGE.lock().unwrap_or_else(|e| e.into_inner());
    let i = match cohorts.iter().position(|c| c.strategy == strategy && c.buy == buy && c.maker == maker) {
        Some(i) => i,
        None => {
            cohorts.push(SlipCohort {
                strategy: strategy.to_string(), buy, maker,
                counts: [0; SLIP_BOUNDS_BPS.len() + 1],
                adverse_usd: rust_decimal::Decimal::ZERO, unmeasured: 0,
            });
            cohorts.len() - 1
        }
    };
    let c = &mut cohorts[i];
    if !verified || intended <= rust_decimal::Decimal::ZERO {
        c.unmeasured += 1;
        return;
    }
    let adverse = if buy { fill - intended } else { intended - fill };
    let bps = adverse / intended * rust_decimal::Decimal::from(10_000);
    c.counts[SLIP_BOUNDS_BPS.partition_point(|&b| rust_decimal::Decimal::from(b) < bps)] += 1;
    c.adverse_usd += adverse * shares;
}

#[derive(Serialize)]
pub struct SlippageCohort {
    pub strategy: String,
    pub side: &'static str,
    /// `maker` for post-only orders, else `taker`: what was intended, not the
    /// liquidity role the venue assigned.
    pub intent: &'static str,
    /// Measured fills.
    pub count: u64,
    /// Bucket upper bounds; `null` with a non-zero count means above 1000 bps.
    pub p50_bps: Option<i64>,
    pub p95_bps: Option<i64>,
    /// Aligned with `SlippageReport::bucket_le_bps` plus overflow.
    pub counts: Vec<u64>,
    /// Total adverse dollars over measured fills; negative is improvement.
    pub adverse_usd: f64,
    /// Fills priced at the limit because the venue reported no price.
    pub unmeasured: u64,
}

#[derive(Serialize)]
pub struct SlippageReport {
    pub bucket_le_bps: &'static [i64],
    pub cohorts: Vec<SlippageCohort>,
}

fn slippage_snapshot() -> SlippageReport {
    use rust_decimal::prelude::ToPrimitive;
    let cohorts = SLIPPAGE.lock().unwrap_or_else(|e| e.into_inner());
    let cohorts = cohorts.iter().map(|c| {
        let pct = |q| rank_bucket(&c.counts, q).and_then(|i| SLIP_BOUNDS_BPS.get(i)).copied();
        SlippageCohort {
            strategy: c.strategy.clone(),
            side: if c.buy { "buy" } else { "sell" },
            intent: if c.maker { "maker" } else { "taker" },
            count: c.counts.iter().sum(),
            p50_bps: pct(0.50),
            p95_bps: pct(0.95),
            counts: c.counts.to_vec(),
            adverse_usd: c.adverse_usd.to_f64().unwrap_or(0.0),
            unmeasured: c.unmeasured,
        }
    }).collect();
    SlippageReport { bucket_le_bps: &SLIP_BOUNDS_BPS, cohorts }
}

#[derive(Serialize)]
pub struct PlacementSnapshot {
    /// Send→ack round trips of acknowledged attempts.
    pub acked: HistogramSnapshot,
    pub failed: u64,
    pub timed_out: u64,
}

/// Execution timing since process start.
#[derive(Serialize)]
pub struct ExecutionTiming {
    pub bucket_le_us: &'static [u64],
    /// Strategy-tick body duration, all squadrons of this process.
    pub tick_service: HistogramSnapshot,
    /// How long after its due time each tick started.
    pub tick_lateness: HistogramSnapshot,
    /// Ticks whose service time exceeded the tick interval.
    pub tick_overruns: u64,
    pub placement_single: PlacementSnapshot,
    pub placement_batch: PlacementSnapshot,
    /// Resting order placement → first fill seen on the venue's fill feed.
    pub resting_fill_event: HistogramSnapshot,
    /// Resting order placement → holding found by a positions poll (upper bound).
    pub resting_fill_poll: HistogramSnapshot,
}

fn placement_snapshot(s: &PlacementStats) -> PlacementSnapshot {
    PlacementSnapshot {
        acked: s.acked.snapshot(),
        failed: s.failed.load(Relaxed),
        timed_out: s.timed_out.load(Relaxed),
    }
}

fn timing_snapshot() -> ExecutionTiming {
    ExecutionTiming {
        bucket_le_us: &BOUNDS_US,
        tick_service: TICK_SERVICE.snapshot(),
        tick_lateness: TICK_LATENESS.snapshot(),
        tick_overruns: TICK_OVERRUNS.load(Relaxed),
        placement_single: placement_snapshot(&PLACE_SINGLE),
        placement_batch: placement_snapshot(&PLACE_BATCH),
        resting_fill_event: REST_FILL_EVENT.snapshot(),
        resting_fill_poll: REST_FILL_POLL.snapshot(),
    }
}

/// Background loop: probe the venue every [`PROBE_INTERVAL`] forever.
pub async fn run_latency_probe() {
    let (venue, url) = probe_target();
    let client = match reqwest::Client::builder().timeout(PROBE_TIMEOUT).build() {
        Ok(c) => c,
        Err(e) => {
            tracing::warn!("Latency probe disabled — HTTP client build failed: {e}");
            return;
        }
    };
    tracing::info!("📶 Venue latency probe started ({venue} → {url})");
    loop {
        let started = Instant::now();
        let result = client.get(&url).send().await;
        match result {
            Ok(resp) => {
                // Drain the (tiny) body so we time the full round trip.
                let status = resp.status();
                let _ = resp.bytes().await;
                let ms = started.elapsed().as_millis() as u64;
                if status.is_success() {
                    debug!("Latency probe {venue}: {ms}ms");
                    record(Some(ms));
                } else {
                    debug!("Latency probe {venue}: HTTP {status}");
                    record(None);
                }
            }
            Err(e) => {
                debug!("Latency probe {venue} failed: {e}");
                record(None);
            }
        }
        tokio::time::sleep(PROBE_INTERVAL).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Serializes the tests in this module against each other.
    ///
    /// `record` and `snapshot` operate on one process-wide `STATE`, and cargo
    /// runs tests in parallel threads inside a single process — so without this
    /// the two tests below interleave on the same static. That is exactly how
    /// CI failed: `snapshot_reports_window_and_median` recorded a failed probe
    /// and asserted `!snap.ok`, while `window_is_capped` recorded a success in
    /// between and flipped `ok` back to true. It passed locally and failed in
    /// CI purely on thread timing.
    static TEST_GUARD: Mutex<()> = Mutex::new(());

    /// Return the shared state to its initial values so each test starts from a
    /// known point and can assert exact numbers rather than `>=` bounds.
    fn reset() {
        let mut s = state().lock().unwrap();
        s.samples.clear();
        s.last_ok = false;
        s.probed = false;
    }

    #[test]
    fn snapshot_reports_window_and_median() {
        let _guard = TEST_GUARD.lock().unwrap_or_else(|e| e.into_inner());
        reset();

        record(Some(100));
        record(Some(300));
        record(Some(200));

        let snap = snapshot();
        assert!(snap.probed);
        assert!(snap.ok);
        assert_eq!(snap.samples, 3);
        assert_eq!(snap.last_ms, Some(200));
        assert_eq!(snap.p50_ms, Some(200), "median of 100/200/300");

        // A failed probe keeps the window but flips `ok`.
        record(None);
        let snap = snapshot();
        assert!(!snap.ok);
        assert_eq!(snap.samples, 3, "a failure must not discard the window");
    }

    #[test]
    fn window_is_capped() {
        let _guard = TEST_GUARD.lock().unwrap_or_else(|e| e.into_inner());
        reset();

        for i in 0..(SAMPLE_CAP as u64 + 10) {
            record(Some(i));
        }

        let snap = snapshot();
        assert_eq!(snap.samples, SAMPLE_CAP, "the window must hold exactly the cap");
    }

    #[test]
    fn histogram_buckets_are_inclusive_and_percentiles_report_bucket_bounds() {
        let h = Histogram::new();
        let empty = h.snapshot();
        assert_eq!((empty.count, empty.p50_ms), (0, None), "no samples is unknown, not zero");

        // 100 µs is the first bucket's inclusive bound; 101 µs is the next one.
        for _ in 0..90 { h.record(Duration::from_micros(100)); }
        for _ in 0..9 { h.record(Duration::from_micros(101)); }
        h.record(Duration::from_secs(61));
        let s = h.snapshot();
        assert_eq!(s.count, 100);
        assert_eq!((s.counts[0], s.counts[1], s.counts[BOUNDS_US.len()]), (90, 9, 1));
        assert_eq!(s.p50_ms, Some(0.1));
        assert_eq!(s.p95_ms, Some(0.25), "rank 95 falls in the 101..=250 µs bucket");
        assert_eq!(s.p99_ms, Some(0.25), "rank 99 is the last in-range sample");

        h.record(Duration::from_secs(61));
        assert_eq!(h.snapshot().p99_ms, None, "a rank in the overflow bucket has no finite bound");
    }

    #[test]
    fn slippage_is_signed_adverse_and_limit_priced_fills_are_unmeasured() {
        use rust_decimal_macros::dec;
        let s = "slippage-sign-test";
        // Buying 0.51 against an evaluated 0.50 costs 200 bps.
        record_slippage(s, true, false, dec!(0.50), dec!(0.51), dec!(10), true);
        // Selling 0.51 against an evaluated 0.50 gains 200 bps.
        record_slippage(s, false, false, dec!(0.50), dec!(0.51), dec!(10), true);
        // A limit-priced fill equals its intent by construction; measured, it
        // would read as a perfect 0 bps and flatter the strategy.
        record_slippage(s, true, false, dec!(0.50), dec!(0.50), dec!(10), false);

        let r = slippage_snapshot();
        let get = |side| r.cohorts.iter().find(|c| c.strategy == s && c.side == side).unwrap();
        let (buy, sell) = (get("buy"), get("sell"));
        assert_eq!((buy.count, buy.unmeasured, buy.p50_bps), (1, 1, Some(250)));
        assert!((buy.adverse_usd - 0.10).abs() < 1e-9, "10 shares × 1¢ adverse");
        assert_eq!((sell.count, sell.p50_bps), (1, Some(-100)), "−200 bps is in the −250..=−100 bucket");
        assert!((sell.adverse_usd + 0.10).abs() < 1e-9, "improvement is negative");
    }
}
