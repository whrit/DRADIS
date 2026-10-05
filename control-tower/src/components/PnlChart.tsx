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

import { useState, useCallback, useRef } from "react";
import { ComposedChart, Area, Line, XAxis, YAxis, CartesianGrid, ReferenceLine } from "recharts";
import type { PnlSnapshotRow, TradeRow, OpenPositionRow } from "@/lib/types";
import { CheckCircleIcon, CrosshairIcon, GhostIcon } from "@phosphor-icons/react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { ChartContainer, ChartTooltip, type ChartConfig } from "@/components/ui/chart";
import { Empty, EmptyDescription } from "@/components/ui/empty";
import { TONE_TEXT, signTone } from "@/components/shared";

const chartConfig = {
  totalValue: { label: "Total value", color: "var(--success)" },
  cash: { label: "Cash", color: "var(--primary)" },
} satisfies ChartConfig;

interface Props {
  data: PnlSnapshotRow[];
  startingBalance?: number;
  /** When true, compute balance as startingBalance + session_pnl (ghost mode — on-chain balance is flat). */
  ghostMode?: boolean;
  /** Completed trade events (exits) to overlay on the chart as markers. */
  trades?: TradeRow[];
  /** Open positions (entries) to overlay on the chart as markers. */
  openPositions?: OpenPositionRow[];
  /** Set when the history request failed, so an empty chart is not read as "no data yet". */
  loadError?: string;
}

function fmt(iso: string) {
  return new Date(iso).toLocaleTimeString("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

/** One trade close snapped to a chart point. */
type TradeEvent = { trade: TradeRow; pnl: number };
/** One position entry snapped to a chart point. */
type PositionEvent = { position: OpenPositionRow };

/** Warning GHOST chip shared by both tooltip headers. */
function GhostChip({ text }: { text: string }) {
  return (
    <Badge variant="warning" className="whitespace-nowrap tabular-nums">
      {text}
    </Badge>
  );
}

/** Success LIVE chip — only shown beside a GHOST chip, to flag a mixed group. */
function LiveChip({ text }: { text: string }) {
  return (
    <Badge variant="success" className="whitespace-nowrap tabular-nums">
      {text}
    </Badge>
  );
}

function pnlColorOf(pnl: number) {
  return TONE_TEXT[signTone(pnl)];
}
function fmtSignedUsd(pnl: number) {
  return `${pnl >= 0 ? "+" : ""}$${pnl.toFixed(2)}`;
}

/**
 * Tooltip body for every trade close snapped to ONE chart point.
 *
 * Takes an array, not a single event: snapshots land every 30s
 * (DASHBOARD_SYNC_SECS), so two closes inside one window snap to the same
 * point. The old single-value shape made the second close silently replace the
 * first, and on a mixed chart the vanished marker could be the real-money one.
 *
 * Ghost handling per event, not per point. The amber border and a header chip
 * flag simulation the moment the tooltip opens — the question it has to answer
 * first is "was this real money?", and a mixed chart (paper trades from a
 * ghost soak beside live ones) is the normal case after an operator flips
 * modes. A group holding both kinds shows BOTH counts in the header and tags
 * each ghost row, because rendering a mixed group as all-live would be a
 * worse lie than dropping a marker was. For the same reason the aggregate
 * P&L line never blends the two: paper P&L added into a real number would
 * manufacture a result no wallet saw.
 */
function TradeCloseTip({ events, label }: { events: TradeEvent[]; label: string }) {
  const ghostEvents = events.filter((e) => e.trade.ghost === true);
  const liveEvents = events.filter((e) => e.trade.ghost !== true);
  const allGhost = liveEvents.length === 0;
  const mixed = ghostEvents.length > 0 && liveEvents.length > 0;
  const livePnl = liveEvents.reduce((s, e) => s + e.pnl, 0);
  const ghostPnl = ghostEvents.reduce((s, e) => s + e.pnl, 0);
  const grouped = events.length > 1;
  return (
    <Card
      size="sm"
      className={`bg-popover text-popover-foreground gap-0 px-3 py-2 text-xs space-y-1.5 shadow-xl border-2 w-52 ${
        ghostEvents.length > 0 ? "border-warning/40" : "border-success/30"
      }`}
    >
      <div
        className={`font-semibold flex flex-wrap items-center gap-1.5 tabular-nums ${
          allGhost ? "text-warning" : "text-success"
        }`}
      >
        {allGhost ? (
          <GhostIcon className="size-4 shrink-0" />
        ) : (
          <CheckCircleIcon className="size-4 shrink-0" />
        )}
        <span>{grouped ? `Trade closes ×${events.length}` : "Trade close"}</span>
        <span className="ml-auto flex items-center gap-1">
          {ghostEvents.length > 0 && (
            <GhostChip text={allGhost ? "GHOST" : `${ghostEvents.length} GHOST`} />
          )}
          {mixed && <LiveChip text={`${liveEvents.length} LIVE`} />}
        </span>
      </div>
      <div className="font-mono tabular-nums text-muted-foreground text-xs border-t border-border pt-1">
        {label}
      </div>
      {grouped && (
        <div className="flex justify-between gap-3 border-t border-border pt-1">
          <span className="text-muted-foreground">Σ P&L</span>
          {mixed ? (
            <span>
              <span className={`font-mono tabular-nums font-semibold ${pnlColorOf(livePnl)}`}>
                {fmtSignedUsd(livePnl)}
              </span>
              <span className="text-muted-foreground"> live · </span>
              <span className="text-warning font-mono tabular-nums">
                {fmtSignedUsd(ghostPnl)} <GhostIcon className="inline size-3" aria-label="Ghost" />
              </span>
            </span>
          ) : (
            <span
              className={`font-mono tabular-nums font-semibold ${pnlColorOf(livePnl + ghostPnl)}`}
            >
              {fmtSignedUsd(livePnl + ghostPnl)}
            </span>
          )}
        </div>
      )}
      {events.map(({ trade, pnl }, i) => (
        <div
          key={`${trade.ts}-${trade.market}-${i}`}
          className="space-y-0.5 pt-1 border-t border-border"
        >
          <div className="flex justify-between gap-3">
            <span className="text-muted-foreground">Strategy</span>
            <span className="text-foreground truncate">
              {grouped && trade.ghost === true && (
                <GhostIcon className="mr-1 inline size-3 text-warning" aria-label="Ghost" />
              )}
              {trade.strategy}
            </span>
          </div>
          <div className="flex justify-between gap-3">
            <span className="text-muted-foreground">Market</span>
            <span className="text-foreground text-xs truncate max-w-27.5">
              {trade.market.split(" ").slice(0, 3).join(" ")}
            </span>
          </div>
          <div className="flex justify-between gap-3">
            <span className="text-muted-foreground">Side</span>
            <span className="text-primary">{trade.side}</span>
          </div>
          <div className="flex justify-between gap-3">
            <span className="text-muted-foreground">Shares</span>
            <span className="font-mono tabular-nums text-foreground">
              {parseFloat(trade.shares).toFixed(2)}
            </span>
          </div>
          <div className="flex justify-between gap-3">
            <span className="text-muted-foreground">P&L</span>
            <span className={`font-mono tabular-nums font-semibold ${pnlColorOf(pnl)}`}>
              {fmtSignedUsd(pnl)}
            </span>
          </div>
          <div className="flex justify-between gap-3">
            <span className="text-muted-foreground">Reason</span>
            <span className="text-muted-foreground text-xs truncate max-w-27.5">
              {trade.reason}
            </span>
          </div>
        </div>
      ))}
    </Card>
  );
}

/**
 * Tooltip body for every position entry snapped to ONE chart point.
 * Same array shape and ghost rules as `TradeCloseTip`; primary is the live
 * accent for entries, amber still means simulated.
 */
function PositionEntryTip({ events, label }: { events: PositionEvent[]; label: string }) {
  const ghostEvents = events.filter((e) => e.position.ghost_mode === true);
  const liveCount = events.length - ghostEvents.length;
  const allGhost = liveCount === 0;
  const mixed = ghostEvents.length > 0 && liveCount > 0;
  const grouped = events.length > 1;
  return (
    <Card
      size="sm"
      className={`bg-popover text-popover-foreground gap-0 px-3 py-2 text-xs space-y-1.5 shadow-xl border-2 w-52 ${
        ghostEvents.length > 0 ? "border-warning/40" : "border-primary/30"
      }`}
    >
      <div
        className={`font-semibold flex flex-wrap items-center gap-1.5 tabular-nums ${
          allGhost ? "text-warning" : "text-primary"
        }`}
      >
        {allGhost ? (
          <GhostIcon className="size-4 shrink-0" />
        ) : (
          <CrosshairIcon className="size-4 shrink-0" />
        )}
        <span>{grouped ? `Position entries ×${events.length}` : "Position entry"}</span>
        <span className="ml-auto flex items-center gap-1">
          {ghostEvents.length > 0 && (
            <GhostChip text={allGhost ? "GHOST" : `${ghostEvents.length} GHOST`} />
          )}
          {mixed && <LiveChip text={`${liveCount} LIVE`} />}
        </span>
      </div>
      <div className="font-mono tabular-nums text-muted-foreground text-xs border-t border-border pt-1">
        {label}
      </div>
      {events.map(({ position }, i) => (
        <div key={`${position.token_id}-${i}`} className="space-y-0.5 pt-1 border-t border-border">
          <div className="flex justify-between gap-3">
            <span className="text-muted-foreground">Strategy</span>
            <span className="text-foreground truncate">
              {grouped && position.ghost_mode === true && (
                <GhostIcon className="mr-1 inline size-3 text-warning" aria-label="Ghost" />
              )}
              {position.strategy}
            </span>
          </div>
          <div className="flex justify-between gap-3">
            <span className="text-muted-foreground">Market</span>
            <span className="text-foreground text-xs truncate max-w-27.5">
              {position.market.split(" ").slice(0, 3).join(" ")}
            </span>
          </div>
          <div className="flex justify-between gap-3">
            <span className="text-muted-foreground">Side</span>
            <span className="text-primary">{position.side}</span>
          </div>
          <div className="flex justify-between gap-3">
            <span className="text-muted-foreground">Entry price</span>
            <span className="font-mono tabular-nums text-foreground">
              {parseFloat(position.entry_price).toFixed(4)}
            </span>
          </div>
          <div className="flex justify-between gap-3">
            <span className="text-muted-foreground">Shares</span>
            <span className="font-mono tabular-nums text-foreground">
              {parseFloat(position.shares).toFixed(2)}
            </span>
          </div>
          <div className="flex justify-between gap-3">
            <span className="text-muted-foreground">Status</span>
            <span className="text-warning">Open</span>
          </div>
        </div>
      ))}
    </Card>
  );
}

export default function PnlChart({
  data,
  startingBalance,
  ghostMode,
  trades,
  openPositions,
  loadError,
}: Props) {
  // API returns newest-first — reverse for chronological chart display
  const base = startingBalance ?? 0;
  const reversedData = [...data].reverse();

  // Birdeye-style: track hovered point to show value in header area.
  //
  // Stores the active *index*, not the datum: recharts v3 dropped `activePayload`
  // from the chart mouse-handler state (only activeTooltipIndex / activeLabel /
  // isTooltipActive survive), so the index is the only handle back to the row.
  // It is resolved against `chartDataWithMarkers` below.
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null);
  // Custom marker tooltip — bypasses Recharts hit-area limitations.
  //
  // Carries the whole EVENT ARRAY for the hovered point plus the point's raw
  // `ts`. The ts is what the dot renderers compare against for the active
  // halo: the arrays are rebuilt on every render, so identity comparison
  // against a payload captured at mouse-enter time would silently stop
  // matching after any refetch re-render.
  type MarkerTipState =
    | {
        kind: "trade";
        events: TradeEvent[];
        pointTs: string;
        label: string;
        x: number;
        y: number;
      }
    | {
        kind: "position";
        events: PositionEvent[];
        pointTs: string;
        label: string;
        x: number;
        y: number;
      }
    | null;
  const [markerTip, setMarkerTip] = useState<MarkerTipState>(null);
  const chartContainerRef = useRef<HTMLDivElement>(null);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const handleMouseMove = useCallback((state: any) => {
    // recharts v3 hands back a STRING index, not a number: its
    // `combineActiveTooltipIndex` combiner returns `String(clampedIndex)` on
    // every success path, and the type is `number | TooltipIndex | undefined`
    // where `TooltipIndex = string | null`.
    //
    // The previous fix here moved off the v2 `activePayload` (correct — v3
    // dropped it) but kept a `typeof idx === 'number'` guard, which can never
    // pass under v3. hoveredIndex stayed null forever and the header silently
    // fell back to the latest point, so hovering never changed Total/Cash.
    // Coerce instead of type-testing; recharts has already clamped the value to
    // [0, data.length - 1] before we see it.
    //
    // `activeIndex` is documented as an exact duplicate kept for v2 back-compat.
    const raw = state?.activeTooltipIndex ?? state?.activeIndex;
    const idx =
      typeof raw === "number"
        ? raw
        : typeof raw === "string" && raw.trim() !== ""
          ? Number(raw)
          : NaN;
    // Upper bound is enforced where it is read (`chartDataWithMarkers[i] ?? null`),
    // which keeps this callback free of data deps and stable across renders.
    const valid = state?.isTooltipActive && Number.isInteger(idx) && idx >= 0;
    setHoveredIndex(valid ? idx : null);
  }, []);
  const handleMouseLeave = useCallback(() => setHoveredIndex(null), []);

  const chartData = reversedData.map((row) => {
    const sessionPnl = parseFloat(row.session_pnl);
    const collateral = parseFloat(row.collateral);

    // Cash: actual collateral (liquid funds)
    const cash = ghostMode ? base + sessionPnl : collateral;

    // Total value uses the same asset-scoped snapshot source for every point.
    // Mixing an all-assets realtime value into a single-asset series creates
    // artificial right-edge spikes/vertical lines.
    let totalValue: number;

    if (row.total_value) {
      // Use historical total value stored in snapshot (cash + positions at that time)
      totalValue = parseFloat(row.total_value);
    } else {
      // Fallback for old snapshots that don't have total_value recorded yet
      totalValue = base + sessionPnl;
    }

    return {
      time: fmt(row.ts),
      ts: row.ts, // Keep raw timestamp for marker matching
      cash,
      totalValue,
      pnl: sessionPnl,
    };
  });

  // Calculate basic domain first
  const allValues = chartData.flatMap((d) => [d.cash, d.totalValue]);
  const minVal = Math.min(...allValues);
  const maxVal = Math.max(...allValues);
  const yRange = Math.max(maxVal - minVal, 10); // Ensure minimum range of 10 for marker visibility

  // Filter trades and positions to only those within the chart's time range
  const oldestSnapshotTime = reversedData[0] ? new Date(reversedData[0].ts).getTime() : 0;
  const newestSnapshotTime = reversedData[reversedData.length - 1]
    ? new Date(reversedData[reversedData.length - 1].ts).getTime()
    : Date.now();

  const tradesInRange = (trades ?? []).filter((trade) => {
    const tradeTime = new Date(trade.ts).getTime();
    return tradeTime >= oldestSnapshotTime && tradeTime <= newestSnapshotTime;
  });

  const positionsInRange = (openPositions ?? []).filter((position) => {
    const positionTime = new Date(position.ts).getTime();
    return positionTime >= oldestSnapshotTime && positionTime <= newestSnapshotTime;
  });

  // Build marker lookup maps keyed by the chart point's RAW timestamp.
  //
  // Not `point.time`: that is `fmt()`ed to HH:MM, while snapshots are written
  // every DASHBOARD_SYNC_SECS (30s). Two points per minute therefore share one
  // `time` string, and since the dot is painted on every point whose key is in
  // the map, a single trade rendered *two* overlay markers. `ts` is unique per
  // point, so each event marks exactly the point it snapped to.
  //
  // Each key holds an ARRAY of events. With the 30s cadence, two closes (or
  // two entries) inside one window snap to the same point; the previous
  // single-value maps made `Map.set` keep only the last one, so the earlier
  // event silently vanished from the chart. Always an undercount, never a
  // spurious marker — and on a mixed ghost/live chart the dropped one could
  // be the real-money trade.
  const tradeMarkerMap = new Map<string, TradeEvent[]>();
  const positionMarkerMap = new Map<string, PositionEvent[]>();

  tradesInRange.forEach((trade) => {
    const tradeTime = new Date(trade.ts).getTime();
    const closestPoint = chartData.reduce((closest, point) => {
      const pointTime = new Date(point.ts).getTime();
      const closestTime = new Date(closest.ts).getTime();
      return Math.abs(pointTime - tradeTime) < Math.abs(closestTime - tradeTime) ? point : closest;
    }, chartData[0]);
    if (closestPoint) {
      const event: TradeEvent = { pnl: parseFloat(trade.pnl), trade };
      const group = tradeMarkerMap.get(closestPoint.ts);
      if (group) group.push(event);
      else tradeMarkerMap.set(closestPoint.ts, [event]);
    }
  });

  positionsInRange.forEach((position) => {
    const positionTime = new Date(position.ts).getTime();
    const closestPoint = chartData.reduce((closest, point) => {
      const pointTime = new Date(point.ts).getTime();
      const closestTime = new Date(closest.ts).getTime();
      return Math.abs(pointTime - positionTime) < Math.abs(closestTime - positionTime)
        ? point
        : closest;
    }, chartData[0]);
    if (closestPoint) {
      const group = positionMarkerMap.get(closestPoint.ts);
      if (group) group.push({ position });
      else positionMarkerMap.set(closestPoint.ts, [{ position }]);
    }
  });

  // Merge marker flags into chartData so Line components can render custom dots
  // on the categorical XAxis (Scatter doesn't support categorical axes reliably)
  const chartDataWithMarkers = chartData.map((point) => ({
    ...point,
    tradeDot: tradeMarkerMap.has(point.ts) ? point.totalValue + yRange * 0.15 : undefined,
    positionDot: positionMarkerMap.has(point.ts) ? point.totalValue + yRange * 0.08 : undefined,
    _tradeMarkers: tradeMarkerMap.get(point.ts),
    _positionMarkers: positionMarkerMap.get(point.ts),
  }));

  // Header readout follows the cursor; falls back to the latest point when idle.
  const hoveredPoint = hoveredIndex !== null ? (chartDataWithMarkers[hoveredIndex] ?? null) : null;

  // For legend display (count)
  const tradeEvents = tradesInRange;
  const positionEvents = positionsInRange;

  if (chartData.length === 0) {
    return (
      <Card className="min-h-48 justify-center">
        <CardContent>
          {loadError ? (
            <Alert variant="destructive">
              <AlertDescription>Couldn&apos;t load balance history: {loadError}</AlertDescription>
            </Alert>
          ) : (
            <Empty>
              <EmptyDescription>
                No balance data yet — snapshots are recorded every 60 s.
              </EmptyDescription>
            </Empty>
          )}
        </CardContent>
      </Card>
    );
  }

  // Calculate Y-axis domain with padding to fit both lines and markers
  // Add extra padding at top for markers positioned at totalValue + yRange * 0.15
  const topPad = yRange * 0.25; // Increased to ensure markers are visible
  const bottomPad = yRange * 0.05;
  const domain = [Math.floor(minVal - bottomPad), Math.ceil(maxVal + topPad)];

  return (
    <Card className="overflow-visible">
      {/* Birdeye-style header: static legend + live hovered value display */}
      <CardHeader className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <CardTitle>Portfolio overview</CardTitle>
          {/* Live value display — updates as cursor moves over chart */}
          <div className="mt-0.5">
            {hoveredPoint ? (
              <div className="flex flex-wrap items-baseline gap-3">
                <span className="font-mono tabular-nums text-lg font-semibold text-success">
                  ${hoveredPoint.totalValue.toFixed(2)}
                </span>
                <span className="text-xs text-muted-foreground">total</span>
                <span className="font-mono tabular-nums text-sm text-primary">
                  ${hoveredPoint.cash.toFixed(2)}
                </span>
                <span className="text-xs text-muted-foreground">cash</span>
                {hoveredPoint.totalValue - hoveredPoint.cash > 0 && (
                  <>
                    <span className="font-mono tabular-nums text-sm text-muted-foreground">
                      ${(hoveredPoint.totalValue - hoveredPoint.cash).toFixed(2)}
                    </span>
                    <span className="text-xs text-muted-foreground">in positions</span>
                  </>
                )}
                <span className="font-mono tabular-nums text-xs text-muted-foreground">
                  {hoveredPoint.time}
                </span>
              </div>
            ) : (
              (() => {
                const latest = chartDataWithMarkers[chartDataWithMarkers.length - 1];
                const inPos = latest ? latest.totalValue - latest.cash : 0;
                return latest ? (
                  <div className="flex flex-wrap items-baseline gap-3">
                    <span className="font-mono tabular-nums text-lg font-semibold text-success">
                      ${latest.totalValue.toFixed(2)}
                    </span>
                    <span className="text-xs text-muted-foreground">total</span>
                    <span className="font-mono tabular-nums text-sm text-primary">
                      ${latest.cash.toFixed(2)}
                    </span>
                    <span className="text-xs text-muted-foreground">cash</span>
                    {inPos > 0 && (
                      <>
                        <span className="font-mono tabular-nums text-sm text-muted-foreground">
                          ${inPos.toFixed(2)}
                        </span>
                        <span className="text-xs text-muted-foreground">in positions</span>
                      </>
                    )}
                  </div>
                ) : null;
              })()
            )}
          </div>
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
          <div className="flex items-center gap-1.5">
            <div className="w-3 h-0.5 bg-success" />
            <span className="text-muted-foreground">Total value</span>
          </div>
          <div className="flex items-center gap-1.5">
            <div className="w-3 h-0.5 bg-primary" />
            <span className="text-muted-foreground">Cash</span>
          </div>
          {positionEvents.length > 0 && (
            <div className="flex items-center gap-1.5">
              <div className="w-4 h-4 rounded-full bg-primary flex items-center justify-center text-primary-foreground text-xs font-bold">
                B
              </div>
              <span className="tabular-nums text-muted-foreground">
                Entries ({positionEvents.length})
              </span>
            </div>
          )}
          {tradeEvents.length > 0 && (
            <div className="flex items-center gap-1.5">
              <div className="w-4 h-4 rounded-full bg-success flex items-center justify-center text-primary-foreground text-xs font-bold">
                S
              </div>
              <span className="tabular-nums text-muted-foreground">
                Exits ({tradeEvents.length})
              </span>
            </div>
          )}
        </div>
      </CardHeader>

      {/* Stacked chart containers: Portfolio chart + Marker overlay */}
      <CardContent>
        <div ref={chartContainerRef} className="relative h-80">
          {/* Custom marker tooltip overlay — positioned absolutely over chart */}
          {markerTip && (
            <div
              className="absolute z-50 pointer-events-none"
              style={{
                left: Math.min(
                  markerTip.x + 14,
                  (chartContainerRef.current?.clientWidth ?? 600) - 220,
                ),
                top: Math.max(markerTip.y - 10, 0),
              }}
            >
              {markerTip.kind === "trade" ? (
                <TradeCloseTip events={markerTip.events} label={markerTip.label} />
              ) : (
                <PositionEntryTip events={markerTip.events} label={markerTip.label} />
              )}
            </div>
          )}

          <ChartContainer config={chartConfig} className="h-80 w-full aspect-auto tabular-nums">
            <ComposedChart
              data={chartDataWithMarkers}
              margin={{ top: 20, right: 12, bottom: 0, left: 0 }}
              onMouseMove={handleMouseMove}
              onMouseLeave={handleMouseLeave}
            >
              <defs>
                <linearGradient id="totalGrad" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="var(--color-totalValue)" stopOpacity={0.2} />
                  <stop offset="95%" stopColor="var(--color-totalValue)" stopOpacity={0} />
                </linearGradient>
                <linearGradient id="cashGrad" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="var(--color-cash)" stopOpacity={0.15} />
                  <stop offset="95%" stopColor="var(--color-cash)" stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
              <XAxis
                dataKey="time"
                tick={{ fill: "var(--muted-foreground)", fontSize: 11, fontFamily: "monospace" }}
                tickLine={false}
                axisLine={{ stroke: "var(--border)" }}
                interval="preserveStartEnd"
                minTickGap={20}
              />
              <YAxis
                domain={domain}
                tick={{ fill: "var(--muted-foreground)", fontSize: 11, fontFamily: "monospace" }}
                tickLine={false}
                axisLine={false}
                tickFormatter={(v) => `$${v}`}
                width={60}
              />
              {/* Value stays in the header; marker details use the custom SVG overlay. */}
              <ChartTooltip content={() => null} />
              {startingBalance !== undefined && (
                <ReferenceLine
                  y={startingBalance}
                  stroke="var(--border)"
                  strokeDasharray="4 4"
                  label={{
                    value: "Session start",
                    position: "insideTopRight",
                    fill: "var(--muted-foreground)",
                    fontSize: 10,
                  }}
                />
              )}
              {/* Total value - render first so it's behind */}
              <Area
                type="monotone"
                dataKey="totalValue"
                stroke="var(--color-totalValue)"
                strokeWidth={2.5}
                fill="url(#totalGrad)"
                dot={false}
                activeDot={{
                  r: 4,
                  fill: "var(--color-totalValue)",
                  stroke: "var(--card)",
                  strokeWidth: 2,
                }}
              />
              {/* Cash - render second so it's in front */}
              <Area
                type="monotone"
                dataKey="cash"
                stroke="var(--color-cash)"
                strokeWidth={2}
                fill="url(#cashGrad)"
                dot={false}
                activeDot={{
                  r: 4,
                  fill: "var(--color-cash)",
                  stroke: "var(--card)",
                  strokeWidth: 2,
                }}
              />

              {/* Position entry markers — large transparent hit circle captures hover via SVG events */}
              <Line
                dataKey="positionDot"
                stroke="none"
                strokeWidth={0}
                isAnimationActive={false}
                dot={(props: any) => {
                  if (props.payload.positionDot === undefined) return <g key={props.key} />;
                  const { cx, cy, payload } = props;
                  const events: PositionEvent[] = payload._positionMarkers ?? [];
                  const isActive =
                    markerTip?.kind === "position" && markerTip.pointTs === payload.ts;
                  return (
                    <g
                      key={props.key}
                      className="cursor-pointer"
                      onMouseEnter={(e) => {
                        const rect = chartContainerRef.current?.getBoundingClientRect();
                        if (rect)
                          setMarkerTip({
                            kind: "position",
                            events,
                            pointTs: payload.ts,
                            label: payload.time,
                            x: e.clientX - rect.left,
                            y: e.clientY - rect.top,
                          });
                      }}
                      onMouseLeave={() => setMarkerTip(null)}
                    >
                      {/* Large transparent hit area */}
                      <circle cx={cx} cy={cy} r={18} fill="transparent" />
                      {isActive && (
                        <circle
                          cx={cx}
                          cy={cy}
                          r={14}
                          fill="var(--primary)"
                          fillOpacity={0.2}
                          stroke="var(--primary)"
                          strokeWidth={1.5}
                          strokeDasharray="3 2"
                        />
                      )}
                      <circle
                        cx={cx}
                        cy={cy}
                        r={8}
                        fill="var(--primary)"
                        stroke="var(--card)"
                        strokeWidth={1.5}
                        opacity={0.95}
                      />
                      <text
                        x={cx}
                        y={cy}
                        textAnchor="middle"
                        dominantBaseline="central"
                        fill="var(--primary-foreground)"
                        fontSize="10"
                        fontWeight="600"
                        fontFamily="monospace"
                        pointerEvents="none"
                      >
                        B
                      </text>
                      {/* Count badge: one dot per point, so a group of entries has to
                        say it is a group or the extra events read as absent. */}
                      {events.length > 1 && (
                        <>
                          <circle
                            cx={cx + 8}
                            cy={cy - 8}
                            r={5.5}
                            fill="var(--card)"
                            stroke="var(--primary)"
                            strokeWidth={1}
                          />
                          <text
                            x={cx + 8}
                            y={cy - 8}
                            textAnchor="middle"
                            dominantBaseline="central"
                            fill="var(--primary)"
                            fontSize="8"
                            fontWeight="700"
                            fontFamily="monospace"
                            pointerEvents="none"
                          >
                            {events.length}
                          </text>
                        </>
                      )}
                    </g>
                  );
                }}
                activeDot={false}
              />

              {/* Trade exit markers — large transparent hit circle captures hover via SVG events */}
              <Line
                dataKey="tradeDot"
                stroke="none"
                strokeWidth={0}
                isAnimationActive={false}
                dot={(props: any) => {
                  if (props.payload.tradeDot === undefined) return <g key={props.key} />;
                  const { cx, cy, payload } = props;
                  const events: TradeEvent[] = payload._tradeMarkers ?? [];
                  // The dot is one glyph for the whole group, so it is colored by
                  // the group's NET P&L — the number the point reads as at a
                  // glance. Per-event signs live in the tooltip.
                  const pnl = events.reduce((s: number, ev: TradeEvent) => s + ev.pnl, 0);
                  const color =
                    pnl > 0
                      ? "var(--success)"
                      : pnl < 0
                        ? "var(--destructive)"
                        : "var(--muted-foreground)";
                  const isActive = markerTip?.kind === "trade" && markerTip.pointTs === payload.ts;
                  return (
                    <g
                      key={props.key}
                      className="cursor-pointer"
                      onMouseEnter={(e) => {
                        const rect = chartContainerRef.current?.getBoundingClientRect();
                        if (rect)
                          setMarkerTip({
                            kind: "trade",
                            events,
                            pointTs: payload.ts,
                            label: payload.time,
                            x: e.clientX - rect.left,
                            y: e.clientY - rect.top,
                          });
                      }}
                      onMouseLeave={() => setMarkerTip(null)}
                    >
                      {/* Large transparent hit area */}
                      <circle cx={cx} cy={cy} r={18} fill="transparent" />
                      {isActive && (
                        <circle
                          cx={cx}
                          cy={cy}
                          r={14}
                          fill={color}
                          fillOpacity={0.2}
                          stroke={color}
                          strokeWidth={1.5}
                          strokeDasharray="3 2"
                        />
                      )}
                      <circle
                        cx={cx}
                        cy={cy}
                        r={8}
                        fill={color}
                        stroke="var(--card)"
                        strokeWidth={1.5}
                        opacity={0.95}
                      />
                      <text
                        x={cx}
                        y={cy}
                        textAnchor="middle"
                        dominantBaseline="central"
                        fill="var(--primary-foreground)"
                        fontSize="10"
                        fontWeight="600"
                        fontFamily="monospace"
                        pointerEvents="none"
                      >
                        S
                      </text>
                      {/* Count badge: one dot per point, so a group of closes has to
                        say it is a group or the extra events read as absent. */}
                      {events.length > 1 && (
                        <>
                          <circle
                            cx={cx + 8}
                            cy={cy - 8}
                            r={5.5}
                            fill="var(--card)"
                            stroke={color}
                            strokeWidth={1}
                          />
                          <text
                            x={cx + 8}
                            y={cy - 8}
                            textAnchor="middle"
                            dominantBaseline="central"
                            fill="var(--foreground)"
                            fontSize="8"
                            fontWeight="700"
                            fontFamily="monospace"
                            pointerEvents="none"
                          >
                            {events.length}
                          </text>
                        </>
                      )}
                    </g>
                  );
                }}
                activeDot={false}
              />
            </ComposedChart>
          </ChartContainer>
        </div>
      </CardContent>
      <CardFooter className="block text-xs text-muted-foreground tabular-nums">
        <span className="text-muted-foreground">Cash</span> = liquid funds ·{" "}
        <span className="text-muted-foreground">Total value</span> = cash + positions (current point
        uses live data; historical points approximate)
        {(positionEvents.length > 0 || tradeEvents.length > 0) && (
          <>
            {" · "}
            <span className="text-muted-foreground">Markers</span>:
            {positionEvents.length > 0 && (
              <span>
                {" "}
                <span className="inline-block w-4 h-4 rounded-full bg-primary text-primary-foreground text-xs font-semibold leading-4 text-center align-middle">
                  B
                </span>{" "}
                buy
              </span>
            )}
            {positionEvents.length > 0 && tradeEvents.length > 0 && " / "}
            {tradeEvents.length > 0 && (
              <span>
                <span className="inline-block w-4 h-4 rounded-full bg-success text-primary-foreground text-xs font-semibold leading-4 text-center align-middle">
                  S
                </span>{" "}
                sell (profit) /{" "}
                <span className="inline-block w-4 h-4 rounded-full bg-destructive text-primary-foreground text-xs font-semibold leading-4 text-center align-middle">
                  S
                </span>{" "}
                sell (loss)
              </span>
            )}
            {(tradesInRange.length < (trades?.length ?? 0) ||
              positionsInRange.length < (openPositions?.length ?? 0)) && (
              <span className="text-muted-foreground">
                {" "}
                (showing {positionsInRange.length + tradesInRange.length} of{" "}
                {(trades?.length ?? 0) + (openPositions?.length ?? 0)} events in range)
              </span>
            )}
          </>
        )}
      </CardFooter>
    </Card>
  );
}
