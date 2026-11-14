/**
 * Workforce > Time & Attendance. Punches (clock in/out) from a time-clock export, independent of RTA agent-state (which tracks live ACD activity, not physical presence), compared with the
 * published schedule and rolled into a payroll export.
 *
 * The week is one row per person with their seven days across, a page of people at a time (those with the most problems first). Chips along the top count person-days by kind of problem
 * (missed punch, late, early leave, still clocked in, not scheduled, not due yet, OK) and filter the list. A person opens in a side panel; adding a punch is a side panel too.
 */
import { Waiting, LoadFailed } from '../common/loading';
import { PersonPicker } from '../common/PersonPicker';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ColDef } from 'ag-grid-community';
import { Download, Plus, Trash2, Upload, X } from 'lucide-react';
import { AttendanceDay, AttendanceIssue, AttendancePerson, AttendanceReason, AttendanceWeekView, api, download, dayYear, dec, ImportResult } from '../../services/api';
import { weekFloor } from '../../services/api';
import { usePayWeek, useApi } from '../forecasting/hooks';
import { useForecast } from '../../services/forecastStore';
import { Grid } from '../forecasting/Grid';
import { Banner, Btn, Busy, Card, Empty, Field, Input, Pill, Select } from '../forecasting/ui';
import { Confirm } from '../configuration/groups/shared';

const plus = (s: string, n: number) => { const d = new Date(s + 'T00:00:00'); d.setDate(d.getDate() + n); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const dayHead = (d: string) => new Date(d + 'T00:00:00').toLocaleDateString('en', { weekday: 'short', day: 'numeric' });
const mins = (m: number) => (m >= 60 ? `${Math.floor(m / 60)}h${m % 60 ? ` ${m % 60}m` : ''}` : `${m}m`);
const clock = (stamp: string) => stamp.slice(11, 16);

const CHIPS: { id: AttendanceIssue | 'all'; label: string; tone: 'bad' | 'warn' | 'plain' }[] = [
  { id: 'all', label: 'All days', tone: 'plain' }, { id: 'missed', label: 'Missed punch', tone: 'bad' }, { id: 'late', label: 'Late', tone: 'warn' }, { id: 'early', label: 'Early leave', tone: 'warn' },
  { id: 'open', label: 'Still clocked in', tone: 'plain' }, { id: 'unscheduled', label: 'Not scheduled', tone: 'warn' }, { id: 'upcoming', label: 'Not due yet', tone: 'plain' }, { id: 'excused', label: 'Excused', tone: 'plain' }, { id: 'ok', label: 'OK', tone: 'plain' },
];
const TONE_TEXT = { bad: 'text-[#BC3F3F]', warn: 'text-[#8F6200]', good: 'text-[#2A7553]', plain: 'text-[#525252]' } as const;

/** What one day says in a table cell: words as well as colour, and the red of a missed punch muted when the time-clock file is probably just missing. */
export function dayCell(d: AttendanceDay | undefined, feedMissing: boolean): { text: string; tone: keyof typeof TONE_TEXT } {
  if (!d) return { text: '–', tone: 'plain' };
  const i = d.issues;
  if (i.includes('missed')) return { text: feedMissing ? 'No punch' : 'Missed', tone: feedMissing ? 'plain' : 'bad' };
  if (i.includes('late')) return { text: `Late ${mins(d.lateMinutes)}`, tone: 'warn' };
  if (i.includes('early')) return { text: `Early ${mins(d.earlyLeaveMinutes)}`, tone: 'warn' };
  if (i.includes('open')) return { text: 'Clocked in', tone: 'plain' };
  if (i.includes('unscheduled')) return { text: `Extra ${dec(d.actualHours, 1)}`, tone: 'warn' };
  if (i.includes('upcoming')) return { text: 'Not due', tone: 'plain' };
  if (i.includes('excused')) return { text: 'Excused', tone: 'plain' };
  return { text: `OK ${dec(d.actualHours, 1)}`, tone: 'good' };
}

const issueWords = (d: AttendanceDay, feedMissing: boolean) => d.issues.map((i) => ({
  missed: feedMissing ? 'No punch' : 'Missed punch', late: `Late by ${mins(d.lateMinutes)}`, early: `Left ${mins(d.earlyLeaveMinutes)} early`, open: 'Still clocked in', unscheduled: 'Not scheduled', upcoming: 'Not due yet', excused: 'Excused', ok: 'On time',
}[i]));

// ---------------------------------------------------------------- side panels

const SidePanel: React.FC<{ label: string; onClose: () => void; children: React.ReactNode }> = ({ label, onClose, children }) => {
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => { closeRef.current?.focus(); }, []);
  useEffect(() => { const k = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); }; window.addEventListener('keydown', k); return () => window.removeEventListener('keydown', k); }, [onClose]);
  // the overlay is the dialog: the app's Escape handler leaves role=dialog layers to themselves
  return (
    <div role="dialog" aria-modal="true" aria-label={label} className="fixed inset-0 z-40 bg-black/20 flex justify-end" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <aside className="w-full max-w-lg bg-white border-l border-[#E5E5E0] shadow-xl h-full overflow-y-auto p-5 space-y-4 select-text">
        <div className="flex items-start justify-between gap-3"><h2 className="text-[16px] font-semibold text-[#171717]">{label}</h2><button ref={closeRef} aria-label="Close" onClick={onClose} className="p-1 rounded hover:bg-[#FAFAF8]"><X className="w-4 h-4" /></button></div>
        {children}
      </aside>
    </div>
  );
};

interface PunchForm { employeeId: string; day: string; clockIn: string; clockOut: string; note: string }

const AddPunch: React.FC<{ initial: PunchForm; lockedPerson?: string; onClose: () => void; onSaved: (text: string) => void }> = ({ initial, lockedPerson, onClose, onSaved }) => {
  const [f, setF] = useState(initial);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true); setError('');
    try {
      // a clock-out earlier than the clock-in is the next morning (an overnight shift), the same as when a file is imported
      const outDay = f.clockOut && f.clockOut <= f.clockIn ? plus(f.day, 1) : f.day;
      await api('/attendance/punches', { method: 'POST', body: { employeeId: f.employeeId, day: f.day, clockIn: `${f.day}T${f.clockIn}:00Z`, clockOut: f.clockOut ? `${outDay}T${f.clockOut}:00Z` : null, note: f.note } });
      onSaved('Punch added.');
    } catch (e: any) { setError(e.message); } finally { setBusy(false); }
  };
  return (
    <SidePanel label="Add a punch" onClose={onClose}>
      <p className="text-[12px] text-[#6B6B6B]">For when someone forgot to badge in or out. Leave the clock-out empty if they are still working.</p>
      <div className="space-y-3">
        <Field label="Person"><PersonPicker ariaLabel="Person" value={f.employeeId} status="ACTIVE" placeholder="Choose: type a name or number" onChange={(id) => setF({ ...f, employeeId: id })} className={lockedPerson ? 'pointer-events-none opacity-70' : ''} /></Field>
        <Field label="Day"><Input type="date" value={f.day} onChange={(e) => setF({ ...f, day: e.target.value })} /></Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Clock in"><Input type="time" step={60} value={f.clockIn} onChange={(e) => setF({ ...f, clockIn: e.target.value })} /></Field>
          <Field label="Clock out"><Input type="time" step={60} value={f.clockOut} onChange={(e) => setF({ ...f, clockOut: e.target.value })} /></Field>
        </div>
        <Field label="Note (optional)"><Input value={f.note} maxLength={200} onChange={(e) => setF({ ...f, note: e.target.value })} /></Field>
      </div>
      {error && <Banner kind="err">{error}</Banner>}
      <div className="flex gap-2"><Btn variant="primary" disabled={busy || !f.employeeId || !f.day || !f.clockIn} onClick={() => void save()}>Save punch</Btn><Btn onClick={onClose}>Cancel</Btn></div>
    </SidePanel>
  );
};

const PersonPanel: React.FC<{ person: AttendancePerson; feedMissing: boolean; canWrite: boolean; canExcuse: boolean; onClose: () => void; onAdd: (day: string) => void; onRemove: (punchId: string) => void; onExcuse: (d: AttendanceDay) => void; onUndo: (id: string) => void }> = ({ person, feedMissing, canWrite, canExcuse, onClose, onAdd, onRemove, onExcuse, onUndo }) => (
  <SidePanel label={`${person.name}: this week`} onClose={onClose}>
    <p className="text-[12px] text-[#6B6B6B] -mt-2">{person.employeeNumber} · scheduled {dec(person.scheduledHours, 1)} h · worked {dec(person.actualHours, 1)} h{person.overtimeHours > 0 ? ` · overtime ${dec(person.overtimeHours, 1)} h` : ''}</p>
    <ul className="divide-y divide-[#E5E5E0] border border-[#E5E5E0] rounded-lg">
      {person.days.map((d) => (
        <li key={d.day} className="p-3 space-y-1.5">
          <div className="flex flex-wrap items-center gap-2 text-[13px]">
            <span className="font-semibold">{dayYear(d.day)}</span>
            <span className="text-[#6B6B6B]">{d.shift ? `scheduled ${d.shift} (${dec(d.scheduledHours, 1)} h)` : 'not scheduled'}</span>
            {issueWords(d, feedMissing).map((w, i) => <Pill key={i} tone={w === 'On time' ? 'good' : /Missed/.test(w) ? 'bad' : /^(Late|Left|Not scheduled)/.test(w) ? 'warn' : 'neutral'}>{w}</Pill>)}
          </div>
          <div className="flex flex-wrap items-center gap-2 text-[12px]">
            {d.punches.length === 0 && <span className="text-[#6B6B6B]">No punches</span>}
            {d.punches.map((x) => (
              <span key={x.id} className="font-mono bg-[#FAFAF8] border border-[#E5E5E0] rounded px-1.5 py-0.5 flex items-center gap-1">
                {clock(x.clockIn)}–{x.clockOut ? clock(x.clockOut) : 'open'}{x.source === 'MANUAL' && <span className="font-sans text-[#6B6B6B]">by hand</span>}
                {canWrite && <button aria-label={`Remove punch ${clock(x.clockIn)} on ${d.day}`} onClick={() => onRemove(x.id)} className="text-[#6B6B6B] hover:text-[#BC3F3F]"><Trash2 className="w-3 h-3" /></button>}
              </span>))}
            {canWrite && <button className="underline text-[#525252]" onClick={() => onAdd(d.day)}>Add a punch</button>}
          </div>
          {d.excused.map((x) => (
            <div key={x.id} className="text-[12px] text-[#525252] flex flex-wrap items-center gap-2">
              <Pill>Excused: {KIND_LABEL[x.kind]}</Pill>
              <span>{REASON_LABEL[x.reasonCode]}{x.note ? `: ${x.note}` : ''} · {x.by}{x.level === 'SUPERVISOR' ? ' (supervisor)' : ''}{x.paid ? ' · paid' : ''}</span>
              {canExcuse && <button className="underline" aria-label={`Undo excuse for ${KIND_LABEL[x.kind].toLowerCase()} on ${d.day}`} onClick={() => onUndo(x.id)}>Undo</button>}
            </div>))}
          {canExcuse && d.issues.some((i) => (EXCUSABLE_KINDS as string[]).includes(i)) && <button className="text-[12px] underline text-[#525252]" onClick={() => onExcuse(d)}>Excuse…</button>}
        </li>))}
    </ul>
  </SidePanel>
);

// ---------------------------------------------------------------- excusing

const REASON_LABEL: Record<AttendanceReason, string> = {
  APPROVED_ABSENCE: 'Approved absence not entered', CLOCK_FAULT: 'Clock or badge fault', SYSTEM_OUTAGE: 'System outage', WORKED_ELSEWHERE: 'Worked at another site', MANAGER_OVERRIDE: 'Manager decision', OTHER: 'Other (say what happened)',
};
const KIND_LABEL = { missed: 'Missed punch', late: 'Late', early: 'Early leave', open: 'Still clocked in' } as const;
type ExcusableKind = keyof typeof KIND_LABEL;
const EXCUSABLE_KINDS: ExcusableKind[] = ['missed', 'late', 'early', 'open'];

/** The reason, an optional note, and whether the scheduled hours are paid for an excused missed day. `kinds` lets the person choose which of a day's problems to excuse. */
const ExcuseDialog: React.FC<{ title: string; intro: React.ReactNode; kinds?: ExcusableKind[]; offerPaid: boolean; busy: boolean; error: string; onCancel: () => void; onSubmit: (v: { kinds: ExcusableKind[]; reasonCode: AttendanceReason; note: string; paid: boolean }) => void }> = ({ title, intro, kinds, offerPaid, busy, error, onCancel, onSubmit }) => {
  const [chosen, setChosen] = useState<ExcusableKind[]>(kinds ?? []);
  const [reasonCode, setReason] = useState<AttendanceReason>('CLOCK_FAULT');
  const [note, setNote] = useState('');
  const [paid, setPaid] = useState(false);
  useEffect(() => { const k = (e: KeyboardEvent) => e.key === 'Escape' && onCancel(); window.addEventListener('keydown', k); return () => window.removeEventListener('keydown', k); }, [onCancel]);
  const noteNeeded = reasonCode === 'OTHER' && note.trim().length < 3;
  const blocked = busy || noteNeeded || (!!kinds && chosen.length === 0);
  return (
    <div role="dialog" aria-modal="true" aria-label={title} className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4" onMouseDown={(e) => e.target === e.currentTarget && onCancel()}>
      <div className="w-full max-w-md rounded-lg border border-[#E5E5E0] bg-white p-5 shadow-lg space-y-3 select-text">
        <h3 className="text-[15px] font-semibold text-[#171717]">{title}</h3>
        <div className="text-[13px] text-[#525252]">{intro}</div>
        {kinds && kinds.length > 1 && (
          <fieldset className="space-y-1"><legend className="text-[12px] font-semibold text-[#6B6B6B]">Excuse</legend>
            {kinds.map((k) => <label key={k} className="flex items-center gap-2 text-[13px]"><input type="checkbox" checked={chosen.includes(k)} onChange={(e) => setChosen(e.target.checked ? [...chosen, k] : chosen.filter((x) => x !== k))} />{KIND_LABEL[k]}</label>)}
          </fieldset>)}
        <Field label="Reason"><Select value={reasonCode} onChange={(e) => setReason(e.target.value as AttendanceReason)}>{(Object.keys(REASON_LABEL) as AttendanceReason[]).map((r) => <option key={r} value={r}>{REASON_LABEL[r]}</option>)}</Select></Field>
        <Field key={reasonCode === 'OTHER' ? 'what' : 'note'} label={reasonCode === 'OTHER' ? 'What happened' : 'Note (optional)'}><Input value={note} maxLength={300} onChange={(e) => setNote(e.target.value)} /></Field>
        {offerPaid && (!kinds || chosen.includes('missed')) && (
          <label className="flex items-start gap-2 text-[13px]"><input className="mt-0.5" type="checkbox" checked={paid} onChange={(e) => setPaid(e.target.checked)} /><span>Pay the scheduled hours for an excused missed day<span className="block text-[11px] text-[#6B6B6B]">Applies to the payroll export on this screen. Left unticked, the day is excused but not paid.</span></span></label>)}
        {error && <Banner kind="err">{error}</Banner>}
        <div className="flex justify-end gap-2 pt-1"><Btn onClick={onCancel}>Cancel</Btn><Btn variant="primary" disabled={blocked} onClick={() => onSubmit({ kinds: chosen, reasonCode, note: note.trim(), paid: paid && chosen.includes('missed') || (!kinds && paid) })}>Excuse</Btn></div>
      </div>
    </div>
  );
};

// ---------------------------------------------------------------- the page

export const AttendancePanel: React.FC = () => {
  const { can, setNotice, group } = useForecast();
  const canWrite = can('workforce:write');
  const weekStart = usePayWeek(group?.id);                 // the week is the group's pay week, not always Monday to Sunday
  const [picked, setPicked] = useState<string | null>(null);
  const from = weekFloor(picked ?? new Date(), weekStart);
  const to = plus(from, 6);
  const [tick, setTick] = useState(0);
  const [issue, setIssue] = useState<AttendanceIssue | 'all'>('all');
  const [search, setSearch] = useState(''), [q, setQ] = useState('');
  const [size, setSize] = useState(50), [offset, setOffset] = useState(0);
  useEffect(() => { const t = setTimeout(() => { setQ(search.trim()); setOffset(0); }, 300); return () => clearTimeout(t); }, [search]);
  useEffect(() => { setOffset(0); }, [issue, from, group?.id, size]);
  // a page of people, not every person-day of the company (24 MB at 50,000 people)
  const path = `/attendance/week?from=${from}&to=${to}${group ? `&groupId=${group.id}` : ''}${issue !== 'all' ? `&issue=${issue}` : ''}${q ? `&q=${encodeURIComponent(q)}` : ''}&limit=${size}&offset=${offset}`;
  const wk = useApi<AttendanceWeekView>(path, [tick, group?.id]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [csv, setCsv] = useState('');
  const [preview, setPreview] = useState<ImportResult | null>(null);
  const file = useRef<HTMLInputElement>(null);
  const [adding, setAdding] = useState<PunchForm | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [snapshot, setSnapshot] = useState<AttendancePerson | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  const reload = () => setTick((t) => t + 1);
  const canExcuse = can('workforce:write') || can('requests:approve');
  const [excusing, setExcusing] = useState<null | { day: AttendanceDay; kinds: ExcusableKind[] } | { issue: ExcusableKind }>(null);
  const [exBusy, setExBusy] = useState(false), [exError, setExError] = useState('');
  const submitExcuse = async (v: { kinds: ExcusableKind[]; reasonCode: AttendanceReason; note: string; paid: boolean }) => {
    if (!excusing) return;
    setExBusy(true); setExError('');
    try {
      if ('day' in excusing) {
        await api('/attendance/exceptions', { method: 'POST', body: { items: v.kinds.map((kind) => ({ employeeId: excusing.day.employeeId, day: excusing.day.day, kind })), reasonCode: v.reasonCode, note: v.note, paid: v.paid } });
        setNotice({ kind: 'ok', text: 'Excused.' });
      } else {
        const r = await api<{ matched: number; excused: number }>('/attendance/exceptions/by-filter', { method: 'POST', body: { groupId: group?.id, from, to, issue: excusing.issue, q: q || undefined, reasonCode: v.reasonCode, note: v.note, paid: v.paid } });
        setNotice({ kind: 'ok', text: `Excused ${r.excused} ${KIND_LABEL[excusing.issue].toLowerCase()} day${r.excused === 1 ? '' : 's'}.` });
      }
      setExcusing(null); reload();
    } catch (e: any) { setExError(e.message); } finally { setExBusy(false); }
  };
  const undoExcuse = async (id: string) => {
    try { await api(`/attendance/exceptions/${id}`, { method: 'DELETE' }); setNotice({ kind: 'ok', text: 'Excuse removed.' }); reload(); }
    catch (e: any) { setNotice({ kind: 'err', text: e.message }); }
  };

  const data = wk.data, feedMissing = !!data?.feedMissing;
  const person = openId ? data?.people.find((p) => p.employeeId === openId) ?? (snapshot?.employeeId === openId ? snapshot : null) : null;
  const dayList = useMemo(() => Array.from({ length: 7 }, (_, i) => plus(from, i)), [from]);

  const check = async (f: File) => {
    setBusy(true); setError(''); setPreview(null);
    try { const text = await f.text(); setCsv(text); setPreview(await api<ImportResult>('/attendance/import', { method: 'POST', body: { csv: text, dryRun: true } })); }
    catch (e: any) { setError(e.message); } finally { setBusy(false); if (file.current) file.current.value = ''; }
  };
  const commit = async () => {
    setBusy(true); setError('');
    try {
      const r = await api<ImportResult>('/attendance/import', { method: 'POST', body: { csv, dryRun: false } });
      setNotice({ kind: 'ok', text: `Imported ${r.newPunches} new punch${r.newPunches === 1 ? '' : 'es'}${r.alreadyImported ? `, ${r.alreadyImported} already there` : ''}.` });
      setPreview(null); setCsv(''); reload();
    } catch (e: any) { setError(e.message); } finally { setBusy(false); }
  };
  const removePunch = async () => {
    if (!removing) return; setBusy(true);
    try { await api(`/attendance/punches/${removing}`, { method: 'DELETE' }); setRemoving(null); setNotice({ kind: 'ok', text: 'Punch removed.' }); reload(); }
    catch (e: any) { setNotice({ kind: 'err', text: e.message }); setRemoving(null); } finally { setBusy(false); }
  };
  const open = (p: AttendancePerson) => { setSnapshot(p); setOpenId(p.employeeId); };

  const cols = useMemo<ColDef<AttendancePerson>[]>(() => [
    { headerName: 'Person', minWidth: 150, flex: 1, sortable: false, cellRenderer: (p: any) => (
      <span className="block leading-tight"><button className="text-left underline font-medium" aria-label={`${p.data.name}, open this week`} onClick={() => open(p.data)}>{p.data.name}</button><span className="block text-[11px] text-[#6B6B6B]">{p.data.employeeNumber}</span></span>) },
    ...dayList.map<ColDef<AttendancePerson>>((d) => ({
      headerName: dayHead(d), width: 88, sortable: false, cellStyle: { paddingLeft: 6, paddingRight: 6 },
      cellRenderer: (p: any) => {
        const day: AttendanceDay | undefined = p.data.days.find((x: AttendanceDay) => x.day === d), c = dayCell(day, feedMissing), hit = issue !== 'all' && day?.issues.includes(issue);
        return <span className={`text-[12px] ${TONE_TEXT[c.tone]} ${hit ? 'font-bold underline decoration-2' : ''}`}>{c.text}</span>;
      },
    })),
    { headerName: 'Scheduled', field: 'scheduledHours', type: 'rightAligned', width: 94, valueFormatter: (p) => dec(p.value, 1) },
    { headerName: 'Worked', field: 'actualHours', type: 'rightAligned', width: 74, valueFormatter: (p) => dec(p.value, 1) },
    { headerName: 'Variance', headerTooltip: 'Worked minus scheduled, over the days that are already over', field: 'varianceHours', type: 'rightAligned', width: 78, valueFormatter: (p) => `${p.value > 0 ? '+' : ''}${dec(p.value, 1)}`, cellStyle: (p) => (!feedMissing && Math.abs(p.value) > 0.5 ? { color: p.value < 0 ? '#BC3F3F' : '#8F6200', fontWeight: 600 } : null) },
    { headerName: 'Overtime', field: 'overtimeHours', type: 'rightAligned', width: 82, valueFormatter: (p) => (p.value > 0 ? dec(p.value, 1) : '–') },
  // eslint-disable-next-line react-hooks/exhaustive-deps
  ], [dayList, feedMissing, issue]);

  const counts = data?.counts;
  const total = data?.total ?? 0;
  const lastShown = Math.min(offset + size, total);

  return (
    <div className="space-y-6">
      <Card title="Time & attendance" sub="Punches compared against the published schedule. Independent of RTA state, which tracks live ACD activity, not physical presence."
        actions={<div className="flex flex-wrap items-center gap-2">
          <Field label="Week"><Input type="date" value={from} onChange={(e) => e.target.value && setPicked(e.target.value)} /></Field>
          {canWrite && <Btn variant="primary" onClick={() => setAdding({ employeeId: '', day: from, clockIn: '09:00', clockOut: '17:00', note: '' })}><Plus className="w-3.5 h-3.5" />Add a punch</Btn>}
          {canWrite && <>
            <input ref={file} type="file" accept=".csv,text/csv" className="hidden" aria-label="Choose a punch file" onChange={(e) => { const f = e.target.files?.[0]; if (f) check(f); }} />
            <Btn onClick={() => download('/attendance/template.csv', 'attendance-template.csv').catch((e) => setError(e.message))}><Download className="w-3.5 h-3.5" />CSV template</Btn>
            <Btn onClick={() => file.current?.click()}><Upload className="w-3.5 h-3.5" />Import punches</Btn>
          </>}
          <Btn onClick={() => download(`/attendance/payroll-export.csv?from=${from}&to=${to}`, `payroll-${from}-to-${to}.csv`).catch((e) => setError(e.message))}><Download className="w-3.5 h-3.5" />Payroll export</Btn>
        </div>}>
        {error && <Banner kind="err" onClose={() => setError('')}>{error}</Banner>}
        {busy && <Busy />}

        {preview && (
          <div className="border border-[#E5E5E0] rounded-lg p-4 bg-[#FAFAF8] space-y-3">
            <div className="flex flex-wrap items-center gap-4 text-[13px]">
              <b>Check before importing</b>
              <span className="text-[#2A7553] font-semibold">{preview.newPunches} new</span>
              <span className="text-[#6B6B6B]">{preview.alreadyImported} already imported</span>
              <span className={preview.errorCount ? 'text-[#BC3F3F] font-semibold' : 'text-[#6B6B6B]'}>{preview.errorCount} problems</span>
            </div>
            {preview.errors.length > 0 && (
              <div className="text-[12px] space-y-1">{preview.errors.slice(0, 15).map((e, i) => <div key={i}><span className="font-mono text-[#6B6B6B]">line {e.line}:</span> {e.message}</div>)}</div>
            )}
            <p className="text-[11px] text-[#6B6B6B]">Columns: employee_number, day, clock_in (required); clock_out. A clock-out earlier than clock-in is read as the next day (an overnight shift).</p>
            <div className="flex gap-2"><Btn variant="primary" disabled={busy || !preview.newPunches} onClick={commit}>Import {preview.newPunches} punch{preview.newPunches === 1 ? '' : 'es'}</Btn><Btn onClick={() => setPreview(null)}>Cancel</Btn></div>
          </div>
        )}

        {feedMissing && counts && (
          <Banner kind="info"><span className="font-semibold">Almost no punches for this week.</span> {counts.missed} of {counts.dueScheduled} scheduled days that are over have no punch, which usually means the time-clock file has not been imported yet, so they are not shown in red. {canWrite ? 'Use Import punches to load it.' : 'Ask someone who can import punches to load it.'}</Banner>)}

        {counts && (
          <div role="group" aria-label="Filter by what happened" className="flex flex-wrap items-center gap-2">
            {CHIPS.map((c) => {
              const n = c.id === 'all' ? counts.total : counts[c.id], on = issue === c.id, hot = n > 0 && !on && !(c.id === 'missed' && feedMissing);
              return (
                <button key={c.id} aria-pressed={on} onClick={() => setIssue(on ? 'all' : c.id)}
                  className={`px-3 py-1.5 rounded-full border text-[12px] font-semibold flex items-center gap-1.5 transition-colors ${on ? 'bg-[#171717] text-white border-[#171717]' : 'bg-white border-[#E5E5E0] hover:bg-[#FAFAF8]'} ${hot && c.tone !== 'plain' ? TONE_TEXT[c.tone] : on ? '' : 'text-[#525252]'}`}>
                  {c.label}<span className={`font-mono ${on ? '' : n === 0 ? 'text-[#6B6B6B] font-normal' : ''}`}>{n}</span>
                </button>);
            })}
            {canExcuse && (EXCUSABLE_KINDS as string[]).includes(issue) && counts[issue] > 0 && (
              <Btn onClick={() => { setExError(''); setExcusing({ issue: issue as ExcusableKind }); }}>Excuse all {counts[issue]} {KIND_LABEL[issue as ExcusableKind].toLowerCase()}…</Btn>)}
            <label className="ml-auto flex items-center gap-2 text-[12px] text-[#525252] whitespace-nowrap">
              <span>Search people</span>
              <Input className="w-56" value={search} placeholder="Name or number" onChange={(e) => setSearch(e.target.value)} />
            </label>
          </div>)}

        {wk.loading && !data ? <Waiting what="attendance" shape="table" reload={wk.reload} /> : wk.error && !data ? <LoadFailed what="attendance" error={wk.error} reload={wk.reload} /> : !data || data.counts.total === 0 ? (
          <Empty title={q ? 'Nobody matches that search' : 'Nothing scheduled or punched this week'}>{q ? 'Try a different name or number.' : 'Publish a schedule for these days, import a time-clock export, or add a punch.'}</Empty>
        ) : total === 0 ? (
          <Empty title="Nobody has that this week">{CHIPS.find((c) => c.id === issue)?.label}: nothing to show. Choose another chip or clear the filter.</Empty>
        ) : (
          <>
            <Grid<AttendancePerson> rowData={data.people} columnDefs={cols} defaultColDef={{ resizable: true }} loading={wk.loading} rowHeight={44} getRowId={(p) => p.data.employeeId} height={Math.min(620, 54 + data.people.length * 44)} />
            <div className="flex flex-wrap items-center justify-between gap-3 text-[12px] text-[#525252]">
              <span role="status">Showing {offset + 1}–{lastShown} of {total} {total === 1 ? 'person' : 'people'}{issue !== 'all' ? ` with ${CHIPS.find((c) => c.id === issue)!.label.toLowerCase()}` : ''}</span>
              <span className="flex items-center gap-2">
                <label className="flex items-center gap-1.5 whitespace-nowrap">Per page<Select value={size} onChange={(e) => setSize(Number(e.target.value))}>{[25, 50, 100, 200].map((n) => <option key={n} value={n}>{n}</option>)}</Select></label>
                <Btn disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - size))}>Previous</Btn>
                <Btn disabled={offset + size >= total} onClick={() => setOffset(offset + size)}>Next</Btn>
              </span>
            </div>
            <p className="text-[11px] text-[#6B6B6B]">People with the most problems come first. Late and early leave are judged against the scheduled shift with {data.graceMinutes} minutes of grace. Punches are compared with the schedule as clock times.</p>
          </>
        )}
      </Card>

      {adding && <AddPunch initial={adding} lockedPerson={adding.employeeId && openId ? adding.employeeId : undefined} onClose={() => setAdding(null)} onSaved={(t) => { setAdding(null); setNotice({ kind: 'ok', text: t }); reload(); }} />}
      {person && !adding && !excusing && <PersonPanel person={person} feedMissing={feedMissing} canWrite={canWrite} canExcuse={canExcuse} onClose={() => setOpenId(null)}
        onAdd={(day) => setAdding({ employeeId: person.employeeId, day, clockIn: '09:00', clockOut: '17:00', note: '' })} onRemove={setRemoving}
        onExcuse={(d) => { setExError(''); setExcusing({ day: d, kinds: EXCUSABLE_KINDS.filter((k) => d.issues.includes(k)) }); }} onUndo={(id) => void undoExcuse(id)} />}
      {excusing && counts && (
        <ExcuseDialog key={'day' in excusing ? `${excusing.day.employeeId}${excusing.day.day}` : excusing.issue} busy={exBusy} error={exError} onCancel={() => setExcusing(null)} onSubmit={(v) => void submitExcuse(v)}
          title={'day' in excusing ? `Excuse ${person?.name ?? 'this person'} on ${dayYear(excusing.day.day)}` : `Excuse all ${counts[excusing.issue]} ${KIND_LABEL[excusing.issue].toLowerCase()} days`}
          kinds={'day' in excusing ? excusing.kinds : undefined} offerPaid={'day' in excusing ? true : excusing.issue === 'missed'}
          intro={'day' in excusing ? <p>The day stops counting as a problem and shows who excused it and why.</p> : <p>This excuses every {KIND_LABEL[excusing.issue].toLowerCase()} day for the {counts[excusing.issue]} shown under this filter{q ? ' and search' : ''}, on every page, for the pay week from {dayYear(from)}. Use it when something such as a clock outage hit many people.</p>} />)}
      {removing && <Confirm title="Remove this punch?" confirmLabel="Remove punch" danger busy={busy} onCancel={() => setRemoving(null)} onConfirm={() => void removePunch()}><p>The hours it counted come off this person's day.</p></Confirm>}
    </div>
  );
};
