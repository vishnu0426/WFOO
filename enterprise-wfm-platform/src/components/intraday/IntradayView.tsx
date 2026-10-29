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

interface IntradayViewProps { activeSubSection?: string }

/** Re-fetch every `ms` while the screen is open (only for "today"; a past day never changes). */
const useTick = (ms: number, on: boolean) => {
  const [t, setT] = useState(0);
  useEffect(() => { if (!on) return; const id = setInterval(() => { if (!document.hidden) setT((x) => x + 1); }, ms); return () => clearInterval(id); }, [ms, on]);
  return t;
};

const REFRESH_OPTIONS = [0, 5, 10, 15, 30, 60, 300] as const;
const REFRESH_KEY = 'rta-refresh-seconds';
const refreshLabel = (s: number) => (s < 60 ? `${s} seconds` : `${s / 60} min`);
const useRefreshSetting = () => {
  const [sec, setSec] = useState<number>(() => {
    try { const v = Number(localStorage.getItem(REFRESH_KEY)); return (REFRESH_OPTIONS as readonly number[]).includes(v) ? v : 15; } catch { return 15; }
  });
  const change = (s: number) => {
    setSec(s);
    try { localStorage.setItem(REFRESH_KEY, String(s)); } catch { /* storage unavailable: keep it for this visit only */ }
  };
  return [sec, change] as const;
};
const PRIORITY: Record<AdherenceStatus, number> = { OUT: 0, UNSCHEDULED: 1, UNKNOWN: 2, IN: 3, IGNORED: 4, NOT_STARTED: 5, SHIFT_ENDED: 6 };

const STATUS: Record<AdherenceStatus, { label: string; tone: 'good' | 'bad' | 'warn' | 'neutral' | 'info' }> = {
  IN: { label: 'In adherence', tone: 'good' }, OUT: { label: 'Out of adherence', tone: 'bad' }, UNSCHEDULED: { label: 'Unscheduled', tone: 'warn' },
  IGNORED: { label: 'Ignored', tone: 'neutral' }, UNKNOWN: { label: 'No state yet', tone: 'info' }, NOT_STARTED: { label: 'Not started', tone: 'neutral' }, SHIFT_ENDED: { label: 'Shift ended', tone: 'neutral' },
};
const schedLabel = (s: string) => (s === 'SHIFT_ENDED' ? 'Shift ended' : s === 'NOT_STARTED' ? 'Not started' : s === 'NONE' ? 'Not scheduled' : ACTIVITY_CATEGORY_LABEL[s as keyof typeof ACTIVITY_CATEGORY_LABEL] ?? s);
const RUN_COLOR: Record<AdherenceStatus, string> = { IN: '#2F7D5A', OUT: '#C84A4A', UNSCHEDULED: '#B7791F', IGNORED: '#A3A3A3', UNKNOWN: '#8AA4C8', NOT_STARTED: 'transparent', SHIFT_ENDED: 'transparent' };
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
      <PageHeader title={title} sub={sub} badge={!day && <span className="text-[11px] font-semibold px-2 py-0.5 rounded-full bg-[#EAF5EF] text-[#2F7D5A] border border-[#2F7D5A]/20">Today</span>}
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
      cellRenderer: (p: ICellRendererParams<CoverageSlot>) => { const v = p.value as number | null; return v === null ? null : <span className={v <= -1 ? 'text-[#C84A4A] font-semibold' : v >= 2 ? 'text-[#B7791F] font-semibold' : 'text-[#2F7D5A]'}>{signed(v)}</span>; } },
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

// ---------------------------------------------------------------- real-time adherence

const AdherenceScreen: React.FC<{ groupId: string; day: string }> = ({ groupId, day }) => {
  const { go, can } = useForecast();
  const [refresh, setRefresh] = useRefreshSetting();
  const tick = useTick(refresh * 1000, !day && refresh > 0);
  const [saved, setSaved] = useState(0);
  const res = useApi<Adherence>(`/intraday/adherence?groupId=${groupId}${day ? `&day=${day}` : ''}`, [tick, groupId, day, saved]);
  const [filter, setFilter] = useState<'ALL' | AdherenceStatus>('ALL');
  const [team, setTeam] = useState('');
  const d = res.data;
  const groupTz = d?.timezone;
  // the colours and names on the Timelines card come from the real activities (Configuration › Activity Definitions),
  // not a fixed palette, so a renamed or recoloured activity shows up here and on the Schedule Timeline the same way
  const acts = useApi<Activity[]>('/config/activities', []);
  const schedColor = useMemo(() => {
    const out: Record<string, string> = { ...SCHED_FALLBACK };
    const seen = new Set<string>();
    for (const a of acts.data ?? []) if (a.status === 'ACTIVE' && !seen.has(a.category)) { seen.add(a.category); out[a.category] = a.color; }
    return out;
  }, [acts.data]);
  const schedTypeLabel = useMemo(() => {
    const out: Record<string, string> = { ...SCHED_LABEL_FALLBACK };
    const seen = new Set<string>();
    for (const a of acts.data ?? []) if (a.status === 'ACTIVE' && !seen.has(a.category)) { seen.add(a.category); out[a.category] = a.name; }
    return out;
  }, [acts.data]);
  const teams = useMemo(() => [...new Set((d?.agents ?? []).map((a) => a.team).filter(Boolean) as string[])].sort(), [d]);
  const rows = useMemo(() => (d?.agents ?? [])
    .filter((a) => (filter === 'ALL' || a.status === filter) && (!team || a.team === team))
    .sort((a, b) => PRIORITY[a.status] - PRIORITY[b.status] || a.name.localeCompare(b.name)), [d, filter, team]);

  const cols = useMemo<ColDef<AdherenceAgent>[]>(() => [
    { headerName: 'Agent', field: 'name', flex: 1.2, minWidth: 170, cellRenderer: (p: ICellRendererParams<AdherenceAgent>) => p.data && <div className="leading-tight py-1"><div className="font-semibold">{p.data.name}</div><div className="text-[12px] text-[#737373]">{p.data.team ?? 'No team'} · {p.data.employeeNumber}</div></div> },
    { headerName: 'Shift', field: 'shift', width: 140, cellRenderer: (p: ICellRendererParams<AdherenceAgent>) => p.data && <div className="leading-tight"><div>{p.data.shift ?? '–'}</div>{p.data.timezone !== groupTz && <div className="text-[12px] text-[#737373]">{p.data.timezone}</div>}</div> },
    { headerName: 'Should be', field: 'scheduled', width: 130, cellRenderer: (p: ICellRendererParams<AdherenceAgent>) => p.data && (p.data.status === 'NOT_STARTED' ? <span className="text-[#A3A3A3]">–</span> : <span>{schedLabel(p.data.scheduled)}</span>), tooltipValueGetter: (p) => (p.data?.scheduledUntil ? `until ${p.data.scheduledUntil}` : '') },
    { headerName: 'Actually', field: 'actual', flex: 1, minWidth: 190, cellRenderer: (p: ICellRendererParams<AdherenceAgent>) => p.data && (p.data.status === 'NOT_STARTED' ? <span className="text-[#A3A3A3]">–</span> : <div className="leading-tight"><div>{p.data.actual}</div>{p.data.state && <div className="text-[12px] text-[#737373]">{p.data.state}{p.data.reason ? ` · ${p.data.reason}` : ''} since {p.data.stateSince}</div>}</div>) },
    { headerName: 'Status', field: 'status', width: 170, cellRenderer: (p: ICellRendererParams<AdherenceAgent>) => p.data && <div className="leading-tight"><Pill tone={STATUS[p.data.status].tone}>{STATUS[p.data.status].label}</Pill>{p.data.status === 'NOT_STARTED' && p.data.shift && <div className="text-[12px] text-[#737373] mt-0.5">Starts {p.data.shift.split('–')[0]}</div>}</div> },
    { headerName: 'Out for', field: 'outSeconds', width: 96, type: 'rightAligned', valueFormatter: (p) => (!p.value ? '–' : p.value < 60 ? `${p.value}s` : `${Math.round(p.value / 60)} min`) },
    { headerName: 'Adherence', field: 'dayPercent', width: 110, type: 'rightAligned', valueFormatter: (p) => (p.value === null ? '–' : `${p.value}%`) },
  ], [groupTz]);

  if (res.loading && !d) return <Busy text="Loading adherence…" />;
  if (res.error) return <Banner kind="err">{res.error}</Banner>;
  if (!d) return null;
  const s = d.summary;

  return (
    <div className="space-y-6">
      {d.unmappedStates.length > 0 && (
        <Banner kind="warn">
          The phone system reported states that are not mapped to an activity: {d.unmappedStates.map((u) => `${u.state}${u.reason ? ` / ${u.reason}` : ''} (${u.agents})`).join(', ')}. Those people show as Unknown.{' '}
          <button className="underline font-semibold" onClick={() => go('rta-mapping', 'configuration')}>Map them</button>
        </Banner>
      )}
      {!d.publishedSchedule && <Banner kind="warn">There is no published schedule for {d.day}, so nobody can be checked against one. Publish a schedule under Scheduling.</Banner>}
      <KpiRow>
        <Kpi label="Adherence today" value={s.dayPercent === null ? '–' : `${s.dayPercent}%`} sub={`Average across ${s.total} people${d.asOf ? `, as of ${d.asOf}` : ''}`} tone={s.dayPercent === null ? undefined : s.dayPercent >= 90 ? 'good' : s.dayPercent >= 80 ? 'warn' : 'bad'} />
        <Kpi label="In adherence" value={s.inAdherence} sub={`Grace period ${d.graceSeconds >= 60 ? `${Math.round(d.graceSeconds / 60)} min` : `${d.graceSeconds}s`}`} tone="good" />
        <Kpi label="Out of adherence" value={s.outOfAdherence} sub={s.unscheduled ? `${s.unscheduled} working unscheduled` : 'Longer than the grace period'} tone={s.outOfAdherence ? 'bad' : 'good'} />
        <Kpi label="Not counted" value={s.unknown + s.ignored} sub={`${s.unknown} unknown state, ${s.ignored} ignored`} tone={s.unknown ? 'warn' : undefined} />
      </KpiRow>
      <div className="grid grid-cols-1 xl:grid-cols-3 gap-5 items-start">
        {d.publishedSchedule && (
          <div className="xl:col-span-2">
            <Card title="Published vs actual" sub="People the schedule has on shift each 15 minutes, against people actually in adherence.">
              <LineChart height={210} xEvery={8} leftLabel="People" labels={d.staffing.map((s) => s.time)}
                series={[
                  { name: 'Published', color: CHART.baseline, kind: 'dashed', values: d.staffing.map((s) => s.published) },
                  { name: 'Actual (in adherence)', color: CHART.success, kind: 'bar', values: d.staffing.map((s) => s.actual) },
                ]} />
            </Card>
          </div>
        )}
        {d.agents.length > 0 && (
          <div className={d.publishedSchedule ? '' : 'xl:col-span-3'}>
            <NeedsAttention agents={d.agents} day={d.day} canAct={can('intraday:act')} onSaved={() => setSaved((x) => x + 1)} />
          </div>
        )}
      </div>
      {d.agents.length > 0 && <AgentTimelines agents={d.agents} day={d.day} schedColor={schedColor} schedTypeLabel={schedTypeLabel} canAct={can('intraday:act')} onSaved={() => setSaved((x) => x + 1)} />}

      <Card title="People" sub={day ? 'A past day shows how it ended.' : refresh ? `Refreshes every ${refreshLabel(refresh)}.` : 'Refresh is off. Reload the page to update.'}
        actions={<>
          <div className="w-40"><Select value={refresh} onChange={(e) => setRefresh(Number(e.target.value))} aria-label="Refresh" disabled={!!day}>
            {REFRESH_OPTIONS.map((s) => <option key={s} value={s}>{s === 0 ? 'Refresh off' : `Every ${refreshLabel(s)}`}</option>)}
          </Select></div>
          <div className="w-44"><Select value={filter} onChange={(e) => setFilter(e.target.value as any)} aria-label="Status">
            <option value="ALL">All statuses</option>{(Object.keys(STATUS) as AdherenceStatus[]).map((k) => <option key={k} value={k}>{STATUS[k].label}</option>)}
          </Select></div>
          {teams.length > 0 && <div className="w-40"><Select value={team} onChange={(e) => setTeam(e.target.value)} aria-label="Team"><option value="">All teams</option>{teams.map((t) => <option key={t} value={t}>{t}</option>)}</Select></div>}
          {!day && refresh > 0 && <span className="text-[11px] text-[#737373] flex items-center gap-1"><RefreshCw className="w-3 h-3" />live</span>}
        </>}>
        {d.agents.length === 0
          ? <Empty title={d.hasEvents ? 'Nobody is scheduled or active in this group for this day' : 'No agent states received yet'}>
            {d.hasEvents
              ? 'Publish a schedule or pick another day.'
              : <>Connect your phone or ACD system so each agent’s state appears here. <button className="underline font-semibold" onClick={() => go('integration-station', 'configuration')}>Open Integration Station</button></>}
          </Empty>
          : <Grid<AdherenceAgent> rowData={rows} columnDefs={cols} defaultColDef={{ sortable: true, resizable: true, suppressHeaderMenuButton: true }} rowHeight={44} height={Math.min(560, 90 + rows.length * 44)} />}
      </Card>
    </div>
  );
};

// used only until a real activity for that category exists (Configuration › Activity Definitions); once one does,
// its own colour and name take over here and on the Schedule Timeline, instead of each screen picking its own
const SCHED_FALLBACK: Record<string, string> = { WORK: '#BFE3CF', MEAL: '#E7C27D', BREAK: '#A9C4DE', TRAINING: '#B8A9D6', COACHING: '#9ACFC4' };
const isOut = (s: AdherenceStatus) => s === 'OUT' || s === 'UNSCHEDULED';
/** An out-of-adherence stretch is explained once an explanation's window covers all of it. */
const coveredBy = (run: { from: number; to: number }, exceptions: AdherenceAgent['exceptions']) => exceptions.find((x) => x.from <= run.from && x.to >= run.to) ?? null;

/** Every stretch someone was out of adherence that no explanation covers yet, with a way to explain it or record it as excused. */
const NeedsAttention: React.FC<{ agents: AdherenceAgent[]; day: string; canAct: boolean; onSaved: () => void }> = ({ agents, day, canAct, onSaved }) => {
  const [open, setOpen] = useState<string | null>(null);
  const [error, setError] = useState('');
  const open_ = agents.flatMap((a) => a.timeline.actual.filter((r) => isOut(r.status) && !coveredBy(r, a.exceptions)).map((r) => ({ a, r, key: `${a.employeeId}|${r.from}|${r.to}` })));
  const explained = agents.flatMap((a) => a.exceptions.map((x) => ({ a, x })));

  const remove = async (id: string) => {
    if (!confirm('Remove this explanation?')) return;
    try { await api(`/intraday/exceptions/${id}`, { method: 'DELETE' }); onSaved(); } catch (e: any) { setError(e.message); }
  };

  return (
    <Card title={`Needs attention (${open_.length})`} sub="Out of adherence past the grace period, with no explanation yet.">
      {error && <Banner kind="err" onClose={() => setError('')}>{error}</Banner>}
      {open_.length === 0
        ? <p className="text-[13px] text-[#2F7D5A]">Nothing outstanding{explained.length ? `: ${explained.length} explained` : ''}.</p>
        : <div className="space-y-2 max-h-80 overflow-y-auto pr-1">
          {open_.map(({ a, r, key }) => (
            <div key={key} className="border border-[#E5E5E0] rounded-lg p-3">
              <div className="flex flex-wrap items-center gap-3 justify-between">
                <div className="text-[13px]"><b>{a.name}</b> <span className="text-[#737373]">{a.timezone}</span> · {hm(r.from)}–{hm(r.to)} ({r.to - r.from} min) · {r.status === 'OUT' ? 'doing' : 'working unscheduled:'} <b>{r.label}</b> {r.status === 'OUT' && <span className="text-[#737373]">when the schedule says {a.timeline.schedule.find((s) => r.from >= s.from && r.from < s.to)?.type.toLowerCase() ?? 'nothing'}</span>}</div>
                {canAct && open !== key && <Btn onClick={() => setOpen(key)}>Explain</Btn>}
              </div>
              {canAct && open === key && <ExplainBox agent={a} day={day} range={r} onCancel={() => setOpen(null)} onSaved={() => { setOpen(null); onSaved(); }} />}
            </div>
          ))}
        </div>}
      {explained.length > 0 && (
        <details className="mt-4 text-[12px]">
          <summary className="cursor-pointer text-[#737373]">{explained.length} explained</summary>
          <ul className="mt-2 space-y-1">
            {explained.map(({ a, x }) => (
              <li key={x.id} className="flex flex-wrap gap-2 items-center">
                <span><b>{a.name}</b> {hm(x.from)}–{hm(x.to)}</span>
                <Pill tone={x.excused ? 'good' : 'neutral'}>{x.excused ? 'Excused' : 'Explained, counted'}</Pill>
                <span className="text-[#525252]">{x.category.replace(/_/g, ' ').toLowerCase()}: {x.note}</span>
                {canAct && <button className="text-[#737373] underline" onClick={() => remove(x.id)}>Remove</button>}
              </li>
            ))}
          </ul>
        </details>
      )}
    </Card>
  );
};

const ExplainBox: React.FC<{ agent: AdherenceAgent; day: string; range: { from: number; to: number }; onCancel: () => void; onSaved: () => void }> = ({ agent, day, range, onCancel, onSaved }) => {
  const [category, setCategory] = useState<'COACHING' | 'TRAINING' | 'SYSTEM_ISSUE' | 'MEETING' | 'OTHER'>('COACHING');
  const [note, setNote] = useState('');
  const [excused, setExcused] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const save = async () => {
    setBusy(true); setError('');
    try {
      await api('/intraday/exceptions', { method: 'POST', body: { employeeId: agent.employeeId, day, fromMinute: range.from, toMinute: range.to, category, note: note.trim(), excused } });
      onSaved();
    } catch (e: any) { setError(e.message); } finally { setBusy(false); }
  };

  return (
    <div className="mt-3 pt-3 border-t border-[#E5E5E0] space-y-3">
      {error && <Banner kind="err" onClose={() => setError('')}>{error}</Banner>}
      <div className="grid grid-cols-1 sm:grid-cols-[11rem_1fr] gap-3">
        <label className="block text-[11px] font-semibold uppercase tracking-wider text-[#737373]">Why
          <Select value={category} onChange={(e) => setCategory(e.target.value as typeof category)} className="mt-1 font-normal normal-case tracking-normal text-[#171717]">
            <option value="COACHING">Coaching</option><option value="TRAINING">Training</option><option value="SYSTEM_ISSUE">System or phone issue</option><option value="MEETING">Meeting</option><option value="OTHER">Other</option>
          </Select>
        </label>
        <label className="block text-[11px] font-semibold uppercase tracking-wider text-[#737373]">What happened
          <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. Coached on call handling until 10:40" className="mt-1 font-normal normal-case tracking-normal text-[#171717]" />
        </label>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <label className="flex items-center gap-2 text-[13px] text-[#171717] cursor-pointer">
          <input type="checkbox" checked={excused} onChange={(e) => setExcused(e.target.checked)} className="w-4 h-4 accent-[#2F7D5A]" />Count as excused
        </label>
        <div className="flex items-center gap-2">
          <Btn onClick={onCancel}>Cancel</Btn>
          <Btn variant="primary" disabled={busy || note.trim().length < 3} onClick={save}>Save</Btn>
        </div>
      </div>
    </div>
  );
};

type Selected = { employeeId: string; kind: 'sched' | 'actual'; from: number; to: number; label: string; status?: AdherenceStatus };
const overlaps = (a: { from: number; to: number }, b: { from: number; to: number }) => a.from < b.to && b.from < a.to;
const SCHED_LABEL_FALLBACK: Record<string, string> = { WORK: 'Work', MEAL: 'Meal', BREAK: 'Break', TRAINING: 'Training', COACHING: 'Coaching' };

/** One row per person: the published schedule as coloured segments, what they actually did as runs on top of it. Click a bar to see both sides. */
const AgentTimelines: React.FC<{ agents: AdherenceAgent[]; day: string; schedColor: Record<string, string>; schedTypeLabel: Record<string, string>; canAct: boolean; onSaved: () => void }> = ({ agents, day, schedColor, schedTypeLabel, canAct, onSaved }) => {
  const [selected, setSelected] = useState<Selected | null>(null);
  const [explaining, setExplaining] = useState(false);
  const pick = (s: Selected) => {
    setExplaining(false);
    setSelected(selected && selected.employeeId === s.employeeId && selected.kind === s.kind && selected.from === s.from ? null : s);
  };
  const isSelected = (employeeId: string, kind: Selected['kind'], from: number) => selected?.employeeId === employeeId && selected.kind === kind && selected.from === from;
  const who = agents.find((a) => a.employeeId === selected?.employeeId) ?? null;
  const sched = who && selected ? who.timeline.schedule.filter((s) => overlaps(s, selected)) : [];
  const actual = who && selected ? who.timeline.actual.filter((r) => overlaps(r, selected)) : [];
  const cover = who && selected && selected.kind === 'actual' ? coveredBy(selected, who.exceptions) : null;
  const needsExplain = !!who && !!selected && selected.kind === 'actual' && !!selected.status && isOut(selected.status) && !cover;

  const withShift = agents.filter((a) => a.timeline.schedule.length > 0);
  const lo = withShift.length ? Math.max(0, Math.min(...withShift.map((a) => a.timeline.schedule[0].from)) - 30) : 0;
  const hi = withShift.length ? Math.min(1440, Math.max(...withShift.map((a) => a.timeline.schedule[a.timeline.schedule.length - 1].to)) + 30) : 1440;
  const span = Math.max(60, hi - lo);
  const pos = (m: number) => `${((Math.max(lo, Math.min(hi, m)) - lo) / span) * 100}%`;
  const width = (from: number, to: number) => `${(Math.max(0, Math.min(hi, to) - Math.max(lo, from)) / span) * 100}%`;
  const ticks: number[] = [];
  for (let t = Math.ceil(lo / 60) * 60; t <= hi; t += 60) ticks.push(t);
  return (
    <Card title="Timelines" sub="Each person on their own clock. Click a bar to see what was scheduled and what happened.">
      <div className="flex flex-wrap gap-x-4 gap-y-1 mb-4 text-[12px] text-[#525252]">
        {[
          { color: schedColor.WORK, label: `Scheduled ${schedTypeLabel.WORK.toLowerCase()}` }, { color: schedColor.MEAL, label: `Scheduled ${schedTypeLabel.MEAL.toLowerCase()}` }, { color: schedColor.BREAK, label: `Scheduled ${schedTypeLabel.BREAK.toLowerCase()}` },
          { color: RUN_COLOR.IN, label: 'In adherence' }, { color: RUN_COLOR.OUT, label: 'Out' }, { color: RUN_COLOR.UNSCHEDULED, label: 'Unscheduled' },
          { color: RUN_COLOR.UNKNOWN, label: 'No state' }, { color: '#B8B8B0', label: 'Explained' },
        ].map((l) => <span key={l.label} className="flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-sm" style={{ backgroundColor: l.color }} />{l.label}</span>)}
      </div>
      <div className="space-y-2 overflow-x-auto">
        <div className="flex items-center gap-3">
          <div className="w-44 shrink-0" />
          <div className="relative h-4 flex-1 min-w-120">{ticks.map((t) => <span key={t} className="absolute top-0 -translate-x-1/2 text-[11px] font-mono text-[#737373]" style={{ left: pos(t) }}>{hm(t)}</span>)}</div>
        </div>
        {withShift.concat(agents.filter((a) => a.timeline.schedule.length === 0)).map((a) => (
          <div key={a.employeeId} className="flex items-center gap-3">
            <div className="w-44 shrink-0 leading-tight"><div className="truncate text-[12px] font-semibold" title={a.name}>{a.name}</div><div className="text-[11px] text-[#737373]">{a.timezone}</div></div>
            <div className="relative h-5 flex-1 min-w-120 rounded bg-[#FAFAF8] border border-[#E5E5E0]">
              {a.timeline.schedule.map((s, i) => <div key={`s${i}`} title={`Scheduled ${(schedTypeLabel[s.type] ?? s.type).toLowerCase()} ${hm(s.from)}–${hm(s.to)}`} onClick={() => pick({ employeeId: a.employeeId, kind: 'sched', from: s.from, to: s.to, label: schedTypeLabel[s.type] ?? s.type })}
                className={`absolute top-0 h-full opacity-70 cursor-pointer ${isSelected(a.employeeId, 'sched', s.from) ? 'ring-2 ring-[#171717] z-10' : ''}`} style={{ left: pos(s.from), width: width(s.from, s.to), backgroundColor: schedColor[s.type] ?? '#E9E9E4' }} />)}
              {a.timeline.actual.map((r, i) => {
                const explained = isOut(r.status) && !!coveredBy(r, a.exceptions);
                return (
                  <div key={`a${i}`} title={`${hm(r.from)}–${hm(r.to)} ${r.label}${explained ? ' (explained)' : ''}`} onClick={() => pick({ employeeId: a.employeeId, kind: 'actual', from: r.from, to: r.to, label: r.label, status: r.status })}
                    className={`absolute top-1 h-3 rounded-sm cursor-pointer ${isSelected(a.employeeId, 'actual', r.from) ? 'ring-2 ring-[#171717] z-10' : ''}`}
                    style={{ left: pos(r.from), width: width(r.from, r.to), backgroundColor: explained ? '#B8B8B0' : RUN_COLOR[r.status] }} />
                );
              })}
            </div>
          </div>
        ))}
      </div>
      {who && selected && (
        <div className="mt-4 rounded-lg border border-[#E5E5E0] bg-[#FAFAF8] p-3 text-[13px] space-y-3">
          <div className="flex flex-wrap items-center gap-2 justify-between">
            <div><b>{who.name}</b> <span className="text-[#737373]">{who.timezone}</span> · {hm(selected.from)}–{hm(selected.to)} ({selected.to - selected.from} min) · {selected.kind === 'sched' ? 'scheduled' : 'actual'}: <b>{selected.label}</b></div>
            <button className="text-[#737373] underline text-[12px]" onClick={() => setSelected(null)}>Close</button>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <div>
              <div className="text-[11px] font-semibold uppercase tracking-wider text-[#737373] mb-1">Scheduled</div>
              {sched.length === 0
                ? <div className="text-[#737373]">Nothing scheduled in this time.</div>
                : sched.map((s, i) => <div key={i}><b>{schedTypeLabel[s.type] ?? s.type}</b> {hm(s.from)}–{hm(s.to)}</div>)}
            </div>
            <div>
              <div className="text-[11px] font-semibold uppercase tracking-wider text-[#737373] mb-1">Actual</div>
              {actual.length === 0
                ? <div className="text-[#737373]">No state received in this time.</div>
                : actual.map((r, i) => <div key={i} className="flex flex-wrap items-center gap-2"><span>{hm(r.from)}–{hm(r.to)}</span><b>{r.label}</b><Pill tone={STATUS[r.status].tone}>{STATUS[r.status].label}</Pill></div>)}
            </div>
          </div>
          {cover && <div className="text-[#525252]"><Pill tone={cover.excused ? 'good' : 'neutral'}>{cover.excused ? 'Excused' : 'Explained, counted'}</Pill> {cover.category.replace(/_/g, ' ').toLowerCase()}: {cover.note}</div>}
          {needsExplain && (canAct
            ? explaining
              ? <ExplainBox agent={who} day={day} range={selected} onCancel={() => setExplaining(false)} onSaved={() => { setExplaining(false); setSelected(null); onSaved(); }} />
              : <Btn onClick={() => setExplaining(true)}>Explain</Btn>
            : <div className="text-[#737373]">Out of adherence and not explained yet.</div>)}
        </div>
      )}
    </Card>
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
        ? <Card><div className="flex items-center gap-2 text-[14px]"><CheckCircle2 className="w-5 h-5 text-[#2F7D5A]" />The rest of the day looks covered: no stretch of 30 minutes or more is short by one person or over by two.</div></Card>
        : ws.map((w, i) => (
          <Card key={i}>
            <div className="flex items-start gap-3">
              <AlertTriangle className={`w-5 h-5 mt-0.5 ${w.kind === 'short' ? 'text-[#C84A4A]' : 'text-[#B7791F]'}`} />
              <div className="space-y-1.5">
                <div className="text-[14px] font-semibold">{w.kind === 'short' ? `Short by up to ${w.size.toFixed(1)} people` : `${w.size.toFixed(1)} more people than needed at the most`} · {w.from}–{w.to}</div>
                <ul className="text-[13px] text-[#525252] list-disc pl-5 space-y-0.5">
                  {w.kind === 'short'
                    ? <><li>Move training, coaching or meetings out of this window.</li><li>Offer overtime or voluntary extra time to people finishing or starting nearby.</li><li>Hold back breaks and meals that have not started, where the rules allow.</li></>
                    : <><li>Offer voluntary time off or an early finish.</li><li>Use the time for training or coaching.</li><li>Bring forward breaks and meals.</li></>}
                </ul>
                <div className="text-[12px] text-[#737373]">Based on {c.reforecast.applied ? `today’s reforecast (${c.reforecast.ratio}× the forecast)` : 'the published forecast'} against the published schedule.</div>
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
          <thead className="bg-[#FAFAF8] text-[#737373] text-[11px] uppercase tracking-wider border-b border-[#E5E5E0]">
            <tr>{canAct && <th className="p-3 w-8"></th>}<th className="p-3 text-left">Person</th><th className="p-3 text-left">Ask</th><th className="p-3 text-left">New shift</th><th className="p-3 text-left">Helps</th><th className="p-3 text-left">Cost</th></tr>
          </thead>
          <tbody className="divide-y divide-[#E5E5E0]">
            {s.fixes.map((f) => (
              <tr key={key(f)} className="hover:bg-[#FAFAF8]">
                {canAct && <td className="p-3"><input type="checkbox" checked={picked.has(key(f))} onChange={() => setPicked((p) => { const n = new Set(p); n.has(key(f)) ? n.delete(key(f)) : n.add(key(f)); return n; })} /></td>}
                <td className="p-3 font-semibold">{f.name}</td>
                <td className="p-3">{f.action}<div className="text-[12px] text-[#737373]">{f.why}</div></td>
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
    <Card><div className="flex items-center gap-2 text-[14px]"><CheckCircle2 className="w-5 h-5 text-[#2F7D5A]" />No upcoming break or meal would help more if moved, as of {s.nowTime}. Checked again every minute.</div></Card>
  );

  return (
    <div className="space-y-4">
      {error && <Banner kind="err" onClose={() => setError('')}>{error}</Banner>}
      <div className="flex items-center justify-between">
        <p className="text-[12px] text-[#737373]">As of {s.nowTime}. {s.suggestions.length} suggestion{s.suggestions.length === 1 ? '' : 's'}, biggest improvement first.{s.reforecastApplied ? ' Weighed against how today is actually running, not just the plain forecast.' : ''}</p>
        {canAct && <Btn variant="primary" disabled={busy} onClick={() => apply(s.suggestions.filter((m) => picked.size === 0 || picked.has(key(m))))}>{picked.size ? `Apply ${picked.size} selected` : 'Apply all'}</Btn>}
      </div>
      <div className="border border-[#E5E5E0] rounded-lg overflow-hidden">
        <table className="w-full text-[13px]">
          <thead className="bg-[#FAFAF8] text-[#737373] text-[11px] uppercase tracking-wider border-b border-[#E5E5E0]">
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
