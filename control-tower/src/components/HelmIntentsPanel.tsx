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

// Helm intents: where each stands, what the critique said, what the fee verdict
// was, and — once an intent has resolved — whether the critique named the
// failure mode that happened.
//
// Intents outlive their squadrons. A Helm squadron retires itself the moment
// its intents are all terminal, and the CAG reaps it soon after, so a panel
// that lived only on the squadron page would vanish exactly when the
// thesis-versus-outcome record becomes readable and scorable. With no
// `squadronId` this panel lists every intent on the instance, from the
// `/api/helm/intents` listing, which does not depend on any squadron existing.
// With one, it is that squadron's own view.
//
// It shows no calibration figure. The summary endpoint says how many intents
// have resolved against how many are needed; below that line everything is
// recorded and nothing is displayed.

import { useCallback, useState } from "react";
import useSWR from "swr";
import { CompassIcon, CaretDownIcon, CaretRightIcon } from "@phosphor-icons/react";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Card } from "./ui/card";
import { Checkbox } from "./ui/checkbox";
import { Field, FieldLabel } from "./ui/field";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "./ui/collapsible";
import { Empty, EmptyDescription } from "./ui/empty";
import { Skeleton } from "./ui/skeleton";
import { Alert, AlertDescription } from "./ui/alert";
import { Item, ItemGroup } from "./ui/item";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip";
import { Stat } from "./shared";
import type { HelmIntent } from "@/lib/types";
import {
  acknowledgeHelmIntent,
  cancelHelmIntent,
  getHelmSummary,
  HelmApiError,
  listHelmIntents,
  scoreHelmCritique,
} from "@/lib/api";

const STATUS_VARIANT: Record<
  string,
  "warning" | "default" | "success" | "destructive" | "outline"
> = {
  proposed: "warning",
  acknowledged: "default",
  working: "default",
  filled: "success",
  partial: "success",
  missed: "destructive",
  closed: "outline",
  superseded: "outline",
};

const IN_FLIGHT = new Set(["working", "filled", "partial"]);

/** Nothing more will happen to it. Matches `IntentStatus::is_terminal` in Rust. */
const isTerminal = (status: string) => status === "closed" || status === "superseded";

function IntentRow({
  intent,
  showSquadron,
  onChanged,
}: {
  intent: HelmIntent;
  showSquadron: boolean;
  onChanged: () => void;
}) {
  const [read, setRead] = useState(false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const critiqueUnavailable = intent.critique?.startsWith("unavailable:") ?? false;
  const inFlight = IN_FLIGHT.has(intent.status);
  const terminal = isTerminal(intent.status);

  const run = useCallback(
    async (f: () => Promise<unknown>) => {
      setBusy(true);
      setNote(null);
      try {
        await f();
        onChanged();
      } catch (e) {
        if (e instanceof HelmApiError) {
          setNote(e.violations.length > 0 ? e.violations.join(" · ") : e.message);
        } else {
          setNote(e instanceof Error ? e.message : String(e));
        }
      } finally {
        setBusy(false);
      }
    },
    [onChanged],
  );

  return (
    <Card size="sm" role="listitem" className="px-3 gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2 min-w-0">
          <span className="text-xs font-mono tabular-nums text-foreground">#{intent.id}</span>
          <Badge variant={STATUS_VARIANT[intent.status] ?? "outline"}>{intent.status}</Badge>
          <span className="text-xs text-foreground">{intent.side}</span>
          <span className="font-mono tabular-nums text-xs text-muted-foreground">
            v{intent.current_version}
          </span>
          {intent.ghost && <Badge variant="warning">Ghost</Badge>}
        </div>
        <span className="text-xs tabular-nums text-muted-foreground shrink-0">
          {new Date(intent.created_at).toLocaleString()}
        </span>
      </div>
      {showSquadron && (
        <p className="text-xs text-primary truncate" title={intent.market_name}>
          <span className="font-mono">{intent.squadron_id}</span> · {intent.market_name}
        </p>
      )}
      <div className="grid grid-cols-2 gap-3">
        <Stat label="Stated probability" value={`${(intent.first.confidence * 100).toFixed(0)}%`} />
        <div>
          <p className="text-xs text-muted-foreground">Horizon</p>
          <p className="text-xs">{intent.first.horizon}</p>
        </div>
      </div>
      <Item variant="muted" className="block space-y-1">
        <h4 className="text-xs font-medium">Thesis as first submitted</h4>
        <p className="text-xs whitespace-pre-wrap">{intent.first.thesis}</p>
      </Item>
      <Item variant="muted" className="block space-y-1">
        <h4 className="text-xs font-medium">Wrong if</h4>
        <p className="text-xs whitespace-pre-wrap">{intent.first.falsification}</p>
      </Item>
      {intent.status_detail && (
        <p className="text-xs text-muted-foreground">{intent.status_detail}</p>
      )}
      {intent.fee_verdict && <p className="text-xs text-warning">Fee: {intent.fee_verdict}</p>}
      {/* Open while it can still change a decision: the proposal is being judged, or
          the operator is asked below whether it named what happened. */}
      <Collapsible
        defaultOpen={
          intent.status === "proposed" ||
          (terminal && !intent.critique_outcome && !!intent.critique && !critiqueUnavailable)
        }
      >
        <CollapsibleTrigger asChild>
          <Button variant="ghost" className="w-full justify-between">
            Critique
            <CaretDownIcon data-icon="inline-end" />
          </Button>
        </CollapsibleTrigger>
        <CollapsibleContent className="px-2 pt-2">
          {intent.critique == null ? (
            <Badge variant={intent.critique_requested_at ? "warning" : "outline"}>
              {intent.critique_requested_at ? "Pending…" : "Not requested"}
            </Badge>
          ) : (
            <p
              className={`text-xs whitespace-pre-wrap ${critiqueUnavailable ? "text-muted-foreground" : "text-foreground"}`}
            >
              {intent.critique}
            </p>
          )}
        </CollapsibleContent>
      </Collapsible>
      {note && (
        <Alert variant="destructive">
          <AlertDescription>{note}</AlertDescription>
        </Alert>
      )}
      <div className="flex flex-wrap items-center gap-2">
        {intent.status === "proposed" && (
          <>
            <Field orientation="horizontal" className="w-auto">
              <Checkbox
                id={`helm-read-${intent.id}`}
                checked={read}
                onCheckedChange={(checked) => setRead(checked === true)}
              />
              <FieldLabel htmlFor={`helm-read-${intent.id}`}>Read the critique</FieldLabel>
            </Field>
            <Button
              disabled={busy || !read}
              onClick={() => run(() => acknowledgeHelmIntent(intent.id))}
            >
              Acknowledge and enter
            </Button>
          </>
        )}
        {!terminal && !inFlight && (
          <Button
            variant="destructive"
            disabled={busy}
            onClick={() =>
              run(() => cancelHelmIntent(intent.id, "cancelled from the Control Tower"))
            }
          >
            Cancel
          </Button>
        )}
        {inFlight && (
          <span className="text-xs text-muted-foreground">
            Held: the position leaves by its posture, by RTB, or by settlement; the intent closes
            when it does
          </span>
        )}
        {terminal && !intent.critique_outcome && intent.critique && !critiqueUnavailable && (
          <>
            <span className="text-xs text-muted-foreground">
              Did the critique name what happened?
            </span>
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => run(() => scoreHelmCritique(intent.id, "named_it"))}
            >
              Named it
            </Button>
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => run(() => scoreHelmCritique(intent.id, "missed_it"))}
            >
              Missed it
            </Button>
          </>
        )}
        {terminal && !intent.critique_outcome && (!intent.critique || critiqueUnavailable) && (
          <Button
            variant="outline"
            disabled={busy}
            onClick={() => run(() => scoreHelmCritique(intent.id, "no_critique"))}
          >
            Record: no critique
          </Button>
        )}
        {intent.critique_outcome && (
          <span className="text-xs text-muted-foreground">
            Critique scored: {intent.critique_outcome}
          </span>
        )}
        {intent.close_reason && (
          <span className="text-xs text-muted-foreground">Closed: {intent.close_reason}</span>
        )}
      </div>
    </Card>
  );
}

/**
 * One line on the operating page, and only when money is committed.
 *
 * The full intent list used to sit on the main page, which put a column of
 * mostly-resolved history in the middle of the view used to operate. A live
 * intent is operational — a position held under a posture that can still be
 * revised — so that count belongs here; the record belongs in the Helm view.
 * Renders nothing while flat.
 */
export function HelmLiveLine() {
  const { data: intents } = useSWR(["helm-intents", "*"], () => listHelmIntents(undefined, true), {
    refreshInterval: 10_000,
  });
  const live = intents?.filter((i) => !isTerminal(i.status)) ?? [];
  if (live.length === 0) return null;

  const held = live.filter((i) => i.status === "filled" || i.status === "partial").length;

  return (
    <Card size="sm" className="py-0">
      <a href="#helm" className="flex items-center gap-2 px-3 py-2 text-xs">
        <CompassIcon className="size-4 text-primary" />
        <span className="text-xs tabular-nums text-primary">
          {live.length} Helm intent{live.length === 1 ? "" : "s"} live
          {held > 0 && <span className="text-primary"> · {held} holding a position</span>}
        </span>
        <span className="text-xs text-muted-foreground ml-auto">View the record →</span>
      </a>
    </Card>
  );
}

interface Props {
  /** One squadron's intents; omit for every intent on the instance. */
  squadronId?: string;
  /** With no squadron, hide the whole card while there is nothing to show. */
  hideWhenEmpty?: boolean;
  /**
   * Which half of the lifecycle to show. A live intent is an operation — money
   * is committed on a conviction under a posture that may need revising. A
   * resolved one is a record, read deliberately against what happened. They
   * belong on different screens, so the Helm view asks for each separately.
   * Omit for both, as a squadron's own page wants.
   */
  show?: "live" | "resolved";
  /** Render the rows bare, for a page that supplies its own heading. */
  bare?: boolean;
  /** Shown in place of the stock empty line. */
  emptyText?: string;
}

export default function HelmIntentsPanel({
  squadronId,
  hideWhenEmpty = false,
  show,
  bare = false,
  emptyText,
}: Props) {
  const [expanded, setExpanded] = useState(false);

  // A bare list has no ribbon to expand; everything else that is not scoped to
  // one squadron opens collapsed, being a record rather than something to
  // operate from. A squadron's own intents are the point of its page.
  const collapsible = !squadronId && !bare;
  const open = !collapsible || expanded;

  // SWR defaults: the poll pauses while the tab is hidden (`refreshWhenHidden`
  // is false) and revalidates once on focus, so the list is refreshed within a
  // fetch of the operator coming back rather than left stale.
  //
  // Collapsed, the only thing on screen is the ribbon's count, so it polls at a
  // tenth of the rate rather than pulling every intent on the instance every
  // three seconds for a panel nobody has opened.
  const { data: intents, mutate } = useSWR(
    ["helm-intents", squadronId ?? "*"],
    () => listHelmIntents(squadronId, true),
    { refreshInterval: open ? 3_000 : 30_000 },
  );
  const { data: summary, mutate: mutateSummary } = useSWR("helm-summary", getHelmSummary, {
    refreshInterval: open ? 10_000 : 60_000,
  });
  const refresh = useCallback(() => {
    mutate();
    mutateSummary();
  }, [mutate, mutateSummary]);

  // Same definition of terminal as `IntentRow` uses.
  const shown = !intents
    ? undefined
    : intents.filter((i) =>
        show === "live" ? !isTerminal(i.status) : show === "resolved" ? isTerminal(i.status) : true,
      );

  if (hideWhenEmpty && !squadronId && shown && shown.length === 0) return null;

  const title = squadronId ? "Helm intents" : "Helm — all intents";

  // Live ones called out in the ribbon: that is the number worth seeing closed.
  const live = intents?.filter((i) => !isTerminal(i.status)).length ?? 0;

  if (bare) {
    return (
      <ItemGroup>
        {!shown && <Skeleton className="h-32 w-full" aria-label="Loading Helm intents" />}
        {shown && shown.length === 0 && (
          <Empty>
            <EmptyDescription>{emptyText ?? "Nothing here yet."}</EmptyDescription>
          </Empty>
        )}
        {shown?.map((i) => (
          <IntentRow key={i.id} intent={i} showSquadron={!squadronId} onChanged={refresh} />
        ))}
      </ItemGroup>
    );
  }

  return (
    <Card size="sm" className="px-4 gap-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className={collapsible ? "min-w-0 flex-1" : ""}>
          {collapsible ? (
            <Button
              variant="outline"
              type="button"
              onClick={() => setExpanded((e) => !e)}
              aria-expanded={expanded}
              className="flex items-center gap-2 text-left w-full group"
            >
              <span className="text-xs text-primary w-3 shrink-0">
                {expanded ? <CaretDownIcon /> : <CaretRightIcon />}
              </span>
              <span className="text-sm font-medium text-foreground">{title}</span>
              <span className="text-xs tabular-nums text-muted-foreground">
                {intents ? `${intents.length} total` : "…"}
                {live > 0 && <span className="text-primary"> · {live} live</span>}
              </span>
            </Button>
          ) : (
            <h3 className="text-sm font-medium text-foreground">{title}</h3>
          )}
          {!squadronId && expanded && (
            <p className="text-xs text-muted-foreground mt-1 ml-5">
              Every intent on this instance, whether or not its squadron still exists. Intents
              outlive their squadrons: the record and the critique scoring live here.
            </p>
          )}
        </div>
        {summary && open && (
          <Tooltip>
            <TooltipTrigger asChild>
              <span tabIndex={0} className="text-xs text-muted-foreground tabular-nums">
                {summary.resolved} resolved of {summary.calibration_min_resolved} needed before any
                calibration is shown
              </span>
            </TooltipTrigger>
            <TooltipContent>
              Everything is recorded; a calibration figure is shown only once enough intents have
              resolved.
            </TooltipContent>
          </Tooltip>
        )}
      </div>
      {open && !shown && <Skeleton className="h-32 w-full" aria-label="Loading Helm intents" />}
      {open && shown && shown.length === 0 && (
        <Empty>
          <EmptyDescription>
            {emptyText ??
              (squadronId
                ? 'No intent yet. The viper reports "awaiting operator intent" until one is acknowledged.'
                : 'No Helm intents yet. "Take the Helm" above creates one.')}
          </EmptyDescription>
        </Empty>
      )}
      {open && (
        <ItemGroup>
          {shown?.map((i) => (
            <IntentRow key={i.id} intent={i} showSquadron={!squadronId} onChanged={refresh} />
          ))}
        </ItemGroup>
      )}
    </Card>
  );
}
