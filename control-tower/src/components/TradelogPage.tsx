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

import { useState, useMemo } from "react";
import useSWR from "swr";
import type { TradeRow, OpenPositionRow, TradeStats, PositionQuote } from "@/lib/types";
import {
  getTrades,
  getTradeStats,
  getOpenPositions,
  getPositionQuotes,
  downloadTradelogCsv,
} from "@/lib/api";
import { DEMO_MODE } from "@/lib/demo";

import {
  ArrowClockwiseIcon,
  DownloadSimpleIcon,
  GhostIcon,
  LightningIcon,
  WarningIcon,
} from "@phosphor-icons/react";
import { cn } from "@/lib/utils";
import { SectionHeader, Stat, TONE_TEXT, signTone } from "@/components/shared";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Empty, EmptyDescription } from "@/components/ui/empty";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from "@/components/ui/table";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

// ── Types ─────────────────────────────────────────────────────────────────────

type LogStatus = "launch" | "inflight" | "completed";

interface LogEntry {
  key: string;
  ts: Date;
  /**
   * Which database the row came from. A *storage* location, not a market
   * attribute — it holds an underlying symbol on the intl CLOB but a venue name
   * on Kalshi and US. Displayed as "Book", never as the asset. The real
   * attributes are `venue` / `marketClass` / `underlying` below.
   */
  shard: string;
  venue: string | null;
  marketClass: string | null;
  /** Null for markets with no underlying instrument (sports, politics). */
  underlying: string | null;
  /** Round-trip venue fees. `pnl` is already net of these. Null if uncaptured. */
  fees: number | null;
  status: LogStatus;
  strategy: string;
  market: string;
  side: string;
  entry: number;
  curOrExit: number | null; // current_price for open; exit_price for completed
  priceAgeSecs: number | null; // seconds since the shown price was fetched (open rows only)
  priceIsLiveBid: boolean; // true when the price is a live venue bid, not the stored mark
  shares: number;
  pnl: number | null; // realized for completed; unrealized for open
  reason: string;
  ghost: boolean;
  /** Set only on Helm trades; links the row to the conviction behind it. */
  intentId?: number | null;
  chainAdopted: boolean;
  tokenId?: string; // for RTB on open positions
  rawPosition?: OpenPositionRow; // kept for RTB modal
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const ASSET_COLOR: Record<string, string> = {
  btc: "bg-chart-1/10 text-chart-1 border-chart-1/20",
  eth: "bg-chart-2/10 text-chart-2 border-chart-2/20",
  sol: "bg-chart-3/10 text-chart-3 border-chart-3/20",
};

const VENUE_LABEL: Record<string, string> = {
  kalshi: "Kalshi",
  "polymarket-us": "Poly US",
  "polymarket-intl": "Poly Intl",
};

const CLASS_COLOR: Record<string, string> = {
  crypto: "bg-chart-1/10 text-chart-1 border-chart-1/20",
  sports: "bg-chart-4/10 text-chart-4 border-chart-4/20",
  politics: "bg-chart-5/10 text-chart-5 border-chart-5/20",
};

/**
 * What to show for the market's subject. Crypto markets have an underlying
 * symbol; sports and politics genuinely do not, so they show their class
 * instead of an invented ticker.
 */
function subjectBadge(e: LogEntry): string {
  if (e.underlying) return e.underlying.toUpperCase();
  if (e.marketClass) return e.marketClass.toUpperCase();
  return "—";
}

const STATUS_META = {
  launch: { label: "Launch", variant: "default" },
  inflight: { label: "In-flight", variant: "warning" },
  completed: { label: "Completed", variant: "success" },
} as const;

function shortStrategy(s: string) {
  return s.replace("Strategy", "");
}

function fmtTime(d: Date) {
  const date = d.toLocaleDateString("en-US", { month: "2-digit", day: "2-digit" });
  const time = d.toLocaleTimeString("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  return `${date} ${time}`;
}

function fmtPnl(n: number | null, prefix = true) {
  if (n === null) return <span className="font-mono tabular-nums text-muted-foreground">—</span>;
  const sign = n >= 0 ? "+" : "";
  const cls = cn("font-mono tabular-nums", TONE_TEXT[signTone(n)]);
  return (
    <span className={cls}>
      {prefix ? `${n < 0 ? "-" : sign}$${Math.abs(n).toFixed(4)}` : `${sign}$${n.toFixed(4)}`}
    </span>
  );
}

/** P&L as a percent of the capital put in at entry (entry price × shares). */
function fmtPnlPct(pnl: number | null, entry: number, shares: number) {
  const cost = entry * shares;
  if (pnl === null || !Number.isFinite(cost) || cost <= 0) return null;
  const pct = (pnl / cost) * 100;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          tabIndex={0}
          className={cn(
            "ml-1 font-mono text-2xs font-normal tabular-nums",
            TONE_TEXT[signTone(pct)],
          )}
        >
          ({pct >= 0 ? "+" : ""}
          {pct.toFixed(1)}%)
        </span>
      </TooltipTrigger>
      <TooltipContent>
        P&amp;L as a percent of the entry cost (${cost.toFixed(4)} = {entry.toFixed(4)} ×{" "}
        {shares.toFixed(2)} shares).
      </TooltipContent>
    </Tooltip>
  );
}

function fmtUnrealized(entry: number, cur: number | null, shares: number) {
  if (cur === null) return null;
  return (cur - entry) * shares;
}

function truncate(s: string, n: number) {
  return s.length > n ? s.slice(0, n) + "…" : s;
}

function TipCell({
  full,
  maxChars,
  className = "",
}: {
  full: string;
  maxChars: number;
  className?: string;
}) {
  if (full.length <= maxChars) return <span className={className}>{full}</span>;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          tabIndex={0}
          className={cn("cursor-help border-b border-dotted border-border", className)}
        >
          {truncate(full, maxChars)}
        </span>
      </TooltipTrigger>
      <TooltipContent className="max-w-xs whitespace-pre-wrap break-words">{full}</TooltipContent>
    </Tooltip>
  );
}

// Convert API data → LogEntry array for one asset
function assetToEntries(
  shard: string,
  trades: TradeRow[],
  positions: OpenPositionRow[],
  /** Live venue quotes by token id. Empty until the first poll returns. */
  quoteByToken: Record<string, PositionQuote>,
): LogEntry[] {
  const entries: LogEntry[] = [];

  for (const t of trades) {
    entries.push({
      key: `${shard}-completed-${t.ts}-${t.market}`,
      ts: new Date(t.ts),
      shard,
      venue: t.venue ?? null,
      marketClass: t.market_class ?? null,
      underlying: t.underlying ?? null,
      fees: t.fees != null ? parseFloat(t.fees) : null,
      status: "completed",
      strategy: t.strategy,
      market: t.market,
      side: t.side,
      entry: parseFloat(t.entry_price),
      curOrExit: parseFloat(t.exit_price),
      priceAgeSecs: null, // a completed trade's exit price is final, not a mark
      priceIsLiveBid: false,
      shares: parseFloat(t.shares),
      pnl: parseFloat(t.pnl),
      reason: t.reason,
      // Was hardcoded false, which told every viewer that every completed trade
      // was real money. Open positions were badged correctly from
      // `open_positions.ghost_mode` all along, so a customer stuck in simulation
      // saw ghost badges disappear the moment a trade closed — and a P&L ledger
      // that looked entirely real. Rows written before the column existed report
      // false, which is what they already displayed.
      ghost: t.ghost ?? false,
      intentId: t.intent_id ?? null,
      chainAdopted: false,
    });
  }

  for (const p of positions) {
    const status: LogStatus = p.status === "pending" ? "launch" : "inflight";
    const entry = parseFloat(p.entry_price);
    // Prefer the live bid: it is both fresher and the price a manual exit would
    // actually get. Fall back to the stored mark, which the age badge labels.
    const liveQuote = quoteByToken[p.token_id];
    const liveBid = liveQuote?.bid ? parseFloat(liveQuote.bid) : null;
    const cur = liveBid ?? (p.current_price ? parseFloat(p.current_price) : null);
    const shares = parseFloat(p.shares);
    const unrealized = fmtUnrealized(entry, cur, shares);
    entries.push({
      key: `${shard}-${status}-${p.ts}-${p.token_id}`,
      ts: new Date(p.ts),
      shard,
      venue: p.venue ?? null,
      marketClass: p.market_class ?? null,
      // Legacy rows and chain adoptions predating the filing columns keep the
      // old shard heuristic (the shard IS the underlying on the intl venue),
      // so their Subject does not regress to "—" after the upgrade. A row
      // that carries the column always wins — the heuristic mislabels every
      // non-intl shard.
      underlying: p.underlying ?? (ASSET_COLOR[shard] ? shard : null),
      fees: null,
      status,
      strategy: p.strategy,
      market: p.market,
      side: p.side,
      entry,
      curOrExit: cur,
      priceIsLiveBid: liveBid !== null,
      priceAgeSecs:
        liveBid !== null
          ? (liveQuote?.age_secs ?? null)
          : p.price_updated_at
            ? Math.max(0, Math.round((Date.now() - new Date(p.price_updated_at).getTime()) / 1000))
            : null,
      shares,
      pnl: unrealized,
      reason: "",
      ghost: p.ghost_mode,
      chainAdopted: p.chain_adopted,
      tokenId: p.token_id,
      rawPosition: p,
    });
  }

  return entries;
}

// ── Sub-components ────────────────────────────────────────────────────────────

/**
 * Top-of-page totals.
 *
 * `entries` is a bounded recent window (200 rows per asset, and the API clamps
 * any limit to 500), so completed-mission counts and realized P&L come from
 * `stats` — lifetime aggregates computed server-side in SQL — rather than a
 * reduce over what happens to be loaded. Launches, in-flight, and unrealized
 * P&L still come from `entries`: those describe currently-open positions, which
 * are never truncated.
 */
/**
 * `unknown` carries why the figures are not known yet ("loading…" or a load
 * error). The cards then show dashes: a list that has not arrived is not an
 * empty ledger, and must not render as 0 missions and +$0.0000 ([B43]).
 */
function SummaryBar({
  entries,
  stats,
  unknown,
}: {
  entries: LogEntry[];
  stats: (TradeStats & { asset: string })[];
  unknown: string | null;
}) {
  const launches = entries.filter((e) => e.status === "launch").length;
  const inflight = entries.filter((e) => e.status === "inflight").length;
  const completedCount = stats.reduce((s, t) => s + t.count, 0);
  const realizedPnl = stats.reduce((s, t) => s + t.realized_pnl, 0);
  const unrealized = entries
    .filter((e) => e.status !== "completed" && e.pnl !== null)
    .reduce((s, e) => s + (e.pnl ?? 0), 0);

  const pnlTotal = realizedPnl + unrealized;
  if (unknown) {
    return (
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {["Viper launches", "Missions in-flight", "Completed missions", "Net P&L"].map((label) => (
          <Card key={label} size="sm">
            <CardContent className="space-y-1">
              <Stat label={label} value="—" />
              {unknown === "loading…" ? (
                <Skeleton className="h-3 w-24" aria-label="Loading totals" />
              ) : (
                <span className="text-xs text-destructive">{unknown}</span>
              )}
            </CardContent>
          </Card>
        ))}
      </div>
    );
  }
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
      <Card size="sm">
        <CardContent>
          <Stat label="Viper launches" value={launches} sub="Pending fills" tone="primary" />
        </CardContent>
      </Card>
      <Card size="sm">
        <CardContent>
          <Stat label="Missions in-flight" value={inflight} sub="Confirmed open" tone="warning" />
        </CardContent>
      </Card>
      <Card size="sm">
        <CardContent>
          <Stat
            label="Completed missions"
            value={completedCount}
            sub={
              <span className={cn("font-mono tabular-nums", TONE_TEXT[signTone(realizedPnl)])}>
                {realizedPnl >= 0 ? "+" : ""}${realizedPnl.toFixed(4)} realized
              </span>
            }
          />
        </CardContent>
      </Card>
      <Card size="sm">
        <CardContent>
          <Stat
            label="Net P&L"
            value={`${pnlTotal >= 0 ? "+" : ""}$${pnlTotal.toFixed(4)}`}
            sub="Realized + unrealized"
            tone={signTone(pnlTotal)}
          />
        </CardContent>
      </Card>
    </div>
  );
}

// ── RTB Modal ────────────────────────────────────────────────────────────────

function RtbModal({
  entry,
  onClose,
  onConfirm,
  loading,
}: {
  entry: LogEntry;
  onClose: () => void;
  onConfirm: () => void;
  loading: boolean;
}) {
  function isLong(side: string) {
    const s = side.toUpperCase();
    return s === "YES" || s === "UP" || s === "BUY";
  }
  return (
    <AlertDialog
      open
      onOpenChange={(open) => {
        if (!open && !loading) onClose();
      }}
    >
      <AlertDialogContent onEscapeKeyDown={(event) => event.preventDefault()}>
        <AlertDialogHeader>
          <AlertDialogTitle>Close now</AlertDialogTitle>
          <AlertDialogDescription>
            Sell this whole position immediately at the live bid.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <dl className="grid grid-cols-2 gap-2 text-xs">
          <dt className="text-muted-foreground">Venue</dt>
          <dd>
            {entry.venue ? (VENUE_LABEL[entry.venue] ?? entry.venue) : entry.shard.toUpperCase()}
          </dd>
          <dt className="text-muted-foreground">Subject</dt>
          <dd className="font-mono">{subjectBadge(entry)}</dd>
          <dt className="text-muted-foreground">Market</dt>
          <dd>{truncate(entry.market, 60)}</dd>
          <dt className="text-muted-foreground">Side</dt>
          <dd className={isLong(entry.side) ? "text-success" : "text-destructive"}>{entry.side}</dd>
          <dt className="text-muted-foreground">Shares</dt>
          <dd className="font-mono tabular-nums">{entry.shares.toFixed(2)}</dd>
        </dl>
        <Alert variant="warning">
          <WarningIcon />
          <AlertTitle>What this does</AlertTitle>
          <AlertDescription>
            <ul className="list-inside list-disc space-y-1">
              <li>
                Sells the <strong>whole position immediately</strong> at the live bid with a
                fill-or-kill market order (FAK)
              </li>
              <li>Taker fees apply (~2% on Polymarket)</li>
              <li>
                The squadron keeps patrolling — this closes one position, it does not stand anything
                down
              </li>
              <li>Alternative: let the position settle naturally (no fees)</li>
            </ul>
          </AlertDescription>
        </Alert>
        <AlertDialogFooter>
          <Button variant="outline" onClick={onClose} disabled={loading}>
            Cancel
          </Button>
          <Button variant="destructive" onClick={onConfirm} disabled={loading}>
            {loading ? "Closing…" : "Close now"}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

interface Props {
  availableAssets: string[];
}

/** Download the complete trade history (all assets) as one CSV — tax
 *  reporting / offline review. A trade record, not a tax document. */
function ExportCsvButton({ assets }: { assets: string[] }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(false);

  const run = async () => {
    setBusy(true);
    setErr(false);
    try {
      await downloadTradelogCsv(assets);
    } catch {
      setErr(true);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span>
          <Button variant="outline" onClick={run} disabled={busy}>
            <DownloadSimpleIcon data-icon="inline-start" />
            {busy ? "Exporting…" : err ? "Export failed — retry" : "Export CSV"}
          </Button>
        </span>
      </TooltipTrigger>
      <TooltipContent className="max-w-sm">
        Download the complete trade history (all assets, all filters ignored) as CSV. A trade record
        for tax prep or review — not a tax document; cost-basis treatment is your accountant&apos;s
        call.
      </TooltipContent>
    </Tooltip>
  );
}

export default function TradelogPage({ availableAssets }: Props) {
  // ── Filters ──────────────────────────────────────────────────────────────────
  const [assetFilter, setAssetFilter] = useState<string>("all");
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [strategyFilter, setStrategyFilter] = useState<string>("all");
  const [sideFilter, setSideFilter] = useState<string>("all");
  const [venueFilter, setVenueFilter] = useState("all");
  const [search, setSearch] = useState("");

  // ── RTB state ───────────────────────────────────────────────────────────────
  const [rtbEntry, setRtbEntry] = useState<LogEntry | null>(null);
  const [rtbLoading, setRtbLoading] = useState(false);

  // ── Fetch all assets in parallel ─────────────────────────────────────────────
  const assets = availableAssets.length > 0 ? availableAssets : ["btc", "eth", "sol"];

  const {
    data: tradesData,
    isLoading: tradesLoading,
    error: tradesError,
  } = useSWR(
    ["tradelog-trades", assets.join(",")],
    async () => {
      const results = await Promise.all(
        assets.map((a) => getTrades(200, a).then((rows) => rows.map((r) => ({ asset: a, ...r })))),
      );
      return results.flat();
    },
    { refreshInterval: 15_000 },
  );

  // Lifetime totals per asset for the summary cards. Kept separate from the
  // trade list above, which stays a bounded window for display.
  const {
    data: statsData,
    isLoading: statsLoading,
    error: statsError,
  } = useSWR(
    ["tradelog-stats", assets.join(",")],
    async () => Promise.all(assets.map((a) => getTradeStats(a).then((t) => ({ asset: a, ...t })))),
    { refreshInterval: 15_000 },
  );

  const {
    data: positionsData,
    isLoading: positionsLoading,
    error: positionsError,
  } = useSWR(
    ["tradelog-positions", assets.join(",")],
    async () => {
      const results = await Promise.all(
        assets.map((a) =>
          getOpenPositions(a).then((rows) => rows.map((r) => ({ asset: a, ...r }))),
        ),
      );
      return results.flat();
    },
    { refreshInterval: 15_000 },
  );

  const allTrades = tradesData ?? [];
  const allStats = statsData ?? [];
  const allPositions = positionsData ?? [];

  // Why the summary's figures are not known, or null when they are. A failed
  // refresh with the last good data still cached is not "unknown": SWR keeps
  // that data, and the list below keeps showing it, so only a read that has
  // never succeeded blanks the cards.
  const loadErr =
    (!tradesData && tradesError) ||
    (!statsData && statsError) ||
    (!positionsData && positionsError);
  const summaryUnknown: string | null =
    tradesLoading || statsLoading || positionsLoading
      ? "loading…"
      : loadErr
        ? `couldn't load: ${loadErr instanceof Error ? loadErr.message : String(loadErr)}`
        : null;

  // Live venue quotes for open positions, polled far faster than the rows.
  //
  // The row's own `current_price` is refreshed by a 300s chain-sync sweep, which
  // is fine for a glance and useless for deciding whether to close a position by
  // hand. This asks the venue directly and shows the BID, because that is what a
  // manual exit sells into. Only polls while positions are actually open.
  //
  // `fresh` is threaded through the fetcher rather than captured from state so a
  // press cannot race the poll into serving a cached read: the flag travels with
  // the request that the press initiated.
  const { data: quotes = [], mutate: mutateQuotes } = useSWR(
    allPositions.length > 0 ? ["tradelog-quotes", assets.join(",")] : null,
    async () => {
      const results = await Promise.allSettled(assets.map((a) => getPositionQuotes(a)));
      return results.flatMap((r) => (r.status === "fulfilled" ? r.value : []));
    },
    { refreshInterval: 4_000 },
  );

  // Manual refresh: bypass the server's quote cache and repaint from the venue.
  //
  // The 4s poll is paced for a dashboard left open; an operator deciding whether
  // to call RTB on a position wants the book as of the moment they ask. Disabled
  // with nothing open, because there would be no quote to fetch.
  const [refreshing, setRefreshing] = useState(false);
  const quotesRefreshable = allPositions.length > 0;
  async function refreshQuotes() {
    if (refreshing || !quotesRefreshable) return;
    setRefreshing(true);
    try {
      await mutateQuotes(
        async () => {
          const results = await Promise.allSettled(assets.map((a) => getPositionQuotes(a, true)));
          return results.flatMap((r) => (r.status === "fulfilled" ? r.value : []));
        },
        { revalidate: false },
      );
    } finally {
      setRefreshing(false);
    }
  }

  const quoteByToken = useMemo(() => {
    const m: Record<string, PositionQuote> = {};
    for (const q of quotes) m[q.token_id] = q;
    return m;
  }, [quotes]);

  const isLoading = tradesLoading || positionsLoading;

  // ── Build unified log ────────────────────────────────────────────────────────
  const allEntries = useMemo((): LogEntry[] => {
    const byAsset: Record<string, { trades: TradeRow[]; positions: OpenPositionRow[] }> = {};
    for (const a of assets) {
      byAsset[a] = { trades: [], positions: [] };
    }
    for (const t of allTrades as (TradeRow & { asset: string })[]) {
      if (byAsset[t.asset]) {
        const { asset: _a, ...row } = t as TradeRow & { asset: string };
        byAsset[t.asset].trades.push(row);
      }
    }
    for (const p of allPositions as (OpenPositionRow & { asset: string })[]) {
      if (byAsset[p.asset]) {
        const { asset: _a, ...row } = p as OpenPositionRow & { asset: string };
        byAsset[p.asset].positions.push(row);
      }
    }

    const entries: LogEntry[] = [];
    for (const a of assets) {
      entries.push(...assetToEntries(a, byAsset[a].trades, byAsset[a].positions, quoteByToken));
    }
    entries.sort((a, b) => b.ts.getTime() - a.ts.getTime());
    return entries;
  }, [allTrades, allPositions, assets, quoteByToken]);

  // ── Derived filter options ──────────────────────────────────────────────────
  const strategies = useMemo(() => {
    const set = new Set(allEntries.map((e) => shortStrategy(e.strategy)));
    return ["all", ...Array.from(set).sort()];
  }, [allEntries]);

  // ── Apply filters ────────────────────────────────────────────────────────────
  const filtered = useMemo(() => {
    return allEntries.filter((e) => {
      if (assetFilter !== "all" && e.shard !== assetFilter) return false;
      if (statusFilter !== "all" && e.status !== statusFilter) return false;
      if (strategyFilter !== "all" && shortStrategy(e.strategy) !== strategyFilter) return false;
      if (sideFilter !== "all" && e.side.toUpperCase() !== sideFilter) return false;
      if (venueFilter !== "all" && e.venue !== venueFilter) return false;
      if (
        search &&
        ![e.market, e.strategy, e.reason, e.underlying ?? "", e.marketClass ?? ""].some((value) =>
          value.toLowerCase().includes(search.toLowerCase()),
        )
      )
        return false;
      return true;
    });
  }, [allEntries, assetFilter, statusFilter, strategyFilter, sideFilter, venueFilter, search]);

  // ── RTB handler ──────────────────────────────────────────────────────────────
  const handleRtbConfirm = async () => {
    if (DEMO_MODE) return;
    if (!rtbEntry?.rawPosition) return;
    setRtbLoading(true);
    try {
      const res = await fetch("/api/positions/manual-exit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          token_id: rtbEntry.rawPosition.token_id,
          // The API's `asset` field is the shard/pool selector, not a market
          // attribute — keep sending the shard under its wire name.
          asset: rtbEntry.shard,
          strategy: rtbEntry.rawPosition.strategy,
          market: rtbEntry.rawPosition.market,
          side: rtbEntry.rawPosition.side,
          current_bid: "0.5",
          verifying_contract: "0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E",
        }),
      });
      if (!res.ok) {
        alert(`Close Now failed: ${await res.text()}`);
      } else {
        alert("Position closed! Refreshing…");
        window.location.reload();
      }
    } catch (err) {
      alert(`Close Now error: ${err}`);
    } finally {
      setRtbLoading(false);
      setRtbEntry(null);
    }
  };

  // ── Render ────────────────────────────────────────────────────────────────────
  return (
    <div className="space-y-5">
      <SectionHeader
        title="Mission tradelog"
        description="Recent execution history and open positions"
      />
      {/* ── Summary stats ────────────────────────────────────────────────────── */}
      <SummaryBar
        entries={
          assetFilter === "all" ? allEntries : allEntries.filter((e) => e.shard === assetFilter)
        }
        stats={assetFilter === "all" ? allStats : allStats.filter((s) => s.asset === assetFilter)}
        unknown={summaryUnknown}
      />

      <Card size="sm">
        <CardContent className="space-y-3">
          <div className="flex flex-wrap items-center gap-3">
            <Tooltip>
              <TooltipTrigger asChild>
                <span tabIndex={0} className="text-muted-foreground">
                  Book
                </span>
              </TooltipTrigger>
              <TooltipContent>
                Which database the rows come from. On the intl venue this is the underlying asset;
                on Kalshi and US it is the venue.
              </TooltipContent>
            </Tooltip>
            <ToggleGroup
              type="single"
              variant="outline"
              spacing={0}
              value={assetFilter}
              onValueChange={(value) => {
                if (value) setAssetFilter(value);
              }}
              aria-label="Book filter"
              className="flex-wrap"
            >
              <ToggleGroupItem value="all">All</ToggleGroupItem>
              {assets.map((asset) => (
                <ToggleGroupItem key={asset} value={asset} className="font-mono">
                  {asset.toUpperCase()}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
            <span className="text-muted-foreground">Status</span>
            <ToggleGroup
              type="single"
              variant="outline"
              spacing={0}
              value={statusFilter}
              onValueChange={(value) => {
                if (value) setStatusFilter(value);
              }}
              aria-label="Status filter"
              className="flex-wrap"
            >
              {[
                { v: "all", label: "All" },
                { v: "launch", label: "Launches" },
                { v: "inflight", label: "In-flight" },
                { v: "completed", label: "Completed" },
              ].map(({ v, label }) => (
                <ToggleGroupItem key={v} value={v}>
                  {label}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
            <span className="text-muted-foreground">Side</span>
            <ToggleGroup
              type="single"
              variant="outline"
              spacing={0}
              value={sideFilter}
              onValueChange={(value) => {
                if (value) setSideFilter(value);
              }}
              aria-label="Side filter"
            >
              {["all", "YES", "NO"].map((side) => (
                <ToggleGroupItem key={side} value={side}>
                  {side === "all" ? "All" : side}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <Select value={strategyFilter} onValueChange={setStrategyFilter}>
              <SelectTrigger aria-label="Strategy filter" className="w-45">
                <SelectValue placeholder="Strategy" />
              </SelectTrigger>
              <SelectContent>
                {strategies.map((strategy) => (
                  <SelectItem key={strategy} value={strategy}>
                    {strategy === "all" ? "All strategies" : strategy}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={venueFilter} onValueChange={setVenueFilter}>
              <SelectTrigger aria-label="Venue filter" className="w-40">
                <SelectValue placeholder="Venue" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All venues</SelectItem>
                {Array.from(
                  new Set(allEntries.flatMap((entry) => (entry.venue ? [entry.venue] : []))),
                )
                  .sort()
                  .map((venue) => (
                    <SelectItem key={venue} value={venue}>
                      {VENUE_LABEL[venue] ?? venue}
                    </SelectItem>
                  ))}
              </SelectContent>
            </Select>
            <Input
              aria-label="Search tradelog"
              placeholder="Search markets, strategies or reasons…"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              className="min-w-48 flex-1"
            />
          </div>
        </CardContent>
      </Card>

      {/* ── Table ────────────────────────────────────────────────────────────── */}
      <Card size="sm" className="gap-0 pb-0">
        <CardContent className="flex flex-wrap items-center justify-between gap-3 pb-3">
          <span className="font-mono tabular-nums text-muted-foreground">
            {isLoading ? "Loading…" : `${filtered.length} entries`}
            {filtered.length < allEntries.length && ` (filtered from ${allEntries.length})`}
          </span>
          <div className="flex items-center gap-2">
            <Tooltip>
              <TooltipTrigger asChild>
                <span>
                  <Button
                    variant="outline"
                    onClick={refreshQuotes}
                    disabled={refreshing || !quotesRefreshable}
                    aria-label="Refresh live quotes"
                  >
                    <ArrowClockwiseIcon
                      data-icon="inline-start"
                      className={refreshing ? "animate-spin" : ""}
                    />
                    {refreshing ? "Refreshing…" : "Refresh quotes"}
                  </Button>
                </span>
              </TooltipTrigger>
              <TooltipContent>
                {quotesRefreshable
                  ? "Refresh live bid/ask for open positions, bypassing the server quote cache"
                  : "No open positions to refresh"}
              </TooltipContent>
            </Tooltip>
            <ExportCsvButton assets={assets} />
          </div>
        </CardContent>
        {loadErr && (
          <Alert variant="destructive">
            <AlertDescription>
              Couldn&apos;t load: {loadErr instanceof Error ? loadErr.message : String(loadErr)}
            </AlertDescription>
          </Alert>
        )}
        {isLoading ? (
          <CardContent
            className="space-y-3 pb-4"
            aria-busy="true"
            aria-label="Loading tradelog across all assets"
          >
            {Array.from({ length: 6 }, (_, i) => (
              <Skeleton key={i} className="h-8 w-full" />
            ))}
          </CardContent>
        ) : filtered.length === 0 ? (
          <Empty>
            <EmptyDescription>No entries match the current filters.</EmptyDescription>
          </Empty>
        ) : (
          <div>
            {/* The Table primitive owns this scrolling container. Bound its height
                so the sticky header and pinned columns share a single viewport. */}
            <Table
              ref={(table) => {
                table?.parentElement?.classList.add("max-h-160", "overflow-y-auto");
              }}
              className="border-separate border-spacing-0"
            >
              <TableHeader className="sticky top-0 z-30 bg-card">
                <TableRow>
                  {/* Time is pinned left so a horizontally scrolled row stays
                      identifiable; Actions is pinned right because RTB closes a
                      live position and must never be scrolled out of reach. */}
                  <TableHead className="sticky left-0 z-40 bg-card px-3">Time</TableHead>
                  {[
                    "Venue",
                    "Status",
                    "Strategy",
                    "Market",
                    "Size @ entry → exit",
                    "P&L",
                    "Reason / mode",
                  ].map((heading) => (
                    <TableHead key={heading} className="px-3">
                      {heading}
                    </TableHead>
                  ))}
                  <TableHead className="sticky right-0 z-40 border-l border-border bg-card px-3">
                    Actions
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filtered.map((e) => {
                  const isLong = ["YES", "UP", "BUY"].includes(e.side.toUpperCase());
                  const sm = STATUS_META[e.status];
                  const assetCls =
                    ASSET_COLOR[e.underlying ?? ""] ??
                    CLASS_COLOR[e.marketClass ?? ""] ??
                    "bg-muted text-muted-foreground border-border";
                  const isOpen = e.status !== "completed";

                  return (
                    <TableRow
                      key={e.key}
                      className={[
                        "group hover:bg-muted transition-colors",
                        e.status === "launch" ? "opacity-70" : "",
                      ].join(" ")}
                    >
                      {/* Time — pinned left */}
                      <TableCell className="sticky left-0 z-10 bg-card group-hover:bg-muted transition-colors px-3 py-2 text-muted-foreground whitespace-nowrap font-mono tabular-nums">
                        {e.chainAdopted ? (
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <Badge tabIndex={0} variant="warning">
                                Adopted
                              </Badge>
                            </TooltipTrigger>
                            <TooltipContent>Re-adopted from on-chain wallet</TooltipContent>
                          </Tooltip>
                        ) : (
                          fmtTime(e.ts)
                        )}
                      </TableCell>

                      {/* Venue */}
                      <TableCell className="px-3 py-2 whitespace-nowrap">
                        <Badge variant="secondary">
                          {e.venue ? (VENUE_LABEL[e.venue] ?? e.venue) : "—"}
                        </Badge>
                      </TableCell>

                      {/* Status */}
                      <TableCell className="px-3 py-2 whitespace-nowrap">
                        <Badge variant={sm.variant}>{sm.label}</Badge>
                      </TableCell>

                      {/* Strategy */}
                      <TableCell className="px-3 py-2 text-foreground whitespace-nowrap">
                        {shortStrategy(e.strategy)}
                      </TableCell>

                      {/* Market, prefixed with the asset. The Subject column was
                          folded in here rather than dropped: it duplicates the
                          asset filter pills only while a filter is applied, and
                          on "All" it is the sole thing identifying the row. */}
                      <TableCell className="px-3 py-2 text-muted-foreground max-w-47.5">
                        <Badge variant="outline" className={cn("mr-1.5 font-mono", assetCls)}>
                          {subjectBadge(e)}
                        </Badge>
                        <TipCell full={e.market} maxChars={24} />
                      </TableCell>

                      {/* Entry → Exit. Side rides along as a LABEL plus color,
                          never color alone, so it survives a mono display. */}
                      <TableCell className="px-3 py-2 whitespace-nowrap font-mono tabular-nums">
                        <span
                          className={`mr-1.5 text-xs font-bold ${isLong ? "text-success" : "text-destructive"}`}
                        >
                          {e.side}
                        </span>
                        {/* Size rides with the price it was filled at — one
                            execution, one cell. Kept muted so the price journey
                            stays the thing the eye lands on. */}
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <span tabIndex={0} className="text-muted-foreground">
                              {e.shares.toFixed(2)}
                            </span>
                          </TooltipTrigger>
                          <TooltipContent>{e.shares} shares</TooltipContent>
                        </Tooltip>
                        <span className="mx-1 text-muted-foreground">@</span>
                        <span className="text-foreground">{e.entry.toFixed(4)}</span>
                        <span className="mx-1 text-muted-foreground">→</span>
                        {e.curOrExit !== null ? (
                          (() => {
                            const delta = e.curOrExit - e.entry;
                            const color =
                              delta > 0
                                ? "text-success"
                                : delta < 0
                                  ? "text-destructive"
                                  : "text-foreground";
                            return (
                              <Tooltip>
                                <TooltipTrigger asChild>
                                  <span tabIndex={0} className={color}>
                                    {e.curOrExit.toFixed(4)}
                                    {isOpen && delta !== 0 && (
                                      <span className="ml-1 opacity-60 text-xs">
                                        {delta > 0 ? "▲" : "▼"}
                                      </span>
                                    )}
                                    {/* Age of the mark, shown whenever it is old enough
                                  to matter. A stale price that LOOKS live is what
                                  makes an operator mistime a manual exit. */}
                                    {/* A live bid is the number a manual exit gets, so
                                  say so. Anything else is a stored mark that can
                                  be minutes behind the book, and the operator
                                  needs to see which one they are looking at. */}
                                    {isOpen && e.priceIsLiveBid && (
                                      <span className="ml-1 text-xs text-success/70">
                                        {/* Age inline, not just in the tooltip. The
                                      quote TTL is operator-tunable up to 300s,
                                      so "bid" alone could label a five-minute-old
                                      number — the same trap the amber mark badge
                                      exists to avoid. */}
                                        {(e.priceAgeSecs ?? 0) > 0
                                          ? `bid ${e.priceAgeSecs}s`
                                          : "bid"}
                                      </span>
                                    )}
                                    {isOpen &&
                                      !e.priceIsLiveBid &&
                                      e.priceAgeSecs !== null &&
                                      e.priceAgeSecs >= 45 && (
                                        <span className="ml-1 text-xs text-warning/80">
                                          {e.priceAgeSecs >= 90
                                            ? `mark ${Math.round(e.priceAgeSecs / 60)}m old`
                                            : `mark ${e.priceAgeSecs}s old`}
                                        </span>
                                      )}
                                    {isOpen && !e.priceIsLiveBid && e.priceAgeSecs === null && (
                                      <span className="ml-1 text-xs text-warning/80">
                                        mark, age unknown
                                      </span>
                                    )}
                                  </span>
                                </TooltipTrigger>
                                <TooltipContent>
                                  {!isOpen
                                    ? "Exit price"
                                    : e.priceIsLiveBid
                                      ? `Live best bid from the venue (${e.priceAgeSecs === null ? "age unknown" : `${e.priceAgeSecs}s old`}). This is what a manual exit would sell into.`
                                      : e.priceAgeSecs === null
                                        ? "Stored mark price; refresh time unknown"
                                        : `Stored mark price, ${e.priceAgeSecs}s old. Refreshed on a 300s sweep, so it can lag the live book.`}
                                </TooltipContent>
                              </Tooltip>
                            );
                          })()
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </TableCell>

                      {/* P&L, with fees folded in beneath it. The two belong
                          together: the headline figure is already NET of the
                          fee, so showing them apart invites double-counting. */}
                      <TableCell className="px-3 py-2 font-semibold whitespace-nowrap font-mono tabular-nums">
                        <div>
                          {isOpen && e.curOrExit === null ? (
                            <span className="text-muted-foreground">—</span>
                          ) : (
                            <>
                              {fmtPnl(e.pnl)}
                              {fmtPnlPct(e.pnl, e.entry, e.shares)}
                            </>
                          )}
                          {isOpen && e.pnl !== null && (
                            <span className="ml-1 text-xs font-normal text-muted-foreground">
                              (unrlzd)
                            </span>
                          )}
                        </div>
                        {e.fees != null && e.fees > 0 && (
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <div
                                tabIndex={0}
                                className="text-xs font-normal text-muted-foreground cursor-help"
                              >
                                net · ${e.fees.toFixed(4)} fees
                              </div>
                            </TooltipTrigger>
                            <TooltipContent>
                              P&amp;L is net of venue fees. Gross was{" "}
                              {((e.pnl ?? 0) + e.fees).toFixed(4)}.
                            </TooltipContent>
                          </Tooltip>
                        )}
                      </TableCell>

                      {/* Reason / Mode */}
                      <TableCell className="px-3 py-2 text-muted-foreground max-w-45">
                        {e.status === "completed" && e.reason ? (
                          <TipCell full={e.reason} maxChars={28} />
                        ) : e.ghost ? (
                          <Badge variant="warning">
                            <GhostIcon />
                            Ghost
                          </Badge>
                        ) : (
                          <Badge variant="success">
                            <LightningIcon />
                            Live
                          </Badge>
                        )}
                        {/* The log says what executed; the intent says why it was
                            entered. Only Helm records that, so only Helm rows link. */}
                        {e.intentId != null && (
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <a
                                href="#helm"
                                className="mt-0.5 block font-mono text-xs tabular-nums text-primary hover:underline"
                              >
                                Intent #{e.intentId} →
                              </a>
                            </TooltipTrigger>
                            <TooltipContent>
                              Helm intent #{e.intentId} — the thesis, the critique and how it
                              resolved
                            </TooltipContent>
                          </Tooltip>
                        )}
                      </TableCell>

                      {/* Actions — pinned right */}
                      <TableCell className="sticky right-0 z-10 bg-card group-hover:bg-muted transition-colors border-l border-border px-3 py-2">
                        {e.status === "inflight" && e.rawPosition && !DEMO_MODE && (
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <Button
                                onClick={() => setRtbEntry(e)}
                                variant="outline"
                                className="border-warning/30 text-warning hover:bg-warning/10 hover:text-warning"
                              >
                                Close now
                              </Button>
                            </TooltipTrigger>
                            <TooltipContent>
                              Close now: sell this position at the live bid immediately
                            </TooltipContent>
                          </Tooltip>
                        )}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        )}

        {/* Filtered P&L footer */}
        {!isLoading &&
          filtered.length > 0 &&
          (() => {
            const realized = filtered
              .filter((e) => e.status === "completed")
              .reduce((s, e) => s + (e.pnl ?? 0), 0);
            const unrealized = filtered
              .filter((e) => e.status !== "completed" && e.pnl !== null)
              .reduce((s, e) => s + (e.pnl ?? 0), 0);
            const net = realized + unrealized;
            return (
              <div className="px-4 py-3 border-t border-border flex flex-wrap gap-6 text-xs">
                <span className="text-muted-foreground">
                  Realized:{" "}
                  <span className={cn("font-mono tabular-nums", TONE_TEXT[signTone(realized)])}>
                    {realized >= 0 ? "+" : ""}${realized.toFixed(4)}
                  </span>
                </span>
                <span className="text-muted-foreground">
                  Unrealized:{" "}
                  <span className={cn("font-mono tabular-nums", TONE_TEXT[signTone(unrealized)])}>
                    {unrealized >= 0 ? "+" : ""}${unrealized.toFixed(4)}
                  </span>
                </span>
                <span className="text-muted-foreground">
                  Net:{" "}
                  <span
                    className={cn("font-mono tabular-nums font-semibold", TONE_TEXT[signTone(net)])}
                  >
                    {net >= 0 ? "+" : ""}${net.toFixed(4)}
                  </span>
                </span>
              </div>
            );
          })()}
      </Card>

      {/* RTB Modal */}
      {rtbEntry && (
        <RtbModal
          entry={rtbEntry}
          onClose={() => setRtbEntry(null)}
          onConfirm={handleRtbConfirm}
          loading={rtbLoading}
        />
      )}
    </div>
  );
}
