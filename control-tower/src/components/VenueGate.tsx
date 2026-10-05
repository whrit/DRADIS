"use client";

/**
 * First-run venue choice, shown before anything else on a multi-venue image.
 *
 * This exists because of an ordering bug rather than for polish. The risk gate
 * that follows records a jurisdiction acknowledgment stamped with the venue the
 * engine is running, and that record is write-once — "the first acknowledgment
 * is the record of legal significance". While first boot seeded a default of
 * Polymarket International, a US buyer was shown a gate telling them the
 * International CLOB is not available to US persons, had to accept it to get
 * any further, and thereby filed a permanent acknowledgment against a venue
 * they may not legally trade.
 *
 * So the choice comes first, and the acknowledgment is made against the venue
 * the operator actually picked.
 *
 * Only rendered when the image carries more than one venue and none has been
 * chosen. A single-venue build has nothing to ask.
 */

import { useState } from "react";
import type { VenueId } from "@/lib/setupApi";
import { putVenue, restartEngine, getSetupStatus } from "@/lib/setupApi";
import { CheckCircleIcon, WarningIcon } from "@phosphor-icons/react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Label } from "@/components/ui/label";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";

const VENUES: {
  id: VenueId;
  name: string;
  custody: string;
  blurb: string;
  eligibility: string;
  usOk: boolean;
}[] = [
  {
    id: "us",
    name: "Polymarket US",
    custody: "Custodial",
    blurb:
      "CFTC-regulated US exchange. Funds stay in your Polymarket US account and DRADIS authenticates with an API key.",
    eligibility: "Open to eligible US persons.",
    usOk: true,
  },
  {
    id: "kalshi",
    name: "Kalshi",
    custody: "Custodial",
    blurb:
      "CFTC-regulated US exchange. Requests are signed locally with an RSA key you generate in your Kalshi account.",
    eligibility: "Open to eligible US persons.",
    usOk: true,
  },
  {
    id: "intl",
    name: "Polymarket International",
    custody: "Self-custody",
    blurb:
      "The international CLOB. Your funds stay in a wallet you control and DRADIS signs orders with its key.",
    eligibility: "NOT available to US persons.",
    usOk: false,
  },
];

export default function VenueGate({
  available,
  onChosen,
}: {
  available: VenueId[];
  onChosen: () => void;
}) {
  const [pending, setPending] = useState<VenueId | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Only offer what this image can actually run.
  const options = VENUES.filter((v) => available.includes(v.id));
  const chosen = options.find((v) => v.id === pending);

  const [note, setNote] = useState<string | null>(null);

  const confirm = async () => {
    if (!pending) return;
    setBusy(true);
    setError(null);
    try {
      // Only restart when the engine is not already running this venue. A fresh
      // instance runs the intl fallback, so choosing Polymarket International
      // needs no restart at all — bouncing it anyway meant a pointless minute of
      // downtime on the very first thing a customer does.
      const res = await putVenue(pending);
      if (res.restart_required) {
        setNote("Restarting the engine — this takes 30-60 seconds.");
        await restartEngine();
      }
      // Wait for the engine to be RUNNING the chosen venue — not merely for the
      // choice to be recorded.
      //
      // `venue_selected` flips true the instant PUT writes the file, which is
      // before the restart has even begun. Polling on it dismissed this gate
      // while the old binary was still serving, so the jurisdiction gate behind
      // it rendered with the previous venue: choose Kalshi, get "DRADIS
      // International — read before proceeding". Acknowledging there would have
      // filed the write-once record against intl, which is the precise failure
      // this whole gate exists to prevent.
      //
      // `st.venue` comes from build_venue() — the binary actually running — so it
      // only reports the new venue once the swap is complete.
      const deadline = Date.now() + 120_000;
      for (;;) {
        try {
          const st = await getSetupStatus();
          if (st.venue === pending) {
            onChosen();
            return;
          }
        } catch {
          /* engine still down mid-restart — keep waiting */
        }
        if (Date.now() > deadline) {
          setError(
            `The engine did not come back as ${VENUES.find((v) => v.id === pending)?.name ?? pending} within two minutes. It may still be starting — reload the page in a moment.`,
          );
          setBusy(false);
          return;
        }
        setNote("Waiting for the engine to come back…");
        await new Promise((r) => setTimeout(r, 3000));
      }
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "Could not set the venue — is the engine reachable?",
      );
      setBusy(false);
    }
  };

  return (
    <Dialog open>
      <DialogContent
        showCloseButton={false}
        className="max-h-dvh overflow-y-auto sm:max-w-2xl"
        onEscapeKeyDown={(event) => event.preventDefault()}
        onPointerDownOutside={(event) => event.preventDefault()}
        onInteractOutside={(event) => event.preventDefault()}
      >
        <DialogHeader>
          <DialogTitle>Choose your trading venue</DialogTitle>
          <DialogDescription>
            This image can trade any of these. Pick the one you hold an account with — the engine
            restarts into it, and everything after this is specific to your choice. You can change
            it later in Setup.
          </DialogDescription>
        </DialogHeader>
        <RadioGroup
          value={pending ?? ""}
          onValueChange={(value) => setPending(value as VenueId)}
          disabled={busy}
          aria-label="Trading venue"
        >
          {options.map((v) => (
            <Card
              key={v.id}
              size="sm"
              className={cn("transition-colors", pending === v.id && "border-primary bg-primary/5")}
            >
              <CardContent>
                <Label htmlFor={`venue-${v.id}`} className="flex cursor-pointer items-start gap-3">
                  <RadioGroupItem id={`venue-${v.id}`} value={v.id} className="mt-0.5" />
                  <div className="min-w-0 flex-1 space-y-2">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="text-sm font-medium">{v.name}</span>
                      <Badge variant="secondary">{v.custody}</Badge>
                    </div>
                    <p className="text-xs font-normal leading-relaxed text-muted-foreground">
                      {v.blurb}
                    </p>
                    <p
                      className={cn(
                        "flex items-center gap-1.5 text-xs font-normal",
                        v.usOk ? "text-success" : "text-warning",
                      )}
                    >
                      {v.usOk ? (
                        <CheckCircleIcon className="size-3.5" />
                      ) : (
                        <WarningIcon className="size-3.5" />
                      )}
                      {v.eligibility}
                    </p>
                  </div>
                </Label>
              </CardContent>
            </Card>
          ))}
        </RadioGroup>
        <p className="text-xs leading-relaxed text-muted-foreground">
          Eligibility is yours to determine. DRADIS does not verify your jurisdiction, and you are
          solely responsible for confirming you may trade on the venue you select.
        </p>
        {note && !error && (
          <Alert role="status">
            <Spinner />
            <AlertDescription>{note}</AlertDescription>
          </Alert>
        )}
        {error && (
          <Alert variant="destructive">
            <WarningIcon />
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        <DialogFooter className="items-center sm:justify-between">
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground">
              {chosen ? `Selected: ${chosen.name}` : "Select a venue to continue"}
            </span>
            {/* Until Continue is pressed nothing has been written, so undoing a
                misclick should not mean reloading the page. */}
            {chosen && !busy && (
              <Button
                variant="ghost"
                onClick={() => {
                  setPending(null);
                  setNote(null);
                  setError(null);
                }}
              >
                Change
              </Button>
            )}
          </div>
          <Button onClick={confirm} disabled={!pending || busy}>
            {busy && <Spinner data-icon="inline-start" />}
            {busy ? "Applying…" : "Continue"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
