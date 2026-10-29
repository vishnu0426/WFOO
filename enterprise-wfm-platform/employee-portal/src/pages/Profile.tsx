/** Your own profile, editable preferred availability, and sign out. */
import React, { useState } from 'react';
import { api, ApiError } from '../api';
import { AvailabilityKind, AvailabilityWindow, Profile as ProfileDto } from '../types';
import { useLoad, Banner, Btn, Busy, Card, Field, Input, Select } from '../ui';

const DOW = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const KINDS: AvailabilityKind[] = ['PREFERRED', 'AVAILABLE', 'UNAVAILABLE'];

const PasswordCard: React.FC = () => {
  const [open, setOpen] = useState(false);
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [ok, setOk] = useState(false);

  const reset = () => { setOpen(false); setCurrent(''); setNext(''); setConfirm(''); setErr(''); };
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (next !== confirm) { setErr('New passwords do not match.'); return; }
    setBusy(true); setErr('');
    try { await api('/me/change-password', { method: 'PUT', body: { currentPassword: current, newPassword: next } }); reset(); setOk(true); }
    catch (e: any) { setErr(e instanceof ApiError ? e.message : 'Could not change your password'); } finally { setBusy(false); }
  };

  return (
    <Card title="Password" actions={!open && <Btn onClick={() => { setOpen(true); setOk(false); }}>Change password</Btn>}>
      {ok && !open && <Banner kind="ok" onClose={() => setOk(false)}>Password changed.</Banner>}
      {!open ? (
        <div className="text-[13px] text-[#737373]">••••••••••</div>
      ) : (
        <form onSubmit={submit} className="space-y-3">
          {err && <Banner kind="err" onClose={() => setErr('')}>{err}</Banner>}
          <Field label="Current password"><Input type="password" value={current} onChange={(e) => setCurrent(e.target.value)} autoFocus /></Field>
          <Field label="New password" hint="At least 8 characters, mixing letters with numbers or symbols"><Input type="password" value={next} onChange={(e) => setNext(e.target.value)} /></Field>
          <Field label="Confirm new password"><Input type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} /></Field>
          <div className="flex gap-2">
            <Btn variant="primary" type="submit" disabled={busy || !current || next.length < 8 || !confirm}>{busy ? 'Saving…' : 'Save new password'}</Btn>
            <Btn type="button" onClick={reset}>Cancel</Btn>
          </div>
        </form>
      )}
    </Card>
  );
};

export const Profile: React.FC<{ onSignOut: () => void }> = ({ onSignOut }) => {
  const profile = useLoad<ProfileDto>('/me/profile');
  const avail = useLoad<{ windows: AvailabilityWindow[]; canSetHardLimits: boolean }>('/me/availability');
  const [windows, setWindows] = useState<AvailabilityWindow[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const current = windows ?? avail.data?.windows ?? [];

  const addWindow = () => setWindows([...current, { dayOfWeek: 0, startTime: '09:00', endTime: '17:00', kind: avail.data?.canSetHardLimits ? 'AVAILABLE' : 'PREFERRED' }]);
  const update = (i: number, patch: Partial<AvailabilityWindow>) => setWindows(current.map((w, j) => (j === i ? { ...w, ...patch } : w)));
  const remove = (i: number) => setWindows(current.filter((_, j) => j !== i));
  const save = async () => {
    setBusy(true); setErr('');
    try { await api('/me/availability', { method: 'PUT', body: { windows: current } }); setWindows(null); avail.reload(); } catch (e: any) { setErr(e instanceof ApiError ? e.message : 'Could not save'); } finally { setBusy(false); }
  };

  if (profile.loading && !profile.data) return <Busy />;
  if (profile.error) return <Banner kind="err">{profile.error}</Banner>;
  const p = profile.data;
  if (!p) return null;

  return (
    <div className="space-y-4">
      <Card>
        <div className="text-[16px] font-semibold text-[#171717]">{p.name}</div>
        <div className="text-[12px] text-[#737373]">{p.employeeNumber} · {p.team ?? 'No team'} · {p.group ?? 'No group'}{p.extension ? ` · Ext. ${p.extension}` : ''}</div>
        <div className="text-[12px] text-[#737373] mt-2">{p.employmentType.replace(/_/g, ' ').toLowerCase()} · {p.weeklyContractHours}h/week · {p.timezone}</div>
        {p.skills.length > 0 && (
          <div className="flex flex-wrap gap-1.5 mt-2">
            {p.skills.map((s) => <span key={s.name} className="text-[11px] bg-[#F5F5F2] text-[#525252] rounded px-1.5 py-0.5">{s.name} · L{s.proficiency}</span>)}
          </div>
        )}
      </Card>

      <Card title="Availability" sub={avail.data?.canSetHardLimits ? undefined : "You can only mark what you'd prefer; your manager sets any hard limits"} actions={<Btn onClick={addWindow}>Add</Btn>}>
        {err && <Banner kind="err" onClose={() => setErr('')}>{err}</Banner>}
        {current.length === 0 ? <div className="text-[13px] text-[#737373]">No windows set.</div> : (
          <div className="space-y-2">
            {current.map((w, i) => (
              <div key={i} className="grid grid-cols-[1fr_1fr_1fr_auto] gap-1.5 items-end">
                <Field label="Day"><Select value={w.dayOfWeek} onChange={(e) => update(i, { dayOfWeek: Number(e.target.value) })}>{DOW.map((d, n) => <option key={d} value={n}>{d}</option>)}</Select></Field>
                <Field label="Start"><Input type="time" value={w.startTime} onChange={(e) => update(i, { startTime: e.target.value })} /></Field>
                <Field label="End"><Input type="time" value={w.endTime} onChange={(e) => update(i, { endTime: e.target.value })} /></Field>
                <button onClick={() => remove(i)} className="text-[#C84A4A] text-[12px] pb-2">×</button>
                <div className="col-span-4 -mt-1"><Select value={w.kind} onChange={(e) => update(i, { kind: e.target.value as AvailabilityKind })}>{KINDS.map((k) => <option key={k} value={k}>{k}</option>)}</Select></div>
              </div>
            ))}
          </div>
        )}
        {windows !== null && <Btn variant="primary" disabled={busy} onClick={save}>{busy ? 'Saving…' : 'Save availability'}</Btn>}
      </Card>

      <PasswordCard />

      <Btn onClick={onSignOut} className="w-full">Sign out</Btn>
    </div>
  );
};
