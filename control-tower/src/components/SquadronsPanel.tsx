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

import { useCallback, useEffect, useState } from "react";
import useSWR from "swr";
import type { SquadronSummary, SquadronState, DeploymentStatus } from "@/lib/types";
import { marketLabel } from "@/lib/types";
import {
  getOpenPositions,
  getVipersForClass,
  getSquadronConfig,
  getDeployments,
  retryDeployment,
  dismissDeployment,
  VIPER_DEFS,
} from "@/lib/api";
import DeploySquadronModal from "./DeploySquadronModal";
import TakeTheHelmModal from "./TakeTheHelmModal";
import { HelmLiveLine } from "./HelmIntentsPanel";
import { AirplaneIcon, CaretRightIcon, CompassIcon, PlusIcon } from "@phosphor-icons/react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardHeader, CardTitle, CardAction, CardContent } from "@/components/ui/card";
import { Item } from "@/components/ui/item";
import {
  Empty,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
  EmptyDescription,
} from "@/components/ui/empty";
import { Skeleton } from "@/components/ui/skeleton";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { StatusDot } from "@/components/shared";

// ── State badge ───────────────────────────────────────────────────────────────

function StateBadge({ state }: { state: SquadronState }) {
  return (
    <Badge
      variant={
        state === "PATROLLING"
          ? "success"
          : state === "STAGED"
            ? "warning"
            : state === "DEPLOYED"
              ? "default"
              : "outline"
      }
    >
      {state}
    </Badge>
  );
}

// ── Asset chip ────────────────────────────────────────────────────────────────

const ASSET_COLORS: Record<string, string> = {
  BTC: "bg-chart-1/10 text-chart-1 border-chart-1/20",
  ETH: "bg-chart-2/10 text-chart-2 border-chart-2/20",
  SOL: "bg-chart-3/10 text-chart-3 border-chart-3/20",
};

function AssetChip({ asset }: { asset: string }) {
  return (
    <Badge
      variant="outline"
      className={ASSET_COLORS[asset] ?? "text-chart-4 border-chart-4/20 bg-chart-4/10"}
    >
      <span className="font-mono">{asset}</span>
    </Badge>
  );
}

// ── Time-ago helper ───────────────────────────────────────────────────────────

function timeAgo(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diffMs / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

// ── Squadron row ──────────────────────────────────────────────────────────────

/**
 * How many of a squadron's strategies are switched ON.
 *
 * This used to read "2/9 strategies apply", counting which strategies the market
 * class SUPPORTS rather than which are running — a sports squadron showed 4/9
 * because only four vipers can price a game, and the number never moved when the
 * operator turned one off. Two different facts were competing for one badge, and
 * the one an operator checks at a glance is whether the squadron is actually
 * working.
 *
 * So the denominator is now what this squadron can run, and the numerator is what
 * is enabled. Applicability has not been dropped — it moved into the tooltip,
 * which is where "the rest need a per-market price signal only crypto provides"
 * belongs.
 */
function ViperCoverage({
  squadronId,
  marketClass,
  vipers,
}: {
  squadronId: string;
  marketClass: string;
  vipers?: string[];
}) {
  const { data: mine } = useSWR(
    ["vipers-for-class", marketClass],
    () => getVipersForClass(marketClass as never),
    { revalidateOnFocus: false },
  );
  const { data: full } = useSWR(
    ["vipers-for-class", "crypto"],
    () => getVipersForClass("crypto" as never),
    { revalidateOnFocus: false },
  );
  // Enablement is per squadron, so it comes from the squadron's own config row
  // rather than the global one.
  const { data: cfg } = useSWR(
    ["squadron-config", squadronId],
    () => getSquadronConfig(squadronId),
    { revalidateOnFocus: false, refreshInterval: 30_000 },
  );
  if (!mine || !full || full.length === 0) return null;

  // What this squadron can run. The squadron's own list when the engine reports
  // one, else the market class's.
  const applicable = vipers && vipers.length > 0 ? mine.filter((v) => vipers.includes(v.id)) : mine;

  // Enabled is only knowable once the config has loaded; until then say how many
  // could run rather than guessing at zero, which would read as a dead squadron.
  const enableKeyFor = (id: string) => VIPER_DEFS.find((d) => d.statusKey === id)?.enableKey;
  const active = cfg
    ? applicable.filter((v) => {
        const k = enableKeyFor(v.id);
        // No enable key means nothing can switch it off.
        return k ? cfg[k] !== false : true;
      })
    : undefined;

  const total = applicable.length;
  const on = active?.length;
  // Amber only when something is off. A squadron running everything it can is
  // healthy even if its class supports fewer strategies than crypto does.
  const partial = on !== undefined && on < total;
  const offNames =
    active && applicable.filter((v) => !active.some((a) => a.id === v.id)).map((v) => v.display);

  const explanation = [
    on === undefined
      ? `${total} strategies apply to ${marketClass} markets.`
      : `${on} of ${total} strategies active: ${active!.map((v) => v.display).join(", ") || "none"}.`,
    offNames && offNames.length > 0 ? `Switched off: ${offNames.join(", ")}.` : "",
    total < full.length
      ? `${total} of ${full.length} strategies apply to ${marketClass} markets — the rest need a per-market price signal that only crypto markets provide.`
      : "",
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Badge variant={partial ? "warning" : "success"}>
          <span className="font-mono tabular-nums">
            {on === undefined ? total : on}/{total}
          </span>{" "}
          strategies active
        </Badge>
      </TooltipTrigger>
      <TooltipContent className="max-w-80">{explanation}</TooltipContent>
    </Tooltip>
  );
}

function SquadronRow({
  sq,
  onClick,
  missionCount,
}: {
  sq: SquadronSummary;
  onClick?: (sq: SquadronSummary) => void;
  missionCount?: number;
}) {
  return (
    <Item asChild size="sm">
      <button
        type="button"
        onClick={() => onClick?.(sq)}
        className="w-full flex flex-col sm:flex-row sm:items-center gap-2 sm:gap-4 px-4 py-3 border-b border-border last:border-0 hover:bg-muted/2 transition-colors text-left cursor-pointer"
      >
        {/* Left — asset + name */}
        <div className="flex items-center gap-2 min-w-0 flex-1">
          <AssetChip asset={sq.asset} />
          <div className="min-w-0">
            <p className="text-xs  text-muted-foreground truncate" title={sq.name}>
              {sq.name}
            </p>
            <p
              className={`text-xs  truncate mt-0.5 ${sq.market_name ? "text-muted-foreground" : "text-muted-foreground italic"}`}
              title={marketLabel(sq.market_name)}
            >
              {marketLabel(sq.market_name)}
            </p>
            {sq.maker_market_name && (
              <p
                className="text-xs  text-muted-foreground truncate mt-0.5"
                title={sq.maker_market_name}
              >
                {sq.maker_market_name}
              </p>
            )}
            {sq.stood_down_reason && (
              <p
                className="text-xs  text-muted-foreground truncate mt-0.5"
                title={sq.stood_down_reason}
              >
                Retired: {sq.stood_down_reason} — this entry is removed shortly
              </p>
            )}
          </div>
        </div>

        {/* Right — tags on one line, metadata beneath.
          Stacked rather than run together on a single line: rows carry a
          varying number of tags (a squadron may have no mission count, or an
          unknown market class), so on one line the deployed-time and id slid
          horizontally from row to row and no column lined up. Splitting them
          gives the tags a row of their own, right-aligned, so they read as a
          column down the panel. */}
        <div className="flex flex-col items-end gap-1 shrink-0">
          <div className="flex items-center gap-2">
            {sq.market_class && sq.market_class !== "unknown" && (
              <Badge variant="outline" className="border-chart-4/20 bg-chart-4/10 text-chart-4">
                {sq.market_class}
              </Badge>
            )}
            {sq.market_class && (
              <ViperCoverage squadronId={sq.id} marketClass={sq.market_class} vipers={sq.vipers} />
            )}
            {missionCount !== undefined && missionCount > 0 && (
              <Badge variant="secondary">
                <AirplaneIcon />
                <span className="font-mono tabular-nums">{missionCount}</span>{" "}
                {missionCount === 1 ? "mission" : "missions"}
              </Badge>
            )}
            <StateBadge state={sq.state} />
          </div>
          <div className="flex items-center gap-2">
            <span
              className="text-xs font-mono tabular-nums text-muted-foreground"
              title={sq.deployed_at}
            >
              {timeAgo(sq.deployed_at)}
            </span>
            <span
              className="hidden lg:inline text-2xs font-mono text-muted-foreground truncate max-w-45"
              title={sq.id}
            >
              {sq.id}
            </span>
          </div>
        </div>
      </button>
    </Item>
  );
}

// ── In-flight deployment row ──────────────────────────────────────────────────
//
// A deploy is queued, not executed. `POST /api/squadrons/deploy` returns as soon
// as the row is written; the engine picks it up on its own poll and only then
// does a squadron exist to list. In between, the modal has already closed and
// the squadron list looks exactly as it did before — which reads as "nothing
// happened" rather than "starting". Worse, a deployment that FAILS leaves that
// state permanently: the error is recorded in the queue and was never surfaced,
// so a failure and a slow success were indistinguishable.
//
// These rows come straight from the queue, so they say what is actually true
// rather than assuming the deploy will succeed.

const DEPLOY_STATUS_STYLES: Record<
  string,
  { label: string; variant: "warning" | "destructive"; pulse: boolean }
> = {
  pending: { label: "QUEUED", variant: "warning", pulse: true },
  processing: { label: "STARTING", variant: "warning", pulse: true },
  failed: { label: "FAILED", variant: "destructive", pulse: false },
};

function PendingDeploymentRow({
  dep,
  onRetry,
  onDismiss,
  busy,
  error,
}: {
  dep: DeploymentStatus;
  onRetry: (id: string) => void;
  onDismiss: (id: string) => void;
  busy: boolean;
  error?: string;
}) {
  const style = DEPLOY_STATUS_STYLES[dep.status] ?? DEPLOY_STATUS_STYLES.pending;
  return (
    <div className="flex flex-wrap items-center justify-between px-4 py-3 border-b border-border last:border-b-0">
      <div className="flex items-center gap-3 min-w-0">
        <Badge variant={style.variant}>
          <StatusDot tone={style.variant} pulse={style.pulse} />
          {style.label}
        </Badge>
        <div className="min-w-0">
          <div className="text-xs  text-muted-foreground truncate">{dep.market_type} squadron</div>
          {dep.status === "failed" && dep.error ? (
            <div className="text-xs  text-destructive/80 truncate" title={dep.error}>
              {dep.error}
            </div>
          ) : (
            <div className="text-xs  text-muted-foreground truncate" title={dep.market_id}>
              {dep.market_id}
            </div>
          )}
        </div>
      </div>
      {dep.status === "failed" ? (
        // A failed deployment has no squadron behind it, so there is nothing to
        // stand down — only a record to act on. Retry is worth offering because
        // failures differ in kind: "market no longer listed" will fail again and
        // wants dismissing, while a venue rate-limit or a transient connect
        // error is exactly the case that succeeds on a second attempt.
        <div className="flex items-center gap-2 shrink-0">
          <Button
            variant="outline"
            onClick={() => onRetry(dep.id)}
            disabled={busy}
            className="text-xs  border border-warning/30 text-warning bg-warning/10
                       rounded px-2 py-1 hover:bg-warning/20 transition-colors disabled:opacity-50"
            aria-label="Queue this deployment again"
          >
            Retry
          </Button>
          <Button
            variant="ghost"
            onClick={() => onDismiss(dep.id)}
            disabled={busy}
            className="text-xs  border border-border text-muted-foreground
                       rounded px-2 py-1 hover:text-muted-foreground hover:border-border
                       transition-colors disabled:opacity-50"
            aria-label="Acknowledge and hide this failure"
          >
            Dismiss
          </Button>
        </div>
      ) : (
        <span className="text-xs  text-muted-foreground shrink-0">waiting for the engine</span>
      )}
      {error && (
        <Alert variant="destructive" className="basis-full mt-2">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
    </div>
  );
}

// ── Empty state ───────────────────────────────────────────────────────────────

function EmptyState({ isLoading }: { isLoading: boolean }) {
  return isLoading ? (
    <div className="space-y-3 px-4 py-3" aria-label="Loading squadrons">
      <Skeleton className="h-14 w-full" />
      <Skeleton className="h-14 w-full" />
    </div>
  ) : (
    <Empty>
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <AirplaneIcon />
        </EmptyMedia>
        <EmptyTitle>No squadrons deployed</EmptyTitle>
        <EmptyDescription>Start DRADIS to deploy a squadron.</EmptyDescription>
      </EmptyHeader>
    </Empty>
  );
}

// ── Main panel ────────────────────────────────────────────────────────────────

interface Props {
  squadrons: SquadronSummary[];
  isLoading: boolean;
  onSquadronClick?: (sq: SquadronSummary) => void;
  onDeploySuccess?: () => void;
}

export default function SquadronsPanel({
  squadrons,
  isLoading,
  onSquadronClick,
  onDeploySuccess,
}: Props) {
  const [deployModalOpen, setDeployModalOpen] = useState(false);
  const [helmModalOpen, setHelmModalOpen] = useState(false);
  // A deploy this panel just made, held until the engine's own queue confirms
  // it. Optimistic on purpose: the API answered success, so the row is true the
  // moment it is shown, and it is retired by real state rather than by a timer.
  const [justDeployed, setJustDeployed] = useState<{ id: string; marketType: string } | null>(null);

  // STAGED is active (pending deployment), not inactive
  // RTB belongs with the ACTIVE squadrons. "Return to base" is an operating
  // phase, not an ending: the squadron is alive and managing its open positions
  // to close, it has only stopped opening new ones. It is entered 60s before
  // every market close, so grouping it with STOOD_DOWN made a healthy crypto
  // squadron drop into a collapsed drawer labeled "stood-down" every fifteen
  // minutes and reappear afterwards — routine rotation shown as a death.
  const active = squadrons.filter(
    (s) =>
      s.state === "PATROLLING" ||
      s.state === "DEPLOYED" ||
      s.state === "STAGED" ||
      s.state === "RTB",
  );
  const inactive = squadrons.filter((s) => s.state === "STOOD_DOWN");

  // Get unique assets from squadrons
  const assets = [...new Set(squadrons.map((s) => s.asset.toLowerCase()))];

  // Fetch positions for all assets concurrently
  const { data: allPositions } = useSWR(
    assets.length > 0 ? ["squadron-missions", ...assets] : null,
    async () => await Promise.all(assets.map((asset) => getOpenPositions(asset))),
    { refreshInterval: 15_000 },
  );

  // In-flight and failed deployments. Polled faster than the squadron list
  // because this is exactly the window the operator is staring at: the engine's
  // own queue poll is 5s, so anything slower would make the UI look stuck for
  // reasons that have nothing to do with the engine.
  const { data: deployments, mutate: mutateDeployments } = useSWR<DeploymentStatus[]>(
    "deployment-queue",
    getDeployments,
    { refreshInterval: 3_000 },
  );

  // A queued row is worth showing until its squadron exists — after that the
  // real row carries the state and showing both would double-count.
  //
  // Keyed on the deployment's OWN status, not on whether the class is live.
  // Suppressing by class was correct while only one squadron per class could
  // exist: a live class meant the deployment had landed. Now that a class can
  // hold several squadrons, it suppressed the feedback exactly when it was most
  // wanted — deploying a second sports squadron beside a running one showed
  // nothing at all. A row's status goes pending → processing → active, and
  // 'active' is precisely the moment the squadron appears in the list.
  const inFlight = (deployments ?? []).filter(
    (d) => d.status === "pending" || d.status === "processing",
  );

  // Failures have no later status to retire them, so they are bounded by age
  // instead — long enough that one cannot slip by between two poll ticks,
  // short enough that last week's failures do not accumulate on screen.
  const FAILURE_VISIBLE_MS = 10 * 60 * 1000;
  const failed = (deployments ?? []).filter((d) => {
    if (d.status !== "failed") return false;
    const at = Date.parse(d.created_at);
    return Number.isNaN(at) || Date.now() - at < FAILURE_VISIBLE_MS;
  });
  // Retire the optimistic row once the engine's queue accounts for it — either
  // it is now one of the in-flight rows (which carry the real market id), or it
  // has left pending/processing entirely, meaning the squadron exists.
  const optimisticSettled =
    justDeployed !== null &&
    (inFlight.some((d) => d.id === justDeployed.id) ||
      (deployments ?? []).some(
        (d) => d.id === justDeployed.id && d.status !== "pending" && d.status !== "processing",
      ));
  useEffect(() => {
    if (optimisticSettled) setJustDeployed(null);
  }, [optimisticSettled]);

  const optimisticRow: DeploymentStatus[] =
    justDeployed && !optimisticSettled
      ? [
          {
            id: justDeployed.id,
            market_id: "selecting market…",
            market_type: justDeployed.marketType as DeploymentStatus["market_type"],
            raptors: [],
            vipers: [],
            status: "pending",
            created_at: new Date().toISOString(),
          },
        ]
      : [];

  const queueRows = [
    ...optimisticRow,
    ...inFlight.filter((d) => d.id !== justDeployed?.id),
    ...failed,
  ];

  // Row actions. `actingOn` disables just the row being acted on, so a slow
  // request cannot be double-submitted while leaving the others usable.
  const [actingOn, setActingOn] = useState<string | null>(null);
  // A refused Retry used to be swallowed with the dismiss, so the operator
  // clicked and nothing happened. It is named on its row now ([B43]); a
  // failed dismiss stays quiet, since the next poll re-reads real state.
  const [actErr, setActErr] = useState<{ id: string; text: string } | null>(null);
  const act = useCallback(
    async (id: string, fn: (id: string) => Promise<void>, reportFailure: boolean) => {
      setActingOn(id);
      setActErr(null);
      try {
        await fn(id);
        // Refresh at once rather than waiting for the next poll — the row is
        // gone from the operator's point of view the moment they click.
        await mutateDeployments();
      } catch (e) {
        if (reportFailure)
          setActErr({ id, text: `retry refused: ${e instanceof Error ? e.message : String(e)}` });
      } finally {
        setActingOn(null);
      }
    },
    [mutateDeployments],
  );
  const handleRetry = useCallback(
    (id: string) => {
      void act(id, retryDeployment, true);
    },
    [act],
  );
  const handleDismiss = useCallback(
    (id: string) => {
      void act(id, dismissDeployment, false);
    },
    [act],
  );

  // Build mission count map: asset -> count
  const missionCounts: Record<string, number> = {};
  if (allPositions) {
    assets.forEach((asset, i) => {
      missionCounts[asset] = allPositions[i]?.length ?? 0;
    });
  }

  return (
    <>
      <Card>
        <CardHeader className="border-b">
          <CardTitle className="flex flex-wrap items-center gap-2">
            CAG registry
            {!isLoading && (squadrons.length > 0 || queueRows.length > 0) && (
              <Badge variant="success">
                <span className="font-mono tabular-nums">{active.length}</span> active
              </Badge>
            )}
          </CardTitle>
          <CardAction className="flex flex-wrap items-center gap-2">
            <Button onClick={() => setDeployModalOpen(true)}>
              <PlusIcon data-icon="inline-start" />
              Deploy
            </Button>
            {/* Take the Helm: a sibling of Deploy, because both create a squadron */}
            <Button variant="outline" onClick={() => setHelmModalOpen(true)}>
              <CompassIcon data-icon="inline-start" />
              Take the helm
            </Button>
          </CardAction>
        </CardHeader>
        <CardContent className="px-0">
          {/* Body */}
          {isLoading || (squadrons.length === 0 && queueRows.length === 0) ? (
            <EmptyState isLoading={isLoading} />
          ) : (
            <>
              {/* Deployments the engine has not picked up yet, and ones that failed */}
              {queueRows.length > 0 && (
                <div>
                  {queueRows.map((dep) => (
                    <PendingDeploymentRow
                      key={dep.id}
                      dep={dep}
                      onRetry={handleRetry}
                      onDismiss={handleDismiss}
                      busy={actingOn === dep.id}
                      error={actErr?.id === dep.id ? actErr.text : undefined}
                    />
                  ))}
                </div>
              )}

              {/* Active squadrons */}
              {active.length > 0 && (
                <div>
                  {active.map((sq) => (
                    <SquadronRow
                      key={sq.id}
                      sq={sq}
                      onClick={onSquadronClick}
                      missionCount={missionCounts[sq.asset.toLowerCase()]}
                    />
                  ))}
                </div>
              )}

              {/* Inactive / historical — collapsed by default if active ones are present */}
              {inactive.length > 0 && (
                <details className="group">
                  <summary className="flex items-center gap-2 px-4 py-2 text-xs  text-muted-foreground cursor-pointer hover:text-muted-foreground transition-colors border-t border-border list-none">
                    <CaretRightIcon className="size-3 group-open:rotate-90 transition-transform" />
                    {inactive.length} stood-down
                  </summary>
                  {inactive.map((sq) => (
                    <SquadronRow
                      key={sq.id}
                      sq={sq}
                      onClick={onSquadronClick}
                      missionCount={missionCounts[sq.asset.toLowerCase()]}
                    />
                  ))}
                </details>
              )}
            </>
          )}
        </CardContent>
      </Card>

      {/* One line, and only while an intent is live. The record of resolved
        intents lives in the Helm view: intents outlive their squadrons — a Helm
        squadron retires itself once its intents are terminal — so the
        thesis-versus-outcome record cannot depend on a squadron card existing,
        but it also does not belong in the middle of the operating view. */}
      <HelmLiveLine />

      {/* Take the Helm */}
      <TakeTheHelmModal
        isOpen={helmModalOpen}
        onClose={() => setHelmModalOpen(false)}
        onDone={() => {
          onDeploySuccess?.();
        }}
      />

      {/* Deploy Squadron Modal */}
      <DeploySquadronModal
        isOpen={deployModalOpen}
        onClose={() => setDeployModalOpen(false)}
        onDeployed={(deploymentId, marketType) => {
          // Show the row immediately rather than waiting to discover it by poll.
          // The queued → active window is only a few seconds and both this panel
          // and the engine poll on their own schedules, so a purely poll-driven
          // row can be missed entirely — which leaves the operator watching an
          // unchanged table, the exact complaint this was meant to answer.
          setJustDeployed({ id: deploymentId, marketType });
          setDeployModalOpen(false);
          onDeploySuccess?.();
        }}
      />
    </>
  );
}
