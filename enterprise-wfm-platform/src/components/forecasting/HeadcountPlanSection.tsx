/**
 * Staffing › Headcount plan. Turns the long-term forecast's monthly FTE need into "hire N people by month X",
 * starting from today's headcount and losing people to attrition along the way -- the strategic capacity-planning
 * view NICE/Genesys/Verint sell as a separate module. The default attrition rate is not a guess: it comes from the
 * audit trail's own record of who in this group has actually been marked Terminated over the last 12 months.
 */
import React, { useState } from "react";
import { dec } from "../../services/api";
import { useApi } from "./hooks";
import { Busy } from "./ui";
import { Metric, Section } from "../wfm/app-shell";
import { RefTable } from "./RefScope";

type Attrition = { currentHeadcount: number; terminatedTrailing12mo: number; estimatedAnnualPct: number };
type Capacity = { periods: { period: string; fte: number }[] };

/** Always plans by calendar month, regardless of whether the Staffing chart above is toggled to weekly: a hiring plan by week is not how anyone reads one. */
export function HeadcountPlanSection({ groupId, versionId, rev }: { groupId: string; versionId: string; rev: number }) {
  const attr = useApi<Attrition>(`/workforce/attrition?groupId=${groupId}`, [groupId]);
  const cap = useApi<Capacity>(`/forecast/versions/${versionId}/capacity?grain=month`, [versionId, rev]);
  const [pctOverride, setPctOverride] = useState<number | null>(null);
  const a = attr.data;

  if ((attr.loading && !a) || (cap.loading && !cap.data)) return <Section title="Headcount plan"><div className="p-6"><Busy text="Loading headcount…" /></div></Section>;
  if (!a || !cap.data) return null;

  const pct = pctOverride ?? a.estimatedAnnualPct;
  const thisMonth = new Date().toISOString().slice(0, 7);
  const future = cap.data.periods.filter((p) => p.period >= thisMonth).sort((x, y) => (x.period < y.period ? -1 : 1));

  if (!future.length) return (
    <Section title="Headcount plan"><p className="px-6 py-4 text-[13px] text-muted-foreground">This forecast does not cover any month from now on, so there is nothing to plan hiring against.</p></Section>
  );

  const monthlyRate = pct / 100 / 12;
  let headcount = a.currentHeadcount;
  const rows = future.map((p) => {
    const start = headcount;
    const attritionLoss = Math.round(start * monthlyRate);
    const available = Math.max(0, start - attritionLoss);
    const needed = Math.ceil(p.fte);
    const hires = Math.max(0, needed - available);
    const end = available + hires;
    headcount = end;
    return { period: p.period, needed, start, attritionLoss, available, hires, end };
  });
  const totalHires = rows.reduce((s, r) => s + r.hires, 0);
  const firstShort = rows.find((r) => r.hires > 0);

  return (
    <Section title="Headcount plan" action={
      <label className="flex items-center gap-2 text-[12px] text-muted-foreground">Assumed annual attrition
        <input type="number" min={0} max={100} step={0.5} value={pct}
          onChange={(e) => setPctOverride(Math.max(0, Math.min(100, Number(e.target.value) || 0)))}
          className="h-8 w-20 rounded-md border bg-background px-2 text-[13px] num" aria-label="Assumed annual attrition percent" />%
      </label>
    }>
      <p className="max-w-4xl px-6 pb-3 text-[13px] text-muted-foreground">
        How many people to hire, and by when, to keep up with this forecast -- starting from today's headcount ({a.currentHeadcount}), losing people to attrition at the rate above, hiring exactly enough each month to close the gap.
        {a.terminatedTrailing12mo > 0
          ? ` The default (${dec(a.estimatedAnnualPct, 1)}%) comes from ${a.terminatedTrailing12mo} termination${a.terminatedTrailing12mo === 1 ? "" : "s"} of this group's people over the last 12 months -- type a different number to try another assumption.`
          : " No terminations recorded for this group in the last 12 months, so the default starts at 0% -- type an assumption to plan against."}
      </p>
      <div className="grid grid-cols-2 divide-x border-y md:grid-cols-4 md:divide-y-0">
        <Metric label="Headcount today" value={String(a.currentHeadcount)} />
        <Metric label="Total hires needed" value={String(totalHires)} hint={`over ${rows.length} month${rows.length === 1 ? "" : "s"}`} tone={totalHires > 0 ? "warning" : undefined} />
        <Metric label="First month short-handed" value={firstShort ? firstShort.period : "None"} tone={firstShort ? "critical" : undefined} />
        <Metric label="Headcount at the end" value={String(rows[rows.length - 1].end)} />
      </div>
      <RefTable right={[1, 2, 3, 4, 5, 6]} head={["Month", "People needed (FTE)", "Start of month", "Lost to attrition", "Before hiring", "Hire this month", "End of month"]}>
        {rows.map((r) => (
          <tr key={r.period} className="border-b hover:bg-surface">
            <td className="px-6 py-3 font-medium">{r.period}</td>
            <td className="px-6 py-3 text-right">{r.needed}</td>
            <td className="px-6 py-3 text-right">{r.start}</td>
            <td className="px-6 py-3 text-right text-critical">{r.attritionLoss > 0 ? `-${r.attritionLoss}` : "-"}</td>
            <td className="px-6 py-3 text-right">{r.available}</td>
            <td className="px-6 py-3 text-right font-semibold text-success">{r.hires > 0 ? `+${r.hires}` : "-"}</td>
            <td className="px-6 py-3 text-right font-semibold">{r.end}</td>
          </tr>
        ))}
      </RefTable>
      <p className="px-6 py-3 text-[12px] text-subtle-foreground">A planning input, not a forecast of who will leave or when: it assumes attrition lands evenly through the year and hires exactly enough each month to meet that month's average need.</p>
    </Section>
  );
}
