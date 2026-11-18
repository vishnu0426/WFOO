/**
 * Forecast Builder: the reference screen (sectioned form on the left, live preview on the right) wired to the gateway.
 * Scope, period and model create a real forecast version; the preview is a typical day from recent history at the group's targets
 * (/forecast/preview). Service parameters are shown read-only because they belong to the WFM group (Configuration › WFM Groups).
 * Below: a what-if for one interval and the special events the models learn from.
 */
import { Waiting } from '../common/loading';
import React, { useEffect, useRef, useState } from "react";
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { Plus, Sparkles, Trash2, Wand2 } from "lucide-react";
import { addDays, api, CHANNEL_LABEL, DOW, dayYear, dec, fmtDate, int, MODEL_LABEL, pct, type VersionMeta } from "../../services/api";
import { dayCount, defaultHistory, publishLines, queueDaysIn } from "../../services/liveForecasts";
import { fmtLong, fmtShortDay, lengthText } from "../../services/dateRange";
import { DateRangeField } from "../common/DateRangeField";
import { Segmented } from "./RefScope";
import { HelpTip } from "../common/HelpTip";
import { useForecast } from "../../services/forecastStore";
import { useApi, useVersionFull } from "./hooks";
import { HistoryHealth } from "./HistoryHealth";
import { EventsCalendar } from "./EventsCalendar";
import { SectionNav, StickyFooter, useScrollSpy, type FormSection } from "./FormIndex";
import { createBlockers, footerNote, goalSentence, occupancySentence, pickRange, shrinkageSentence, type FindingSummary } from "../../services/forecastForm";
import { ChartTooltip } from "./ChartTooltip";
import { Banner, Btn, Busy, Card, Empty, Field as StackField, Input as PlainInput, Pill, Select as PlainSelect, Table } from "./ui";
import { OutlineButton, PageHeader, PrimaryButton, Section, StatusPill } from "../wfm/app-shell";

type Coverage = { queueId: string; name: string; channel: string; firstDay: string | null; lastDay: string | null; days: number; intervals: number; missingIntervals: number };
type EventRow = { id: string; groupName: string | null; queueName: string | null; name: string; kind: string; startDay: string; endDay: string; upliftPct: number; leadDays: number; lagDays: number };
type Preview =
  | { ready: false; reason: string }
  | {
    ready: true; staffing?: { intervals: number; targetNotMet: number; methodFallback: number; lowConfidence: number }; dow: number; aht: number | null; ahtHistory: number | null; basis: { from: string; to: string; weeks: number };
    slots: { slot: number; volume: number; required: number; onPhones: number }[];
    day: { volume: number; peakRequired: number; agentHours: number }; week: { volume: number; agentHours: number; fte: number };
    targets: { serviceLevel: number; answerSec: number; occupancyCap: number; shrinkage: number; method: string; fteHoursWeek: number };
  };

/** The value, but only after it has stopped changing for a moment (so typing does not fire a request per keystroke). */
function useDebounced<T>(value: T, ms = 450): T {
  const [v, setV] = useState(value);
  useEffect(() => { const t = setTimeout(() => setV(value), ms); return () => clearTimeout(t); }, [JSON.stringify(value), ms]);
  return v;
}

function Field({ label, hint, tip, children }: { label: string; hint?: React.ReactNode; tip?: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-1 items-start gap-x-6 gap-y-1.5 border-b px-6 py-3.5 md:grid-cols-[220px_1fr]">
      <div>
        <div className="text-[13px] font-medium">{label}{tip && <HelpTip title={label} text={tip} />}</div>
        {hint && <div className="text-[12px] text-subtle-foreground">{hint}</div>}
      </div>
      <div className="max-w-xl">{children}</div>
    </div>
  );
}

const input = "w-full rounded-md border bg-background px-2.5 py-1.5 text-[13px] outline-none transition-colors focus:border-border-strong disabled:bg-surface disabled:text-muted-foreground";

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="px-6 py-3">
      <div className="text-[12px] text-subtle-foreground">{label}</div>
      <div className="mt-0.5 text-[20px] font-semibold">{value}</div>
    </div>
  );
}

function Chip({ label, on, onClick, disabled, title }: { label: string; on: boolean; onClick?: () => void; disabled?: boolean; title?: string }) {
  return (
    <button
      type="button" onClick={onClick} disabled={disabled} title={title}
      className={`rounded-md border px-2.5 py-1 text-[13px] transition-colors ${on ? "border-border-strong bg-surface-subtle font-medium" : "text-muted-foreground hover:bg-surface"} ${disabled ? "cursor-not-allowed opacity-50" : ""}`}
    >
      {label}
    </button>
  );
}

/** The shrinkage staffing really uses: the group's categories added up when it has any, otherwise its flat percentage. */
const shrinkOf = (g: { shrinkagePercent: number; shrinkageEffectivePercent?: number }) => g.shrinkageEffectivePercent ?? g.shrinkagePercent;

export function BuilderSection() {
  const { groups, group, setGroupId, version, can, reload, go, setNotice } = useForecast();
  const [name, setName] = useState("");
  const [kind, setKind] = useState<"SHORT" | "LONG">("SHORT");
  const [hStart, setHStart] = useState("");
  const [hEnd, setHEnd] = useState("");
  const [model, setModel] = useState("auto");
  const [advanced, setAdvanced] = useState(false);
  const [dow, setDow] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  // the service parameters start at the group's saved targets; changing them re-runs the preview (the forecast keeps the group's targets)
  type WhatIf = { sl: number; answer: number; occ: number; shrink: number; aht: number | null };
  const [wi, setWi] = useState<WhatIf>({ sl: 80, answer: 20, occ: 85, shrink: 30, aht: null });
  useEffect(() => {
    if (group) setWi({ sl: group.serviceLevelGoal, answer: group.serviceLevelThresholdSec, occ: group.targetOccupancy, shrink: shrinkOf(group), aht: null });
  }, [group?.id, group?.serviceLevelGoal, group?.serviceLevelThresholdSec, group?.targetOccupancy, group?.shrinkagePercent, group?.shrinkageEffectivePercent]);
  const wiD = useDebounced(wi);

  // the horizon opens as six weeks (short-term) or a year (long-term) from today
  useEffect(() => {
    const today = fmtDate(new Date());
    setHStart(today);
    setHEnd(addDays(today, kind === "SHORT" ? 6 * 7 - 1 : 364));
  }, [kind]);
  useEffect(() => { setModel(group?.model ?? "auto"); setAdvanced(false); setDow(null); }, [group?.id]);

  const coverage = useApi<Coverage[]>("/data/coverage");
  const mine = (coverage.data ?? []).filter((c) => group?.queueIds.includes(c.queueId));
  const shortest = mine.length ? Math.min(...mine.map((c) => c.days)) : 0;
  const firstDay = mine.map((c) => c.firstDay).filter(Boolean).sort()[0] ?? "";
  const lastDay = mine.map((c) => c.lastDay).filter(Boolean).sort().at(-1) ?? "";
  const histEnd = lastDay && lastDay > addDays(fmtDate(new Date()), -1) ? addDays(fmtDate(new Date()), -1) : lastDay;      // history never reaches today, whatever dates the data has
  // the history the models learn from: opens as the last 12 months that have data, and can be changed
  const [histFrom, setHistFrom] = useState("");
  const [histTo, setHistTo] = useState("");
  const histKey = `${group?.id}|${firstDay}|${lastDay}`;
  useEffect(() => {
    const d = defaultHistory(mine, fmtDate(new Date()));
    setHistFrom(d?.from ?? ""); setHistTo(d?.to ?? "");
  }, [histKey]);
  const everyForGroup = useApi<VersionMeta[]>(group ? `/forecast/versions?groupId=${group.id}` : null, [group?.id]);
  const previewUrl = group ? `/forecast/preview?groupId=${group.id}${dow !== null ? `&dow=${dow}` : ""}&sl=${wiD.sl}&answer=${wiD.answer}&occ=${wiD.occ}&shrink=${wiD.shrink}${wiD.aht ? `&aht=${wiD.aht}` : ""}` : null;
  const preview = useApi<Preview>(previewUrl, [previewUrl]);
  const last = useVersionFull(version && group && version.wfmGroupId === group.id ? version : null).full;
  const lastSeries = last?.summary?.series?.[0];
  const lastPick = lastSeries?.scores.find((s) => s.selected);
  const [fsum, setFsum] = useState<FindingSummary | null>(null);                      // what the history check found, for the section index and the footer
  const spyRef = useRef<HTMLDivElement>(null);
  const spy = useScrollSpy(["scope", "period", "service", "model", "history", "events"], spyRef);

  if (!group) return <Empty title="No WFM group yet">Create one under Configuration › WFM Groups, then import interval history.</Empty>;

  // the horizon dates turn into "weeks ahead" (short-term) or "days ahead" (long-term)
  const daysAhead = hStart && hEnd ? Math.round((new Date(hEnd + "T00:00:00").getTime() - new Date(hStart + "T00:00:00").getTime()) / 864e5) + 1 : 0;
  const weeks = Math.ceil(daysAhead / 7);
  const horizonProblem = kind === "SHORT" ? (weeks < 1 || weeks > 18 ? "A short-term forecast covers 1 to 18 weeks." : "") : (daysAhead < 30 || daysAhead > 730 ? "A long-term forecast covers 30 to 730 days." : "");

  const histProblem = !histFrom || !histTo ? "" : histFrom > histTo ? "The history ends before it starts." : histTo >= fmtDate(new Date()) ? "The history must end before today." : dayCount(histFrom, histTo) < 7 ? "Choose at least 7 days of history." : "";
  const histQueues = histFrom && histTo && !histProblem ? queueDaysIn(mine, histFrom, histTo) : [];
  const liveShort = (everyForGroup.data ?? []).filter((v) => v.kind === "SHORT" && v.status === "PUBLISHED");
  const willPublish = kind === "SHORT" && hStart && hEnd && !horizonProblem ? publishLines({ fromDay: hStart, toDay: hEnd }, everyForGroup.data ?? []) : null;

  const todayStr = fmtDate(new Date());
  const [showEffect, setShowEffect] = useState(false);

  const create = async (openIt = true) => {
    setBusy(true); setError(""); setNotice(null);
    try {
      const body: any = { groupId: group.id, kind, model: model || undefined, name: name.trim() || undefined, fromDay: hStart || undefined, ...(histFrom && histTo && !histProblem ? { historyFrom: histFrom, historyTo: histTo } : {}) };
      if (kind === "SHORT") body.weeks = weeks; else body.days = daysAhead;
      const v = await api("/forecast/versions", { method: "POST", body });
      await reload(v.id);
      setNotice({ kind: "ok", text: `Created ${v.name}. It is a draft: check it, adjust if needed, then submit it for approval.` });
      if (openIt) go("forecast-dashboard");
    } catch (e: any) { setError(e.message); } finally { setBusy(false); }
  };

  const pv = preview.data && preview.data.ready ? preview.data : null;
  const changed = !!group && (wi.sl !== group.serviceLevelGoal || wi.answer !== group.serviceLevelThresholdSec || wi.occ !== group.targetOccupancy || wi.shrink !== shrinkOf(group) || wi.aht !== null);
  const open = pv ? pv.slots.filter((s) => s.volume > 0 || s.required > 0) : [];
  const shown = pv ? pv.slots.slice(Math.max(0, (open[0]?.slot ?? 0) - 1), (open.at(-1)?.slot ?? 95) + 2) : [];
  const chart = shown.map((s) => ({ time: `${String(Math.floor(s.slot / 4)).padStart(2, "0")}:${String((s.slot % 4) * 15).padStart(2, "0")}`, forecast: s.volume, requiredStaff: s.required }));
  const canCreate = can("forecast:create");
  const blockers = createBlockers({ canCreate, shortestHistoryDays: shortest, horizonProblem, busy });
  if (histProblem) blockers.push(histProblem);
  const sections: FormSection[] = [
    { id: "scope", label: "Scope" }, { id: "period", label: "Period", badge: horizonProblem ? { text: "Check", tone: "bad" } : null }, { id: "service", label: "Service parameters" }, { id: "model", label: "Model" },
    { id: "history", label: "History check", badge: fsum && fsum.total ? { text: String(fsum.total), tone: fsum.blocks ? "bad" : "warn" } : null },
    { id: "events", label: "Special events" },
  ];
  const summary = `${kind === "SHORT" ? "Short-term" : "Long-term"} forecast for ${group.name} · ${kind === "SHORT" ? `${weeks} week${weeks === 1 ? "" : "s"}` : `${daysAhead} days`}${hStart ? ` from ${dayYear(hStart)}` : ""} · ${model === "auto" ? "best model chosen for you" : MODEL_LABEL[model] ?? model}`;

  return (
    <div>
      <PageHeader
        breadcrumb={["Forecasting", "Forecast Builder"]}
        title="Forecast Builder"
        description="Preview the demand and staffing outcome before the forecast is created."
      />

      <div className="grid grid-cols-1 xl:grid-cols-[minmax(0,1fr)_420px]">
        <div className="border-r" ref={spyRef}>
          <SectionNav variant="strip" sections={sections} active={spy.active} onGo={spy.go} />
          <div className="2xl:grid 2xl:grid-cols-[190px_minmax(0,1fr)]">
          <SectionNav variant="rail" sections={sections} active={spy.active} onGo={spy.go} />
          <div className="min-w-0">
          <div id="sec-scope" className="scroll-mt-14"><Section title="Scope">
            <Field label="Forecast name" tip="Used exactly as typed. Left blank, it is numbered automatically.">
              <input className={input} value={name} onChange={(e) => setName(e.target.value)} maxLength={120} placeholder="e.g. April campaign plan" />
            </Field>
            <Field label="WFM group" tip="Determines the queues and the service targets.">
              <select className={input} value={group.id} onChange={(e) => setGroupId(e.target.value)} aria-label="WFM group">
                {groups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
              </select>
            </Field>
            {kind === "SHORT" && liveShort.length > 0 && (
              <Field label="Based on" tip="Start from the period of a live forecast, to make a new version of it. You can still change the dates.">
                <select className={input} aria-label="Based on" value={liveShort.find((v) => v.fromDay === hStart && v.toDay === hEnd)?.id ?? ""} onChange={(e) => { const v = liveShort.find((x) => x.id === e.target.value); if (v) { setHStart(v.fromDay); setHEnd(v.toDay); } }}>
                  <option value="">Nothing: choose the dates myself</option>
                  {liveShort.map((v) => <option key={v.id} value={v.id}>{`v${v.seq} · ${fmtLong(v.fromDay)} to ${fmtLong(v.toDay)}`}</option>)}
                </select>
              </Field>
            )}
            <Field label="Channels" tip="From the group's queues.">
              {mine.length === 0 ? <span className="text-[13px] text-subtle-foreground">No queues in this group yet</span> : (
                <div className="flex flex-wrap gap-1.5">
                  {[...new Set(mine.map((c) => c.channel))].map((c) => <Chip key={c} label={CHANNEL_LABEL[c] ?? c} on />)}
                </div>
              )}
            </Field>
            <Field label="Queues" tip="The history each queue has to learn from.">
              <div className="flex flex-wrap gap-1.5">
                {mine.map((c) => {
                  const shown = Math.min(c.days, c.lastDay && c.firstDay && histEnd ? dayCount(c.firstDay, c.lastDay > histEnd ? histEnd : c.lastDay) : c.days);
                  return (
                    <span key={c.queueId} className="rounded-md border bg-surface px-2.5 py-1 text-[13px]" title={c.missingIntervals ? `${int(c.missingIntervals)} intervals missing` : undefined}>
                      {c.name} <span className="text-subtle-foreground">· {shown} days</span>
                    </span>
                  );
                })}
              </div>
            </Field>
          </Section></div>

          <div id="sec-period" className="scroll-mt-14"><Section title="Period">
            <Field label="Type" tip={kind === "SHORT" ? "Short-term: 15-minute intervals, drives the schedule." : "Long-term: daily volumes, drives capacity planning."}>
              <Segmented value={kind} onChange={(id) => setKind(id as "SHORT" | "LONG")} options={[{ id: "SHORT", label: "Short-term" }, { id: "LONG", label: "Long-term" }]} />
            </Field>
            <Field label="Historical period" tip="The days the models learn from and are tested on. Days with no data cannot be chosen.">
              <div className="max-w-md">
                <DateRangeField ariaLabel="Historical period" from={histFrom} to={histTo} min={firstDay || undefined} max={histEnd || undefined} disabled={!firstDay} onChange={(f, t) => { setHistFrom(f); setHistTo(t); }} />
              </div>
              <HistoryStatus problem={histProblem} queues={histQueues} none={shortest === 0} />
            </Field>
            <Field label="Forecast horizon" tip={kind === "SHORT" ? "The days the forecast covers: up to 18 weeks." : "The days the forecast covers: 30 days to two years."}>
              <div className="flex max-w-md items-center gap-3">
                <div className="flex-1"><DateRangeField ariaLabel="Forecast horizon" from={hStart} to={hEnd} min={todayStr} maxDays={kind === "SHORT" ? 126 : 730} onChange={(f, t) => { setHStart(f); setHEnd(t); }} /></div>
                {hStart && hEnd && <span className="shrink-0 text-[13px] font-medium tabular-nums">{lengthText(hStart, hEnd)}</span>}
              </div>
              <div className={`mt-1 text-[12px] ${horizonProblem ? "text-critical" : "text-subtle-foreground"}`}>{horizonProblem || (hStart && hEnd ? `${fmtShortDay(hStart)} to ${fmtShortDay(hEnd)}` : "")}</div>
            </Field>
            <Field label="Interval"><div className="num py-1 text-[13px]">{kind === "SHORT" ? "15 minutes" : "Daily"}</div></Field>
          </Section></div>

          <div id="sec-service" className="scroll-mt-14"><Section title="Service parameters">
            <Field label="Forecast metric"><select className={input} value="Offered volume" disabled aria-label="Forecast metric"><option>Offered volume</option></select></Field>
            <Field label="AHT" tip={`Average handle time, in seconds per contact${pv?.ahtHistory ? `. Your history shows ${pv.ahtHistory}s.` : "."}`}>
              <div className="num flex items-center gap-2 text-[13px]">
                <input type="number" min={1} className={`${input} !w-24`} value={wi.aht ?? pv?.ahtHistory ?? ""} placeholder="–" aria-label="AHT" onChange={(e) => setWi({ ...wi, aht: e.target.value === "" ? null : Math.max(1, Math.min(7200, +e.target.value)) })} />
                <span className="text-subtle-foreground">sec</span>
              </div>
            </Field>
            <Field label="Service goal" tip={goalSentence(wi.sl, wi.answer) + ". These targets start at the group's saved values: change them under Configuration › WFM Groups."}>
              <div className="num flex flex-wrap items-center gap-2 text-[13px]">
                <input type="number" min={1} max={99} className={`${input} !w-20`} value={wi.sl} aria-label="Service goal" onChange={(e) => setWi({ ...wi, sl: Math.max(1, Math.min(99, +e.target.value || 1)) })} />
                <span className="text-subtle-foreground">% in</span>
                <input type="number" min={1} max={600} className={`${input} !w-20`} value={wi.answer} aria-label="Threshold seconds" onChange={(e) => setWi({ ...wi, answer: Math.max(1, Math.min(600, Math.round(+e.target.value) || 1)) })} />
                <span className="text-subtle-foreground">sec</span>
              </div>
            </Field>
            <Field label="Occupancy target" tip={occupancySentence(wi.occ)}>
              <div className="num flex items-center gap-2 text-[13px]">
                <input type="number" min={31} max={100} className={`${input} !w-20`} value={wi.occ} aria-label="Occupancy target" onChange={(e) => setWi({ ...wi, occ: Math.max(31, Math.min(100, +e.target.value || 31)) })} />
                <span className="text-subtle-foreground">% max</span>
              </div>
            </Field>
            <Field label="Shrinkage" tip={shrinkageSentence(wi.shrink) + (group.shrinkageSource === "CATEGORIES" ? ". This is the total of the group's shrinkage categories." : "")}>
              <div className="num flex items-center gap-2 text-[13px]">
                <input type="number" min={0} max={90} className={`${input} !w-20`} value={wi.shrink} aria-label="Shrinkage" onChange={(e) => setWi({ ...wi, shrink: Math.max(0, Math.min(90, +e.target.value || 0)) })} />
                <span className="text-subtle-foreground">%</span>
              </div>
            </Field>
            {changed ? (
              <div className="flex flex-wrap items-center gap-3 border-b bg-warning-bg/60 px-6 py-2.5 text-[12px] text-warning">
                <span>Preview only. The forecast uses {group.name}'s saved targets.</span>
                <button className="font-medium underline" onClick={() => setWi({ sl: group.serviceLevelGoal, answer: group.serviceLevelThresholdSec, occ: group.targetOccupancy, shrink: shrinkOf(group), aht: null })}>Reset</button>
                <button className="font-medium underline" onClick={() => go("wfm-groups", "configuration")}>Change in WFM Groups</button>
              </div>
            ) : null}
          </Section></div>

          <div id="sec-model" className="scroll-mt-14"><Section title="Model">
            <div className="mx-6 my-4 rounded-md border bg-info-bg/60 p-4">
              <div className="flex items-center gap-2 text-[13px] font-semibold">
                <Sparkles className="size-4 text-info" /> Auto ensemble recommended
                <HelpTip title="Automatic model" text={`${lastSeries && lastPick ? `Last forecast used ${MODEL_LABEL[lastSeries.model] ?? lastSeries.model}. ` : ""}Every method is tested on your last 4 weeks and the most accurate one is kept for each queue.`} />
              </div>
              <div className="num mt-2 grid grid-cols-3 gap-4 text-[13px]">
                <div>
                  <div className="text-[12px] text-subtle-foreground">WAPE</div>
                  <div className="font-semibold">{lastPick ? `${(lastPick.wape * 100).toFixed(1)}%` : "–"}</div>
                </div>
                <div>
                  <div className="text-[12px] text-subtle-foreground">Stability</div>
                  <div className="font-semibold">{lastPick ? (lastPick.stability === "HIGH" ? "High" : lastPick.stability === "MEDIUM" ? "Medium" : "Variable") : "–"}</div>
                </div>
                <div>
                  <div className="text-[12px] text-subtle-foreground">Backtest</div>
                  <div className="font-semibold">4 weeks</div>
                </div>
              </div>
              <div className="mt-3 flex gap-2">
                <button onClick={() => { setModel("auto"); setAdvanced(false); }} className="rounded-md bg-primary px-2.5 py-1.5 text-[13px] font-medium text-primary-foreground">Use recommended</button>
                <button onClick={() => setAdvanced(true)} className="rounded-md border bg-background px-2.5 py-1.5 text-[13px] font-medium">Choose manually</button>
              </div>
            </div>
            {advanced && (
              <Field label="Model" tip="Advanced: skips the test and uses this one.">
                <select className={input} value={model} onChange={(e) => setModel(e.target.value)} aria-label="Model">
                  {Object.entries(MODEL_LABEL).map(([id, l]) => <option key={id} value={id}>{l}</option>)}
                </select>
              </Field>
            )}
          </Section></div>
          <div id="sec-history" className="scroll-mt-14 p-6"><HistoryHealth groupId={group.id} onSummary={setFsum} onGoSection={spy.go} /></div>
          <div id="sec-events" className="scroll-mt-14 p-6"><EventsCard groupId={group.id} canEdit={canCreate} /></div>
          </div>
          </div>
        </div>

        <aside className="h-fit xl:sticky xl:top-0">
          <div className="border-b px-6 py-3">
            <div className="flex items-center justify-between">
              <h2 className="text-[18px] font-semibold">Preview</h2>
              <StatusPill status="DRAFT" />
            </div>
            <p className="mt-0.5 text-[13px] text-muted-foreground">A typical day from your recent history at {group.name}'s targets. Recalculated as you change the group or the day.</p>
            <div className="mt-2.5 flex flex-wrap gap-1">
              {DOW.map((d, n) => <Chip key={d} label={d} on={(pv?.dow ?? dow) === n} onClick={() => setDow(n)} />)}
            </div>
          </div>
          {preview.loading && !pv ? <div className="p-6"><Waiting what="a typical day" shape="panel" reload={preview.reload} /></div>
            : preview.error ? <div className="p-6"><Banner kind="err">{preview.error}</Banner></div>
              : !pv ? <div className="p-6 text-[13px] text-muted-foreground">{preview.data && preview.data.ready === false ? preview.data.reason : ""}</div> : (
                <>
                  {!!pv.staffing?.targetNotMet && <div className="px-6 pt-4"><Banner kind="warn">{pv.staffing.targetNotMet} of {pv.staffing.intervals} intervals cannot reach the service level target even at the engine's agent limit, so the staffing shown there falls short of the target. Check the volume, handle time and targets.</Banner></div>}
                  {!!pv.staffing?.methodFallback && <div className="px-6 pt-4"><Banner kind="info">{pv.staffing.methodFallback} intervals were sized with Erlang C because Erlang A was not reliable for that load; Erlang C never needs fewer agents, so those numbers are on the safe side.</Banner></div>}
                  <div className="num grid grid-cols-2 divide-x divide-y border-b">
                    <Stat label={`Forecast volume, a ${DOW[pv.dow]}`} value={int(pv.day.volume)} />
                    <Stat label="Peak required staff" value={String(pv.day.peakRequired)} />
                    <Stat label="Required FTE" value={dec(pv.week.fte, 1)} />
                    <Stat label="Intervals" value={`${pv.slots.filter((s) => s.volume > 0 || s.required > 0).length} × 15m`} />
                  </div>
                  <div className="h-56 px-2 py-4">
                    <ResponsiveContainer width="100%" height="100%">
                      <AreaChart data={chart}>
                        <CartesianGrid vertical={false} stroke="var(--color-border)" />
                        <XAxis dataKey="time" tickLine={false} axisLine={false} fontSize={11} minTickGap={24} />
                        <YAxis tickLine={false} axisLine={false} fontSize={11} width={36} />
                        <Tooltip content={<ChartTooltip />} />
                        <Area dataKey="forecast" stroke="var(--color-chart-2)" fill="var(--color-info-bg)" strokeWidth={2} type="monotone" isAnimationActive={false} />
                      </AreaChart>
                    </ResponsiveContainer>
                  </div>
                  <div className="border-t px-6 py-3 text-[13px] text-muted-foreground">
                    <div className="flex items-center gap-1.5 font-medium text-foreground">
                      <Wand2 className="size-3.5" /> Traceability
                      <HelpTip title="How this is calculated" text={`Volume is the average ${DOW[pv.dow]} over the last ${pv.basis.weeks} weeks. AHT ${pv.aht ?? "–"}s, service goal ${pct(pv.targets.serviceLevel)} in ${pv.targets.answerSec}s (${pv.targets.method === "erlang_a" ? "Erlang A" : "Erlang C"}), occupancy cap ${pct(pv.targets.occupancyCap)}, shrinkage ${pct(pv.targets.shrinkage)}. Once the forecast is created, click any point on the dashboard to see the steps for that interval.`} />
                    </div>
                  </div>
                </>
              )}
          {(error || busy) && (
            <div className="space-y-2 border-t px-6 py-4">
              {error && <Banner kind="err">{error}</Banner>}
              {busy && <Busy text="Testing models on your history: this can take up to a minute…" />}
            </div>
          )}
        </aside>
      </div>

      <StickyFooter summary={summary}
        notes={<>
          {blockers.map((b) => <div key={b} className="text-critical">{b}</div>)}
          {histProblem && <div className="text-critical">{histProblem}</div>}
          {willPublish && (
            <div className="text-subtle-foreground" data-testid="publish-effect">
              <span className="font-medium text-foreground">When published: </span>
              <span className={willPublish.replaces.length ? "text-warning" : ""}>{willPublish.replaces.length ? `Replaces ${willPublish.replaces.map((f) => `v${f.seq}`).join(", ")}` : "Adds a live forecast"}</span>
              {" "}<button type="button" className="underline" aria-expanded={showEffect} onClick={() => setShowEffect((s) => !s)}>{showEffect ? "Hide" : "Details"}</button>
              {showEffect && <ul className="mt-1 list-disc space-y-0.5 pl-5">{willPublish.lines.map((l) => <li key={l}>{l}</li>)}</ul>}
            </div>
          )}
          {fsum && footerNote(fsum) && <div className={footerNote(fsum)!.tone === "bad" ? "text-critical" : "text-warning"}>{footerNote(fsum)!.text}. <button type="button" className="underline" onClick={() => spy.go("history")}>Review it</button></div>}
        </>}>
        {canCreate ? (
          <>
            <OutlineButton onClick={() => create(false)} disabled={busy || blockers.length > 0} title="Creates the forecast as a draft and stays here">Save draft</OutlineButton>
            <PrimaryButton onClick={() => create(true)} disabled={busy || blockers.length > 0} title="Creates the forecast as a draft and opens it on the dashboard"><Plus className="size-3.5" />{busy ? "Creating…" : "Create forecast"}</PrimaryButton>
          </>
        ) : <Pill>You do not have permission to create forecasts</Pill>}
      </StickyFooter>
    </div>
  );
}

/** One line about the history chosen: how many days, and whether every queue has enough. Only the queues with too little are named. */
function HistoryStatus({ problem, queues, none }: { problem: string; queues: { name: string; days: number; total: number; thin: boolean }[]; none: boolean }) {
  if (problem) return <div className="mt-1 text-[12px] text-critical">{problem}</div>;
  if (none) return <div className="mt-1.5"><Banner kind="warn">No interval history for this group yet. Import it under Data Management › Staged Ingestion first.</Banner></div>;
  if (!queues.length) return null;
  const thin = queues.filter((q) => q.thin), total = queues[0].total;
  return (
    <div className="mt-1 text-[12px]" aria-label="Days of data in these dates">
      <div className={thin.length ? "text-warning" : "text-subtle-foreground"}>{total} days · {thin.length === 0 ? `all ${queues.length} ${queues.length === 1 ? "queue has" : "queues have"} enough data` : `${queues.length - thin.length} of ${queues.length} queues have enough data`}</div>
      {thin.map((q) => <div key={q.name} className="text-warning">{q.name}: about {q.days} days, too little for a steady forecast</div>)}
    </div>
  );
}

const EventsCard: React.FC<{ groupId: string; canEdit: boolean }> = ({ groupId, canEdit }) => {
  const [tick, setTick] = useState(0);
  const events = useApi<EventRow[]>(`/forecast/events?groupId=${groupId}`, [tick]);
  const [f, setF] = useState({ name: '', kind: 'campaign', startDay: '', endDay: '', upliftPct: 0, leadDays: 0, lagDays: 0 });
  const [error, setError] = useState('');
  const add = async () => {
    setError('');
    try {
      await api('/forecast/events', { method: 'POST', body: { groupId, name: f.name, kind: f.kind, startDay: f.startDay, endDay: f.endDay || undefined, upliftPct: f.upliftPct, leadDays: f.leadDays, lagDays: f.lagDays } });
      setF({ name: '', kind: 'campaign', startDay: '', endDay: '', upliftPct: 0, leadDays: 0, lagDays: 0 }); setTick((t) => t + 1);
    } catch (e: any) { setError(e.message); }
  };
  return (
    <Card title="Special events" sub="Holidays, campaigns, outages. The models learn the uplift from past events and apply the same effect to future ones; the percentage you enter is used until there is history to learn from. Ramp days let the effect build up before the event and taper off after, instead of switching on and off at its exact dates.">
      <EventsCalendar events={events.data ?? []} range={f.startDay ? { start: f.startDay, end: f.endDay || f.startDay } : null}
        onPick={canEdit ? (d) => { const r = pickRange(f.startDay ? { start: f.startDay, end: f.endDay || f.startDay } : null, d); setF({ ...f, startDay: r.start, endDay: r.end }); } : undefined} />
      {events.data && events.data.length > 0 && (
        <div className="overflow-x-auto"><Table head={['Event', 'Type', 'From', 'To', 'Expected change', 'Ramp', 'Applies to', '']} right={[4]}>
          {events.data.map((e) => (
            <tr key={e.id}>
              <td className="p-3 font-medium">{e.name}</td><td className="p-3 capitalize">{e.kind}</td>
              <td className="p-3">{dayYear(e.startDay)}</td><td className="p-3">{dayYear(e.endDay)}</td>
              <td className="p-3 text-right tabular-nums">{e.upliftPct > 0 ? '+' : ''}{e.upliftPct}%</td>
              <td className="p-3 text-[12px] text-[#6B6B6B]">{e.leadDays || e.lagDays ? `${e.leadDays}d in, ${e.lagDays}d out` : '—'}</td>
              <td className="p-3">{e.queueName ?? e.groupName ?? 'All groups'}</td>
              <td className="p-3 text-right">{canEdit && <button aria-label="Delete event" className="text-[#6B6B6B] hover:text-[#BC3F3F]" onClick={async () => { await api(`/forecast/events/${e.id}`, { method: 'DELETE' }); setTick((t) => t + 1); }}><Trash2 className="w-4 h-4" /></button>}</td>
            </tr>
          ))}
        </Table></div>
      )}
      {events.data?.length === 0 && <p className="text-[12px] text-[#6B6B6B]">No events recorded yet.</p>}
      {canEdit && (
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 items-end">
          <div className="col-span-2"><StackField label="Name"><PlainInput value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="e.g. Spring sale" /></StackField></div>
          <StackField label="Type"><PlainSelect value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })}>{['campaign', 'holiday', 'outage', 'other'].map((k) => <option key={k} value={k}>{k}</option>)}</PlainSelect></StackField>
          <StackField label="From"><PlainInput type="date" value={f.startDay} onChange={(e) => setF({ ...f, startDay: e.target.value })} /></StackField>
          <StackField label="To"><PlainInput type="date" value={f.endDay} onChange={(e) => setF({ ...f, endDay: e.target.value })} /></StackField>
          <StackField label="Change %"><PlainInput type="number" value={f.upliftPct} onChange={(e) => setF({ ...f, upliftPct: Number(e.target.value) })} /></StackField>
          <StackField label="Ramp in (days)"><PlainInput type="number" min={0} max={60} value={f.leadDays} onChange={(e) => setF({ ...f, leadDays: Number(e.target.value) })} /></StackField>
          <StackField label="Ramp out (days)"><PlainInput type="number" min={0} max={60} value={f.lagDays} onChange={(e) => setF({ ...f, lagDays: Number(e.target.value) })} /></StackField>
          <div className="col-span-2 lg:col-span-4 flex items-center gap-3"><Btn disabled={!f.name || !f.startDay} onClick={add}><Plus className="w-3.5 h-3.5" />Add event</Btn>{error && <span className="text-[12px] text-[#BC3F3F]">{error}</span>}</div>
        </div>
      )}
    </Card>
  );
};
