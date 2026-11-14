/**
 * Staffing: how many full-time people the selected forecast implies, by week or month, set against the people there are. The page opens on the position (over, short or about right,
 * in a colour and a sentence), then shows how the people needed are built up (workload, service-level buffer, shrinkage) against the people you have, then the detail by period.
 * One period gets a sentence instead of a one-bar chart; several get a line.
 */
import { Waiting } from '../common/loading';
import React, { useState } from "react";
import { Bar, CartesianGrid, Cell, ComposedChart, LabelList, Line, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { dec, int, type VersionMeta } from "../../services/api";
import { useForecast } from "../../services/forecastStore";
import { buildUp, shrinkageNote, storySentence, type ShrinkageSource, type Step } from "../../services/capacityStory";
import { useApi } from "./hooks";
import { CHART } from "./charts";
import { Metric, Section } from "../wfm/app-shell";
import { Notice, RefScope, RefTable, Segmented } from "./RefScope";
import { PoolingSection } from "./PoolingSection";
import { HeadcountPlanSection } from "./HeadcountPlanSection";

type Period = { period: string; days: number; volume: number; workloadHours: number; agentHours: number; fte: number; peakFte: number };
type Capacity = { version: VersionMeta; factor: number; fteHoursWeek: number; shrinkage: number; headcount: { people: number; fte: number }; shrinkageSource: ShrinkageSource; periods: Period[] };
type Summaries = Record<string, { schedule: { name: string; coverage: number | null } | null }>;

const FILL: Record<Step["tone"], string> = { neutral: "#94A3B8", add: "#B9C3D0", total: CHART.forecast, have: "#171717", over: "#B7791F", short: "#C84A4A", ok: "#2F7D5A" };
const POSITION = {
  OVER: { box: "border-[#B7791F] bg-[#FFF8EB] text-[#7A5210]", word: "Over-staffed" },
  SHORT: { box: "border-[#C84A4A] bg-[#FDF2F2] text-[#9B2C2C]", word: "Short-staffed" },
  BALANCED: { box: "border-[#2F7D5A] bg-[#F1F8F4] text-[#1F5C41]", word: "About right" },
} as const;

export function CapacitySection() {
  const [grain, setGrain] = useState("month");
  return (
    <RefScope crumb="Staffing" title="Staffing" description="People needed over weeks and months, set against the people you have."
      actions={<Segmented options={[{ id: "week", label: "Weekly" }, { id: "month", label: "Monthly" }]} value={grain} onChange={setGrain} />}
      emptyHint="Create a long-term forecast in Forecast Builder to plan capacity.">
      {(version) => <Body version={version} grain={grain} />}
    </RefScope>
  );
}

function Body({ version, grain }: { version: { id: string; name: string; rev: number }; grain: string }) {
  const { group, go } = useForecast();
  const cap = useApi<Capacity>(`/forecast/versions/${version.id}/capacity?grain=${grain}`, [version.rev]);
  const sums = useApi<Summaries>("/config/groups/summary");
  const d = cap.data;
  const rows = d?.periods.map((p) => ({ ...p, label: p.period.slice(grain === "month" ? 0 : 5) })) ?? [];
  const peak = d ? Math.max(0, ...d.periods.map((p) => p.peakFte)) : 0;
  const build = d ? buildUp(d.periods, { fteHoursWeek: d.fteHoursWeek, factor: d.factor, headcountFte: d.headcount.fte }) : null;
  const coverage = group ? sums.data?.[group.id]?.schedule?.coverage ?? null : null;
  const pos = build ? POSITION[build.gap.state] : null;
  const unit = grain === "month" ? "month" : "week";

  return (
    <>
      {cap.error && <Notice kind="err">{cap.error}</Notice>}
      {cap.loading && !d && <div className="p-6"><Waiting what="the capacity plan" shape="table" reload={cap.reload} /></div>}
      {d && build && pos && (
        <>
          {/* the position: over, short or about right, in words and colour */}
          <div role="status" data-testid="position" data-state={build.gap.state} className={`mx-6 mt-5 rounded-lg border px-5 py-4 ${pos.box}`}>
            <div className="flex flex-wrap items-baseline gap-x-3">
              <span className="text-[22px] font-semibold" data-testid="position-label">{build.gap.label}</span>
              <span className="text-[13px] font-medium">{pos.word}{build.gap.state !== "BALANCED" ? ` · ${build.gap.pct > 0 ? "+" : "−"}${Math.abs(Math.round(build.gap.pct))}% of the need` : ""}</span>
            </div>
            <p className="mt-1 max-w-4xl text-[14px]" data-testid="position-story">{storySentence({ gap: build.gap, need: build.need, haveFte: d.headcount.fte, people: d.headcount.people, coveragePct: coverage })}</p>
            {coverage !== null && coverage < 95 && (
              <div className="mt-2"><button type="button" className="text-[13px] font-medium underline" onClick={() => go("schedule-quality", "scheduling")}>See where the schedule falls short</button></div>)}
          </div>

          <div className="mt-5 grid grid-cols-2 divide-x divide-y border-y md:grid-cols-4 md:divide-y-0">
            <Metric label="People needed (average)" value={dec(build.need, 1)} hint="Full-time equivalents" />
            <Metric label={`Busiest ${unit}`} value={dec(peak > 0 ? Math.max(...d.periods.map((p) => p.fte)) : 0, 1)} hint={`Busiest day ${dec(peak, 1)} FTE`} />
            <Metric label="People you have" value={dec(d.headcount.fte, 1)} hint={`${int(d.headcount.people)} active ${d.headcount.people === 1 ? "person" : "people"}, ${group?.fteHoursWeek ?? 40} h = 1 FTE`} />
            <Metric label="Gap" value={build.gap.state === "BALANCED" ? "About right" : `${build.gap.gapFte > 0 ? "+" : "−"}${dec(Math.abs(build.gap.gapFte), 1)}`} tone={build.gap.state === "OVER" ? "warning" : build.gap.state === "SHORT" ? "critical" : "success"} delta={build.gap.state === "OVER" ? "More than needed" : build.gap.state === "SHORT" ? "Fewer than needed" : undefined} />
          </div>

          <Section title="From workload to people needed">
            <p className="max-w-4xl px-6 pb-2 text-[13px] text-muted-foreground">The workload in people, plus the extra agents the service level needs on top of it, plus what shrinkage takes away from paid time. That is the people needed, set against the people you have.</p>
            <div className="h-72 px-4" data-testid="waterfall">
              <ResponsiveContainer width="100%" height="100%">
                <ComposedChart data={build.steps} margin={{ top: 24, right: 16, bottom: 0, left: 0 }}>
                  <CartesianGrid vertical={false} stroke="var(--color-border)" />
                  <XAxis dataKey="label" tickLine={false} axisLine={false} fontSize={12} interval={0} />
                  <YAxis tickLine={false} axisLine={false} fontSize={12} width={44} />
                  <Tooltip cursor={false} content={<StepTip />} />
                  <Bar dataKey="base" stackId="w" fill="transparent" isAnimationActive={false} />
                  <Bar dataKey="value" stackId="w" isAnimationActive={false} radius={2}>
                    {build.steps.map((s) => <Cell key={s.id} fill={FILL[s.tone]} />)}
                    <LabelList dataKey="text" position="top" fontSize={12} fontWeight={600} />
                  </Bar>
                </ComposedChart>
              </ResponsiveContainer>
            </div>
            <div className="space-y-1 px-6 pb-5 pt-2 text-[12px] text-muted-foreground" data-testid="assumptions">
              <p data-testid="shrinkage-source"><span className="font-medium text-foreground">Shrinkage {dec(d.shrinkageSource.effectivePct, 0)}%</span> — {shrinkageNote(d.shrinkageSource).replace(/^[\d.]+% /, "")}{" "}
                <button type="button" className="underline" onClick={() => go("wfm-groups", "configuration")}>Change it on WFM Groups</button></p>
              <p><span className="font-medium text-foreground">Service-level buffer ×{dec(d.factor, 2)}</span> — the extra agents beyond the plain workload that answering calls in time needs. Full-time is {d.fteHoursWeek} hours a week.</p>
            </div>
          </Section>

          <Section title="People needed over time">
            {rows.length > 1 ? (
              <div className="h-64 px-4 pb-6" data-testid="trend-chart">
                <ResponsiveContainer width="100%" height="100%">
                  <ComposedChart data={rows} margin={{ top: 8, right: 16, bottom: 0, left: 0 }}>
                    <CartesianGrid vertical={false} stroke="var(--color-border)" />
                    <XAxis dataKey="label" tickLine={false} axisLine={false} fontSize={12} minTickGap={16} />
                    <YAxis tickLine={false} axisLine={false} fontSize={12} width={44} domain={[0, (max: number) => Math.ceil(Math.max(max, d.headcount.fte) * 1.1)]} />
                    <Tooltip content={<TrendTip />} />
                    <ReferenceLine y={d.headcount.fte} stroke={CHART.actual} strokeDasharray="4 3" label={{ value: `People you have ${dec(d.headcount.fte, 0)}`, position: "insideTopRight", fontSize: 12 }} />
                    <Line dataKey="fte" name="People needed" stroke={CHART.forecast} strokeWidth={2.5} dot={{ r: 3 }} isAnimationActive={false} />
                    <Line dataKey="peakFte" name="Busiest day" stroke={CHART.agents} strokeWidth={1.5} strokeDasharray="5 3" dot={false} isAnimationActive={false} />
                  </ComposedChart>
                </ResponsiveContainer>
              </div>
            ) : (
              <p className="px-6 pb-6 text-[14px]" data-testid="one-period">{rows[0] ? `${rows[0].period}: ${dec(rows[0].fte, 1)} people needed on average, ${dec(rows[0].peakFte, 1)} on the busiest day.` : "This forecast has no periods."}</p>
            )}
          </Section>

          <Section title={grain === "month" ? "Monthly detail" : "Weekly detail"}>
            <RefTable right={[1, 2, 3, 4, 5, 6]} head={[grain === "month" ? "Month" : "Week starting", "Days", "Contacts", "Workload hours", "Agent hours", "People needed (FTE)", "Busiest day (FTE)"]}>
              {d.periods.map((p) => (
                <tr key={p.period} className="border-b hover:bg-surface">
                  <td className="px-6 py-3 font-medium">{p.period}</td>
                  <td className="px-6 py-3 text-right">{p.days}</td>
                  <td className="px-6 py-3 text-right">{int(p.volume)}</td>
                  <td className="px-6 py-3 text-right">{int(p.workloadHours)}</td>
                  <td className="px-6 py-3 text-right">{int(p.agentHours)}</td>
                  <td className="px-6 py-3 text-right font-semibold">{dec(p.fte, 1)}</td>
                  <td className="px-6 py-3 text-right">{dec(p.peakFte, 1)}</td>
                </tr>
              ))}
            </RefTable>
          </Section>
          {group && <HeadcountPlanSection groupId={group.id} versionId={version.id} rev={version.rev} />}
        </>
      )}
      {d && !build && <p className="px-6 py-5 text-[13px] text-muted-foreground">This forecast has no days to plan against.</p>}
      <PoolingSection />
    </>
  );
}

function StepTip({ active, payload }: any) {
  if (!active || !payload?.length) return null;
  const s: Step = payload[0].payload;
  return <div className="num rounded-md border bg-popover px-3 py-2 text-[12px] shadow-sm"><div className="font-semibold">{s.label}</div><div>{s.text} FTE</div></div>;
}
function TrendTip({ active, payload, label }: any) {
  if (!active || !payload?.length) return null;
  return (
    <div className="num rounded-md border bg-popover px-3 py-2 text-[12px] shadow-sm">
      <div className="mb-1 font-semibold">{label}</div>
      {payload.map((p: any) => <div key={p.dataKey} className="flex items-center justify-between gap-6"><span className="text-muted-foreground">{p.name}</span><span className="font-medium">{dec(p.value, 1)}</span></div>)}
    </div>
  );
}
