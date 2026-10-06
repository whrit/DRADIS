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

"use client";

import useSWR from "swr";
import { getLatency, type Histogram } from "@/lib/api";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Empty, EmptyDescription, EmptyHeader } from "@/components/ui/empty";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Stat } from "@/components/shared";

/** A percentile from a bucketed histogram: the bucket's upper bound. */
function ms(h: Histogram, p: number | null): string {
  if (h.count === 0) return "—";
  if (p === null) return ">60 s";
  return p >= 1000 ? `≤${p / 1000} s` : `≤${p} ms`;
}

function bps(count: number, p: number | null): string {
  if (count === 0) return "—";
  if (p === null) return ">1000";
  return `≤${p}`;
}

const COLUMNS = ["Strategy", "Side", "Intent", "Fills", "p50 bps", "p95 bps", "Adverse $", "Unmeasured"];

/**
 * Execution timing and slippage since the engine started (GET /api/latency).
 *
 * Every figure is host-observed: order round trips run from request start to
 * parsed reply, not to the venue's matching engine. Slippage is the fill price
 * against the price the strategy evaluated, positive meaning it cost money,
 * and only counts fills whose price the venue reported.
 */
export default function ExecutionQualityCard() {
  // Same key and cadence as the footer meter, so the two share one poll.
  const { data } = useSWR("latency", getLatency, {
    refreshInterval: 15_000,
    revalidateOnFocus: false,
  });
  if (!data?.timing) return null;
  const t = data.timing;
  const cohorts = data.slippage?.cohorts ?? [];
  const single = t.placement_single;
  const failed = single.failed + t.placement_batch.failed;
  const timedOut = single.timed_out + t.placement_batch.timed_out;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Execution quality</CardTitle>
        <CardDescription>Since engine start · upper-bound buckets · host-observed</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Stat
            label="Tick p95"
            value={ms(t.tick_service, t.tick_service.p95_ms)}
            sub={`${t.tick_service.count.toLocaleString()} ticks · ${t.tick_overruns} overran`}
            tone={t.tick_overruns > 0 ? "warning" : undefined}
          />
          <Stat
            label="Tick late p95"
            value={ms(t.tick_lateness, t.tick_lateness.p95_ms)}
            sub="start after due time"
          />
          <Stat
            label="Order ack p50 / p95"
            value={`${ms(single.acked, single.acked.p50_ms)} / ${ms(single.acked, single.acked.p95_ms)}`}
            sub={`${single.acked.count} acked · ${failed} failed · ${timedOut} timed out`}
            tone={failed + timedOut > 0 ? "warning" : undefined}
          />
          <Stat
            label="Resting fill p95"
            value={ms(t.resting_fill_event, t.resting_fill_event.p95_ms)}
            sub={`${t.resting_fill_event.count} via feed · poll p95 ${ms(t.resting_fill_poll, t.resting_fill_poll.p95_ms)} (${t.resting_fill_poll.count})`}
          />
        </div>

        {cohorts.length === 0 ? (
          <Empty>
            <EmptyHeader>
              <EmptyDescription>
                No live fills yet. Ghost fills are simulated at the strategy&apos;s price, so they
                carry no slippage to measure.
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <div className="overflow-x-auto">
            <Table className="w-full text-xs">
              <TableHeader>
                <TableRow className="border-b border-border">
                  {COLUMNS.map((h) => (
                    <TableHead
                      key={h}
                      className="px-3 py-2 text-left font-normal whitespace-nowrap text-muted-foreground"
                    >
                      {h}
                    </TableHead>
                  ))}
                </TableRow>
              </TableHeader>
              <TableBody>
                {cohorts.map((c) => (
                  <TableRow key={`${c.strategy}-${c.side}-${c.intent}`}>
                    <TableCell className="px-3 py-2 text-foreground">{c.strategy}</TableCell>
                    <TableCell className="px-3 py-2 text-muted-foreground">{c.side}</TableCell>
                    <TableCell className="px-3 py-2 text-muted-foreground">{c.intent}</TableCell>
                    <TableCell className="px-3 py-2 font-mono tabular-nums">{c.count}</TableCell>
                    <TableCell className="px-3 py-2 font-mono tabular-nums">{bps(c.count, c.p50_bps)}</TableCell>
                    <TableCell className="px-3 py-2 font-mono tabular-nums">{bps(c.count, c.p95_bps)}</TableCell>
                    <TableCell
                      className={
                        c.count === 0
                          ? "px-3 py-2 font-mono tabular-nums text-muted-foreground"
                          : c.adverse_usd > 0
                            ? "px-3 py-2 font-mono tabular-nums text-destructive"
                            : "px-3 py-2 font-mono tabular-nums text-success"
                      }
                    >
                      {c.count === 0 ? "—" : c.adverse_usd.toFixed(2)}
                    </TableCell>
                    <TableCell className="px-3 py-2 font-mono tabular-nums text-muted-foreground">
                      {c.unmeasured}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
