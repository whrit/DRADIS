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

import { useState, useCallback, useEffect } from "react";
import useSWR from "swr";
import type { Icon } from "@phosphor-icons/react";
import {
  FootballIcon,
  FlagIcon,
  CurrencyBtcIcon,
  CompassIcon,
  RocketLaunchIcon,
  GearIcon,
  GlobeIcon,
} from "@phosphor-icons/react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Field, FieldLabel, FieldDescription, FieldSet, FieldLegend } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Button } from "@/components/ui/button";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Item } from "@/components/ui/item";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { Empty, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { Alert, AlertDescription } from "@/components/ui/alert";
import type {
  MarketType,
  DeploymentRegionInfo,
  AvailableMarket,
  RaptorKind,
  ViperKindInfo,
} from "@/lib/types";
import {
  getDeploymentRegion,
  getAvailableMarkets,
  getRaptorsForClass,
  getVipersForClass,
  deploySquadron,
} from "@/lib/api";

// ── Market Type Icons & Labels ────────────────────────────────────────────────

const MARKET_TYPE_CONFIG: Record<MarketType, { icon: Icon; label: string; color: string }> = {
  sports: { icon: FootballIcon, label: "Sports", color: "text-chart-1" },
  politics: { icon: FlagIcon, label: "Politics", color: "text-chart-2" },
  crypto: { icon: CurrencyBtcIcon, label: "Crypto", color: "text-chart-3" },
  // Not offered here: a Helm squadron is created by "Take the Helm", a sibling of this modal.
  helm: { icon: CompassIcon, label: "Helm", color: "text-chart-4" },
};

// ── Market Type Selector ──────────────────────────────────────────────────────

interface MarketTypeSelectorProps {
  available: MarketType[];
  selected: MarketType | null;
  onSelect: (type: MarketType) => void;
}

function MarketTypeSelector({ available, selected, onSelect }: MarketTypeSelectorProps) {
  return (
    <ToggleGroup
      type="single"
      value={selected ?? ""}
      onValueChange={(value) => {
        if (value) onSelect(value as MarketType);
      }}
      variant="outline"
      className="flex-wrap"
    >
      {available.map((type) => {
        const cfg = MARKET_TYPE_CONFIG[type];
        const Icon = cfg.icon;
        return (
          <ToggleGroupItem key={type} value={type}>
            <Icon className={cfg.color} />
            {cfg.label}
          </ToggleGroupItem>
        );
      })}
    </ToggleGroup>
  );
}

// ── Quick Deploy Preview ──────────────────────────────────────────────────────

interface QuickPreviewProps {
  marketType: MarketType;
  raptors: RaptorKind[];
  vipers: ViperKindInfo[];
  loading: boolean;
}

function QuickDeployPreview({ marketType, raptors, vipers, loading }: QuickPreviewProps) {
  const cfg = MARKET_TYPE_CONFIG[marketType];
  const implementedRaptors = raptors.filter((r) => r.implemented);
  if (loading) return <Skeleton className="h-32 w-full" aria-label="Loading configuration" />;
  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle>Auto-selection preview</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-muted-foreground">
          DRADIS will select optimal <span className={cfg.color}>{cfg.label.toLowerCase()}</span>{" "}
          market.
        </p>
        <FieldSet>
          <FieldLegend variant="label">Raptors</FieldLegend>
          <div className="flex flex-wrap gap-1.5">
            {implementedRaptors.length > 0 ? (
              implementedRaptors.map((r) => (
                <Badge
                  key={r.id}
                  variant="outline"
                  className="text-chart-4 border-chart-4/20 bg-chart-4/10"
                >
                  {r.id}
                </Badge>
              ))
            ) : (
              <span className="text-muted-foreground italic">None implemented yet</span>
            )}
          </div>
        </FieldSet>
        <FieldSet>
          <FieldLegend variant="label">Vipers</FieldLegend>
          <div className="flex flex-wrap gap-1.5">
            {vipers.map((v) => (
              <Badge
                key={v.id}
                variant="outline"
                className="text-chart-5 border-chart-5/20 bg-chart-5/10"
              >
                {v.display}
              </Badge>
            ))}
          </div>
        </FieldSet>
      </CardContent>
    </Card>
  );
}

// ── Manual Mode: Market Browser ───────────────────────────────────────────────

export interface MarketBrowserProps {
  markets: AvailableMarket[];
  selected: string | null;
  onSelect: (conditionId: string) => void;
  loading: boolean;
}

/** The market picker. Exported because "Take the Helm" reuses it: both flows
 *  create a squadron on a chosen market, and the browser is the shared part. */
export function MarketBrowser({ markets, selected, onSelect, loading }: MarketBrowserProps) {
  if (loading) return <Skeleton className="h-40 w-full" aria-label="Fetching available markets" />;
  if (markets.length === 0)
    return (
      <Empty>
        <EmptyHeader>
          <EmptyTitle>No markets available for this type</EmptyTitle>
        </EmptyHeader>
      </Empty>
    );
  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle>
          <span className="font-mono tabular-nums">{markets.length}</span> market
          {markets.length === 1 ? "" : "s"} available
        </CardTitle>
      </CardHeader>
      <CardContent className="max-h-60 overflow-y-auto space-y-1">
        {markets.map((market) => {
          const isSelected = selected === market.condition_id;
          const expiresAt = new Date(market.end_date);
          const hoursUntil = Math.max(0, (expiresAt.getTime() - Date.now()) / (1000 * 60 * 60));
          return (
            <Item
              asChild
              size="sm"
              variant={isSelected ? "outline" : "default"}
              key={market.condition_id}
              className={isSelected ? "border-primary bg-primary/10" : "hover:bg-muted"}
            >
              <button
                type="button"
                aria-pressed={isSelected}
                onClick={() => onSelect(market.condition_id)}
                className="text-left"
              >
                <div className="min-w-0 flex-1">
                  <p className="text-xs text-foreground truncate" title={market.question}>
                    {market.question}
                  </p>
                  {/* What is actually being bet on. The question often does not say: "Bitcoin Up or Down on October 3?" names no reference price, because the market compares two timestamps rather than quoting a strike. The criteria name the candle, the exchange and the two times. Shown in full on the selected row, since that is the one the operator is about to commit to. */}
                  {market.criteria && (
                    <p
                      className={`text-xs text-muted-foreground mt-0.5 ${isSelected ? "" : "truncate"}`}
                      title={market.criteria}
                    >
                      {market.criteria}
                    </p>
                  )}
                </div>
                <div className="flex items-center gap-3 shrink-0 font-mono tabular-nums">
                  <span className="text-muted-foreground">
                    {hoursUntil < 1
                      ? `${Math.round(hoursUntil * 60)}m`
                      : hoursUntil < 24
                        ? `${Math.round(hoursUntil)}h`
                        : `${Math.round(hoursUntil / 24)}d`}
                  </span>
                  <span>${market.liquidity.toLocaleString()}</span>
                </div>
              </button>
            </Item>
          );
        })}
      </CardContent>
    </Card>
  );
}

// ── Manual Mode: Raptor/Viper Checkboxes ──────────────────────────────────────

interface ConfigChecklistProps {
  title: string;
  items: { id: string; display: string; implemented?: boolean }[];
  selected: Set<string>;
  onToggle: (id: string) => void;
}

function ConfigChecklist({ title, items, selected, onToggle }: ConfigChecklistProps) {
  return (
    <FieldSet>
      <FieldLegend variant="label">{title}</FieldLegend>
      <div className="space-y-2">
        {items.map((item) => {
          const isDisabled = item.implemented === false;
          const isChecked = selected.has(item.id);
          const id = `deploy-${title}-${item.id}`;
          return (
            <Field key={item.id} orientation="horizontal" data-disabled={isDisabled}>
              <Checkbox
                id={id}
                checked={isChecked}
                disabled={isDisabled}
                onCheckedChange={() => !isDisabled && onToggle(item.id)}
              />
              <FieldLabel htmlFor={id}>{item.display}</FieldLabel>
              {isDisabled && <Badge variant="warning">Roadmap</Badge>}
            </Field>
          );
        })}
      </div>
    </FieldSet>
  );
}

// ── Manual Mode: Per-Viper Capital Budgets ────────────────────────────────────

interface ViperBudgetsProps {
  vipers: { id: string; display: string }[];
  budgets: Record<string, string>;
  onChange: (id: string, value: string) => void;
}

/** USDC max-exposure input per selected viper. Blank = keep squadron default. */
function ViperBudgets({ vipers, budgets, onChange }: ViperBudgetsProps) {
  if (vipers.length === 0) return null;
  return (
    <FieldSet>
      <FieldLegend variant="label">Viper capital budgets</FieldLegend>
      <FieldDescription>USDC max exposure — blank keeps defaults.</FieldDescription>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        {vipers.map((v) => (
          <Field key={v.id}>
            <FieldLabel htmlFor={`budget-${v.id}`}>{v.display}</FieldLabel>
            <Input
              id={`budget-${v.id}`}
              type="number"
              min="0"
              step="1"
              placeholder="default"
              value={budgets[v.id] ?? ""}
              onChange={(e) => onChange(v.id, e.target.value)}
              className="font-mono tabular-nums"
            />
          </Field>
        ))}
      </div>
    </FieldSet>
  );
}

// ── Main Modal ────────────────────────────────────────────────────────────────

interface DeploySquadronModalProps {
  isOpen: boolean;
  onClose: () => void;
  /** Fired on a successful queue-up, with the deployment id and its class. */
  onDeployed?: (deploymentId: string, marketType: string) => void;
}

export default function DeploySquadronModal({
  isOpen,
  onClose,
  onDeployed,
}: DeploySquadronModalProps) {
  // Mode: 'quick' or 'manual'
  const [mode, setMode] = useState<"quick" | "manual">("quick");

  // Selection state
  const [selectedType, setSelectedType] = useState<MarketType | null>(null);
  const [selectedMarket, setSelectedMarket] = useState<string | null>(null);
  const [selectedRaptors, setSelectedRaptors] = useState<Set<string>>(new Set());
  const [selectedVipers, setSelectedVipers] = useState<Set<string>>(new Set());
  const [viperBudgets, setViperBudgets] = useState<Record<string, string>>({});

  // Operator-chosen name. Optional: without one the squadron is named after its
  // class, which is fine until a second squadron of that class exists — then the
  // name is what tells them apart on screen and what gives each its own config
  // and budgets.
  const [name, setName] = useState("");

  // Deployment state
  const [deploying, setDeploying] = useState(false);
  const [confirmed, setConfirmed] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Fetch deployment region
  const { data: regionInfo, isLoading: regionLoading } = useSWR<DeploymentRegionInfo>(
    isOpen ? "deployment-region" : null,
    getDeploymentRegion,
    { revalidateOnFocus: false },
  );

  // Fetch raptors/vipers for selected market type
  const { data: raptors = [], isLoading: raptorsLoading } = useSWR<RaptorKind[]>(
    isOpen && selectedType ? `raptors-${selectedType}` : null,
    () => getRaptorsForClass(selectedType!),
    { revalidateOnFocus: false },
  );

  const { data: vipers = [], isLoading: vipersLoading } = useSWR<ViperKindInfo[]>(
    isOpen && selectedType ? `vipers-${selectedType}` : null,
    () => getVipersForClass(selectedType!),
    { revalidateOnFocus: false },
  );

  // Fetch available markets for manual mode
  const { data: marketsResponse, isLoading: marketsLoading } = useSWR(
    isOpen && mode === "manual" && selectedType ? `markets-${selectedType}` : null,
    () => getAvailableMarkets(selectedType!),
    { revalidateOnFocus: false, revalidateOnMount: true, dedupingInterval: 0 },
  );

  // Auto-select all implemented raptors and all vipers when type changes
  useEffect(() => {
    if (selectedType && raptors.length > 0) {
      setSelectedRaptors(new Set(raptors.filter((r) => r.implemented).map((r) => r.id)));
    }
    if (selectedType && vipers.length > 0) {
      setSelectedVipers(new Set(vipers.map((v) => v.id)));
    }
  }, [selectedType, raptors, vipers]);

  // Clear selected market when type changes
  useEffect(() => {
    setSelectedMarket(null);
  }, [selectedType]);

  // Reset state when modal closes
  useEffect(() => {
    if (!isOpen) {
      setMode("quick");
      setSelectedType(null);
      setSelectedMarket(null);
      setSelectedRaptors(new Set());
      setSelectedVipers(new Set());
      setViperBudgets({});
      setError(null);
    }
  }, [isOpen]);

  // Toggle handlers
  const toggleRaptor = useCallback((id: string) => {
    setSelectedRaptors((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const toggleViper = useCallback((id: string) => {
    setSelectedVipers((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const setViperBudget = useCallback((id: string, value: string) => {
    setViperBudgets((prev) => ({ ...prev, [id]: value }));
  }, []);

  // Deploy handler
  const handleDeploy = useCallback(async () => {
    if (!selectedType) return;

    setDeploying(true);
    setError(null);
    setConfirmed(null);

    // Collect valid budgets for selected vipers only (blank = keep default)
    const budgets: Record<string, number> = {};
    if (mode === "manual") {
      for (const id of selectedVipers) {
        const parsed = parseFloat(viperBudgets[id] ?? "");
        if (Number.isFinite(parsed) && parsed >= 0) budgets[id] = parsed;
      }
    }

    try {
      const response = await deploySquadron({
        mode,
        market_type: selectedType,
        auto_config: mode === "quick",
        market_id: mode === "manual" ? (selectedMarket ?? undefined) : undefined,
        raptors: mode === "manual" ? Array.from(selectedRaptors) : undefined,
        vipers: mode === "manual" ? Array.from(selectedVipers) : undefined,
        viper_budgets: Object.keys(budgets).length > 0 ? budgets : undefined,
        name: name.trim() || undefined,
      });

      if (response.success && response.squadron_id) {
        // Confirm before closing. A deploy is QUEUED, not executed — the engine
        // picks it up on its own poll, so the squadron appears several seconds
        // later. Closing instantly left the operator watching an unchanged list
        // with nothing to say their click had landed, which reads as a dead
        // button even when the deployment succeeded.
        setConfirmed(
          `Queued. ${selectedType} squadron starting — it appears in the CAG registry shortly.`,
        );
        onDeployed?.(response.squadron_id, selectedType);
        setTimeout(onClose, 1800);
      } else {
        setError(response.error || "Deployment failed");
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unknown error");
    } finally {
      setDeploying(false);
    }
    // Every value the callback READS must be listed, or useCallback memoises a
    // closure over the render in which it was created and keeps reading that
    // render's values forever. `name` and `viperBudgets` were missing: a typed
    // squadron name and per-viper capital budgets were captured as their initial
    // empty state and silently dropped from the request — the deploy succeeded,
    // so nothing surfaced the loss.
  }, [
    mode,
    selectedType,
    selectedMarket,
    selectedRaptors,
    selectedVipers,
    name,
    viperBudgets,
    onClose,
    onDeployed,
  ]);

  // Can deploy?
  // Why Deploy is unavailable, or null when it is available.
  //
  // A disabled button with no explanation is indistinguishable from a broken
  // one — the operator clicks it, nothing happens, and there is nothing on
  // screen or in the log to say why. Naming the missing piece costs a line.
  const blockedReason: string | null = !selectedType
    ? "Pick a market type first."
    : mode === "quick"
      ? null
      : !selectedMarket
        ? "Pick a market from the list."
        : selectedVipers.size === 0
          ? "Select at least one viper."
          : null;
  const canDeploy = blockedReason === null;

  if (!isOpen) return null;

  const availableTypes = regionInfo?.available_types ?? [];

  return (
    <Dialog
      open={isOpen}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent
        className="sm:max-w-lg"
        onEscapeKeyDown={(e) => e.preventDefault()}
        onPointerDownOutside={(e) => e.preventDefault()}
      >
        <DialogHeader>
          <DialogTitle>Deploy squadron</DialogTitle>
          <DialogDescription>Choose a market type and deployment configuration.</DialogDescription>
        </DialogHeader>
        <ToggleGroup
          type="single"
          value={mode}
          onValueChange={(value) => {
            if (value) setMode(value as "quick" | "manual");
          }}
          variant="outline"
        >
          <ToggleGroupItem value="quick">
            <RocketLaunchIcon />
            Quick deploy
          </ToggleGroupItem>
          <ToggleGroupItem value="manual">
            <GearIcon />
            Full control
          </ToggleGroupItem>
        </ToggleGroup>
        <div className="max-h-96 overflow-y-auto space-y-4">
          {regionInfo && (
            <p className="flex items-center gap-2 text-xs text-muted-foreground">
              <GlobeIcon className="size-3.5 shrink-0" />
              {regionInfo.region.toUpperCase()} deployment — {availableTypes.join(", ")} markets
            </p>
          )}
          <FieldSet>
            <FieldLegend variant="label">Market type</FieldLegend>
            {regionLoading ? (
              <Skeleton className="h-8 w-full" />
            ) : (
              <MarketTypeSelector
                available={availableTypes}
                selected={selectedType}
                onSelect={setSelectedType}
              />
            )}
          </FieldSet>
          {selectedType &&
            (mode === "quick" ? (
              <QuickDeployPreview
                marketType={selectedType}
                raptors={raptors}
                vipers={vipers}
                loading={raptorsLoading || vipersLoading}
              />
            ) : (
              <>
                <FieldSet>
                  <FieldLegend variant="label">Select market</FieldLegend>
                  <MarketBrowser
                    markets={marketsResponse?.markets ?? []}
                    selected={selectedMarket}
                    onSelect={setSelectedMarket}
                    loading={marketsLoading}
                  />
                </FieldSet>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <ConfigChecklist
                    title="Raptors (signal sources)"
                    items={raptors}
                    selected={selectedRaptors}
                    onToggle={toggleRaptor}
                  />
                  <ConfigChecklist
                    title="Vipers (strategies)"
                    items={vipers.map((v) => ({ id: v.id, display: v.display }))}
                    selected={selectedVipers}
                    onToggle={toggleViper}
                  />
                </div>
                <ViperBudgets
                  vipers={vipers
                    .filter((v) => selectedVipers.has(v.id))
                    .map((v) => ({ id: v.id, display: v.display }))}
                  budgets={viperBudgets}
                  onChange={setViperBudget}
                />
              </>
            ))}
          {error && (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
          {/* Name — optional, but the only thing that tells two squadrons of one class apart once a second exists. Inside the scroll container: when it sat below it the modal grew past the viewport and pushed the Deploy button off-screen, which reads as a dead button. */}
          <Field>
            <FieldLabel htmlFor="squadron-name">Squadron name (optional)</FieldLabel>
            <Input
              id="squadron-name"
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. 15m Scalper"
              maxLength={48}
            />
            <FieldDescription>
              Names a second squadron of this class so it gets its own strategy settings, budgets
              and positions. Leave blank for the default name.
            </FieldDescription>
          </Field>
        </div>
        {confirmed ? (
          <Alert variant="success">
            <AlertDescription>{confirmed}</AlertDescription>
          </Alert>
        ) : blockedReason ? (
          <p className="text-xs text-warning">{blockedReason}</p>
        ) : null}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={handleDeploy} disabled={!canDeploy || deploying}>
            {deploying ? (
              <Spinner data-icon="inline-start" />
            ) : (
              <RocketLaunchIcon data-icon="inline-start" />
            )}
            {deploying ? "Deploying…" : "Deploy squadron"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
