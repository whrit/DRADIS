/**
 * The Helm view — DRADIS's record of why a trade was entered.
 *
 * Every other viper's rationale lives in its source and its config. A Helm
 * intent instead carries what the operator believed, how strongly, what would
 * have proved them wrong, and what the LLM said about that reasoning before the
 * money went in. None of that fits a trade row, which is why this is its own
 * screen rather than a section of the Tradelog: the log answers what executed,
 * this answers why it was entered.
 *
 * The page is ordered by what it is for. Live intents first, because those are
 * operations with money committed. Then the resolved record, read deliberately
 * against what actually happened. Calibration last, and only once enough
 * intents have resolved to mean anything.
 */
"use client";

import useSWR from "swr";
import HelmIntentsPanel from "./HelmIntentsPanel";
import { getHelmSummary } from "@/lib/api";
import { SectionHeader, Stat } from "./shared";
import { Card } from "./ui/card";
import { Progress } from "./ui/progress";

export default function HelmPage() {
  const { data: summary } = useSWR("helm-summary", getHelmSummary, { refreshInterval: 10_000 });

  const resolved = summary?.resolved ?? 0;
  const needed = summary?.calibration_min_resolved ?? 30;
  const pct = needed > 0 ? Math.min(100, Math.round((resolved / needed) * 100)) : 0;

  return (
    <div className="space-y-6">
      <SectionHeader
        title="Helm"
        description={
          <>
            Convictions you took the helm for, with the thesis as first submitted. Intents outlive
            their squadrons, so the record stays here after a squadron retires.
          </>
        }
      />

      <section className="space-y-2">
        <SectionHeader
          title="Live"
          description={<>Money committed now, under a posture you can still revise.</>}
        />
        <HelmIntentsPanel
          bare
          show="live"
          emptyText="Nothing live. Take the Helm from the CAG overview to open an intent."
        />
      </section>

      <section className="space-y-2">
        <SectionHeader
          title="Resolved"
          description={
            <>
              How each conviction ended, and whether the critique named the failure that actually
              happened.
            </>
          }
        />
        <HelmIntentsPanel bare show="resolved" emptyText="No resolved intents yet." />
      </section>

      <section className="space-y-2">
        <SectionHeader title="Calibration" />
        <Card size="sm" className="px-4 gap-3">
          {/*
            Deliberately shows no figure until the sample supports one. Ten
            resolved intents with stated probabilities would invite a
            calibration claim the sample cannot carry, and Helm produces a
            handful a month, so the temptation would arrive long before the
            evidence. Everything is recorded from the first intent; only the
            display waits.
          */}
          <Stat label="Resolved intents" value={`${resolved} of ${needed}`} />
          <Progress value={pct} aria-label="Calibration sample progress" />
          {summary?.calibration_visible && summary.calibration ? (
            <pre className="text-xs font-mono tabular-nums text-foreground whitespace-pre-wrap">
              {JSON.stringify(summary.calibration, null, 2)}
            </pre>
          ) : (
            <p className="text-xs text-muted-foreground">
              Stated confidence against realized outcome, and the critique&apos;s hit rate, appear
              once {needed} intents have resolved. Recorded from the first one; a figure drawn from
              fewer would read as evidence without being any.
            </p>
          )}
        </Card>
      </section>
    </div>
  );
}
