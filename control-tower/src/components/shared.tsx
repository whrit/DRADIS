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
 * Small app-level building blocks shared by every screen. Primitives (Button,
 * Card, Badge, …) live in `@/components/ui`; these compose them into the
 * patterns the Control Tower repeats.
 */

import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export type Tone = "success" | "warning" | "destructive" | "primary" | "muted";

const DOT_TONE: Record<Tone, string> = {
  success: "bg-success",
  warning: "bg-warning",
  destructive: "bg-destructive",
  primary: "bg-primary",
  muted: "bg-muted-foreground/50",
};

/** Text color class per tone; use for status words and signed figures. */
export const TONE_TEXT: Record<Tone, string> = {
  success: "text-success",
  warning: "text-warning",
  destructive: "text-destructive",
  primary: "text-primary",
  muted: "text-muted-foreground",
};

/** Status indicator dot. `pulse` only for states that are actively changing. */
export function StatusDot({
  tone,
  pulse = false,
  className,
}: {
  tone: Tone;
  pulse?: boolean;
  className?: string;
}) {
  return (
    <span className={cn("relative inline-flex size-2 shrink-0", className)} aria-hidden>
      {pulse && (
        <span
          className={cn("absolute inset-0 animate-ping rounded-full opacity-60", DOT_TONE[tone])}
        />
      )}
      <span className={cn("relative inline-flex size-2 rounded-full", DOT_TONE[tone])} />
    </span>
  );
}

/** Tone of a signed figure: profit, loss, or unknown. */
export function signTone(n: number | null | undefined): Tone {
  if (n === null || n === undefined || Number.isNaN(n)) return "muted";
  return n >= 0 ? "success" : "destructive";
}

/** Heading row above a section: title, optional one-line description, optional action. */
export function SectionHeader({
  title,
  description,
  action,
  className,
}: {
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex items-end justify-between gap-4", className)}>
      <div className="min-w-0">
        <h2 className="text-sm font-medium text-balance">{title}</h2>
        {description && (
          <p className="mt-0.5 text-xs text-pretty text-muted-foreground">{description}</p>
        )}
      </div>
      {action && <div className="flex shrink-0 items-center gap-2">{action}</div>}
    </div>
  );
}

/** Label + value pair for KPI rows and breakdowns. Numbers are tabular. */
export function Stat({
  label,
  value,
  sub,
  tone,
  className,
}: {
  label: ReactNode;
  value: ReactNode;
  sub?: ReactNode;
  tone?: Tone;
  className?: string;
}) {
  return (
    <div className={cn("flex min-w-0 flex-col gap-0.5", className)}>
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className={cn("font-mono text-sm tabular-nums", tone && TONE_TEXT[tone])}>{value}</span>
      {sub && <span className="text-xs text-muted-foreground">{sub}</span>}
    </div>
  );
}
