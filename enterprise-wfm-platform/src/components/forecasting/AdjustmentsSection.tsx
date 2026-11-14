/**
 * Adjustments: change a draft forecast for a day range and time window. A reason is mandatory and lands in the audit trail.
 *
 * Pick the intervals by dragging across the chart (or type the dates and times), choose what to do in words, read the sentence that says what will happen, and apply. A forecast that is
 * locked (live, archived, or waiting for review) shows what can be done about it in the banner: clone it into a new draft, or return it to draft. The day and the queue are the ones on
 * the shared context bar, so they carry over from the dashboard.
 */
import React, { useRef, useState } from "react";
import { Area, CartesianGrid, ComposedChart, Line, ReferenceArea, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { api, type Bucket, type DataResp, dayName, dec, slotLabel, when } from "../../services/api";
import { useForecast } from "../../services/forecastStore";
import { adjustmentSentence, dragSpan, slotTime, timeSlot, type AdjustMode } from "../../services/forecastForm";
import { useApi, useVersionFull } from "./hooks";
import { TraceModal } from "./Trace";
import { scrollToEl } from "./FormIndex";
import { ChartTooltip } from "./ChartTooltip";
import { Busy } from "./ui";
import { Confirm } from "../configuration/groups/shared";
import { PrimaryButton, Section } from "../wfm/app-shell";
import { Labeled, Notice, RefScope, RefTable, fieldCls } from "./RefScope";

const MODES: { id: AdjustMode; label: string; help: string }[] = [
  { id: "pct", label: "Change by %", help: "Raise or lower every interval by a percentage. A minus sign lowers it." },
  { id: "add", label: "Add contacts", help: "Add (or, with a minus sign, take away) a number of contacts, shared across the intervals by their usual weight." },
  { id: "total", label: "Set total", help: "Set the total for the range. The usual shape of the day is kept." },
  { id: "zero", label: "Zero out", help: "Expect no contacts: a closure, a holiday." },
  { id: "reset", label: "Undo adjustments", help: "Take off earlier adjustments in the range and go back to the model's own numbers." },
];

export function AdjustmentsSection() {
  const { group, kind, can, reload, setNotice } = useForecast();
  return (
    <RefScope crumb="Adjustments" title="Adjustments" description="Change a draft forecast with a recorded reason. Adjustments change the forecast only, never the imported history." context="day">
      {(version) => <Body version={version} kind={kind} can={can} reload={reload} setNotice={setNotice} group={group!} />}
    </RefScope>
  );
}

/** The banner on a forecast that cannot be changed, with the buttons that get the person unstuck. */
function LockedBanner({ version, can, reload, setNotice }: any) {
  const [ask, setAsk] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const s = version.status as string;
  const canClone = (s === "PUBLISHED" || s === "ARCHIVED") && can("forecast:create");
  const canReturn = (s === "SUBMITTED" || s === "APPROVED") && (can("forecast:approve") || can("forecast:submit"));
  const why = s === "PUBLISHED" ? "This forecast is live, so it is locked: schedules are built from it."
    : s === "ARCHIVED" ? "This version is archived, so it is locked."
      : s === "DRAFT" ? "You do not have permission to adjust forecasts."
        : `This forecast is ${s === "SUBMITTED" ? "waiting to be approved" : "approved and waiting to be published"}, so it is locked.`;
  const what = canClone ? " Clone it to make changes in a new draft." : canReturn ? " Return it to draft to change it." : s === "DRAFT" ? "" : " Someone with permission can clone it or return it to draft.";
  const clone = async () => {
    setBusy(true); setError("");
    try { const c = await api<{ id: string; name: string }>(`/forecast/versions/${version.id}/clone`, { method: "POST" }); await reload(c.id); setNotice({ kind: "ok", text: `Created ${c.name}. It is a draft: you can adjust it now.` }); }
    catch (e: any) { setError(e.message); } finally { setBusy(false); }
  };
  const back = async (reason: string) => {
    setBusy(true); setError("");
    try { await api(`/forecast/versions/${version.id}/reject`, { method: "POST", body: { reason } }); setAsk(false); await reload(version.id); setNotice({ kind: "ok", text: "Returned to draft. You can adjust it now." }); }
    catch (e: any) { setError(e.message); } finally { setBusy(false); }
  };
  return (
    <>
      <Notice kind="info">
        <div className="flex flex-wrap items-center gap-3">
          <span>{why}{what}</span>
          {canClone && <button type="button" disabled={busy} onClick={() => void clone()} className="h-8 rounded-md bg-primary px-3 text-[13px] font-medium text-primary-foreground disabled:opacity-60">Clone to edit</button>}
          {canReturn && <button type="button" disabled={busy} onClick={() => { setError(""); setAsk(true); }} className="h-8 rounded-md border bg-background px-3 text-[13px] font-medium text-foreground disabled:opacity-60">Return to draft…</button>}
        </div>
        {error && !ask && <p className="mt-1 text-critical" role="alert">{error}</p>}
      </Notice>
      {ask && (
        <Confirm title={`Return v${version.seq} to draft?`} confirmLabel="Return to draft" reason busy={busy} error={error} onCancel={() => setAsk(false)} onConfirm={(r) => void back(r)}>
          <p>It can be changed again, then submitted for approval. Say why it is being returned.</p>
        </Confirm>)}
    </>
  );
}

function Body({ version, kind, can, reload, setNotice, group }: any) {
  const { full } = useVersionFull(version);
  const { view } = useForecast();
  const [mode, setMode] = useState<AdjustMode>("pct");
  const [value, setValue] = useState(10);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [tFrom, setTFrom] = useState("00:00");
  const [tTo, setTTo] = useState("23:45");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [trace, setTrace] = useState<Bucket | null>(null);
  const [drag, setDrag] = useState<{ a: number; b: number } | null>(null);
  const [picked, setPicked] = useState(false);              // the range came from the chart
  const valueRef = useRef<HTMLInputElement>(null);
  const formRef = useRef<HTMLDivElement>(null);

  const short = kind === "SHORT";
  const clampDay = (d: string) => (d < version.fromDay ? version.fromDay : d > version.toDay ? version.toDay : d);
  const day = clampDay(view?.start || version.fromDay), queueId = view?.queueId ?? "";
  const qs = queueId ? `&queueId=${queueId}` : "";
  const data = useApi<DataResp>(`/forecast/versions/${version.id}/data?grain=${short ? "15" : "day"}&from=${short ? day : version.fromDay}&to=${short ? day : version.toDay}${qs}`, [version.rev, version.status]);
  const editable = version.status === "DRAFT" && can("forecast:adjust");
  const channel = group.queues.some((q: any) => q.channel === "CHAT") && !group.queues.some((q: any) => q.channel === "VOICE") ? "chat" : "voice";
  const queueName = group.queues.find((q: any) => q.id === queueId)?.name ?? "";

  // what the form will do: the day chosen on the bar for a short-term forecast (not the whole horizon), the whole horizon for a long-term one, unless a range was picked
  const fromV = from || (short ? day : version.fromDay), toV = to || from || (short ? day : version.toDay);
  const apply = async () => {
    setBusy(true); setError(""); setNotice(null);
    try {
      const body: any = { mode: mode === "zero" ? "total" : mode, from: fromV, to: toV, queueId: queueId || null, reason };
      if (mode === "zero") body.value = 0; else if (mode !== "reset") body.value = value;
      if (short) { body.slotFrom = timeSlot(tFrom); body.slotTo = timeSlot(tTo); }
      const r = await api<{ rows: number; beforeVolume: number; afterVolume: number }>(`/forecast/versions/${version.id}/adjustments`, { method: "PATCH", body });
      setNotice({ kind: "ok", text: `Adjusted ${r.rows.toLocaleString()} rows: ${Math.round(r.beforeVolume).toLocaleString()} → ${Math.round(r.afterVolume).toLocaleString()} contacts. Recorded in the audit trail.` });
      setReason(""); setPicked(false);
      await reload(version.id);
    } catch (e: any) { setError(e.message); } finally { setBusy(false); }
  };

  const history = (full?.audit ?? []).filter((a) => a.action === "ADJUST");
  const rows = data.data?.buckets ?? [];
  const labelOf = (b: Bucket) => (short ? slotLabel(b.slot) : dayName(b.day));
  const chart = rows.map((b) => ({ ...b, time: labelOf(b), edited_volume: b.edited ? b.volume : null }));

  // dragging across the chart picks the intervals (or days) to change
  const idxOf = (e: any) => { const i = Number(e?.activeTooltipIndex ?? e?.activeIndex); return Number.isFinite(i) ? i : null; };
  const finish = () => {
    if (!drag) return;
    const span = dragSpan(drag.a, drag.b, rows.length);
    setDrag(null);
    if (!span) return;
    const a = rows[span.first], b = rows[span.last];
    if (short) { setFrom(day); setTo(day); setTFrom(slotTime(a.slot)); setTTo(slotTime(b.slot)); } else { setFrom(a.day); setTo(b.day); }
    setPicked(true);
    setTimeout(() => { if (formRef.current) scrollToEl(formRef.current, 120); valueRef.current?.focus(); }, 50);
  };
  // the shaded part of the chart: the drag in progress, else the range now in the form
  const shade = (() => {
    if (drag) { const s = dragSpan(drag.a, drag.b, rows.length); return s ? { x1: chart[s.first]?.time, x2: chart[s.last]?.time } : null; }
    if (!editable || !rows.length) return null;
    if (short) { if (day < fromV || day > toV) return null; const a = chart.find((c) => c.slot >= timeSlot(tFrom)), b = [...chart].reverse().find((c) => c.slot <= timeSlot(tTo)); return a && b ? { x1: a.time, x2: b.time } : null; }
    const a = chart.find((c) => c.day >= fromV), b = [...chart].reverse().find((c) => c.day <= toV);
    return a && b && (from || to) ? { x1: a.time, x2: b.time } : null;
  })();
  const inSel = (b: Bucket) => (short ? day >= fromV && day <= toV && b.slot >= timeSlot(tFrom) && b.slot <= timeSlot(tTo) : (!!from || !!to) && b.day >= fromV && b.day <= toV);
  const shownCount = shade ? rows.filter(inSel).length : 0;
  const clear = () => { setFrom(""); setTo(""); setTFrom("00:00"); setTTo("23:45"); setPicked(false); };

  return (
    <>
      {!editable && <LockedBanner version={version} can={can} reload={reload} setNotice={setNotice} />}
      {error && <Notice kind="err" onClose={() => setError("")}>{error}</Notice>}

      <Section title={short ? `Forecast on ${dayName(day)}` : "Forecast by day"}
        action={editable ? <span className="text-[12px] text-muted-foreground">Drag across the chart to pick what to change</span> : undefined}>
        {data.error && <Notice kind="err">{data.error}</Notice>}
        <div role="group" className="h-64 select-none px-4 pb-4" aria-label="Forecast chart: drag across it to choose the intervals to adjust" style={{ cursor: editable ? "crosshair" : "default" }}>
          {rows.length === 0 ? <p className="px-2 py-6 text-[13px] text-subtle-foreground">{data.loading ? "Loading…" : "Nothing to show for this selection."}</p> : (
            <ResponsiveContainer width="100%" height="100%">
              <ComposedChart data={chart} margin={{ top: 8, right: 16, bottom: 0, left: 0 }}
                onMouseDown={(e: any) => { if (!editable) return; const i = idxOf(e); if (i !== null) setDrag({ a: i, b: i }); }}
                onMouseMove={(e: any) => { if (!drag) return; const i = idxOf(e); if (i !== null && i !== drag.b) setDrag({ a: drag.a, b: i }); }}
                onMouseUp={finish} onMouseLeave={finish}>
                <CartesianGrid vertical={false} stroke="var(--color-border)" />
                <XAxis dataKey="time" tickLine={false} axisLine={false} fontSize={12} minTickGap={24} />
                <YAxis tickLine={false} axisLine={false} fontSize={12} width={48} />
                <Tooltip content={<ChartTooltip />} />
                <Area dataKey="p90" stroke="none" fill="var(--color-info-bg)" fillOpacity={1} activeDot={false} isAnimationActive={false} />
                <Area dataKey="p10" stroke="none" fill="var(--color-background)" fillOpacity={1} activeDot={false} isAnimationActive={false} />
                <Line name="Forecast" dataKey="volume" stroke="var(--color-chart-2)" strokeWidth={2} dot={false} type="monotone" isAnimationActive={false} />
                <Line name="Adjusted" dataKey="edited_volume" stroke="none" dot={{ r: 3, fill: "var(--color-warning)" }} activeDot={false} isAnimationActive={false} legendType="none" />
                {shade?.x1 && shade?.x2 && <ReferenceArea x1={shade.x1} x2={shade.x2} fill="var(--color-foreground)" fillOpacity={0.12} stroke="var(--color-foreground)" strokeOpacity={0.4} />}
              </ComposedChart>
            </ResponsiveContainer>)}
        </div>
        {editable && picked && shade && (
          <p className="-mt-1 flex flex-wrap items-center gap-3 px-6 pb-3 text-[13px]" role="status">
            <span>Selected {short ? `${tFrom} to ${tTo} on ${dayName(day)}` : `${fromV} to ${toV}`} ({shownCount} {short ? "interval" : "day"}{shownCount === 1 ? "" : "s"}).</span>
            <button type="button" className="underline" onClick={clear}>Clear</button>
          </p>)}
      </Section>

      {editable && (
        <div ref={formRef}>
          <Section title="Adjust this forecast">
            <div className="space-y-4 px-6 pb-6">
              <div>
                <div className="text-[12px] font-medium text-subtle-foreground" id="adj-what">What to do</div>
                <div role="group" aria-labelledby="adj-what" className="mt-1.5 flex flex-wrap gap-1.5">
                  {MODES.map((m) => (
                    <button key={m.id} type="button" aria-pressed={mode === m.id} onClick={() => setMode(m.id)}
                      className={`h-9 rounded-lg border px-3 text-[13px] font-medium transition-colors ${mode === m.id ? "border-primary bg-primary text-primary-foreground" : "border-border-strong bg-background text-foreground hover:bg-surface"}`}>{m.label}</button>))}
                </div>
                <p className="mt-1.5 text-[12px] text-muted-foreground">{MODES.find((m) => m.id === mode)!.help}</p>
              </div>
              <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">
                {mode !== "reset" && mode !== "zero" && (
                  <Labeled label={mode === "pct" ? "Change (%)" : mode === "add" ? "Contacts to add (minus takes away)" : "New total contacts"}>
                    <input ref={valueRef} type="number" className={fieldCls} value={value} onChange={(e) => setValue(Number(e.target.value))} />
                  </Labeled>)}
                <Labeled label="From day"><input type="date" className={fieldCls} min={version.fromDay} max={version.toDay} value={fromV} onChange={(e) => { setFrom(e.target.value); setPicked(false); }} /></Labeled>
                <Labeled label="To day"><input type="date" className={fieldCls} min={version.fromDay} max={version.toDay} value={toV} onChange={(e) => { setTo(e.target.value); setPicked(false); }} /></Labeled>
                {short && <Labeled label="From time"><input type="time" step={900} className={fieldCls} value={tFrom} onChange={(e) => { setTFrom(e.target.value); setPicked(false); }} /></Labeled>}
                {short && <Labeled label="To time (last interval)"><input type="time" step={900} className={fieldCls} value={tTo} onChange={(e) => { setTTo(e.target.value); setPicked(false); }} /></Labeled>}
                <Labeled label="Reason (required)" hint="Shown in the audit trail, e.g. “Spring sale email on the 14th”" className="md:col-span-2">
                  <input className={fieldCls} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} />
                </Labeled>
              </div>
              <p className="rounded-md bg-surface px-3 py-2 text-[13px]" data-testid="adjustment-sentence">{adjustmentSentence({ mode, value, from: fromV, to: toV, short, tFrom, tTo, queue: queueName })}</p>
              <div className="flex items-center gap-3">
                <PrimaryButton disabled={busy || reason.trim().length < 3} onClick={apply}>Apply adjustment</PrimaryButton>
                {busy && <Busy />}
                {version.rev > 0 && <span className="rounded-md bg-warning-bg px-2 py-1 text-[11px] font-semibold uppercase tracking-wider text-warning">Adjusted draft · revision {version.rev}</span>}
              </div>
            </div>
          </Section>
        </div>)}

      <Section title={short ? "Forecast by 15 minutes" : "Forecast by day"}>
        <p className="px-6 pb-3 text-[12px] text-subtle-foreground">Adjusted values are highlighted.{short && " Click an agents figure to see how the number was worked out."}</p>
        <div className="max-h-[480px] overflow-auto">
          <RefTable right={[1, 2, 3, 4, 5, 6, 7]}
            head={[short ? "Time" : "Day", "Forecast", "Low", "High", "Handle time (s)", ...(short ? ["Agents on schedule", "Service level"] : ["Peak agents", "Agent hours"])]}>
            {rows.map((b) => (
              <tr key={`${b.day}-${b.slot}`} className={`border-b hover:bg-surface ${editable && shade && inSel(b) ? "bg-info-bg/50" : ""}`}>
                <td className="px-6 py-2 font-medium">{short ? slotLabel(b.slot) : dayName(b.day)}</td>
                <td className={`px-6 py-2 text-right ${b.edited ? "bg-warning-bg font-semibold text-warning" : ""}`}>{dec(b.volume, 1)}</td>
                <td className="px-6 py-2 text-right text-muted-foreground">{dec(b.p10, 0)}</td>
                <td className="px-6 py-2 text-right text-muted-foreground">{dec(b.p90, 0)}</td>
                <td className="px-6 py-2 text-right">{dec(b.aht, 0)}</td>
                {short ? (
                  <>
                    <td className="cursor-pointer px-6 py-2 text-right font-semibold underline decoration-dotted" title="Click to see how this is worked out" onClick={() => setTrace(b)}>{b.required}</td>
                    <td className="px-6 py-2 text-right">{Math.round(b.sl * 100)}%</td>
                  </>
                ) : (
                  <>
                    <td className="px-6 py-2 text-right">{(b as any).peakRequired ?? "–"}</td>
                    <td className="px-6 py-2 text-right">{dec((b as any).agentHours ?? 0, 0)}</td>
                  </>
                )}
              </tr>
            ))}
          </RefTable>
          {!rows.length && !data.loading && <p className="px-6 py-4 text-[13px] text-subtle-foreground">Nothing to show for this selection.</p>}
        </div>
      </Section>

      <Section title="Adjustment history">
        {history.length === 0 ? <p className="px-6 pb-5 text-[13px] text-subtle-foreground">No adjustments yet. Every change to this forecast, who made it and why, will be listed here.</p> : (
          <RefTable head={["When", "Who", "Reason", "Change"]}>
            {history.map((a, i) => (
              <tr key={i} className="border-b"><td className="whitespace-nowrap px-6 py-3">{when(a.at)}</td><td className="px-6 py-3">{a.by}</td><td className="px-6 py-3">{a.reason}</td><td className="px-6 py-3 text-[12px] text-muted-foreground">{typeof a.detail === "string" ? a.detail : ""}</td></tr>
            ))}
          </RefTable>
        )}
      </Section>

      {trace && <TraceModal groupId={group.id} title={`${dayName(trace.day)} at ${slotLabel(trace.slot)} · ${dec(trace.volume, 1)} contacts`} input={{ volume: trace.volume, ahtSec: trace.aht, channel }} onClose={() => setTrace(null)} />}
    </>
  );
}
