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

import { useEffect, useState } from "react";
import {
  BroadcastIcon,
  CaretDownIcon,
  ClockIcon,
  CompassIcon,
  CrosshairIcon,
  GearSixIcon,
  GhostIcon,
  LightningIcon,
  ListBulletsIcon,
  RobotIcon,
  SquaresFourIcon,
  TerminalWindowIcon,
  type Icon,
} from "@phosphor-icons/react";
import { Button } from "@/components/ui/button";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { StatusDot, TONE_TEXT, type Tone } from "@/components/shared";
import { cn } from "@/lib/utils";

export type AppView = "main" | "telemetry" | "tradelog" | "helm" | "ai" | "console" | "setup";

export const VIEW_DEFS: { id: AppView; label: string; icon: Icon }[] = [
  { id: "main", label: "Overview", icon: SquaresFourIcon },
  { id: "telemetry", label: "Telemetry", icon: BroadcastIcon },
  { id: "tradelog", label: "Tradelog", icon: ListBulletsIcon },
  // Beside the Tradelog because they answer adjacent questions: the log says
  // what executed, Helm says why it was entered.
  { id: "helm", label: "Helm", icon: CompassIcon },
  { id: "ai", label: "AI Actions", icon: RobotIcon },
  { id: "console", label: "Console", icon: TerminalWindowIcon },
  { id: "setup", label: "Setup", icon: GearSixIcon },
];

function fmtSessionTime(iso: string): string {
  try {
    return new Date(iso).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  } catch {
    return "—";
  }
}

function fmtUptime(iso: string): string {
  const secs = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (!Number.isFinite(secs)) return "—";
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}

/// Reachability of the engine's API — a different axis from GHOST/LIVE.
/// Three states: SWR's `data` is undefined until the first poll resolves, and
/// that means "not asked yet", not "down".
function EngineStatus({ health }: { health?: string }) {
  const state = health === undefined ? "pending" : health === "ok" ? "up" : "down";
  const { label, tone, pulse, title } = (
    {
      up: { label: "Engine up", tone: "success", pulse: false, title: "Engine API reachable" },
      down: {
        label: "Engine down",
        tone: "destructive",
        pulse: false,
        title: "Engine API unreachable",
      },
      pending: {
        label: "Connecting",
        tone: "warning",
        pulse: true,
        title: "Contacting the engine API",
      },
    } as const satisfies Record<
      string,
      { label: string; tone: Tone; pulse: boolean; title: string }
    >
  )[state];

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="flex cursor-default items-center gap-1.5 text-xs" aria-label={label}>
          <StatusDot tone={tone} pulse={pulse} />
          <span className={cn("hidden whitespace-nowrap sm:inline", TONE_TEXT[tone])}>{label}</span>
        </span>
      </TooltipTrigger>
      <TooltipContent>{title}</TooltipContent>
    </Tooltip>
  );
}

function SessionClock({ startedAt }: { startedAt?: string }) {
  // Re-render every minute so the uptime stays current.
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 60_000);
    return () => clearInterval(id);
  }, []);
  if (!startedAt) return null;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="hidden cursor-default items-center gap-1.5 text-xs text-muted-foreground sm:flex">
          <ClockIcon className="size-3.5" />
          <span className="font-mono tabular-nums">{fmtUptime(startedAt)}</span>
        </span>
      </TooltipTrigger>
      <TooltipContent>
        Session started {fmtSessionTime(startedAt)} ({startedAt})
      </TooltipContent>
    </Tooltip>
  );
}

/// The most consequential control on the page. Going LIVE spends real money, so
/// it asks first; going back to GHOST is always safe and happens immediately.
function TradingModeToggle({
  ghost,
  onToggle,
  error,
}: {
  ghost: boolean;
  onToggle: () => void;
  error: string | null;
}) {
  const [confirmLive, setConfirmLive] = useState(false);
  return (
    <>
      {error && <span className="max-w-64 text-xs text-destructive">{error}</span>}
      <Button
        size="sm"
        variant="outline"
        onClick={() => (ghost ? setConfirmLive(true) : onToggle())}
        className={cn(
          "font-mono tracking-wide",
          ghost
            ? "border-warning/40 text-warning hover:bg-warning/10 hover:text-warning"
            : "border-success/40 text-success hover:bg-success/10 hover:text-success",
        )}
        aria-label={ghost ? "Ghost mode — switch to live trading" : "Live — switch to ghost mode"}
      >
        {ghost ? (
          <GhostIcon data-icon="inline-start" />
        ) : (
          <LightningIcon data-icon="inline-start" weight="fill" />
        )}
        {ghost ? "GHOST" : "LIVE"}
      </Button>
      <AlertDialog open={confirmLive} onOpenChange={setConfirmLive}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Switch to live trading?</AlertDialogTitle>
            <AlertDialogDescription>
              Every squadron will place real orders with real funds on the venue. You can switch
              back to ghost mode at any time; positions opened while live stay open.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Stay in ghost mode</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                setConfirmLive(false);
                onToggle();
              }}
            >
              Go live
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

function NavTabs({ active, onChange }: { active: AppView; onChange: (v: AppView) => void }) {
  return (
    <nav aria-label="Main" className="hidden items-center gap-0.5 lg:flex">
      {VIEW_DEFS.map(({ id, label, icon: Icon }) => {
        const selected = id === active;
        return (
          <Button
            key={id}
            size="sm"
            variant="ghost"
            aria-current={selected ? "page" : undefined}
            onClick={() => onChange(id)}
            className={cn(
              "text-muted-foreground",
              selected && "bg-muted text-foreground hover:bg-muted",
            )}
          >
            <Icon data-icon="inline-start" weight={selected ? "fill" : "regular"} />
            {label}
          </Button>
        );
      })}
    </nav>
  );
}

/** Below `lg` the seven tabs don't fit; the same views collapse into a menu. */
function NavMenu({ active, onChange }: { active: AppView; onChange: (v: AppView) => void }) {
  const current = VIEW_DEFS.find((v) => v.id === active) ?? VIEW_DEFS[0];
  const CurrentIcon = current.icon;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild className="lg:hidden">
        <Button size="sm" variant="outline">
          <CurrentIcon data-icon="inline-start" weight="fill" />
          {current.label}
          <CaretDownIcon data-icon="inline-end" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-44">
        {VIEW_DEFS.map(({ id, label, icon: Icon }) => (
          <DropdownMenuItem
            key={id}
            onSelect={() => onChange(id)}
            className={cn(id === active && "text-foreground")}
          >
            <Icon weight={id === active ? "fill" : "regular"} />
            {label}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function AppHeader({
  active,
  onNavigate,
  health,
  sessionStartedAt,
  ghostMode,
  onToggleGhost,
  ghostError,
}: {
  active: AppView;
  onNavigate: (v: AppView) => void;
  health?: string;
  sessionStartedAt?: string;
  /** Undefined while config is loading, or in demo mode: the toggle is hidden. */
  ghostMode?: boolean;
  onToggleGhost: () => void;
  ghostError: string | null;
}) {
  return (
    <header className="sticky top-0 z-40 border-b bg-background/85 backdrop-blur-md">
      <div className="mx-auto flex h-12 max-w-7xl items-center gap-3 px-4 sm:px-6">
        <button
          type="button"
          onClick={() => onNavigate("main")}
          className="flex items-center gap-2 rounded-md pr-1 focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:outline-none"
          aria-label="DRADIS overview"
        >
          <CrosshairIcon className="size-4 text-primary" weight="bold" />
          <span className="font-mono text-sm font-semibold tracking-widest">DRADIS</span>
        </button>
        <span className="h-4 w-px bg-border" aria-hidden />
        <NavTabs active={active} onChange={onNavigate} />
        <NavMenu active={active} onChange={onNavigate} />

        <div className="ml-auto flex items-center gap-3">
          <SessionClock startedAt={sessionStartedAt} />
          <EngineStatus health={health} />
          {ghostMode !== undefined && (
            <TradingModeToggle ghost={ghostMode} onToggle={onToggleGhost} error={ghostError} />
          )}
        </div>
      </div>
    </header>
  );
}
