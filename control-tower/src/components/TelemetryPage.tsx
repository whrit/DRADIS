"use client";

// SPDX-License-Identifier: AGPL-3.0-only
//
// DRADIS Control Tower — operator dashboard for the DRADIS trading engine.
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

import { useEffect, useMemo, useState } from "react";
import useSWR from "swr";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ReferenceLine,
  Brush,
} from "recharts";
import { getTelemetryHistory, getTelemetryAssets } from "@/lib/api";
import type { TelemetrySample } from "@/lib/types";
import type { VenueId } from "@/lib/setupApi";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { ChartContainer, ChartTooltipContent, type ChartConfig } from "@/components/ui/chart";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { Item, ItemContent, ItemDescription, ItemGroup, ItemTitle } from "@/components/ui/item";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { SectionHeader, Stat, StatusDot, TONE_TEXT, signTone } from "@/components/shared";

const POLL_MS = 2000; // server samples at 2s — match it while live
const SAMPLES_PER_MIN = 30; // 60s / 2s

const WINDOWS: { mins: number; label: string }[] = [
  { mins: 5, label: "5m" },
  { mins: 15, label: "15m" },
  { mins: 30, label: "30m" },
  { mins: 60, label: "1h" },
];

// ── Chart-ready row derived from a server TelemetrySample ─────────────────────
interface Row {
  t: number;
  time: string;
  oracle: number;
  v5: number;
  v1: number;
  accel: number;
  d60: number;
  d10: number;
  funding: number; // percent
  oi: number; // open interest (base contracts)
  oiDelta: number; // percent change vs previous poll
  cvd: number; // taker buy/sell ratio (1.0 = balanced)
  pulse: number; // institutional pulse (signed z-score)
  coherence: number; // 0..1 agreement
  ibitBps: number; // per-ETF premium (bps)
  fbtcBps: number;
  arkbBps: number;
  tideOpen: boolean; // US cash session live
  // Horizon Raptor
  tradfiVel: number; // SPY+QQQ 5s velocity
  macroCoh: number; // BTC/QQQ correlation
  vix: number; // UVXY price
  vixVel: number; // UVXY 5s velocity
  horizonOpen: boolean; // US cash session
}

function fmtClock(ms: number): string {
  return new Date(ms).toLocaleTimeString("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}

// Sports telemetry now spans days (de-duplicated ~2h polls), so a seconds-level
// clock is ambiguous. Label these points with month/day + HH:MM instead.
function fmtDayClock(ms: number): string {
  return new Date(ms).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

// Render an ISO-8601 kickoff time as a compact local "Sat 8:10 PM" label.
function fmtKickoff(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString("en-US", {
    weekday: "short",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
}

// rust_decimal::Decimal serializes to JSON as a *string* ("64000.5"), so every
// numeric signal arrives here as a string despite the TelemetrySample type. Coerce
// at the boundary — otherwise chart/stat formatters call .toFixed() on a string and
// crash the whole page.
const num = (v: unknown): number => {
  const n = typeof v === "number" ? v : parseFloat(v as string);
  return Number.isFinite(n) ? n : 0;
};

function toRow(s: TelemetrySample): Row {
  return {
    t: Number(s.t),
    time: fmtClock(Number(s.t)),
    oracle: num(s.oracle_price),
    v5: num(s.velocity_5s),
    v1: num(s.velocity_1s),
    accel: num(s.acceleration),
    d60: num(s.drift_60m),
    d10: num(s.drift_10m),
    funding: num(s.funding_rate) * 100,
    oi: num(s.open_interest),
    oiDelta: num(s.oi_delta_pct) * 100,
    cvd: num(s.cvd_ratio),
    pulse: num(s.institutional_pulse),
    coherence: num(s.tide_coherence),
    ibitBps: num(s.ibit_premium_bps),
    fbtcBps: num(s.fbtc_premium_bps),
    arkbBps: num(s.arkb_premium_bps),
    tideOpen: !!s.tide_market_open,
    // Horizon Raptor
    tradfiVel: num(s.tradfi_velocity),
    macroCoh: num(s.macro_coherence),
    vix: num(s.vix_proxy),
    vixVel: num(s.vix_velocity),
    horizonOpen: !!s.horizon_market_open,
  };
}

// The Sports Raptor snapshots each game at fixed offsets before kick-off rather than
// on a clock, so its telemetry is sparse and de-duplicated server-side; it gets its own
// multi-day chart row type independent of the crypto asset samples.
interface SportsRow {
  t: number;
  time: string;
  consensus: number; // vig-free consensus implied prob (0..1)
  drift: number; // Δ consensus vs previous poll (signed)
  dispersion: number; // spread of per-book implied probs (0..1)
  numBooks: number; // bookmakers in the sample
}

function toSportsRow(s: TelemetrySample): SportsRow {
  return {
    t: Number(s.t),
    time: fmtDayClock(Number(s.t)),
    consensus: num(s.sports_consensus_prob),
    drift: num(s.sports_line_drift),
    dispersion: num(s.sports_book_dispersion),
    numBooks: num(s.sports_num_books),
  };
}

// The Tennis Raptor is the other slow, venue-neutral poller (900s default), so
// it gets the same sparse multi-day row treatment as the Sports feed.
interface TennisRow {
  t: number;
  time: string;
  gamesP1: number; // games won in the CURRENT set
  gamesP2: number;
  setsP1: number; // sets won in the match
  setsP2: number;
  feedAge: number; // seconds since the score last moved (-1 → 0, unknown)
}

function toTennisRow(s: TelemetrySample): TennisRow {
  const age = num(s.tennis_feed_age_secs);
  return {
    t: Number(s.t),
    time: fmtDayClock(Number(s.t)),
    gamesP1: num(s.tennis_games_p1),
    gamesP2: num(s.tennis_games_p2),
    setsP1: num(s.tennis_sets_p1),
    setsP2: num(s.tennis_sets_p2),
    // -1 means "no timestamp on the score", not "zero seconds old". Plot it as
    // 0 so the unknown case cannot masquerade as a fresher-than-real feed.
    feedAge: age < 0 ? 0 : age,
  };
}

// Player series colors. The two sides of a match must stay tellable apart under
// color-vision deficiency; use distinct semantic series and a dashed player-2
// line as a non-color cue, with the actual player names in every legend.
const P1_COLOR = "var(--chart-3)";
const P2_COLOR = "var(--chart-2)";

// Mirrors config::TENNIS_SCORE_STALENESS_SECS. Drawn as a reference line so the
// chart shows *why* the raptor flips to disconnected, rather than the pill just
// going dark with no visible cause.
const TENNIS_STALENESS_SECS = 600;

// ── Signal-graph card ─────────────────────────────────────────────────────────

interface SeriesDef<R> {
  key: keyof R;
  label: string;
  color: string;
}

function SignalChart<R extends { time: string }>({
  title,
  subtitle,
  data,
  series,
  fmtY,
  zeroLine = false,
  refY,
  refLabel,
  lineType = "monotone",
  connected,
}: {
  title: string;
  subtitle: string;
  connected?: boolean;
  data: R[];
  series: SeriesDef<R>[];
  fmtY: (v: number) => string;
  zeroLine?: boolean;
  /** Optional horizontal baseline (e.g. 1.0 for a balanced CVD ratio). */
  refY?: number;
  refLabel?: string;
  /**
   * Interpolation between samples. Continuous measures curve ('monotone');
   * counts that only ever change by whole steps — games, sets — must use
   * 'stepAfter', or the curve draws values the score never held (3.5 games)
   * and implies the change happened gradually between polls.
   */
  lineType?: "monotone" | "stepAfter";
}) {
  const latest = data[data.length - 1];
  const config: ChartConfig = Object.fromEntries(
    series.map((s) => [String(s.key), { label: s.label, color: s.color }]),
  );
  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        <CardDescription>{subtitle}</CardDescription>
        <CardAction>
          <ConnPill label="Feed" live={connected} />
        </CardAction>
        <div className="col-span-full flex flex-wrap gap-x-5 gap-y-2 pt-2">
          {series.map((s) => (
            <Stat
              key={String(s.key)}
              label={s.label}
              value={latest ? fmtY(latest[s.key] as number) : "—"}
            />
          ))}
        </div>
      </CardHeader>
      <CardContent>
        {data.length < 2 ? (
          <Empty className="h-50">
            <EmptyHeader>
              <EmptyTitle>Collecting samples…</EmptyTitle>
              <EmptyDescription>
                At least two readings are needed to plot this signal.
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <ChartContainer config={config} className="h-50 w-full aspect-auto">
            <LineChart
              data={data}
              syncId="telemetry"
              margin={{ top: 6, right: 12, bottom: 0, left: 0 }}
            >
              <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
              <XAxis
                dataKey="time"
                tick={{ fill: "var(--muted-foreground)", fontSize: 10, fontFamily: "monospace" }}
                tickLine={false}
                axisLine={{ stroke: "var(--border)" }}
                interval="preserveStartEnd"
                minTickGap={40}
              />
              <YAxis
                tick={{ fill: "var(--muted-foreground)", fontSize: 10, fontFamily: "monospace" }}
                tickLine={false}
                axisLine={false}
                tickFormatter={fmtY}
                width={60}
                domain={["auto", "auto"]}
              />
              <Tooltip
                content={
                  <ChartTooltipContent
                    nameKey="dataKey"
                    formatter={(v, name) => (
                      <>
                        <span className="text-muted-foreground">{String(name)}</span>
                        <span className="ml-auto font-mono tabular-nums">{fmtY(Number(v))}</span>
                      </>
                    )}
                  />
                }
              />
              {zeroLine && <ReferenceLine y={0} stroke="var(--border)" strokeDasharray="4 4" />}
              {typeof refY === "number" && (
                <ReferenceLine
                  y={refY}
                  stroke="var(--muted-foreground)"
                  strokeDasharray="4 4"
                  label={
                    refLabel
                      ? {
                          value: refLabel,
                          position: "insideTopLeft",
                          fill: "var(--muted-foreground)",
                          fontSize: 9,
                        }
                      : undefined
                  }
                />
              )}
              {series.map((s, index) => (
                <Line
                  key={String(s.key)}
                  type={lineType}
                  dataKey={s.key as string}
                  name={s.label}
                  stroke={s.color}
                  strokeDasharray={lineType === "stepAfter" && index === 1 ? "5 3" : undefined}
                  strokeWidth={1.8}
                  dot={false}
                  isAnimationActive={false}
                />
              ))}
            </LineChart>
          </ChartContainer>
        )}
      </CardContent>
    </Card>
  );
}

// ── Overview scrubber (only shown when paused) ────────────────────────────────

function Scrubber({
  data,
  range,
  onChange,
}: {
  data: Row[];
  range: { startIndex: number; endIndex: number };
  onChange: (r: { startIndex: number; endIndex: number }) => void;
}) {
  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle>Scrub window</CardTitle>
        <CardDescription>Drag the handles to inspect a past interval</CardDescription>
      </CardHeader>
      <CardContent>
        <ChartContainer
          config={{ oracle: { label: "Oracle price", color: "var(--chart-1)" } }}
          className="h-17.5 w-full aspect-auto"
        >
          <LineChart data={data} margin={{ top: 4, right: 12, bottom: 0, left: 0 }}>
            <YAxis hide domain={["auto", "auto"]} />
            <Line
              type="monotone"
              dataKey="oracle"
              stroke="var(--chart-1)"
              strokeWidth={1.2}
              dot={false}
              isAnimationActive={false}
            />
            <Brush
              dataKey="time"
              height={22}
              travellerWidth={8}
              stroke="var(--primary)"
              fill="var(--muted)"
              startIndex={range.startIndex}
              endIndex={range.endIndex}
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              onChange={(r: any) => {
                if (typeof r?.startIndex === "number" && typeof r?.endIndex === "number") {
                  onChange({ startIndex: r.startIndex, endIndex: r.endIndex });
                }
              }}
              tickFormatter={() => ""}
            />
          </LineChart>
        </ChartContainer>
      </CardContent>
    </Card>
  );
}

// ── Small UI bits ─────────────────────────────────────────────────────────────

function AssetSelector({
  assets,
  selected,
  onChange,
}: {
  assets: string[];
  selected: string;
  onChange: (a: string) => void;
}) {
  if (assets.length <= 1) return null;
  return (
    <ToggleGroup
      type="single"
      variant="outline"
      value={selected}
      aria-label="Crypto asset"
      onValueChange={(value) => {
        if (value) onChange(value);
      }}
    >
      {assets.map((a) => (
        <ToggleGroupItem key={a} value={a}>
          {a.toUpperCase()}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  );
}

/** `live` is undefined before the first sample: unknown renders grey, not as a red "down" ([B43]). */
function ConnPill({ label, live }: { label: string; live: boolean | undefined }) {
  return (
    <Badge variant={live === undefined ? "secondary" : live ? "success" : "destructive"}>
      <StatusDot
        tone={live === undefined ? "muted" : live ? "success" : "destructive"}
        pulse={live === true}
      />
      {label} · {live === undefined ? "No reading yet" : live ? "Live" : "Offline"}
    </Badge>
  );
}

function StatCard({
  label,
  value,
  valueClass = "",
}: {
  label: string;
  value: string;
  valueClass?: string;
}) {
  return (
    <Card size="sm" className="px-4">
      <Stat label={label} value={<span className={valueClass}>{value}</span>} />
    </Card>
  );
}

function fmtSigned(n: number): string {
  const sign = n > 0 ? "+" : "";
  return `${sign}${n.toFixed(2)}`;
}

// ── Tide Raptor — Institutional Pulse card (BTC-only) ─────────────────────────

function fmtBps(n: number): string {
  return `${n >= 0 ? "+" : ""}${n.toFixed(1)} bps`;
}

function TideCard({ data, latest }: { data: Row[]; latest: Row }) {
  const open = latest.tideOpen;
  const pulse = latest.pulse;
  const coherence = latest.coherence;

  // Greyed/idle styling when the US cash session is closed: premiums are stale
  // and the pulse is intentionally held at 0.
  const dim = open ? "" : "opacity-50";
  const pulseClass = !open
    ? "text-muted-foreground"
    : pulse > 0
      ? "text-success"
      : pulse < 0
        ? "text-destructive"
        : "text-muted-foreground";

  // Coherence drives conviction: high agreement = trust the pulse.
  const cohClass = !open
    ? "text-muted-foreground"
    : coherence >= 0.66
      ? "text-success"
      : coherence >= 0.34
        ? "text-warning"
        : "text-muted-foreground";

  const etf = (label: string, bps: number) => (
    <Stat label={label} value={open ? fmtBps(bps) : "—"} tone={open ? signTone(bps) : "muted"} />
  );
  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle>Institutional pulse · Tide Raptor</CardTitle>
        <CardDescription>
          Spot-BTC-ETF premium vs synthetic iNAV — IBIT / FBTC / ARKB · live: Convergence · GBoost ·
          Basis
        </CardDescription>
        <CardAction>
          <Badge variant={open ? "success" : "secondary"}>
            <StatusDot tone={open ? "success" : "muted"} pulse={open} />
            {open ? "US session open" : "Market closed"}
          </Badge>
        </CardAction>
        <div className={`col-span-full grid grid-cols-2 sm:grid-cols-5 gap-3 pt-2 ${dim}`}>
          <Stat
            label="Pulse (Iₚ)"
            value={
              <span className={pulseClass}>
                {open ? `${pulse >= 0 ? "+" : ""}${pulse.toFixed(2)}σ` : "—"}
              </span>
            }
          />
          <Stat
            label="Coherence (C)"
            value={<span className={cohClass}>{open ? coherence.toFixed(2) : "—"}</span>}
          />
          {etf("IBIT", latest.ibitBps)}
          {etf("FBTC", latest.fbtcBps)}
          {etf("ARKB", latest.arkbBps)}
        </div>
      </CardHeader>
      <CardContent>
        <div className="h-40">
          {data.length < 2 ? (
            <Empty className="h-full">
              <EmptyDescription>
                {open ? "Collecting samples…" : "Pulse resumes at the US cash open (09:30 ET)"}
              </EmptyDescription>
            </Empty>
          ) : (
            <ChartContainer
              config={
                {
                  pulse: { label: "pulse σ", color: "var(--chart-1)" },
                  coherence: { label: "coherence", color: "var(--chart-2)" },
                } satisfies ChartConfig
              }
              className="h-40 w-full aspect-auto"
            >
              <LineChart
                data={data}
                syncId="telemetry"
                margin={{ top: 6, right: 12, bottom: 0, left: 0 }}
              >
                <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
                <XAxis
                  dataKey="time"
                  tick={{ fill: "var(--muted-foreground)", fontSize: 10, fontFamily: "monospace" }}
                  tickLine={false}
                  axisLine={{ stroke: "var(--border)" }}
                  interval="preserveStartEnd"
                  minTickGap={40}
                />
                <YAxis
                  tick={{ fill: "var(--muted-foreground)", fontSize: 10, fontFamily: "monospace" }}
                  tickLine={false}
                  axisLine={false}
                  tickFormatter={(v: number) => v.toFixed(1)}
                  width={44}
                  domain={["auto", "auto"]}
                />
                <Tooltip content={<ChartTooltipContent nameKey="dataKey" />} />
                <ReferenceLine y={0} stroke="var(--border)" strokeDasharray="4 4" />
                <Line
                  type="monotone"
                  dataKey="pulse"
                  name="pulse σ"
                  stroke="var(--chart-1)"
                  strokeWidth={1.8}
                  dot={false}
                  isAnimationActive={false}
                />
                <Line
                  type="monotone"
                  dataKey="coherence"
                  name="coherence"
                  stroke="var(--chart-2)"
                  strokeWidth={1.2}
                  dot={false}
                  isAnimationActive={false}
                />
              </LineChart>
            </ChartContainer>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

// ── Horizon Raptor — TradFi Velocity / VIX Proxy card (BTC-only) ──────────────

function HorizonCard({ data, latest }: { data: Row[]; latest: Row }) {
  const open = latest.horizonOpen;
  const tradfiVel = latest.tradfiVel;
  const macroCoh = latest.macroCoh;
  const vix = latest.vix;
  const vixVel = latest.vixVel;

  const dim = open ? "" : "opacity-50";
  const velClass = !open
    ? "text-muted-foreground"
    : tradfiVel > 0
      ? "text-success"
      : tradfiVel < 0
        ? "text-destructive"
        : "text-muted-foreground";

  // Macro coherence: high positive = BTC tracking tech, low = decoupled
  const cohClass = !open
    ? "text-muted-foreground"
    : macroCoh >= 0.5
      ? "text-success"
      : macroCoh >= 0
        ? "text-warning"
        : "text-destructive";

  // VIX velocity: spikes indicate panic
  const vixVelClass = !open
    ? "text-muted-foreground"
    : vixVel > 0.5
      ? "text-destructive"
      : vixVel < -0.5
        ? "text-success"
        : "text-muted-foreground";

  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle>TradFi velocity · Horizon Raptor</CardTitle>
        <CardDescription>
          SPY + QQQ momentum · BTC/QQQ correlation · UVXY VIX proxy · live: Maker · TrendReversal
          gates
        </CardDescription>
        <CardAction>
          <Badge variant={open ? "success" : "secondary"}>
            <StatusDot tone={open ? "success" : "muted"} pulse={open} />
            {open ? "US session open" : "Market closed"}
          </Badge>
        </CardAction>
        <div className={`col-span-full grid grid-cols-2 sm:grid-cols-4 gap-3 pt-2 ${dim}`}>
          <Stat
            label="TradFi velocity"
            value={
              <span className={velClass}>
                {open ? `${tradfiVel >= 0 ? "+" : ""}${tradfiVel.toFixed(3)}` : "—"}
              </span>
            }
          />
          <Stat
            label="Macro Cₘ"
            value={<span className={cohClass}>{open ? macroCoh.toFixed(2) : "—"}</span>}
          />
          <Stat label="VIX (UVXY)" value={open && vix > 0 ? `$${vix.toFixed(2)}` : "—"} />
          <Stat
            label="VIX velocity"
            value={
              <span className={vixVelClass}>
                {open ? `${vixVel >= 0 ? "+" : ""}${vixVel.toFixed(3)}` : "—"}
              </span>
            }
          />
        </div>
      </CardHeader>
      <CardContent>
        <div className="h-40">
          {data.length < 2 ? (
            <Empty className="h-full">
              <EmptyDescription>
                {open
                  ? "Collecting samples…"
                  : "TradFi velocity resumes at the US cash open (09:30 ET)"}
              </EmptyDescription>
            </Empty>
          ) : (
            <ChartContainer
              config={
                {
                  tradfiVel: { label: "TradFi velocity", color: "var(--chart-3)" },
                  macroCoh: { label: "macro Cₘ", color: "var(--chart-2)" },
                } satisfies ChartConfig
              }
              className="h-40 w-full aspect-auto"
            >
              <LineChart
                data={data}
                syncId="telemetry"
                margin={{ top: 6, right: 12, bottom: 0, left: 0 }}
              >
                <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
                <XAxis
                  dataKey="time"
                  tick={{ fill: "var(--muted-foreground)", fontSize: 10, fontFamily: "monospace" }}
                  tickLine={false}
                  axisLine={{ stroke: "var(--border)" }}
                  interval="preserveStartEnd"
                  minTickGap={40}
                />
                <YAxis
                  tick={{ fill: "var(--muted-foreground)", fontSize: 10, fontFamily: "monospace" }}
                  tickLine={false}
                  axisLine={false}
                  tickFormatter={(v: number) => v.toFixed(2)}
                  width={44}
                  domain={["auto", "auto"]}
                />
                <Tooltip content={<ChartTooltipContent nameKey="dataKey" />} />
                <ReferenceLine y={0} stroke="var(--border)" strokeDasharray="4 4" />
                <Line
                  type="monotone"
                  dataKey="tradfiVel"
                  name="TradFi vel"
                  stroke="var(--chart-3)"
                  strokeWidth={1.8}
                  dot={false}
                  isAnimationActive={false}
                />
                <Line
                  type="monotone"
                  dataKey="macroCoh"
                  name="macro Cₘ"
                  stroke="var(--chart-2)"
                  strokeWidth={1.2}
                  dot={false}
                  isAnimationActive={false}
                />
              </LineChart>
            </ChartContainer>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

// ── Main telemetry page ───────────────────────────────────────────────────────

// ── Asset-class sub-navigation ────────────────────────────────────────────────

type TelemetryClass = "crypto" | "sports" | "politics";

const TELEMETRY_CLASSES: { id: TelemetryClass; label: string; ready: boolean }[] = [
  { id: "crypto", label: "Crypto", ready: true },
  { id: "sports", label: "Sports", ready: true },
  { id: "politics", label: "Politics", ready: false },
];

function ClassNav({
  active,
  onChange,
  classes,
}: {
  active: TelemetryClass;
  onChange: (c: TelemetryClass) => void;
  classes: typeof TELEMETRY_CLASSES;
}) {
  return (
    <ToggleGroup
      type="single"
      variant="outline"
      value={active}
      aria-label="Telemetry class"
      onValueChange={(value) => {
        if (value) onChange(value as TelemetryClass);
      }}
    >
      {classes.map((c) => (
        <ToggleGroupItem key={c.id} value={c.id} disabled={!c.ready}>
          {c.label}
          {!c.ready && <span className="text-muted-foreground"> · Coming soon</span>}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  );
}

export default function TelemetryPage({
  availableAssets,
  venue,
}: {
  availableAssets: string[];
  venue?: VenueId;
}) {
  // US builds run a crypto wing (Polymarket US lists crypto markets), so the
  // Crypto tab stays visible — but Sports remains the default landing tab.
  //
  // Deliberately `=== 'us'` and not "any non-intl venue": Kalshi's default
  // series (KALSHI_SERIES) are crypto contracts, so a Kalshi instance should
  // land on Crypto like an intl one does.
  const isUs = venue === "us";
  const classes = TELEMETRY_CLASSES;
  // Use raptor-specific asset list (crypto underlyings only) rather than the
  // full DB pool list which may include venue-only entries (e.g. "kalshi").
  const { data: telemetryAssets } = useSWR("telemetry-assets", getTelemetryAssets, {
    refreshInterval: 30_000,
  });
  const assets = telemetryAssets?.length
    ? telemetryAssets
    : availableAssets.length
      ? availableAssets
      : ["btc"];
  const [selectedAsset, setSelectedAsset] = useState<string>("");
  const asset = selectedAsset || assets[0];

  const [windowMins, setWindowMins] = useState(15);
  const [live, setLive] = useState(true);
  // Tide and Horizon both read the US cash session. Outside it the ETF premiums
  // are stale and both signals are deliberately held at zero, so their panels
  // are two large cards of dashes. They collapse to one line until the open,
  // with a toggle for when the operator does want to look.
  const [showClosedRaptors, setShowClosedRaptors] = useState(false);
  const [range, setRange] = useState<{ startIndex: number; endIndex: number } | null>(null);
  const [assetClass, setAssetClass] = useState<TelemetryClass>(isUs ? "sports" : "crypto");
  // setupStatus loads async — if the venue resolves to US after mount, move the
  // initial crypto default over to the US landing tab (Sports) once.
  const [usDefaultApplied, setUsDefaultApplied] = useState(false);
  useEffect(() => {
    if (isUs && !usDefaultApplied) {
      setUsDefaultApplied(true);
      if (assetClass === "crypto") setAssetClass("sports");
    }
  }, [isUs, usDefaultApplied, assetClass]);

  const limit = windowMins * SAMPLES_PER_MIN;

  const { data: samples, error } = useSWR(
    ["telemetry-history", asset, limit],
    () => getTelemetryHistory(asset, limit),
    { refreshInterval: live ? POLL_MS : 0, revalidateOnFocus: false, keepPreviousData: true },
  );

  // The Sports Raptor publishes under a fixed "sports" key, independent of the selected
  // crypto asset. It snapshots at fixed offsets before kick-off and its telemetry is
  // de-duplicated server-side (one point per change/heartbeat), so a modest fixed
  // request spans many days of readable movement regardless of the crypto window.
  const { data: sportsSamples } = useSWR(
    ["telemetry-history", "sports", 288],
    () => getTelemetryHistory("sports", 288),
    { refreshInterval: live ? POLL_MS : 0, revalidateOnFocus: false, keepPreviousData: true },
  );
  const sportsLast =
    sportsSamples && sportsSamples.length > 0 ? sportsSamples[sportsSamples.length - 1] : undefined;
  const sportsRows = useMemo<SportsRow[]>(
    () => (sportsSamples ?? []).map(toSportsRow),
    [sportsSamples],
  );

  // The Tennis Raptor publishes under its own fixed "tennis" health key, on the
  // same slow cadence as Sports, so it is fetched as a sibling series here.
  const { data: tennisSamples } = useSWR(
    ["telemetry-history", "tennis", 288],
    () => getTelemetryHistory("tennis", 288),
    { refreshInterval: live ? POLL_MS : 0, revalidateOnFocus: false, keepPreviousData: true },
  );
  const tennisLast =
    tennisSamples && tennisSamples.length > 0 ? tennisSamples[tennisSamples.length - 1] : undefined;
  const tennisRows = useMemo<TennisRow[]>(
    () => (tennisSamples ?? []).map(toTennisRow),
    [tennisSamples],
  );
  // The feed labels the tracked match "A vs B"; split it so the chart legends
  // carry the actual players rather than an anonymous "p1"/"p2".
  const [tennisP1, tennisP2] = useMemo(() => {
    const parts = (tennisLast?.tennis_match ?? "").split(" vs ");
    return [parts[0]?.trim() || "player 1", parts[1]?.trim() || "player 2"];
  }, [tennisLast?.tennis_match]);

  const rows = useMemo<Row[]>(() => (samples ?? []).map(toRow), [samples]);

  // When pausing, seed the scrub range to the full loaded window; clear on resume.
  useEffect(() => {
    if (!live && rows.length > 1 && range === null) {
      setRange({ startIndex: 0, endIndex: rows.length - 1 });
    }
    if (live && range !== null) setRange(null);
  }, [live, rows.length, range]);

  // Detail charts show the scrubbed slice when paused, else the full window.
  const viewRows = useMemo<Row[]>(() => {
    if (!live && range) {
      const end = Math.min(range.endIndex, rows.length - 1);
      const start = Math.max(0, Math.min(range.startIndex, end));
      return rows.slice(start, end + 1);
    }
    return rows;
  }, [rows, live, range]);

  const latest = rows[rows.length - 1];
  const lastSample = samples && samples.length > 0 ? samples[samples.length - 1] : undefined;
  const spanSecs = rows.length >= 2 ? Math.round((rows[rows.length - 1].t - rows[0].t) / 1000) : 0;

  return (
    <div className="space-y-5">
      {/* Asset-class sub-navigation */}
      <div className="flex items-center gap-3 flex-wrap">
        <SectionHeader title="Telemetry" />
        <ClassNav active={assetClass} onChange={setAssetClass} classes={classes} />
      </div>

      {assetClass === "crypto" && (
        <div className="space-y-5">
          {/* Header / intro + controls */}
          <Card size="sm" className="px-4">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
              <div>
                <h2 className="text-sm font-medium">Raptor signal telemetry</h2>
                <p className="text-sm text-muted-foreground mt-0.5">
                  Live signal collectors -- watch the data streams to understand what your vipers
                  see —
                  <span className="text-muted-foreground">
                    {" "}
                    from spot micro-structure up to perp macro pressure.
                  </span>
                </p>
              </div>
              <AssetSelector assets={assets} selected={asset} onChange={setSelectedAsset} />
            </div>

            <div className="flex flex-wrap items-center gap-3 mt-3 pt-3 border-t border-border">
              <ConnPill
                label="Price Raptor"
                live={lastSample ? !!lastSample.price_connected : undefined}
              />
              <ConnPill
                label="Funding Raptor"
                live={lastSample ? !!lastSample.funding_connected : undefined}
              />
              <ConnPill
                label="Derivatives Raptor"
                live={lastSample ? !!lastSample.deriv_connected : undefined}
              />
              {asset === "btc" && (
                <ConnPill
                  label="Tide Raptor"
                  live={lastSample ? !!lastSample.tide_connected : undefined}
                />
              )}
              {asset === "btc" && (
                <ConnPill
                  label="Horizon Raptor"
                  live={lastSample ? !!lastSample.horizon_connected : undefined}
                />
              )}

              {/* Window selector */}
              <ToggleGroup
                type="single"
                variant="outline"
                value={String(windowMins)}
                aria-label="History window"
                onValueChange={(value) => {
                  if (value) setWindowMins(Number(value));
                }}
              >
                {WINDOWS.map((w) => (
                  <ToggleGroupItem key={w.mins} value={String(w.mins)}>
                    {w.label}
                  </ToggleGroupItem>
                ))}
              </ToggleGroup>

              {/* Live / Pause toggle */}
              <div className="flex items-center gap-2">
                <Switch id="telemetry-live" checked={live} onCheckedChange={setLive} />
                <Label htmlFor="telemetry-live">
                  <StatusDot tone={live ? "success" : "warning"} pulse={live} />
                  {live ? "Live" : "Paused"}
                </Label>
              </div>

              <span className="text-xs text-muted-foreground tabular-nums ml-auto">
                {rows.length} samples · {spanSecs}s loaded · {POLL_MS / 1000}s cadence
              </span>
            </div>
          </Card>

          {error && (
            <Alert variant="destructive">
              <AlertDescription>
                Failed to reach /api/telemetry/history — is the engine running?
              </AlertDescription>
            </Alert>
          )}

          {!samples && !error && (
            <Card size="sm" className="px-4" aria-busy>
              <Skeleton className="h-12 w-full" />
              <Skeleton className="h-50 w-full" />
            </Card>
          )}

          {/* Current-value stat strip */}
          {latest && (
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
              {/* A disconnected feed's last fields are zeros, not readings: dash them
              rather than print "$0.00" or "+0.0000%" as live values ([B43]). */}
              {(() => {
                const priceUp = !!lastSample?.price_connected;
                const fundingUp = !!lastSample?.funding_connected;
                const derivUp = !!lastSample?.deriv_connected;
                const off = "text-muted-foreground";
                return (
                  <>
                    <StatCard
                      label="Oracle price"
                      value={
                        priceUp
                          ? `$${latest.oracle.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
                          : "—"
                      }
                      valueClass={priceUp ? "" : off}
                    />
                    <StatCard
                      label="Velocity (5s)"
                      value={priceUp ? fmtSigned(latest.v5) : "—"}
                      valueClass={!priceUp ? off : TONE_TEXT[signTone(latest.v5)]}
                    />
                    <StatCard
                      label="Drift (10m)"
                      value={priceUp ? fmtSigned(latest.d10) : "—"}
                      valueClass={!priceUp ? off : TONE_TEXT[signTone(latest.d10)]}
                    />
                    <StatCard
                      label="Funding rate"
                      value={
                        fundingUp
                          ? `${latest.funding >= 0 ? "+" : ""}${latest.funding.toFixed(4)}%`
                          : "—"
                      }
                      valueClass={!fundingUp ? off : TONE_TEXT[signTone(latest.funding)]}
                    />
                    <StatCard
                      label="Open interest Δ"
                      value={
                        derivUp
                          ? `${latest.oiDelta >= 0 ? "+" : ""}${latest.oiDelta.toFixed(3)}%`
                          : "—"
                      }
                      valueClass={!derivUp ? off : TONE_TEXT[signTone(latest.oiDelta)]}
                    />
                  </>
                );
              })()}
              <StatCard
                label="Taker CVD"
                value={latest.cvd > 0 ? latest.cvd.toFixed(3) : "—"}
                valueClass={
                  latest.cvd === 0
                    ? "text-muted-foreground"
                    : latest.cvd >= 1
                      ? "text-success"
                      : "text-destructive"
                }
              />
            </div>
          )}

          {/* Scrubber — only when paused */}
          {!live && range && rows.length > 1 && (
            <Scrubber data={rows} range={range} onChange={setRange} />
          )}

          {/* Tide and Horizon are BTC-only and both follow the US cash session.
          Out of hours they collapse into a single line rather than two idle
          cards, which is the difference between a page that says "closed" and a
          page that looks broken. */}
          {asset === "btc" &&
            latest &&
            !latest.tideOpen &&
            !latest.horizonOpen &&
            !showClosedRaptors && (
              <Alert>
                <AlertDescription className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <p className="font-medium text-foreground">Tide Raptor · Horizon Raptor</p>
                    <p>
                      US cash session closed — ETF premiums are stale and both signals are held at
                      zero until the open.
                    </p>
                  </div>
                  <Button variant="outline" onClick={() => setShowClosedRaptors(true)}>
                    Show anyway
                  </Button>
                </AlertDescription>
              </Alert>
            )}

          {/* Institutional Pulse — Tide Raptor (BTC-only, consumed by Convergence/GBoost/Basis) */}
          {asset === "btc" && latest && (latest.tideOpen || showClosedRaptors) && (
            <TideCard data={viewRows} latest={latest} />
          )}

          {/* TradFi Velocity — Horizon Raptor (BTC-only, consumed by Maker/TrendReversal gates) */}
          {asset === "btc" && latest && (latest.horizonOpen || showClosedRaptors) && (
            <HorizonCard data={viewRows} latest={latest} />
          )}

          {/* Once revealed, let the operator put them away again without waiting for
          the close. Only offered while the session is actually shut. */}
          {asset === "btc" &&
            latest &&
            !latest.tideOpen &&
            !latest.horizonOpen &&
            showClosedRaptors && (
              <Button variant="outline" onClick={() => setShowClosedRaptors(false)}>
                Hide closed-session raptors
              </Button>
            )}

          {/* Signal charts */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <SignalChart
              title="Oracle price"
              subtitle="Binance Spot WS — current mark"
              data={viewRows}
              connected={lastSample ? !!lastSample.price_connected : undefined}
              series={[{ key: "oracle", label: "price", color: "var(--chart-1)" }]}
              fmtY={(v) => `$${Math.round(v).toLocaleString("en-US")}`}
            />
            <SignalChart
              title="Velocity & acceleration"
              subtitle="Δprice over 5s / 1s windows + accel"
              data={viewRows}
              connected={lastSample ? !!lastSample.price_connected : undefined}
              zeroLine
              series={[
                { key: "v5", label: "5s", color: "var(--chart-1)" },
                { key: "v1", label: "1s", color: "var(--chart-2)" },
                { key: "accel", label: "accel", color: "var(--chart-3)" },
              ]}
              fmtY={(v) => fmtSigned(v)}
            />
            <SignalChart
              title="Drift"
              subtitle="Δprice over 60m / 10m — medium-term trend"
              data={viewRows}
              connected={lastSample ? !!lastSample.price_connected : undefined}
              zeroLine
              series={[
                { key: "d60", label: "60m", color: "var(--chart-4)" },
                { key: "d10", label: "10m", color: "var(--chart-5)" },
              ]}
              fmtY={(v) => fmtSigned(v)}
            />
            <SignalChart
              title="Funding rate"
              subtitle="Binance perpetual — smart-money lean"
              data={viewRows}
              connected={lastSample ? !!lastSample.funding_connected : undefined}
              zeroLine
              series={[{ key: "funding", label: "rate", color: "var(--chart-2)" }]}
              fmtY={(v) => `${v.toFixed(4)}%`}
            />
            <SignalChart
              title="Open interest Δ"
              subtitle="Binance perp OI change — 10m regime pressure"
              data={viewRows}
              connected={lastSample ? !!lastSample.deriv_connected : undefined}
              zeroLine
              series={[{ key: "oiDelta", label: "ΔOI", color: "var(--chart-3)" }]}
              fmtY={(v) => `${v >= 0 ? "+" : ""}${v.toFixed(3)}%`}
            />
            <SignalChart
              title="Taker CVD ratio"
              subtitle="Perp buy÷sell aggression — >1 buyers lifting, <1 sellers hitting"
              data={viewRows}
              connected={lastSample ? !!lastSample.deriv_connected : undefined}
              refY={1}
              refLabel="balanced"
              series={[{ key: "cvd", label: "ratio", color: "var(--chart-4)" }]}
              fmtY={(v) => v.toFixed(3)}
            />
          </div>

          {/* Footer note */}
          <p className="text-xs text-muted-foreground">
            History is served from the engine ring buffer (
            <span className="text-muted-foreground">/api/telemetry/history</span>), so it survives
            page reloads. Pick a window, then <span className="text-muted-foreground">Pause</span>{" "}
            to scrub a past interval. Positive velocity/drift = price rising; funding &gt; 0 = longs
            paying shorts (bullish lean). The macro Derivatives Raptor adds perp context: rising{" "}
            <span className="text-muted-foreground">Open Interest Δ</span> with price = fresh
            positioning, while <span className="text-muted-foreground">Taker CVD</span> &gt; 1 marks
            buy-side aggression — your vipers fuse these slow macro reads with the fast spot micro
            signals.
          </p>
        </div>
      )}

      {assetClass === "sports" && (
        <div className="space-y-5">
          <Card size="sm">
            <CardHeader>
              <CardTitle>Sports Raptor — Cross-book consensus board</CardTitle>
              <CardDescription>
                Recording feed (The Odds API) against Polymarket International. Every matched
                moneyline is kept as a line keyed to its own outcome token, so a squadron reads its
                own game. The reading below is the next game to start.
              </CardDescription>
              <CardAction>
                <ConnPill
                  label="Sports Raptor"
                  live={sportsLast ? !!sportsLast.sports_connected : undefined}
                />
              </CardAction>
              <div className="col-span-full pt-2">
                <Stat label="Books" value={num(sportsLast?.sports_num_books).toFixed(0)} />
              </div>
            </CardHeader>
            <CardContent className="space-y-4">
              {/* Which event / outcome / books the numbers describe */}
              {!sportsLast?.sports_connected && sportsLast && !sportsLast.sports_enabled ? (
                <Alert>
                  <AlertDescription>
                    Switched off. Turn on{" "}
                    <span className="text-muted-foreground">Sports Line Ledger</span> under Setup →
                    Engine to start recording.
                  </AlertDescription>
                </Alert>
              ) : !sportsLast?.sports_connected && sportsLast && !sportsLast.sports_has_key ? (
                <Alert variant="warning">
                  <AlertDescription>
                    No <span className="text-muted-foreground">ODDS_API_KEY</span> set — the feed is
                    on but has nothing to read.
                  </AlertDescription>
                </Alert>
              ) : null}
              {sportsLast?.sports_connected && sportsLast?.sports_event ? (
                <ItemGroup>
                  <Item variant="muted">
                    <ItemContent>
                      <ItemTitle className="flex-wrap">
                        {sportsLast.sports_sport && (
                          <Badge variant="secondary">{sportsLast.sports_sport}</Badge>
                        )}
                        <span className="text-sm text-foreground font-medium">
                          {sportsLast.sports_event}
                        </span>
                        {sportsLast.sports_commence && (
                          <span className="text-xs text-muted-foreground">
                            · {fmtKickoff(sportsLast.sports_commence)}
                          </span>
                        )}
                      </ItemTitle>
                      <ItemDescription className="line-clamp-none">
                        Consensus is the vig-free implied probability that{" "}
                        <span className="font-medium text-foreground">
                          {sportsLast.sports_reference || "the reference outcome"}
                        </span>{" "}
                        wins — currently{" "}
                        <span className="text-foreground font-mono tabular-nums">
                          {(num(sportsLast.sports_consensus_prob) * 100).toFixed(1)}%
                        </span>
                        .
                      </ItemDescription>
                      {sportsLast.sports_books && (
                        <p className="text-xs text-muted-foreground mt-1">
                          <span className="text-muted-foreground tabular-nums">
                            {num(sportsLast.sports_num_books).toFixed(0)} books:
                          </span>{" "}
                          {sportsLast.sports_books}
                        </p>
                      )}
                    </ItemContent>
                  </Item>
                </ItemGroup>
              ) : !sportsSamples ? (
                <Skeleton className="h-24 w-full" aria-label="Loading sports board" />
              ) : (
                <Empty>
                  <EmptyHeader>
                    <EmptyTitle>No matched game on the board yet</EmptyTitle>
                    <EmptyDescription>
                      The raptor snapshots each game at fixed offsets before kick-off, so a line
                      appears as its game approaches.
                    </EmptyDescription>
                  </EmptyHeader>
                </Empty>
              )}

              <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                <SignalChart<SportsRow>
                  title="Consensus probability"
                  subtitle="Vig-free implied prob of reference outcome (0–1)"
                  data={sportsRows}
                  connected={sportsLast ? !!sportsLast.sports_connected : undefined}
                  series={[{ key: "consensus", label: "consensus", color: "var(--chart-1)" }]}
                  fmtY={(v) => v.toFixed(3)}
                />
                <SignalChart<SportsRow>
                  title="Line drift & book dispersion"
                  subtitle="Δconsensus vs that game's prior snapshot (signed) + cross-book spread"
                  data={sportsRows}
                  connected={sportsLast ? !!sportsLast.sports_connected : undefined}
                  zeroLine
                  series={[
                    { key: "drift", label: "drift", color: "var(--chart-3)" },
                    { key: "dispersion", label: "dispersion", color: "var(--chart-2)" },
                  ]}
                  fmtY={(v) => fmtSigned(v)}
                />
              </div>
            </CardContent>
          </Card>

          <p className="text-xs text-muted-foreground">
            The Sports Raptor records only — no Viper trades on it yet. It snapshots each matched
            game at fixed offsets before kick-off and budgets spend against the key's own quota, so
            it runs on the free tier (~500 requests/month) as well as a paid plan.{" "}
            <span className="text-muted-foreground">Consensus</span> is the vig-free cross-book
            implied probability of the outcome shown;{" "}
            <span className="text-muted-foreground">drift</span> is its move since that game's
            previous snapshot; <span className="text-muted-foreground">dispersion</span> is how much
            the books disagree — a proxy for soft, potentially mispriced lines.
          </p>

          {/* ── Tennis Raptor — live event state ────────────────────────────── */}
          <Card size="sm">
            <CardHeader>
              <CardTitle>Tennis Raptor — Live event state</CardTitle>
              <CardDescription>
                Venue-neutral observe-only feed (Live Tennis API). One tracked live match — sets,
                games, serving side and a derived break-point flag.
              </CardDescription>
              <CardAction>
                <ConnPill
                  label="Tennis Raptor"
                  live={tennisLast ? !!tennisLast.tennis_connected : undefined}
                />
              </CardAction>
              <div className="col-span-full pt-2">
                <Stat label="Live matches" value={num(tennisLast?.tennis_num_live).toFixed(0)} />
              </div>
            </CardHeader>
            <CardContent className="space-y-4">
              {/* Live scoreboard for the tracked match */}
              {tennisLast?.tennis_connected && tennisLast?.tennis_match ? (
                <div className="space-y-3">
                  <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                    {tennisLast.tennis_tour && (
                      <Badge variant="secondary">{tennisLast.tennis_tour}</Badge>
                    )}
                    <span className="text-sm text-foreground font-medium">
                      {tennisLast.tennis_match}
                    </span>
                    {tennisLast.tennis_tournament && (
                      <span className="text-xs text-muted-foreground">
                        · {tennisLast.tennis_tournament}
                      </span>
                    )}
                    {tennisLast.tennis_is_tiebreak && <Badge variant="secondary">Tiebreak</Badge>}
                    {tennisLast.tennis_break_point && <Badge variant="warning">Break point</Badge>}
                  </div>

                  {/* Score table — one row per player, color-keyed to the charts.
                  The serving side carries a labelled badge, so "who is serving"
                  is never conveyed by color alone. */}
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Player</TableHead>
                        <TableHead className="text-right">Sets</TableHead>
                        <TableHead className="text-right">Games</TableHead>
                        <TableHead className="text-right">Points</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {(
                        [
                          [
                            tennisP1,
                            P1_COLOR,
                            1,
                            num(tennisLast.tennis_sets_p1),
                            num(tennisLast.tennis_games_p1),
                            0,
                          ],
                          [
                            tennisP2,
                            P2_COLOR,
                            2,
                            num(tennisLast.tennis_sets_p2),
                            num(tennisLast.tennis_games_p2),
                            1,
                          ],
                        ] as const
                      ).map(([name, _color, side, sets, games, ptIdx]) => (
                        <TableRow key={side}>
                          <TableCell>
                            <span className="flex items-center gap-2">
                              <span
                                className={`size-2 rounded-xs shrink-0 ${side === 1 ? "bg-chart-3" : "bg-chart-2"}`}
                              />
                              {name}
                              {num(tennisLast.tennis_server) === side && (
                                <Badge variant="success">Serving</Badge>
                              )}
                            </span>
                          </TableCell>
                          <TableCell className="text-right font-mono tabular-nums">
                            {sets.toFixed(0)}
                          </TableCell>
                          <TableCell className="text-right font-mono tabular-nums">
                            {games.toFixed(0)}
                          </TableCell>
                          <TableCell className="text-right font-mono tabular-nums">
                            {(tennisLast.tennis_points ?? "").split("–")[ptIdx] || "–"}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              ) : !tennisSamples ? (
                <Skeleton className="h-24 w-full" aria-label="Loading tennis board" />
              ) : (
                <Empty>
                  <EmptyDescription>
                    {num(tennisLast?.tennis_num_live) > 0
                      ? "Live matches on court, but no score has been published yet."
                      : "Nothing on court — tennis has quiet hours daily, which is a healthy state, not a fault. Set LIVETENNIS_API_KEY in Setup if the pill stays offline."}
                  </EmptyDescription>
                </Empty>
              )}

              <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                <SignalChart<TennisRow>
                  title="Games — Current set"
                  subtitle="Games won in the set in progress"
                  data={tennisRows}
                  connected={tennisLast ? !!tennisLast.tennis_connected : undefined}
                  lineType="stepAfter"
                  series={[
                    { key: "gamesP1", label: tennisP1, color: P1_COLOR },
                    { key: "gamesP2", label: tennisP2, color: P2_COLOR },
                  ]}
                  fmtY={(v) => v.toFixed(0)}
                />
                <SignalChart<TennisRow>
                  title="Sets won"
                  subtitle="Match score in sets"
                  data={tennisRows}
                  connected={tennisLast ? !!tennisLast.tennis_connected : undefined}
                  lineType="stepAfter"
                  series={[
                    { key: "setsP1", label: tennisP1, color: P1_COLOR },
                    { key: "setsP2", label: tennisP2, color: P2_COLOR },
                  ]}
                  fmtY={(v) => v.toFixed(0)}
                />
                <div className="lg:col-span-2">
                  <SignalChart<TennisRow>
                    title="Feed age"
                    subtitle="Seconds since the tracked score last moved"
                    data={tennisRows}
                    connected={tennisLast ? !!tennisLast.tennis_connected : undefined}
                    refY={TENNIS_STALENESS_SECS}
                    refLabel={`stale > ${TENNIS_STALENESS_SECS}s`}
                    series={[{ key: "feedAge", label: "feed age", color: "var(--chart-5)" }]}
                    fmtY={(v) => `${v.toFixed(0)}s`}
                  />
                </div>
              </div>
            </CardContent>
          </Card>

          <p className="text-xs text-muted-foreground">
            The Tennis Raptor observes only — no Viper trades on it yet, and the tracked match is
            chosen for signal liveness (sticky on the previous match, else the freshest score), not
            because it maps to a listed market. It polls every ~15 min to stay inside the free tier
            (100 requests/day), so <span className="text-muted-foreground">games</span> and{" "}
            <span className="text-muted-foreground">sets</span> step rather than curve — the score
            only ever moves in whole units, and between polls it genuinely has no value.{" "}
            <span className="text-muted-foreground">Feed age</span> above the dashed line means the
            score has gone stale, and the raptor then reports disconnected so a consumer widens or
            pulls rather than holding on a frozen number.
          </p>
        </div>
      )}
    </div>
  );
}
