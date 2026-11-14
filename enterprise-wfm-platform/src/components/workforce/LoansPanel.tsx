/**
 * Workforce › Cross-Site Cover. Have a person cover at a group at another site for a stretch of days. They keep their home group; while the loan runs the schedule builder treats them as part
 * of the borrowing group's pool and keeps them off their home group, and afterwards nothing changes. Every loan has a reason and stays on record when it ends.
 */
import { Waiting } from '../common/loading';
import React, { useMemo, useState } from 'react';
import { api, Employee, dayYear } from '../../services/api';
import { useForecast } from '../../services/forecastStore';
import { useApi } from '../forecasting/hooks';
import { PersonPicker } from '../common/PersonPicker';
import { Banner, Btn, Card, Empty, Field, Input, Kpi, KpiRow, Pill, Seg, Table } from '../forecasting/ui';

type Loan = {
  id: string; employeeId: string; employeeName: string; employeeNumber: string; homeGroupId: string | null; homeGroup: string | null; homeSite: string | null;
  toGroupId: string; toGroup: string | null; toSite: string | null; startDay: string; endDay: string; reason: string; status: 'ACTIVE' | 'CANCELLED';
  state: 'UPCOMING' | 'CURRENT' | 'PAST' | 'CANCELLED'; createdBy: string | null; endedBy: string | null;
};
type SiteLite = { id: string; name: string; status: 'ACTIVE' | 'CLOSED' };

const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const plus = (n: number) => { const d = new Date(); d.setDate(d.getDate() + n); return iso(d); };
const place = (group: string | null, site: string | null) => (group ? `${group}${site ? ` · ${site}` : ''}` : 'another site you cannot see');
const STATE: Record<Loan['state'], { label: string; tone: 'good' | 'info' | 'neutral' | 'warn' }> = {
  CURRENT: { label: 'Covering now', tone: 'good' }, UPCOMING: { label: 'Starts soon', tone: 'info' }, PAST: { label: 'Finished', tone: 'neutral' }, CANCELLED: { label: 'Cancelled', tone: 'warn' },
};

export const LoansPanel: React.FC = () => {
  const { groups, can } = useForecast();
  const canWrite = can('workforce:write');
  const [tab, setTab] = useState<'active' | 'past'>('active');
  const [tick, setTick] = useState(0);
  const list = useApi<Loan[]>(`/workforce/loans?when=${tab}`, [tab, tick]);
  const sites = useApi<SiteLite[]>('/config/sites');
  const [person, setPerson] = useState<Employee | null>(null);
  const [toGroupId, setToGroupId] = useState('');
  const [startDay, setStartDay] = useState(plus(1));
  const [endDay, setEndDay] = useState(plus(14));
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const siteOf = (groupId: string | null | undefined) => { const sid = (groups.find((g) => g.id === groupId) as any)?.siteId as string | null | undefined; return sid ? sites.data?.find((s) => s.id === sid) ?? null : null; };
  const homeId = person?.primaryGroupId ?? null;
  const homeSite = siteOf(homeId);
  // where the person can be lent: groups at a different open site (a group with no site is offered too, and the server checks the rest)
  const targets = useMemo(() => {
    const bySite = new Map<string, { id: string; name: string }[]>();
    for (const g of groups) {
      if (g.id === homeId) continue;
      const s = siteOf(g.id);
      if (s && (s.status === 'CLOSED' || s.id === homeSite?.id)) continue;
      const key = s?.name ?? 'No site';
      bySite.set(key, [...(bySite.get(key) ?? []), { id: g.id, name: g.name }]);
    }
    return [...bySite].sort(([a], [b]) => a.localeCompare(b));
  }, [groups, sites.data, homeId, homeSite?.id]);

  const lend = async () => {
    if (!person) return;
    setBusy(true); setError(''); setNotice('');
    try {
      const r = await api<{ loan: Loan; warnings: { publishedShiftsAtHome: number } }>('/workforce/loans', { method: 'POST', body: { employeeId: person.id, toGroupId, startDay, endDay, reason: reason.trim() } });
      setNotice(`${r.loan.employeeName} will cover at ${place(r.loan.toGroup, r.loan.toSite)} from ${dayYear(r.loan.startDay)} to ${dayYear(r.loan.endDay)}.${r.warnings.publishedShiftsAtHome ? ` ${r.warnings.publishedShiftsAtHome} shift${r.warnings.publishedShiftsAtHome === 1 ? ' is' : 's are'} already published at ${r.loan.homeGroup ?? 'the home group'} in these days: change or remove ${r.warnings.publishedShiftsAtHome === 1 ? 'it' : 'them'} in the schedule.` : ''}`);
      setPerson(null); setToGroupId(''); setReason(''); setTick((t) => t + 1);
    } catch (e: any) { setError(e.message); } finally { setBusy(false); }
  };
  const end = async (l: Loan) => {
    const upcoming = l.state === 'UPCOMING';
    if (!confirm(upcoming ? `Cancel the cover arranged for ${l.employeeName} at ${l.toGroup ?? 'another site'}?` : `End ${l.employeeName}'s cover now? They are back at ${l.homeGroup ?? 'their home group'} from today.`)) return;
    setError(''); setNotice('');
    try { await api(`/workforce/loans/${l.id}/end`, { method: 'POST' }); setNotice(upcoming ? 'Cover cancelled.' : 'Cover ended. The person is back at their home group from today.'); setTick((t) => t + 1); } catch (e: any) { setError(e.message); }
  };

  const rows = list.data ?? [];
  const now = rows.filter((l) => l.state === 'CURRENT').length, soon = rows.filter((l) => l.state === 'UPCOMING').length;
  const ready = !!person && !!toGroupId && !!startDay && !!endDay && endDay >= startDay && reason.trim().length >= 3;

  return (
    <div className="space-y-6">
      {error && <Banner kind="err" onClose={() => setError('')}>{error}</Banner>}
      {notice && <Banner kind="ok" onClose={() => setNotice('')}>{notice}</Banner>}

      {canWrite && (
        <Card title="Arrange cover at another site" sub="The person keeps their home group. While the cover runs, schedules for the other group can use them, and their home group does not. Afterwards nothing changes.">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 max-w-4xl items-start">
            <Field label="Person" hint={person ? `Home: ${place(person.primaryGroupName ?? null, homeSite?.name ?? null)}` : 'Active people only'}>
              <PersonPicker ariaLabel="Person to send" status="ACTIVE" value={person?.id ?? ''} onChange={(id, p) => { setPerson(id ? p : null); setToGroupId(''); }} placeholder="Choose the person" />
            </Field>
            <Field label="Cover at" hint={person && !person.primaryGroupId ? 'This person has no home group yet' : 'A group at a different site'}>
              <select aria-label="Cover at" disabled={!person} value={toGroupId} onChange={(e) => setToGroupId(e.target.value)} className="w-full h-9 px-3 border border-[#D4D4CF] rounded text-[13px] bg-white">
                <option value="">Choose a group</option>
                {targets.map(([site, gs]) => <optgroup key={site} label={site}>{gs.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}</optgroup>)}
              </select>
            </Field>
            <Field label="First day"><Input type="date" min={plus(0)} value={startDay} onChange={(e) => setStartDay(e.target.value)} /></Field>
            <Field label="Last day" hint="Up to 180 days"><Input type="date" min={startDay} value={endDay} onChange={(e) => setEndDay(e.target.value)} /></Field>
            <div className="md:col-span-2"><Field label="Reason" hint="Kept on record with the cover"><Input value={reason} maxLength={300} onChange={(e) => setReason(e.target.value)} placeholder="London is short for the November peak" /></Field></div>
          </div>
          <Btn variant="primary" disabled={!ready || busy} onClick={lend}>{busy ? 'Saving…' : 'Arrange cover'}</Btn>
        </Card>
      )}

      <Card title="Cover arranged" sub="Who covers where, and when. Ended and cancelled cover stays on record under Past.">
        <div className="flex flex-wrap items-center gap-4">
          <Seg options={[{ id: 'active', label: 'Current and upcoming' }, { id: 'past', label: 'Past' }]} value={tab} onChange={(v) => setTab(v as 'active' | 'past')} />
        </div>
        {tab === 'active' && <KpiRow><Kpi label="Covering now" value={now} /><Kpi label="Starting soon" value={soon} /></KpiRow>}
        {list.loading && !list.data ? <Waiting what="loans" shape="table" reload={list.reload} />
          : rows.length === 0 ? <Empty title={tab === 'active' ? 'No cover arranged right now' : 'No past cover'}>{tab === 'active' ? 'When a site is short and another has people to spare, arrange cover above.' : 'Finished and cancelled cover appears here.'}</Empty> : (
            <Table head={['Person', 'Home', 'Covering at', 'Days', 'Reason', 'Status', '']}>
              {rows.map((l) => (
                <tr key={l.id}>
                  <td className="p-2.5"><div className="font-medium">{l.employeeName}</div><div className="text-[11px] text-[#6B6B6B] font-mono">#{l.employeeNumber}</div></td>
                  <td className="p-2.5 text-[12px]">{place(l.homeGroup, l.homeSite)}</td><td className="p-2.5 text-[12px]">{place(l.toGroup, l.toSite)}</td>
                  <td className="p-2.5 text-[12px] whitespace-nowrap">{dayYear(l.startDay)} to {dayYear(l.endDay)}</td>
                  <td className="p-2.5 text-[12px] max-w-[260px]">{l.reason}{l.createdBy && <div className="text-[11px] text-[#6B6B6B]">by {l.createdBy}</div>}</td>
                  <td className="p-2.5"><Pill tone={STATE[l.state].tone}>{STATE[l.state].label}</Pill></td>
                  <td className="p-2.5 text-right">{canWrite && (l.state === 'CURRENT' || l.state === 'UPCOMING') && <button className="text-[12px] underline" onClick={() => end(l)}>{l.state === 'UPCOMING' ? 'Cancel' : 'End now'}</button>}</td>
                </tr>
              ))}
            </Table>
          )}
      </Card>
    </div>
  );
};
