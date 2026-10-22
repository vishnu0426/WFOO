/**
 * Scheduling › Multi-Site View. Every published schedule side by side, by site and by group: hours needed against hours scheduled,
 * coverage per day, how many people are free and could be asked to cover, and one clock (UTC) for the day so sites in different
 * time zones can be compared. Gaps here are what VTO & Overtime offers and shift swaps are for.
 */
import React, { useMemo, useState } from 'react';
import { Bar, CartesianGrid, ComposedChart, Line, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { dec } from '../../services/api';
import { useApi } from '../forecasting/hooks';
import { Banner, Busy, Card, Empty, Field, Input, Kpi, KpiRow, Pill, Select } from '../forecasting/ui';

type Day = { day: string; requiredHours: number; scheduledHours: number; coveragePercent: number; underIntervals: number; available: number };
type Series = { hour: string; required: number; scheduled: number }[];
type G = { groupId: string; groupName: string; siteName: string; timezone: string; scheduleName: string; days: Day[] };
type Site = { siteName: string; timezone: string; groups: string[]; requiredHours: number; scheduledHours: number; coveragePercent: number; series: Series | null };
type Roll = { from: string; to: string; day: string | null; total: { requiredHours: number; scheduledHours: number; coveragePercent: number }; sites: Site[]; groups: G[] };

const monday = (d: Date) => { const x = new Date(d); x.setDate(x.getDate() - ((x.getDay() + 6) % 7)); return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`; };
const plus = (s: string, n: number) => { const d = new Date(s + 'T00:00:00'); d.setDate(d.getDate() + n); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const tone = (p: number) => (p >= 95 ? 'bg-[#EAF5EF] text-[#2F7D5A]' : p >= 85 ? 'bg-[#FFF5DD] text-[#B7791F]' : 'bg-[#FCEBEC] text-[#C84A4A]');

export const RollupPanel: React.FC = () => {
  const [from, setFrom] = useState(monday(new Date()));
  const to = plus(from, 6);
  const [day, setDay] = useState(plus(monday(new Date()), 1));
  const [site, setSite] = useState('');
  const r = useApi<Roll>(`/scheduling/rollup?from=${from}&to=${to}&day=${day >= from && day <= to ? day : from}`);
  const data = r.data;
  const series = useMemo(() => {
    if (!data) return [];
    const use = data.sites.filter((s) => !site || s.siteName === site);
    const m = new Map<string, { required: number; scheduled: number }>();
    for (const s of use) for (const h of s.series ?? []) { const c = m.get(h.hour) ?? { required: 0, scheduled: 0 }; c.required += h.required; c.scheduled += h.scheduled; m.set(h.hour, c); }
    return [...m].sort().map(([hour, c]) => ({ label: hour.slice(11, 13) + ':00', date: hour.slice(0, 10), required: Math.round(c.required * 10) / 10, scheduled: Math.round(c.scheduled * 10) / 10 }));
  }, [data, site]);
  const days = Array.from({ length: 7 }, (_, i) => plus(from, i));

  return (
    <div className="space-y-6">
      <Card title="Multi-site view" sub="Published schedules for the week, by site and group. Hours are worked out from each group's published forecast; the chart puts every site on one clock (UTC)."
        actions={<div className="flex flex-wrap items-center gap-3">
          <Field label="Week starting"><Input type="date" value={from} onChange={(e) => e.target.value && setFrom(monday(new Date(e.target.value + 'T00:00:00')))} /></Field>
          <Field label="Chart day"><Select value={data?.day ?? day} onChange={(e) => setDay(e.target.value)}>{days.map((d) => <option key={d} value={d}>{new Date(d + 'T00:00:00').toLocaleDateString('en', { weekday: 'short', month: 'short', day: 'numeric' })}</option>)}</Select></Field>
        </div>}>
        {r.loading && !data && <Busy text="Reading every published schedule…" />}
        {r.error && <Banner kind="err">{r.error}</Banner>}
        {data && data.groups.length === 0 && <Empty title="No published schedules this week">Publish a schedule for at least one group to see it here. Assign groups to sites in Configuration › Sites & Skills.</Empty>}
        {data && data.groups.length > 0 && (
          <>
            <KpiRow>
              <Kpi label="Coverage, all sites" value={`${dec(data.total.coveragePercent)}%`} tone={data.total.coveragePercent >= 95 ? 'good' : data.total.coveragePercent >= 85 ? 'warn' : 'bad'} sub={`${data.groups.length} group${data.groups.length === 1 ? '' : 's'}, ${data.sites.length} site${data.sites.length === 1 ? '' : 's'}`} />
              <Kpi label="Hours needed" value={dec(data.total.requiredHours, 0)} sub="from the forecasts" />
              <Kpi label="Hours scheduled" value={dec(data.total.scheduledHours, 0)} sub={`${data.total.scheduledHours >= data.total.requiredHours ? 'covers' : 'short of'} the need`} />
            </KpiRow>

            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
              {data.sites.map((s) => (
                <button key={s.siteName} onClick={() => setSite(site === s.siteName ? '' : s.siteName)} className={`text-left p-3 rounded-lg border ${site === s.siteName ? 'border-[#171717] bg-[#FAFAF8]' : 'border-[#E5E5E0] hover:bg-[#FAFAF8]'}`}>
                  <div className="flex items-center justify-between gap-2"><span className="font-semibold text-[14px]">{s.siteName}</span><span className={`px-2 py-0.5 rounded text-[12px] font-semibold ${tone(s.coveragePercent)}`}>{dec(s.coveragePercent)}%</span></div>
                  <div className="text-[11px] text-[#737373] mt-1">{s.timezone} · {s.groups.join(', ')}</div>
                  <div className="text-[12px] text-[#525252] mt-1">{dec(s.scheduledHours, 0)} of {dec(s.requiredHours, 0)} hours</div>
                </button>
              ))}
            </div>

            <div>
              <div className="text-[13px] font-semibold mb-1">{site || 'All sites'} on {new Date((data.day ?? from) + 'T00:00:00').toLocaleDateString('en', { weekday: 'long', month: 'short', day: 'numeric' })}, hours needed against scheduled by UTC hour</div>
              <div style={{ height: 260 }}>
                <ResponsiveContainer>
                  <ComposedChart data={series} margin={{ top: 8, right: 16, bottom: 0, left: 0 }}>
                    <CartesianGrid stroke="#E5E5E0" strokeDasharray="3 3" vertical={false} />
                    <XAxis dataKey="label" tick={{ fontSize: 11 }} interval={1} />
                    <YAxis tick={{ fontSize: 11 }} width={40} />
                    <Tooltip formatter={(v: any, n: any) => [dec(Number(v), 1), n]} labelFormatter={(l, p: any) => `${p?.[0]?.payload?.date ?? ''} ${l} UTC`} />
                    <Bar dataKey="scheduled" name="People scheduled" fill="#171717" fillOpacity={0.75} isAnimationActive={false} />
                    <Line dataKey="required" name="People needed" type="stepAfter" stroke="#C84A4A" strokeWidth={2} dot={false} isAnimationActive={false} />
                  </ComposedChart>
                </ResponsiveContainer>
              </div>
            </div>
          </>
        )}
      </Card>

      {data && data.groups.length > 0 && (
        <Card title="Coverage by group and day" sub="Share of the forecast that is covered. Below each figure, how many people are free that day and could be asked to cover (not working for any group, not on time off).">
          <div className="overflow-x-auto border border-[#E5E5E0] rounded-lg">
            <table className="w-full text-[13px]">
              <thead className="bg-[#FAFAF8] text-[#737373] text-[11px] uppercase tracking-wider border-b border-[#E5E5E0]">
                <tr><th className="p-3 text-left">Group</th>{days.map((d) => <th key={d} className="p-3 text-center">{new Date(d + 'T00:00:00').toLocaleDateString('en', { weekday: 'short', day: 'numeric' })}</th>)}</tr>
              </thead>
              <tbody className="divide-y divide-[#E5E5E0]">
                {data.groups.filter((g) => !site || g.siteName === site).map((g) => (
                  <tr key={g.groupId}>
                    <td className="p-3"><div className="font-semibold">{g.groupName}</div><div className="text-[11px] text-[#737373]">{g.siteName} · {g.timezone}</div></td>
                    {days.map((d) => { const x = g.days.find((y) => y.day === d); return <td key={d} className="p-2 text-center">{x ? <div><span className={`inline-block px-2 py-0.5 rounded text-[12px] font-semibold ${tone(x.coveragePercent)}`}>{dec(x.coveragePercent, 0)}%</span><div className="text-[11px] text-[#737373] mt-0.5">{x.available} free</div></div> : <span className="text-[#A3A3A3]">–</span>}</td>; })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="flex gap-2 text-[11px] text-[#737373]"><Pill tone="good">95% or more</Pill><Pill tone="warn">85% to 95%</Pill><Pill tone="bad">under 85%</Pill></div>
        </Card>
      )}
    </div>
  );
};
