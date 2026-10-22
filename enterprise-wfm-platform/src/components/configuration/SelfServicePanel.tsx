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
        <Field label="Offer stays open" hint="Never longer than until the window starts"><div className="flex items-center gap-2"><Input type="number" min={5} max={10080} disabled={!canWrite} value={d.offerMinutes} onChange={(e) => set('offerMinutes', Number(e.target.value))} /><span className="text-[12px] text-[#737373]">minutes</span></div></Field>
        <Field label="Ask in waves of" hint="0 asks everyone at once. Otherwise the next people are asked when a wave has all answered or the time below passes"><div className="flex items-center gap-2"><Input type="number" min={0} max={500} disabled={!canWrite} value={d.waveSize} onChange={(e) => set('waveSize', Number(e.target.value))} /><span className="text-[12px] text-[#737373]">people</span></div></Field>
        <Field label="Wait between waves"><div className="flex items-center gap-2"><Input type="number" min={1} max={1440} disabled={!canWrite} value={d.waveMinutes} onChange={(e) => set('waveMinutes', Number(e.target.value))} /><span className="text-[12px] text-[#737373]">minutes</span></div></Field>
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
          <Field label="Notice needed" hint="Days before the first day off"><div className="flex items-center gap-2"><Input type="number" min={0} max={365} disabled={!canWrite} value={d.timeOffMinNoticeDays} onChange={(e) => set('timeOffMinNoticeDays', Number(e.target.value))} /><span className="text-[12px] text-[#737373]">days</span></div></Field>
          <Field label="Most people off at once" hint="Share of a WFM group; at least one person is always allowed"><div className="flex items-center gap-2"><Input type="number" min={0} max={100} disabled={!canWrite} value={d.timeOffMaxOffPercent} onChange={(e) => set('timeOffMaxOffPercent', Number(e.target.value))} /><span className="text-[12px] text-[#737373]">%</span></div></Field>
        </div>
        <div className="max-w-4xl border-t border-[#E5E5E0] pt-4">
          <div className="text-[12px] font-semibold mb-2">Days each person gets a year</div>
          <p className="text-[11px] text-[#737373] mb-3">Leave a box empty for a type with no balance. Requests over the balance go to a manager.</p>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            {TYPES.map((t) => <Field key={t.id} label={t.label}><Input type="number" min={0} max={366} placeholder="No balance" disabled={!canWrite} value={d.entitlements[t.id] ?? ''} onChange={(e) => setEnt(t.id, e.target.value)} /></Field>)}
          </div>
        </div>
      </Card>

      <Card title="Availability" sub="Hours a person prefers are always theirs to set. Hours they cannot work are limits the scheduler treats as strict, so by default only a manager sets them.">
        <div className="max-w-md"><Field label="Employees can set hours they cannot work"><Select disabled={!canWrite} value={yesNo(d.agentCanEditAvailability)} onChange={(e) => set('agentCanEditAvailability', e.target.value === 'y')}><option value="n">No, preferred hours only</option><option value="y">Yes</option></Select></Field></div>
      </Card>

      <Card title="Shift swaps and giveaways" sub="Every swap is tried on a copy of the published schedule first, using the same rules as the scheduler, including the labour-law pack. Nothing that breaks a blocking rule can be approved by anyone.">
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-4 max-w-5xl">
          <Field label="Approve automatically" hint="When the change is clean and keeps enough cover"><Select disabled={!canWrite} value={yesNo(d.swapAutoApprove)} onChange={(e) => set('swapAutoApprove', e.target.value === 'y')}><option value="n">No, a manager decides</option><option value="y">Yes, when the rules pass</option></Select></Field>
          <Field label="Cover a swap may give up" hint="Extra 15-minute intervals below the forecast that still count as automatic"><div className="flex items-center gap-2"><Input type="number" min={0} max={96} disabled={!canWrite} value={d.swapMaxExtraGapSlots} onChange={(e) => set('swapMaxExtraGapSlots', Number(e.target.value))} /><span className="text-[12px] text-[#737373]">intervals</span></div></Field>
          <Field label="Notice needed" hint="Hours before the earlier shift starts"><div className="flex items-center gap-2"><Input type="number" min={0} max={720} disabled={!canWrite} value={d.swapMinNoticeHours} onChange={(e) => set('swapMinNoticeHours', Number(e.target.value))} /><span className="text-[12px] text-[#737373]">hours</span></div></Field>
          <Field label="Board stays open" hint="How long an offered shift or proposal waits"><div className="flex items-center gap-2"><Input type="number" min={1} max={720} disabled={!canWrite} value={d.swapBoardHours} onChange={(e) => set('swapBoardHours', Number(e.target.value))} /><span className="text-[12px] text-[#737373]">hours</span></div></Field>
        </div>
      </Card>

      {canWrite && <div><Btn variant="primary" onClick={save}>Save rules</Btn></div>}

      <OfferRules />
    </div>
  );
};
