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
 * AlphaGate — blocking first-run acknowledgment overlay.
 *
 * Shown until the operator records the one-time alpha risk + jurisdiction
 * acknowledgment (POST /api/setup/acknowledge, persisted with a timestamp in
 * the instance DB). Rendered above everything, including the Setup view — no
 * interaction with the instance is possible until accepted.
 *
 * The jurisdiction text is venue-aware: the International build carries the
 * hard US-person warning; the US build a lighter eligibility note.
 */

import { useState } from "react";
import { acknowledgeAlpha } from "@/lib/setupApi";
import type { VenueId, Edition } from "@/lib/setupApi";
import { REPO_URL } from "@/lib/demo";
import {
  ArrowLeftIcon,
  GlobeIcon,
  LifebuoyIcon,
  ScrollIcon,
  UsersIcon,
  WarningIcon,
} from "@phosphor-icons/react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Field, FieldLabel } from "@/components/ui/field";
import { Spinner } from "@/components/ui/spinner";

/** Display name per venue — used in the header, the jurisdiction heading, and
 *  the confirmation checkbox, so a Kalshi build never labels itself "US". */
// Venues are named in full: "Polymarket US", "Polymarket International",
// "Kalshi". Abbreviating to "US" / "International" made the acknowledgement
// modal read "DRADIS US — read before proceeding", which names no venue a
// customer would recognise — and this modal is the first thing they see, where
// they are being asked to confirm eligibility to trade on that exact venue.
const VENUE_NAME: Record<VenueId, string> = {
  intl: "Polymarket International",
  us: "Polymarket US",
  kalshi: "Kalshi",
};

export default function AlphaGate({
  venue,
  appVersion,
  edition,
  onAcknowledged,
  onBack,
}: {
  venue: VenueId;
  appVersion?: string;
  edition?: Edition;
  onAcknowledged: () => void;
  /** Return to the venue chooser. Supplied only on a multi-venue image, where
   *  there is something to go back to. Accepting here writes a permanent,
   *  write-once record stamped with this venue, so an operator who arrives and
   *  sees the wrong one must be able to leave without signing it. */
  onBack?: () => void;
}) {
  const [riskOk, setRiskOk] = useState(false);
  const [jurisdictionOk, setJurisdictionOk] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // The engine serves its API before the SQLite pool finishes opening, so on a
  // freshly launched instance this call can land in that gap and come back
  // "DB not ready". That is a startup race, not a failure, and showing it as an
  // error makes a customer's very first interaction with the product look broken.
  // Retry quietly for a few seconds before surfacing anything.
  const accept = async () => {
    setBusy(true);
    setError(null);
    const DELAYS_MS = [400, 800, 1500, 2500, 4000];
    for (let attempt = 0; ; attempt++) {
      try {
        await acknowledgeAlpha();
        onAcknowledged();
        return;
      } catch (e) {
        const msg = e instanceof Error ? e.message : "";
        const stillStarting = /not ready|503|unavailable/i.test(msg);
        if (stillStarting && attempt < DELAYS_MS.length) {
          setError("Engine is still starting — retrying…");
          await new Promise((r) => setTimeout(r, DELAYS_MS[attempt]));
          continue;
        }
        setError(
          stillStarting
            ? 'The engine is reachable but its database has not opened. If this persists past a minute it is not a slow start — check the engine log for "SQLite init failed".'
            : msg || "Failed to record acknowledgment — is the engine reachable?",
        );
        setBusy(false);
        return;
      }
    }
  };

  return (
    <Dialog open>
      <DialogContent
        showCloseButton={false}
        className="max-h-dvh overflow-y-auto sm:max-w-2xl"
        aria-describedby={undefined}
        onEscapeKeyDown={(event) => event.preventDefault()}
        onPointerDownOutside={(event) => event.preventDefault()}
        onInteractOutside={(event) => event.preventDefault()}
      >
        <DialogHeader>
          <DialogTitle>
            DRADIS {VENUE_NAME[venue]}
            {appVersion ? ` v${appVersion}` : ""} — read before proceeding
          </DialogTitle>
        </DialogHeader>

        {/* ── Risk ─────────────────────────────────────────────────────── */}
        <Alert variant="destructive">
          <WarningIcon />
          <AlertTitle>Real-money risk</AlertTitle>
          <AlertDescription>
            <ul className="space-y-1 list-disc pl-4">
              <li>
                DRADIS is <strong>trading automation software provided AS IS</strong>. It places
                live orders with real funds and can <strong>lose some or all of the capital</strong>{" "}
                you give it access to.
              </li>
              <li>
                Automated trading involves substantial risk of loss: software bugs, security issues,
                network latency, API rate limits, venue outages, slippage, or misconfiguration can
                produce unintended trades and <strong>total loss of deployed capital</strong>. Start
                in GHOST mode and with money you can afford to lose entirely.
              </li>
              {/* The licence an operator holds depends on how they obtained
                  DRADIS. A Marketplace subscription carries commercial terms —
                  telling those customers they hold an AGPL grant is simply
                  wrong, and it was naming GPLv3 rather than AGPLv3 besides. */}
              {edition === "marketplace" ? (
                <li>
                  Licensed under the commercial terms of your AWS Marketplace subscription,{" "}
                  <strong>without warranty of any kind</strong>. Nothing here is financial advice.
                </li>
              ) : (
                <li>
                  Provided under the <strong>AGPLv3</strong>, without warranty of any kind. Nothing
                  here is financial advice.
                </li>
              )}
            </ul>
          </AlertDescription>
        </Alert>

        {/* ── Legal status ─────────────────────────────────────────────── */}
        <Alert>
          <ScrollIcon />
          <AlertTitle>Software, not a financial service</AlertTitle>
          <AlertDescription>
            <ul className="space-y-1 list-disc pl-4">
              <li>
                <strong className="text-foreground">Non-custodial:</strong> DRADIS is self-hosted
                software. Your private keys, API keys, and funds stay exclusively on this instance
                under your control — the developers never store, access, or take custody of them.
              </li>
              <li>
                <strong className="text-foreground">Not a broker or adviser:</strong> this is a
                self-hosted automation tool. The developers are not acting as a broker, dealer,
                investment adviser, or money transmitter, and no strategy signal or AI
                recommendation produced by the engine constitutes financial or investment advice.
              </li>
              <li>
                <strong className="text-foreground">Limitation of liability:</strong> to the maximum
                extent permitted by law, the developers and contributors are not liable for any
                direct, indirect, incidental, special, consequential, or punitive damages —
                including loss of funds, profits, or data — arising from use of, or inability to
                use, this software.
              </li>
            </ul>
          </AlertDescription>
        </Alert>

        {/* ── Jurisdiction ─────────────────────────────────────────────── */}
        <Alert variant="warning">
          <GlobeIcon />
          <AlertTitle>Jurisdiction — {VENUE_NAME[venue]} venue</AlertTitle>
          <AlertDescription>
            {venue === "intl" ? (
              <p>
                This build trades on Polymarket&apos;s <strong>international CLOB</strong>, which is{" "}
                <strong>not available to US persons</strong>. If you are a US person, do not use
                this venue — switch this instance to <strong>Polymarket US</strong> or{" "}
                <strong>Kalshi</strong> in Setup instead. By continuing you confirm you are legally
                permitted to trade on this venue in your jurisdiction and that you bear{" "}
                <strong>sole legal responsibility</strong> for that determination; the DRADIS
                project accepts none.
              </p>
            ) : (
              <p>
                This build trades on <strong>US-regulated venues</strong>. You remain responsible
                for confirming that you are eligible to trade on these venues under the laws that
                apply to you (state, residency, and account eligibility rules included).
              </p>
            )}
          </AlertDescription>
        </Alert>

        {/* ── Support policy ───────────────────────────────────────────── */}
        {/* A paid customer must be told how to get help, and by whom. The
              community wording below is honest for a free self-hosted build and
              would be unacceptable — quite possibly rejected — on a Marketplace
              product someone paid for. */}
        {edition === "marketplace" ? (
          <Alert>
            <LifebuoyIcon />
            <AlertTitle>Support</AlertTitle>
            <AlertDescription>
              <ul className="space-y-1 list-disc pl-4">
                <li>
                  Get help at{" "}
                  <a
                    href="https://dradis.live/support"
                    target="_blank"
                    rel="noreferrer"
                    className="text-primary hover:underline"
                  >
                    dradis.live/support
                  </a>{" "}
                  — the form collects what is needed to diagnose a deployment.
                </li>
                <li>
                  Or email{" "}
                  <a href="mailto:support@dradis.live" className="text-primary hover:underline">
                    support@dradis.live
                  </a>
                  .
                </li>
                <li>
                  <strong className="text-foreground">
                    Support will never ask for your wallet private key, seed phrase or API secrets.
                  </strong>{" "}
                  Anyone who does is not us.
                </li>
              </ul>
            </AlertDescription>
          </Alert>
        ) : (
          <Alert>
            <UsersIcon />
            <AlertTitle>Community-supported software</AlertTitle>
            <AlertDescription>
              <ul className="space-y-1 list-disc pl-4">
                <li>
                  Individual support is not included. For setup help, ask an AI assistant (ChatGPT,
                  Gemini, Claude) — paste in the README and your question; they are very good at
                  this.
                </li>
                <li>
                  Report bugs via{" "}
                  <a
                    href={`${REPO_URL}/issues`}
                    target="_blank"
                    rel="noreferrer"
                    className="text-primary hover:underline"
                  >
                    GitHub Issues
                  </a>{" "}
                  and request enhancements via{" "}
                  <a
                    href={`${REPO_URL}/discussions`}
                    target="_blank"
                    rel="noreferrer"
                    className="text-primary hover:underline"
                  >
                    GitHub Discussions
                  </a>
                  .
                </li>
              </ul>
            </AlertDescription>
          </Alert>
        )}

        {/* ── Acknowledgment ───────────────────────────────────────────── */}
        <div className="space-y-2.5">
          <Field orientation="horizontal" className="items-start">
            <Checkbox
              id="alpha-risk"
              className="mt-0.5"
              checked={riskOk}
              onCheckedChange={(checked) => setRiskOk(checked === true)}
            />
            <FieldLabel htmlFor="alpha-risk" className="text-xs font-normal leading-relaxed">
              I understand this software trades real money and can lose it, is provided AS IS
              without warranty or individual support, and I accept these risks and the
              non-custodial, no-advice, and limitation-of-liability terms above.
            </FieldLabel>
          </Field>
          <Field orientation="horizontal" className="items-start">
            <Checkbox
              id="alpha-jurisdiction"
              className="mt-0.5"
              checked={jurisdictionOk}
              onCheckedChange={(checked) => setJurisdictionOk(checked === true)}
            />
            <FieldLabel
              htmlFor="alpha-jurisdiction"
              className="text-xs font-normal leading-relaxed"
            >
              {venue === "intl"
                ? "I confirm I am legally permitted to trade on the international venue this build connects to, and I bear sole legal responsibility for that determination."
                : `I confirm I am eligible to trade on ${VENUE_NAME[venue]}, a US-regulated venue, under the laws that apply to me.`}
            </FieldLabel>
          </Field>
        </div>

        {error && (
          <Alert variant="destructive">
            <WarningIcon />
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        <Button onClick={accept} disabled={!riskOk || !jurisdictionOk || busy} className="w-full">
          {busy && <Spinner data-icon="inline-start" />}
          {busy ? "Recording…" : "I acknowledge — continue to DRADIS"}
        </Button>

        {onBack && !busy && (
          <Button
            variant="ghost"
            onClick={onBack}
            className="h-auto w-full whitespace-normal text-xs"
          >
            <ArrowLeftIcon data-icon="inline-start" />
            Not {VENUE_NAME[venue]}? Choose a different trading venue
          </Button>
        )}

        <p className="text-xs text-muted-foreground text-center">
          Your acknowledgment is recorded with a timestamp on this instance.
        </p>
      </DialogContent>
    </Dialog>
  );
}
