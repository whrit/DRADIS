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

import { useCallback, useState } from "react";
import useSWR from "swr";
import type { SquadronSummary, DynamicConfig, AssetRaptorHealth } from "@/lib/types";
import { marketLabel } from "@/lib/types";
import {
  getTrades,
  getTradeStats,
  getOpenPositions,
  getStatus,
  getSquadronConfig,
  getVipersStatus,
  patchSquadronConfig,
  getConfigSchema,
  standDownSquadron,
  VIPER_DEFS,
} from "@/lib/api";
import ViperCard, { fmtAgo, isTroubled } from "@/components/ViperCard";
import { AdvancedRow } from "@/components/AdvancedConfigModal";
import OpenPositionsCard from "@/components/OpenPositionsCard";
import HelmIntentsPanel from "@/components/HelmIntentsPanel";
import { useConfirm } from "@/components/ConfirmDialog";
import { DEMO_MODE } from "@/lib/demo";
import { ArrowLeftIcon, AirplaneLandingIcon } from "@phosphor-icons/react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Item } from "@/components/ui/item";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Empty, EmptyHeader, EmptyTitle, EmptyDescription } from "@/components/ui/empty";
import { Skeleton } from "@/components/ui/skeleton";
import { SectionHeader, Stat, StatusDot, signTone } from "@/components/shared";

// ── Raptor health panel ───────────────────────────────────────────────────────

/** Display metadata per raptor kind. `flag` ties the kind to its health field
 *  in the /api/status raptor map; kinds without a flag (future sports/politics)
 *  render as "Pending" until their feed publishes health. */
const RAPTOR_META: Record<
  string,
  {
    label: string;
    flag?:
      | "price_connected"
      | "funding_connected"
      | "deriv_connected"
      | "tide_connected"
      | "sports_connected"
      | "horizon_connected";
    source: string;
    /** Health-map key to read this raptor's flag from, when it differs from the
     *  squadron's asset (e.g. the venue-neutral Sports Raptor publishes under "sports"). */
    healthKey?: string;
    /** When the feed is expected to be intermittently offline (e.g. off-hours),
     *  render the disconnected state as a neutral idle badge rather than a red error. */
    offlineText?: string;
  }
> = {
  price: {
    label: "Price Raptor",
    flag: "price_connected",
    source: "Binance Spot WS",
  },
  funding: {
    label: "Funding Raptor",
    flag: "funding_connected",
    source: "Binance Funding API",
  },
  derivatives: {
    label: "Derivatives Raptor",
    flag: "deriv_connected",
    source: "Binance FAPI (OI + CVD)",
  },
  tide: {
    label: "Tide Raptor",
    flag: "tide_connected",
    source: "Alpaca IEX (ETF iNAV)",
    offlineText: "Idle (off-hours)",
  },
  horizon: {
    label: "Horizon Raptor",
    flag: "horizon_connected",
    source: "Alpaca IEX (SPY/QQQ/UVXY)",
    // Macro raptor — publishes health under the "btc" key regardless of squadron asset.
    healthKey: "btc",
    offlineText: "Idle (off-hours)",
  },
  sports: {
    label: "Sports Raptor",
    flag: "sports_connected",
    source: "The Odds API (book consensus board)",
    healthKey: "sports",
    offlineText: "Idle",
  },
};

function RaptorHealthPanel({
  raptorKinds,
  raptors,
  asset,
  taxonomy,
}: {
  raptorKinds: string[];
  raptors?: Record<string, AssetRaptorHealth>;
  asset: string;
  taxonomy: string;
}) {
  const h = raptors?.[asset];

  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle>Raptor telemetry</CardTitle>
      </CardHeader>
      <CardContent>
        {raptorKinds.length === 0 ? (
          <div className="text-xs  text-muted-foreground">
            No raptors linked to the{" "}
            <span className="text-foreground">{taxonomy || "unknown"}</span> market class yet.
          </div>
        ) : (
          <div className="space-y-2">
            {raptorKinds.map((kind) => {
              const meta = RAPTOR_META[kind];
              const label = meta?.label ?? `${kind.charAt(0).toUpperCase()}${kind.slice(1)} Raptor`;
              // Implemented raptors with a health flag report live connection;
              // any without (roadmapped kinds) show as pending.
              const hasFlag = !!meta?.flag;
              const src = meta?.healthKey ? raptors?.[meta.healthKey] : h;
              const connected = hasFlag ? (src?.[meta!.flag!] ?? false) : false;
              // No health reading yet (status still loading, or it failed): the
              // feed's state is unknown, not "Reconnecting" ([B43]).
              const unread = hasFlag && src === undefined;
              // A feed with an `offlineText` (e.g. Tide off-hours) shows a neutral
              // idle badge when down rather than a red "Reconnecting" error.
              const idleStyle = !connected && meta?.offlineText;
              const statusText = !hasFlag
                ? "Pending"
                : unread
                  ? "Checking…"
                  : connected
                    ? "Connected"
                    : idleStyle
                      ? meta!.offlineText!
                      : "Reconnecting";
              return (
                <Item key={kind} variant="muted" size="sm">
                  <span className="flex flex-1 items-center gap-2">
                    <StatusDot
                      tone={
                        !hasFlag || unread
                          ? "muted"
                          : connected
                            ? "success"
                            : idleStyle
                              ? "muted"
                              : "destructive"
                      }
                      pulse={connected}
                    />
                    {label}
                  </span>
                  <Badge
                    variant={
                      !hasFlag || unread
                        ? "warning"
                        : connected
                          ? "success"
                          : idleStyle
                            ? "secondary"
                            : "destructive"
                    }
                  >
                    {statusText}
                  </Badge>
                </Item>
              );
            })}
            {(() => {
              const sources = raptorKinds.map((k) => RAPTOR_META[k]?.source).filter(Boolean);
              return sources.length > 0 ? (
                <div className="text-xs  text-muted-foreground pt-1">
                  Source: {sources.join(" + ")}
                </div>
              ) : null;
            })()}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ── Squadron info card ────────────────────────────────────────────────────────

function SquadronInfoCard({ squadron }: { squadron: SquadronSummary }) {
  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle>Squadron info</CardTitle>
      </CardHeader>
      <CardContent>
        <dl className="space-y-2">
          <div className="flex justify-between gap-3">
            <dt className="text-muted-foreground">Name</dt>
            <dd>{squadron.name}</dd>
          </div>
          <div className="flex justify-between gap-3">
            <dt className="text-muted-foreground">Asset</dt>
            <dd>
              <Badge variant="outline" className="text-chart-1 border-chart-1/20 bg-chart-1/10">
                <span className="font-mono">{squadron.asset}</span>
              </Badge>
            </dd>
          </div>
          {squadron.market_class && (
            <div className="flex justify-between gap-3">
              <dt className="text-muted-foreground">Market class</dt>
              <dd>
                <Badge variant="outline" className="text-chart-4 border-chart-4/20 bg-chart-4/10">
                  {squadron.market_class}
                </Badge>
              </dd>
            </div>
          )}
          <div className="flex justify-between gap-3">
            <dt className="text-muted-foreground">State</dt>
            <dd>
              <Badge
                variant={
                  squadron.state === "PATROLLING"
                    ? "success"
                    : squadron.state === "STAGED"
                      ? "warning"
                      : squadron.state === "DEPLOYED"
                        ? "default"
                        : "outline"
                }
              >
                {squadron.state}
              </Badge>
            </dd>
          </div>
          <div className="flex justify-between gap-3">
            <dt className="text-muted-foreground">Deployed</dt>
            <dd className="font-mono tabular-nums text-muted-foreground">
              {new Date(squadron.deployed_at).toLocaleString()}
            </dd>
          </div>
          <div className="space-y-1 border-t border-border pt-2">
            <dt className="text-muted-foreground">
              {squadron.asset.toLowerCase().startsWith("us")
                ? "Active market"
                : "Primary market (hourly)"}
            </dt>
            <dd
              className={squadron.market_name ? "wrap-break-word" : "text-muted-foreground italic"}
            >
              {marketLabel(squadron.market_name)}
            </dd>
          </div>
          {squadron.maker_market_name && (
            <div className="space-y-1 border-t border-border pt-2">
              <dt className="text-muted-foreground">Maker market (window/daily)</dt>
              <dd className="wrap-break-word">{squadron.maker_market_name}</dd>
            </div>
          )}
          <div className="border-t border-border pt-2 text-2xs text-muted-foreground">
            <dt className="inline">ID: </dt>
            <dd className="inline font-mono wrap-break-word">{squadron.id}</dd>
          </div>
        </dl>
      </CardContent>
    </Card>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

interface Props {
  squadron: SquadronSummary;
  onBack: () => void;
}

/**
 * Config groups that belong to the squadron rather than to any single viper.
 *
 * The schema is rendered by matching `group` against a viper's name, so a group
 * named for something other than a viper had no home and simply never appeared —
 * "Order Book" and "Exit Accounting" were registered in the Rust schema and
 * unreachable in the UI. Listed explicitly rather than inferred as "not a viper
 * name", because a squadron only carries the vipers of its market class: a
 * politics squadron has no Momentum card, and inferring would then treat
 * Momentum's own fields as squadron-wide.
 */
// 'Sports Lines' holds the line-quality gates that BOTH FairValue and Maker read
// on sports markets. They sit here rather than on either card because duplicating
// one key onto two cards would imply two independent settings.
const SQUADRON_GROUPS = ["Order Book", "Exit Accounting", "Sports Lines"];

function SquadronSettingsCard({
  config,
  onPatch,
}: {
  config: DynamicConfig;
  onPatch: (patch: Partial<DynamicConfig>) => Promise<void>;
}) {
  const { data: schema } = useSWR("configSchema", getConfigSchema);
  const fields = (schema ?? []).filter((f) => SQUADRON_GROUPS.includes(f.group));
  if (fields.length === 0) return null;

  return (
    <Card size="sm">
      <CardContent className="space-y-3">
        <div>
          <h3 className="text-sm font-medium text-foreground">Squadron settings</h3>
          <p className="text-2xs text-muted-foreground mt-1 leading-relaxed">
            Apply to every viper in this squadron. Changing them here affects only this squadron, so
            a setting can be tried on one market class and compared against the others.
          </p>
        </div>
        {SQUADRON_GROUPS.map((group) => {
          const inGroup = fields.filter((f) => f.group === group);
          if (inGroup.length === 0) return null;
          return (
            <div key={group} className="space-y-2">
              <p className="text-xs font-medium text-muted-foreground">{group}</p>
              {inGroup.map((f) => (
                <AdvancedRow
                  key={f.key}
                  field={f}
                  config={config}
                  onPatch={onPatch}
                  disabled={DEMO_MODE}
                />
              ))}
            </div>
          );
        })}
      </CardContent>
    </Card>
  );
}

export default function SquadronDetailView({ squadron, onBack }: Props) {
  const asset = squadron.asset.toLowerCase();
  // Raptor health is keyed by crypto underlying (btc/eth/sol), which may
  // differ from the squadron's venue asset (e.g. "kalshi"). Fall back to
  // asset for older backends that don't send `underlying`.
  const raptorAsset = (squadron.underlying || asset).toLowerCase();

  // Market taxonomy resolved by the backend (data-driven; falls back to the
  // full set if an older backend didn't supply it).
  const raptorKinds = squadron.raptors ?? [];
  const taxonomy = squadron.market_class ?? "unknown";
  const activeVipers =
    squadron.vipers && squadron.vipers.length > 0
      ? VIPER_DEFS.filter((v) => squadron.vipers!.includes(v.statusKey))
      : VIPER_DEFS;

  // ── Stand down ─────────────────────────────────────────────────────────────
  // Stops this squadron without stopping the engine. Confirmed first, because it
  // can flatten open positions and there is no undo — the operator redeploys.
  const [confirm, confirmDialog] = useConfirm();
  const [standingDown, setStandingDown] = useState(false);
  const [standDownError, setStandDownError] = useState<string | null>(null);

  const handleStandDown = useCallback(async () => {
    const autoDeployed = taxonomy === "politics" || taxonomy === "sports";
    const ok = await confirm({
      title: `Stand down ${squadron.name}?`,
      body: (
        <div className="space-y-2">
          <p>
            This squadron stops trading {squadron.market_name || "its market"}. Resting orders are
            cancelled and any open position is flattened or left to settle.
          </p>
          {autoDeployed && (
            <p className="text-warning">
              Auto-deploy for {taxonomy} will be switched off, so DRADIS does not immediately start
              a replacement. Turn it back on in Setup → Deployment.
            </p>
          )}
          <p className="text-muted-foreground">The engine and other squadrons keep running.</p>
        </div>
      ),
      confirmLabel: "Stand down",
      tone: "danger",
    });
    if (!ok) return;

    setStandingDown(true);
    setStandDownError(null);
    try {
      await standDownSquadron(squadron.id);
      onBack();
    } catch (err) {
      setStandDownError(err instanceof Error ? err.message : "Stand-down failed");
    } finally {
      setStandingDown(false);
    }
  }, [confirm, squadron.id, squadron.name, squadron.market_name, taxonomy, onBack]);

  // ── Data fetching ──────────────────────────────────────────────────────────
  // Load squadron-specific config instead of global config
  const { data: config, mutate: refreshConfig } = useSWR(
    ["squadron-config", squadron.id],
    () => getSquadronConfig(squadron.id),
    { refreshInterval: 0, revalidateOnFocus: false },
  );

  const { data: trades, isLoading: tradesLoading } = useSWR(
    ["trades", asset],
    () => getTrades(60, asset),
    { refreshInterval: 15_000 },
  );

  // Summary cards read lifetime aggregates, NOT a reduce over `trades` above:
  // that call returns only the newest 60 rows (and the API clamps any limit to
  // 500), so every "total" it fed was silently truncated once the shard passed
  // 60 trades. `trades` still backs the list/table, which wants a recent window.
  const { data: tradeStats, isLoading: statsLoading } = useSWR(
    ["trade-stats", asset],
    () => getTradeStats(asset),
    { refreshInterval: 15_000 },
  );

  const { data: openPositions, isLoading: positionsLoading } = useSWR(
    ["positions", asset],
    () => getOpenPositions(asset),
    { refreshInterval: 15_000 },
  );

  const { data: status } = useSWR("status", getStatus, { refreshInterval: 30_000 });

  // Per-viper liveness + veto reasons, rendered on each ViperCard.
  const { data: viperStatus } = useSWR(["vipers-status", asset], () => getVipersStatus(asset), {
    refreshInterval: 10_000,
    revalidateOnFocus: false,
  });

  // Registry rows keyed by `Strategy::name()` — the same key VIPER_DEFS carries.
  const statusByStrategy = new Map((viperStatus ?? []).map((r) => [r.strategy, r]));

  // The registry holds every viper the engine has evaluated, which is not
  // necessarily the set that renders as a card (market-class filtering, or a
  // viper with no VIPER_DEFS entry yet). Surface the remainder rather than
  // dropping it — an unlisted viper erroring silently is exactly what this
  // panel exists to catch.
  const rendered = new Set(activeVipers.map((v) => v.strategyName));
  const unmapped = (viperStatus ?? []).filter((r) => !rendered.has(r.strategy));

  // ── Handlers ───────────────────────────────────────────────────────────────
  const handlePatch = useCallback(
    async (patch: Partial<DynamicConfig>) => {
      if (DEMO_MODE) return;
      await patchSquadronConfig(squadron.id, patch);
      await refreshConfig();
    },
    [squadron.id, refreshConfig],
  );

  return (
    <div className="space-y-6">
      <Button variant="ghost" onClick={onBack}>
        <ArrowLeftIcon data-icon="inline-start" />
        Back to CAG overview
      </Button>
      <SectionHeader
        title={squadron.name}
        description={
          <>
            <span className="font-mono">{squadron.asset}</span> squadron · {squadron.state}
          </>
        }
        action={
          squadron.state !== "STOOD_DOWN" ? (
            <Button variant="destructive" onClick={handleStandDown} disabled={standingDown}>
              <AirplaneLandingIcon data-icon="inline-start" />
              {standingDown ? "Standing down…" : "Stand down"}
            </Button>
          ) : undefined
        }
      />
      {standDownError && (
        <Alert variant="destructive">
          <AlertDescription>{standDownError}</AlertDescription>
        </Alert>
      )}
      {confirmDialog}

      {/* ── Squadron + Raptor info ────────────────────────────────────────── */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <SquadronInfoCard squadron={squadron} />
        <RaptorHealthPanel
          raptorKinds={raptorKinds}
          raptors={status?.raptors}
          asset={raptorAsset}
          taxonomy={taxonomy}
        />
      </div>

      {/* ── Helm: the operator's intents on this squadron ─────────────────── */}
      {taxonomy === "helm" && <HelmIntentsPanel squadronId={squadron.id} />}

      {/* ── Performance stats for this squadron/asset ─────────────────────── */}
      {(() => {
        const total = tradeStats?.count ?? 0;
        const wins = tradeStats?.wins ?? 0;
        // Win rate is measured over decided trades only. Exactly-flat trades are
        // neither wins nor losses, and counting them as losses (which dividing by
        // `count` would do) understates the rate.
        const decided = wins + (tradeStats?.losses ?? 0);
        const winRate = decided > 0 ? (wins / decided) * 100 : null;
        const avgPnl = total > 0 ? (tradeStats?.realized_pnl ?? 0) / total : null;
        const since = tradeStats?.first_ts
          ? new Date(tradeStats.first_ts).toLocaleDateString(undefined, {
              month: "short",
              day: "numeric",
            })
          : null;
        return (
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <Card size="sm">
              <CardContent>
                <Stat
                  label="Completed trades"
                  value={statsLoading || !tradeStats ? "—" : String(total)}
                  sub={since ? `all time, since ${since}` : "all time"}
                />
              </CardContent>
            </Card>
            <Card size="sm">
              <CardContent>
                <Stat
                  label="Open positions"
                  value={positionsLoading || !openPositions ? "—" : String(openPositions.length)}
                  sub="active now"
                />
              </CardContent>
            </Card>
            <Card size="sm">
              <CardContent>
                <Stat
                  label="Win rate"
                  value={statsLoading || winRate === null ? "—" : `${winRate.toFixed(0)}%`}
                  tone={winRate === null ? "muted" : winRate >= 50 ? "success" : "warning"}
                  sub={winRate === null ? "no closed trades" : `${wins}/${decided} profitable`}
                />
              </CardContent>
            </Card>
            <Card size="sm">
              <CardContent>
                <Stat
                  label="Avg trade P&L"
                  value={
                    statsLoading || avgPnl === null
                      ? "—"
                      : `${avgPnl >= 0 ? "+" : "−"}$${Math.abs(avgPnl).toFixed(2)}`
                  }
                  tone={signTone(avgPnl)}
                  sub={avgPnl === null ? "no closed trades" : "per closed trade, net of fees"}
                />
              </CardContent>
            </Card>
          </div>
        );
      })()}

      {/* ── Viper Strategies ──────────────────────────────────────────────── */}
      <section>
        <SectionHeader
          className="mb-3"
          title="Viper layer (active strategies)"
          action={<Badge variant="secondary">Squadron-scoped config</Badge>}
        />
        <Alert className="mb-3">
          <AlertDescription>
            <strong>Squadron config:</strong> Changes here only affect this squadron. Vipers shown
            are those linked to the {taxonomy} market class.
          </AlertDescription>
        </Alert>

        {config ? (
          activeVipers.length > 0 ? (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
              {activeVipers.map((v) => (
                <ViperCard
                  key={v.name}
                  viper={v}
                  config={config}
                  onPatch={handlePatch}
                  // Scoped by squadron: both US wings and all three Kalshi
                  // squadrons share the venue-agnostic viper kinds, so a bare
                  // kind returned whichever squadron published last — the header
                  // named one market and the viper cards another.
                  market={status?.strategy_markets[`${squadron.id}:${v.statusKey}`]}
                  status={statusByStrategy.get(v.strategyName)}
                />
              ))}
            </div>
          ) : (
            <Empty>
              <EmptyHeader>
                <EmptyTitle>No vipers linked</EmptyTitle>
                <EmptyDescription>
                  No vipers linked to the {taxonomy} market class.
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          )
        ) : (
          <div
            className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3"
            aria-label="Loading config"
          >
            <Skeleton className="h-64 w-full" />
            <Skeleton className="h-64 w-full" />
            <Skeleton className="h-64 w-full" />
          </div>
        )}

        {/* Settings that apply across the squadron rather than to one viper.
            Rendered here because these read the SQUADRON's config — the same
            values the vipers above read — so a change lands where it is seen. */}
        {config && (
          <div className="mt-3">
            <SquadronSettingsCard config={config} onPatch={handlePatch} />
          </div>
        )}

        {unmapped.length > 0 && (
          <Alert variant="warning" className="mt-3">
            <AlertDescription>
              <span className="font-semibold">Reporting without a card:</span>{" "}
              {unmapped.map((r, i) => {
                const bad = isTroubled(r);
                return (
                  <span key={r.strategy}>
                    {i > 0 && " · "}
                    <span className={bad ? "text-destructive" : ""}>
                      {r.strategy.replace(/Strategy$/, "")}
                    </span>
                    <span className="text-muted-foreground">
                      {" "}
                      (eval {fmtAgo(r.last_eval_secs_ago)})
                    </span>
                  </span>
                );
              })}
            </AlertDescription>
          </Alert>
        )}
      </section>

      {/* ── Open Positions & Trades ───────────────────────────────────────── */}
      <section>
        <SectionHeader
          className="mb-3"
          title={
            <>
              Mission activity (<span className="font-mono">{asset.toUpperCase()}</span>)
            </>
          }
        />
        <OpenPositionsCard
          positions={openPositions ?? []}
          trades={trades ?? []}
          isLoading={positionsLoading || tradesLoading}
          asset={asset}
        />
      </section>
    </div>
  );
}
