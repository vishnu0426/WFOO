/**
 * Staffing › Pooling benefit. Two or more groups planned separately each carry their own safety margin. If their people can be shared
 * (cross-trained), one pool serves the combined traffic with fewer people. This works both out with the same engine, for one day, so the
 * value of cross-training is a number. Groups of different channels are compared as they are configured.
 */
import React, { useState } from "react";
import { Area, CartesianGrid, ComposedChart, Line, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { api, dec } from "../../services/api";
import { useForecast } from "../../services/forecastStore";
import { Busy } from "./ui";
import { ChartTooltip } from "./ChartTooltip";
import { Metric, PrimaryButton, Section } from "../wfm/app-shell";
import { Notice } from "./RefScope";

type Result = {
  day: string; groups: { id: string; name: string; queues: number; contacts: number }[]; separateHours: number; pooledHours: number; savingHours: number; savingPercent: number; peakSeparate: number; peakPooled: number;
  targets: { serviceLevel: number; answerSec: number; from: string }; note: string; slots: { slot: number; time: string; separate: number; pooled: number }[];
};
const tomorrow = () => { const d = new Date(); d.setDate(d.getDate() + 1); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };

export function PoolingSection() {
  const { groups } = useForecast();
  const [picked, setPicked] = useState<string[]>([]);
  const [day, setDay] = useState(tomorrow());
  const [res, setRes] = useState<Result | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  if (groups.length < 2) return null;
  const toggle = (id: string) => { setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id])); setRes(null); };
  const run = async () => { setBusy(true); setError(""); try { setRes(await api<Result>(`/forecast/pooling?groupIds=${picked.join(",")}&day=${day}`)); } catch (e: any) { setError(e.message); setRes(null); } finally { setBusy(false); } };

  return (
    <Section title="Pooling benefit" action={<div className="flex flex-wrap items-center gap-2">
      <input type="date" value={day} onChange={(e) => { setDay(e.target.value); setRes(null); }} aria-label="Day" className="h-9 rounded-lg border bg-background px-3 text-[13px]" />
      <PrimaryButton disabled={picked.length < 2 || busy} onClick={run}>Compare</PrimaryButton>
    </div>}>
      <p className="max-w-4xl px-6 pb-3 text-[13px] text-muted-foreground">Pick two or more groups whose people could be shared. Each needs a published short-term forecast for the day.</p>
      <div className="flex flex-wrap gap-2 px-6 pb-4">
        {groups.map((g) => (
          <label key={g.id} className={`flex cursor-pointer items-center gap-2 rounded-lg border px-3 py-1.5 text-[13px] ${picked.includes(g.id) ? "border-foreground bg-surface" : ""}`}>
            <input type="checkbox" checked={picked.includes(g.id)} onChange={() => toggle(g.id)} />{g.name}
          </label>
        ))}
      </div>
      {error && <Notice kind="err" onClose={() => setError("")}>{error}</Notice>}
      {busy && <div className="px-6 pb-5"><Busy text="Working out both ways…" /></div>}
      {res && (
        <>
          <div className="grid grid-cols-2 divide-x divide-y border-y md:grid-cols-4 md:divide-y-0">
            <Metric label="Separate pools" value={`${dec(res.separateHours, 0)} h`} hint={`Peak ${Math.round(res.peakSeparate)} people`} />
            <Metric label="One shared pool" value={`${dec(res.pooledHours, 0)} h`} hint={`Peak ${Math.round(res.peakPooled)} people`} />
            <Metric label="Saving" value={`${dec(res.savingHours, 0)} h`} tone={res.savingHours > 0 ? "success" : undefined} delta={res.savingHours > 0 ? "Fewer people for the same service" : "No gain on this day"} />
            <Metric label="Saving, share" value={`${dec(res.savingPercent, 1)}%`} hint={`Target ${Math.round(res.targets.serviceLevel * 100)}% in ${res.targets.answerSec}s (${res.targets.from})`} />
          </div>
          <div className="h-64 px-4 py-4">
            <ResponsiveContainer width="100%" height="100%">
              <ComposedChart data={res.slots} margin={{ top: 8, right: 16, bottom: 0, left: 0 }}>
                <CartesianGrid vertical={false} stroke="var(--color-border)" />
                <XAxis dataKey="time" tickLine={false} axisLine={false} fontSize={12} interval={7} />
                <YAxis tickLine={false} axisLine={false} fontSize={12} width={40} />
                <Tooltip content={<ChartTooltip />} />
                <Area dataKey="separate" name="Separate" stroke="var(--color-critical)" fill="var(--color-critical-bg)" strokeWidth={2} type="stepAfter" isAnimationActive={false} />
                <Line dataKey="pooled" name="Pooled" stroke="var(--color-chart-2)" strokeWidth={2} dot={false} type="stepAfter" isAnimationActive={false} />
              </ComposedChart>
            </ResponsiveContainer>
          </div>
          <p className="max-w-4xl px-6 pb-5 text-[12px] text-subtle-foreground">{res.note}</p>
        </>
      )}
    </Section>
  );
}
