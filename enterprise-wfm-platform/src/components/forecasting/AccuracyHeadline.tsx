/**
 * The one forecast-accuracy figure, fetched once and shown the same way everywhere. `useAccuracyHeadline` is for screens that draw it in their own tile; `AccuracyHero` is the large version
 * at the top of the Accuracy page.
 */
import React from "react";
import { Info } from "lucide-react";
import { useApi } from "./hooks";
import { ACCURACY_LABEL, accuracySub, accuracyTone, accuracyValue, type AccuracyHeadline } from "../../services/accuracyTerms";

export function useAccuracyHeadline(groupId: string | undefined) {
  return useApi<AccuracyHeadline>(groupId ? `/forecast/accuracy-headline?groupId=${groupId}` : null, [groupId]);
}

/** A small "what does this mean" mark: hover or focus shows the definition; screen readers read it. */
export const Define: React.FC<{ text: string; label?: string }> = ({ text, label = "How this is measured" }) => (
  <button type="button" aria-label={`${label}: ${text}`} title={text} className="inline-flex align-middle text-subtle-foreground hover:text-foreground"><Info className="size-3.5" aria-hidden /></button>
);

const TONE = { good: "text-success", warn: "text-warning", bad: "text-critical", neutral: "text-foreground" } as const;

export const AccuracyHero: React.FC<{ groupId: string }> = ({ groupId }) => {
  const r = useAccuracyHeadline(groupId);
  const h = r.data;
  const tone = accuracyTone(h?.accuracyPct ?? null, h?.targetPct);
  return (
    <section aria-label={ACCURACY_LABEL} data-testid="accuracy-hero" data-state={h?.state ?? "LOADING"} className="rounded-lg border p-5">
      <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
        <h2 className="text-[13px] font-medium text-subtle-foreground">{ACCURACY_LABEL} {h && <Define text={h.definition} />}</h2>
        <span className={`num text-[36px] font-semibold leading-none ${h?.state === "SPARSE" ? "text-muted-foreground" : TONE[tone]}`} data-testid="accuracy-value">{r.loading && !h ? "…" : accuracyValue(h)}</span>
        {h && h.deltaPts !== null && h.deltaPts !== 0 && <span className={`text-[13px] ${h.deltaPts > 0 ? "text-success" : "text-critical"}`}>{h.deltaPts > 0 ? "+" : "−"}{Math.abs(h.deltaPts).toFixed(1)} pts on the 28 days before</span>}
      </div>
      <p className="mt-1 text-[13px] text-muted-foreground" data-testid="accuracy-sub">{h ? accuracySub(h) : ""}</p>
      {h && h.biasPct !== null && h.accuracyPct !== null && <p className="text-[12px] text-subtle-foreground">{Math.abs(h.biasPct) < 0.5 ? "Not running high or low overall." : `Running ${Math.abs(h.biasPct).toFixed(1)}% ${h.biasPct > 0 ? "high" : "low"} overall.`} Target {h.targetPct}% or better.</p>}
      <p className="mt-2 max-w-3xl text-[12px] text-subtle-foreground">The other figures on this page are different measures and are named for what they are: the latest week, and a test run on recent history.</p>
    </section>
  );
};
