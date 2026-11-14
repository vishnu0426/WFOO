/**
 * Today: what needs doing first, for the signed-in role and the active WFM group, all from live data (GET /overview/today). Nothing here is a fixed sample.
 *
 * The page says "all clear" only when every signal was checked and none is a problem; a signal that could not be checked is listed as not checked, never read as fine.
 * Every figure comes from the server's one calculation, the same one the detailed screens use.
 */
import React, { useEffect, useState } from 'react';
import { Bar, CartesianGrid, ComposedChart, Legend, Line, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { AlertTriangle, ArrowDownRight, ArrowRight, ArrowUpRight, ChevronRight, Info } from 'lucide-react';
import { dec } from '../../services/api';
import { useForecast } from '../../services/forecastStore';
import { useApi } from '../forecasting/hooks';
import { CHART } from '../forecasting/charts';
import { CardsSkeleton, TableSkeleton, useDelayed } from '../common/loading';
import { Card, Empty, PageHeader, Pill } from '../forecasting/ui';

type Action = { label: string; module: string; section: string; needs: string | null; allowed: boolean };
type Item = { id: string; area: string; severity: 'urgent' | 'check' | 'todo'; title: string; detail: string; action: Action | null };
type Trend = { direction: 'UP' | 'DOWN' | 'FLAT'; delta: number; better: boolean | null };
type Kpi = { key: string; label: string; unit: string; value: number | null; target: number | null; tone: 'good' | 'warn' | 'bad' | null; trend: Trend | null; trendBasis: string; sub: string; go: [string, string] };
type Today = {
  groupId: string; day: string; timezone: string; nowTime: string | null; role: string;
  verdict: { status: 'ATTENTION' | 'PARTIAL' | 'OK'; text: string; checked: string[]; notChecked: string[] }; attention: Item[]; hidden: string[]; kpis: Kpi[];
  chart: { slot: number; time: string; forecast: number; actualContacts: number | null; required: number; scheduled: number; onFloor: number | null }[]; chartNote: string | null;
  dayTotals: { requiredHours: number; scheduledHours: number; shortHours: number; surplusHours: number; serviceLevel: number | null; peakRequired: number } | null;
  drivers: { shortForecast: string | null; schedule: { name: string; from: string; to: string } | null };
  recent: { id: string; at: string; actorName: string; action: string; entityType: string; entityName: string | null; reason: string | null; diffSummary: string | null }[]; signInsHidden: boolean;
};

const ago = (iso: string) => {
  const m = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
  return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} d ago`;
};
const label = (t: string) => t.charAt(0) + t.slice(1).toLowerCase().replace(/_/g, ' ');
const ROLE_NAME: Record<string, string> = { WFM_ADMIN: 'an administrator', WFM_MANAGER: 'a manager', FORECAST_PLANNER: 'a forecast planner', SCHEDULER: 'a scheduler', SUPERVISOR_RTA: 'a supervisor', ANALYST: 'an analyst', AGENT: 'an agent' };
const VERDICT_TONE = { ATTENTION: 'bad', PARTIAL: 'warn', OK: 'good' } as const;
const SEVERITY = { urgent: { tone: 'bad' as const, text: 'Urgent' }, check: { tone: 'warn' as const, text: 'Check' }, todo: { tone: 'info' as const, text: 'To do' } };
const VALUE_TONE = { good: 'text-[#2A7553]', warn: 'text-[#8F6200]', bad: 'text-[#BC3F3F]' };

const Tile: React.FC<{ k: Kpi; onClick: () => void }> = ({ k, onClick }) => {
  const t = k.trend, Icon = t?.direction === 'UP' ? ArrowUpRight : t?.direction === 'DOWN' ? ArrowDownRight : ArrowRight;
  const value = k.value === null ? '–' : k.unit === '%' ? `${dec(k.value)}%` : dec(k.value, 0);
  return (
    <button type="button" onClick={onClick} className="flex flex-col items-start justify-start text-left p-4 bg-[#FAFAF8] rounded-lg border border-[#E5E5E0] hover:opacity-90">
      <div className="text-[11px] font-semibold text-[#6B6B6B] uppercase tracking-wider">{k.label}</div>
      <div className={`text-[24px] font-bold tabular-nums mt-1 font-mono ${k.tone ? VALUE_TONE[k.tone] : 'text-[#171717]'}`}>{value}</div>
      <div className="flex flex-wrap items-center gap-x-3 text-[12px] mt-0.5">
        {k.target !== null && <span className="text-[#6B6B6B]">Target {k.unit === '%' ? `${dec(k.target, 0)}%` : dec(k.target, 0)}</span>}
        {t ? <span className={`inline-flex items-center gap-0.5 ${t.better === true ? 'text-[#2A7553]' : t.better === false ? 'text-[#BC3F3F]' : 'text-[#6B6B6B]'}`} title={`${k.trendBasis}`}>
          <Icon className="w-3.5 h-3.5" aria-hidden="true" />{t.direction === 'FLAT' ? 'steady' : `${t.delta > 0 ? '+' : ''}${dec(t.delta, 1)}${k.unit === '%' ? ' pts' : ''}`} {k.trendBasis}</span>
          : <span className="text-[#6B6B6B]">no trend yet</span>}
      </div>
      <div className="text-[12px] text-[#6B6B6B] mt-0.5">{k.sub}</div>
    </button>
  );
};

export const OverviewDashboard: React.FC<{ onNavigate: (module: string, subSection?: string) => void }> = ({ onNavigate }) => {
  const { groups, group, can, ready } = useForecast();
  const gid = group?.id;
  const [signIns, setSignIns] = useState(false);
  const [tick, setTick] = useState(0);
  useEffect(() => { const t = setInterval(() => setTick((n) => n + 1), 60_000); return () => clearInterval(t); }, []);      // the page keeps itself current
  const today = useApi<Today>(gid ? `/overview/today?groupId=${gid}${signIns ? '&includeSignIns=1' : ''}` : null, [tick]);
  const d = today.data;
  const loading = !ready || (!!gid && today.loading && !d);
  const showWait = useDelayed(!!loading, 150);
  const go = (a: Action | { module: string; section: string }) => onNavigate(a.module, a.section);

  return (
    <div className="flex-1 flex flex-col h-[calc(100vh-3.5rem)] overflow-y-auto bg-[#FFFFFF] p-6 space-y-6">
      <PageHeader title="Today"
        badge={d ? <Pill tone={VERDICT_TONE[d.verdict.status]} title={`Checked: ${d.verdict.checked.join(', ') || 'nothing'}.${d.verdict.notChecked.length ? ` Not checked: ${d.verdict.notChecked.join(', ')}.` : ''}`}>{d.verdict.status === 'ATTENTION' ? 'Attention needed' : d.verdict.status === 'PARTIAL' ? 'Not everything could be checked' : 'On track'}</Pill> : undefined}
        sub={d ? `${group?.name} · ${new Date(d.day + 'T00:00:00').toLocaleDateString('en', { weekday: 'long', month: 'short', day: 'numeric', year: 'numeric' })}${d.nowTime ? ` · now ${d.nowTime} (${d.timezone})` : ''}` : 'What needs doing first, across forecasting, scheduling and the live floor.'} />

      {ready && !groups.length ? <Empty title="Nothing set up yet">Create a WFM group and its queues in Configuration, import call history, then build a forecast. This page fills in as you go.
        <div className="mt-3"><button className="px-3 py-1.5 rounded bg-[#171717] text-white text-[12px] font-semibold" onClick={() => onNavigate('configuration', 'wfm-groups')}>Open Configuration</button></div></Empty>
      : loading ? (showWait ? <div role="status" aria-busy="true" className="space-y-4"><span className="sr-only">Loading today</span><CardsSkeleton /><TableSkeleton rows={4} cols={4} /></div> : <div className="min-h-[240px]" />)
      : !d ? <Empty title="Today could not be loaded">{today.error || 'Try again in a moment.'} <button className="underline font-semibold" onClick={today.reload}>Try again</button></Empty> : (
        <>
          <div className={`p-4 rounded-lg border flex flex-wrap items-center justify-between gap-3 ${d.verdict.status === 'ATTENTION' ? 'bg-[#FCEBEC] border-[#C84A4A]/30' : d.verdict.status === 'PARTIAL' ? 'bg-[#FFF5DD] border-[#B7791F]/20' : 'bg-[#EAF5EF] border-[#2F7D5A]/20'}`}>
            <div className="flex items-start gap-3">
              {d.verdict.status === 'ATTENTION' ? <AlertTriangle className="w-5 h-5 text-[#BC3F3F] mt-0.5" /> : <Info className={`w-5 h-5 mt-0.5 ${d.verdict.status === 'PARTIAL' ? 'text-[#8F6200]' : 'text-[#2A7553]'}`} />}
              <div>
                <div className="text-[14px] font-bold text-[#171717]">{d.verdict.text}</div>
                <div className="text-[12px] text-[#525252] mt-0.5">
                  {d.verdict.checked.length ? `Checked: ${d.verdict.checked.join(', ')}.` : 'Nothing could be checked.'}{d.verdict.notChecked.length ? ` Not checked: ${d.verdict.notChecked.join(', ')}.` : ''}
                  {d.role && ROLE_NAME[d.role] ? ` Ordered for ${ROLE_NAME[d.role]}.` : ''}
                </div>
              </div>
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-4">
            {d.kpis.map((k) => <Tile key={k.key} k={k} onClick={() => onNavigate(k.go[0], k.go[1])} />)}
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
            <Card className="lg:col-span-2" title="Today: needed, scheduled and on the floor"
              sub={d.chartNote ?? undefined}
              actions={can('intraday:read') && <button onClick={() => onNavigate('intraday', 'live-coverage')} className="text-[12px] font-semibold text-[#171717] hover:underline flex items-center gap-1">Open live coverage<ChevronRight className="w-3.5 h-3.5" /></button>}>
              {!d.chart.length ? <p className="text-[13px] text-[#6B6B6B]">{d.chartNote || 'Live coverage needs a published short-term forecast that covers today.'}</p> : (
                <>
                  <div style={{ height: 300 }}>
                    <ResponsiveContainer>
                      <ComposedChart data={d.chart} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
                        <CartesianGrid stroke="#E5E5E0" strokeDasharray="3 3" vertical={false} />
                        <XAxis dataKey="time" tick={{ fontSize: 11 }} interval={7} />
                        <YAxis yAxisId="v" tick={{ fontSize: 11 }} width={40} />
                        <YAxis yAxisId="a" orientation="right" tick={{ fontSize: 11 }} width={36} />
                        <Tooltip formatter={(v: any, n: any) => [typeof v === 'number' ? dec(v, Number.isInteger(v) ? 0 : 1) : '–', n]} />
                        <Legend wrapperStyle={{ fontSize: 12 }} />
                        <Bar yAxisId="v" dataKey="forecast" name="Contacts forecast" fill={CHART.forecast} fillOpacity={0.3} isAnimationActive={false} />
                        <Bar yAxisId="v" dataKey="actualContacts" name="Contacts so far" fill={CHART.actual} isAnimationActive={false} />
                        <Line yAxisId="a" type="stepAfter" dataKey="required" name="People needed" stroke={CHART.agents} strokeWidth={2} dot={false} isAnimationActive={false} />
                        <Line yAxisId="a" type="stepAfter" dataKey="scheduled" name="People scheduled" stroke={CHART.scheduled} strokeWidth={2} strokeDasharray="5 3" dot={false} isAnimationActive={false} />
                        <Line yAxisId="a" type="stepAfter" dataKey="onFloor" name="People on the floor" stroke="#2F7D5A" strokeWidth={2.5} dot={false} connectNulls={false} isAnimationActive={false} />
                      </ComposedChart>
                    </ResponsiveContainer>
                  </div>
                  {d.dayTotals && <p className="text-[12px] text-[#6B6B6B] mt-2">The day needs {dec(d.dayTotals.requiredHours, 1)} h of people and has {dec(d.dayTotals.scheduledHours, 1)} h scheduled
                    ({dec(d.dayTotals.shortHours, 1)} h short in some intervals, {dec(d.dayTotals.surplusHours, 1)} h more than needed in others). Meals and other time off the phones are not counted as scheduled. “On the floor” is people actually logged in, from agent activity.</p>}
                </>
              )}
            </Card>

            <Card title="Needs attention" sub={d.attention.length ? `${d.attention.length} item${d.attention.length === 1 ? '' : 's'}, most serious first` : d.verdict.status === 'OK' ? 'Nothing needs action. Everything was checked.' : 'Nothing wrong in what could be checked.'}>
              <div className="space-y-2">
                {d.attention.slice(0, 8).map((x) => (
                  <div key={x.id} className="p-3 rounded-lg border border-[#E5E5E0]">
                    <div className="flex items-center gap-2"><Pill tone={SEVERITY[x.severity].tone}>{SEVERITY[x.severity].text}</Pill><span className="font-semibold text-[13px] text-[#171717]">{x.title}</span></div>
                    <div className="text-[11px] text-[#6B6B6B] mt-1">{x.detail}</div>
                    {x.action && (x.action.allowed
                      ? <button onClick={() => go(x.action!)} className="mt-2 inline-flex items-center gap-1 px-2.5 py-1 rounded bg-[#171717] text-white text-[11px] font-semibold hover:bg-[#333]">{x.action.label}<ChevronRight className="w-3 h-3" /></button>
                      : <div className="mt-2 text-[11px] text-[#6B6B6B]">Your role cannot do this. Ask someone who can: {x.action.label.toLowerCase()}.</div>)}
                  </div>
                ))}
                {d.attention.length > 8 && <div className="text-[12px] text-[#6B6B6B]">and {d.attention.length - 8} more</div>}
              </div>
            </Card>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
            <Card title="What is driving the plan" className="lg:col-span-1">
              <dl className="space-y-3 text-[13px]">
                <Row k="Short-term forecast" v={d.drivers.shortForecast ?? 'None published'} go={() => onNavigate('forecasting', 'all-forecasts')} />
                <Row k="Schedule" v={d.drivers.schedule ? `${d.drivers.schedule.name} (${d.drivers.schedule.from} to ${d.drivers.schedule.to})` : 'None published'} go={() => onNavigate('scheduling', 'schedule-timeline')} />
                <Row k="Service level if staffed to the requirement" v={d.dayTotals?.serviceLevel != null ? `${dec(d.dayTotals.serviceLevel * 100, 0)}%` : '–'} />
                <Row k="Peak people needed today" v={d.dayTotals ? String(Math.ceil(d.dayTotals.peakRequired)) : '–'} />
              </dl>
            </Card>

            <Card className="lg:col-span-2" title="Recent changes" sub={d.signInsHidden ? 'The latest changes to the plan, people and settings. Sign-ins are left out.' : 'The latest entries in the audit log, sign-ins included.'}
              actions={can('audit:read') && <div className="flex items-center gap-3">
                <label className="text-[12px] text-[#525252] flex items-center gap-1.5"><input type="checkbox" checked={signIns} onChange={(e) => setSignIns(e.target.checked)} />Show sign-ins</label>
                <button onClick={() => onNavigate('audit')} className="text-[12px] font-semibold text-[#171717] hover:underline flex items-center gap-1">Open audit log<ChevronRight className="w-3.5 h-3.5" /></button></div>}>
              {!can('audit:read') ? <p className="text-[13px] text-[#6B6B6B]">Recent changes are shown to people with audit access.</p>
                : !d.recent.length ? <p className="text-[13px] text-[#6B6B6B]">No changes recorded yet.</p>
                : <ul className="divide-y divide-[#E5E5E0]">{d.recent.map((r) => (
                  <li key={r.id} className="py-2.5 flex items-start justify-between gap-3 text-[13px]">
                    <div><span className="font-semibold">{r.actorName}</span> <span className="text-[#525252]">{r.action.toLowerCase().replace(/_/g, ' ')}</span> <span className="font-medium">{r.entityName ?? label(r.entityType)}</span>
                      <div className="text-[11px] text-[#6B6B6B]">{label(r.entityType)}{r.reason ? ` · ${r.reason}` : r.diffSummary ? ` · ${r.diffSummary}` : ''}</div></div>
                    <span className="text-[11px] text-[#6B6B6B] whitespace-nowrap">{ago(r.at)}</span>
                  </li>))}</ul>}
            </Card>
          </div>
        </>
      )}
    </div>
  );
};

const Row: React.FC<{ k: string; v: string; go?: () => void }> = ({ k, v, go }) => (
  <div className={go ? 'cursor-pointer hover:opacity-80' : ''} onClick={go}>
    <dt className="text-[11px] text-[#6B6B6B]">{k}</dt>
    <dd className="text-[#171717] font-medium">{v}</dd>
  </div>
);
