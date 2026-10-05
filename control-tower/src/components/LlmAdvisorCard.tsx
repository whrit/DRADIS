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
 * LLM Advisor — compact summary strip for the Main view.
 *
 * One row: latest analysis metadata (time, model, P&L at analysis) plus a
 * "N proposals pending" badge that jumps to the AI Actions tab (the detail
 * surface for the approval queue and audit trail). The full prose analysis
 * expands inline on demand; older analyzes are browsable while expanded.
 */

import { useState } from "react";
import type { LlmRecommendationRow } from "@/lib/types";
import { ArrowLeftIcon, ArrowRightIcon, RobotIcon } from "@phosphor-icons/react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Item, ItemActions } from "@/components/ui/item";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { TONE_TEXT, signTone } from "@/components/shared";
import { cn } from "@/lib/utils";

interface Props {
  recommendations: LlmRecommendationRow[];
  isLoading: boolean;
  /** Set when the recommendations request failed; not the same as "none yet". */
  loadError?: string;
  advisorEnabled: boolean;
  /** Count of AI config proposals awaiting approval (status 'proposed'). */
  pendingCount?: number;
  /** Navigate to the AI Actions view (approval queue + audit trail). */
  onGoToActions?: () => void;
}

/** Format an ISO timestamp to a short local string, e.g. "May 11, 14:32" */
function fmtTs(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleString("en-US", {
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

export default function LlmAdvisorCard({
  recommendations,
  isLoading,
  loadError,
  advisorEnabled,
  pendingCount = 0,
  onGoToActions,
}: Props) {
  const [expanded, setExpanded] = useState(false);
  const [idx, setIdx] = useState(0);

  const total = recommendations.length;
  const safeIdx = total > 0 ? Math.min(idx, total - 1) : 0;
  const rec = total > 0 ? recommendations[safeIdx] : null;

  return (
    <section>
      <Card size="sm" className="gap-0 py-0">
        {/* Summary strip */}
        <Item size="sm" className="gap-3 px-4">
          <RobotIcon className="size-4 text-muted-foreground" aria-hidden />
          <span className="text-sm font-medium">LLM advisor</span>
          {!advisorEnabled && <Badge variant="secondary">Disabled</Badge>}

          {isLoading ? (
            <Skeleton className="h-4 w-32" aria-label="Loading analysis" />
          ) : loadError ? (
            <Alert variant="destructive" className="w-auto flex-1">
              <AlertDescription>Couldn&apos;t load: {loadError}</AlertDescription>
            </Alert>
          ) : rec ? (
            <>
              <span className="text-xs text-muted-foreground tabular-nums">{fmtTs(rec.ts)}</span>
              <Badge variant="outline">{rec.model}</Badge>
              <span className="hidden text-xs text-muted-foreground tabular-nums sm:inline">
                {rec.trade_count} trade{rec.trade_count !== 1 ? "s" : ""}
              </span>
              {!rec.is_current_session && <Badge variant="secondary">Prior session</Badge>}
              <span className="text-xs text-muted-foreground">
                P&L{" "}
                <span
                  className={cn(
                    "font-mono tabular-nums",
                    TONE_TEXT[signTone(parseFloat(rec.session_pnl))],
                  )}
                >
                  {parseFloat(rec.session_pnl) >= 0 ? "+" : ""}$
                  {parseFloat(rec.session_pnl).toFixed(2)}
                </span>
              </span>
            </>
          ) : (
            <span className="text-xs text-muted-foreground">
              {advisorEnabled ? "Awaiting first analysis" : "Disabled (ENABLE_LLM_ADVISOR)"}
            </span>
          )}

          {/* Right cluster: pending badge + expand toggle */}
          <ItemActions className="ml-auto">
            {pendingCount > 0 && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button variant="ghost" onClick={onGoToActions}>
                    <Badge variant="warning" className="tabular-nums">
                      {pendingCount} proposal{pendingCount !== 1 ? "s" : ""} pending
                    </Badge>
                    <ArrowRightIcon data-icon="inline-end" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Review in the AI actions view</TooltipContent>
              </Tooltip>
            )}
            {onGoToActions && pendingCount === 0 && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button variant="link" onClick={onGoToActions}>
                    AI actions
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Open the AI actions audit trail</TooltipContent>
              </Tooltip>
            )}
            {rec && (
              <Button
                variant="outline"
                onClick={() => setExpanded((v) => !v)}
                aria-expanded={expanded}
                aria-label={expanded ? "Collapse analysis" : "Read the full analysis"}
              >
                {expanded ? "Collapse" : "Read"}
              </Button>
            )}
          </ItemActions>
        </Item>

        {/* Expanded prose */}
        {expanded && rec && (
          <CardContent className="border-t border-border py-3">
            {total > 1 && (
              <div className="mb-2 flex items-center gap-2">
                <span className="font-mono text-xs text-muted-foreground tabular-nums">
                  {safeIdx + 1} / {total}
                </span>
                <Button
                  variant="outline"
                  size="icon-sm"
                  onClick={() => setIdx((i) => Math.min(i + 1, total - 1))}
                  disabled={safeIdx >= total - 1}
                  aria-label="Older analysis"
                >
                  <ArrowLeftIcon />
                </Button>
                <Button
                  variant="outline"
                  size="icon-sm"
                  onClick={() => setIdx((i) => Math.max(i - 1, 0))}
                  disabled={safeIdx === 0}
                  aria-label="Newer analysis"
                >
                  <ArrowRightIcon />
                </Button>
              </div>
            )}
            <div className="max-h-96 overflow-y-auto whitespace-pre-wrap text-xs leading-relaxed text-foreground">
              {rec.analysis}
            </div>
          </CardContent>
        )}
      </Card>
    </section>
  );
}
