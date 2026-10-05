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

import { useState, useCallback } from "react";
import useSWR from "swr";
import type { DynamicConfig, ViperDef, ConfigFieldSchema, FieldType } from "@/lib/types";
import { toDisplay, fromDisplay, fieldUnit, NO_MARKET_LABEL } from "@/lib/types";
import { getConfigSchema, refusalText, type ViperStatusRow } from "@/lib/api";
import { DEMO_MODE } from "@/lib/demo";
import AdvancedConfigModal from "@/components/AdvancedConfigModal";
import { GearIcon, MapPinIcon } from "@phosphor-icons/react";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardAction,
  CardContent,
  CardFooter,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Item } from "@/components/ui/item";
import { Switch } from "@/components/ui/switch";
import { Field, FieldLabel, FieldError } from "@/components/ui/field";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { Skeleton } from "@/components/ui/skeleton";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Stat, StatusDot } from "@/components/shared";

// ── Runtime status helpers ────────────────────────────────────────────────────

/** Duration, e.g. "12m". */
export function fmtDur(secs: number | null | undefined): string {
  if (secs === null || secs === undefined) return "—";
  if (secs < 60) return `${secs}s`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h`;
  return `${Math.floor(secs / 86400)}d`;
}

/** Relative age, e.g. "12m ago". */
export function fmtAgo(secs: number | null | undefined): string {
  if (secs === null || secs === undefined) return "—";
  if (secs < 5) return "just now";
  return `${fmtDur(secs)} ago`;
}

/** Evaluations tick sub-second; nothing for 2 minutes means the loop is wedged. */
export const STALE_EVAL_SECS = 120;

type RuntimeState = "DISABLED" | "PENDING" | "STALE" | "ERROR" | "TIMEOUT" | "WAITING" | "ACTIVE";

/**
 * Is this row a fault the operator should look at?
 *
 * One definition, shared by the CAG-level ribbon and the squadron detail view,
 * so the ribbon's count and the cards' red badges can never disagree.
 *
 * `idle` is NOT trouble. The engine records it every tick a squadron has no
 * market to evaluate against, so the row stays fresh: the loop is alive and
 * deliberately waiting. A loop that has actually wedged stops recording
 * anything, idle included, and ages past `STALE_EVAL_SECS` exactly as before.
 * On a fresh Marketplace instance 2026-09-04 the old derivation counted nine
 * such waiting vipers as "9 stale/error" on a healthy system.
 */
export function isTroubled(status: ViperStatusRow): boolean {
  return (
    status.last_eval_secs_ago > STALE_EVAL_SECS ||
    status.last_outcome === "error" ||
    status.last_outcome === "timeout"
  );
}

/**
 * Collapse config state + the engine's last evaluation into one badge state.
 * `enabled` comes from DynamicConfig; everything else from /api/vipers/status.
 * PENDING means the engine has not evaluated this viper since startup — the
 * registry is in-memory, so it is empty for a few ticks after a restart.
 * WAITING means the squadron holds no market right now; see `isTroubled`.
 */
export function runtimeState(enabled: boolean, status?: ViperStatusRow): RuntimeState {
  if (!enabled) return "DISABLED";
  if (!status) return "PENDING";
  if (status.last_eval_secs_ago > STALE_EVAL_SECS) return "STALE";
  if (status.last_outcome === "error") return "ERROR";
  if (status.last_outcome === "timeout") return "TIMEOUT";
  if (status.last_outcome === "idle") return "WAITING";
  return "ACTIVE";
}

const STATE_BADGE: Record<
  Exclude<RuntimeState, "ACTIVE">,
  { variant: "secondary" | "warning" | "destructive" | "outline"; title: string }
> = {
  DISABLED: { variant: "secondary", title: "Turned off in this squadron’s config" },
  PENDING: {
    variant: "warning",
    title: "Enabled, but the engine has not reported an evaluation yet",
  },
  STALE: {
    variant: "destructive",
    title: `No evaluation in over ${STALE_EVAL_SECS}s — the patrol loop may be wedged`,
  },
  ERROR: { variant: "destructive", title: "Last evaluate_entry returned an error" },
  TIMEOUT: { variant: "warning", title: "Last evaluation exceeded the executor timeout" },
  WAITING: {
    variant: "outline",
    title:
      "The squadron holds no tradeable market right now. The engine is alive and will evaluate again as soon as one opens.",
  },
};

// ── Editable param row ────────────────────────────────────────────────────────

interface ParamRowProps {
  field: ConfigFieldSchema;
  config: DynamicConfig;
  onPatch: (patch: Partial<DynamicConfig>) => Promise<void>;
  disabled: boolean;
}

/// A boolean knob on a viper card.
///
/// `ParamRow` handles numbers and text through `toDisplay`/`fromDisplay`, so
/// bools were filtered out of the card entirely — and because the Advanced modal
/// only shows `advanced: true` fields, an `advanced: false` bool rendered
/// NOWHERE in the Control Tower. `helm_live_enabled`, the switch that arms real
/// Helm orders, was unreachable: the only way to set it was a PATCH by hand. So
/// was `helm_fee_verdict_enforce`, a safety gate. The card's own on/off switch is
/// hardwired to `viper.enableKey`, which is why that one bool had a home and
/// every other one did not.
function BoolRow({ field, config, onPatch, disabled }: ParamRowProps) {
  const cfgKey = field.key as keyof DynamicConfig;
  const value = config[cfgKey] === true;
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const flip = useCallback(async () => {
    if (DEMO_MODE || disabled) return;
    setBusy(true);
    setErr(null);
    try {
      await onPatch({ [cfgKey]: !value } as Partial<DynamicConfig>);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "failed");
    } finally {
      setBusy(false);
    }
  }, [cfgKey, value, onPatch, disabled]);

  return (
    <Field orientation="horizontal" className="py-0.5">
      <Tooltip>
        <TooltipTrigger asChild>
          <FieldLabel htmlFor={field.key} className="truncate">
            {field.label}
          </FieldLabel>
        </TooltipTrigger>
        <TooltipContent className="max-w-80">{field.description}</TooltipContent>
      </Tooltip>
      <Switch
        id={field.key}
        checked={value}
        onCheckedChange={flip}
        disabled={busy || DEMO_MODE || disabled}
      />
      {err && <FieldError>{err}</FieldError>}
    </Field>
  );
}

function ParamRow({ field, config, onPatch, disabled }: ParamRowProps) {
  const type = field.type as FieldType;
  const cfgKey = field.key as keyof DynamicConfig;
  const rawValue = config[cfgKey];
  const initial = toDisplay(type, rawValue as string);
  const [draft, setDraft] = useState(initial);
  const [editMode, setEditMode] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveErr, setSaveErr] = useState<string | null>(null);

  // Reset draft when config prop changes (e.g. after a remote patch)
  const display = editMode ? draft : toDisplay(type, rawValue as string);

  const commit = useCallback(async () => {
    setEditMode(false);
    const stored = fromDisplay(type, draft);
    const prev = fromDisplay(type, toDisplay(type, rawValue as string));
    if (stored === prev) return;
    // Hold the schema's declared range here, the same way the advanced modal
    // and the advisor's proposal validator do. This row used to send whatever
    // was typed, so for a basic field the range was decorative: a lone-leg stop
    // of 90% would have gone straight through. Refuse rather than clamp, so the
    // operator sees the bound instead of a silently different value.
    const n = parseFloat(stored);
    if (!isNaN(n)) {
      const below = field.min != null && n < field.min;
      const above = field.max != null && n > field.max;
      if (below || above) {
        const lo = field.min != null ? toDisplay(type, field.min) : null;
        const hi = field.max != null ? toDisplay(type, field.max) : null;
        setSaveErr(
          `out of range (${[lo != null ? `min ${lo}` : null, hi != null ? `max ${hi}` : null].filter(Boolean).join(", ")})`,
        );
        return;
      }
    }
    setSaving(true);
    setSaveErr(null);
    try {
      await onPatch({ [field.key]: stored } as Partial<DynamicConfig>);
    } catch (e) {
      setSaveErr(refusalText(e));
    } finally {
      setSaving(false);
    }
  }, [draft, field.key, type, rawValue, onPatch]);

  return (
    <Field orientation="horizontal" className="flex-wrap py-1 border-b border-border last:border-0">
      <FieldLabel htmlFor={`param-${field.key}`} className="text-muted-foreground truncate mr-2">
        {field.label}
      </FieldLabel>
      <div className="flex items-center gap-1">
        {editMode ? (
          <Input
            id={`param-${field.key}`}
            aria-label={field.label}
            className="w-20 font-mono tabular-nums"
            value={display}
            autoFocus
            disabled={disabled || saving}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => {
              if (e.key === "Enter") commit();
              if (e.key === "Escape") {
                setEditMode(false);
                setDraft(initial);
              }
            }}
          />
        ) : (
          <Button
            variant="ghost"
            id={`param-${field.key}`}
            aria-label={`Edit ${field.label}`}
            onClick={() => {
              if (!disabled) {
                setDraft(toDisplay(type, rawValue as string));
                setEditMode(true);
              }
            }}
            disabled={disabled || saving}
            className={[
              "text-xs font-mono tabular-nums px-2 py-1 rounded-sm",
              "hover:bg-muted transition-colors text-right w-20",
              disabled ? "text-muted-foreground cursor-default" : "text-foreground cursor-text",
              saving ? "opacity-50" : "",
            ].join(" ")}
          >
            {saving ? "…" : toDisplay(type, rawValue as string)}
          </Button>
        )}
        {fieldUnit(type) && (
          <span className="text-xs text-muted-foreground w-8">{fieldUnit(type)}</span>
        )}
      </div>
      {saveErr && <FieldError className="basis-full text-right">{saveErr}</FieldError>}
    </Field>
  );
}

// ── ViperCard ─────────────────────────────────────────────────────────────────

interface Props {
  viper: ViperDef;
  config: DynamicConfig;
  onPatch: (patch: Partial<DynamicConfig>) => Promise<void>;
  /** Active market name returned by /api/status */
  market?: string;
  /** This viper's row from /api/vipers/status, if the engine has evaluated it. */
  status?: ViperStatusRow;
}

export default function ViperCard({ viper, config, onPatch, market, status }: Props) {
  const [toggling, setToggling] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const enabled = config[viper.enableKey] as boolean;

  // Basic params are derived from the Rust schema registry (single source of
  // truth) — `advanced:false`, non-bool fields for this viper group. Shared SWR
  // key dedupes with the Advanced modal's fetch.
  const { data: schema = [], isLoading: schemaLoading } = useSWR("config-schema", getConfigSchema, {
    revalidateOnFocus: false,
  });
  const basicFields = schema.filter(
    (f) => f.group === viper.name && !f.advanced && f.type !== "bool",
  );
  // Bools too, minus the card's own on/off switch, which is rendered in the
  // header. Without this they appear nowhere in the UI at all.
  const basicBools = schema.filter(
    (f) => f.group === viper.name && !f.advanced && f.type === "bool" && f.key !== viper.enableKey,
  );

  const [toggleErr, setToggleErr] = useState<string | null>(null);
  const handleToggle = async () => {
    if (DEMO_MODE) return;
    setToggling(true);
    setToggleErr(null);
    try {
      await onPatch({ [viper.enableKey]: !enabled } as Partial<DynamicConfig>);
    } catch (e) {
      setToggleErr(refusalText(e));
    } finally {
      setToggling(false);
    }
  };

  return (
    <Card size="sm" className={enabled ? "ring-success/20" : "opacity-60"}>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <StatusDot tone={enabled ? "success" : "muted"} />
          {viper.name}
        </CardTitle>
        <CardAction>
          <Switch
            aria-label={`Enable ${viper.name}`}
            checked={enabled}
            onCheckedChange={handleToggle}
            disabled={toggling || DEMO_MODE}
          />
        </CardAction>
        <CardDescription>{viper.description}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {toggleErr && (
          <Alert variant="destructive">
            <AlertDescription>{toggleErr}</AlertDescription>
          </Alert>
        )}

        {/* Active market */}
        {market && market.length > 0 && (
          <Item
            size="xs"
            variant="muted"
            className="gap-1.5 text-muted-foreground truncate"
            title={market}
          >
            <MapPinIcon className="size-3.5 shrink-0 text-muted-foreground" />
            <span className="truncate">{market}</span>
          </Item>
        )}

        {/* Runtime status — badge, why it is holding, and when it last signalled.
          Deliberately sits directly above the params: the gate that vetoed entry
          ("edge below required") reads next to the knob that would clear it. */}
        <div className="flex flex-col gap-1.5">
          <div className="flex items-center gap-2 flex-wrap">
            {(() => {
              const state = runtimeState(enabled, status);
              const badge =
                state === "ACTIVE"
                  ? { variant: "success" as const, title: "Evaluating normally" }
                  : STATE_BADGE[state];
              return (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Badge variant={badge.variant}>{state}</Badge>
                  </TooltipTrigger>
                  <TooltipContent className="max-w-80">{badge.title}</TooltipContent>
                </Tooltip>
              );
            })()}
            {enabled && status && (
              <span
                className="text-2xs font-mono tabular-nums text-muted-foreground"
                title={status.last_eval_at}
              >
                eval {fmtAgo(status.last_eval_secs_ago)}
              </span>
            )}
          </div>

          {enabled && (
            <>
              <div className="text-2xs  leading-snug">
                {/* An idle row is not held by a gate; it is waiting for a market,
                  and the age is how long the wait has lasted (the engine stamps
                  it once, when the wait began). A few minutes at the top of the
                  hour is routine; a wait that outlives an hour deserves a look. */}
                {status?.last_outcome === "idle" ? (
                  <>
                    <span className="text-muted-foreground">
                      {status.last_reason ?? NO_MARKET_LABEL}
                    </span>
                    <span className="font-mono tabular-nums text-muted-foreground">
                      {" "}
                      · for {fmtDur(status.last_reason_secs_ago)}
                    </span>
                  </>
                ) : (
                  <>
                    <span className="text-muted-foreground">holding: </span>
                    {status?.last_reason ? (
                      <>
                        <span className="text-muted-foreground">{status.last_reason}</span>
                        <span className="font-mono tabular-nums text-muted-foreground">
                          {" "}
                          · {fmtAgo(status.last_reason_secs_ago)}
                        </span>
                      </>
                    ) : (
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <span className="text-muted-foreground" tabIndex={0}>
                            {status ? "no active veto" : "—"}
                          </span>
                        </TooltipTrigger>
                        <TooltipContent className="max-w-80">
                          {status
                            ? "No veto recorded — this viper recently signalled, or reports liveness only."
                            : "Waiting on the engine’s first evaluation."}
                        </TooltipContent>
                      </Tooltip>
                    )}
                  </>
                )}
              </div>
              {/* The viper's standing context, when it keeps one. GBoost: which
                model is serving and what its training pipeline is doing
                (backfill progress, training, the last cycle's decision). */}
              {status?.detail && (
                <div
                  className="text-2xs  leading-snug text-muted-foreground whitespace-pre-wrap wrap-break-word"
                  title={status.detail}
                >
                  <span className="text-muted-foreground">model: </span>
                  <span className="text-muted-foreground">{status.detail}</span>
                </div>
              )}
              {/* The refusal ledger: what has been holding this viper and how
                often, not just what holds it now. Same data the LLM Advisor
                reads, so an operator can check its reasoning against it. */}
              {status && status.refusals && status.refusals.length > 0 && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <div
                      tabIndex={0}
                      className="text-2xs leading-snug text-muted-foreground truncate"
                    >
                      <span>refused: </span>
                      {status.refusals.slice(0, 3).map((t, i) => (
                        <span key={t.reason}>
                          {i > 0 && <span> · </span>}
                          <span className="font-mono tabular-nums text-muted-foreground">
                            {t.count.toLocaleString()}×
                          </span>{" "}
                          <span className="text-muted-foreground">{t.reason}</span>
                        </span>
                      ))}
                    </div>
                  </TooltipTrigger>
                  <TooltipContent className="max-w-96 whitespace-pre-wrap">
                    {status.refusals
                      .map(
                        (t) =>
                          `${t.count.toLocaleString()}× ${t.reason}\n    latest: ${t.last_detail}`,
                      )
                      .join("\n")}
                  </TooltipContent>
                </Tooltip>
              )}
              {/* No row at all ≠ "never signalled" — the registry resets on restart. */}
              <Stat
                label="Last signal"
                value={
                  !status
                    ? "—"
                    : status.last_signal_secs_ago === null
                      ? "none yet"
                      : fmtAgo(status.last_signal_secs_ago)
                }
              />
            </>
          )}
        </div>

        {/* Params */}
        <div className="flex flex-col">
          {basicBools.map((f) => (
            <BoolRow
              key={f.key}
              field={f}
              config={config}
              onPatch={onPatch}
              disabled={!enabled || DEMO_MODE}
            />
          ))}
          {schemaLoading && basicFields.length === 0 && basicBools.length === 0 ? (
            <Skeleton className="h-16 w-full" />
          ) : (
            basicFields.map((f) => (
              <ParamRow
                key={f.key}
                field={f}
                config={config}
                onPatch={onPatch}
                disabled={!enabled || DEMO_MODE}
              />
            ))
          )}
        </div>
      </CardContent>
      <CardFooter>
        <Button variant="ghost" onClick={() => setShowAdvanced(true)}>
          <GearIcon data-icon="inline-start" />
          Advanced config
        </Button>
      </CardFooter>

      {showAdvanced && (
        <AdvancedConfigModal
          viperName={viper.name}
          config={config}
          onPatch={onPatch}
          onClose={() => setShowAdvanced(false)}
          enabled={enabled}
        />
      )}
    </Card>
  );
}
