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

import { useState, useCallback, useEffect, useId } from "react";
import useSWR from "swr";
import type { DynamicConfig, ConfigFieldSchema } from "@/lib/types";
import { getConfigSchema, refusalText } from "@/lib/api";
import { DEMO_MODE } from "@/lib/demo";
import { WarningIcon } from "@phosphor-icons/react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Empty, EmptyDescription, EmptyHeader } from "@/components/ui/empty";
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldError,
  FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";

// ── Advanced config modal ─────────────────────────────────────────────────────
//
// Renders the "rest" of a viper's editable config — every field flagged
// `advanced: true` in the Rust schema registry (GET /api/config/schema) that does
// NOT appear on the ViperCard's Basic panel. Inputs are clamped to the schema's
// min/max and saved per-field through the same generic PATCH path as the Basic
// panel, so non-power users can tune ad-hoc without a footgun.
//
// Values are edited in STORED units (e.g. a 12% stop-loss shows as 0.12) — the
// per-field description clarifies the encoding. Schema is fetched via SWR with a
// shared key, so multiple open cards/modals dedupe to one request.

export interface RowProps {
  field: ConfigFieldSchema;
  config: DynamicConfig;
  onPatch: (patch: Partial<DynamicConfig>) => Promise<void>;
  disabled: boolean;
}

/** Clamp a number to the schema's [min, max] when provided. */
function clamp(n: number, min: number | null, max: number | null): number {
  if (min != null && n < min) return min;
  if (max != null && n > max) return max;
  return n;
}

/// Exported so config groups that belong to no viper — the order-book source,
/// exit accounting — can be rendered with the same clamping, units and patch
/// path rather than a second, divergent editor.
export function AdvancedRow({ field, config, onPatch, disabled }: RowProps) {
  const id = useId();
  const stored = String((config as unknown as Record<string, unknown>)[field.key] ?? "");
  const [draft, setDraft] = useState(stored);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Re-sync local draft when the upstream config changes (e.g. after a save).
  useEffect(() => {
    setDraft(stored);
  }, [stored]);

  const commit = useCallback(async () => {
    if (field.type === "bool") return; // handled by the toggle path
    if (field.type === "string") {
      // Free text passes through verbatim: no clamping, no number parsing.
      // Trimmed, since a trailing space in a series list or a sport key is
      // never intended and would only fail upstream.
      const next = draft.trim();
      if (next === stored) {
        setDraft(next);
        return;
      }
      setSaving(true);
      try {
        await onPatch({ [field.key]: next } as unknown as Partial<DynamicConfig>);
      } catch (e) {
        setError(refusalText(e));
        setDraft(stored);
      } finally {
        setSaving(false);
      }
      return;
    }
    const n = parseFloat(draft);
    if (isNaN(n)) {
      setError("not a number");
      setDraft(stored);
      return;
    }
    // A field may declare where out-of-range input lands. Without it we clamp to the
    // nearest bound, which is right for magnitudes and wrong for modes: on a posture
    // field the nearest bound is not the nearest meaning, and clamping a mistyped 3
    // to 2 would enable the experimental posture rather than fall back to the safe one.
    const outOfRange = (field.min != null && n < field.min) || (field.max != null && n > field.max);
    const fallback = field.clamp_fallback;
    const clamped = outOfRange && fallback != null ? fallback : clamp(n, field.min, field.max);
    const next = String(clamped);
    setError(
      clamped !== n
        ? outOfRange && fallback != null
          ? `out of range: reset to ${clamped}`
          : `clamped to ${clamped}`
        : null,
    );
    if (next === stored) {
      setDraft(next);
      return;
    }
    setSaving(true);
    try {
      // Integer fields (i64 in DynamicConfig) must be sent as JSON numbers —
      // serde rejects "300" (string) for an i64. Decimal fields stay strings
      // to avoid f64 precision drift.
      const isInt = field.type === "int" || field.type === "secs";
      await onPatch({
        [field.key]: isInt ? Math.round(clamped) : next,
      } as unknown as Partial<DynamicConfig>);
    } catch (e) {
      setError(refusalText(e));
      setDraft(stored);
    } finally {
      setSaving(false);
    }
  }, [draft, field, stored, onPatch]);

  const toggleBool = useCallback(async () => {
    const next = stored === "true" ? "false" : "true";
    setSaving(true);
    try {
      await onPatch({ [field.key]: next === "true" } as unknown as Partial<DynamicConfig>);
    } catch (e) {
      setError(refusalText(e));
    } finally {
      setSaving(false);
    }
  }, [field.key, stored, onPatch]);

  const bounds = [
    field.min != null ? `min ${field.min}` : null,
    field.max != null ? `max ${field.max}` : null,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <Field
      orientation="horizontal"
      className="flex-col items-start border-b border-border py-3 last:border-0 sm:flex-row"
      data-invalid={Boolean(error?.startsWith("not saved"))}
    >
      <FieldContent className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <FieldLabel htmlFor={id} className="text-xs">
            {field.label}
          </FieldLabel>
          <Badge variant="secondary" className="text-2xs">
            {field.type}
          </Badge>
        </div>
        <FieldDescription id={`${id}-description`}>{field.description}</FieldDescription>
        {bounds && (
          <p className="font-mono text-2xs tabular-nums text-muted-foreground">{bounds}</p>
        )}
        {error && (
          <FieldError
            className={error.startsWith("not saved") ? "text-destructive" : "text-warning"}
          >
            {error}
          </FieldError>
        )}
      </FieldContent>
      <div className="flex min-w-0 max-w-full items-center gap-2 sm:shrink-0">
        {field.type === "bool" ? (
          <Switch
            id={id}
            checked={stored === "true"}
            onCheckedChange={toggleBool}
            disabled={disabled || saving}
            aria-describedby={`${id}-description`}
          />
        ) : (
          <>
            <Input
              id={id}
              aria-describedby={`${id}-description`}
              type={field.type === "string" ? "text" : "number"}
              className={
                field.type === "string"
                  ? "w-full font-mono text-xs sm:w-64"
                  : "w-28 font-mono tabular-nums"
              }
              value={draft}
              disabled={disabled || saving}
              min={field.min ?? undefined}
              max={field.max ?? undefined}
              step={field.step ?? undefined}
              spellCheck={false}
              onChange={(e) => setDraft(e.target.value)}
              onBlur={commit}
              onKeyDown={(e) => {
                if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                if (e.key === "Escape") {
                  setDraft(stored);
                  setError(null);
                }
              }}
            />
            {field.unit && (
              <span className="shrink-0 text-xs text-muted-foreground">{field.unit}</span>
            )}
          </>
        )}
        {saving && <Spinner className="size-3.5" />}
      </div>
    </Field>
  );
}

interface Props {
  /** Viper display name — must match the schema `group` (e.g. "Arbitrage"). */
  viperName: string;
  config: DynamicConfig;
  onPatch: (patch: Partial<DynamicConfig>) => Promise<void>;
  onClose: () => void;
  enabled: boolean;
}

export default function AdvancedConfigModal({
  viperName,
  config,
  onPatch,
  onClose,
  enabled,
}: Props) {
  const {
    data: schema = [],
    isLoading,
    error,
  } = useSWR("config-schema", getConfigSchema, {
    revalidateOnFocus: false,
  });

  const fields = schema.filter((f) => f.group === viperName && f.advanced);

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      {/* Fields save on blur. Radix dismisses on pointerdown, before the focused
          input would blur, so blur it first: an edit typed and then clicked away
          from is saved, as it was with the old backdrop. */}
      <DialogContent
        className="flex max-h-dvh flex-col sm:max-w-2xl"
        onPointerDownOutside={() => (document.activeElement as HTMLElement | null)?.blur()}
        onEscapeKeyDown={() => (document.activeElement as HTMLElement | null)?.blur()}
      >
        <DialogHeader className="pr-6">
          <DialogTitle>{viperName} — advanced</DialogTitle>
          <DialogDescription>
            Live-edited; clamped to safe ranges. Saves immediately.
          </DialogDescription>
        </DialogHeader>
        <div className="min-h-0 space-y-3 overflow-y-auto">
          {!enabled && (
            <Alert variant="warning">
              <WarningIcon />
              <AlertDescription>
                This viper is disabled — changes are saved but take effect only when enabled.
              </AlertDescription>
            </Alert>
          )}
          {isLoading && (
            <div className="space-y-4 py-3" aria-label="Loading schema" aria-busy="true">
              {[0, 1, 2].map((key) => (
                <div key={key} className="space-y-2">
                  <Skeleton className="h-4 w-32" />
                  <Skeleton className="h-8 w-full" />
                </div>
              ))}
            </div>
          )}
          {error && (
            <Alert variant="destructive">
              <WarningIcon />
              <AlertDescription>Failed to load config schema.</AlertDescription>
            </Alert>
          )}
          {!isLoading && !error && fields.length === 0 && (
            <Empty>
              <EmptyHeader>
                <EmptyDescription>No advanced settings for this viper.</EmptyDescription>
              </EmptyHeader>
            </Empty>
          )}
          {fields.map((f) => (
            <AdvancedRow
              key={f.key}
              field={f}
              config={config}
              onPatch={onPatch}
              disabled={DEMO_MODE}
            />
          ))}
        </div>
        <DialogFooter>
          <Button variant="secondary" onClick={onClose}>
            Done
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
