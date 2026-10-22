/**
 * Overview: today at a glance for the active WFM group, all from live data: today's traffic against the people scheduled and required,
 * schedule coverage, adherence, forecast accuracy, what needs attention and the latest changes. Nothing here is a fixed sample.
 */
import React, { useMemo, useState } from 'react';
import { Bar, CartesianGrid, ComposedChart, Legend, Line, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { Activity, AlertTriangle, Calendar, ChevronRight, Layers, TrendingUp, Users } from 'lucide-react';
import { Adherence, Coverage, dec, Employee, ScheduleVersion, VersionMeta } from '../../services/api';
import { useForecast } from '../../services/forecastStore';
import { useApi } from '../forecasting/hooks';
import { CHART } from '../forecasting/charts';
import { TraceModal } from '../forecasting/Trace';
import { Banner, Busy, Card, Empty, Kpi, PageHeader, Pill, Select } from '../forecasting/ui';

type Audit = { id: string; actorName: string; action: string; entityType: string; entityName: string | null; timestamp: string; reason: string | null; diffSummary: string | null };
type Attention = { tone: 'bad' | 'warn' | 'info'; title: string; detail: string; go: [string, string] };

const ago = (iso: string) => {
  const m = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
  return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} d ago`;
};
const label = (t: string) => t.charAt(0) + t.slice(1).toLowerCase().replace(/_/g, ' ');

export const OverviewDashboard: React.FC<{ onNavigate: (module: string, subSection?: string) => void }> = ({ onNavigate }) => {
  const { groups, group, setGroupId, can, ready } = useForecast();
  const gid = group?.id;
  const cov = useApi<Coverage>(gid && can('intraday:read') ? `/intraday/coverage?groupId=${gid}` : null);
  const adh = useApi<Adherence>(gid && can('intraday:read') ? `/intraday/adherence?groupId=${gid}` : null);
  const fcs = useApi<VersionMeta[]>(gid && can('forecast:read') ? `/forecast/versions?groupId=${gid}` : null);
  const sch = useApi<ScheduleVersion[]>(gid && can('schedule:read') ? `/scheduling/versions?groupId=${gid}` : null);
  const emps = useApi<Employee[]>(gid && can('workforce:read') ? `/workforce/employees?groupId=${gid}&status=ACTIVE` : null);
  const log = useApi<Audit[]>(can('audit:read') ? '/audit?limit=8' : null);
  const [trace, setTrace] = useState<{ title: string; volume: number; ahtSec: number } | null>(null);

  const pubShort = fcs.data?.find((v) => v.kind === 'SHORT' && v.status === 'PUBLISHED');
  const pubLong = fcs.data?.find((v) => v.kind === 'LONG' && v.status === 'PUBLISHED');
  const pubSched = sch.data?.find((v) => v.status === 'PUBLISHED');
  const c = cov.data && cov.data.ready ? cov.data : null;
  const wape = c?.stats.wape ?? pubShort?.wape ?? pubLong?.wape ?? null;

  const attention = useMemo<Attention[]>(() => {
    const a: Attention[] = [];
    if (c) {
      const short = c.gaps.filter((g) => g.gap < -0.5);
      if (short.length) { const w = short.reduce((m, g) => (g.gap < m.gap ? g : m)); a.push({ tone: 'bad', title: `${short.length} upcoming interval${short.length === 1 ? '' : 's'} understaffed`, detail: `Worst at ${w.time}: ${dec(-w.gap)} fewer people than needed.`, go: ['intraday', 'live-coverage'] }); }
    }
    if (adh.data?.hasEvents && adh.data.summary.outOfAdherence > 0) a.push({ tone: 'warn', title: `${adh.data.summary.outOfAdherence} agent${adh.data.summary.outOfAdherence === 1 ? ' is' : 's are'} out of adherence`, detail: 'Their status differs from the published schedule beyond the grace period.', go: ['intraday', 'adherence'] });
    if (adh.data?.hasEvents && adh.data.unmappedStates.length) a.push({ tone: 'warn', title: `${adh.data.unmappedStates.length} agent state${adh.data.unmappedStates.length === 1 ? '' : 's'} not mapped`, detail: `${adh.data.unmappedStates.map((u) => u.state).slice(0, 3).join(', ')} cannot be matched to an activity.`, go: ['configuration', 'rta-mapping'] });
    for (const v of fcs.data ?? []) {
      if (v.status === 'SUBMITTED') a.push({ tone: 'info', title: `"${v.name}" is waiting for approval`, detail: `Submitted by ${v.submittedBy ?? 'a planner'}.`, go: ['forecasting', 'all-forecasts'] });
      else if (v.status === 'APPROVED') a.push({ tone: 'info', title: `"${v.name}" is approved but not published`, detail: 'Publish it so scheduling and staffing use it.', go: ['forecasting', 'all-forecasts'] });
    }
    for (const v of sch.data ?? []) if (v.status === 'DRAFT' && v.stats.violations > 0) a.push({ tone: 'warn', title: `Draft "${v.name}" has ${v.stats.violations} rule violation${v.stats.violations === 1 ? '' : 's'}`, detail: 'These must be fixed before it can be published.', go: ['scheduling', 'schedule-timeline'] });
    if (fcs.data && !pubShort) a.push({ tone: 'info', title: 'No published short-term forecast', detail: 'Live coverage and adherence need one.', go: ['forecasting', 'forecast-builder'] });
    if (sch.data && !pubSched) a.push({ tone: 'info', title: 'No published schedule', detail: 'Adherence compares agents against a published schedule.', go: ['scheduling', 'generate-schedule'] });
    return a;
  }, [c, adh.data, fcs.data, sch.data, pubShort, pubSched]);

  const chart = useMemo(() => (c ? c.slots.filter((s) => s.slot >= c.first && s.slot <= c.last).map((s) => ({ ...s, need: s.requiredReforecast ?? s.required })) : []), [c]);
  const understaffed = attention.some((x) => x.tone === 'bad');
  const status = !c ? { tone: 'info' as const, text: 'Waiting for data' } : understaffed ? { tone: 'bad' as const, text: 'Attention needed' } : { tone: 'good' as const, text: 'Operations normal' };
  const loading = !ready || (gid && (cov.loading && !cov.data));

  return (
    <div className="flex-1 flex flex-col h-[calc(100vh-3.5rem)] overflow-y-auto bg-[#FFFFFF] p-6 space-y-6">
      <PageHeader title="Overview" badge={<Pill tone={status.tone}>{status.text}</Pill>}
        sub={c ? `${group?.name} · ${new Date(c.day + 'T00:00:00').toLocaleDateString('en', { weekday: 'long', month: 'short', day: 'numeric', year: 'numeric' })}${c.nowTime ? ` · now ${c.nowTime} (${c.timezone})` : ''}` : 'Today across forecasting, scheduling and the live floor.'}
        actions={groups.length > 0 && (
          <div className="flex items-center gap-2 text-[12px] text-[#525252]"><Layers className="w-3.5 h-3.5 text-[#737373]" />
            <Select value={gid ?? ''} onChange={(e) => setGroupId(e.target.value)} className="w-auto!" aria-label="WFM group">{groups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}</Select>
          </div>
        )} />

      {ready && !groups.length ? <Empty title="Nothing set up yet">Create a WFM group and its queues in Configuration, import call history, then build a forecast. This page fills in as you go.
        <div className="mt-3"><button className="px-3 py-1.5 rounded bg-[#171717] text-white text-[12px] font-semibold" onClick={() => onNavigate('configuration', 'wfm-groups')}>Open Configuration</button></div></Empty>
      : loading ? <Busy text="Loading today…" /> : (
        <>
          {attention.find((x) => x.tone === 'bad') && (() => { const x = attention.find((y) => y.tone === 'bad')!; return (
            <div className="p-4 bg-[#FCEBEC] border border-[#C84A4A]/30 rounded-lg flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-3"><AlertTriangle className="w-5 h-5 text-[#C84A4A]" /><div><div className="text-[14px] font-bold text-[#171717]">{x.title}</div><div className="text-[12px] text-[#525252] mt-0.5">{x.detail}</div></div></div>
              <button onClick={() => onNavigate(...x.go)} className="px-4 py-2 rounded bg-[#171717] hover:bg-[#333] text-white text-[12px] font-semibold">Open live coverage</button>
            </div>); })()}

          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-4">
            <div onClick={() => onNavigate('scheduling', 'schedule-timeline')} className="cursor-pointer hover:opacity-90">
              <Kpi label="Schedule coverage" value={pubSched ? `${dec(pubSched.stats.coverage.percent)}%` : '–'} tone={pubSched ? (pubSched.stats.coverage.percent >= 95 ? 'good' : pubSched.stats.coverage.percent >= 85 ? 'warn' : 'bad') : undefined}
                sub={pubSched ? `${pubSched.name} · ${pubSched.stats.shifts} shifts` : 'No published schedule'} />
            </div>
            <div onClick={() => onNavigate('intraday', 'adherence')} className="cursor-pointer hover:opacity-90">
              <Kpi label="Adherence today" value={adh.data?.hasEvents && adh.data.summary.dayPercent != null ? `${dec(adh.data.summary.dayPercent)}%` : '–'}
                tone={!adh.data?.hasEvents || adh.data.summary.dayPercent == null ? undefined : adh.data.summary.dayPercent >= 88 ? 'good' : adh.data.summary.dayPercent >= 80 ? 'warn' : 'bad'}
                sub={adh.data ? (adh.data.hasEvents ? `${adh.data.summary.total} agents tracked` : 'No agent activity received yet') : 'Not available'} />
            </div>
            <div onClick={() => onNavigate('forecasting', 'accuracy-heatmap')} className="cursor-pointer hover:opacity-90">
              <Kpi label="Forecast accuracy" value={wape == null ? '–' : `${dec(Math.max(0, 100 - wape * 100))}%`} tone={wape == null ? undefined : wape <= 0.1 ? 'good' : wape <= 0.2 ? 'warn' : 'bad'}
                sub={wape == null ? 'Needs published forecast and actuals' : `${dec(wape * 100)}% average miss (WAPE)${c?.stats.wape != null ? ' today' : ''}`} />
            </div>
            <div onClick={() => onNavigate('workforce', 'employees')} className="cursor-pointer hover:opacity-90">
              <Kpi label="Active people" value={emps.data ? emps.data.length : '–'} sub={pubSched ? `${pubSched.stats.people} on the published schedule` : 'In this WFM group'} />
            </div>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
            <Card className="lg:col-span-2" title="Today: traffic against people"
              sub={c ? `${c.forecastName}. Bars are calls or chats per 15 minutes; lines are people required and scheduled. Click a bar to see how the requirement was worked out.` : undefined}
              actions={<button onClick={() => onNavigate('intraday', 'live-coverage')} className="text-[12px] font-semibold text-[#171717] hover:underline flex items-center gap-1">Open live coverage<ChevronRight className="w-3.5 h-3.5" /></button>}>
              {!c ? <p className="text-[13px] text-[#737373]">{cov.data && cov.data.ready === false ? cov.data.reason : cov.error || 'Live coverage needs a published short-term forecast for this group.'}</p> : (
                <div style={{ height: 300 }}>
                  <ResponsiveContainer>
                    <ComposedChart data={chart} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
                      <CartesianGrid stroke="#E5E5E0" strokeDasharray="3 3" vertical={false} />
                      <XAxis dataKey="time" tick={{ fontSize: 11 }} interval={7} />
                      <YAxis yAxisId="v" tick={{ fontSize: 11 }} width={40} />
                      <YAxis yAxisId="a" orientation="right" tick={{ fontSize: 11 }} width={36} />
                      <Tooltip formatter={(v: any, n: any) => [typeof v === 'number' ? dec(v, Number.isInteger(v) ? 0 : 1) : v, n]} />
                      <Legend wrapperStyle={{ fontSize: 12 }} />
                      <Bar yAxisId="v" dataKey="forecast" name="Forecast" fill={CHART.forecast} fillOpacity={0.35} isAnimationActive={false}
                        onClick={(d: any) => d?.forecast > 0 && d?.aht && setTrace({ title: `${d.time} · forecast ${d.forecast} at ${d.aht}s handle time`, volume: d.forecast, ahtSec: d.aht })} cursor="pointer" />
                      <Bar yAxisId="v" dataKey="actual" name="Actual" fill={CHART.actual} isAnimationActive={false} />
                      <Line yAxisId="a" type="stepAfter" dataKey="need" name="People required" stroke={CHART.agents} strokeWidth={2} dot={false} isAnimationActive={false} />
                      <Line yAxisId="a" type="stepAfter" dataKey="scheduled" name="People scheduled" stroke={CHART.scheduled} strokeWidth={2} strokeDasharray="5 3" dot={false} isAnimationActive={false} />
                    </ComposedChart>
                  </ResponsiveContainer>
                </div>
              )}
              {c && !c.hasSchedule && <Banner kind="info">No published schedule covers today, so the people-scheduled line is empty.</Banner>}
            </Card>

            <Card title="Needs attention" sub={attention.length ? undefined : 'Nothing needs action right now.'}>
              <div className="space-y-2">
                {attention.slice(0, 7).map((x, i) => (
                  <button key={i} onClick={() => onNavigate(...x.go)} className="w-full text-left p-3 rounded-lg border border-[#E5E5E0] hover:bg-[#FAFAF8] flex items-start justify-between gap-2">
                    <div><div className="flex items-center gap-2"><Pill tone={x.tone}>{x.tone === 'bad' ? 'Urgent' : x.tone === 'warn' ? 'Check' : 'To do'}</Pill><span className="font-semibold text-[13px] text-[#171717]">{x.title}</span></div><div className="text-[11px] text-[#737373] mt-1">{x.detail}</div></div>
                    <ChevronRight className="w-4 h-4 text-[#737373] shrink-0 mt-0.5" />
                  </button>
                ))}
              </div>
            </Card>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
            <Card title="What is driving the plan" className="lg:col-span-1">
              <dl className="space-y-3 text-[13px]">
                <Row icon={<TrendingUp className="w-4 h-4" />} k="Short-term forecast" v={pubShort ? pubShort.name : 'None published'} go={() => onNavigate('forecasting', 'all-forecasts')} />
                <Row icon={<TrendingUp className="w-4 h-4" />} k="Long-term forecast" v={pubLong ? pubLong.name : 'None published'} go={() => onNavigate('forecasting', 'all-forecasts')} />
                <Row icon={<Calendar className="w-4 h-4" />} k="Schedule" v={pubSched ? `${pubSched.name} (${pubSched.periodStart} to ${pubSched.periodEnd})` : 'None published'} go={() => onNavigate('scheduling', 'schedule-timeline')} />
                <Row icon={<Activity className="w-4 h-4" />} k="Service level (forecast)" v={c?.stats.serviceLevel != null ? `${dec(c.stats.serviceLevel * 100, 0)}%` : '–'} />
                <Row icon={<Users className="w-4 h-4" />} k="Peak people required today" v={c ? String(Math.ceil(c.stats.peakRequired)) : '–'} />
              </dl>
            </Card>

            <Card className="lg:col-span-2" title="Recent changes" sub="The latest entries in the audit log."
              actions={can('audit:read') && <button onClick={() => onNavigate('audit')} className="text-[12px] font-semibold text-[#171717] hover:underline flex items-center gap-1">Open audit log<ChevronRight className="w-3.5 h-3.5" /></button>}>
              {!can('audit:read') ? <p className="text-[13px] text-[#737373]">Recent changes are shown to people with audit access.</p>
                : !log.data ? <p className="text-[13px] text-[#737373]">{log.error || 'Loading…'}</p>
                : !log.data.length ? <p className="text-[13px] text-[#737373]">No changes recorded yet.</p>
                : <ul className="divide-y divide-[#E5E5E0]">{log.data.map((r) => (
                  <li key={r.id} className="py-2.5 flex items-start justify-between gap-3 text-[13px]">
                    <div><span className="font-semibold">{r.actorName}</span> <span className="text-[#525252]">{r.action.toLowerCase()}</span> <span className="font-medium">{r.entityName ?? label(r.entityType)}</span>
                      <div className="text-[11px] text-[#737373]">{label(r.entityType)}{r.reason ? ` · ${r.reason}` : r.diffSummary ? ` · ${r.diffSummary}` : ''}</div></div>
                    <span className="text-[11px] text-[#737373] whitespace-nowrap">{ago(r.timestamp)}</span>
                  </li>))}</ul>}
            </Card>
          </div>
        </>
      )}
      {trace && gid && <TraceModal groupId={gid} title={trace.title} input={{ volume: trace.volume, ahtSec: trace.ahtSec, channel: 'voice' }} onClose={() => setTrace(null)} />}
    </div>
  );
};

const Row: React.FC<{ icon: React.ReactNode; k: string; v: string; go?: () => void }> = ({ icon, k, v, go }) => (
  <div className={`flex items-start gap-2.5 ${go ? 'cursor-pointer hover:opacity-80' : ''}`} onClick={go}>
    <span className="text-[#737373] mt-0.5">{icon}</span>
    <div><dt className="text-[11px] text-[#737373]">{k}</dt><dd className="text-[#171717] font-medium">{v}</dd></div>
  </div>
);
