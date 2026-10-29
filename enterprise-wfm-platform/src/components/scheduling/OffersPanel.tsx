/**
 * Scheduling › VTO & Overtime. Offer time off when the day is overstaffed, or extra hours when it is short. The forecast suggests
 * windows; you choose the window and the number of places. Everyone whose shift can take the change without breaking a blocking rule
 * is invited, in the order set under Configuration › Self-Service Rules. The first valid acceptances change the published schedule.
 */
import React, { useEffect, useState } from 'react';
import { ChevronDown, ChevronRight, Plus } from 'lucide-react';
import { api, when } from '../../services/api';
import { useForecast } from '../../services/forecastStore';
import { useApi } from '../forecasting/hooks';
import { Banner, Btn, Busy, Card, Empty, Field, Input, Pill, Select, Table } from '../forecasting/ui';

type Offer = {
  id: string; groupId: string; groupName: string; kind: 'VTO' | 'OVERTIME'; day: string; startTime: string; endTime: string; spots: number; filled: number; status: string; note: string; ordering: string;
  waveSize: number; wave: number; closesAt: string; createdBy: string; invited: number; queued: number; declined: number; total: number;
};
type Detail = Offer & { invites: { employeeId: string; name: string; employeeNumber: string; rank: number; wave: number; status: string; warnings: string[] }[] };
type Gaps = { from: string; days: number; unpublishedDays: string[]; totalShortHours: number; gaps: { day: string; startTime: string; endTime: string; spots: number; shortHours: number }[] };
type Suggestion = { kind: 'VTO' | 'OVERTIME'; startTime: string; endTime: string; spots: number; reason: string };

const ORDERINGS: [string, string][] = [
  ['', 'The organisation’s rule'], ['SENIORITY', 'Seniority'], ['FIRST_COME', 'First to accept'], ['FEWEST_HOURS', 'Fewest hours this week'], ['MOST_HOURS', 'Most hours this week'], ['ROUND_ROBIN', 'Longest since last accepted'], ['RANDOM', 'Random'],
];
const ORDER_LABEL = Object.fromEntries(ORDERINGS.filter(([k]) => k)) as Record<string, string>;
const STATUS: Record<string, { label: string; tone: 'good' | 'info' | 'neutral' | 'bad' | 'warn' }> = {
  OPEN: { label: 'Open', tone: 'info' }, FILLED: { label: 'Filled', tone: 'good' }, EXPIRED: { label: 'Closed', tone: 'neutral' }, CANCELLED: { label: 'Cancelled', tone: 'neutral' },
};
const INV: Record<string, { label: string; tone: 'good' | 'info' | 'neutral' | 'bad' | 'warn' }> = {
  QUEUED: { label: 'Waiting their turn', tone: 'neutral' }, INVITED: { label: 'Asked', tone: 'info' }, ACCEPTED: { label: 'Accepted', tone: 'good' }, DECLINED: { label: 'Declined', tone: 'neutral' }, EXPIRED: { label: 'Closed', tone: 'neutral' }, SKIPPED: { label: 'No longer possible', tone: 'warn' },
};
const today = () => new Date().toISOString().slice(0, 10);
const kindLabel = (k: string) => (k === 'VTO' ? 'Time off' : 'Overtime');

export const OffersPanel: React.FC = () => {
  const { group, can } = useForecast();
  const canEdit = can('schedule:edit');
  const [tick, setTick] = useState(0);
  const offers = useApi<Offer[]>('/scheduling/offers', [tick]);
  const [day, setDay] = useState(today());
  const sug = useApi<{ vto: Suggestion[]; overtime: Suggestion[]; reforecastApplied?: boolean }>(group ? `/scheduling/offers/suggestions?groupId=${group.id}&day=${day}` : null, [tick]);
  const [horizon, setHorizon] = useState(7);
  const gaps = useApi<Gaps>(group ? `/scheduling/offers/shortages?groupId=${group.id}&days=${horizon}` : null, [tick, horizon]);
  const [form, setForm] = useState({ kind: 'VTO' as 'VTO' | 'OVERTIME', startTime: '14:00', endTime: '16:00', spots: 1, ordering: '', note: '' });
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const detail = useApi<Detail>(open ? `/scheduling/offers/${open}` : null, [tick]);
  useEffect(() => { const t = setInterval(() => setTick((x) => x + 1), 20000); return () => clearInterval(t); }, []);

  const create = async () => {
    if (!group) return;
    setBusy(true); setError(''); setNotice('');
    try {
      const o = await api<Offer>('/scheduling/offers', { method: 'POST', body: { groupId: group.id, kind: form.kind, day, startTime: form.startTime, endTime: form.endTime, spots: form.spots, note: form.note, ...(form.ordering ? { ordering: form.ordering } : {}) } });
      setNotice(`Offer opened. ${o.invited} ${o.invited === 1 ? 'person has' : 'people have'} been asked${o.queued ? `, ${o.queued} more will be asked in turn` : ''}.`);
      setOpen(o.id); setTick((t) => t + 1);
    } catch (e: any) { setError(e.message); } finally { setBusy(false); }
  };
  const cancel = async (id: string) => { if (!confirm('Cancel this offer? Anyone who has not answered is released.')) return; try { await api(`/scheduling/offers/${id}/cancel`, { method: 'POST' }); setTick((t) => t + 1); } catch (e: any) { setError(e.message); } };
  const fromSuggestion = (s: Suggestion) => setForm((f) => ({ ...f, kind: s.kind, startTime: s.startTime, endTime: s.endTime, spots: s.spots }));
  const offerForGap = (g: Gaps['gaps'][number]) => { setDay(g.day); setForm((f) => ({ ...f, kind: 'OVERTIME', startTime: g.startTime, endTime: g.endTime, spots: g.spots })); window.scrollTo({ top: 0, behavior: 'smooth' }); };
  const mine = (offers.data ?? []).filter((o) => !group || o.groupId === group.id);

  return (
    <div className="space-y-6">
      {error && <Banner kind="err" onClose={() => setError('')}>{error}</Banner>}
      {notice && <Banner kind="ok" onClose={() => setNotice('')}>{notice}</Banner>}

      <Card title="Open an offer" sub="Time off must reach the start or the end of a shift. Extra hours must join up with a shift or fall on a day off. Only people who can take it without breaking a blocking rule are asked.">
        <div className="grid grid-cols-1 md:grid-cols-3 xl:grid-cols-6 gap-4">
          <Field label="What"><Select value={form.kind} disabled={!canEdit} onChange={(e) => setForm({ ...form, kind: e.target.value as 'VTO' | 'OVERTIME' })}><option value="VTO">Time off (VTO)</option><option value="OVERTIME">Overtime</option></Select></Field>
          <Field label="Day"><Input type="date" value={day} min={today()} onChange={(e) => setDay(e.target.value)} /></Field>
          <Field label="From"><Input type="time" step={900} value={form.startTime} disabled={!canEdit} onChange={(e) => setForm({ ...form, startTime: e.target.value })} /></Field>
          <Field label="To"><Input type="time" step={900} value={form.endTime} disabled={!canEdit} onChange={(e) => setForm({ ...form, endTime: e.target.value })} /></Field>
          <Field label="Places"><Input type="number" min={1} max={500} value={form.spots} disabled={!canEdit} onChange={(e) => setForm({ ...form, spots: Math.max(1, Number(e.target.value)) })} /></Field>
          <Field label="Who is asked first"><Select value={form.ordering} disabled={!canEdit} onChange={(e) => setForm({ ...form, ordering: e.target.value })}>{ORDERINGS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</Select></Field>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 items-end max-w-4xl">
          <div className="md:col-span-2"><Field label="Note for the people asked (optional)"><Input value={form.note} maxLength={200} disabled={!canEdit} onChange={(e) => setForm({ ...form, note: e.target.value })} placeholder="For example: quiet afternoon, leave when you like" /></Field></div>
          {canEdit && <div><Btn variant="primary" onClick={create} disabled={busy || !group}><Plus className="w-3.5 h-3.5" />Open offer</Btn></div>}
        </div>
        {busy && <Busy text="Checking who can take it…" />}
      </Card>

      <Card title="Gaps still to cover" sub={group ? `${group.name}: stretches in the coming days where the published schedule, rotation crews included, has fewer people than the forecast needs. Offer them as overtime and everyone who can take it without breaking a rule is asked, crew members on a day off too.` : undefined}>
        <div className="flex items-center gap-2 mb-3 text-[12px] text-[#525252]">Look ahead
          <Select value={horizon} onChange={(e) => setHorizon(Number(e.target.value))}>{[3, 7, 14].map((d) => <option key={d} value={d}>{d} days</option>)}</Select>
        </div>
        {gaps.error ? <p className="text-[13px] text-[#737373]">{gaps.error}</p> : !gaps.data ? <Busy text="Looking for gaps…" /> : (
          <div className="space-y-3">
            {gaps.data.unpublishedDays.length > 0 && <p className="text-[12px] text-[#B7791F]">{gaps.data.unpublishedDays.length === gaps.data.days ? 'No schedule is published for these days, so there is nothing to offer yet. Publish one first.' : `No schedule is published on ${gaps.data.unpublishedDays.length} of these days (${gaps.data.unpublishedDays.slice(0, 3).join(', ')}${gaps.data.unpublishedDays.length > 3 ? ', …' : ''}).`}</p>}
            {gaps.data.gaps.length === 0 && gaps.data.unpublishedDays.length < gaps.data.days && <p className="text-[13px] text-[#737373]">No gaps. The published schedule covers the forecast for the next {gaps.data.days} days.</p>}
            {gaps.data.gaps.length > 0 && <>
              <p className="text-[12px] text-[#525252]">{gaps.data.gaps.length} {gaps.data.gaps.length === 1 ? 'gap' : 'gaps'}, {gaps.data.totalShortHours} hours short in total.</p>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                {gaps.data.gaps.map((g, i) => (
                  <div key={i} className="p-3 border border-[#E5E5E0] rounded-lg flex items-center justify-between gap-3">
                    <div><div className="flex items-center gap-2"><Pill tone="warn">Short</Pill><span className="font-semibold text-[13px]">{g.day} · {g.startTime} to {g.endTime}</span></div><div className="text-[11px] text-[#737373] mt-1">Up to {g.spots} {g.spots === 1 ? 'person' : 'people'} short, {g.shortHours} hours in all</div></div>
                    {canEdit && <Btn onClick={() => offerForGap(g)}>Offer overtime</Btn>}
                  </div>
                ))}
              </div>
            </>}
          </div>
        )}
      </Card>

      <Card title="Suggested from the forecast" sub={group ? `${group.name} on ${day}: where the published schedule has more or fewer people than ${sug.data?.reforecastApplied ? 'today is actually running' : 'the forecast needs'}.` : undefined}>
        {sug.error ? <p className="text-[13px] text-[#737373]">{sug.error}</p> : !sug.data ? <Busy text="Looking at the forecast…" /> : sug.data.vto.length + sug.data.overtime.length === 0 ? <p className="text-[13px] text-[#737373]">The schedule matches the forecast on this day. Nothing to suggest.</p> : (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {[...sug.data.vto, ...sug.data.overtime].map((s, i) => (
              <div key={i} className="p-3 border border-[#E5E5E0] rounded-lg flex items-center justify-between gap-3">
                <div><div className="flex items-center gap-2"><Pill tone={s.kind === 'VTO' ? 'info' : 'warn'}>{kindLabel(s.kind)}</Pill><span className="font-semibold text-[13px]">{s.startTime} to {s.endTime}, {s.spots} {s.spots === 1 ? 'place' : 'places'}</span></div><div className="text-[11px] text-[#737373] mt-1">{s.reason}</div></div>
                {canEdit && <Btn onClick={() => fromSuggestion(s)}>Use</Btn>}
              </div>
            ))}
          </div>
        )}
      </Card>

      <Card title="Offers" sub="Newest first. Click one to see who was asked and what they answered.">
        {offers.loading && !offers.data && <Busy text="Loading…" />}
        {offers.data && mine.length === 0 && <Empty title="No offers yet">Open an offer above, or use a suggestion.</Empty>}
        <div className="space-y-2">
          {mine.map((o) => {
            const st = STATUS[o.status] ?? { label: o.status, tone: 'neutral' as const };
            return (
              <div key={o.id} className="border border-[#E5E5E0] rounded-lg">
                <button className="w-full p-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-left" onClick={() => setOpen(open === o.id ? null : o.id)}>
                  {open === o.id ? <ChevronDown className="w-4 h-4 text-[#737373]" /> : <ChevronRight className="w-4 h-4 text-[#737373]" />}
                  <Pill tone={st.tone}>{st.label}</Pill>
                  <span className="font-semibold text-[13px]">{kindLabel(o.kind)} · {o.day} · {o.startTime} to {o.endTime}</span>
                  <span className="text-[12px] text-[#525252]">{o.filled} of {o.spots} taken</span>
                  <span className="text-[12px] text-[#737373]">{o.total} eligible · {ORDER_LABEL[o.ordering] ?? o.ordering}{o.waveSize ? ` · waves of ${o.waveSize}` : ''}</span>
                  {o.status === 'OPEN' && <span className="text-[12px] text-[#737373] ml-auto">closes {when(o.closesAt)}</span>}
                </button>
                {open === o.id && (
                  <div className="p-3 border-t border-[#E5E5E0] space-y-3">
                    {o.note && <p className="text-[12px] text-[#525252]">“{o.note}”</p>}
                    {detail.data?.id === o.id ? (
                      <Table head={['#', 'Person', 'Answer', 'Notes']}>
                        {detail.data.invites.map((i) => {
                          const s = INV[i.status] ?? { label: i.status, tone: 'neutral' as const };
                          return <tr key={i.employeeId}><td className="p-2.5 font-mono text-[#737373]">{i.rank}</td><td className="p-2.5">{i.name} <span className="text-[#737373] text-[11px]">#{i.employeeNumber}</span></td><td className="p-2.5"><Pill tone={s.tone}>{s.label}</Pill></td><td className="p-2.5 text-[12px] text-[#B7791F]">{i.warnings[0] ?? ''}</td></tr>;
                        })}
                      </Table>
                    ) : <Busy text="Loading…" />}
                    {o.status === 'OPEN' && canEdit && <Btn onClick={() => cancel(o.id)}>Cancel offer</Btn>}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </Card>
    </div>
  );
};
