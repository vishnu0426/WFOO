/**
 * Scheduling › Follow the Sun. Several sites in different time zones on one clock: the combined need against the combined cover for every hour, where it falls short,
 * who covers which hour of the typical day, and whether sliding a site's roster earlier or later would close the gaps.
 * Groups are picked from a searchable list (grouped by site) and kept as chips; a selection can be saved as a named view shared by the organisation. The result appears by itself
 * once two groups are picked, opens with the answer, and can be shown in UTC or in the time of any picked group.
 */
import { Waiting } from '../common/loading';
import React, { useEffect, useMemo, useState } from 'react';
import { X } from 'lucide-react';
import { api, dec, nextWeekStart } from '../../services/api';
import { useForecast } from '../../services/forecastStore';
import { CHART, LineChart } from '../forecasting/charts';
import { useApi, usePayWeek } from '../forecasting/hooks';
import { Banner, Btn, Busy, Card, Empty, Field, Input, Kpi, KpiRow, Select } from '../forecasting/ui';

type Sun = {
  from: string; to: string; notes: string[]; groups: { id: string; name: string; timezone: string; versionId: string | null; coveragePercent?: number }[];
  profile: { utcHour: number; required: number; scheduled: number; byGroup: Record<string, number> }[];
  gaps: { from: string; to: string; hours: number; worstShort: number }[];
  totals: { requiredHours: number; scheduledHours: number; shortHours: number; coveredPercent: number };
  suggestions: { groupId: string; name: string; currentShortHours: number; bestShiftHours: number; shortHoursAfter: number; improvementPercent: number }[];
};
type Choice = { id: string; name: string; timezone: string; siteName: string | null; hasSchedule: boolean };
type View = { id: string; name: string; groupIds: string[]; displayTz: string; weekChoice: 'THIS' | 'NEXT' | null; createdBy: string | null };

const MAX_GROUPS = 12;
/** Minutes a zone is ahead of UTC right now. */
const offsetMin = (tz: string) => {
  if (tz === 'UTC') return 0;
  try {
    const p = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric' }).formatToParts(new Date());
    const g = (t: string) => Number(p.find((x) => x.type === t)?.value);
    return Math.round((Date.UTC(g('year'), g('month') - 1, g('day'), g('hour'), g('minute')) - Math.floor(Date.now() / 60000) * 60000) / 60000);
  } catch { return 0; }
};
const offsetLabel = (tz: string) => { const m = offsetMin(tz); const a = Math.abs(m); return `UTC${m < 0 ? '-' : '+'}${Math.floor(a / 60)}${a % 60 ? `:${String(a % 60).padStart(2, '0')}` : ''}`; };
const city = (tz: string) => (tz === 'UTC' ? 'UTC' : (tz.split('/').pop() ?? tz).replace(/_/g, ' '));
const zoneText = (tz: string) => (tz === 'UTC' ? 'UTC' : `${city(tz)}, ${offsetLabel(tz)}`);
const hhmm = (min: number) => { const m = ((min % 1440) + 1440) % 1440; return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`; };
/** An ISO instant (UTC) as "Sat 09 Nov 02:00" in a zone. */
const when = (iso: string, tz: string) => {
  const d = new Date(iso.endsWith('Z') ? iso : `${iso}Z`);
  try { return new Intl.DateTimeFormat('en-GB', { timeZone: tz, weekday: 'short', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(d).replace(',', ''); } catch { return iso; }
};
const COLORS = ['#4F6F8F', '#2F7D5A', '#B7791F', '#7A62A8', '#C84A4A', '#525252'];

export const SunPanel: React.FC = () => {
  const { groups, can, setGroupId, go } = useForecast();
  const weekStart = usePayWeek(null);                      // the first day of the company's pay week
  const [pickedFrom, setFrom] = useState<string | null>(null);
  const [weekChoice, setWeekChoice] = useState<'THIS' | 'NEXT' | null>('NEXT');   // which quick choice the week came from; null once a date is typed
  const from = pickedFrom ?? nextWeekStart(weekStart, 1);
  const choices = useApi<Choice[]>(groups.length >= 2 ? `/scheduling/follow-the-sun/choices?from=${from}&days=7` : null, [from]);
  const [views, setViews] = useState<View[]>([]);
  const loadViews = () => api<View[]>('/scheduling/follow-the-sun/views').then(setViews).catch(() => {});
  useEffect(() => { if (groups.length >= 2) loadViews(); }, [groups.length]);

  const [picked, setPicked] = useState<string[]>([]);
  const [find, setFind] = useState('');
  const [showAll, setShowAll] = useState(false);
  const [tz, setTz] = useState('UTC');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [sun, setSun] = useState<Sun | null>(null);
  const [saving, setSaving] = useState(false);
  const [viewName, setViewName] = useState('');
  const [note, setNote] = useState('');

  const byId = useMemo(() => new Map((choices.data ?? []).map((c) => [c.id, c])), [choices.data]);
  // the result follows the selection by itself: two groups or more, after a short pause so ticking several does not fire several requests
  useEffect(() => {
    if (picked.length < 2) { setSun(null); setErr(''); return; }
    let live = true; setBusy(true); setErr('');
    const t = setTimeout(() => {
      api<Sun>(`/scheduling/follow-the-sun?groupIds=${picked.join(',')}&from=${from}&days=7`)
        .then((s) => { if (live) setSun(s); })
        .catch((e) => { if (live) { setErr(e.message); setSun(null); } })
        .finally(() => live && setBusy(false));
    }, 500);
    return () => { live = false; clearTimeout(t); };
  }, [picked.join(','), from]);
  useEffect(() => { if (tz !== 'UTC' && byId.size && !picked.some((id) => (byId.get(id)?.timezone ?? groups.find((g) => g.id === id)?.timezone) === tz)) setTz('UTC'); }, [picked.join(','), byId]);

  if (groups.length < 2) return <Empty title="Two or more WFM groups are needed">Create the groups for each site, publish a schedule for each, and they can be seen on one clock here.</Empty>;

  // each group's queues, by name: sites that share none cannot cover each other's need, however the hours line up
  const queueNames = (id: string) => new Set((groups.find((g) => g.id === id)?.queues ?? []).map((x) => x.name.trim().toLowerCase()));
  const apart = picked.length >= 2 ? picked.filter((id) => { const mine = queueNames(id); const rest = picked.filter((x) => x !== id).flatMap((x) => [...queueNames(x)]); return mine.size > 0 && !rest.some((n) => mine.has(n)); }) : [];
  const q = find.trim().toLowerCase();
  const usable = (c: Choice) => c.hasSchedule;
  const list = (choices.data ?? []).filter((c) => !picked.includes(c.id) && (showAll || usable(c)) && (!q || `${c.name} ${c.siteName ?? ''} ${city(c.timezone)}`.toLowerCase().includes(q)));
  const bySite = new Map<string, Choice[]>();
  for (const c of list) { const k = c.siteName ?? 'No site'; bySite.set(k, [...(bySite.get(k) ?? []), c]); }
  const hidden = (choices.data ?? []).filter((c) => !usable(c)).length;
  const add = (id: string) => picked.length < MAX_GROUPS && setPicked((p) => [...p, id]);
  const weekEnd = (() => { const d = new Date(from + 'T00:00:00'); d.setDate(d.getDate() + 6); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; })();

  const saveView = async () => {
    setNote('');
    try { await api('/scheduling/follow-the-sun/views', { method: 'POST', body: { name: viewName, groupIds: picked, displayTz: tz, weekChoice } }); setSaving(false); setViewName(''); loadViews(); setNote('View saved. Everyone in the organisation can open it.'); } catch (e: any) { setNote(e.message); }
  };
  const dropView = async (v: View) => { if (!confirm(`Delete the saved view "${v.name}"?`)) return; try { await api(`/scheduling/follow-the-sun/views/${v.id}`, { method: 'DELETE' }); loadViews(); } catch (e: any) { setNote(e.message); } };

  const hh = (utcHour: number) => hhmm(utcHour * 60 + offsetMin(tz));
  const order = sun ? sun.profile.map((p, i) => ({ p, i })).sort((a, b) => ((a.p.utcHour * 60 + offsetMin(tz)) % 1440 + 1440) % 1440 - ((b.p.utcHour * 60 + offsetMin(tz)) % 1440 + 1440) % 1440) : [];
  const shownTz = tz === 'UTC' ? 'UTC' : zoneText(tz);
  const worst = sun?.gaps.reduce((a, g) => (g.worstShort > (a?.worstShort ?? -1) ? g : a), undefined as Sun['gaps'][number] | undefined);
  const exportCsv = () => {
    if (!sun) return;
    const esc = (v: string | number) => `"${String(v).replace(/"/g, '""')}"`;
    const lines = [
      [`Follow the Sun ${sun.from} to ${sun.to}`, `times in ${shownTz}`].map(esc).join(','), '',
      ['Hour', 'Needed', 'On shift', ...sun.groups.filter((g) => g.versionId).map((g) => g.name)].map(esc).join(','),
      ...order.map(({ p }) => [hh(p.utcHour), p.required, p.scheduled, ...sun.groups.filter((g) => g.versionId).map((g) => p.byGroup[g.id] ?? 0)].map(esc).join(',')), '',
      ['Gap from', 'Gap to', 'Hours', 'Worst shortfall (people)'].map(esc).join(','),
      ...sun.gaps.map((g) => [when(g.from, tz), when(g.to, tz), g.hours, g.worstShort].map(esc).join(',')),
    ];
    const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob(['\ufeff' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' })); a.download = `follow-the-sun-${sun.from}.csv`; a.click(); URL.revokeObjectURL(a.href);
  };
  /** The runs of hours a group has people on shift, as a readable window in the chosen zone. */
  const windows = (id: string) => {
    if (!sun) return '';
    const on = order.map(({ p }) => (p.byGroup[id] ?? 0) > 0);
    if (on.every(Boolean)) return 'around the clock';
    const out: string[] = [];
    for (let k = 0; k < on.length; k++) {
      if (!on[k] || on[(k + on.length - 1) % on.length]) continue;
      let e = k; while (on[(e + 1) % on.length] && (e + 1) % on.length !== k) e++;
      out.push(`${hhmm(sun.profile[order[k].i].utcHour * 60 + offsetMin(tz))} to ${hhmm(sun.profile[order[e % on.length].i].utcHour * 60 + offsetMin(tz) + 60)}`);
    }
    return out.join(', ');
  };

  return (
    <div className="space-y-6">
      <Card title="Choose the sites" sub="Share one day of work across sites in different time zones. Pick two or more groups; the result appears below.">
        {views.length > 0 && (
          <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Saved views">
            <span className="text-[12px] font-semibold">Saved views</span>
            {views.map((v) => (
              <span key={v.id} className="inline-flex items-center border border-[#E5E5E0] rounded-md overflow-hidden text-[12px]">
                <button type="button" className="px-2.5 py-1 hover:bg-[#FAFAF8]" onClick={() => { setPicked(v.groupIds.filter((id) => byId.has(id) || !choices.data)); setNote(''); setTz(v.displayTz); if (v.weekChoice) { setFrom(nextWeekStart(weekStart, v.weekChoice === 'THIS' ? -6 : 1)); setWeekChoice(v.weekChoice); } }}>{v.name} ({v.groupIds.length})</button>
                {can('workforce:write') && <button type="button" aria-label={`Delete ${v.name}`} className="px-1.5 py-1 text-[#6B6B6B] hover:text-[#BC3F3F]" onClick={() => dropView(v)}><X className="w-3 h-3" /></button>}
              </span>
            ))}
          </div>
        )}

        <div className="flex flex-wrap items-end gap-3">
          <Field label="Week of" hint={`${from} to ${weekEnd}`}><Input type="date" value={from} onChange={(e) => { setFrom(e.target.value); setWeekChoice(null); }} /></Field>
          <div className="flex gap-2 pb-[22px]">
            <Btn onClick={() => { setFrom(nextWeekStart(weekStart, -6)); setWeekChoice('THIS'); }}>This week</Btn>
            <Btn onClick={() => { setFrom(nextWeekStart(weekStart, 1)); setWeekChoice('NEXT'); }}>Next week</Btn>
          </div>
        </div>

        <div className="flex flex-wrap gap-2 min-h-[32px]" aria-label="Picked groups">
          {picked.length === 0 && <span className="text-[12px] text-[#6B6B6B] py-1.5">Nothing picked yet.</span>}
          {picked.map((id) => { const c = byId.get(id); const g = groups.find((x) => x.id === id); return (
            <span key={id} className="inline-flex items-center gap-1.5 bg-[#F0F4F8] border border-[#D6DEE8] rounded-full pl-3 pr-1.5 py-1 text-[12px]">
              <span className="font-medium">{c?.name ?? g?.name ?? 'Group'}</span><span className="text-[#6B6B6B]">{zoneText(c?.timezone ?? g?.timezone ?? 'UTC')}</span>
              <button type="button" aria-label={`Remove ${c?.name ?? g?.name}`} className="p-0.5 text-[#6B6B6B] hover:text-[#171717]" onClick={() => setPicked((p) => p.filter((x) => x !== id))}><X className="w-3 h-3" /></button>
            </span>); })}
        </div>

        <div className="border border-[#E5E5E0] rounded-lg">
          <div className="p-2 border-b border-[#E5E5E0]"><Input aria-label="Find a group" placeholder="Find a group, site or city" value={find} onChange={(e) => setFind(e.target.value)} /></div>
          <div className="max-h-[260px] overflow-y-auto">
            {choices.loading && !choices.data ? <div className="p-3"><Waiting what="the groups" shape="lines" reload={choices.reload} /></div>
              : list.length === 0 ? <p className="p-3 text-[12px] text-[#6B6B6B]">{q ? 'No group matches that.' : picked.length ? 'Every group with a published schedule is already picked.' : 'No group has a published schedule for this week yet.'}</p>
              : [...bySite].map(([site, cs]) => (
                <div key={site}>
                  <div className="px-3 py-1 text-[11px] font-semibold uppercase tracking-wide text-[#6B6B6B] bg-[#FAFAF8]">{site}</div>
                  {cs.map((c) => (
                    <button key={c.id} type="button" disabled={!usable(c) || picked.length >= MAX_GROUPS} onClick={() => add(c.id)} className="w-full flex items-center justify-between gap-3 px-3 py-1.5 text-left text-[13px] hover:bg-[#FAFAF8] disabled:opacity-50 disabled:hover:bg-transparent">
                      <span>{c.name}</span>
                      <span className="text-[11px] text-[#6B6B6B]">{usable(c) ? zoneText(c.timezone) : 'No published schedule this week'}</span>
                    </button>
                  ))}
                </div>))}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-4 text-[12px] text-[#525252]">
          {hidden > 0 && <button type="button" className="underline" onClick={() => setShowAll((s) => !s)}>{showAll ? 'Hide' : 'Show'} the {hidden} group{hidden === 1 ? '' : 's'} without a published schedule</button>}
          {picked.length >= MAX_GROUPS && <span className="text-[#8F6200]">Up to {MAX_GROUPS} groups at a time.</span>}
          {can('workforce:write') && picked.length >= 2 && !saving && <button type="button" className="underline" onClick={() => { setSaving(true); setNote(''); }}>Save this selection as a view</button>}
        </div>
        {saving && (
          <div className="flex flex-wrap items-end gap-3">
            <Field label="Name this view"><Input value={viewName} maxLength={80} onChange={(e) => setViewName(e.target.value)} placeholder="Global support" /></Field>
            <Btn variant="primary" disabled={!viewName.trim()} onClick={saveView}>Save view</Btn><Btn onClick={() => setSaving(false)}>Cancel</Btn>
          </div>
        )}
        {note && <p className="text-[12px] text-[#525252]">{note}</p>}
        {picked.length === 1 && <p className="text-[12px] text-[#8F6200]">Pick at least two groups to see them on one clock.</p>}
        {apart.length > 0 && <Banner kind="warn">{apart.map((id) => groups.find((g) => g.id === id)?.name).join(', ')} {apart.length === 1 ? 'serves' : 'serve'} no queue that the other picked groups serve (matched by queue name). Their people may not be able to cover each other, so read the totals below as separate sites, not one pool.</Banner>}
        {err && <Banner kind="warn">{err}</Banner>}
      </Card>

      {picked.length < 2 && !busy && (
        <p className="text-[13px] text-[#6B6B6B]">When two or more groups are picked, this shows where the combined cover meets the need hour by hour, who covers which hours, and where the gaps are.</p>
      )}
      {busy && <Busy text="Reading each site's schedule and forecast…" />}
      {sun && !busy && (
        <>
          <Card title={sun.gaps.length === 0 ? `Covered around the clock across ${sun.groups.filter((g) => g.versionId).length} sites` : `${dec(sun.totals.shortHours, 0)} hours short this week`}
            sub={sun.gaps.length === 0 ? `${sun.from} to ${sun.to}. Every hour is covered.` : `${sun.from} to ${sun.to}. ${worst ? `Biggest gap: ${when(worst.from, tz)} to ${when(worst.to, tz).split(' ').slice(-1)[0]} (${shownTz}), about ${dec(worst.worstShort, 1)} people short.` : ''}`}
            actions={<div className="flex flex-wrap items-center gap-2 text-[12px] print:hidden"><Btn onClick={() => exportCsv()}>Download CSV</Btn><Btn onClick={() => window.print()}>Print</Btn><span className="text-[#525252]">Show times in</span>
              <Select aria-label="Show times in" value={tz} onChange={(e) => setTz(e.target.value)} className="!w-auto"><option value="UTC">UTC</option>{[...new Set(picked.map((id) => byId.get(id)?.timezone).filter((z): z is string => !!z && z !== 'UTC'))].map((z) => <option key={z} value={z}>{zoneText(z)}</option>)}</Select></div>}>
            <KpiRow>
              <Kpi label="Hours needed" value={dec(sun.totals.requiredHours, 0)} /><Kpi label="Hours covered" value={dec(sun.totals.scheduledHours, 0)} />
              <Kpi label="Covered" value={`${dec(sun.totals.coveredPercent, 1)}%`} tone={sun.totals.coveredPercent >= 95 ? 'good' : sun.totals.coveredPercent >= 85 ? 'warn' : 'bad'} />
              <Kpi label="Hours short" value={dec(sun.totals.shortHours, 0)} tone={sun.totals.shortHours > 0 ? 'bad' : 'good'} sub={`${sun.gaps.length} gap${sun.gaps.length === 1 ? '' : 's'}`} />
            </KpiRow>
            <div className="text-[12px] font-semibold">A typical day, hour by hour ({shownTz}): people needed against people on shift</div>
            <LineChart height={260} leftLabel="people" labels={order.map(({ p }) => hh(p.utcHour))} xEvery={2}
              series={[{ name: 'Needed', color: CHART.agents, kind: 'step', values: order.map(({ p }) => p.required) }, { name: 'On shift', color: CHART.scheduled, kind: 'step', area: true, values: order.map(({ p }) => p.scheduled) }]}
              tooltip={(i) => <span>{sun.groups.map((g) => `${g.name}: ${order[i].p.byGroup[g.id] ?? 0}`).join(' · ')}</span>} />
          </Card>

          <Card title="Who covers which hours" sub={`Each site's working hours on a typical day, in ${shownTz}. Darker means more people.`}>
            <div className="overflow-x-auto">
              <table className="w-full text-[11px]">
                <thead className="text-left text-[#6B6B6B]"><tr><th className="py-1 pr-3">Site</th><th className="pr-3">Working hours</th><th><div className="flex w-[360px] justify-between"><span>{hh(order[0]?.p.utcHour ?? 0)}</span><span>{hh(order[6]?.p.utcHour ?? 6)}</span><span>{hh(order[12]?.p.utcHour ?? 12)}</span><span>{hh(order[18]?.p.utcHour ?? 18)}</span></div></th></tr></thead>
                <tbody>{sun.groups.filter((g) => g.versionId).map((g, k) => {
                  const max = Math.max(1, ...sun.profile.map((p) => p.byGroup[g.id] ?? 0));
                  return (
                    <tr key={g.id} className="border-t border-[#E5E5E0]">
                      <td className="py-1.5 pr-3 whitespace-nowrap"><span className="inline-block w-2.5 h-2.5 rounded-sm mr-1.5" style={{ background: COLORS[k % COLORS.length] }} />{g.name} <span className="text-[#6B6B6B]">{zoneText(g.timezone)}</span></td>
                      <td className="pr-3 whitespace-nowrap">{windows(g.id) || 'no one'}</td>
                      <td><div className="flex w-[360px] h-4 gap-px">{order.map(({ p }) => { const n = p.byGroup[g.id] ?? 0; return <span key={p.utcHour} title={`${hh(p.utcHour)}: ${dec(n, 0)} on shift`} className="flex-1 rounded-[1px]" style={{ background: n ? COLORS[k % COLORS.length] : '#EDEDE8', opacity: n ? 0.35 + 0.65 * (n / max) : 1 }} />; })}</div></td>
                    </tr>);
                })}</tbody>
              </table>
            </div>
          </Card>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            <Card title="Where the need is not met" sub={`Runs of hours where the combined cover is below the combined need, in ${shownTz}.`}>
              {sun.gaps.length === 0 ? <p className="text-[13px] text-[#2A7553]">No gaps. Every hour is covered.</p> : (
                <table className="w-full text-[12px]"><thead className="text-left text-[#6B6B6B]"><tr><th>From</th><th>To</th><th className="text-right">Hours</th><th className="text-right">Worst shortfall</th></tr></thead>
                  <tbody>{sun.gaps.slice(0, 20).map((g, i) => <tr key={i} className="border-t border-[#E5E5E0]"><td className="py-1 tabular-nums">{when(g.from, tz)}</td><td className="tabular-nums">{when(g.to, tz)}</td><td className="text-right">{g.hours}</td><td className="text-right">{dec(g.worstShort, 1)} people</td></tr>)}</tbody></table>
              )}
            </Card>
            <Card title="If a site started earlier or later" sub="A what-if that slides one site's whole roster, to show where the gap sits. It ignores each person's own hours and availability, so plan the real change in the schedule.">
              <table className="w-full text-[12px]"><thead className="text-left text-[#6B6B6B]"><tr><th>Site</th><th className="text-right">Short now</th><th className="text-right">Best slide</th><th className="text-right">Short after</th><th className="print:hidden" /></tr></thead>
                <tbody>{sun.suggestions.map((s) => <tr key={s.groupId} className="border-t border-[#E5E5E0]"><td className="py-1">{s.name}</td><td className="text-right">{dec(s.currentShortHours, 0)} h</td>
                  <td className="text-right font-semibold">{s.bestShiftHours === 0 ? 'No change helps' : `${s.bestShiftHours > 0 ? '+' : ''}${s.bestShiftHours} h`}</td><td className="text-right">{s.bestShiftHours === 0 ? '·' : `${dec(s.shortHoursAfter, 0)} h (${dec(s.improvementPercent, 0)}% less)`}</td>
                  <td className="text-right print:hidden"><button type="button" className="underline text-[#525252]" onClick={() => { setGroupId(s.groupId); go('generate-schedule', 'scheduling'); }}>Plan {s.name} in Generate Schedule</button></td></tr>)}</tbody></table>
            </Card>
          </div>
          <ul className="text-[11px] text-[#6B6B6B] list-disc ml-4">{sun.notes.map((n) => <li key={n}>{n}</li>)}</ul>
        </>
      )}
    </div>
  );
};
