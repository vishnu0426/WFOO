/** Your own details (read only), preferred availability you can edit, and your account: password and sign out. */
import React, { useState } from 'react';
import { api, ApiError } from '../api';
import { AvailabilityKind, AvailabilityWindow, Profile as ProfileDto } from '../types';
import { useLoad, Banner, Btn, Busy, Card, Field, Input, PasswordInput, Select } from '../ui';

const DOW = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const KINDS: AvailabilityKind[] = ['PREFERRED', 'AVAILABLE', 'UNAVAILABLE'];
// plain words for what the system calls these
const KIND_TEXT: Record<AvailabilityKind, string> = { PREFERRED: "I'd like to work", AVAILABLE: 'I can work', UNAVAILABLE: "I can't work" };
const nice = (t: string) => { const x = t.replace(/_/g, ' ').toLowerCase(); return x[0].toUpperCase() + x.slice(1); };
const initials = (n: string) => n.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join('');

const Detail: React.FC<{ label: string; children: React.ReactNode }> = ({ label, children }) => (
  <div className="flex items-baseline justify-between gap-4 py-2 border-b border-[#F0F0EC] last:border-b-0">
    <dt className="text-[12px] text-[#6B6B6B] shrink-0">{label}</dt>
    <dd className="text-[13px] text-[#171717] text-right min-w-0 break-words">{children}</dd>
  </div>
);
const Unset = () => <span className="text-[#A3A3A3]">Not set</span>;

const PasswordCard: React.FC<{ onSignOut: () => void }> = ({ onSignOut }) => {
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
    <Card title="Account" actions={!open && <Btn onClick={() => { setOpen(true); setOk(false); }}>Change password</Btn>}>
      {ok && !open && <Banner kind="ok" onClose={() => setOk(false)}>Password changed.</Banner>}
      {!open ? (
        <div className="text-[13px] text-[#6B6B6B]">Use a password you do not use anywhere else.</div>
      ) : (
        <form onSubmit={submit} className="space-y-3">
          {err && <Banner kind="err" onClose={() => setErr('')}>{err}</Banner>}
          <Field label="Current password"><PasswordInput value={current} onChange={(e) => setCurrent(e.target.value)} autoFocus autoComplete="current-password" /></Field>
          <Field label="New password" hint="At least 8 characters, mixing letters with numbers or symbols"><PasswordInput value={next} onChange={(e) => setNext(e.target.value)} autoComplete="new-password" /></Field>
          <Field label="Confirm new password"><PasswordInput value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="new-password" /></Field>
          <div className="flex gap-2">
            <Btn variant="primary" type="submit" disabled={busy || !current || next.length < 8 || !confirm}>{busy ? 'Saving…' : 'Save new password'}</Btn>
            <Btn type="button" onClick={reset}>Cancel</Btn>
          </div>
        </form>
      )}
      <div className="pt-1"><Btn onClick={onSignOut}>Sign out</Btn></div>
    </Card>
  );
};

export const Profile: React.FC<{ onSignOut: () => void }> = ({ onSignOut }) => {
  const profile = useLoad<ProfileDto>('/me/profile');
  const avail = useLoad<{ windows: AvailabilityWindow[]; canSetHardLimits: boolean }>('/me/availability');
  const [windows, setWindows] = useState<AvailabilityWindow[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [saved, setSaved] = useState(false);
  const current = windows ?? avail.data?.windows ?? [];
  const hard = !!avail.data?.canSetHardLimits;
  const startKind: AvailabilityKind = hard ? 'AVAILABLE' : 'PREFERRED';

  const change = (next: AvailabilityWindow[]) => { setWindows(next); setSaved(false); };
  const addWindow = () => change([...current, { dayOfWeek: 0, startTime: '09:00', endTime: '17:00', kind: startKind }]);
  const addWeekdays = () => change([...current, ...[0, 1, 2, 3, 4].map((d) => ({ dayOfWeek: d, startTime: '09:00', endTime: '17:00', kind: startKind }))]);
  const update = (i: number, patch: Partial<AvailabilityWindow>) => change(current.map((w, j) => (j === i ? { ...w, ...patch } : w)));
  const remove = (i: number) => change(current.filter((_, j) => j !== i));
  const bad = current.some((w) => w.endTime <= w.startTime && w.endTime !== '00:00');
  const save = async () => {
    setBusy(true); setErr('');
    try { await api('/me/availability', { method: 'PUT', body: { windows: current } }); setWindows(null); setSaved(true); avail.reload(); } catch (e: any) { setErr(e instanceof ApiError ? e.message : 'Could not save'); } finally { setBusy(false); }
  };

  if (profile.loading && !profile.data) return <Busy />;
  if (profile.error) return <Banner kind="err">{profile.error}</Banner>;
  const p = profile.data;
  if (!p) return null;

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,380px)_minmax(0,1fr)] items-start">
      <Card>
        <div className="flex items-center gap-3 pb-3 border-b border-[#F0F0EC]">
          <div className="w-12 h-12 rounded-full bg-accent text-white flex items-center justify-center text-[16px] font-bold shrink-0" aria-hidden>{initials(p.name)}</div>
          <div className="min-w-0">
            <div className="text-[16px] font-semibold text-[#171717] truncate">{p.name}</div>
            <div className="text-[12px] text-[#6B6B6B]">Employee {p.employeeNumber}</div>
          </div>
        </div>
        <dl>
          <Detail label="Team">{p.team ?? <Unset />}</Detail>
          <Detail label="Group">{p.group ?? <Unset />}</Detail>
          <Detail label="Email">{p.email ?? <Unset />}</Detail>
          <Detail label="Phone">{p.phone ?? <Unset />}</Detail>
          {p.extension && <Detail label="Extension">{p.extension}</Detail>}
          <Detail label="Contract">{nice(p.employmentType)} · {p.weeklyContractHours} hours a week</Detail>
          <Detail label="Time zone">{p.timezone}</Detail>
          <Detail label="Night shifts">{p.nightShiftConsent ? "You've agreed to work night shifts" : 'Not agreed'}</Detail>
        </dl>
        {p.skills.length > 0 && (
          <div>
            <div className="text-[12px] text-[#6B6B6B] mb-1.5">Skills</div>
            <div className="flex flex-wrap gap-1.5">
              {p.skills.map((s) => <span key={s.name} title={`Proficiency level ${s.proficiency}`} className="text-[11px] bg-[#F5F5F2] text-[#525252] border border-[#E5E5E0] rounded-full px-2 py-0.5">{s.name} · level {s.proficiency}</span>)}
            </div>
          </div>
        )}
        <div className="text-[11px] text-[#6B6B6B]">To change your name, contract or contact details, ask your manager.</div>
      </Card>

      <div className="space-y-4">
        <Card title="When I can work" sub={hard ? 'Your manager has asked you to set the times you can and cannot work.' : 'Tell your manager the times you would like to work. They are used as a guide when schedules are built; they are not a promise.'}
          actions={<div className="flex gap-1.5"><Btn onClick={addWeekdays}>Mon–Fri 9 to 5</Btn><Btn onClick={addWindow}>Add a time</Btn></div>}>
          {err && <Banner kind="err" onClose={() => setErr('')}>{err}</Banner>}
          {saved && windows === null && <Banner kind="ok" onClose={() => setSaved(false)}>Saved. Your manager can now see these times.</Banner>}
          {current.length === 0 ? (
            <div className="py-5 text-center space-y-2">
              <div className="text-[13px] text-[#171717] font-semibold">You have not set any times</div>
              <div className="text-[12px] text-[#6B6B6B]">Add the days and hours you would prefer, for example Monday to Friday 9 to 5.</div>
              <Btn variant="primary" onClick={addWeekdays}>Add Mon–Fri 9 to 5</Btn>
            </div>
          ) : (
            <div className="space-y-2">
              {current.map((w, i) => (
                <div key={i} className="flex flex-wrap items-end gap-2 border border-[#E5E5E0] rounded-md p-2.5">
                  <div className="w-24"><Field label="Day"><Select value={w.dayOfWeek} onChange={(e) => update(i, { dayOfWeek: Number(e.target.value) })}>{DOW.map((d, n) => <option key={d} value={n}>{d}</option>)}</Select></Field></div>
                  <div className="w-28"><Field label="From"><Input type="time" value={w.startTime} onChange={(e) => update(i, { startTime: e.target.value })} /></Field></div>
                  <div className="w-28"><Field label="To"><Input type="time" value={w.endTime} onChange={(e) => update(i, { endTime: e.target.value })} /></Field></div>
                  <div className="flex-1 min-w-[150px]"><Field label="This means"><Select value={w.kind} onChange={(e) => update(i, { kind: e.target.value as AvailabilityKind })}>
                    {KINDS.filter((k) => hard || k === 'PREFERRED' || k === w.kind).map((k) => <option key={k} value={k}>{KIND_TEXT[k]}</option>)}
                  </Select></Field></div>
                  <button onClick={() => remove(i)} aria-label="Remove this time" className="text-[12px] font-semibold text-[#BC3F3F] hover:underline pb-2">Remove</button>
                </div>
              ))}
              {bad && <div className="text-[12px] text-[#BC3F3F]">One of the times ends before it starts.</div>}
            </div>
          )}
          {windows !== null && (
            <div className="flex flex-wrap items-center gap-2 pt-1">
              <Btn variant="primary" disabled={busy || bad} onClick={save}>{busy ? 'Saving…' : 'Save changes'}</Btn>
              <Btn disabled={busy} onClick={() => { setWindows(null); setErr(''); }}>Discard</Btn>
              <span className="text-[12px] text-[#8F6200]">You have unsaved changes</span>
            </div>
          )}
        </Card>

        <PasswordCard onSignOut={onSignOut} />
      </div>
    </div>
  );
};
