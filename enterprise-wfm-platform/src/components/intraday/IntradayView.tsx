/**
 * Intraday & RTA, live against the gateway. Layout follows the market WFM products (NICE, Verint/Calabrio, Genesys):
 *  - Live Coverage: contacts so far vs forecast, the reforecast for the rest of the day, and scheduled vs needed staff per 15 minutes.
 *  - Real-Time Adherence: who is in / out of adherence right now (actual state mapped to an activity vs the published schedule),
 *    with counts, the day's adherence %, and states that still need mapping.
 *  - Recommended Actions: plain rule-based suggestions for the coming shortfalls and surpluses. Nothing is applied automatically.
 * Nothing is seeded: every screen says what is missing and where to add it.
 */

import React, { useEffect, useMemo, useState } from 'react';
import { ColDef, ICellRendererParams } from 'ag-grid-community';
import { AlertTriangle, CheckCircle2, RefreshCw } from 'lucide-react';
import { Activity, Adherence, AdherenceAgent, AdherenceStatus, ACTIVITY_CATEGORY_LABEL, api, BreakSuggestions, Coverage, CoverageSlot } from '../../services/api';
import { useForecast } from '../../services/forecastStore';
import { useApi } from '../forecasting/hooks';
import { Grid } from '../forecasting/Grid';
import { CHART, LineChart } from '../forecasting/charts';
import { Banner, Btn, Busy, Card, Empty, Input, Kpi, KpiRow, PageHeader, Pill, Select } from '../forecasting/ui';

import { AdherenceScreen } from './AdherencePanel';
import { useTick } from './adherenceShared';

interface IntradayViewProps { activeSubSection?: string }

const hm = (min: number) => `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
const signed = (n: number, d = 1) => `${n > 0 ? '+' : ''}${n.toFixed(d)}`;

export const IntradayView: React.FC<IntradayViewProps> = ({ activeSubSection = 'live-coverage' }) => {
  const { group } = useForecast();
  const [day, setDay] = useState('');           // '' = today in the group's time zone
  const title = activeSubSection === 'adherence' ? 'Real-Time Adherence' : activeSubSection === 'ai-recommendations' ? 'Recommended Actions' : activeSubSection === 'break-optimizer' ? 'Break Optimizer' : 'Live Coverage';
  const sub = activeSubSection === 'adherence'
    ? 'Each person’s actual state, turned into an activity, against what the published schedule says they should be doing right now.'
    : activeSubSection === 'ai-recommendations'
      ? 'Suggestions for the coming intervals, worked out from the reforecast and the published schedule. Nothing is changed automatically.'
      : activeSubSection === 'break-optimizer'
        ? 'Moves only breaks and meals that have not started yet, to where the forecast needs the person less right now. Never touches a shift’s own start, end or paid hours.'
        : 'Contacts so far against the published forecast, the reforecast for the rest of the day, and scheduled against needed staff.';

  return (
    <div className="flex-1 flex flex-col h-[calc(100vh-3.5rem)] overflow-y-auto bg-[#FFFFFF] p-6 space-y-6 select-none">
      <PageHeader title={title} sub={sub} badge={!day && <span className="text-[11px] font-semibold px-2 py-0.5 rounded-full bg-[#EAF5EF] text-[#2A7553] border border-[#2F7D5A]/20">Today</span>}
        actions={activeSubSection !== 'break-optimizer' && <><Input type="date" value={day} onChange={(e) => setDay(e.target.value)} aria-label="Day" className="w-40" />{day && <Btn onClick={() => setDay('')}>Back to today</Btn>}</>} />
      {!group
        ? <Empty title="No WFM group yet">Create a WFM group first (Configuration › WFM Groups).</Empty>
        : activeSubSection === 'adherence' ? <AdherenceScreen groupId={group.id} day={day} />
          : activeSubSection === 'ai-recommendations' ? <ActionsScreen groupId={group.id} day={day} />
            : activeSubSection === 'break-optimizer' ? <BreakOptimizerScreen groupId={group.id} />
              : <CoverageScreen groupId={group.id} day={day} />}
    </div>
  );
};

// ---------------------------------------------------------------- live coverage

const useCoverage = (groupId: string, day: string) => {
  const tick = useTick(30_000, !day);
  const res = useApi<Coverage>(`/intraday/coverage?groupId=${groupId}${day ? `&day=${day}` : ''}`, [tick, groupId, day]);
  return res;
};

const CoverageScreen: React.FC<{ groupId: string; day: string }> = ({ groupId, day }) => {
  const { go } = useForecast();
  const cov = useCoverage(groupId, day);
  const c = cov.data;
  const cols = useMemo<ColDef<CoverageSlot>[]>(() => [
    { headerName: 'Time', field: 'time', width: 90, pinned: 'left' },
    { headerName: 'Forecast', field: 'forecast', width: 105, type: 'rightAligned' },
    { headerName: 'Actual', field: 'actual', width: 100, type: 'rightAligned', valueFormatter: (p) => (p.value === null ? '–' : String(p.value)) },
    { headerName: 'vs forecast', width: 120, type: 'rightAligned', valueGetter: (p) => (p.data && p.data.actual !== null && p.data.forecast > 0 ? ((p.data.actual - p.data.forecast) / p.data.forecast) * 100 : null), valueFormatter: (p) => (p.value === null ? '–' : `${signed(p.value, 0)}%`) },
    { headerName: 'Reforecast', field: 'reforecast', width: 115, type: 'rightAligned', valueFormatter: (p) => (p.value === null ? '–' : String(p.value)) },
    { headerName: 'Needed', field: 'required', width: 100, type: 'rightAligned' },
    { headerName: 'Needed now', field: 'requiredReforecast', width: 120, type: 'rightAligned', valueFormatter: (p) => (p.value === null ? '–' : String(p.value)) },
    { headerName: 'Scheduled', field: 'scheduled', width: 110, type: 'rightAligned' },
    { headerName: 'Over / under', width: 125, type: 'rightAligned', valueGetter: (p) => (p.data ? p.data.scheduled - (p.data.requiredReforecast ?? p.data.required) : null),
      cellRenderer: (p: ICellRendererParams<CoverageSlot>) => { const v = p.value as number | null; return v === null ? null : <span className={v <= -1 ? 'text-[#BC3F3F] font-semibold' : v >= 2 ? 'text-[#8F6200] font-semibold' : 'text-[#2A7553]'}>{signed(v)}</span>; } },
  ], []);

  if (cov.loading && !c) return <Busy text="Loading coverage…" />;
  if (cov.error) return <Banner kind="err">{cov.error}</Banner>;
  if (!c) return null;
  if (c.ready === false) return <Empty title="Nothing to compare yet">{c.reason}</Empty>;

  const slots = c.slots.slice(c.first, c.last + 1);
  const labels = slots.map((s) => s.time);
  const cur = c.slots[Math.min(95, c.nowSlot)];
  const isToday = c.nowTime !== null;
  const gapNow = cur ? cur.scheduled - (cur.requiredReforecast ?? cur.required) : 0;
  const soon = c.gaps.slice(0, 8);
  const worst = soon.reduce<{ time: string; gap: number } | null>((w, g) => (!w || g.gap < w.gap ? g : w), null);
  const vsFc = c.totals.forecastSoFar > 0 && c.hasActuals ? ((c.totals.actualSoFar - c.totals.forecastSoFar) / c.totals.forecastSoFar) * 100 : null;

  return (
    <div className="space-y-6">
      {!c.hasActuals && isToday && <Banner kind="info">No live contact counts have arrived for today. Send them from your phone system to the live feed (Data Management) and this screen will start comparing them with the forecast.</Banner>}
      {!c.hasSchedule && <Banner kind="warn">There is no published schedule for this day, so scheduled staff shows as zero. Publish one under Scheduling.</Banner>}
      <KpiRow>
        <Kpi label="Contacts so far" value={c.hasActuals ? c.totals.actualSoFar.toLocaleString() : '–'} sub={vsFc === null ? `Forecast ${c.totals.forecastSoFar.toLocaleString()}` : `${signed(vsFc, 0)}% vs forecast (${c.totals.forecastSoFar.toLocaleString()})`} tone={vsFc === null ? undefined : Math.abs(vsFc) > 15 ? 'bad' : Math.abs(vsFc) > 7 ? 'warn' : 'good'} />
        <Kpi label="Expected for the day" value={(c.totals.reforecastDay ?? c.totals.forecastDay).toLocaleString()} sub={c.reforecast.applied ? `Reforecast (${c.reforecast.ratio}× the forecast). Forecast was ${c.totals.forecastDay.toLocaleString()}` : `From ${c.forecastName}`} />
        {isToday
          ? <Kpi label={`Staffing at ${c.nowTime}`} value={`${cur?.scheduled ?? 0} of ${Math.round(cur ? cur.requiredReforecast ?? cur.required : 0)}`} sub={gapNow <= -1 ? `Short by ${Math.abs(gapNow).toFixed(1)}` : gapNow >= 2 ? `${gapNow.toFixed(1)} more than needed` : 'About right'} tone={gapNow <= -1 ? 'bad' : gapNow >= 2 ? 'warn' : 'good'} />
          : <Kpi label="Busiest interval" value={`${Math.max(...slots.map((s) => s.forecast))} contacts`} sub={slots.reduce((b, s) => (s.forecast > b.forecast ? s : b), slots[0]).time} />}
        {isToday && <Kpi label="Next two hours" value={worst && worst.gap <= -1 ? `Short ${Math.abs(worst.gap).toFixed(1)}` : 'On track'} sub={worst && worst.gap <= -1 ? `Tightest at ${worst.time}` : 'Scheduled covers what is needed'} tone={worst && worst.gap <= -1 ? 'bad' : 'good'} />}
      </KpiRow>

      <Card title="Contacts" sub={`Per 15 minutes. ${c.reforecast.applied ? `The reforecast reads today’s actuals and adjusts the rest of the day (trusted ${Math.round(c.reforecast.credibility * 100)}%).` : 'The reforecast appears once contacts start arriving.'}`}>
        <LineChart labels={labels} height={260} xEvery={4} leftLabel="Contacts"
          series={[
            { name: 'Forecast', color: CHART.forecast, kind: 'dashed', values: slots.map((s) => s.forecast) },
            { name: 'Actual', color: CHART.success, kind: 'bar', values: slots.map((s) => s.actual) },
            { name: 'Reforecast', color: CHART.reforecast, kind: 'line', values: slots.map((s) => s.reforecast) },
          ]} />
      </Card>
      <Card title="Staffing" sub="People on shift against people needed. Needed already allows for breaks and time away from the queue.">
        <LineChart labels={labels} height={260} xEvery={4} leftLabel="People"
          series={[
            { name: 'Needed', color: CHART.baseline, kind: 'dashed', values: slots.map((s) => s.required) },
            { name: 'Needed after reforecast', color: CHART.agents, kind: 'line', values: slots.map((s) => s.requiredReforecast) },
            { name: 'Scheduled', color: CHART.scheduled, kind: 'step', values: slots.map((s) => s.scheduled) },
          ]} />
      </Card>
      <Card title="Every 15 minutes" actions={<Btn onClick={() => go('scheduled-syncs', 'data-management')}>How to send live counts</Btn>}>
        <Grid<CoverageSlot> rowData={slots} columnDefs={cols} defaultColDef={{ sortable: true, resizable: true }} height={420} getRowStyle={(p) => (p.data && isToday && p.data.slot === c.nowSlot ? { background: '#FFF5DD' } : undefined)} />
      </Card>
    </div>
  );
};

// ---------------------------------------------------------------- recommended actions

type Window = { from: string; to: string; kind: 'short' | 'over'; size: number; slots: number };

/** Runs of upcoming intervals that are short (1+ people) or over (2+ people), at least 30 minutes long. */
function windows(gaps: { slot: number; time: string; gap: number }[]): Window[] {
  const out: Window[] = []; let cur: { kind: 'short' | 'over'; g: typeof gaps } | null = null;
  const flush = () => { if (cur && cur.g.length >= 2) { const worst = cur.kind === 'short' ? Math.min(...cur.g.map((x) => x.gap)) : Math.max(...cur.g.map((x) => x.gap)); out.push({ kind: cur.kind, from: cur.g[0].time, to: nextTime(cur.g.at(-1)!.slot), size: Math.abs(worst), slots: cur.g.length }); } cur = null; };
  for (const g of gaps) {
    const kind = g.gap <= -1 ? 'short' : g.gap >= 2 ? 'over' : null;
    if (!kind || (cur && (cur.kind !== kind || g.slot !== cur.g.at(-1)!.slot + 1))) flush();
    if (kind) { if (!cur) cur = { kind, g: [] }; cur.g.push(g); }
  }
  flush();
  return out;
}
const nextTime = (slot: number) => { const m = ((slot + 1) * 15) % 1440; return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`; };

const ActionsScreen: React.FC<{ groupId: string; day: string }> = ({ groupId, day }) => {
  const cov = useCoverage(groupId, day);
  const c = cov.data;
  if (cov.loading && !c) return <Busy text="Working out the coming intervals…" />;
  if (cov.error) return <Banner kind="err">{cov.error}</Banner>;
  if (!c) return null;
  if (c.ready === false) return <Empty title="Nothing to recommend yet">{c.reason}</Empty>;
  if (c.nowTime === null) return <Empty title="Pick today">Recommendations look ahead from now, so they only make sense for today.</Empty>;
  const ws = windows(c.gaps);
  return (
    <div className="space-y-4">
      {!c.reforecast.applied && <Banner kind="info">Contacts have not started arriving yet, so these use the published forecast. They sharpen once live counts come in.</Banner>}
      {ws.length === 0
        ? <Card><div className="flex items-center gap-2 text-[14px]"><CheckCircle2 className="w-5 h-5 text-[#2A7553]" />The rest of the day looks covered: no stretch of 30 minutes or more is short by one person or over by two.</div></Card>
        : ws.map((w, i) => (
          <Card key={i}>
            <div className="flex items-start gap-3">
              <AlertTriangle className={`w-5 h-5 mt-0.5 ${w.kind === 'short' ? 'text-[#BC3F3F]' : 'text-[#8F6200]'}`} />
              <div className="space-y-1.5">
                <div className="text-[14px] font-semibold">{w.kind === 'short' ? `Short by up to ${w.size.toFixed(1)} people` : `${w.size.toFixed(1)} more people than needed at the most`} · {w.from}–{w.to}</div>
                <ul className="text-[13px] text-[#525252] list-disc pl-5 space-y-0.5">
                  {w.kind === 'short'
                    ? <><li>Move training, coaching or meetings out of this window.</li><li>Offer overtime or voluntary extra time to people finishing or starting nearby.</li><li>Hold back breaks and meals that have not started, where the rules allow.</li></>
                    : <><li>Offer voluntary time off or an early finish.</li><li>Use the time for training or coaching.</li><li>Bring forward breaks and meals.</li></>}
                </ul>
                <div className="text-[12px] text-[#6B6B6B]">Based on {c.reforecast.applied ? `today’s reforecast (${c.reforecast.ratio}× the forecast)` : 'the published forecast'} against the published schedule.</div>
              </div>
            </div>
          </Card>
        ))}
      <GapFixPanel groupId={groupId} />
    </div>
  );
};

// ---------------------------------------------------------------- who could close the gap (named, rule-checked)

interface GapFix { kind: string; action: string; employeeId: string; name: string; newStart: number; newLength: number; newStartTime: string; newEndTime: string; coverFromTime: string; coverToTime: string; slotsClosed: number; slotsWasted: number; paidMinutes: number; pastContractMinutes: number; why: string }
interface GapFixes { day: string; ready: boolean; reason?: string; nowTime?: string; reforecastApplied?: boolean; before?: { shortSlots: number }; after?: { shortSlots: number }; fixes: GapFix[] }

const GapFixPanel: React.FC<{ groupId: string }> = ({ groupId }) => {
  const { can } = useForecast();
  const canAct = can('intraday:act');
  const [tick, setTick] = useState(0);
  const t = useTick(60_000, true);
  const res = useApi<GapFixes>(`/intraday/gap-fixes?groupId=${groupId}`, [t, tick, groupId]);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  const s = res.data;
  useEffect(() => { setPicked(new Set()); }, [s?.fixes.length]);
  if (!s || !s.ready || !s.fixes.length) return s && s.ready ? <Card title="Who could help"><div className="text-[13px] text-[#525252]">Nobody needs to change: no one is short enough, or too many on, to be worth asking anyone as of {s.nowTime}.</div></Card> : null;
  const key = (f: GapFix) => `${f.employeeId}|${f.kind}`;
  const apply = async (list: GapFix[]) => {
    if (!list.length) return;
    if (reason.trim().length < 3) { setError('Say why you are changing the schedule (a few words).'); return; }
    setBusy(true); setError(''); setNote('');
    try {
      const r = await api<{ applied: number; notes: string[]; refused: { name: string; why: string }[]; needsRepublish: boolean }>('/intraday/gap-fixes/apply', { method: 'POST', body: { groupId, day: s.day, reason: reason.trim(), fixes: list.map((f) => ({ employeeId: f.employeeId, kind: f.kind, newStart: f.newStart, newLength: f.newLength })) } });
      setNote(`${r.applied} change${r.applied === 1 ? '' : 's'} made.${r.refused.length ? ` Not made: ${r.refused.map((x) => `${x.name} (${x.why})`).join('; ')}` : ''}${r.needsRepublish ? ' The schedule now has unpublished changes: publish it again so people see theirs.' : ''}`);
      setTick((x) => x + 1);
    } catch (e: any) { setError(e.message); } finally { setBusy(false); }
  };
  const chosen = s.fixes.filter((f) => picked.has(key(f)));
  return (
    <Card title="Who could help" sub={`As of ${s.nowTime}. Each person has to agree. Their weekly limit, rest between shifts, availability and time off have been checked.${s.before && s.after ? ` Doing all of these takes the shortage from ${s.before.shortSlots} to ${s.after.shortSlots} person-quarter-hours.` : ''}`}>
      {error && <Banner kind="err" onClose={() => setError('')}>{error}</Banner>}
      {note && <Banner kind="info" onClose={() => setNote('')}>{note}</Banner>}
      <div className="border border-[#E5E5E0] rounded-lg overflow-hidden">
        <table className="w-full text-[13px]">
          <thead className="bg-[#FAFAF8] text-[#6B6B6B] text-[11px] uppercase tracking-wider border-b border-[#E5E5E0]">
            <tr>{canAct && <th className="p-3 w-8"></th>}<th className="p-3 text-left">Person</th><th className="p-3 text-left">Ask</th><th className="p-3 text-left">New shift</th><th className="p-3 text-left">Helps</th><th className="p-3 text-left">Cost</th></tr>
          </thead>
          <tbody className="divide-y divide-[#E5E5E0]">
            {s.fixes.map((f) => (
              <tr key={key(f)} className="hover:bg-[#FAFAF8]">
                {canAct && <td className="p-3"><input type="checkbox" checked={picked.has(key(f))} onChange={() => setPicked((p) => { const n = new Set(p); n.has(key(f)) ? n.delete(key(f)) : n.add(key(f)); return n; })} /></td>}
                <td className="p-3 font-semibold">{f.name}</td>
                <td className="p-3">{f.action}<div className="text-[12px] text-[#6B6B6B]">{f.why}</div></td>
                <td className="p-3 font-mono">{f.newStartTime}–{f.newEndTime}</td>
                <td className="p-3">{f.kind.startsWith('RELEASE') ? `${f.slotsClosed * 15} min with fewer people` : `${f.coverFromTime}–${f.coverToTime}, closes ${(f.slotsClosed * 15 / 60).toFixed(1)} person-hours${f.slotsWasted ? ` (${(f.slotsWasted * 15 / 60).toFixed(1)} h not needed)` : ''}`}</td>
                <td className="p-3">{f.paidMinutes > 0 ? `+${f.paidMinutes / 60} h paid${f.pastContractMinutes ? `, ${f.pastContractMinutes / 60} h past contract` : ''}` : `${f.paidMinutes / 60} h paid`}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {canAct && (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Reason (required), e.g. volume running 20% over forecast" className="max-w-md" />
          <Btn variant="primary" disabled={busy || !chosen.length} onClick={() => apply(chosen)}>{chosen.length ? `Make ${chosen.length} selected change${chosen.length === 1 ? '' : 's'}` : 'Select who to ask'}</Btn>
        </div>
      )}
    </Card>
  );
};

// ---------------------------------------------------------------- dynamic break re-optimization

const BreakOptimizerScreen: React.FC<{ groupId: string }> = ({ groupId }) => {
  const { can } = useForecast();
  const canAct = can('intraday:act');
  const [tick, setTick] = useState(0);
  const t = useTick(60_000, true);
  const res = useApi<BreakSuggestions>(`/intraday/break-suggestions?groupId=${groupId}`, [t, tick, groupId]);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const s = res.data;
  const key = (x: { shiftId: string; type: string; fromSlot: number }) => `${x.shiftId}|${x.type}|${x.fromSlot}`;

  useEffect(() => { setPicked(new Set()); }, [s?.suggestions.length]);
  const toggle = (k: string) => setPicked((p) => { const n = new Set(p); n.has(k) ? n.delete(k) : n.add(k); return n; });

  const apply = async (moves: BreakSuggestions['suggestions']) => {
    if (!moves.length) return;
    setBusy(true); setError('');
    try {
      await api(`/intraday/break-suggestions/apply`, { method: 'POST', body: { groupId, day: s!.day, moves: moves.map((m) => ({ shiftId: m.shiftId, type: m.type, fromSlot: m.fromSlot, toSlot: m.toSlot })) } });
      setTick((x) => x + 1);
    } catch (e: any) { setError(e.message); } finally { setBusy(false); }
  };

  if (res.loading && !s) return <Busy text="Looking for a better spot for upcoming breaks…" />;
  if (res.error) return <Banner kind="err">{res.error}</Banner>;
  if (!s) return null;
  if (!s.ready) return <Empty title="Nothing to optimize yet">{s.reason}</Empty>;
  if (!s.suggestions.length) return (
    <Card><div className="flex items-center gap-2 text-[14px]"><CheckCircle2 className="w-5 h-5 text-[#2A7553]" />No upcoming break or meal would help more if moved, as of {s.nowTime}. Checked again every minute.</div></Card>
  );

  return (
    <div className="space-y-4">
      {error && <Banner kind="err" onClose={() => setError('')}>{error}</Banner>}
      <div className="flex items-center justify-between">
        <p className="text-[12px] text-[#6B6B6B]">As of {s.nowTime}. {s.suggestions.length} suggestion{s.suggestions.length === 1 ? '' : 's'}, biggest improvement first.{s.reforecastApplied ? ' Weighed against how today is actually running, not just the plain forecast.' : ''}</p>
        {canAct && <Btn variant="primary" disabled={busy} onClick={() => apply(s.suggestions.filter((m) => picked.size === 0 || picked.has(key(m))))}>{picked.size ? `Apply ${picked.size} selected` : 'Apply all'}</Btn>}
      </div>
      <div className="border border-[#E5E5E0] rounded-lg overflow-hidden">
        <table className="w-full text-[13px]">
          <thead className="bg-[#FAFAF8] text-[#6B6B6B] text-[11px] uppercase tracking-wider border-b border-[#E5E5E0]">
            <tr>{canAct && <th className="p-3 w-8"></th>}<th className="p-3 text-left">Person</th><th className="p-3 text-left">What</th><th className="p-3 text-left">From</th><th className="p-3 text-left">To</th><th className="p-3 text-right">Helps by</th><th className="p-3"></th></tr>
          </thead>
          <tbody className="divide-y divide-[#E5E5E0]">
            {s.suggestions.map((m) => (
              <tr key={key(m)} className="hover:bg-[#FAFAF8]">
                {canAct && <td className="p-3"><input type="checkbox" checked={picked.has(key(m))} onChange={() => toggle(key(m))} /></td>}
                <td className="p-3 font-semibold">{m.employeeName}</td>
                <td className="p-3">{m.type === 'MEAL' ? 'Meal' : 'Break'}</td>
                <td className="p-3 font-mono">{m.from}</td>
                <td className="p-3 font-mono">{m.to}</td>
                <td className="p-3 text-right">{m.deficitReduction.toFixed(1)} fewer short-slots</td>
                <td className="p-3 text-right">{canAct && <button className="text-[12px] underline" disabled={busy} onClick={() => apply([m])}>Apply</button>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
};
