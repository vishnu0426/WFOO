/**
 * Scenarios (reference design): "what if" comparisons against the selected forecast. Change volume, handle time and staffing
 * targets and see the effect on agents needed and service level. Scenarios can be saved with the forecast.
 */
import React, { useEffect, useState } from "react";
import { CartesianGrid, ComposedChart, Legend, Line, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { Plus, Trash2 } from "lucide-react";
import { api, dec, int, pct } from "../../services/api";
import { useForecast } from "../../services/forecastStore";
import { useApi } from "./hooks";
import { CHART } from "./charts";
import { Busy } from "./ui";
import { OutlineButton, PrimaryButton, Section } from "../wfm/app-shell";
import { Labeled, Notice, RefScope, RefTable, fieldCls } from "./RefScope";

type Draft = { name: string; volumePct: number; ahtPct: number; shrinkage: string; serviceLevel: string; occupancyCap: string };
type Params = { volumePct?: number; ahtPct?: number; shrinkage?: number; serviceLevel?: number; occupancyCap?: number };
type Saved = { id: string; name: string; description: string; params: Params };
type Result = { name: string; params: Params; volume: number; agentHours: number; fte: number; peakRequired: number | null; serviceLevel: number | null; occupancy: number | null; warnIntervals: number; impactRequiredFteDelta: number; impactServiceLevelDelta: number | null; daily: { day: string; agentHours: number }[] };
type Compare = { window: { from: string; to: string }; results: Result[] };

const blank = (name: string, extra: Partial<Draft> = {}): Draft => ({ name, volumePct: 0, ahtPct: 0, shrinkage: "", serviceLevel: "", occupancyCap: "", ...extra });
const toParams = (d: Draft): Params => {
  const p: Params = {};
  if (d.volumePct) p.volumePct = d.volumePct;
  if (d.ahtPct) p.ahtPct = d.ahtPct;
  if (d.shrinkage !== "") p.shrinkage = Number(d.shrinkage) / 100;
  if (d.serviceLevel !== "") p.serviceLevel = Number(d.serviceLevel) / 100;
  if (d.occupancyCap !== "") p.occupancyCap = Number(d.occupancyCap) / 100;
  return p;
};
const fromParams = (name: string, p: Params): Draft => blank(name, {
  volumePct: p.volumePct ?? 0, ahtPct: p.ahtPct ?? 0, shrinkage: p.shrinkage !== undefined ? String(p.shrinkage * 100) : "",
  serviceLevel: p.serviceLevel !== undefined ? String(p.serviceLevel * 100) : "", occupancyCap: p.occupancyCap !== undefined ? String(p.occupancyCap * 100) : "",
});
const COLORS = [CHART.forecast, CHART.agents, CHART.reforecast, CHART.actual, CHART.bad, CHART.baseline];

export function ScenariosSection() {
  return (
    <RefScope crumb="Scenarios" title="Scenarios" description="Compare “what if” cases against the forecast: more contacts, longer calls, different targets.">
      {(version) => <Body version={version} />}
    </RefScope>
  );
}

function Body({ version }: { version: { id: string; name: string; rev: number; kind: string } }) {
  const { group, can, setNotice } = useForecast();
  const [drafts, setDrafts] = useState<Draft[]>([blank("Volume surge +20%", { volumePct: 20 }), blank("Handle time +15%", { ahtPct: 15 })]);
  const [tick, setTick] = useState(0);
  const saved = useApi<Saved[]>(`/forecast/versions/${version.id}/scenarios`, [tick]);
  const [result, setResult] = useState<Compare | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => { setResult(null); setError(""); }, [version.id, version.rev]);
  if (!group) return null;

  const set = (i: number, patch: Partial<Draft>) => setDrafts((d) => d.map((x, j) => (j === i ? { ...x, ...patch } : x)));
  const compare = async () => {
    setBusy(true); setError("");
    try { setResult(await api<Compare>(`/forecast/versions/${version.id}/scenarios/compare`, { method: "POST", body: { scenarios: drafts.map((d) => ({ name: d.name || "Scenario", params: toParams(d) })) } })); }
    catch (e: any) { setError(e.message); } finally { setBusy(false); }
  };
  const save = async (d: Draft) => {
    try { await api(`/forecast/versions/${version.id}/scenarios`, { method: "POST", body: { name: d.name || "Scenario", params: toParams(d) } }); setTick((t) => t + 1); setNotice({ kind: "ok", text: `Saved “${d.name}”.` }); }
    catch (e: any) { setNotice({ kind: "err", text: e.message }); }
  };
  const short = version.kind === "SHORT";
  const chart = result ? result.results[0].daily.map((d, i) => ({ day: d.day.slice(5), ...Object.fromEntries(result.results.map((r, k) => [`s${k}`, r.daily[i]?.agentHours ?? null])) })) : [];

  return (
    <>
      {error && <Notice kind="err" onClose={() => setError("")}>{error}</Notice>}
      <Section title="What if…">
        <p className="px-6 pb-3 text-[13px] text-muted-foreground">
          Compared with {version.name}. Leave a target blank to keep the group's setting ({group.serviceLevelGoal}% in {group.serviceLevelThresholdSec}s, {group.shrinkagePercent}% shrinkage, {group.targetOccupancy}% occupancy cap).
        </p>
        <div className="space-y-3 px-6 pb-4">
          {drafts.map((d, i) => (
            <div key={i} className="grid grid-cols-2 items-end gap-3 rounded-lg border bg-surface p-3 md:grid-cols-7">
              <Labeled label="Name" className="col-span-2"><input className={fieldCls} value={d.name} onChange={(e) => set(i, { name: e.target.value })} /></Labeled>
              <Labeled label="Volume %"><input type="number" className={fieldCls} value={d.volumePct} onChange={(e) => set(i, { volumePct: Number(e.target.value) })} /></Labeled>
              <Labeled label="Handle time %"><input type="number" className={fieldCls} value={d.ahtPct} onChange={(e) => set(i, { ahtPct: Number(e.target.value) })} /></Labeled>
              <Labeled label="Shrinkage %"><input type="number" min={0} max={90} className={fieldCls} value={d.shrinkage} placeholder={String(group.shrinkagePercent)} onChange={(e) => set(i, { shrinkage: e.target.value })} /></Labeled>
              <Labeled label="Service level %"><input type="number" min={1} max={99} className={fieldCls} value={d.serviceLevel} placeholder={String(group.serviceLevelGoal)} onChange={(e) => set(i, { serviceLevel: e.target.value })} /></Labeled>
              <div className="flex items-end gap-2">
                <Labeled label="Occupancy cap %"><input type="number" min={31} max={100} className={fieldCls} value={d.occupancyCap} placeholder={String(group.targetOccupancy)} onChange={(e) => set(i, { occupancyCap: e.target.value })} /></Labeled>
                <button aria-label="Remove scenario" className="mb-2 text-subtle-foreground hover:text-critical" onClick={() => setDrafts((x) => x.filter((_, j) => j !== i))}><Trash2 className="size-4" /></button>
              </div>
              {can("forecast:create") && <div className="col-span-2 md:col-span-7"><button className="text-[12px] text-muted-foreground underline" onClick={() => save(d)}>Save this scenario with the forecast</button></div>}
            </div>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-3 px-6 pb-4">
          <OutlineButton onClick={() => setDrafts((d) => [...d, blank(`Scenario ${d.length + 1}`)])} disabled={drafts.length >= 5}><Plus className="size-3.5" /> Add scenario</OutlineButton>
          <PrimaryButton onClick={compare} disabled={busy || !drafts.length}>Compare with baseline</PrimaryButton>
          {busy && <Busy text="Calculating staffing for each scenario…" />}
        </div>
        {saved.data && saved.data.length > 0 && (
          <div className="flex flex-wrap items-center gap-2 px-6 pb-5 text-[12px]">
            <span className="text-subtle-foreground">Saved:</span>
            {saved.data.map((s) => (
              <span key={s.id} className="inline-flex items-center gap-1.5 rounded-full border bg-background px-2.5 py-1">
                <button className="font-medium hover:underline" onClick={() => setDrafts((d) => (d.length < 5 ? [...d, fromParams(s.name, s.params)] : d))}>{s.name}</button>
                {can("forecast:create") && <button aria-label={`Delete ${s.name}`} className="text-subtle-foreground hover:text-critical" onClick={async () => { await api(`/forecast/scenarios/${s.id}`, { method: "DELETE" }); setTick((t) => t + 1); }}>×</button>}
              </span>
            ))}
          </div>
        )}
      </Section>

      {result && (
        <>
          <Section title="Result">
            <p className="px-6 pb-3 text-[12px] text-subtle-foreground">{result.window.from} to {result.window.to}{short ? ". Short-term what-ifs cover up to four weeks of the forecast." : ""}</p>
            <RefTable right={[1, 2, 3, 4, 5, 6, 7]} head={["Scenario", "Contacts", "Agent hours", "Agents needed (FTE)", "vs baseline", "Peak agents", "Service level", "Occupancy"]}>
              {result.results.map((r, i) => (
                <tr key={i} className={`border-b ${i === 0 ? "bg-surface font-medium" : ""}`}>
                  <td className="px-6 py-3">{r.name}</td>
                  <td className="px-6 py-3 text-right">{int(r.volume)}</td>
                  <td className="px-6 py-3 text-right">{int(r.agentHours)}</td>
                  <td className="px-6 py-3 text-right font-semibold">{dec(r.fte, 1)}</td>
                  <td className={`px-6 py-3 text-right ${r.impactRequiredFteDelta > 0 ? "text-critical" : r.impactRequiredFteDelta < 0 ? "text-success" : ""}`}>{i === 0 ? "—" : `${r.impactRequiredFteDelta > 0 ? "+" : ""}${dec(r.impactRequiredFteDelta, 1)} FTE`}</td>
                  <td className="px-6 py-3 text-right">{r.peakRequired ?? "–"}</td>
                  <td className="px-6 py-3 text-right">{r.serviceLevel === null ? "–" : pct(r.serviceLevel, 1)}</td>
                  <td className="px-6 py-3 text-right">{r.occupancy === null ? "–" : pct(r.occupancy)}</td>
                </tr>
              ))}
            </RefTable>
          </Section>
          <Section title="Agent hours per day">
            <div className="h-64 px-4 pb-6">
              <ResponsiveContainer width="100%" height="100%">
                <ComposedChart data={chart} margin={{ top: 8, right: 16, bottom: 0, left: 0 }}>
                  <CartesianGrid vertical={false} stroke="var(--color-border)" />
                  <XAxis dataKey="day" tickLine={false} axisLine={false} fontSize={12} minTickGap={16} />
                  <YAxis tickLine={false} axisLine={false} fontSize={12} width={48} />
                  <Tooltip content={<ScenarioTip names={result.results.map((r) => r.name)} />} />
                  <Legend wrapperStyle={{ fontSize: 12 }} formatter={(_v, e: any) => result.results[Number(String(e.dataKey).slice(1))]?.name} />
                  {result.results.map((_, k) => <Line key={k} dataKey={`s${k}`} stroke={COLORS[k % COLORS.length]} strokeWidth={2} strokeDasharray={k === 0 ? undefined : "5 3"} dot={false} isAnimationActive={false} />)}
                </ComposedChart>
              </ResponsiveContainer>
            </div>
          </Section>
        </>
      )}
    </>
  );
}

function ScenarioTip({ active, payload, label, names }: any) {
  if (!active || !payload?.length) return null;
  return (
    <div className="num rounded-md border bg-popover px-3 py-2 text-[12px] shadow-sm">
      <div className="mb-1 font-semibold">{label}</div>
      {payload.map((p: any) => (
        <div key={p.dataKey} className="flex items-center justify-between gap-6">
          <span className="text-muted-foreground">{names[Number(String(p.dataKey).slice(1))]}</span>
          <span className="font-medium">{Math.round(p.value)}</span>
        </div>
      ))}
    </div>
  );
}
