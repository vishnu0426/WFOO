/**
 * Configuration › Self-Service Rules. What employees can ask for in the app and what is approved without a manager:
 * time off (notice, balances, how many colleagues may be off at once), availability, and shift swaps.
 * A request that passes every rule is approved on the spot; anything else waits for a person.
 */
import React, { useEffect, useState } from 'react';
import { api } from '../../services/api';
import { useForecast } from '../../services/forecastStore';
import { useApi } from '../forecasting/hooks';
import { Banner, Btn, Busy, Card, Field, Input, Select } from '../forecasting/ui';

type Policy = {
  timeOffAutoApprove: boolean; timeOffMinNoticeDays: number; timeOffMaxOffPercent: number; entitlements: Record<string, number>; agentCanEditAvailability: boolean;
  swapAutoApprove: boolean; swapMaxExtraGapSlots: number; swapMinNoticeHours: number; swapBoardHours: number;
  accrualMode: 'UPFRONT' | 'MONTHLY'; carryOverDays: Record<string, number>;
  supervisorFirst: boolean; escalateHours: number; limitSupervisorsToTeams: boolean;
};
const TYPES: { id: string; label: string }[] = [
  { id: 'VACATION', label: 'Vacation' }, { id: 'SICK', label: 'Sick leave' }, { id: 'PERSONAL', label: 'Personal' }, { id: 'HOLIDAY', label: 'Holiday' },
  { id: 'TRAINING', label: 'Training' }, { id: 'LEAVE', label: 'Other leave' }, { id: 'OTHER', label: 'Other' },
];
const yesNo = (v: boolean) => (v ? 'y' : 'n');

type OfferPolicy = { vtoOrdering: string; overtimeOrdering: string; reverseSeniority: boolean; waveSize: number; waveMinutes: number; offerMinutes: number };
const ORDER: [string, string][] = [
  ['SENIORITY', 'Seniority (earliest hire date first)'], ['FIRST_COME', 'First to accept (everyone is asked at once)'], ['FEWEST_HOURS', 'Fewest hours worked this week'],
  ['MOST_HOURS', 'Most hours worked this week'], ['ROUND_ROBIN', 'Longest since they last accepted an offer'], ['RANDOM', 'Random (fair over time)'],
];

type OffRule = { id: string; kind: 'BLACKOUT' | 'CAP'; groupId: string | null; groupName: string | null; startDate: string; endDate: string; maxOff: number | null; types: string[]; strict: boolean; reason: string };

/** Dates when leave cannot be taken (blackouts) or is limited to a number of people (daily limits), for everyone or one WFM group. */
const TimeOffRules: React.FC = () => {
  const { can, groups } = useForecast();
  const [tick, setTick] = useState(0);
  const rules = useApi<OffRule[]>('/self-service/time-off-rules', [tick]);
  const blank = { kind: 'BLACKOUT' as 'BLACKOUT' | 'CAP', groupId: '', startDate: '', endDate: '', maxOff: 1, strict: false, reason: '' };
  const [f, setF] = useState(blank);
  const [err, setErr] = useState('');
  const canWrite = can('config:write');
  const add = async () => {
    setErr('');
    try { await api('/self-service/time-off-rules', { method: 'POST', body: { kind: f.kind, groupId: f.groupId || null, startDate: f.startDate, endDate: f.endDate || f.startDate, maxOff: f.kind === 'CAP' ? f.maxOff : null, strict: f.strict, reason: f.reason } }); setF(blank); setTick((n) => n + 1); }
    catch (e: any) { setErr(e.message); }
  };
  const del = async (r: OffRule) => { try { await api(`/self-service/time-off-rules/${r.id}`, { method: 'DELETE' }); setTick((n) => n + 1); } catch (e: any) { setErr(e.message); } };
  return (
    <Card title="Blackout dates and daily limits" sub="Dates when leave cannot be taken, or only a few people may be off at once, for everyone or one WFM group. A request that hits a rule goes to a manager with the reason, or is refused outright if you choose. Sick leave is never held up.">
      {err && <Banner kind="err" onClose={() => setErr('')}>{err}</Banner>}
      {(rules.data ?? []).length === 0 ? <p className="text-[12px] text-[#6B6B6B]">No rules yet.</p> : (
        <table className="w-full text-[12px]">
          <thead className="text-left text-[#6B6B6B]"><tr><th className="py-1">Rule</th><th>Dates</th><th>Applies to</th><th>If someone asks</th><th /></tr></thead>
          <tbody>{rules.data!.map((r) => (
            <tr key={r.id} className="border-t border-[#E5E5E0]">
              <td className="py-1.5"><span className="font-semibold">{r.kind === 'BLACKOUT' ? 'No leave' : `At most ${r.maxOff} off a day`}</span>{r.reason ? <span className="text-[#6B6B6B]"> · {r.reason}</span> : null}</td>
              <td className="tabular-nums">{r.startDate}{r.endDate !== r.startDate ? ` to ${r.endDate}` : ''}</td>
              <td>{r.groupName ?? 'Everyone'}</td><td>{r.strict ? 'Refused' : 'A manager decides'}</td>
              <td className="text-right">{canWrite && <button type="button" className="underline text-[#BC3F3F]" onClick={() => del(r)}>Remove</button>}</td>
            </tr>))}</tbody>
        </table>
      )}
      {canWrite && (
        <div className="border-t border-[#E5E5E0] pt-3 flex flex-wrap items-end gap-3">
          <Field label="Rule"><Select value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value as 'BLACKOUT' | 'CAP' })}><option value="BLACKOUT">No leave on these dates</option><option value="CAP">Limit how many are off</option></Select></Field>
          {f.kind === 'CAP' && <Field label="Most people off a day"><Input type="number" min={0} className="!w-20" value={f.maxOff} onChange={(e) => setF({ ...f, maxOff: Number(e.target.value) })} /></Field>}
          <Field label="From"><Input type="date" value={f.startDate} onChange={(e) => setF({ ...f, startDate: e.target.value, endDate: f.endDate < e.target.value ? e.target.value : f.endDate })} /></Field>
          <Field label="To"><Input type="date" value={f.endDate} min={f.startDate} onChange={(e) => setF({ ...f, endDate: e.target.value })} /></Field>
          <Field label="Applies to"><Select value={f.groupId} onChange={(e) => setF({ ...f, groupId: e.target.value })}><option value="">Everyone</option>{groups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}</Select></Field>
          <Field label="If someone asks"><Select value={f.strict ? 'y' : 'n'} onChange={(e) => setF({ ...f, strict: e.target.value === 'y' })}><option value="n">A manager decides</option><option value="y">Refuse it</option></Select></Field>
          <Field label="Reason (shown to staff)"><Input value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} placeholder="Year-end close" /></Field>
          <Btn variant="primary" disabled={!f.startDate} onClick={add}>Add rule</Btn>
        </div>
      )}
    </Card>
  );
};

/** How VTO and overtime offers are ordered and released. The administrator decides; nothing is fixed in code. */
const OfferRules: React.FC = () => {
  const { can } = useForecast();
  const res = useApi<OfferPolicy>('/self-service/offer-policy');
  const [d, setD] = useState<OfferPolicy | null>(null);
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');
  useEffect(() => { if (res.data) setD(res.data); }, [res.data]);
  if (!d) return res.error ? <Banner kind="err">{res.error}</Banner> : <Busy text="Loading…" />;
  const canWrite = can('config:write');
  const set = <K extends keyof OfferPolicy>(k: K, v: OfferPolicy[K]) => { setD({ ...d, [k]: v }); setMsg(''); };
  const save = async () => { setErr(''); try { await api('/self-service/offer-policy', { method: 'PUT', body: d }); setMsg('Saved. New offers use these rules.'); } catch (e: any) { setErr(e.message); } };
  return (
    <Card title="VTO and overtime offers" sub="Who is asked first when time off or extra hours are offered. A manager can still choose differently for a single offer. Everyone asked has already been checked against the scheduling rules and the labour-law pack.">
      {err && <Banner kind="err" onClose={() => setErr('')}>{err}</Banner>}
      {msg && <Banner kind="ok">{msg}</Banner>}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 max-w-4xl">
        <Field label="Time off (VTO): who is asked first"><Select disabled={!canWrite} value={d.vtoOrdering} onChange={(e) => set('vtoOrdering', e.target.value)}>{ORDER.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</Select></Field>
        <Field label="Overtime: who is asked first"><Select disabled={!canWrite} value={d.overtimeOrdering} onChange={(e) => set('overtimeOrdering', e.target.value)}>{ORDER.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</Select></Field>
        <Field label="Seniority order" hint="Only used when seniority is chosen above"><Select disabled={!canWrite} value={d.reverseSeniority ? 'y' : 'n'} onChange={(e) => set('reverseSeniority', e.target.value === 'y')}><option value="n">Most senior first</option><option value="y">Least senior first</option></Select></Field>
        <Field label="Offer stays open" hint="Never longer than until the window starts"><div className="flex items-center gap-2"><Input type="number" min={5} max={10080} disabled={!canWrite} value={d.offerMinutes} onChange={(e) => set('offerMinutes', Number(e.target.value))} /><span className="text-[12px] text-[#6B6B6B]">minutes</span></div></Field>
        <Field label="Ask in waves of" hint="0 asks everyone at once. Otherwise the next people are asked when a wave has all answered or the time below passes"><div className="flex items-center gap-2"><Input type="number" min={0} max={500} disabled={!canWrite} value={d.waveSize} onChange={(e) => set('waveSize', Number(e.target.value))} /><span className="text-[12px] text-[#6B6B6B]">people</span></div></Field>
        <Field label="Wait between waves"><div className="flex items-center gap-2"><Input type="number" min={1} max={1440} disabled={!canWrite} value={d.waveMinutes} onChange={(e) => set('waveMinutes', Number(e.target.value))} /><span className="text-[12px] text-[#6B6B6B]">minutes</span></div></Field>
      </div>
      {canWrite && <div><Btn variant="primary" onClick={save}>Save offer rules</Btn></div>}
    </Card>
  );
};

export const SelfServicePanel: React.FC = () => {
  const { can } = useForecast();
  const res = useApi<Policy>('/self-service/policy');
  const [d, setD] = useState<Policy | null>(null);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  const canWrite = can('config:write');
  useEffect(() => { if (res.data) setD(res.data); }, [res.data]);
  if (res.loading && !d) return <Busy text="Loading…" />;
  if (!d) return <Banner kind="err">{res.error || 'Could not load the self-service rules.'}</Banner>;

  const set = <K extends keyof Policy>(k: K, v: Policy[K]) => { setD({ ...d, [k]: v }); setSaved(false); };
  const setEnt = (t: string, raw: string) => { const e = { ...d.entitlements }; if (raw === '') delete e[t]; else e[t] = Number(raw); set('entitlements', e); };
  const save = async () => { setError(''); try { await api('/self-service/policy', { method: 'PUT', body: d }); setSaved(true); } catch (e: any) { setError(e.message); } };

  return (
    <div className="space-y-6">
      {error && <Banner kind="err" onClose={() => setError('')}>{error}</Banner>}
      {saved && <Banner kind="ok">Saved. The app uses these rules from now on.</Banner>}

      <Card title="Time off" sub="A request that is far enough ahead, within the person's balance, and would not leave too many colleagues off is approved immediately. Sick leave skips the notice and cover checks.">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 max-w-4xl">
          <Field label="Approve automatically" hint="Off: every request goes to a manager"><Select disabled={!canWrite} value={yesNo(d.timeOffAutoApprove)} onChange={(e) => set('timeOffAutoApprove', e.target.value === 'y')}><option value="n">No, a manager decides</option><option value="y">Yes, when the rules pass</option></Select></Field>
          <Field label="Notice needed" hint="Days before the first day off"><div className="flex items-center gap-2"><Input type="number" min={0} max={365} disabled={!canWrite} value={d.timeOffMinNoticeDays} onChange={(e) => set('timeOffMinNoticeDays', Number(e.target.value))} /><span className="text-[12px] text-[#6B6B6B]">days</span></div></Field>
          <Field label="Most people off at once" hint="Share of a WFM group; at least one person is always allowed"><div className="flex items-center gap-2"><Input type="number" min={0} max={100} disabled={!canWrite} value={d.timeOffMaxOffPercent} onChange={(e) => set('timeOffMaxOffPercent', Number(e.target.value))} /><span className="text-[12px] text-[#6B6B6B]">%</span></div></Field>
        </div>
        <div className="max-w-4xl border-t border-[#E5E5E0] pt-4">
          <div className="text-[12px] font-semibold mb-2">Days each person gets a year</div>
          <p className="text-[11px] text-[#6B6B6B] mb-3">Leave a box empty for a type with no balance. Requests over the balance go to a manager.</p>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            {TYPES.map((t) => <Field key={t.id} label={t.label}><Input type="number" min={0} max={366} placeholder="No balance" disabled={!canWrite} value={d.entitlements[t.id] ?? ''} onChange={(e) => setEnt(t.id, e.target.value)} /></Field>)}
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mt-4">
            <Field label="When the days become available" hint={d.accrualMode === 'MONTHLY' ? 'One twelfth builds up each month, so early in the year less can be booked' : 'The whole year is available from 1 January'}>
              <Select disabled={!canWrite} value={d.accrualMode ?? 'UPFRONT'} onChange={(e) => set('accrualMode', e.target.value as 'UPFRONT' | 'MONTHLY')}><option value="UPFRONT">All at the start of the year</option><option value="MONTHLY">Building up month by month</option></Select>
            </Field>
            <Field label="Unused days carried into next year" hint="Up to this many, per type. Leave empty for none">
              <div className="grid grid-cols-3 gap-2">{TYPES.filter((t) => d.entitlements[t.id] !== undefined).map((t) => (
                <label key={t.id} className="text-[11px] text-[#6B6B6B]">{t.label}<Input type="number" min={0} max={366} placeholder="0" disabled={!canWrite} value={d.carryOverDays?.[t.id] ?? ''} onChange={(e) => { const c = { ...(d.carryOverDays ?? {}) }; if (e.target.value === '') delete c[t.id]; else c[t.id] = Number(e.target.value); set('carryOverDays', c); }} /></label>
              ))}</div>
            </Field>
          </div>
        </div>
      </Card>

      <TimeOffRules />

      <Card title="Availability" sub="Hours a person prefers are always theirs to set. Hours they cannot work are limits the scheduler treats as strict, so by default only a manager sets them.">
        <div className="max-w-md"><Field label="Employees can set hours they cannot work"><Select disabled={!canWrite} value={yesNo(d.agentCanEditAvailability)} onChange={(e) => set('agentCanEditAvailability', e.target.value === 'y')}><option value="n">No, preferred hours only</option><option value="y">Yes</option></Select></Field></div>
      </Card>

      <Card title="Shift swaps and giveaways" sub="Every swap is tried on a copy of the published schedule first, using the same rules as the scheduler, including the labour-law pack. Nothing that breaks a blocking rule can be approved by anyone.">
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-4 max-w-5xl">
          <Field label="Approve automatically" hint="When the change is clean and keeps enough cover"><Select disabled={!canWrite} value={yesNo(d.swapAutoApprove)} onChange={(e) => set('swapAutoApprove', e.target.value === 'y')}><option value="n">No, a manager decides</option><option value="y">Yes, when the rules pass</option></Select></Field>
          <Field label="Cover a swap may give up" hint="Extra 15-minute intervals below the forecast that still count as automatic"><div className="flex items-center gap-2"><Input type="number" min={0} max={96} disabled={!canWrite} value={d.swapMaxExtraGapSlots} onChange={(e) => set('swapMaxExtraGapSlots', Number(e.target.value))} /><span className="text-[12px] text-[#6B6B6B]">intervals</span></div></Field>
          <Field label="Notice needed" hint="Hours before the earlier shift starts"><div className="flex items-center gap-2"><Input type="number" min={0} max={720} disabled={!canWrite} value={d.swapMinNoticeHours} onChange={(e) => set('swapMinNoticeHours', Number(e.target.value))} /><span className="text-[12px] text-[#6B6B6B]">hours</span></div></Field>
          <Field label="Board stays open" hint="How long an offered shift or proposal waits"><div className="flex items-center gap-2"><Input type="number" min={1} max={720} disabled={!canWrite} value={d.swapBoardHours} onChange={(e) => set('swapBoardHours', Number(e.target.value))} /><span className="text-[12px] text-[#6B6B6B]">hours</span></div></Field>
        </div>
      </Card>

      <Card title="Who approves first" sub="A team's supervisor, deputy, or whoever is covering for them decides that team's time off and shift changes before they go to a manager. A team with no supervisor goes straight to the managers.">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 max-w-4xl items-start">
          <Field label="Supervisor decides first" hint="Off: only managers and schedulers decide"><Select disabled={!canWrite} value={yesNo(d.supervisorFirst)} onChange={(e) => set('supervisorFirst', e.target.value === 'yes')}><option value="yes">Yes</option><option value="no">No</option></Select></Field>
          <Field label="Tell the managers after" hint="Hours a request waits for its supervisor before the managers are told"><div className="flex items-center gap-2"><Input type="number" min={1} max={720} disabled={!canWrite || !d.supervisorFirst} value={d.escalateHours} onChange={(e) => set('escalateHours', Number(e.target.value))} /><span className="text-[12px] text-[#6B6B6B]">hours</span></div></Field>
          <Field label="Supervisors see only their own teams" hint="Off: they can read everyone, but only decide their own team's requests"><Select disabled={!canWrite} value={yesNo(d.limitSupervisorsToTeams)} onChange={(e) => set('limitSupervisorsToTeams', e.target.value === 'yes')}><option value="yes">Yes</option><option value="no">No</option></Select></Field>
        </div>
        {d.limitSupervisorsToTeams && <p className="text-[12px] text-[#B7791F]">Before you switch this on, check every Supervisor is set as the supervisor or deputy of a team on the Teams screen. A Supervisor with no team would see nobody. The schedule and coverage views stay group-wide.</p>}
      </Card>

      {canWrite && <div><Btn variant="primary" onClick={save}>Save rules</Btn></div>}

      <OfferRules />
    </div>
  );
};
