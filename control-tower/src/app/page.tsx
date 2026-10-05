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

import { useCallback, useEffect, useState, type ReactNode } from "react";
import useSWR, { useSWRConfig } from "swr";
import dynamic from "next/dynamic";
import {
  CellSignalSlashIcon,
  GhostIcon,
  TrendDownIcon,
  TrendUpIcon,
  WarningIcon,
} from "@phosphor-icons/react";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { AppHeader, VIEW_DEFS, type AppView } from "@/components/shell/AppHeader";
import { SectionHeader, Stat, TONE_TEXT, signTone } from "@/components/shared";
import { cn } from "@/lib/utils";
import ChunkBoundary from "@/components/ChunkBoundary";

import LlmAdvisorCard from "@/components/LlmAdvisorCard";
import SquadronsPanel from "@/components/SquadronsPanel";
import SquadronDetailView from "@/components/SquadronDetailView";
import TradelogPage from "@/components/TradelogPage";
import HelmPage from "@/components/HelmPage";
import SetupPage from "@/components/SetupPage";
import AiActionsPage from "@/components/AiActionsPage";
import ConsolePage from "@/components/ConsolePage";
import AlphaGate from "@/components/AlphaGate";
import VenueGate from "@/components/VenueGate";
import ErrorBoundary from "@/components/ErrorBoundary";
import Footer from "@/components/Footer";
import { ViperHealthStrip } from "@/components/ViperHealthStrip";
import {
  getAssets,
  getConfig,
  getPnlHistory,
  getTrades,
  getOpenPositions,
  getHealth,
  patchConfig,
  getStatus,
  getLlmRecommendations,
  getLlmActions,
  getPortfolioValue,
  getVenueIncome,
  getSquadrons,
  refusalText,
} from "@/lib/api";
import { DEMO_MODE } from "@/lib/demo";
import { getSetupStatus } from "@/lib/setupApi";
import type { DynamicConfig, SquadronSummary, PortfolioValue, VenueIncome } from "@/lib/types";

// Recharts must be loaded client-side only. Loading states are explicit: without
// one these render nothing while their chunk is in flight, which on a slow
// connection is indistinguishable from a broken page.
function ChartPlaceholder({ label }: { label: string }) {
  return (
    <Card aria-busy className="gap-3 px-4">
      <span className="text-xs text-muted-foreground">{label}</span>
      <Skeleton className="h-72 w-full" />
    </Card>
  );
}
const PnlChart = dynamic(() => import("@/components/PnlChart"), {
  ssr: false,
  loading: () => <ChartPlaceholder label="Loading portfolio history…" />,
});
const TelemetryPage = dynamic(() => import("@/components/TelemetryPage"), {
  ssr: false,
  loading: () => <ChartPlaceholder label="Loading telemetry…" />,
});

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmt$(n: number) {
  return n.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
  });
}

function fmtPct(n: number) {
  const sign = n >= 0 ? "+" : "";
  return `${sign}${(n * 100).toFixed(2)}%`;
}

/** "45s", "12m", "3h" — for saying how old a figure is. */
function fmtAge(secs: number) {
  if (secs < 60) return `${Math.round(secs)}s`;
  if (secs < 3600) return `${Math.round(secs / 60)}m`;
  return `${(secs / 3600).toFixed(1)}h`;
}

// ── KPI card ──────────────────────────────────────────────────────────────────

function KpiCard({
  label,
  value,
  sub,
  valueClass,
}: {
  label: string;
  value: string;
  sub?: string;
  valueClass?: string;
}) {
  return (
    <Card size="sm" className="gap-1 px-4">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span
        className={cn("font-mono text-2xl font-semibold tracking-tight tabular-nums", valueClass)}
      >
        {value}
      </span>
      {sub && <span className="text-xs text-muted-foreground">{sub}</span>}
    </Card>
  );
}

/** One line for venue rebates and rewards; see [E57]. */
function VenueIncomeLine({ income }: { income: VenueIncome }) {
  const known = income.total !== null && income.session !== null;
  return (
    <p className="px-1 text-xs text-muted-foreground">
      <span className="mr-2 font-medium text-foreground">Venue rebates</span>
      {known ? (
        <>
          <span className="font-mono text-foreground tabular-nums">
            {fmt$(parseFloat(income.total!))}
          </span>{" "}
          all-time ·{" "}
          <span className="font-mono text-foreground tabular-nums">
            {fmt$(parseFloat(income.session!))}
          </span>{" "}
          this session · paid by the venue per wallet, not attributed to any viper
        </>
      ) : (
        "not read from the venue yet"
      )}
    </p>
  );
}

// ── Status banners ────────────────────────────────────────────────────────────

/// Order-book feeds that have stopped arriving.
///
/// Nothing else on this dashboard reports it. When the venue's book stops, the
/// API still answers 200, the squadron still reads PATROLLING and the Maker
/// still logs that it is quoting — every gate correctly declines an empty book,
/// and declining quietly looks exactly like a quiet market. An operator whose
/// connection drops would otherwise see a healthy engine that has silently
/// stopped being able to trade.
function DarkFeedBanner({
  feeds,
}: {
  feeds?: { market: string; market_name?: string; dark_for_secs: number }[];
}) {
  if (!feeds || feeds.length === 0) return null;
  return (
    <Alert variant="destructive">
      <CellSignalSlashIcon />
      <AlertTitle>
        Market data has stopped for {feeds.length} market{feeds.length === 1 ? "" : "s"}
      </AlertTitle>
      <AlertDescription>
        <p>
          The engine is still running and your positions are untouched, but with no order book it
          cannot evaluate entries or exits. If other markets are still trading, this market simply
          has no book — a freshly rotated or untraded market often does. If every market is listed
          here, check network access to the venue.
        </p>
        <ul className="space-y-0.5 font-mono">
          {feeds.map((f) => (
            <li key={f.market} className="truncate">
              {/* Name the market, not just the asset: "btc" alone reads as a broken
                  connection even when every other btc market is trading fine. */}
              {f.market_name ? `${f.market} — "${f.market_name}"` : f.market} — no book for{" "}
              {Math.floor(f.dark_for_secs / 60)}m {f.dark_for_secs % 60}s
            </li>
          ))}
        </ul>
      </AlertDescription>
    </Alert>
  );
}

function GhostBanner() {
  return (
    <Alert variant="warning">
      <GhostIcon />
      <AlertTitle>Ghost mode</AlertTitle>
      <AlertDescription>Orders are simulated. Nothing is sent to the venue.</AlertDescription>
    </Alert>
  );
}

// ── Portfolio value ───────────────────────────────────────────────────────────

/**
 * Honest-state rule ([B43]): this card never coerces a figure it does not
 * have. Three situations used to collapse into "$0.00 · ⚡ cached prices":
 * the engine has not taken a balance reading yet, the engine is unreachable,
 * and a mark really is stale. The first is what a Marketplace customer sees in
 * the seconds after importing their keys, and it read as the keys being wrong
 * ([B42]). Each now has its own words, and the dollar figure only appears when
 * there is one.
 */
function PortfolioValueCard({
  portfolio,
  sessionPnl,
  ghostMode,
  isLoading,
  unreachable,
}: {
  portfolio?: PortfolioValue;
  /** Realized session P&L, or `null` while it is not known yet. */
  sessionPnl: number | null;
  ghostMode?: boolean;
  isLoading: boolean;
  /** The last poll failed. With `portfolio` set the figures are the previous reading. */
  unreachable: boolean;
}) {
  const collateral = portfolio?.collateral != null ? parseFloat(portfolio.collateral) : null;
  const totalValue = portfolio?.total_value != null ? parseFloat(portfolio.total_value) : null;
  const positionsValue = portfolio ? parseFloat(portfolio.positions_value) : null;
  const unrealizedPnl = portfolio ? parseFloat(portfolio.unrealized_pnl) : null;
  const stranded = portfolio ? parseFloat(portfolio.stranded_collateral) : 0;
  const positionCount = portfolio?.position_count ?? 0;
  const unpriced = portfolio?.unpriced_positions ?? 0;
  const snapshotAge =
    portfolio?.collateral_source === "snapshot" ? portfolio.collateral_age_secs : null;
  // Stale is a statement about a reading that exists; absent a reading it is
  // neither true nor false, so it is never defaulted in either direction.
  const pricesStale = portfolio ? !portfolio.prices_live : false;
  const cashStale = snapshotAge != null && snapshotAge > 300;

  // The engine answered and has not read the balance yet: a real, benign state
  // on a fresh instance, named rather than rendered as an empty wallet.
  const awaitingBalance = !isLoading && !!portfolio && collateral === null;

  // The true session delta is realized P&L + unrealized P&L. This is correct
  // whether or not positions were carried in from a prior session, because it
  // derives the starting portfolio value as (totalValue - delta) rather than
  // using the raw collateral snapshot, which omits the cost basis of any open
  // positions. It needs all three figures; with any of them unknown there is
  // no delta.
  const delta =
    totalValue !== null && unrealizedPnl !== null && sessionPnl !== null
      ? sessionPnl + unrealizedPnl
      : null;
  const startingPortfolioVal = delta !== null && totalValue !== null ? totalValue - delta : null;
  const deltaPct =
    delta !== null && startingPortfolioVal !== null && startingPortfolioVal > 0
      ? delta / startingPortfolioVal
      : 0;
  const isPositive = (delta ?? 0) >= 0;

  const flag = (variant: "destructive" | "warning" | "outline", text: string, title: string) => (
    <Tooltip>
      <TooltipTrigger asChild>
        <Badge variant={variant} className="cursor-default">
          {text}
        </Badge>
      </TooltipTrigger>
      <TooltipContent className="max-w-64">{title}</TooltipContent>
    </Tooltip>
  );

  return (
    <Card className="px-5">
      <div className="flex flex-col gap-5 md:flex-row md:items-end md:justify-between">
        <div className="flex min-w-0 flex-col gap-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-xs text-muted-foreground">Portfolio value</span>
            {unreachable &&
              flag(
                "destructive",
                portfolio ? "Engine unreachable — last reading" : "Engine unreachable",
                "The last /api/portfolio poll failed. Figures shown are from the previous successful reading.",
              )}
            {pricesStale &&
              flag(
                "warning",
                "Stale marks",
                "At least one open position has not been marked to market in over five minutes. Its value is the last mark.",
              )}
            {cashStale &&
              snapshotAge != null &&
              flag(
                "warning",
                `Cash from a snapshot ${fmtAge(snapshotAge)} old`,
                "No live balance query is available on this venue right now; Cash is the newest P&L snapshot.",
              )}
            {unpriced > 0 &&
              flag(
                "outline",
                `${unpriced} awaiting first mark`,
                "New positions are valued at cost (or from the last snapshot) until the first mark-to-market sweep, about a minute.",
              )}
            {ghostMode &&
              flag("warning", "Virtual", "Ghost mode: simulated fills, no real orders.")}
          </div>
          {isLoading ? (
            <Skeleton className="h-9 w-48" />
          ) : (
            <span
              className={cn(
                "font-mono text-3xl font-semibold tracking-tight tabular-nums",
                totalValue === null && "text-muted-foreground",
              )}
            >
              {totalValue === null ? "—" : fmt$(totalValue)}
            </span>
          )}
          {awaitingBalance && (
            <span className="text-xs text-muted-foreground">
              Waiting for the first balance read — the engine has not queried the wallet yet.
            </span>
          )}
          {!isLoading &&
            delta !== null &&
            startingPortfolioVal !== null &&
            startingPortfolioVal > 0 && (
              <span
                className={cn(
                  "flex items-center gap-1 font-mono text-sm tabular-nums",
                  TONE_TEXT[signTone(delta)],
                )}
              >
                {isPositive ? <TrendUpIcon /> : <TrendDownIcon />}
                {fmt$(Math.abs(delta))} ({(Math.abs(deltaPct) * 100).toFixed(2)}%)
                <span className="font-sans text-muted-foreground">vs session start</span>
              </span>
            )}
        </div>

        <div className="grid grid-cols-3 gap-6 md:gap-8">
          <Stat
            label="Cash"
            value={collateral === null ? "—" : fmt$(collateral)}
            tone={collateral === null ? "muted" : undefined}
            sub={
              // Settlement proceeds paid as USDC.e sit in the Safe until wrapped into
              // pUSD; the exchange cannot see them, so they are shown here rather than
              // folded into Cash. Not counted in Portfolio Value.
              stranded > 0 ? (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span className="cursor-default font-mono text-warning tabular-nums">
                      + {fmt$(stranded)} unwrapped
                    </span>
                  </TooltipTrigger>
                  <TooltipContent className="max-w-64">
                    USDC.e settlement proceeds in your Safe, not yet wrapped into pUSD. Real cash,
                    not tradeable, not counted above. Enable Collateral Sweep in Setup to wrap it.
                  </TooltipContent>
                </Tooltip>
              ) : undefined
            }
          />
          <Stat
            label="Positions"
            value={positionsValue === null ? "—" : fmt$(positionsValue)}
            tone={positionsValue === null ? "muted" : undefined}
            sub={positionCount > 0 ? `${positionCount} open` : undefined}
          />
          <Stat
            label="Unrealized P&L"
            value={
              unrealizedPnl === null ? "—" : (unrealizedPnl >= 0 ? "+" : "") + fmt$(unrealizedPnl)
            }
            tone={signTone(unrealizedPnl)}
          />
        </div>
      </div>
    </Card>
  );
}

// ── Routing ───────────────────────────────────────────────────────────────────

/**
 * The app's location, encoded in the URL hash.
 *
 * Navigation was state-only, so the browser had no record of it: Back from a
 * squadron detail left DRADIS entirely rather than returning to the CAG, which
 * is a good way to lose your place mid-investigation. The hash keeps view and
 * focused squadron, so Back and Forward walk the trail, a reload lands where you
 * were, and a squadron page can be linked to directly.
 *
 * Hash rather than real paths because the Control Tower is served as a static
 * export with no server-side routing.
 */
function encodeRoute(view: AppView, squadronId: string | null): string {
  return squadronId ? `#${view}/squadron/${encodeURIComponent(squadronId)}` : `#${view}`;
}

function decodeRoute(hash: string): { view: AppView; squadronId: string | null } {
  const [view, kind, id] = hash.replace(/^#/, "").split("/");
  // An unknown view means a hand-edited or stale URL; fall back rather than
  // rendering nothing.
  const known = VIEW_DEFS.some((v) => v.id === view);
  return {
    view: known ? (view as AppView) : "main",
    squadronId: kind === "squadron" && id ? decodeURIComponent(id) : null,
  };
}

export default function DashboardPage() {
  // ── Top-level view (Main vs Tradelog) ───────────────────────────────────────
  const [activeView, setActiveView] = useState<AppView>("main");

  // ── Squadron drill-down state ────────────────────────────────────────────────
  const [focusedSquadronId, setFocusedSquadronId] = useState<string | null>(null);

  /** Move to a view (optionally a squadron) and record it in browser history. */
  const navigate = useCallback((view: AppView, squadronId: string | null = null) => {
    setActiveView(view);
    setFocusedSquadronId(squadronId);
    const next = encodeRoute(view, squadronId);
    if (typeof window !== "undefined" && window.location.hash !== next) {
      window.history.pushState({ view, squadronId }, "", next);
    }
  }, []);

  // Adopt the URL on first paint, and follow Back/Forward thereafter. Deliberately
  // does not push: this reacts to history rather than adding to it.
  useEffect(() => {
    const apply = () => {
      const { view, squadronId } = decodeRoute(window.location.hash);
      setActiveView(view);
      setFocusedSquadronId(squadronId);
    };
    apply();
    window.addEventListener("popstate", apply);
    return () => window.removeEventListener("popstate", apply);
  }, []);

  // ── Asset selector — populated from GET /api/assets on first load ───────────
  const { data: availableAssets = [] } = useSWR("assets", getAssets, {
    refreshInterval: 0,
    revalidateOnFocus: false,
    // Seed a sensible default while the request is in-flight
    fallbackData: [],
  });

  const { data: config, mutate: refreshConfig } = useSWR("config", getConfig, {
    refreshInterval: 0,
    revalidateOnFocus: false,
  });

  // CAG-level P&L history: fetch global aggregated history (all assets) for main dashboard
  const {
    data: pnl,
    isLoading: pnlLoading,
    error: pnlError,
  } = useSWR("pnl-global", () => getPnlHistory(1440), { refreshInterval: 60_000 });

  // For chart markers: fetch ALL trades/positions across all assets (not filtered by selected asset).
  // The asset list is part of the SWR key: a static key would cache the initial []
  // result (assets not loaded yet) and markers wouldn't render until the 15s refresh.
  const { data: allTrades } = useSWR(
    availableAssets.length > 0 ? ["trades-all", ...availableAssets] : null,
    async () => {
      const results = await Promise.all(availableAssets.map((a) => getTrades(60, a)));
      return results.flat();
    },
    { refreshInterval: 15_000 },
  );

  const { data: allOpenPositions } = useSWR(
    availableAssets.length > 0 ? ["positions-all", ...availableAssets] : null,
    async () => {
      const results = await Promise.all(availableAssets.map((a) => getOpenPositions(a)));
      return results.flat();
    },
    { refreshInterval: 15_000 },
  );

  const { data: health } = useSWR("health", getHealth, { refreshInterval: 10_000 });

  const { data: status } = useSWR("status", getStatus, { refreshInterval: 30_000 });

  // Refresh EVERY server-backed card the moment the engine restarts.
  //
  // This used to revalidate only `pnl-global` — the chart — because that was the
  // card the complaint named. It was the wrong scope. The number an operator
  // actually stares at after entering their venue credentials is the wallet
  // balance on the `portfolio` key, which polls on its own unsynchronized 30s
  // interval, and `config` does not poll at all (`refreshInterval: 0`). So the
  // balance card kept showing the pre-restart value while the chart beside it had
  // already caught up, which reads as the key not having worked. On a fresh
  // Ireland box the log showed "Starting portfolio value: $59.49" within the same
  // second while the card was still empty.
  //
  // A restart invalidates all server state at once, so revalidate all of it at
  // once rather than curating a list that the next new card will fall off.
  //
  // `session_started_at` changes on every engine restart, so this refetches once
  // and then every key goes back to its own cadence. Note this is the BACKSTOP:
  // `status` itself polls at 30s, so a restart can go unnoticed here for that
  // long. The Setup view, which knows precisely when the engine went down and
  // polls at 3s for its return, does the same revalidation immediately.
  const { mutate: mutateKey } = useSWRConfig();
  const sessionStartedAt = status?.session_started_at;
  useEffect(() => {
    if (!sessionStartedAt) return;
    mutateKey(() => true);
  }, [sessionStartedAt, mutateKey]);

  // Poll every 5 minutes — recommendations only arrive every 30 min at most.
  // Global LLM Advisor reads ALL asset databases and writes to primary pool,
  // so we fetch without an asset filter (always reads from primary).
  const {
    data: llmRecs,
    isLoading: llmLoading,
    error: llmError,
  } = useSWR("llmRecs", () => getLlmRecommendations(10), { refreshInterval: 300_000 });

  // AI config proposals awaiting approval — poll faster (30 s): they're
  // TTL-bound; the Main strip shows a count, the AI Actions view the detail.
  const { data: llmActions } = useSWR("llmActions", () => getLlmActions(100), {
    refreshInterval: 30_000,
  });
  const pendingLlmCount = (llmActions ?? []).filter((a) => a.status === "proposed").length;

  // Portfolio value: collateral + live mark-to-market on open positions.
  // Refresh every 30 s so the number stays fresh without hammering Polymarket CLOB.
  // `error` is kept so the banner can say the engine is unreachable instead of
  // showing a wallet that appears to have emptied itself ([B43]).
  const {
    data: portfolio,
    isLoading: portfolioLoading,
    error: portfolioError,
  } = useSWR("portfolio", getPortfolioValue, { refreshInterval: 30_000 });

  // Venue rebates and rewards ([E57]). Read hourly by the engine, so a slow
  // refresh is plenty.
  const { data: venueIncome } = useSWR("venue-income", getVenueIncome, {
    refreshInterval: 300_000,
  });

  // CAG squadron registry — refresh every 10 s to catch state transitions quickly.
  const {
    data: squadrons,
    isLoading: squadronsLoading,
    error: squadronsError,
  } = useSWR("squadrons", getSquadrons, { refreshInterval: 10_000 });
  // No list, loading or failed: the counts are unknown, not zero ([B43]).
  const squadronsUnknown = squadronsLoading || (!squadrons && !!squadronsError);

  // Setup state — drives the "engine idle, complete Setup" first-run banner.
  //
  // Polled at the same cadence as trades and positions rather than the 60s it
  // used to use. This value's whole job is to make a warning disappear the
  // moment setup is complete, so a stale minute of "ENGINE IDLE — venue
  // credentials not configured" on a correctly configured instance is the
  // worst-case cost of the slower interval, and it lands on a first-run or
  // post-migration operator with no way to tell whether their import worked.
  // Explicit revalidation on import and on restart is the fast path; this is
  // the ceiling on how wrong the banner can be if either is missed.
  const { data: setupStatus, mutate: mutateSetupStatus } = useSWR(
    !DEMO_MODE ? "setupStatus" : null,
    getSetupStatus,
    { refreshInterval: 15_000 },
  );

  // ── First-run overlays, in order ──────────────────────────────────────────
  //
  // Venue BEFORE jurisdiction, and the order is load-bearing. The risk gate
  // records an acknowledgment stamped with the running venue, and that record is
  // write-once. Shown first, it made a US buyer accept International terms — for
  // a venue the same screen tells them they may not use — and filed that
  // permanently before they ever reached the venue switcher.
  const multiVenue = (setupStatus?.venues_available?.length ?? 0) > 1;

  // Set when the operator backs out of the acknowledgment to pick again. The
  // venue file on disk stays as it is — reopening the chooser is a UI decision,
  // and the choice is only rewritten if they actually confirm a different one.
  const [reselectVenue, setReselectVenue] = useState(false);

  const needsVenue = !!setupStatus && multiVenue && (!setupStatus.venue_selected || reselectVenue);

  const venueGate = needsVenue ? (
    <VenueGate
      available={setupStatus!.venues_available!}
      onChosen={() => {
        setReselectVenue(false);
        mutateSetupStatus();
      }}
    />
  ) : null;

  // Only once a venue is settled — either chosen here, or the sole one this
  // image carries — does the jurisdiction gate have a venue worth naming.
  const alphaGate =
    setupStatus && !needsVenue && !setupStatus.alpha_ack ? (
      <AlphaGate
        venue={setupStatus.venue}
        appVersion={setupStatus.app_version}
        edition={setupStatus.edition}
        onAcknowledged={() => mutateSetupStatus()}
        onBack={multiVenue ? () => setReselectVenue(true) : undefined}
      />
    ) : null;

  // ── Stats derived from P&L history ──────────────────────────────────────────
  const latestSnap = pnl?.[0];
  // No snapshot yet: Session P&L is unknown, and renders as a dash, not $0.00.
  const sessionKnown = !!latestSnap;
  const oldestSnap = pnl?.[pnl.length - 1];
  const startingBal = oldestSnap ? parseFloat(oldestSnap.collateral) : 0;
  const sessionPnl = latestSnap ? parseFloat(latestSnap.session_pnl) : 0;
  const sessionPct = startingBal > 0 ? sessionPnl / startingBal : 0;

  // ── Patch handler ────────────────────────────────────────────────────────────
  const handlePatch = useCallback(
    async (patch: Partial<DynamicConfig>) => {
      if (DEMO_MODE) return;
      await patchConfig(patch);
      await refreshConfig();
    },
    [refreshConfig],
  );

  // The GHOST/LIVE switch is the most consequential control on the page; a
  // refused switch must say so rather than leave the button as it was ([B43]).
  const [ghostErr, setGhostErr] = useState<string | null>(null);
  const toggleGhost = useCallback(async () => {
    if (!config) return;
    setGhostErr(null);
    try {
      await handlePatch({ ghost_mode: !config.ghost_mode });
    } catch (e) {
      setGhostErr(refusalText(e));
    }
  }, [config, handlePatch]);

  // ── Squadron navigation ────────────────────────────────────────────────────
  const handleSquadronClick = useCallback(
    (sq: SquadronSummary) => {
      navigate("main", sq.id);
    },
    [navigate],
  );

  const handleBackToCag = useCallback(() => {
    navigate("main", null);
  }, [navigate]);

  const focusedSquadron = squadrons?.find((s) => s.id === focusedSquadronId);

  // ── Layout ─────────────────────────────────────────────────────────────────
  // Every view shares the header, the first-run gates, and the status banners.
  // Console and Setup skip the trading banners: they are where you go to fix them.
  const showTradingBanners = activeView !== "console" && activeView !== "setup";
  const engineIdle = !!setupStatus && !setupStatus.venue_configured && activeView !== "setup";
  const shell = (content: ReactNode) => (
    <div className="min-h-dvh">
      {venueGate}
      {alphaGate}
      <AppHeader
        active={activeView}
        onNavigate={(v) => navigate(v)}
        health={health}
        sessionStartedAt={status?.session_started_at}
        ghostMode={config && !DEMO_MODE ? config.ghost_mode : undefined}
        onToggleGhost={toggleGhost}
        ghostError={ghostErr}
      />
      <main className="mx-auto flex max-w-7xl flex-col gap-6 px-4 py-6 sm:px-6">
        {engineIdle && (
          <Alert variant="warning">
            <WarningIcon />
            <AlertTitle>Engine idle — venue credentials not configured</AlertTitle>
            <AlertDescription>
              DRADIS is running but cannot trade. Enter your credentials in Setup and restart the
              engine.
            </AlertDescription>
            <AlertAction>
              <Button size="xs" variant="outline" onClick={() => navigate("setup")}>
                Open Setup
              </Button>
            </AlertAction>
          </Alert>
        )}
        {showTradingBanners && config?.ghost_mode && <GhostBanner />}
        {showTradingBanners && <DarkFeedBanner feeds={status?.dark_market_feeds} />}
        {content}
        <Footer />
      </main>
    </div>
  );

  // ── Squadron detail (drill-down from the registry) ─────────────────────────
  if (focusedSquadron) {
    return shell(<SquadronDetailView squadron={focusedSquadron} onBack={handleBackToCag} />);
  }

  switch (activeView) {
    case "tradelog":
      return shell(<TradelogPage availableAssets={availableAssets} />);
    case "helm":
      return shell(
        <ErrorBoundary label="Helm">
          <HelmPage />
        </ErrorBoundary>,
      );
    case "telemetry":
      return shell(
        <ErrorBoundary label="Telemetry">
          <ChunkBoundary name="Telemetry">
            <TelemetryPage availableAssets={availableAssets} venue={setupStatus?.venue} />
          </ChunkBoundary>
        </ErrorBoundary>,
      );
    case "ai":
      return shell(
        <ErrorBoundary label="AI Actions">
          <AiActionsPage />
        </ErrorBoundary>,
      );
    case "console":
      return shell(
        <ErrorBoundary label="Console">
          <ConsolePage />
        </ErrorBoundary>,
      );
    case "setup":
      return shell(
        <ErrorBoundary label="Setup">
          <SetupPage />
        </ErrorBoundary>,
      );
  }

  // ── Overview (CAG) ─────────────────────────────────────────────────────────
  return shell(
    <>
      <PortfolioValueCard
        portfolio={portfolio}
        sessionPnl={pnlLoading || !latestSnap ? null : sessionPnl}
        ghostMode={config?.ghost_mode}
        isLoading={portfolioLoading}
        unreachable={!!portfolioError}
      />

      {pnlLoading ? (
        <ChartPlaceholder label="Loading portfolio history…" />
      ) : (
        <ChunkBoundary name="Portfolio history">
          <PnlChart
            data={pnl ?? []}
            loadError={
              !pnl && pnlError
                ? pnlError instanceof Error
                  ? pnlError.message
                  : String(pnlError)
                : undefined
            }
            startingBalance={startingBal}
            ghostMode={config?.ghost_mode}
            trades={allTrades ?? []}
            openPositions={allOpenPositions ?? []}
          />
        </ChunkBoundary>
      )}

      {/* Three cards, not four: an "Active Assets" card used to sit here
          showing `availableAssets.length`, which is the number of open SQLite
          shards. On Polymarket International those shards are BTC/ETH/SOL so
          it read as assets, but on Polymarket US and Kalshi they are market
          wings plus the venue's own default shard — so it reported 4 for a
          venue with three wings and no multi-asset ops at all. */}
      <div className="flex flex-col gap-2">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <KpiCard
            label="Active squadrons"
            value={
              squadronsUnknown || !squadrons
                ? "—"
                : String(
                    squadrons.filter((s) => s.state === "PATROLLING" || s.state === "DEPLOYED")
                      .length,
                  )
            }
            sub={squadronsError && !squadrons ? "Couldn't load" : "Deployed and patrolling"}
          />
          <KpiCard
            label="Session P&L"
            value={sessionKnown ? fmt$(sessionPnl) : "—"}
            sub={sessionKnown ? fmtPct(sessionPct) : "No snapshot yet"}
            valueClass={sessionKnown ? TONE_TEXT[signTone(sessionPnl)] : undefined}
          />
          <KpiCard
            label="Total squadrons"
            value={squadronsUnknown || !squadrons ? "—" : String(squadrons.length)}
            sub={squadronsError && !squadrons ? "Couldn't load" : "All states"}
          />
        </div>
        {/* Venue income ([E57]): paid by the venue per wallet, outside any
            trade, so it sits beside the cards rather than inside Session P&L
            or any viper's figures. Hidden on venues whose income is not read;
            "not read yet" rather than $0.00 before the first read ([B43]). */}
        {venueIncome?.supported && <VenueIncomeLine income={venueIncome} />}
      </div>

      {/* LLM Advisor summary strip — detail lives in AI Actions. */}
      <LlmAdvisorCard
        recommendations={llmRecs ?? []}
        isLoading={llmLoading}
        loadError={
          !llmRecs && llmError
            ? llmError instanceof Error
              ? llmError.message
              : String(llmError)
            : undefined
        }
        advisorEnabled={status?.llm_advisor_enabled ?? true}
        pendingCount={pendingLlmCount}
        onGoToActions={() => navigate("ai")}
      />

      <section className="flex flex-col gap-3">
        <SectionHeader
          title="Squadrons"
          description="Select a squadron for its raptors, vipers and trades."
        />
        {squadronsError && !squadrons ? (
          <Alert variant="destructive">
            <WarningIcon />
            <AlertTitle>Couldn&apos;t load the squadron registry</AlertTitle>
            <AlertDescription>
              {squadronsError instanceof Error ? squadronsError.message : String(squadronsError)}
            </AlertDescription>
          </Alert>
        ) : (
          <SquadronsPanel
            squadrons={squadrons ?? []}
            isLoading={squadronsLoading}
            onSquadronClick={handleSquadronClick}
          />
        )}
      </section>

      {/* Viper health rollup (per-squadron detail lives in the drill-down). */}
      <ViperHealthStrip />
    </>,
  );
}
