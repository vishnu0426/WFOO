/**
 * Staffing (reference design): how many full-time people the selected forecast implies, by week or month, using the group's
 * shrinkage, occupancy cap and full-time hours.
 */
import React, { useState } from "react";
import { Bar, CartesianGrid, ComposedChart, Line, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { dec, int, pct, type VersionMeta } from "../../services/api";
import { useForecast } from "../../services/forecastStore";
import { useApi } from "./hooks";
import { ChartTooltip } from "./ChartTooltip";
import { Busy } from "./ui";
import { Metric, Section } from "../wfm/app-shell";
import { Notice, RefScope, RefTable, Segmented } from "./RefScope";
import { PoolingSection } from "./PoolingSection";
import { HeadcountPlanSection } from "./HeadcountPlanSection";

type Capacity = { version: VersionMeta; factor: number; fteHoursWeek: number; shrinkage: number; periods: { period: string; days: number; volume: number; workloadHours: number; agentHours: number; fte: number; peakFte: number }[] };

export function CapacitySection() {
  const [grain, setGrain] = useState("month");
  return (
    <RefScope crumb="Staffing" title="Staffing" description="People needed over weeks and months, after shrinkage and the occupancy cap."
      actions={<Segmented options={[{ id: "week", label: "Weekly" }, { id: "month", label: "Monthly" }]} value={grain} onChange={setGrain} />}
      emptyHint="Create a long-term forecast in Forecast Builder to plan capacity.">
      {(version) => <Body version={version} grain={grain} />}
    </RefScope>
  );
}

function Body({ version, grain }: { version: { id: string; name: string; rev: number }; grain: string }) {
  const { group } = useForecast();
  const cap = useApi<Capacity>(`/forecast/versions/${version.id}/capacity?grain=${grain}`, [version.rev]);
  const d = cap.data;
  const peak = d ? Math.max(0, ...d.periods.map((p) => p.fte)) : 0;
  const avg = d && d.periods.length ? d.periods.reduce((a, p) => a + p.fte, 0) / d.periods.length : 0;
  const rows = d?.periods.map((p) => ({ ...p, label: p.period.slice(grain === "month" ? 0 : 5) })) ?? [];
  return (
    <>
      {cap.error && <Notice kind="err">{cap.error}</Notice>}
      {cap.loading && !d && <div className="p-6"><Busy text="Calculating…" /></div>}
      {d && (
        <>
          <div className="grid grid-cols-2 divide-x divide-y border-b md:grid-cols-4 md:divide-y-0">
            <Metric label="Average people needed" value={dec(avg, 1)} hint="Full-time equivalents" />
            <Metric label="Busiest period" value={dec(peak, 1)} hint="Full-time equivalents" />
            <Metric label="Shrinkage allowed" value={pct(d.shrinkage)} hint="Breaks, training, absence" />
            <Metric label="Erlang factor" value={dec(d.factor, 2)} hint={`Extra agents vs plain workload · full-time is ${group?.fteHoursWeek ?? 40} h/week`} />
          </div>
          <Section title="People needed">
            <div className="h-64 px-4 pb-6">
              <ResponsiveContainer width="100%" height="100%">
                <ComposedChart data={rows} margin={{ top: 8, right: 16, bottom: 0, left: 0 }}>
                  <CartesianGrid vertical={false} stroke="var(--color-border)" />
                  <XAxis dataKey="label" tickLine={false} axisLine={false} fontSize={12} minTickGap={16} />
                  <YAxis tickLine={false} axisLine={false} fontSize={12} width={44} />
                  <Tooltip content={<ChartTooltip />} />
                  <Bar dataKey="fte" name="People needed" fill="var(--color-chart-2)" radius={2} isAnimationActive={false} />
                  <Line dataKey="peakFte" name="Busiest day" stroke="var(--color-critical)" strokeWidth={2} dot={false} isAnimationActive={false} />
                </ComposedChart>
              </ResponsiveContainer>
            </div>
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
      <PoolingSection />
    </>
  );
}
