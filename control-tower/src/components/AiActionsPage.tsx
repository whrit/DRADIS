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

/**
 * AI Actions view — the full llm_actions audit trail (Epic S6).
 *
 * Every config change the LLM Advisor has proposed, with its lifecycle:
 * proposed → applied / rejected / expired / reverted / failed. This is the
 * observability + retraining surface: outcomes recorded here feed the
 * few-shot corpus injected back into the advisor prompt (S7).
 */

import { useState } from "react";
import useSWR from "swr";
import type { LlmActionRow } from "@/lib/types";
import { getLlmActions, approveLlmAction, rejectLlmAction } from "@/lib/api";
import { getSetupStatus } from "@/lib/setupApi";

import { RobotIcon, ArrowRightIcon } from "@phosphor-icons/react";
import { SectionHeader, TONE_TEXT, signTone } from "@/components/shared";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardFooter } from "@/components/ui/card";
import { Empty, EmptyMedia } from "@/components/ui/empty";
import { Skeleton } from "@/components/ui/skeleton";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

const STATUS_VARIANT = {
  proposed: "warning",
  applied: "success",
  approved: "success",
  rejected: "destructive",
  expired: "secondary",
  reverted: "warning",
  failed: "destructive",
} as const;

const TIER_LABEL: Record<number, string> = {
  1: "T1 recommend",
  2: "T2 limited",
  3: "T3 autonomous",
};

function fmtTs(iso: string): string {
  try {
    return new Date(iso).toLocaleString("en-US", {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });
  } catch {
    return iso;
  }
}

const unquote = (s: string) => s.replaceAll('"', "");

/** Provider ids are config values; these are what an operator calls them. */
const LLM_LABEL: Record<string, string> = {
  anthropic: "Claude",
  openai: "OpenAI",
  ollama: "Ollama",
};

export default function AiActionsPage() {
  // Public endpoint — no admin session needed just to say whether an advisor exists.
  const { data: setup } = useSWR("setupStatus", getSetupStatus, { refreshInterval: 60_000 });
  const {
    data: actions,
    isLoading,
    mutate,
  } = useSWR("llmActionsFull", () => getLlmActions(250), { refreshInterval: 30_000 });
  const [filter, setFilter] = useState<string>("all");
  const [busyIds, setBusyIds] = useState<Set<number>>(new Set());
  const [error, setError] = useState<string | null>(null);

  const all = actions ?? [];
  const counts = all.reduce<Record<string, number>>((m, a) => {
    m[a.status] = (m[a.status] ?? 0) + 1;
    return m;
  }, {});
  const rows = filter === "all" ? all : all.filter((a) => a.status === filter);

  const run = async (id: number, fn: (id: number) => Promise<LlmActionRow>) => {
    setError(null);
    setBusyIds((prev) => new Set(prev).add(id));
    try {
      await fn(id);
      await mutate();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyIds((prev) => {
        const n = new Set(prev);
        n.delete(id);
        return n;
      });
    }
  };

  return (
    <section className="space-y-4">
      <SectionHeader title="AI actions" description="Config-change audit trail" />
      <ToggleGroup
        type="single"
        variant="outline"
        value={filter}
        onValueChange={(value) => {
          if (value) setFilter(value);
        }}
        aria-label="Action status"
        className="flex-wrap"
      >
        {["all", "proposed", "applied", "rejected", "expired", "reverted", "failed"].map(
          (status) => (
            <ToggleGroupItem key={status} value={status} className="capitalize">
              {status}{" "}
              <span className="font-mono tabular-nums text-muted-foreground">
                {status === "all" ? all.length : counts[status] || ""}
              </span>
            </ToggleGroupItem>
          ),
        )}
      </ToggleGroup>
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      {isLoading ? (
        <div className="space-y-3" aria-busy="true" aria-label="Loading AI actions">
          {Array.from({ length: 3 }, (_, i) => (
            <Card key={i} size="sm">
              <CardContent className="space-y-3">
                <Skeleton className="h-4 w-40" />
                <Skeleton className="h-8 w-full" />
                <Skeleton className="h-3 w-3/4" />
              </CardContent>
            </Card>
          ))}
        </div>
      ) : rows.length === 0 ? (
        <Card size="sm">
          <Empty>
            <EmptyMedia variant="icon">
              <RobotIcon />
            </EmptyMedia>
            {filter !== "all" ? (
              <p className="text-sm text-muted-foreground">No &apos;{filter}&apos; actions.</p>
            ) : setup && setup.llm_provider_ready && !setup.llm_enabled ? (
              // The most confusing state: credentials test green, and nothing
              // ever appears. Say which half is missing.
              <>
                <p className="text-sm text-warning">
                  The LLM Advisor is configured but switched off.
                </p>
                <p className="text-xs text-muted-foreground max-w-md leading-relaxed">
                  Your provider and key are working — the advisor itself is not running, so no
                  recommendations will be produced. Set{" "}
                  <span className="text-foreground">Run the LLM Advisor</span> to{" "}
                  <span className="text-foreground">true</span> under{" "}
                  <span className="text-foreground">Setup → LLM Advisor</span>, then restart the
                  engine.
                </p>
              </>
            ) : setup && !setup.llm_configured ? (
              // An empty table looks the same whether the advisor is running and
              // has proposed nothing, or was never set up. Say which.
              <>
                <p className="text-sm text-foreground">No LLM Advisor is configured.</p>
                <p className="text-xs text-muted-foreground max-w-md leading-relaxed">
                  Nothing will ever appear here until one is. The advisor is optional — it reviews
                  live trading and proposes config changes for your approval. Choose a provider
                  under <span className="text-foreground">Setup → LLM Advisor</span>.
                </p>
              </>
            ) : (
              <>
                <p className="text-sm text-muted-foreground">No AI actions yet.</p>
                <p className="text-xs text-muted-foreground">
                  {setup?.llm_provider
                    ? `The advisor (${LLM_LABEL[setup.llm_provider.toLowerCase()] ?? setup.llm_provider}) records every config proposal here.`
                    : "The LLM Advisor records every config proposal here."}
                </p>
              </>
            )}
          </Empty>
        </Card>
      ) : (
        <div className="space-y-3">
          {rows.map((a) => {
            const busy = busyIds.has(a.id);
            return (
              <Card key={a.id} size="sm">
                <CardHeader>
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <CardTitle className="font-mono text-xs">{a.field}</CardTitle>
                    <div className="flex flex-wrap items-center gap-2">
                      {a.ghost_mode && <Badge variant="warning">GHOST</Badge>}
                      {a.clamped && <Badge variant="warning">Clamped</Badge>}
                      <Badge
                        variant={
                          STATUS_VARIANT[a.status as keyof typeof STATUS_VARIANT] ?? "secondary"
                        }
                      >
                        {a.status}
                      </Badge>
                      <Badge variant="outline">{TIER_LABEL[a.tier] ?? `T${a.tier}`}</Badge>
                    </div>
                  </div>
                  <div className="flex flex-wrap items-center gap-3 text-muted-foreground">
                    <span className="font-mono tabular-nums">{fmtTs(a.ts)}</span>
                    <span>
                      Squadron{" "}
                      <span className="font-mono">
                        {a.squadron_id ?? (
                          // Written before the advisor was squadron-scoped: applied
                          // to a config no strategy reads, so it never moved
                          // anything live and cannot be approved now.
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <span tabIndex={0}>—</span>
                            </TooltipTrigger>
                            <TooltipContent>
                              Pre-dates squadron-scoped advice — targets a config no strategy reads
                            </TooltipContent>
                          </Tooltip>
                        )}
                      </span>
                    </span>
                  </div>
                </CardHeader>
                <CardContent className="space-y-3">
                  <div className="flex flex-wrap items-center gap-2 bg-muted px-3 py-2 font-mono tabular-nums">
                    <span className="break-all text-muted-foreground line-through">
                      {unquote(a.from_value)}
                    </span>
                    <ArrowRightIcon
                      className="size-3.5 shrink-0 text-muted-foreground"
                      aria-label="changes to"
                    />
                    <span className="break-all text-foreground">{unquote(a.to_value)}</span>
                    <span className="ml-auto text-muted-foreground">
                      Δ{" "}
                      {a.delta_pct == null
                        ? "—"
                        : `${a.delta_pct >= 0 ? "+" : ""}${(a.delta_pct * 100).toFixed(1)}%`}
                    </span>
                  </div>
                  <p className="text-pretty text-muted-foreground">{a.reason}</p>
                  {a.status_detail && (
                    <p className="text-xs text-muted-foreground">{a.status_detail}</p>
                  )}
                </CardContent>
                <CardFooter className="flex-wrap justify-between gap-3 border-t border-border">
                  <div className="text-muted-foreground">
                    Outcome{" "}
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <span
                          tabIndex={0}
                          className={`font-mono tabular-nums ${TONE_TEXT[signTone(a.outcome_score)]}`}
                        >
                          {a.outcome_score == null
                            ? "—"
                            : `${a.outcome_score >= 0 ? "+" : ""}${a.outcome_score.toFixed(2)}`}
                        </span>
                      </TooltipTrigger>
                      <TooltipContent>
                        {a.outcome_detail || "No outcome detail recorded"}
                      </TooltipContent>
                    </Tooltip>
                  </div>
                  {a.status === "proposed" && (
                    <div className="flex gap-2">
                      <Button onClick={() => run(a.id, approveLlmAction)} disabled={busy}>
                        {busy ? "Applying…" : "Apply"}
                      </Button>
                      <Button
                        variant="outline"
                        className="border-destructive/30 text-destructive hover:bg-destructive/10 hover:text-destructive"
                        onClick={() => run(a.id, rejectLlmAction)}
                        disabled={busy}
                      >
                        Reject
                      </Button>
                    </div>
                  )}
                </CardFooter>
              </Card>
            );
          })}
        </div>
      )}
      <p className="text-xs text-muted-foreground">
        Rejected and reverted actions become negative few-shot examples in future advisor prompts;
        applied actions are outcome-scored against post-apply P&L.
      </p>
    </section>
  );
}
