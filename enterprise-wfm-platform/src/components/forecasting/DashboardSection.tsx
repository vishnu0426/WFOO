/**
 * Forecast Dashboard: the reference screen (header, toolbar, six-figure strip, two recharts charts, interval table) wired to the
 * gateway. Rows come from /forecast/versions/:id/data (forecast, likely range, required staff) with actuals, last week's volume
 * and scheduled staff added by the gateway. Click a point on the volume chart to see how that number is worked out.
 */
import React, { useEffect, useMemo, useState } from "react";
import { Area, Bar, CartesianGrid, ComposedChart, Line, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { Calculator, Download, Plus, RefreshCw, X } from "lucide-react";
import { addDays, api, isNew, STATUS_LABEL, type Bucket, type DataResp, dayName, dec, fmtDate, int, lean, MODEL_LABEL, pct, slotLabel } from "../../services/api";
import { useForecast } from "../../services/forecastStore";
import { useApi, useVersionFull } from "./hooks";
import { TracePanel, useTrace } from "./Trace";
import { useVersionActions } from "./useVersionActions";
import { ChartTooltip } from "./ChartTooltip";
import { Banner, Busy, Empty } from "./ui";
import { DateField, Metric, OutlineButton, PageHeader, PrimaryButton, Section, Select, StatusPill, Toolbar } from "../wfm/app-shell";

type Grain = "15" | "30" | "60" | "day" | "week" | "month";
const ranges = ["Day", "Week", "Month", "Custom Range"];
const INTERVALS = {
  SHORT: [{ id: "15", label: "15 min" }, { id: "30", label: "30 min" }, { id: "60", label: "60 min" }, { id: "day", label: "Daily" }, { id: "week", label: "Weekly" }, { id: "month", label: "Monthly" }],
  LONG: [{ id: "15", label: "15 min" }, { id: "30", label: "30 min" }, { id: "60", label: "60 min" }, { id: "day", label: "Daily" }, { id: "week", label: "Weekly" }, { id: "month", label: "Monthly" }],
};
const DEFAULT_GRAIN: Record<string, Grain> = { Day: "30", Week: "60", Month: "day", "Custom Range": "60" };
const PER_BUCKET: Record<string, number> = { "15": 1, "30": 2, "60": 4 };   // 15-minute slots in one bucket
const span = (a: string, b: string) => Math.round((new Date(b + "T00:00:00").getTime() - new Date(a + "T00:00:00").getTime()) / 864e5) + 1;

export function DashboardSection() {
  const { groups, group, setGroupId, versions, version, setVersionId, kind, setKind, can, go, reload, setNotice } = useForecast();
  const act = useVersionActions();
  const { full } = useVersionFull(version);
  const [range, setRange] = useState("Day");
  const [grain, setGrain] = useState<Grain>("30");
  const [queueId, setQueueId] = useState("");
  const [start, setStart] = useState("");
  const [end, setEnd] = useState("");
  const [pin, setPin] = useState<number | null>(null); // the chart point being explained
  const [busy, setBusy] = useState(false);

  // a new forecast (or group) opens on today when it covers today, otherwise on its first day
  useEffect(() => {
    if (!version) return;
    const today = fmtDate(new Date());
    setStart(today >= version.fromDay && today <= version.toDay ? today : version.fromDay);
    setEnd(version.toDay);
    setRange("Day");
    setGrain("30");                                  // time of day first, for short- and long-term forecasts alike
    setQueueId("");
  }, [version?.id]);

  const win = useMemo(() => {
    if (!version || !start) return null;
    const clamp = (d: string) => (d < version.fromDay ? version.fromDay : d > version.toDay ? version.toDay : d);
    const s = clamp(start);
    let from = s, to = s;
    if (range === "Week") to = clamp(addDays(s, 6));
    else if (range === "Month") { from = version.fromDay; to = version.toDay; }
    else if (range === "Custom Range") to = clamp(end < s ? s : end);
    const days = span(from, to);
    let g: Grain = grain === "15" && days > 14 ? "60" : grain;             // the gateway limits 15-minute views to 14 days
    if (kind === "LONG" && PER_BUCKET[g] && days > 31) g = "day";            // and the time-of-day split of a long-term forecast to 31 days
    return { from, to, grain: g };
  }, [version, start, end, range, grain, kind]);

  const res = useApi<DataResp>(
    version && win ? `/forecast/versions/${version.id}/data?grain=${win.grain}&from=${win.from}&to=${win.to}${queueId ? `&queueId=${queueId}` : ""}` : null,
    [version?.rev, version?.status],
  );
  const buckets: Bucket[] = res.data?.buckets ?? [];
  useEffect(() => { setPin(null); }, [win?.from, win?.to, win?.grain, queueId, version?.id]);

  const single = !!win && win.from === win.to;
  const shortDay = (d: string) => new Date(d + "T00:00:00").toLocaleDateString("en", { month: "short", day: "numeric" });
  // chart labels: "Sep 24" for days, "Week of Sep 21", "Sep 2026", a time of day for one day, "Sep 25 14:00" across several days
  const label = (b: Bucket) => (b.period
    ? (win?.grain === "month" ? new Date(b.period + "-01T00:00:00").toLocaleDateString("en", { month: "short", year: "numeric" }) : `Week of ${shortDay(b.period)}`)
    : win?.grain === "day" ? shortDay(b.day) : single ? slotLabel(b.slot) : `${shortDay(b.day)} ${slotLabel(b.slot)}`);
  // table labels: the full weekday and date for a day ("Thu, Sep 24"), otherwise the same as the chart
  const rowLabel = (b: Bucket) => (!b.period && win?.grain === "day" ? dayName(b.day) : label(b));
  const firstCol = win?.grain === "day" ? "Day" : win?.grain === "week" ? "Week" : win?.grain === "month" ? "Month" : "Interval";
  const intraday = !!PER_BUCKET[win?.grain ?? ""];
  // required and scheduled people exist per time of day (any forecast) and per day of a short-term forecast; not for the days of a long-term one
  const staffCols = kind === "SHORT" || intraday;
  // one row per interval, in the shape the reference charts and table expect
  const all = useMemo(() => buckets.map((b) => ({
    time: label(b), rowLabel: rowLabel(b), historical: b.lastWeek ?? null, forecast: b.volume, actual: b.actual ?? null, upper: b.p90, lower: b.p10, aht: Math.round(b.aht),
    days: b.days ?? null, requiredStaff: b.required ?? null, scheduledStaff: b.scheduled ?? null, sla: b.sl, occupancy: b.occ, edited: b.edited, b,
  })), [buckets, win?.grain, single]);
  // a single day shows the busy hours (like the reference), not the quiet overnight intervals; the six figures still count every interval
  const data = useMemo(() => {
    if (!single || !PER_BUCKET[win?.grain ?? ""]) return all;
    const peak = Math.max(0, ...all.map((d) => d.forecast));
    const t = Math.max(1, peak * 0.06);                                // the window follows the forecast, not stray overnight actuals
    const active = (d: (typeof all)[number]) => d.forecast >= t;
    const first = all.findIndex(active);
    const last = all.length - 1 - [...all].reverse().findIndex(active);
    return first < 0 ? all : all.slice(first, last + 1);
  }, [all, single, win?.grain]);

  // x-axis labels: on the hour for a single day (every 2 hours when the day is long), automatic for several days
  const xTicks = useMemo(() => {
    if (!single || !PER_BUCKET[win?.grain ?? ""]) return undefined;
    const perHour = 4 / PER_BUCKET[win!.grain];
    const step = data.length / perHour > 14 ? 2 : 1;
    const t = data.filter((d) => d.b.slot % (4 * step) === 0).map((d) => d.time);
    return t.length ? t : undefined;
  }, [data, single, win?.grain]);

  const seriesFor = full?.summary?.series?.find((s) => s.queueId === (queueId || null)) ?? full?.summary?.series?.[0];
  const sel = seriesFor?.scores.find((s) => s.selected);

  // ---- the six figures
  const totals = useMemo(() => {
    const forecast = all.reduce((a, d) => a + d.forecast, 0);
    const withActual = all.filter((d) => d.actual !== null);
    const actual = withActual.reduce((a, d) => a + (d.actual ?? 0), 0);
    const wape = actual > 0 ? withActual.reduce((a, d) => a + Math.abs(d.forecast - d.actual!), 0) / actual : null;
    const need = all.filter((d) => (d.requiredStaff ?? 0) > 0);
    const checked = need.filter((d) => d.scheduledStaff !== null);
    return {
      forecast, actual, actualCount: withActual.length, wape,
      aht: forecast > 0 ? Math.round(all.reduce((a, d) => a + d.aht * d.forecast, 0) / forecast) : 0,
      peakRequired: Math.max(0, ...all.map((d) => d.requiredStaff ?? 0)),
      coverage: checked.length ? (checked.filter((d) => d.scheduledStaff! >= d.requiredStaff!).length / checked.length) * 100 : null,
      sla: need.length ? (need.reduce((a, d) => a + d.sla, 0) / need.length) * 100 : null,
      occupancy: need.length ? (need.reduce((a, d) => a + d.occupancy, 0) / need.length) * 100 : null,
    };
  }, [all]);
  const showStaff = staffCols && all.some((d) => (d.requiredStaff ?? 0) > 0);

  // ---- explain one point
  const pinned = pin !== null ? data[pin] ?? null : null;
  const canTrace = !!pinned && intraday;
  const chan = (group?.queues.find((q) => q.id === queueId) ?? group?.queues.find((q) => q.channel === "VOICE") ?? group?.queues[0])?.channel === "CHAT" ? "chat" : "voice";
  const trace = useTrace(group?.id, canTrace && pinned && can("forecast:read") ? { volume: Math.round((pinned.forecast / (PER_BUCKET[win?.grain ?? "15"] ?? 1)) * 100) / 100, ahtSec: Math.max(1, pinned.aht), channel: chan as "voice" | "chat" } : null);
  const onChartClick = (e: any) => { const i = Number(e?.activeTooltipIndex ?? e?.activeIndex); if (Number.isFinite(i) && data[i]) setPin(i); };

  const exportCsv = () => {
    const lines = [["Interval", "Historical", "Forecast", "Actual", "AHT (s)", "Required", "Scheduled"].join(","), ...data.map((d) => [d.b.period ?? (PER_BUCKET[win?.grain ?? ""] ? `${d.b.day} ${slotLabel(d.b.slot)}` : d.b.day), d.historical ?? "", d.forecast, d.actual ?? "", d.aht, d.requiredStaff ?? "", d.scheduledStaff ?? ""].join(","))];
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([lines.join("\n")], { type: "text/csv" }));
    a.download = `forecast-${win?.from}-${win?.to}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };
  // a new version with the same horizon length, starting today, from the latest history
  const reforecast = async () => {
    if (!version || !group || !confirm("Create a new forecast version from the latest history? The current one is kept.")) return;
    setBusy(true); setNotice(null);
    try {
      const days = span(version.fromDay, version.toDay);
      const body: any = { groupId: group.id, kind };
      if (kind === "SHORT") body.weeks = Math.min(18, Math.max(1, Math.ceil(days / 7))); else body.days = Math.min(730, Math.max(30, days));
      const v = await api("/forecast/versions", { method: "POST", body });
      await reload(v.id);
      setNotice({ kind: "ok", text: `Created ${v.name}. It is a draft: check it, then submit it for approval.` });
    } catch (e: any) { setNotice({ kind: "err", text: e.message }); } finally { setBusy(false); }
  };

  if (!group) return null;
  const header = (
    <PageHeader
      breadcrumb={["Forecasting", "Forecast Dashboard"]}
      title="Forecast Dashboard"
      description={version ? `${group.name} — ${version.name} · version ${version.seq}` : group.name}
      actions={
        <>
          {version && <StatusPill status={version.status} />}
          {act.submit && <PrimaryButton onClick={act.submit} disabled={act.busy}>Submit for approval</PrimaryButton>}
          {act.approve && <PrimaryButton onClick={act.approve} disabled={act.busy}>Approve</PrimaryButton>}
          {act.publish && <PrimaryButton onClick={act.publish} disabled={act.busy}>Publish</PrimaryButton>}
          {act.returnToDraft && <OutlineButton onClick={act.returnToDraft} disabled={act.busy}>Return to draft</OutlineButton>}
          {act.clone && <OutlineButton onClick={act.clone} disabled={act.busy}>Clone to edit</OutlineButton>}
          {version && can("forecast:create") && (
            <OutlineButton onClick={reforecast} disabled={busy}><RefreshCw className={`size-3.5 ${busy ? "animate-spin" : ""}`} /> Reforecast</OutlineButton>
          )}
          {can("forecast:create") && <PrimaryButton onClick={() => go("forecast-builder")}><Plus className="size-3.5" /> New forecast</PrimaryButton>}
        </>
      }
    />
  );
  if (!version) {
    return (
      <div>
        {header}
        <Toolbar>
          <Select label="Type" value={kind} options={[{ id: "SHORT", label: "Short-term" }, { id: "LONG", label: "Long-term" }]} onChange={(k) => setKind(k as "SHORT" | "LONG")} />
        </Toolbar>
        <div className="p-6">
          <Empty title={`No ${kind === "SHORT" ? "short-term" : "long-term"} forecast for ${group.name} yet`}>
            {can("forecast:create") ? <>Open <button className="underline" onClick={() => go("forecast-builder")}>Forecast Builder</button> to create one from your interval history.</> : "Someone with forecast permission needs to create one."}
          </Empty>
        </div>
      </div>
    );
  }

  const tone = (v: number | null, good: number, ok: number) => (v === null ? undefined : v < good ? "success" as const : v < ok ? "warning" as const : "critical" as const);
  return (
    <div>
      {header}
      <Toolbar>
        <Select label="Group" value={group.id} options={groups.map((g) => ({ id: g.id, label: g.name }))} onChange={(id) => setGroupId(id)} />
        <Select label="Type" value={kind} options={[{ id: "SHORT", label: "Short-term" }, { id: "LONG", label: "Long-term" }]} onChange={(k) => setKind(k as "SHORT" | "LONG")} />
        <Select label="Forecast" value={version.id}
          options={versions.filter((v) => v.kind === kind).map((v) => ({ id: v.id, label: `${v.status === "PUBLISHED" ? "● " : ""}${v.name} — ${STATUS_LABEL[v.status].toLowerCase()}${isNew(v) ? " — NEW" : ""}` }))}
          onChange={(id) => setVersionId(id)} />
        <Select label="Range" value={range} options={ranges} onChange={(r) => { setRange(r); setGrain(DEFAULT_GRAIN[r]); }} />
        <Select label="Interval" value={win?.grain ?? grain} options={INTERVALS[kind]} onChange={(g) => {
          setGrain(g as Grain);
          // days, weeks and months need a range wide enough to hold more than one of them, or the chart would be a single point
          if ((g === "day" || g === "week" || g === "month") && (range === "Day" || (range === "Week" && g !== "day"))) setRange("Month");
        }} />
        <Select label="Queue" value={queueId} options={[{ id: "", label: "All queues" }, ...group.queues.map((q) => ({ id: q.id, label: q.name }))]} onChange={setQueueId} />
        {range !== "Month" && <DateField label={range === "Custom Range" ? "From" : "Starting"} value={win?.from ?? start} min={version.fromDay} max={version.toDay} onChange={setStart} />}
        {range === "Custom Range" && <DateField label="To" value={win?.to ?? end} min={start || version.fromDay} max={version.toDay} onChange={setEnd} />}
        <div className="ml-auto flex items-center gap-2">
          {act.remove && <button onClick={act.remove} disabled={act.busy} className="h-9 rounded-md px-3 text-critical transition-colors hover:bg-background disabled:opacity-50">Delete</button>}
          {act.exportAll && <button onClick={act.exportAll} disabled={act.busy} title="The whole forecast, every interval" className="flex h-9 items-center gap-1.5 rounded-md border bg-background px-3 transition-colors hover:bg-surface disabled:opacity-50">Export all</button>}
          <button onClick={exportCsv} disabled={data.length === 0} className="flex h-9 items-center gap-1.5 rounded-md border bg-background px-3 transition-colors hover:bg-surface disabled:opacity-50">
            <Download className="size-3.5" /> Export
          </button>
        </div>
      </Toolbar>

      {res.error && <div className="px-6 pt-3"><Banner kind="err">{res.error}</Banner></div>}

      <div className="grid grid-cols-2 divide-x divide-y border-b md:grid-cols-3 xl:grid-cols-6 xl:divide-y-0">
        <Metric label="Forecast volume" value={int(totals.forecast)} hint={win ? (single ? dayName(win.from) : `${range === "Custom Range" ? "Range" : range} total`) : ""} />
        <Metric label="Actual volume" value={totals.actualCount ? int(totals.actual) : "–"} delta={totals.actualCount ? `${totals.actualCount} of ${all.length} intervals` : undefined} hint={totals.actualCount ? undefined : "None yet in this range"} />
        <Metric label="WAPE" title="Weighted absolute percentage error: how far the forecast was from what happened"
          value={totals.wape !== null ? `${(totals.wape * 100).toFixed(1)}%` : sel ? `${(sel.wape * 100).toFixed(1)}%` : "–"}
          delta={totals.wape !== null ? (totals.wape < 0.05 ? "Within tolerance" : totals.wape < 0.1 ? "Watch closely" : "Outside tolerance") : sel ? `Backtest · ${lean(sel.bias)}` : undefined}
          tone={tone(totals.wape ?? sel?.wape ?? null, 0.05, 0.1)} />
        <Metric label="Average AHT" value={totals.aht ? `${totals.aht} sec` : "–"} hint="Weighted" />
        <Metric label="Peak required staff" value={showStaff ? String(totals.peakRequired) : "–"} delta={totals.coverage !== null ? `Coverage ${totals.coverage.toFixed(0)}%` : undefined} hint={totals.coverage === null && showStaff ? "No published schedule yet" : !staffCols ? "Pick a time-of-day interval" : undefined} tone={totals.coverage !== null ? (totals.coverage > 80 ? "success" : "warning") : undefined} />
        <Metric label="Service level" value={totals.sla !== null ? `${totals.sla.toFixed(0)}%` : "–"} hint={!staffCols ? "Pick a time-of-day interval" : undefined} delta={totals.occupancy !== null ? `Occupancy ${totals.occupancy.toFixed(0)}%` : undefined} tone={totals.sla !== null ? (totals.sla >= 80 ? "success" : "warning") : undefined} />
      </div>

      <Section
        title="Volume — historical, forecast and actual"
        action={
          <div className="flex items-center gap-3 text-[12px] text-muted-foreground">
            <Legend color="var(--color-border-strong)" label="Historical" />
            <Legend color="var(--color-chart-2)" label="Forecast" />
            <Legend color="var(--color-foreground)" label="Actual" />
            <Legend color="var(--color-info-bg)" label="Confidence band" />
          </div>
        }
      >
        <div className="h-80 px-4 pb-6">
          {res.loading && data.length === 0 ? <Busy text="Loading…" /> : data.length === 0 ? <Empty title="No data in this range" /> : (
            <ResponsiveContainer width="100%" height="100%">
              <ComposedChart data={data} margin={{ top: 8, right: 16, bottom: 0, left: 0 }} onClick={onChartClick} style={{ cursor: "pointer" }}>
                <CartesianGrid vertical={false} stroke="var(--color-border)" />
                <XAxis dataKey="time" tickLine={false} axisLine={false} fontSize={12} minTickGap={16} ticks={xTicks} interval={xTicks ? 0 : "preserveEnd"} />
                <YAxis tickLine={false} axisLine={false} fontSize={12} width={44} />
                <Tooltip content={<ChartTooltip extra={(p: any) => [p.days ? `${p.days} day${p.days === 1 ? "" : "s"} in this ${win?.grain}` : null, p.edited ? "Adjusted by a planner" : null].filter(Boolean).join(" · ") || null} />} />
                <Area dataKey="upper" stroke="none" fill="var(--color-info-bg)" fillOpacity={1} activeDot={false} isAnimationActive={false} />
                <Area dataKey="lower" stroke="none" fill="var(--color-background)" fillOpacity={1} activeDot={false} isAnimationActive={false} />
                <Bar dataKey="historical" fill="var(--color-surface-subtle)" radius={2} isAnimationActive={false} />
                <Line dataKey="forecast" stroke="var(--color-chart-2)" strokeWidth={2} dot={data.length <= 3 ? { r: 3 } : false} type="monotone" isAnimationActive={false} />
                <Line dataKey="actual" stroke="var(--color-foreground)" strokeWidth={2} dot={data.length <= 3 ? { r: 3 } : false} type="monotone" connectNulls={false} isAnimationActive={false} />
                {pinned && <ReferenceLine x={pinned.time} stroke="var(--color-foreground)" strokeDasharray="4 3" />}
              </ComposedChart>
            </ResponsiveContainer>
          )}
        </div>
        {data.length > 0 && <p className="-mt-3 px-6 pb-3 text-[12px] text-subtle-foreground">Hover for the numbers. Click a point to see how it is worked out.{(win?.grain === "week" || win?.grain === "month") ? " The first and last week or month can be partial, so they may look lower." : ""}{kind === "LONG" && intraday ? " A long-term forecast is one number per day: the times of day are that number spread over your usual pattern for the weekday." : ""}</p>}
      </Section>

      {pinned && (
        <Section
          title={<span className="flex items-center gap-2"><Calculator className="size-4 text-info" />How this number is worked out: {pinned.time}</span>}
          action={<button onClick={() => setPin(null)} className="rounded p-1 text-subtle-foreground hover:bg-surface hover:text-foreground" aria-label="Close explanation"><X className="size-4" /></button>}
        >
          <div className="space-y-4 px-6 pb-5">
            <div className="grid grid-cols-1 gap-4 text-[13px] lg:grid-cols-3">
              <div className="space-y-1.5 rounded-lg border p-4">
                <div className="text-[11px] font-semibold uppercase tracking-wider text-subtle-foreground">1 · Expected contacts</div>
                <p><b className="num">{dec(pinned.forecast, 1)}</b> contacts{win?.grain === "60" ? " in the hour" : win?.grain === "30" ? " in 30 minutes" : win?.grain === "15" ? " in 15 minutes" : ""}, from the <b>{seriesFor ? MODEL_LABEL[seriesFor.model] ?? seriesFor.model : "selected"}</b> model.</p>
                <p className="text-muted-foreground">{sel ? `On your last 4 weeks this model missed by about ${pct(sel.wape, 1)} a day (${lean(sel.bias)}), the best of those tested.` : "The most accurate method on your own history was chosen."}</p>
              </div>
              <div className="space-y-1.5 rounded-lg border p-4">
                <div className="text-[11px] font-semibold uppercase tracking-wider text-subtle-foreground">2 · How sure we are</div>
                <p>About 8 in 10 comparable days land between <b className="num">{dec(pinned.lower, 0)}</b> and <b className="num">{dec(pinned.upper, 0)}</b> contacts.</p>
                <p className="text-muted-foreground">Handle time <b className="num">{pinned.aht}s</b> per contact, from recent history.{pinned.edited ? <span className="text-warning"> A planner adjusted this value; the reason is on the Adjustments screen.</span> : ""}</p>
              </div>
              <div className="space-y-1.5 rounded-lg border p-4">
                <div className="text-[11px] font-semibold uppercase tracking-wider text-subtle-foreground">3 · Agents needed</div>
                {canTrace
                  ? <p>{(pinned.requiredStaff ?? 0) > 0 ? <><b className="num">{pinned.requiredStaff}</b> agents on the schedule at {pct(pinned.sla)} service level. The steps are below.</> : "No agents needed: the queue is closed or has no contacts."}</p>
                  : <p className="text-muted-foreground">Set Interval to 15, 30 or 60 min and click a point to see the staffing steps.</p>}
              </div>
            </div>
            {canTrace && can("forecast:read") && <TracePanel data={trace.data} error={trace.error} />}
            {canTrace && win?.grain !== "15" && <p className="text-[11px] text-subtle-foreground">{win?.grain === "60" ? "Hourly" : "Half-hour"} points are explained as an average 15-minute interval within the {win?.grain === "60" ? "hour" : "half hour"}.</p>}
          </div>
        </Section>
      )}

      {staffCols && data.length > 0 && (
        <Section title="Required versus scheduled staff">
          <div className="h-64 px-4 pb-6">
            <ResponsiveContainer width="100%" height="100%">
              <ComposedChart data={data} margin={{ top: 8, right: 16, bottom: 0, left: 0 }}>
                <CartesianGrid vertical={false} stroke="var(--color-border)" />
                <XAxis dataKey="time" tickLine={false} axisLine={false} fontSize={12} minTickGap={16} ticks={xTicks} interval={xTicks ? 0 : "preserveEnd"} />
                <YAxis tickLine={false} axisLine={false} fontSize={12} width={44} />
                <Tooltip content={<ChartTooltip />} />               <Bar dataKey="scheduledStaff" fill="var(--color-surface-subtle)" radius={2} isAnimationActive={false} />
                <Line dataKey="requiredStaff" stroke="var(--color-critical)" strokeWidth={2} dot={false} type="stepAfter" isAnimationActive={false} />
              </ComposedChart>
            </ResponsiveContainer>
          </div>
          {!data.some((d) => d.scheduledStaff !== null) && <p className="-mt-3 px-6 pb-3 text-[12px] text-subtle-foreground">No published schedule covers this range yet, so only the required line is shown. Publish one under Scheduling.</p>}
        </Section>
      )}

      {data.length > 0 && (
        <Section title="Average handle time by time of day" action={<span className="text-[12px] text-muted-foreground">Same range as above — switch Interval or Range to compare a weekday against a weekend, or one queue against another</span>}>
          <div className="h-56 px-4 pb-6">
            <ResponsiveContainer width="100%" height="100%">
              <ComposedChart data={data} margin={{ top: 8, right: 16, bottom: 0, left: 0 }}>
                <CartesianGrid vertical={false} stroke="var(--color-border)" />
                <XAxis dataKey="time" tickLine={false} axisLine={false} fontSize={12} minTickGap={16} ticks={xTicks} interval={xTicks ? 0 : "preserveEnd"} />
                <YAxis tickLine={false} axisLine={false} fontSize={12} width={44} unit="s" />
                <Tooltip content={<ChartTooltip />} />
                <Line dataKey="aht" name="Handle time" stroke="var(--color-chart-2)" strokeWidth={2} dot={data.length <= 3 ? { r: 3 } : false} type="monotone" isAnimationActive={false} />
              </ComposedChart>
            </ResponsiveContainer>
          </div>
          <p className="-mt-3 px-6 pb-3 text-[12px] text-subtle-foreground">The forecast's own handle-time profile — where it climbs or dips across the day (or across days at a daily/weekly grain) is the shape staffing is built from, not a flat average.</p>
        </Section>
      )}

      <Section title={win?.grain === "day" ? "Daily detail" : win?.grain === "week" ? "Weekly detail" : win?.grain === "month" ? "Monthly detail" : "Interval detail"}>
        <div className="max-h-[520px] overflow-auto">
          <table className="num w-full text-[13px]">
            <thead className="sticky top-0 border-y bg-surface text-left text-[12px] text-subtle-foreground">
              <tr>
                {[firstCol, "Historical", "Forecast", "Actual", "Variance", "AHT", ...(staffCols ? ["Required", "Scheduled", "Coverage"] : [])].map((h) => (
                  <th key={h} className="px-6 py-2 font-medium first:w-32">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data.map((d, i) => {
                const fc = Math.round(d.forecast);                       // whole contacts, as in the reference
                const variance = d.actual === null ? null : d.actual - fc;
                const varText = variance === null ? "—" : `${variance > 0 ? "+" : ""}${variance}`;
                const gap = d.scheduledStaff === null || d.requiredStaff === null ? null : d.scheduledStaff - d.requiredStaff;
                return (
                  <tr key={`${d.b.day}-${d.time}-${i}`} className="border-b transition-colors last:border-0 hover:bg-surface">
                    <td className="px-6 py-2 font-medium">{d.rowLabel}</td>
                    <td className="px-6 py-2 text-muted-foreground">{d.historical ?? "—"}</td>
                    <td className="px-6 py-2">{fc}{d.edited && <span title="Adjusted by a planner" className="text-warning"> ●</span>}</td>
                    <td className="px-6 py-2">{d.actual ?? "—"}</td>
                    <td className={`px-6 py-2 ${variance === null ? "text-subtle-foreground" : Math.abs(variance) > Math.max(1, fc * 0.1) ? "text-critical" : "text-success"}`}>
                      {varText}
                    </td>
                    <td className="px-6 py-2 text-muted-foreground">{d.aht}s</td>
                    {staffCols && <td className="px-6 py-2 font-medium">{d.requiredStaff ?? "—"}</td>}
                    {staffCols && <td className="px-6 py-2 text-muted-foreground">{d.scheduledStaff ?? "—"}</td>}
                    {staffCols && (
                      <td className={`px-6 py-2 ${gap === null ? "text-subtle-foreground" : gap >= 0 ? "text-success" : "text-critical"}`}>
                        {gap === null ? "—" : gap > 0 ? `+${gap}` : gap}
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      {!staffCols && <p className="px-6 pb-4 text-[12px] text-subtle-foreground">Required and scheduled people are worked out for short-term forecasts. For a time-of-day view choose a 15, 30 or 60 min Interval; for the long-term people plan open Staffing.</p>}
      </Section>

      {seriesFor && seriesFor.notes?.length > 0 && (
        <Section title="How this forecast was prepared">
          <ul className="list-disc space-y-1 pb-5 pl-11 pr-6 text-[13px] text-muted-foreground">{seriesFor.notes.map((n, i) => <li key={i}>{n}</li>)}</ul>
        </Section>
      )}
    </div>
  );
}

function Legend({ color, label }: { color: string; label: string }) {
  return (
    <span className="flex items-center gap-1.5">
      <span className="size-2.5 rounded-xs" style={{ backgroundColor: color }} />
      {label}
    </span>
  );
}
