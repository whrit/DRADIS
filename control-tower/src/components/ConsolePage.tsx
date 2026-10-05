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
 * ConsolePage — live view of the engine's recent log output.
 *
 * Reads GET /api/logs (in-memory ring buffer inside the engine — no Docker
 * socket, no file access) on a short poll. Built for AMI operators without
 * SSH: confirm the engine is alive, watch activity, and copy a snippet to
 * paste into a GitHub Issue.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import useSWR from "swr";
import { getLogs } from "@/lib/api";
import { CheckIcon, CopyIcon } from "@phosphor-icons/react";
import { SectionHeader } from "@/components/shared";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Empty, EmptyDescription } from "@/components/ui/empty";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";

type Level = "all" | "info" | "warn" | "error";

const LEVEL_TESTS: Record<Exclude<Level, "all">, (l: string) => boolean> = {
  info: (l) => l.includes(" INFO "),
  warn: (l) => l.includes(" WARN "),
  error: (l) => l.includes(" ERROR "),
};

function lineColor(l: string): string {
  if (l.includes(" ERROR ")) return "text-destructive";
  if (l.includes(" WARN ")) return "text-warning";
  if (l.includes(" DEBUG ")) return "text-muted-foreground/70";
  return "text-muted-foreground";
}

export default function ConsolePage() {
  const [tail, setTail] = useState(500);
  const [level, setLevel] = useState<Level>("all");
  const [follow, setFollow] = useState(true);
  const [copied, setCopied] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  const { data, error, isLoading } = useSWR(["logs", tail], () => getLogs(tail), {
    refreshInterval: 3_000,
  });

  const lines = useMemo(() => {
    const all = data?.lines ?? [];
    return level === "all" ? all : all.filter(LEVEL_TESTS[level]);
  }, [data, level]);

  // Follow mode: keep the viewport pinned to the newest lines.
  useEffect(() => {
    const viewport = scrollRef.current?.querySelector<HTMLDivElement>(
      '[data-slot="scroll-area-viewport"]',
    );
    if (follow && viewport) {
      viewport.scrollTop = viewport.scrollHeight;
    }
  }, [lines, follow]);

  const copyVisible = async () => {
    try {
      await navigator.clipboard.writeText(lines.join("\n"));
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* clipboard unavailable (http origin) — ignore */
    }
  };

  return (
    <section className="space-y-4">
      <SectionHeader title="Engine console" description="Recent engine logs · refreshes every 3s" />
      <Card size="sm">
        <CardContent className="flex flex-wrap items-center gap-3">
          <span className="text-xs text-muted-foreground">Level</span>
          <ToggleGroup
            type="single"
            variant="outline"
            spacing={0}
            value={level}
            onValueChange={(value) => {
              if (value) setLevel(value as Level);
            }}
            aria-label="Log level"
          >
            {(["all", "info", "warn", "error"] as Level[]).map((value) => (
              <ToggleGroupItem key={value} value={value}>
                {value === "all" ? "All" : value.toUpperCase()}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
          <span className="text-xs text-muted-foreground">Tail</span>
          <ToggleGroup
            type="single"
            variant="outline"
            spacing={0}
            value={String(tail)}
            onValueChange={(value) => {
              if (value) setTail(Number(value));
            }}
            aria-label="Log tail size"
          >
            {[200, 500, 2000].map((n) => (
              <ToggleGroupItem key={n} value={String(n)} className="font-mono tabular-nums">
                {n}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
          <Button
            variant={follow ? "secondary" : "outline"}
            aria-pressed={follow}
            onClick={() => setFollow(!follow)}
          >
            Follow
          </Button>
          <Button variant="outline" className="sm:ml-auto" onClick={copyVisible}>
            {copied ? (
              <CheckIcon data-icon="inline-start" />
            ) : (
              <CopyIcon data-icon="inline-start" />
            )}
            {copied ? "Copied" : "Copy visible"}
          </Button>
        </CardContent>
      </Card>

      {error && (
        <Alert variant="destructive">
          <AlertDescription>
            Engine unreachable: {error instanceof Error ? error.message : String(error)}
          </AlertDescription>
        </Alert>
      )}
      <Card size="sm" className="gap-0 pb-0">
        <CardContent className="flex items-center justify-between gap-3 pb-3">
          <span className="text-xs text-muted-foreground">Recent output</span>
          <span className="font-mono text-xs tabular-nums text-muted-foreground">
            {error
              ? "Engine unreachable"
              : isLoading
                ? "Loading…"
                : `${lines.length} lines · refreshes every 3s`}
          </span>
        </CardContent>
        <ScrollArea
          ref={scrollRef}
          onWheel={() => setFollow(false)}
          className="h-144 border-t border-border bg-background"
        >
          <div className="px-4 py-3">
            {isLoading && lines.length === 0 ? (
              <div className="space-y-2" aria-label="Loading engine logs" aria-busy="true">
                {Array.from({ length: 12 }, (_, i) => (
                  <Skeleton key={i} className="h-3 w-full" />
                ))}
              </div>
            ) : lines.length === 0 ? (
              <Empty>
                <EmptyDescription>
                  No log lines yet — the buffer fills as the engine runs.
                </EmptyDescription>
              </Empty>
            ) : (
              lines.map((line, i) => (
                <div
                  key={i}
                  className={`whitespace-pre-wrap break-all font-mono text-2xs leading-relaxed ${lineColor(line)}`}
                >
                  {line}
                </div>
              ))
            )}
          </div>
        </ScrollArea>
      </Card>
      <p className="text-xs leading-relaxed text-muted-foreground">
        Shows the engine&apos;s most recent in-memory log lines (up to 2,000). Sharing a snippet in
        a GitHub Issue? Use &ldquo;Copy visible&rdquo; with the ERROR filter — and skim it for
        market names or figures you&apos;d rather not post publicly.
      </p>
    </section>
  );
}
