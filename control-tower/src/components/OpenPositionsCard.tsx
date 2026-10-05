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

import { useState } from "react";
import type { OpenPositionRow, TradeRow } from "@/lib/types";
import { DEMO_MODE } from "@/lib/demo";
import { AirplaneLandingIcon } from "@phosphor-icons/react";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from "@/components/ui/table";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { Skeleton } from "@/components/ui/skeleton";
import { Empty, EmptyHeader, EmptyDescription } from "@/components/ui/empty";
import { Alert, AlertTitle, AlertDescription } from "@/components/ui/alert";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
} from "@/components/ui/alert-dialog";
import { TONE_TEXT, signTone } from "@/components/shared";

function fmtTime(iso: string) {
  const d = new Date(iso);
  const date = d.toLocaleDateString("en-US", { month: "2-digit", day: "2-digit" });
  const time = d.toLocaleTimeString("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  return `${date} ${time}`;
}

function truncate(s: string, n: number) {
  return s.length > n ? s.slice(0, n) + "…" : s;
}

/** Inline tooltip cell: shows dotted underline and a styled popup on hover. */
function TipCell({
  full,
  maxChars,
  className = "",
}: {
  full: string;
  maxChars: number;
  className?: string;
}) {
  const isTruncated = full.length > maxChars;
  if (!isTruncated) return <span className={className}>{full}</span>;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          tabIndex={0}
          className={`border-b border-dotted border-border cursor-help ${className}`}
        >
          {truncate(full, maxChars)}
        </span>
      </TooltipTrigger>
      <TooltipContent className="max-w-xs whitespace-pre-wrap wrap-break-word">
        {full}
      </TooltipContent>
    </Tooltip>
  );
}

/** Returns true for "long / bullish" outcomes: YES, UP, BUY, etc. */
function isLongSide(side: string): boolean {
  const s = side.toUpperCase();
  return s === "YES" || s === "UP" || s === "BUY" || s === "LONG";
}

/** Estimate unrealised P&L direction from side label color only (no live price here). */
function strategyLabel(s: string) {
  return s.replace("Strategy", "");
}

function pnlColor(pnl: string) {
  const n = parseFloat(pnl);
  return TONE_TEXT[signTone(n === 0 ? null : n)];
}

function fmtPnl(pnl: string) {
  const n = parseFloat(pnl);
  if (isNaN(n)) return pnl;
  return `${n >= 0 ? "+" : ""}$${n.toFixed(4)}`;
}

interface Props {
  positions: OpenPositionRow[];
  trades: TradeRow[];
  isLoading: boolean;
  asset: string;
}

export default function OpenPositionsCard({ positions, trades, isLoading, asset }: Props) {
  const [activeTab, setActiveTab] = useState<"pending" | "confirmed" | "completed">("pending");
  const [rtbModal, setRtbModal] = useState<{ show: boolean; position: OpenPositionRow | null }>({
    show: false,
    position: null,
  });
  const [rtbLoading, setRtbLoading] = useState(false);

  // Split positions by status
  const pending = positions.filter((p) => p.status === "pending");
  const confirmed = positions.filter((p) => p.status === "confirmed");

  const handleRtbClick = (position: OpenPositionRow) => {
    setRtbModal({ show: true, position });
  };

  const handleRtbConfirm = async () => {
    if (DEMO_MODE) return;
    if (!rtbModal.position) return;

    setRtbLoading(true);
    try {
      const res = await fetch("/api/positions/manual-exit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          token_id: rtbModal.position.token_id,
          asset: asset,
          strategy: rtbModal.position.strategy,
          market: rtbModal.position.market,
          side: rtbModal.position.side,
          // TODO: Get actual current bid from live price feed
          current_bid: "0.5", // Placeholder - will be fetched by backend from CLOB
          // TODO: Get actual exchange address from config
          verifying_contract: "0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E", // Polymarket CTF Exchange
        }),
      });

      if (!res.ok) {
        const err = await res.text();
        alert(`RTB failed: ${err}`);
      } else {
        alert("Position closed successfully! Check Completed Missions tab.");
        // Refresh page to update UI
        window.location.reload();
      }
    } catch (err) {
      alert(`RTB error: ${err}`);
    } finally {
      setRtbLoading(false);
      setRtbModal({ show: false, position: null });
    }
  };

  if (isLoading) {
    return <Skeleton className="h-24 w-full" aria-label="Loading mission status" />;
  }

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle>Mission activity</CardTitle>
        </CardHeader>
        <CardContent className="px-0 space-y-3">
          <Tabs
            value={activeTab}
            onValueChange={(value) => setActiveTab(value as "pending" | "confirmed" | "completed")}
            className="px-4"
          >
            <TabsList className="flex-wrap h-auto">
              <TabsTrigger value="pending">
                Viper launches <span className="font-mono tabular-nums">({pending.length})</span>
              </TabsTrigger>
              <TabsTrigger value="confirmed">
                Missions in-flight{" "}
                <span className="font-mono tabular-nums">({confirmed.length})</span>
              </TabsTrigger>
              <TabsTrigger value="completed">
                Completed missions <span className="font-mono tabular-nums">({trades.length})</span>
              </TabsTrigger>
            </TabsList>
            <TabsContent value={activeTab}>
              {/* Tab Content */}
              {activeTab === "pending" &&
                (pending.length === 0 ? (
                  <Empty>
                    <EmptyHeader>
                      <EmptyDescription>
                        No pending launches — all vipers are either confirmed or at rest.
                      </EmptyDescription>
                    </EmptyHeader>
                  </Empty>
                ) : (
                  <div className="overflow-x-auto">
                    <Table className="w-full text-xs">
                      <TableHeader>
                        <TableRow className="border-b border-border">
                          {[
                            "Launched",
                            "Asset",
                            "Strategy",
                            "Market",
                            "Side",
                            "Entry",
                            "Shares",
                            "Mode",
                          ].map((h) => (
                            <TableHead
                              key={h}
                              className="px-3 py-2 text-left text-muted-foreground font-normal whitespace-nowrap"
                            >
                              {h}
                            </TableHead>
                          ))}
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {pending.map((p, i) => (
                          <TableRow
                            key={i}
                            className="border-b border-border hover:bg-muted transition-colors"
                          >
                            <TableCell className="px-3 py-2 text-muted-foreground whitespace-nowrap font-mono tabular-nums">
                              {fmtTime(p.ts)}
                            </TableCell>
                            <TableCell className="px-3 py-2">
                              <Badge
                                variant="outline"
                                className="border-chart-1/20 bg-chart-1/10 text-chart-1"
                              >
                                <span className="font-mono">{asset.toUpperCase()}</span>
                              </Badge>
                            </TableCell>
                            <TableCell className="px-3 py-2 text-foreground whitespace-nowrap">
                              {strategyLabel(p.strategy)}
                            </TableCell>
                            <TableCell className="px-3 py-2 text-muted-foreground max-w-40">
                              <TipCell full={p.market} maxChars={26} />
                            </TableCell>
                            <TableCell
                              className={`px-3 py-2 font-semibold ${isLongSide(p.side) ? "text-success" : "text-destructive"}`}
                            >
                              {p.side}
                            </TableCell>
                            <TableCell className="px-3 py-2 text-foreground font-mono tabular-nums">
                              {parseFloat(p.entry_price).toFixed(4)}
                            </TableCell>
                            <TableCell className="px-3 py-2 text-muted-foreground font-mono tabular-nums">
                              {parseFloat(p.shares).toFixed(2)}
                            </TableCell>
                            <TableCell className="px-3 py-2">
                              {p.ghost_mode ? (
                                <Badge variant="warning">GHOST</Badge>
                              ) : (
                                <Badge variant="success">LIVE</Badge>
                              )}
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                ))}

              {activeTab === "confirmed" &&
                (confirmed.length === 0 ? (
                  <Empty>
                    <EmptyHeader>
                      <EmptyDescription>
                        No active missions — all positions are either pending or closed.
                      </EmptyDescription>
                    </EmptyHeader>
                  </Empty>
                ) : (
                  <div className="overflow-x-auto">
                    <Table className="w-full text-xs">
                      <TableHeader>
                        <TableRow className="border-b border-border">
                          {[
                            "Entered",
                            "Asset",
                            "Strategy",
                            "Market",
                            "Side",
                            "Entry",
                            "Cur Price",
                            "Shares",
                            "Mode",
                            "Actions",
                          ].map((h) => (
                            <TableHead
                              key={h}
                              className="px-3 py-2 text-left text-muted-foreground font-normal whitespace-nowrap"
                            >
                              {h}
                            </TableHead>
                          ))}
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {confirmed.map((p, i) => (
                          <TableRow
                            key={i}
                            className="border-b border-border hover:bg-muted transition-colors"
                          >
                            <TableCell className="px-3 py-2 text-muted-foreground whitespace-nowrap font-mono tabular-nums">
                              {p.chain_adopted ? (
                                <Tooltip>
                                  <TooltipTrigger asChild>
                                    <Badge variant="warning">Adopted</Badge>
                                  </TooltipTrigger>
                                  <TooltipContent>
                                    Re-adopted from on-chain wallet; original entry time unknown
                                  </TooltipContent>
                                </Tooltip>
                              ) : (
                                fmtTime(p.ts)
                              )}
                            </TableCell>
                            <TableCell className="px-3 py-2">
                              <Badge
                                variant="outline"
                                className="border-chart-1/20 bg-chart-1/10 text-chart-1"
                              >
                                <span className="font-mono">{asset.toUpperCase()}</span>
                              </Badge>
                            </TableCell>
                            <TableCell className="px-3 py-2 text-foreground whitespace-nowrap">
                              {strategyLabel(p.strategy)}
                            </TableCell>
                            <TableCell className="px-3 py-2 text-muted-foreground max-w-40">
                              <TipCell full={p.market} maxChars={26} />
                            </TableCell>
                            <TableCell
                              className={`px-3 py-2 font-semibold ${isLongSide(p.side) ? "text-success" : "text-destructive"}`}
                            >
                              {p.side}
                            </TableCell>
                            <TableCell className="px-3 py-2 text-foreground font-mono tabular-nums">
                              {parseFloat(p.entry_price).toFixed(4)}
                            </TableCell>
                            <TableCell className="px-3 py-2 font-mono tabular-nums">
                              {p.current_price ? (
                                (() => {
                                  const cur = parseFloat(p.current_price);
                                  const entry = parseFloat(p.entry_price);
                                  const color =
                                    cur > entry
                                      ? "text-success"
                                      : cur < entry
                                        ? "text-destructive"
                                        : "text-foreground";
                                  return (
                                    <span className={`font-mono tabular-nums ${color}`}>
                                      {cur.toFixed(4)}
                                    </span>
                                  );
                                })()
                              ) : (
                                <span className="text-muted-foreground">—</span>
                              )}
                            </TableCell>
                            <TableCell className="px-3 py-2 text-muted-foreground font-mono tabular-nums">
                              {parseFloat(p.shares).toFixed(2)}
                            </TableCell>
                            <TableCell className="px-3 py-2">
                              {p.ghost_mode ? (
                                <Badge variant="warning">GHOST</Badge>
                              ) : (
                                <Badge variant="success">LIVE</Badge>
                              )}
                            </TableCell>
                            <TableCell className="px-3 py-2">
                              {DEMO_MODE ? (
                                <span className="text-xs text-muted-foreground ">demo</span>
                              ) : (
                                <Button
                                  variant="outline"
                                  onClick={() => handleRtbClick(p)}
                                  className="px-2 py-0.5 text-xs rounded-sm bg-warning/10 text-warning border border-warning/30 hover:bg-warning/20 transition-colors"
                                  aria-label="Return to base: manually close this position"
                                >
                                  <AirplaneLandingIcon data-icon="inline-start" />
                                  RTB
                                </Button>
                              )}
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                ))}

              {activeTab === "completed" &&
                (trades.length === 0 ? (
                  <Empty>
                    <EmptyHeader>
                      <EmptyDescription>No completed missions yet this session.</EmptyDescription>
                    </EmptyHeader>
                  </Empty>
                ) : (
                  <div className="overflow-x-auto">
                    <Table className="w-full text-xs">
                      <TableHeader>
                        <TableRow className="border-b border-border">
                          {[
                            "Time",
                            "Strategy",
                            "Market",
                            "Side",
                            "Entry",
                            "Exit",
                            "Shares",
                            "P&L",
                            "Reason",
                          ].map((h) => (
                            <TableHead
                              key={h}
                              className="px-3 py-2 text-left text-muted-foreground font-normal whitespace-nowrap"
                            >
                              {h}
                            </TableHead>
                          ))}
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {trades.map((t, i) => (
                          <TableRow
                            key={i}
                            className="border-b border-border hover:bg-muted transition-colors"
                          >
                            <TableCell className="px-3 py-2 text-muted-foreground whitespace-nowrap font-mono tabular-nums">
                              {fmtTime(t.ts)}
                            </TableCell>
                            <TableCell className="px-3 py-2 text-foreground whitespace-nowrap">
                              {strategyLabel(t.strategy)}
                            </TableCell>
                            <TableCell className="px-3 py-2 text-muted-foreground max-w-40">
                              <TipCell full={t.market} maxChars={26} />
                            </TableCell>
                            <TableCell
                              className={`px-3 py-2 font-semibold ${isLongSide(t.side) ? "text-success" : "text-destructive"}`}
                            >
                              {t.side}
                            </TableCell>
                            <TableCell className="px-3 py-2 text-foreground font-mono tabular-nums">
                              {parseFloat(t.entry_price).toFixed(4)}
                            </TableCell>
                            <TableCell className="px-3 py-2 text-foreground font-mono tabular-nums">
                              {parseFloat(t.exit_price).toFixed(4)}
                            </TableCell>
                            <TableCell className="px-3 py-2 text-muted-foreground font-mono tabular-nums">
                              {parseFloat(t.shares).toFixed(2)}
                            </TableCell>
                            <TableCell
                              className={`px-3 py-2 font-mono tabular-nums font-semibold ${pnlColor(t.pnl)}`}
                            >
                              {fmtPnl(t.pnl)}
                            </TableCell>
                            <TableCell className="px-3 py-2 text-muted-foreground max-w-55">
                              <TipCell full={t.reason} maxChars={34} />
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                ))}
            </TabsContent>
          </Tabs>
        </CardContent>
      </Card>

      {/* RTB Confirmation Modal */}
      {rtbModal.show && rtbModal.position && (
        <AlertDialog open={rtbModal.show}>
          <AlertDialogContent onEscapeKeyDown={(e) => e.preventDefault()}>
            <AlertDialogHeader>
              <AlertDialogTitle>Return to base confirmation</AlertDialogTitle>
              <AlertDialogDescription>
                Manually close this position with a market order.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <dl className="space-y-2 text-xs">
              <div>
                <dt className="inline font-medium">Position: </dt>
                <dd className="inline">{truncate(rtbModal.position.market, 50)}</dd>
              </div>
              <div>
                <dt className="inline font-medium">Side: </dt>
                <dd
                  className={`inline ${isLongSide(rtbModal.position.side) ? "text-success" : "text-destructive"}`}
                >
                  {rtbModal.position.side}
                </dd>
              </div>
              <div>
                <dt className="inline font-medium">Shares: </dt>
                <dd className="inline font-mono tabular-nums">
                  {parseFloat(rtbModal.position.shares).toFixed(2)}
                </dd>
              </div>
            </dl>
            <Alert variant="warning">
              <AlertTitle>Warning</AlertTitle>
              <AlertDescription>
                <ul className="space-y-1 list-disc list-inside">
                  <li>
                    This will place a <strong>market order (FAK)</strong>
                  </li>
                  <li>Taker fees apply (~2% on Polymarket)</li>
                  <li>Alternative: Let position settle naturally (no fees)</li>
                </ul>
              </AlertDescription>
            </Alert>
            <AlertDialogFooter>
              <Button
                variant="outline"
                onClick={() => setRtbModal({ show: false, position: null })}
                disabled={rtbLoading}
              >
                Cancel
              </Button>
              <Button variant="destructive" onClick={handleRtbConfirm} disabled={rtbLoading}>
                <AirplaneLandingIcon data-icon="inline-start" />
                {rtbLoading ? "Closing…" : "Confirm RTB"}
              </Button>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      )}
    </>
  );
}
