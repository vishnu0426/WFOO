/**
 * Scenarios: "what if" cases set against the baseline, side by side. Pick a starting point (+10% volume, +15 s handle time, shrinkage 25%, holiday week, or one saved with the forecast);
 * each scenario becomes a column next to the baseline. The answer comes first (a sentence per scenario, then agents needed, service level and cost), what the scenario changes sits
 * underneath. The comparison is worked out again by itself a moment after anything is typed, so there is no Compare button. With no scenario yet, the baseline is shown as a few tiles.
 */
import React, { useEffect, useRef, useState } from "react";
import { CartesianGrid, ComposedChart, Legend, Line, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { Check, Plus, Trash2 } from "lucide-react";
import { api, dec, int, pct } from "../../services/api";
import { useForecast } from "../../services/forecastStore";
import { useApi } from "./hooks";
import { CHART } from "./charts";
import { Busy } from "./ui";
import { OutlineButton, Section } from "../wfm/app-shell";
import { Notice, RefScope, fieldCls } from "./RefScope";
import { MAX_SCENARIOS, PRESETS, blank, deltaText, fromParams, headline, money, moneyDelta, problemWith, scenarioKey, toParams, type Draft, type Params } from "../../services/scenarioForm";

type Saved = { id: string; name: string; description: string; params: Params };
type Result = { name: string; params: Params; volume: number; agentHours: number; fte: number; peakRequired: number | null; serviceLevel: number | null; occupancy: number | null; warnIntervals: number; impactRequiredFteDelta: number; impactServiceLevelDelta: number | null; cost: number | null; impactCostDelta: number | null; daily: { day: string; agentHours: number }[] };
type Compare = { window: { from: string; to: string }; costPerHour: number | null; currency: string; avgAhtSec: number; results: Result[] };
const COLORS = [CHART.baseline, CHART.forecast, CHART.agents, CHART.reforecast, CHART.actual, CHART.bad];
const LABEL_W = 190, COL_W = 170;

export function ScenariosSection() {
  return (
    <RefScope crumb="Scenarios" title="Scenarios" description="Compare “what if” cases against the forecast: more contacts, longer calls, different targets.">
      {(version) => <Body version={version} />}
    </RefScope>
  );
}

function Body({ version }: { version: { id: string; name: string; rev: number; kind: string } }) {
  const { group, can, setNotice, reloadGroups } = useForecast();
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [tick, setTick] = useState(0);
  const saved = useApi<Saved[]>(`/forecast/versions/${version.id}/scenarios`, [tick]);
  // the answer is kept with the scenarios it was worked out for, so a column never shows another scenario's numbers while a new answer is on its way
  const [answer, setAnswer] = useState<{ keys: string[]; data: Compare } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [costTick, setCostTick] = useState(0);
  const [editCost, setEditCost] = useState(false);
  const [cost, setCost] = useState("");
  const seq = useRef(0);
  useEffect(() => { setAnswer(null); setError(""); }, [version.id]);

  const keys = drafts.map(scenarioKey);
  const problem = drafts.map(problemWith).find(Boolean) ?? "";
  useEffect(() => {
    if (problem) { setBusy(false); return undefined; }
    const mine = ++seq.current;
    setBusy(true);
    const t = setTimeout(async () => {
      try {
        const data = await api<Compare>(`/forecast/versions/${version.id}/scenarios/compare`, { method: "POST", body: { scenarios: drafts.map((d) => ({ name: d.name.trim() || "Scenario", params: toParams(d) })) } });
        if (mine === seq.current) { setAnswer({ keys, data }); setError(""); }
      } catch (e: any) { if (mine === seq.current) setError(e.message); }
      finally { if (mine === seq.current) setBusy(false); }
    }, 450);
    return () => clearTimeout(t);
  }, [version.id, version.rev, keys.join("|"), costTick, problem]);          // eslint-disable-line react-hooks/exhaustive-deps
  if (!group) return null;
  const groupShrink = group.shrinkageEffectivePercent ?? group.shrinkagePercent;

  const full = drafts.length >= MAX_SCENARIOS;
  const add = (d: Draft) => setDrafts((cur) => (cur.length >= MAX_SCENARIOS ? cur : [...cur, d]));
  const set = (i: number, patch: Partial<Draft>) => setDrafts((d) => d.map((x, j) => (j === i ? { ...x, ...patch } : x)));
  const save = async (d: Draft) => {
    try { await api(`/forecast/versions/${version.id}/scenarios`, { method: "POST", body: { name: d.name.trim() || "Scenario", params: toParams(d) } }); setTick((t) => t + 1); setNotice({ kind: "ok", text: `Saved “${d.name}” with this forecast.` }); }
    catch (e: any) { setNotice({ kind: "err", text: e.message }); }
  };
  const saveCost = async () => {
    const v = cost.trim() === "" ? null : Number(cost);
    if (v !== null && (!Number.isFinite(v) || v < 0)) { setError("Cost per agent hour must be zero or more."); return; }
    try { await api(`/config/groups/${group.id}`, { method: "PUT", body: { agentCostPerHour: v } }); await reloadGroups?.(); setCostTick((t) => t + 1); setEditCost(false); setCost(""); setNotice({ kind: "ok", text: v === null ? "Cost per agent hour cleared." : "Cost per agent hour saved." }); }
    catch (e: any) { setError(e.message); }
  };

  const data = answer?.data ?? null;
  const base = data?.results[0] ?? null;
  const cur = data?.currency ?? "USD";
  const hasCost = !!data && data.costPerHour !== null;
  const short = version.kind === "SHORT";
  /** The result for a scenario column, if the answer on screen was worked out for exactly this scenario. */
  const resultFor = (i: number): Result | null => { const at = answer ? answer.keys.indexOf(keys[i]) : -1; return answer && at >= 0 ? answer.data.results[at + 1] : null; };
  const shown = drafts.map((_, i) => resultFor(i));
  const chartRows = data?.results ?? [];
  const chart = base ? base.daily.map((d, i) => ({ day: d.day.slice(5), ...Object.fromEntries(chartRows.map((r, k) => [`s${k}`, r.daily[i]?.agentHours ?? null])) })) : [];

  const cell = "px-3 py-2 text-right num whitespace-nowrap";
  const label = "px-4 py-2 text-left text-[13px] whitespace-nowrap";
  const num = (v: number | null | undefined, f: (n: number) => string) => (v === null || v === undefined ? "–" : f(v));
  const tone = (v: number | null | undefined, goodWhenLow = true) => (v === null || v === undefined || Math.round(v * 10) === 0 ? "" : (v > 0) === goodWhenLow ? "text-critical" : "text-success");

  // the result rows, written once: what it is, the baseline's value, and each scenario's
  const resultRows: { id: string; label: string; strong?: boolean; sub?: boolean; base: React.ReactNode; of: (r: Result) => React.ReactNode; tone?: (r: Result) => string; show: boolean }[] = [
    { id: "fte", label: "Agents needed (FTE)", strong: true, base: dec(base?.fte ?? 0, 1), of: (r) => dec(r.fte, 1), show: true },
    { id: "fte-delta", label: "vs baseline", sub: true, base: "—", of: (r) => deltaText(r.impactRequiredFteDelta, "FTE"), tone: (r) => tone(r.impactRequiredFteDelta), show: true },
    { id: "sl", label: "Service level", base: num(base?.serviceLevel, (v) => pct(v, 1)), of: (r) => num(r.serviceLevel, (v) => pct(v, 1)), show: true },
    { id: "sl-delta", label: "vs baseline", sub: true, base: "—", of: (r) => deltaText(r.impactServiceLevelDelta, "pts"), tone: (r) => tone(r.impactServiceLevelDelta, false), show: base?.serviceLevel != null },
    { id: "cost", label: "Staffing cost", base: money(base?.cost, cur), of: (r) => money(r.cost, cur), show: hasCost },
    { id: "cost-delta", label: "vs baseline", sub: true, base: "—", of: (r) => moneyDelta(r.impactCostDelta, cur), tone: (r) => tone(r.impactCostDelta), show: hasCost },
    { id: "hours", label: "Agent hours", base: int(base?.agentHours ?? 0), of: (r) => int(r.agentHours), show: true },
    { id: "volume", label: "Contacts", base: int(base?.volume ?? 0), of: (r) => int(r.volume), show: true },
    { id: "peak", label: "Peak agents", base: base?.peakRequired ?? "–", of: (r) => r.peakRequired ?? "–", show: short },
    { id: "occ", label: "Occupancy", base: num(base?.occupancy, (v) => pct(v)), of: (r) => num(r.occupancy, (v) => pct(v)), show: short },
  ];
  const baseText = (v: string) => <span className="text-muted-foreground">{v}</span>;
  const tableWidth = LABEL_W + COL_W * (1 + drafts.length);

  const costEditor = (
    <div className="flex flex-wrap items-center gap-2 text-[13px]" data-testid="cost-editor">
      <label className="flex items-center gap-2"><span className="text-subtle-foreground">One agent hour costs ({cur})</span>
        <input type="number" min={0} autoFocus aria-label="Cost per agent hour" className={`${fieldCls} w-24`} value={cost} placeholder={data?.costPerHour != null ? String(data.costPerHour) : "e.g. 28"} onChange={(e) => setCost(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") void saveCost(); if (e.key === "Escape") setEditCost(false); }} /></label>
      <OutlineButton onClick={() => void saveCost()} disabled={cost.trim() === "" && data?.costPerHour == null}>{cost.trim() === "" ? "Clear rate" : "Save"}</OutlineButton>
      <button type="button" className="text-[12px] text-muted-foreground underline" onClick={() => { setEditCost(false); setCost(""); }}>Cancel</button>
      <span className="text-[12px] text-muted-foreground">Cost is agent hours times this rate. It is saved on the group.</span>
    </div>
  );
  const rateLink = (text: string) => can("config:write")
    ? <button type="button" data-testid="set-cost" className="text-[13px] font-medium underline" onClick={() => { setEditCost(true); setCost(data?.costPerHour != null ? String(data.costPerHour) : ""); }}>{text}</button>
    : <span className="text-[12px] text-muted-foreground">No rate set</span>;

  return (
    <div className="max-w-[1160px]">
      {error && <Notice kind="err" onClose={() => setError("")}>{error}</Notice>}
      <Section title="What if…" action={busy ? <Busy text="Working it out…" /> : undefined}>
        <p className="px-6 pb-3 text-[13px] text-muted-foreground">Pick a starting point, then change anything in its column. The answer updates as you type.</p>
        <div className="flex flex-wrap items-center gap-2 px-6 pb-4" role="group" aria-label="Start from">
          <span className="text-[12px] text-subtle-foreground">Start from</span>
          {PRESETS.map((p) => {
            const used = keys.includes(scenarioKey(p.make()));
            return (
              <button key={p.id} type="button" data-testid={`preset-${p.id}`} aria-pressed={used} disabled={full || used} onClick={() => add(p.make())}
                className={`inline-flex h-8 items-center gap-1 rounded-full border px-3 text-[13px] font-medium ${used ? "bg-surface text-muted-foreground" : "bg-background hover:bg-surface"} disabled:opacity-60`}>{used && <Check className="size-3.5" />}{p.label}</button>
            );
          })}
          {(saved.data ?? []).map((s) => (
            <span key={s.id} className="inline-flex h-8 items-center gap-1.5 rounded-full border bg-background pl-3 pr-2 text-[13px]" data-testid="saved-chip">
              <button type="button" disabled={full} className="font-medium hover:underline disabled:opacity-50" title="Saved with this forecast" onClick={() => add(fromParams(s.name, s.params))}>{s.name}</button>
              {can("forecast:create") && <button type="button" aria-label={`Delete ${s.name}`} className="text-subtle-foreground hover:text-critical" onClick={async () => { await api(`/forecast/scenarios/${s.id}`, { method: "DELETE" }); setTick((t) => t + 1); }}>×</button>}
            </span>
          ))}
          <OutlineButton onClick={() => add(blank(`Scenario ${drafts.length + 1}`))} disabled={full}><Plus className="size-3.5" /> Blank scenario</OutlineButton>
          {full && <span className="text-[12px] text-muted-foreground">Up to {MAX_SCENARIOS} scenarios at a time.</span>}
        </div>
        {problem && <p className="px-6 pb-3 text-[13px] text-critical" role="alert">{problem}</p>}
      </Section>

      <Section title={drafts.length ? "Against the baseline" : "The baseline"}>
        {!base && !error && <p className="px-6 pb-6 text-[13px] text-muted-foreground" role="status">Working out the baseline…</p>}
        {data && <p className="px-6 pb-3 text-[12px] text-subtle-foreground">{version.name} · {data.window.from} to {data.window.to}{short ? ". Short-term what-ifs cover up to four weeks of the forecast." : ""}</p>}

        {/* no scenario yet: the baseline as tiles, and an invitation */}
        {base && !drafts.length && (
          <div className="space-y-4 px-6 pb-6">
            <div className="grid grid-cols-2 gap-3 md:grid-cols-4" data-testid="baseline-tiles">
              <Tile label="Agents needed (FTE)" value={dec(base.fte, 1)} />
              <Tile label="Service level" value={num(base.serviceLevel, (v) => pct(v, 1))} sub={`goal ${group.serviceLevelGoal}% in ${group.serviceLevelThresholdSec} s`} />
              {short ? <Tile label="Peak agents" value={String(base.peakRequired ?? "–")} /> : <Tile label="Agent hours" value={int(base.agentHours)} />}
              <Tile label="Staffing cost" value={hasCost ? money(base.cost, cur) : "–"} sub={hasCost ? undefined : "no rate set"} action={rateLink(hasCost ? "Change rate" : "Set cost per hour")} />
            </div>
            {editCost && costEditor}
            <button type="button" data-testid="add-scenario" onClick={() => add(blank("Scenario 1"))} className="flex h-20 w-full items-center justify-center gap-2 rounded-lg border-2 border-dashed text-[13px] font-medium text-muted-foreground hover:bg-surface">
              <Plus className="size-4" /> Add a scenario to compare with this baseline
            </button>
          </div>)}

        {base && drafts.length > 0 && (
          <>
            <div className="mx-6 mb-4 space-y-1 rounded-lg bg-surface px-4 py-3 text-[14px]" data-testid="headline" aria-live="polite">
              {drafts.map((d, i) => { const r = shown[i]; return <div key={i} className="flex items-center gap-2"><span aria-hidden className="inline-block size-2.5 shrink-0 rounded-full" style={{ background: COLORS[(i + 1) % COLORS.length] }} />{r ? headline(d.name.trim() || "Scenario", r, base.fte, cur) : <span className="text-muted-foreground">{d.name.trim() || "Scenario"}: working it out…</span>}</div>; })}
            </div>
            <div className={`overflow-x-auto pb-2 transition-opacity ${busy ? "opacity-70" : ""}`} data-testid="scenario-table">
              <table className="table-fixed border-collapse text-[13px]" style={{ width: tableWidth }}>
                <colgroup><col style={{ width: LABEL_W }} /><col style={{ width: COL_W }} />{drafts.map((_, i) => <col key={i} style={{ width: COL_W }} />)}</colgroup>
                <thead>
                  <tr className="border-y bg-surface">
                    <th scope="col" className={label}><span className="sr-only">Measure</span></th>
                    <th scope="col" className="px-3 py-2 text-right align-bottom font-medium"><span className="block text-[11px] font-normal uppercase tracking-wide text-subtle-foreground">Baseline</span><span className="block truncate" title={version.name}>{version.name}</span></th>
                    {drafts.map((d, i) => (
                      <th key={i} scope="col" className="px-2 py-2 text-left align-bottom font-medium">
                        <div className="flex items-center gap-1">
                          <span aria-hidden className="inline-block size-2.5 shrink-0 rounded-full" style={{ background: COLORS[(i + 1) % COLORS.length] }} />
                          <input aria-label={`Scenario ${i + 1} name`} className={`${fieldCls} min-w-0 font-medium`} value={d.name} onChange={(e) => set(i, { name: e.target.value })} />
                          <button type="button" aria-label={`Remove ${d.name || "scenario"}`} className="shrink-0 text-subtle-foreground hover:text-critical" onClick={() => setDrafts((x) => x.filter((_, j) => j !== i))}><Trash2 className="size-4" /></button>
                        </div>
                      </th>))}
                  </tr>
                </thead>
                <tbody>
                  {resultRows.filter((r) => r.show).map((r) => (
                    <React.Fragment key={r.id}>
                      <tr className={`border-b ${r.strong ? "font-semibold" : ""}`} data-row={r.id}>
                        <th scope="row" className={`${label} ${r.sub ? "pl-8 text-[12px] font-normal text-subtle-foreground" : r.strong ? "" : "font-normal"}`}>{r.label}</th>
                        <td className={cell}>{r.base}</td>
                        {shown.map((x, i) => <td key={i} className={`${cell} ${x && r.tone ? r.tone(x) : ""}`}>{x ? r.of(x) : "…"}</td>)}
                      </tr>
                      {r.id === "cost" && (
                        <tr className="border-b"><td colSpan={2 + drafts.length} className="px-4 py-1.5">{editCost ? costEditor : <span className="text-[12px] text-muted-foreground">Agent hours times {money(data?.costPerHour, cur)} an hour. {rateLink("Change rate")}</span>}</td></tr>)}
                    </React.Fragment>))}
                  {!hasCost && (
                    <tr className="border-b"><th scope="row" className={`${label} font-normal`}>Staffing cost</th><td colSpan={1 + drafts.length} className="px-3 py-2 text-left">{editCost ? costEditor : rateLink("Set cost per hour to see it")}</td></tr>)}

                  <tr className="border-b bg-surface"><th scope="rowgroup" colSpan={2 + drafts.length} className="px-4 py-1.5 text-left text-[11px] font-semibold uppercase tracking-wide text-subtle-foreground">Change this</th></tr>
                  <tr className="border-b">
                    <th scope="row" className={`${label} font-normal`}>Volume %</th><td className={cell}>{baseText("as forecast")}</td>
                    {drafts.map((d, i) => <td key={i} className="px-2 py-2"><input type="number" aria-label={`${d.name} volume %`} className={fieldCls} value={d.volumePct} onChange={(e) => set(i, { volumePct: Number(e.target.value) })} /></td>)}
                  </tr>
                  <tr className="border-b">
                    <th scope="row" className={`${label} font-normal`}>Handle time</th><td className={cell}>{baseText(data ? `${data.avgAhtSec} s average` : "as forecast")}</td>
                    {drafts.map((d, i) => (
                      <td key={i} className="px-2 py-2">
                        <div className="flex gap-1">
                          <input type="number" aria-label={`${d.name} handle time change`} className={`${fieldCls} min-w-0`} value={d.aht} onChange={(e) => set(i, { aht: Number(e.target.value) })} />
                          <select aria-label={`${d.name} handle time unit`} className="h-9 rounded-lg border bg-background px-1 text-[13px]" value={d.ahtUnit} onChange={(e) => set(i, { ahtUnit: e.target.value as "pct" | "sec" })}><option value="pct">%</option><option value="sec">sec</option></select>
                        </div>
                      </td>))}
                  </tr>
                  <tr className="border-b">
                    <th scope="row" className={`${label} font-normal`}>Shrinkage %</th><td className={cell}>{baseText(`${groupShrink}%`)}</td>
                    {drafts.map((d, i) => <td key={i} className="px-2 py-2"><input type="number" min={0} max={90} aria-label={`${d.name} shrinkage %`} className={fieldCls} value={d.shrinkage} placeholder={String(groupShrink)} onChange={(e) => set(i, { shrinkage: e.target.value })} /></td>)}
                  </tr>
                  <tr className="border-b">
                    <th scope="row" className={`${label} font-normal`}>Service level %</th><td className={cell}>{baseText(`${group.serviceLevelGoal}%`)}</td>
                    {drafts.map((d, i) => <td key={i} className="px-2 py-2"><input type="number" min={1} max={99} aria-label={`${d.name} service level %`} className={fieldCls} value={d.serviceLevel} placeholder={String(group.serviceLevelGoal)} onChange={(e) => set(i, { serviceLevel: e.target.value })} /></td>)}
                  </tr>
                  <tr className="border-b">
                    <th scope="row" className={`${label} font-normal`}>Occupancy cap %</th><td className={cell}>{baseText(`${group.targetOccupancy}%`)}</td>
                    {drafts.map((d, i) => <td key={i} className="px-2 py-2"><input type="number" min={31} max={100} aria-label={`${d.name} occupancy cap %`} className={fieldCls} value={d.occupancyCap} placeholder={String(group.targetOccupancy)} onChange={(e) => set(i, { occupancyCap: e.target.value })} /></td>)}
                  </tr>
                  {can("forecast:create") && (
                    <tr>
                      <th scope="row" className={label}><span className="sr-only">Save</span></th><td />
                      {drafts.map((d, i) => <td key={i} className="px-2 py-2 text-left"><button type="button" className="text-[12px] text-muted-foreground underline" onClick={() => save(d)}>Save with the forecast</button></td>)}
                    </tr>)}
                </tbody>
              </table>
            </div>
            <p className="px-6 pb-4 pt-1 text-[11px] text-subtle-foreground">A blank target keeps the group's own setting, shown in the Baseline column.</p>
          </>)}
      </Section>

      {base && drafts.length > 0 && (
        <Section title="Agent hours per day">
          <div className="h-64 px-4 pb-6">
            <ResponsiveContainer width="100%" height="100%">
              <ComposedChart data={chart} margin={{ top: 8, right: 16, bottom: 0, left: 0 }}>
                <CartesianGrid vertical={false} stroke="var(--color-border)" />
                <XAxis dataKey="day" tickLine={false} axisLine={false} fontSize={12} minTickGap={16} />
                <YAxis tickLine={false} axisLine={false} fontSize={12} width={48} />
                <Tooltip content={<ScenarioTip names={chartRows.map((r) => r.name)} />} />
                <Legend wrapperStyle={{ fontSize: 12 }} formatter={(_v, e: any) => chartRows[Number(String(e.dataKey).slice(1))]?.name} />
                {chartRows.map((_, k) => <Line key={k} dataKey={`s${k}`} stroke={COLORS[k % COLORS.length]} strokeWidth={2} strokeDasharray={k === 0 ? undefined : "5 3"} dot={false} isAnimationActive={false} />)}
              </ComposedChart>
            </ResponsiveContainer>
          </div>
        </Section>)}
    </div>
  );
}

function Tile({ label, value, sub, action }: { label: string; value: string; sub?: string; action?: React.ReactNode }) {
  return (
    <div className="rounded-lg border bg-background px-4 py-3">
      <div className="text-[12px] text-subtle-foreground">{label}</div>
      <div className="num text-[22px] font-semibold leading-tight">{value}</div>
      {sub && <div className="text-[12px] text-muted-foreground">{sub}</div>}
      {action && <div className="mt-1">{action}</div>}
    </div>
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
