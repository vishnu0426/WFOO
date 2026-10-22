/**
 * Adjustments (reference design): change a draft forecast for a day range and time window (percentage, add contacts, set a total,
 * or remove). A reason is mandatory and lands in the audit trail. Click an agents figure to see how it was worked out.
 */
import React, { useState } from "react";
import { api, type Bucket, type DataResp, dayName, dec, slotLabel, when } from "../../services/api";
import { useForecast } from "../../services/forecastStore";
import { useApi, useVersionFull } from "./hooks";
import { TraceModal } from "./Trace";
import { Busy } from "./ui";
import { DateField, PrimaryButton, Section, Select } from "../wfm/app-shell";
import { Labeled, Notice, RefScope, RefTable, Segmented, fieldCls } from "./RefScope";

const toSlot = (t: string) => { const [h, m] = t.split(":").map(Number); return h * 4 + Math.floor(m / 15); };

export function AdjustmentsSection() {
  const { group, kind, can, reload, setNotice } = useForecast();
  const [gridDay, setGridDay] = useState("");
  const [queueId, setQueueId] = useState("");
  return (
    <RefScope crumb="Adjustments" title="Adjustments" description="Change a draft forecast with a recorded reason. Adjustments change the forecast only, never the imported history."
      toolbar={<Select label="Queue" value={queueId} options={[{ id: "", label: "All queues" }, ...(group?.queues ?? []).map((q) => ({ id: q.id, label: q.name }))]} onChange={setQueueId} />}>
      {(version) => <Body version={version} gridDay={gridDay} setGridDay={setGridDay} queueId={queueId} kind={kind} can={can} reload={reload} setNotice={setNotice} group={group!} />}
    </RefScope>
  );
}

function Body({ version, gridDay, setGridDay, queueId, kind, can, reload, setNotice, group }: any) {
  const { full } = useVersionFull(version);
  const [mode, setMode] = useState<"pct" | "add" | "total" | "reset">("pct");
  const [value, setValue] = useState(10);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [tFrom, setTFrom] = useState("00:00");
  const [tTo, setTTo] = useState("23:45");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [trace, setTrace] = useState<Bucket | null>(null);

  const short = kind === "SHORT";
  const day = gridDay || version.fromDay;
  const qs = queueId ? `&queueId=${queueId}` : "";
  const data = useApi<DataResp>(`/forecast/versions/${version.id}/data?grain=${short ? "15" : "day"}&from=${short ? day : version.fromDay}&to=${short ? day : version.toDay}${qs}`, [version.rev, version.status]);
  const editable = version.status === "DRAFT" && can("forecast:adjust");
  const channel = group.queues.some((q: any) => q.channel === "CHAT") && !group.queues.some((q: any) => q.channel === "VOICE") ? "chat" : "voice";

  const apply = async () => {
    setBusy(true); setError(""); setNotice(null);
    try {
      const body: any = { mode, from: from || version.fromDay, to: to || from || version.toDay, queueId: queueId || null, reason };
      if (mode !== "reset") body.value = value;
      if (short) { body.slotFrom = toSlot(tFrom); body.slotTo = toSlot(tTo); }
      const r = await api<{ rows: number; beforeVolume: number; afterVolume: number }>(`/forecast/versions/${version.id}/adjustments`, { method: "PATCH", body });
      setNotice({ kind: "ok", text: `Adjusted ${r.rows.toLocaleString()} rows: ${Math.round(r.beforeVolume).toLocaleString()} → ${Math.round(r.afterVolume).toLocaleString()} contacts. Recorded in the audit trail.` });
      setReason("");
      await reload(version.id);
    } catch (e: any) { setError(e.message); } finally { setBusy(false); }
  };

  const history = (full?.audit ?? []).filter((a) => a.action === "ADJUST");
  const rows = data.data?.buckets ?? [];
  return (
    <>
      {!editable && (
        <Notice kind="info">
          {version.status !== "DRAFT" ? `This forecast is ${version.status.toLowerCase()}, so it is locked. Return it to draft, or clone it, to make changes.` : "You do not have permission to adjust forecasts."}
        </Notice>
      )}
      {error && <Notice kind="err" onClose={() => setError("")}>{error}</Notice>}

      <Section title="Adjust this forecast">
        <div className="grid grid-cols-1 gap-4 px-6 pb-6 md:grid-cols-2 xl:grid-cols-4">
          <Labeled label="What to do">
            <Segmented disabled={!editable} options={[{ id: "pct", label: "± %" }, { id: "add", label: "+ contacts" }, { id: "total", label: "Set total" }, { id: "reset", label: "Remove" }]} value={mode} onChange={(m) => setMode(m as typeof mode)} />
          </Labeled>
          {mode !== "reset" && (
            <Labeled label={mode === "pct" ? "Change (%)" : mode === "add" ? "Contacts to add (or remove)" : "New total contacts"}>
              <input type="number" className={fieldCls} value={value} onChange={(e) => setValue(Number(e.target.value))} disabled={!editable} />
            </Labeled>
          )}
          <Labeled label="From day"><input type="date" className={fieldCls} min={version.fromDay} max={version.toDay} value={from || version.fromDay} onChange={(e) => setFrom(e.target.value)} disabled={!editable} /></Labeled>
          <Labeled label="To day"><input type="date" className={fieldCls} min={version.fromDay} max={version.toDay} value={to || from || version.fromDay} onChange={(e) => setTo(e.target.value)} disabled={!editable} /></Labeled>
          {short && <Labeled label="From time"><input type="time" step={900} className={fieldCls} value={tFrom} onChange={(e) => setTFrom(e.target.value)} disabled={!editable} /></Labeled>}
          {short && <Labeled label="To time (last interval)"><input type="time" step={900} className={fieldCls} value={tTo} onChange={(e) => setTTo(e.target.value)} disabled={!editable} /></Labeled>}
          <Labeled label="Reason (required)" hint="Shown in the audit trail, e.g. “Spring sale email on the 14th”" className="md:col-span-2">
            <input className={fieldCls} value={reason} onChange={(e) => setReason(e.target.value)} disabled={!editable} maxLength={300} />
          </Labeled>
        </div>
        <div className="flex items-center gap-3 px-6 pb-6">
          <PrimaryButton disabled={!editable || busy || reason.trim().length < 3} onClick={apply}>Apply adjustment</PrimaryButton>
          {busy && <Busy />}
          {version.status === "DRAFT" && version.rev > 0 && <span className="rounded-md bg-warning-bg px-2 py-1 text-[11px] font-semibold uppercase tracking-wider text-warning">Adjusted draft · revision {version.rev}</span>}
        </div>
      </Section>

      <Section title={short ? "Forecast by 15 minutes" : "Forecast by day"}
        action={short && <DateField label="Day" value={day} min={version.fromDay} max={version.toDay} onChange={setGridDay} />}>
        <p className="px-6 pb-3 text-[12px] text-subtle-foreground">Adjusted values are highlighted.{short && " Click an agents figure to see how the number was worked out."}</p>
        {data.error && <Notice kind="err">{data.error}</Notice>}
        <div className="max-h-[480px] overflow-auto">
          <RefTable right={[1, 2, 3, 4, 5, 6, 7]}
            head={[short ? "Time" : "Day", "Forecast", "Low", "High", "Handle time (s)", ...(short ? ["Agents on schedule", "Service level"] : ["Peak agents", "Agent hours"])]}>
            {rows.map((b) => (
              <tr key={`${b.day}-${b.slot}`} className="border-b hover:bg-surface">
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
