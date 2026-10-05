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

// "Take the Helm": the operator enters a position the vipers' gates would never
// produce, states a falsifiable reason for it, and the engine holds the exit.
//
// A sibling of Deploy Squadron, not a mode inside it: both create a squadron,
// and the market browser is the shared part. The flow is four steps —
//
//   1. pick a market and deploy a Helm squadron onto it (class `helm`, one
//      viper, no Raptors, whatever the venue files the market under);
//   2. the conviction form: thesis, probability, horizon, "what would make me
//      wrong", and the exit posture as explicit fields — never parsed from the
//      prose;
//   3. the deterministic validator blocks with every failing rule named; the
//      fee verdict and the LLM critique are shown; the critique advises and
//      cannot block or delay past its timeout;
//   4. the operator confirms having read it and acknowledges. The engine
//      enters on the next tick and enforces the posture from then on.

import { useCallback, useEffect, useRef, useState } from "react";
import type { AvailableMarket, HelmIntentDetail, MarketType } from "@/lib/types";
import {
  acknowledgeHelmIntent,
  createHelmIntent,
  deploySquadron,
  getAvailableMarkets,
  getDeployments,
  getHelmIntent,
  HelmApiError,
} from "@/lib/api";
import { MarketBrowser } from "./DeploySquadronModal";
import { CoinsIcon, FootballIcon, CheckSquareIcon, CompassIcon } from "@phosphor-icons/react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "./ui/dialog";
import { Button } from "./ui/button";
import { Card } from "./ui/card";
import { Alert, AlertDescription } from "./ui/alert";
import { Field, FieldLabel, FieldDescription, FieldError } from "./ui/field";
import { Input } from "./ui/input";
import { Textarea } from "./ui/textarea";
import { Checkbox } from "./ui/checkbox";
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from "./ui/select";
import { ToggleGroup, ToggleGroupItem } from "./ui/toggle-group";
import { Spinner } from "./ui/spinner";

type Step = "market" | "deploying" | "form" | "critique" | "done";

const BROWSABLE = [
  { type: "crypto" as const, icon: CoinsIcon, label: "Crypto" },
  { type: "sports" as const, icon: FootballIcon, label: "Sports" },
  { type: "politics" as const, icon: CheckSquareIcon, label: "Politics" },
];

/** How long to wait for the queued deploy to become a live squadron. A deploy
 *  is queued and claimed within seconds; a minute without the row reporting
 *  its squadron means the modal has lost the thread, not that the squadron
 *  failed — it may well be patrolling. The message says where to look. */
const DEPLOY_WAIT_MS = 60_000;
/** How long the form waits on the critique before offering to proceed
 *  without it. The server's own timeout records `unavailable`; this only
 *  decides when the button appears. */
const CRITIQUE_WAIT_MS = 45_000;

interface Props {
  isOpen: boolean;
  onClose: () => void;
  /** Called once an intent is acknowledged, with the squadron it lives on. */
  onDone?: (squadronId: string) => void;
}

interface FormState {
  side: "YES" | "NO";
  thesis: string;
  confidence: string;
  horizon: "expiry" | "sooner";
  falsification: string;
  entry_kind: "taker" | "resting";
  entry_limit_price: string;
  size_usdc: string;
  stop_price: string;
  take_profit_price: string;
  time_limit_at: string;
  hold_to_settlement: boolean;
  catastrophic_floor_pct: string;
}

const EMPTY_FORM: FormState = {
  side: "YES",
  thesis: "",
  confidence: "0.65",
  horizon: "expiry",
  falsification: "",
  entry_kind: "taker",
  entry_limit_price: "",
  size_usdc: "4",
  stop_price: "",
  take_profit_price: "",
  time_limit_at: "",
  hold_to_settlement: false,
  catastrophic_floor_pct: "",
};

const inputCls = "w-full font-mono tabular-nums";

function orNull(s: string): string | null {
  const t = s.trim();
  return t === "" ? null : t;
}

/** A `datetime-local` value to RFC 3339 in UTC, or null when blank. */
function toRfc3339(local: string): string | null {
  if (!local.trim()) return null;
  const d = new Date(local);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

export default function TakeTheHelmModal({ isOpen, onClose, onDone }: Props) {
  const [step, setStep] = useState<Step>("market");

  // Step 1: market and squadron.
  const [browseType, setBrowseType] = useState<MarketType>("crypto");
  const [markets, setMarkets] = useState<AvailableMarket[]>([]);
  const [loadingMarkets, setLoadingMarkets] = useState(false);
  const [selectedMarket, setSelectedMarket] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [squadronId, setSquadronId] = useState<string | null>(null);

  // Step 2: the form.
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [violations, setViolations] = useState<string[]>([]);

  // Step 3: critique and acknowledgement.
  const [detail, setDetail] = useState<HelmIntentDetail | null>(null);
  const [critiqueWaitedOut, setCritiqueWaitedOut] = useState(false);
  const [readCritique, setReadCritique] = useState(false);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const timers = useRef<number[]>([]);

  const clearTimers = () => {
    for (const t of timers.current) window.clearTimeout(t);
    timers.current = [];
  };

  // Reset on open so a second use starts clean.
  useEffect(() => {
    if (!isOpen) return;
    setStep("market");
    setSelectedMarket(null);
    setName("");
    setSquadronId(null);
    setForm(EMPTY_FORM);
    setViolations([]);
    setDetail(null);
    setCritiqueWaitedOut(false);
    setReadCritique(false);
    setBusy(false);
    setError(null);
    return clearTimers;
  }, [isOpen]);

  // Browse markets for the chosen type.
  useEffect(() => {
    if (!isOpen || step !== "market") return;
    let cancelled = false;
    setLoadingMarkets(true);
    setMarkets([]);
    setSelectedMarket(null);
    getAvailableMarkets(browseType, { expiryWindow: browseType === "crypto" ? "4h" : undefined })
      .then((r) => {
        if (!cancelled) setMarkets(r.markets);
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (!cancelled) setLoadingMarkets(false);
      });
    return () => {
      cancelled = true;
    };
  }, [isOpen, step, browseType]);

  const selected = markets.find((m) => m.condition_id === selectedMarket) ?? null;

  // ── Step 1 → 2: deploy and wait for the squadron id ───────────────────────
  const deploy = useCallback(async () => {
    if (!selectedMarket) return;
    setBusy(true);
    setError(null);
    try {
      const res = await deploySquadron({
        mode: "manual",
        market_type: "helm",
        market_id: selectedMarket,
        raptors: [],
        vipers: ["helm"],
        name: name.trim() || undefined,
      });
      if (!res.success || !res.squadron_id) {
        setError(res.error || "Deployment refused");
        setBusy(false);
        return;
      }
      const deploymentId = res.squadron_id;
      setStep("deploying");
      const startedAt = Date.now();
      const poll = async () => {
        try {
          const rows = await getDeployments();
          const row = rows.find((d) => d.id === deploymentId);
          if (row?.status === "failed") {
            setError(row.error || "Deployment failed");
            setStep("market");
            setBusy(false);
            return;
          }
          if (row?.status === "active" && row.squadron_id) {
            setSquadronId(row.squadron_id);
            setStep("form");
            setBusy(false);
            return;
          }
        } catch {
          // A failed poll is retried; the engine's queue is the truth.
        }
        if (Date.now() - startedAt > DEPLOY_WAIT_MS) {
          setError(
            `No squadron id reported for deployment ${deploymentId} within 60 s. The squadron may already be up: ` +
              "look for a helm-open-… entry in the CAG list and give it an intent from its page. If the deployment " +
              "shows failed in Deployments, the reason is on that row.",
          );
          setStep("market");
          setBusy(false);
          return;
        }
        timers.current.push(window.setTimeout(poll, 2000));
      };
      timers.current.push(window.setTimeout(poll, 1500));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  }, [selectedMarket, name]);

  // ── Step 2 → 3: submit the conviction ─────────────────────────────────────
  const submit = useCallback(async () => {
    if (!squadronId) return;
    setBusy(true);
    setError(null);
    setViolations([]);
    const confidence = Number.parseFloat(form.confidence);
    try {
      const intent = await createHelmIntent({
        squadron_id: squadronId,
        side: form.side,
        thesis: form.thesis,
        confidence: Number.isFinite(confidence) ? confidence : -1,
        horizon: form.horizon,
        falsification: form.falsification,
        entry_kind: form.entry_kind,
        entry_limit_price: form.entry_kind === "resting" ? orNull(form.entry_limit_price) : null,
        size_usdc: form.size_usdc.trim(),
        stop_price: orNull(form.stop_price),
        take_profit_price: orNull(form.take_profit_price),
        time_limit_at: toRfc3339(form.time_limit_at),
        hold_to_settlement: form.hold_to_settlement,
        catastrophic_floor_pct: orNull(form.catastrophic_floor_pct),
      });
      setStep("critique");
      setCritiqueWaitedOut(false);
      // Poll the intent until the critique answers (text or unavailable).
      const startedAt = Date.now();
      const poll = async () => {
        try {
          const d = await getHelmIntent(intent.id);
          setDetail(d);
          if (d.intent.critique != null) {
            setBusy(false);
            return;
          }
        } catch {
          // Retry on the next tick.
        }
        if (Date.now() - startedAt > CRITIQUE_WAIT_MS) {
          setCritiqueWaitedOut(true);
          setBusy(false);
          return;
        }
        timers.current.push(window.setTimeout(poll, 1500));
      };
      poll();
    } catch (e) {
      if (e instanceof HelmApiError) {
        setViolations(e.violations.length > 0 ? e.violations : [e.message]);
      } else {
        setError(e instanceof Error ? e.message : String(e));
      }
      setBusy(false);
    }
  }, [squadronId, form]);

  // ── Step 3 → 4: acknowledge ───────────────────────────────────────────────
  const acknowledge = useCallback(async () => {
    if (!detail) return;
    setBusy(true);
    setError(null);
    setViolations([]);
    try {
      const d = await acknowledgeHelmIntent(detail.intent.id);
      setDetail(d);
      setStep("done");
      onDone?.(d.intent.squadron_id);
    } catch (e) {
      if (e instanceof HelmApiError) {
        if (e.status === 409 && e.retryAfterSecs) {
          setError(`${e.message} — retrying in ${e.retryAfterSecs}s`);
          timers.current.push(window.setTimeout(acknowledge, e.retryAfterSecs * 1000));
          return;
        }
        setViolations(e.violations.length > 0 ? e.violations : [e.message]);
      } else {
        setError(e instanceof Error ? e.message : String(e));
      }
    } finally {
      setBusy(false);
    }
  }, [detail, onDone]);

  if (!isOpen) return null;

  const set = <K extends keyof FormState>(k: K, v: FormState[K]) =>
    setForm((f) => ({ ...f, [k]: v }));
  const critique = detail?.intent.critique ?? null;
  const critiqueUnavailable = critique?.startsWith("unavailable:") ?? false;
  const canAcknowledge = !busy && readCritique && (critique != null || critiqueWaitedOut);

  return (
    <Dialog
      open={isOpen}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent
        className="sm:max-w-2xl max-h-full overflow-hidden flex flex-col"
        onEscapeKeyDown={(event) => event.preventDefault()}
        onPointerDownOutside={(event) => event.preventDefault()}
        onInteractOutside={(event) => event.preventDefault()}
      >
        <DialogHeader className="pr-8">
          <DialogTitle className="flex items-center gap-2">
            <CompassIcon className="size-4 text-primary" />
            Take the helm
          </DialogTitle>
          <DialogDescription>
            {step === "market" && "1 · Market"}
            {step === "deploying" && "1 · Deploying"}
            {step === "form" && "2 · Conviction"}
            {step === "critique" && "3 · Critique and acknowledgement"}
            {step === "done" && "4 · Entered"}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4 overflow-y-auto min-h-0">
          {error && (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}

          {/* ── Step 1: market ─────────────────────────────────────────────── */}
          {(step === "market" || step === "deploying") && (
            <>
              <p className="text-xs text-muted-foreground">
                Pick the market. The squadron you deploy carries one viper, Helm, and no Raptors —
                whatever the venue files the market under, it resolves to class{" "}
                <span className="text-primary">helm</span>. The posture you state next is the whole
                exit plan.
              </p>
              <ToggleGroup
                type="single"
                value={browseType}
                onValueChange={(value) => {
                  if (value) setBrowseType(value as MarketType);
                }}
                variant="outline"
                className="w-full"
              >
                {BROWSABLE.map((b) => (
                  <ToggleGroupItem
                    key={b.type}
                    value={b.type}
                    disabled={step === "deploying"}
                    className="flex-1"
                  >
                    <b.icon />
                    {b.label}
                  </ToggleGroupItem>
                ))}
              </ToggleGroup>
              <MarketBrowser
                markets={markets}
                selected={selectedMarket}
                onSelect={setSelectedMarket}
                loading={loadingMarkets}
              />
              {selected && (
                <Card size="sm" className="px-3 gap-1 text-xs text-muted-foreground">
                  <p>
                    DRADIS files this market as{" "}
                    <span className="text-foreground">{selected.market_class}</span>; a{" "}
                    {selected.market_class} squadron would carry that class&apos;s Raptors and
                    vipers.
                  </p>
                  <p>
                    Deployed as Helm it resolves to class <span className="text-primary">helm</span>{" "}
                    — one viper, no Raptors. Closes {new Date(selected.end_date).toLocaleString()}.
                  </p>
                </Card>
              )}
              <Field>
                <FieldLabel htmlFor="helm-name">Squadron name (optional)</FieldLabel>
                <Input
                  id="helm-name"
                  className={inputCls}
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="e.g. btc-3pm-fade"
                  disabled={step === "deploying"}
                />
              </Field>
              <Button
                onClick={deploy}
                disabled={!selectedMarket || busy || step === "deploying"}
                className="w-full"
              >
                {step === "deploying" ? "Deploying the Helm squadron…" : "Deploy Helm squadron"}
              </Button>
            </>
          )}

          {/* ── Step 2: conviction form ────────────────────────────────────── */}
          {step === "form" && squadronId && (
            <>
              <p className="text-xs text-muted-foreground">
                Squadron <span className="font-mono text-primary">{squadronId}</span> is patrolling.
                State the conviction. The exit posture below is what the engine enforces; the prose
                is kept beside it and is never parsed.
              </p>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <Field>
                  <FieldLabel htmlFor="helm-side">Side</FieldLabel>
                  <Select
                    value={form.side}
                    onValueChange={(value) => set("side", value as "YES" | "NO")}
                  >
                    <SelectTrigger id="helm-side" className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {" "}
                      <SelectItem value="YES">YES</SelectItem>
                      <SelectItem value="NO">NO</SelectItem>
                    </SelectContent>
                  </Select>
                </Field>
                <Field>
                  <FieldLabel htmlFor="helm-confidence">
                    Confidence (probability, strictly inside 0–1)
                  </FieldLabel>
                  <Input
                    id="helm-confidence"
                    className={inputCls}
                    type="number"
                    min="0.01"
                    max="0.99"
                    step="0.01"
                    value={form.confidence}
                    onChange={(e) => set("confidence", e.target.value)}
                  />
                </Field>
              </div>
              <Field>
                <FieldLabel htmlFor="helm-thesis">Thesis — what you believe and why</FieldLabel>
                <Textarea
                  id="helm-thesis"
                  className="h-20"
                  value={form.thesis}
                  onChange={(e) => set("thesis", e.target.value)}
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="helm-falsification">What would make me wrong</FieldLabel>
                <Textarea
                  id="helm-falsification"
                  className="h-16"
                  value={form.falsification}
                  onChange={(e) => set("falsification", e.target.value)}
                  placeholder="The observable condition that would show the thesis wrong"
                />
              </Field>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <Field>
                  <FieldLabel htmlFor="helm-horizon">Horizon</FieldLabel>
                  <Select
                    value={form.horizon}
                    onValueChange={(value) => set("horizon", value as "expiry" | "sooner")}
                  >
                    <SelectTrigger id="helm-horizon" className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {" "}
                      <SelectItem value="expiry">Ride to expiry</SelectItem>
                      <SelectItem value="sooner">Expect to exit sooner</SelectItem>
                    </SelectContent>
                  </Select>
                </Field>
                <Field>
                  <FieldLabel htmlFor="helm-entry_kind">Entry</FieldLabel>
                  <Select
                    value={form.entry_kind}
                    onValueChange={(value) => set("entry_kind", value as "taker" | "resting")}
                  >
                    <SelectTrigger id="helm-entry_kind" className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {" "}
                      <SelectItem value="taker">Taker (buy the ask now)</SelectItem>
                      <SelectItem value="resting">Resting bid (post-only)</SelectItem>
                    </SelectContent>
                  </Select>
                </Field>
                <Field>
                  <FieldLabel htmlFor="helm-size_usdc">Size (USDC)</FieldLabel>
                  <Input
                    id="helm-size_usdc"
                    className={inputCls}
                    value={form.size_usdc}
                    onChange={(e) => set("size_usdc", e.target.value)}
                  />
                </Field>
              </div>
              {form.entry_kind === "resting" && (
                <Field>
                  <FieldLabel htmlFor="helm-entry_limit_price">
                    Resting bid price (below the ask)
                  </FieldLabel>
                  <Input
                    id="helm-entry_limit_price"
                    className={inputCls}
                    value={form.entry_limit_price}
                    onChange={(e) => set("entry_limit_price", e.target.value)}
                    placeholder="0.40"
                  />
                </Field>
              )}
              <Card size="sm" className="px-3 gap-3">
                <p className="text-xs text-primary">
                  Exit posture — the engine enforces exactly this
                </p>
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                  <Field>
                    <FieldLabel htmlFor="helm-stop_price">Stop price</FieldLabel>
                    <Input
                      id="helm-stop_price"
                      className={inputCls}
                      value={form.stop_price}
                      onChange={(e) => set("stop_price", e.target.value)}
                      placeholder="below the bid"
                      disabled={form.hold_to_settlement}
                    />
                  </Field>
                  <Field>
                    <FieldLabel htmlFor="helm-take_profit_price">Take-profit price</FieldLabel>
                    <Input
                      id="helm-take_profit_price"
                      className={inputCls}
                      value={form.take_profit_price}
                      onChange={(e) => set("take_profit_price", e.target.value)}
                      placeholder="above the ask"
                    />
                  </Field>
                  <Field>
                    <FieldLabel htmlFor="helm-catastrophic_floor_pct">
                      Catastrophic floor (fraction of entry)
                    </FieldLabel>
                    <Input
                      id="helm-catastrophic_floor_pct"
                      className={inputCls}
                      value={form.catastrophic_floor_pct}
                      onChange={(e) => set("catastrophic_floor_pct", e.target.value)}
                      placeholder="0.50"
                    />
                  </Field>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 items-end">
                  <Field>
                    <FieldLabel htmlFor="helm-time_limit_at">
                      Time limit (before the market&apos;s close)
                    </FieldLabel>
                    <Input
                      id="helm-time_limit_at"
                      className={inputCls}
                      type="datetime-local"
                      value={form.time_limit_at}
                      onChange={(e) => set("time_limit_at", e.target.value)}
                    />
                  </Field>
                  <Field orientation="horizontal">
                    <Checkbox
                      id="helm-hold"
                      checked={form.hold_to_settlement}
                      onCheckedChange={(value) => {
                        const checked = value === true;
                        set("hold_to_settlement", checked);
                        if (checked) set("stop_price", "");
                      }}
                    />
                    <FieldLabel htmlFor="helm-hold">
                      Hold to settlement (no price stop; the floor is the insurance)
                    </FieldLabel>
                  </Field>
                </div>
                <FieldDescription>
                  A posture must name an exit: a stop, a take-profit, a time limit, or hold to
                  settlement. The validator checks each against the live book and names every rule
                  it fails.
                </FieldDescription>
              </Card>
              {violations.length > 0 && (
                <Alert variant="warning">
                  <AlertDescription>
                    <p className="text-xs text-warning mb-1">Refused — fix each of these</p>
                    <FieldError errors={violations.map((message) => ({ message }))} />
                  </AlertDescription>
                </Alert>
              )}
              <Button onClick={submit} disabled={busy} className="w-full">
                {busy && <Spinner data-icon="inline-start" />}
                {busy ? "Submitting…" : "Submit conviction"}
              </Button>
            </>
          )}

          {/* ── Step 3: critique and acknowledgement ───────────────────────── */}
          {step === "critique" && detail && (
            <>
              <Card size="sm" className="px-3 gap-1 text-xs tabular-nums">
                <p>
                  Intent <span className="font-mono text-primary">#{detail.intent.id}</span> on{" "}
                  {detail.intent.market_name} — {detail.intent.side}, confidence{" "}
                  {(detail.intent.first.confidence * 100).toFixed(0)}%, status{" "}
                  {detail.intent.status}
                  {detail.intent.ghost ? " (ghost)" : ""}.
                </p>
                <p className="text-muted-foreground">
                  Stored as first written. Any edit after reading the critique is a new version; the
                  first never changes.
                </p>
              </Card>
              <Alert variant="warning">
                <AlertDescription>
                  <p className="text-sm font-medium text-warning mb-1">Fee verdict</p>
                  <p className="text-xs text-warning">{detail.intent.fee_verdict ?? "—"}</p>
                </AlertDescription>
              </Alert>
              <Card size="sm" className="px-3 gap-2">
                <p className="text-sm font-medium mb-1">
                  Critique{" "}
                  {detail.intent.critique_model && !critiqueUnavailable
                    ? `· ${detail.intent.critique_model}`
                    : ""}
                </p>
                {critique == null && !critiqueWaitedOut && (
                  <p className="text-xs text-muted-foreground animate-pulse">
                    Reading your reasoning… (it sees the thesis, the probability, the horizon, the
                    falsification, the market name and the current price — nothing else)
                  </p>
                )}
                {critique == null && critiqueWaitedOut && (
                  <p className="text-xs text-muted-foreground">
                    No critique arrived in time. Acknowledging records it as unavailable; the trade
                    proceeds either way.
                  </p>
                )}
                {critique != null && (
                  <p
                    className={`text-xs whitespace-pre-wrap ${critiqueUnavailable ? "text-muted-foreground" : "text-foreground"}`}
                  >
                    {critique}
                  </p>
                )}
              </Card>
              {violations.length > 0 && (
                <Alert variant="warning">
                  <AlertDescription>
                    <p className="text-xs text-warning mb-1">Not acknowledged</p>
                    <FieldError errors={violations.map((message) => ({ message }))} />
                    <p className="text-xs text-muted-foreground mt-1">
                      Revise the intent from the squadron page, then acknowledge there.
                    </p>
                  </AlertDescription>
                </Alert>
              )}
              <Field orientation="horizontal">
                <Checkbox
                  id="helm-read"
                  checked={readCritique}
                  onCheckedChange={(value) => setReadCritique(value === true)}
                />
                <FieldLabel htmlFor="helm-read">
                  I have read the critique and the fee verdict. The engine will enter on the next
                  tick and enforce the posture above.
                </FieldLabel>
              </Field>
              <Button onClick={acknowledge} disabled={!canAcknowledge} className="w-full">
                {busy && <Spinner data-icon="inline-start" />}
                {busy ? "Acknowledging…" : "Acknowledge and enter"}
              </Button>
            </>
          )}

          {/* ── Step 4: done ───────────────────────────────────────────────── */}
          {step === "done" && detail && (
            <Alert variant="success">
              <AlertDescription className="space-y-2 tabular-nums">
                <p>
                  Intent #{detail.intent.id} acknowledged on {detail.intent.squadron_id}.
                </p>
                <p className="text-foreground">
                  The engine enters on its next tick, subject to its own risk gates (kill switch,
                  live-orders gate, exposure cap, collateral, drawdown). Follow it on the squadron
                  page.
                </p>
                <Button onClick={onClose} variant="outline" className="mt-2">
                  Close
                </Button>
              </AlertDescription>
            </Alert>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
