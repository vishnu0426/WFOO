/**
 * Forecast quality: how accurate the forecasts are (Accuracy) and which methods and learned corrections produce them (Models), as two tabs of one page. Each tab keeps its own address
 * (/forecasting/accuracy-heatmap and /forecasting/model-leaderboard), so bookmarks and links still land where they did.
 */
import React, { useRef } from "react";
import { useForecast } from "../../services/forecastStore";
import { PageHeader } from "../wfm/app-shell";
import { AccuracySection } from "./AccuracySection";
import { LeaderboardSection } from "./LeaderboardSection";

export type QualityTab = "accuracy" | "models";
const TABS: { id: QualityTab; label: string; sub: string; hint: string }[] = [
  { id: "accuracy", label: "Accuracy", sub: "accuracy-heatmap", hint: "How close the published forecasts were to what really happened" },
  { id: "models", label: "Models", sub: "model-leaderboard", hint: "Which method was most accurate on your history, and what the system has learned" },
];

export function QualityPage({ tab }: { tab: QualityTab }) {
  const { go } = useForecast();
  const list = useRef<HTMLDivElement>(null);
  // arrow keys move between the tabs, as a tab list does
  const onKey = (e: React.KeyboardEvent, i: number) => {
    if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
    e.preventDefault();
    const next = TABS[(i + (e.key === "ArrowRight" ? 1 : TABS.length - 1)) % TABS.length];
    go(next.sub);
    requestAnimationFrame(() => list.current?.querySelector<HTMLButtonElement>(`[data-tab="${next.id}"]`)?.focus());
  };
  return (
    <div>
      <PageHeader breadcrumb={["Forecasting", "Forecast quality"]} title="Forecast quality" description="How accurate the forecasts are, and which methods and learned corrections produce them." />
      <div ref={list} role="tablist" aria-label="Forecast quality" className="flex gap-1 border-b px-6">
        {TABS.map((t, i) => (
          <button key={t.id} type="button" role="tab" id={`quality-tab-${t.id}`} data-tab={t.id} aria-selected={tab === t.id} aria-controls="quality-panel" tabIndex={tab === t.id ? 0 : -1} title={t.hint}
            onClick={() => tab !== t.id && go(t.sub)} onKeyDown={(e) => onKey(e, i)}
            className={`-mb-px border-b-2 px-4 py-2.5 text-[14px] font-medium ${tab === t.id ? "border-foreground text-foreground" : "border-transparent text-muted-foreground hover:text-foreground"}`}>{t.label}</button>
        ))}
      </div>
      <div role="tabpanel" id="quality-panel" aria-labelledby={`quality-tab-${tab}`}>
        {tab === "accuracy" ? <AccuracySection bare /> : <LeaderboardSection bare />}
      </div>
    </div>
  );
}
