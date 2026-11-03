/**
 * Scheduling › Follow the Sun. Several sites in different time zones on one clock (UTC): the combined need against the combined cover for every hour, where it falls
 * short, who covers which hour of the typical day, and whether sliding a site's roster earlier or later would close the gaps.
 */
import React, { useState } from 'react';
import { api, dec, nextWeekStart } from '../../services/api';
import { useForecast } from '../../services/forecastStore';
import { CHART, LineChart } from '../forecasting/charts';
import { usePayWeek } from '../forecasting/hooks';
import { Banner, Btn, Busy, Card, Empty, Field, Input, Kpi, KpiRow } from '../forecasting/ui';

type Sun = {
  from: string; to: string; notes: string[]; groups: { id: string; name: string; timezone: string; versionId: string | null; coveragePercent?: number }[];
  profile: { utcHour: number; required: number; scheduled: number; byGroup: Record<string, number> }[];
  gaps: { from: string; to: string; hours: number; worstShort: number }[];
  totals: { requiredHours: number; scheduledHours: number; shortHours: number; coveredPercent: number };
  suggestions: { groupId: string; name: string; currentShortHours: number; bestShiftHours: number; shortHoursAfter: number; improvementPercent: number }[];
};
const offset = (tz: string) => { try { const p = new Intl.DateTimeFormat('en', { timeZone: tz, timeZoneName: 'shortOffset' }).formatToParts(new Date()).find((x) => x.type === 'timeZoneName')?.value; return p ?? tz; } catch { return tz; } };
const COLORS = ['#4F6F8F', '#2F7D5A', '#B7791F', '#7A62A8', '#C84A4A', '#525252'];

export const SunPanel: React.FC = () => {
  const { groups } = useForecast();
  const [picked, setPicked] = useState<string[]>([]);
  const weekStart = usePayWeek(null);                      // starts on the first day of the company's next pay week
  const [pickedFrom, setFrom] = useState<string | null>(null);
  const from = pickedFrom ?? nextWeekStart(weekStart, 1);
  const [days, setDays] = useState(7);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [sun, setSun] = useState<Sun | null>(null);
  if (groups.length < 2) return <Empty title="Two or more WFM groups are needed">Create the groups for each site, publish a schedule for each, and they can be seen on one clock here.</Empty>;
  const run = async () => { setBusy(true); setErr(''); try { setSun(await api<Sun>(`/scheduling/follow-the-sun?groupIds=${picked.join(',')}&from=${from}&days=${days}`)); } catch (e: any) { setErr(e.message); setSun(null); } finally { setBusy(false); } };
  const hh = (h: number) => `${String(h).padStart(2, '0')}:00`;
  return (
    <div className="space-y-6">
      <Card title="Sites on one clock" sub="Pick the groups that share the work across time zones, and the days. Each needs a published schedule for them.">
        <div className="flex flex-wrap gap-x-5 gap-y-1 text-[13px]">{groups.map((g) => <label key={g.id} className="flex items-center gap-1.5"><input type="checkbox" checked={picked.includes(g.id)} onChange={(e) => setPicked(e.target.checked ? [...picked, g.id] : picked.filter((x) => x !== g.id))} />{g.name} <span className="text-[11px] text-[#6B6B6B]">{offset(g.timezone)}</span></label>)}</div>
        <div className="flex flex-wrap items-end gap-3">
          <Field label="From"><Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></Field>
          <Field label="Days"><Input type="number" min={1} max={14} className="!w-20" value={days} onChange={(e) => setDays(Math.min(14, Math.max(1, Number(e.target.value) || 1)))} /></Field>
          <Btn variant="primary" disabled={picked.length < 2 || busy} onClick={run}>{busy ? 'Working it out…' : 'Show them on one clock'}</Btn>
        </div>
        {err && <Banner kind="warn">{err}</Banner>}
      </Card>
      {busy && <Busy text="Reading each site's schedule and forecast…" />}
      {sun && !busy && (
        <>
          <Card title={`${sun.from} to ${sun.to}`} sub="Everything below is on UTC.">
            <KpiRow>
              <Kpi label="Hours needed" value={dec(sun.totals.requiredHours, 0)} /><Kpi label="Hours covered" value={dec(sun.totals.scheduledHours, 0)} />
              <Kpi label="Covered" value={`${dec(sun.totals.coveredPercent, 1)}%`} tone={sun.totals.coveredPercent >= 95 ? 'good' : sun.totals.coveredPercent >= 85 ? 'warn' : 'bad'} />
              <Kpi label="Hours short" value={dec(sun.totals.shortHours, 0)} tone={sun.totals.shortHours > 0 ? 'bad' : 'good'} sub={`${sun.gaps.length} gap${sun.gaps.length === 1 ? '' : 's'}`} />
            </KpiRow>
            <div className="text-[12px] font-semibold">A typical day, hour by hour (UTC): people needed against people on shift</div>
            <LineChart height={260} leftLabel="people" labels={sun.profile.map((p) => hh(p.utcHour))} xEvery={2}
              series={[{ name: 'Needed', color: CHART.agents, kind: 'step', values: sun.profile.map((p) => p.required) }, { name: 'On shift', color: CHART.scheduled, kind: 'step', area: true, values: sun.profile.map((p) => p.scheduled) }]}
              tooltip={(i) => <span>{sun.groups.map((g) => `${g.name}: ${sun.profile[i].byGroup[g.id] ?? 0}`).join(' · ')}</span>} />
            <table className="w-full text-[11px]">
              <thead className="text-left text-[#6B6B6B]"><tr><th className="py-1">Who covers the hour</th>{sun.profile.filter((_, i) => i % 3 === 0).map((p) => <th key={p.utcHour} className="text-right">{hh(p.utcHour)}</th>)}</tr></thead>
              <tbody>{sun.groups.filter((g) => g.versionId).map((g, k) => (
                <tr key={g.id} className="border-t border-[#E5E5E0]"><td className="py-1"><span className="inline-block w-2.5 h-2.5 rounded-sm mr-1.5" style={{ background: COLORS[k % COLORS.length] }} />{g.name} <span className="text-[#6B6B6B]">{offset(g.timezone)}</span></td>
                  {sun.profile.filter((_, i) => i % 3 === 0).map((p) => <td key={p.utcHour} className="text-right tabular-nums">{p.byGroup[g.id] ? dec(p.byGroup[g.id], 0) : '·'}</td>)}</tr>))}</tbody>
            </table>
          </Card>
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            <Card title="Where the need is not met" sub="Runs of hours where the combined cover is below the combined need.">
              {sun.gaps.length === 0 ? <p className="text-[13px] text-[#2A7553]">No gaps. Every hour is covered.</p> : (
                <table className="w-full text-[12px]"><thead className="text-left text-[#6B6B6B]"><tr><th>From (UTC)</th><th>To (UTC)</th><th className="text-right">Hours</th><th className="text-right">Worst shortfall</th></tr></thead>
                  <tbody>{sun.gaps.slice(0, 20).map((g, i) => <tr key={i} className="border-t border-[#E5E5E0]"><td className="py-1 tabular-nums">{g.from.replace('T', ' ').replace('Z', '')}</td><td className="tabular-nums">{g.to.replace('T', ' ').replace('Z', '')}</td><td className="text-right">{g.hours}</td><td className="text-right">{dec(g.worstShort, 1)} people</td></tr>)}</tbody></table>
              )}
            </Card>
            <Card title="If a site started earlier or later" sub="A what-if that slides one site's whole roster, to show where the gap sits. It ignores each person's own hours and availability, so plan the real change in the schedule.">
              <table className="w-full text-[12px]"><thead className="text-left text-[#6B6B6B]"><tr><th>Site</th><th className="text-right">Short now</th><th className="text-right">Best slide</th><th className="text-right">Short after</th></tr></thead>
                <tbody>{sun.suggestions.map((s) => <tr key={s.groupId} className="border-t border-[#E5E5E0]"><td className="py-1">{s.name}</td><td className="text-right">{dec(s.currentShortHours, 0)} h</td>
                  <td className="text-right font-semibold">{s.bestShiftHours === 0 ? 'No change helps' : `${s.bestShiftHours > 0 ? '+' : ''}${s.bestShiftHours} h`}</td><td className="text-right">{s.bestShiftHours === 0 ? '·' : `${dec(s.shortHoursAfter, 0)} h (${dec(s.improvementPercent, 0)}% less)`}</td></tr>)}</tbody></table>
            </Card>
          </div>
          <ul className="text-[11px] text-[#6B6B6B] list-disc ml-4">{sun.notes.map((n) => <li key={n}>{n}</li>)}</ul>
        </>
      )}
    </div>
  );
};
