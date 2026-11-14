/**
 * Workforce > Time Off. A list or a calendar of leave requests; opening one shows a drawer with the person's balance, the rules, the team's daily limit and what approving does to
 * cover on each day, so a manager decides with the risk in front of them. Waiting requests can be ticked and approved together: only those that pass every check are approved.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ColDef } from 'ag-grid-community';
import { ChevronLeft, ChevronRight, Plus, X } from 'lucide-react';
import { api, TimeOff, addDays, dayYear, fmtDate, when } from '../../services/api';
import { useForecast } from '../../services/forecastStore';
import { useApi } from '../forecasting/hooks';
import { PersonPicker } from '../common/PersonPicker';
import { MultiSelect } from '../common/MultiSelect';
import { Grid } from '../forecasting/Grid';
import { Banner, Btn, Card, Empty, Field, Input, Pill, Select, Seg } from '../forecasting/ui';
import { LoadFailed, Waiting } from '../common/loading';
import { Confirm } from '../configuration/groups/shared';

const STATUS_TONE = { REQUESTED: 'warn', APPROVED: 'good', REJECTED: 'bad', CANCELLED: 'neutral' } as const;
const STATUS_LABEL = { REQUESTED: 'Waiting', APPROVED: 'Approved', REJECTED: 'Declined', CANCELLED: 'Cancelled' } as const;
const cap = (s: string) => s[0] + s.slice(1).toLowerCase();

export interface Impact {
  request: TimeOff;
  balance: { type: string; entitledDays: number; remainingDays: number; usedDays: number; asksFor: number; afterDays: number; mode: string } | null;
  rules: { blockers: string[]; reasons: string[] };
  cap: { percent: number; limit: number; groupSize: number; busiest: { day: string; n: number } | null; breach: { day: string; off: number; cap: number } | null } | null;
  target: number;
  coverage: {
    source: 'forecast' | 'template' | null; groups: string[]; projectedDays: string[]; judgedDays: number; clipped: boolean; headline: string; tone: 'good' | 'warn' | 'bad' | 'unknown';
    days: { day: string; dayName: string; groupName: string | null; scheduled: boolean; published: boolean; judged: boolean; beforePercent: number | null; afterPercent: number | null; worst: { from: string; to: string; percent: number; short: number } | null }[];
  };
  passes: { ok: boolean; why: string[] };
}
interface BulkResult { decided: number; skipped: number; left: { id: string; employeeName?: string; why: string[] }[] }

const TONE_BANNER = { good: 'ok', warn: 'warn', bad: 'err', unknown: 'info' } as const;
const pctClass = (p: number | null, target: number) => p === null ? 'text-[#6B6B6B]' : p < target ? 'text-[#BC3F3F] font-semibold' : 'text-[#171717]';

// ---------------------------------------------------------------- the drawer

const Drawer: React.FC<{ id: string; canDecide: boolean; onClose: () => void; onDecided: (text: string) => void }> = ({ id, canDecide, onClose, onDecided }) => {
  const [imp, setImp] = useState<Impact | null>(null);
  const [error, setError] = useState('');
  const [ask, setAsk] = useState<null | 'anyway' | 'decline' | 'cancel'>(null);
  const [busy, setBusy] = useState(false);
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => { let live = true; setImp(null); setError(''); api<Impact>(`/workforce/time-off/${id}/impact`).then((d) => live && setImp(d)).catch((e) => live && setError(e.message)); return () => { live = false; }; }, [id]);
  useEffect(() => { closeRef.current?.focus(); }, [id]);
  useEffect(() => { const k = (e: KeyboardEvent) => { if (e.key === 'Escape' && !ask) onClose(); }; window.addEventListener('keydown', k); return () => window.removeEventListener('keydown', k); }, [onClose, ask]);

  const decide = async (status: 'APPROVED' | 'REJECTED' | 'CANCELLED', reason: string, done: string) => {
    setBusy(true); setError('');
    try { await api(`/workforce/time-off/${id}/decide`, { method: 'POST', body: { status, reason } }); setAsk(null); onDecided(done); }
    catch (e: any) { setError(e.message); setAsk(null); } finally { setBusy(false); }
  };
  const r = imp?.request;
  const waiting = r?.status === 'REQUESTED';
  // the overlay is the dialog: the app's Escape handler leaves role=dialog layers to themselves (otherwise it would press "Cancel leave…")
  return (
    <div role="dialog" aria-modal="true" aria-label={r ? `Time off request for ${r.employeeName}` : 'Time off request'} className="fixed inset-0 z-40 bg-black/20 flex justify-end" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <aside className="w-full max-w-xl bg-white border-l border-[#E5E5E0] shadow-xl h-full overflow-y-auto p-5 space-y-4 select-text">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="text-[16px] font-semibold text-[#171717]">{r ? r.employeeName : 'Time off request'}</h2>
            {r && <p className="text-[12px] text-[#6B6B6B] mt-0.5">{cap(r.type)} · {dayYear(r.startDate)}{r.endDate !== r.startDate ? ` to ${dayYear(r.endDate)}` : ''} · {r.days} day{r.days === 1 ? '' : 's'}</p>}
          </div>
          <div className="flex items-center gap-2">{r && <Pill tone={STATUS_TONE[r.status]}>{STATUS_LABEL[r.status]}</Pill>}<button ref={closeRef} onClick={onClose} aria-label="Close" className="p-1 rounded hover:bg-[#FAFAF8]"><X className="w-4 h-4" /></button></div>
        </div>
        {error && <Banner kind="err">{error}</Banner>}
        {!imp && !error && <p className="text-[12px] text-[#6B6B6B]" role="status">Checking the balance, the rules and the team's cover…</p>}
        {imp && r && (
          <>
            {r.reason && <p className="text-[13px] text-[#525252]"><span className="font-semibold text-[#171717]">Note: </span>{r.reason}</p>}
            {r.decidedBy && <p className="text-[12px] text-[#6B6B6B]">Decided by {r.decidedBy}{r.decidedLevel ? ` (${r.decidedLevel === 'SUPERVISOR' ? 'supervisor' : 'manager'})` : ''} · {when(r.decidedAt)}</p>}

            <Banner kind={TONE_BANNER[imp.coverage.tone]}><span className="font-semibold">{imp.coverage.headline}</span></Banner>

            <section aria-label="Checks" className="space-y-1.5">
              <h3 className="text-[12px] font-semibold uppercase tracking-wide text-[#6B6B6B]">Checks</h3>
              <ul className="text-[13px] space-y-1">
                <li>{imp.balance
                  ? <><span className={imp.balance.afterDays < 0 ? 'text-[#BC3F3F] font-semibold' : ''}>{cap(imp.balance.type)} balance: {imp.balance.remainingDays} day{imp.balance.remainingDays === 1 ? '' : 's'} {imp.balance.mode === 'MONTHLY' ? 'available by then' : 'left'}</span>{r.status === 'REQUESTED' ? `; this uses ${imp.balance.asksFor}, leaving ${imp.balance.afterDays}.` : '.'}</>
                  : <span className="text-[#6B6B6B]">No yearly allowance is set for {cap(r.type)}, so there is no balance to run out of.</span>}</li>
                <li>{imp.cap
                  ? <span className={imp.cap.breach ? 'text-[#BC3F3F] font-semibold' : ''}>Team limit: at most {imp.cap.limit} of {imp.cap.groupSize} off at once ({imp.cap.percent}%). {imp.cap.breach ? `On ${imp.cap.breach.day} ${imp.cap.breach.off} are already off.` : imp.cap.busiest ? `The busiest of these days has ${imp.cap.busiest.n} already off.` : 'Nobody else is off on these days.'}</span>
                  : <span className="text-[#6B6B6B]">No team limit applies to this request.</span>}</li>
                {imp.rules.blockers.map((t) => <li key={t} className="text-[#BC3F3F] font-semibold">{t}</li>)}
                {imp.rules.reasons.map((t) => <li key={t} className="text-[#8F6200]">{t}</li>)}
                {!imp.rules.blockers.length && !imp.rules.reasons.length && <li className="text-[#6B6B6B]">No blackout dates or daily limits are in the way.</li>}
              </ul>
            </section>

            <section aria-label="Cover on each day" className="space-y-1.5">
              <h3 className="text-[12px] font-semibold uppercase tracking-wide text-[#6B6B6B]">Cover on each day <span className="normal-case font-normal">(target {imp.target}%)</span></h3>
              {imp.coverage.source === null && <p className="text-[12px] text-[#6B6B6B]">No published forecast or weekly coverage template reaches these days, so cover cannot be shown.</p>}
              <div className="overflow-x-auto border border-[#E5E5E0] rounded">
                <table className="w-full text-[12px]">
                  <thead><tr className="bg-[#FAFAF8] text-left text-[#6B6B6B]"><th className="px-2 py-1.5 font-semibold">Day</th><th className="px-2 py-1.5 font-semibold">Working</th><th className="px-2 py-1.5 font-semibold text-right">Now</th><th className="px-2 py-1.5 font-semibold text-right">If approved</th><th className="px-2 py-1.5 font-semibold">Weakest stretch</th></tr></thead>
                  <tbody>
                    {imp.coverage.days.map((d) => (
                      <tr key={d.day} className="border-t border-[#E5E5E0]">
                        <td className="px-2 py-1.5 whitespace-nowrap">{d.dayName} {d.day.slice(5)}</td>
                        <td className="px-2 py-1.5">{d.scheduled ? 'Yes' : <span className="text-[#6B6B6B]">No</span>}{d.groupName && <span className="block text-[11px] text-[#6B6B6B]">{d.groupName}</span>}</td>
                        <td className="px-2 py-1.5 text-right">{d.beforePercent === null ? '–' : `${d.beforePercent}%`}</td>
                        <td className={`px-2 py-1.5 text-right ${d.scheduled ? pctClass(d.afterPercent, imp.target) : 'text-[#6B6B6B]'}`}>{d.afterPercent === null ? '–' : `${d.afterPercent}%`}</td>
                        <td className="px-2 py-1.5">{d.worst ? `${d.worst.from}–${d.worst.to} at ${d.worst.percent}% (${d.worst.short} short)` : !d.published ? <span className="text-[#6B6B6B]">No schedule published yet</span> : d.scheduled && !d.judged ? <span className="text-[#6B6B6B]">Not known</span> : <span className="text-[#6B6B6B]">–</span>}</td>
                      </tr>))}
                  </tbody>
                </table>
              </div>
              {imp.coverage.groups.length > 1 && <p className="text-[12px] text-[#6B6B6B]">They work in more than one group ({imp.coverage.groups.join(', ')}); each day is judged in the group whose schedule holds their shift.</p>}
              {imp.coverage.clipped && <p className="text-[12px] text-[#6B6B6B]">Only the first {imp.coverage.judgedDays} days are shown.</p>}
              {imp.coverage.projectedDays.length > 0 && <p className="text-[12px] text-[#6B6B6B]">{imp.coverage.projectedDays.length} of these days come from the long-term forecast, so the need is an estimate.</p>}
              {imp.coverage.source === 'template' && <p className="text-[12px] text-[#6B6B6B]">Judged against the group's weekly coverage template (no forecast reaches these days).</p>}
            </section>

            {waiting && (imp.passes.ok
              ? <Banner kind="ok">This request passes every check.</Banner>
              : <Banner kind="warn"><div className="font-semibold">Needs your judgement:</div><ul className="list-disc pl-4 mt-1">{imp.passes.why.map((t) => <li key={t}>{t}</li>)}</ul></Banner>)}

            {canDecide && (
              <div className="flex flex-wrap items-center gap-2 pt-1">
                {waiting && (imp.passes.ok
                  ? <Btn variant="success" disabled={busy} onClick={() => void decide('APPROVED', '', `Approved ${r.employeeName}'s time off.`)}>Approve</Btn>
                  : <Btn variant="primary" disabled={busy} onClick={() => setAsk('anyway')}>Approve anyway…</Btn>)}
                {waiting && <Btn disabled={busy} onClick={() => setAsk('decline')}>Decline…</Btn>}
                {(waiting || r.status === 'APPROVED') && <Btn disabled={busy} onClick={() => setAsk('cancel')}>{waiting ? 'Withdraw request' : 'Cancel leave'}…</Btn>}
              </div>)}
          </>
        )}
      </aside>
      {ask === 'anyway' && r && (
        <Confirm title={`Approve ${r.employeeName}'s time off anyway?`} confirmLabel="Approve anyway" reason busy={busy} onCancel={() => setAsk(null)}
          onConfirm={(why) => void decide('APPROVED', `${r.reason ? `${r.reason} · ` : ''}Approved with the checks open: ${why}`.slice(0, 300), `Approved ${r.employeeName}'s time off.`)}>
          <p>Not everything above is clear. Say why you are approving it; the reason is kept with the request.</p>
        </Confirm>)}
      {ask === 'decline' && r && (
        <Confirm title={`Decline ${r.employeeName}'s request?`} confirmLabel="Decline" danger reason busy={busy} onCancel={() => setAsk(null)}
          onConfirm={(why) => void decide('REJECTED', why, `Declined ${r.employeeName}'s request.`)}>
          <p>They are told it was declined, with your reason.</p>
        </Confirm>)}
      {ask === 'cancel' && r && (
        <Confirm title={waiting ? 'Withdraw this request?' : `Cancel ${r.employeeName}'s approved leave?`} confirmLabel={waiting ? 'Withdraw' : 'Cancel leave'} danger busy={busy} onCancel={() => setAsk(null)}
          onConfirm={() => void decide('CANCELLED', '', waiting ? 'Request withdrawn.' : 'Leave cancelled.')}>
          <p>{waiting ? 'The request is closed without a decision.' : 'They go back on the schedule for these days.'}</p>
        </Confirm>)}
    </div>
  );
};

// ---------------------------------------------------------------- the calendar

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const CHIP = { REQUESTED: 'bg-[#FFF5DD] text-[#8F6200] border-[#B7791F]/30', APPROVED: 'bg-[#EAF5EF] text-[#2A7553] border-[#2F7D5A]/30', REJECTED: 'bg-[#FCEBEC] text-[#BC3F3F] border-[#C84A4A]/30', CANCELLED: 'bg-[#FAFAF8] text-[#525252] border-[#E5E5E0]' } as const;

/** The weeks (Monday first) that make up a month, as arrays of seven dates. */
export function monthWeeks(year: number, month: number): string[][] {
  const first = fmtDate(new Date(year, month, 1)), lead = (new Date(year, month, 1).getDay() + 6) % 7;
  const start = addDays(first, -lead), last = new Date(year, month + 1, 0), total = Math.ceil((lead + last.getDate()) / 7) * 7;
  return Array.from({ length: total / 7 }, (_, w) => Array.from({ length: 7 }, (_, d) => addDays(start, w * 7 + d)));
}

const Calendar: React.FC<{ statuses: string[]; reloadKey: number; onOpen: (id: string) => void }> = ({ statuses, reloadKey, onOpen }) => {
  const now = new Date();
  const [ym, setYm] = useState({ y: now.getFullYear(), m: now.getMonth() });
  const [open, setOpen] = useState<string | null>(null);
  const weeks = useMemo(() => monthWeeks(ym.y, ym.m), [ym]);
  const from = weeks[0][0], to = weeks.at(-1)![6];
  const want = statuses.length ? statuses : ['REQUESTED', 'APPROVED'];
  const data = useApi<TimeOff[]>(`/workforce/time-off?from=${from}&to=${to}&statuses=${want.join(',')}`, [from, to, want.join(','), reloadKey]);
  const byDay = useMemo(() => {
    const m = new Map<string, TimeOff[]>();
    for (const t of data.data ?? []) for (let d = t.startDate < from ? from : t.startDate; d <= t.endDate && d <= to; d = addDays(d, 1)) m.set(d, [...(m.get(d) ?? []), t]);
    for (const l of m.values()) l.sort((a, b) => (a.status === b.status ? a.employeeName.localeCompare(b.employeeName) : a.status === 'REQUESTED' ? -1 : 1));
    return m;
  }, [data.data, from, to]);
  const step = (n: number) => setYm((v) => { const d = new Date(v.y, v.m + n, 1); return { y: d.getFullYear(), m: d.getMonth() }; });
  const today = fmtDate(now);
  const SHOW = 3;
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <button aria-label="Previous month" className="p-1.5 border border-[#E5E5E0] rounded hover:bg-[#FAFAF8]" onClick={() => step(-1)}><ChevronLeft className="w-4 h-4" /></button>
        <h3 className="text-[14px] font-semibold w-40 text-center" aria-live="polite">{MONTHS[ym.m]} {ym.y}</h3>
        <button aria-label="Next month" className="p-1.5 border border-[#E5E5E0] rounded hover:bg-[#FAFAF8]" onClick={() => step(1)}><ChevronRight className="w-4 h-4" /></button>
        <Btn onClick={() => setYm({ y: now.getFullYear(), m: now.getMonth() })}>This month</Btn>
        <span className="ml-auto flex items-center gap-3 text-[11px] text-[#6B6B6B]"><span className="flex items-center gap-1"><i className="w-2.5 h-2.5 rounded-sm bg-[#FFF5DD] border border-[#B7791F]/40" />Waiting</span><span className="flex items-center gap-1"><i className="w-2.5 h-2.5 rounded-sm bg-[#EAF5EF] border border-[#2F7D5A]/40" />Approved</span></span>
      </div>
      {data.error && !data.data ? <LoadFailed what="time off" error={data.error} reload={data.reload} /> : (
        <table aria-label="Time off calendar" className="w-full table-fixed border-collapse text-[12px]">
          <thead><tr>{WEEKDAYS.map((d) => <th key={d} scope="col" className="text-left text-[11px] font-semibold uppercase tracking-wide text-[#6B6B6B] px-2 py-1 border border-[#E5E5E0] bg-[#FAFAF8]">{d}</th>)}</tr></thead>
          <tbody>
            {weeks.map((w) => (
              <tr key={w[0]}>
                {w.map((d) => {
                  const list = byDay.get(d) ?? [], inMonth = Number(d.slice(5, 7)) - 1 === ym.m, all = open === d, shown = all ? list : list.slice(0, SHOW);
                  return (
                    <td key={d} className={`align-top border border-[#E5E5E0] p-1.5 h-28 ${inMonth ? 'bg-white' : 'bg-[#FAFAF8]'}`}>
                      <div className={`text-[11px] mb-1 ${d === today ? 'inline-block px-1.5 rounded bg-[#171717] text-white font-semibold' : inMonth ? 'text-[#171717]' : 'text-[#6B6B6B]'}`}>{Number(d.slice(8))}</div>
                      <div className="space-y-0.5">
                        {shown.map((t) => (
                          <button key={t.id} onClick={() => onOpen(t.id)} aria-label={`${t.employeeName}, ${cap(t.type)}, ${STATUS_LABEL[t.status].toLowerCase()}, ${d}`}
                            className={`block w-full truncate text-left px-1.5 py-0.5 rounded border text-[11px] ${CHIP[t.status]}`}>{t.employeeName}</button>))}
                        {list.length > SHOW && <button className="text-[11px] underline text-[#525252]" aria-expanded={all} onClick={() => setOpen(all ? null : d)}>{all ? 'Show fewer' : `+${list.length - SHOW} more`}</button>}
                      </div>
                    </td>);
                })}
              </tr>))}
          </tbody>
        </table>)}
    </div>
  );
};

// ---------------------------------------------------------------- the page

export const TimeOffPanel: React.FC = () => {
  const { can, setNotice } = useForecast();
  const [tick, setTick] = useState(0);
  const [statuses, setStatuses] = useState<string[]>([]);
  const [view, setView] = useState<'list' | 'calendar'>('list');
  const list = useApi<TimeOff[]>(`/workforce/time-off${statuses.length ? `?statuses=${statuses.join(',')}` : ''}`, [tick, statuses.join(',')]);
  const [f, setF] = useState<{ employeeId: string; type: string; startDate: string; endDate: string; reason: string; approve: boolean } | null>(null);
  const [error, setError] = useState('');
  const [drawer, setDrawer] = useState<string | null>(null);
  const [picked, setPicked] = useState<TimeOff[]>([]);
  const [bulk, setBulk] = useState<null | 'decline'>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ text: string; left: BulkResult['left'] } | null>(null);
  const gridApi = useRef<any>(null);
  const w = can('workforce:write') || can('requests:approve');
  const waiting = (list.data ?? []).filter((t) => t.status === 'REQUESTED').length;
  const refresh = useCallback(() => setTick((x) => x + 1), []);

  const create = async () => {
    if (!f) return; setError('');
    try { await api('/workforce/time-off', { method: 'POST', body: f }); setF(null); refresh(); } catch (e: any) { setError(e.message); }
  };

  /** Inline Approve: approves at once when the request passes every check, otherwise opens the drawer to show what is in the way. */
  const quickApprove = async (t: TimeOff) => {
    try {
      const imp = await api<Impact>(`/workforce/time-off/${t.id}/impact`);
      if (!imp.passes.ok) { setDrawer(t.id); return; }
      await api(`/workforce/time-off/${t.id}/decide`, { method: 'POST', body: { status: 'APPROVED', reason: '' } });
      setNotice({ kind: 'ok', text: `Approved ${t.employeeName}'s time off.` }); refresh();
    } catch (e: any) { setNotice({ kind: 'err', text: e.message }); }
  };

  const runBulk = async (status: 'APPROVED' | 'REJECTED', reason = '') => {
    setBusy(true);
    try {
      const r = await api<BulkResult>('/workforce/time-off/bulk-decide', { method: 'POST', body: { ids: picked.map((t) => t.id), status, reason, onlyIfPasses: true } });
      setResult({ text: `${status === 'APPROVED' ? 'Approved' : 'Declined'} ${r.decided} request${r.decided === 1 ? '' : 's'}.${r.skipped ? ` ${r.skipped} left for you to look at.` : ''}`, left: r.left });
      setBulk(null); gridApi.current?.deselectAll(); setPicked([]); refresh();
    } catch (e: any) { setNotice({ kind: 'err', text: e.message }); setBulk(null); } finally { setBusy(false); }
  };

  const cols = useMemo<ColDef<TimeOff>[]>(() => [
    { headerName: 'Employee', field: 'employeeName', minWidth: 170, cellRenderer: (p: any) => <button className="underline text-left font-medium" aria-label={`${p.value}, review request`} onClick={() => setDrawer(p.data.id)}>{p.value}</button> },
    { headerName: 'Type', field: 'type', valueFormatter: (p) => cap(p.value), width: 110 },
    { headerName: 'From', field: 'startDate', valueFormatter: (p) => dayYear(p.value) },
    { headerName: 'To', field: 'endDate', valueFormatter: (p) => dayYear(p.value) },
    { headerName: 'Days', field: 'days', type: 'rightAligned', width: 80 },
    { headerName: 'Status', field: 'status', width: 130, cellRenderer: (p: any) => <span className="flex items-center gap-1 h-full"><Pill tone={STATUS_TONE[p.value as keyof typeof STATUS_TONE]}>{STATUS_LABEL[p.value as keyof typeof STATUS_LABEL]}</Pill>{p.data?.escalatedAt && p.value === 'REQUESTED' && <Pill tone="warn" title="Waited longer than the escalation time: the managers have been told">Overdue</Pill>}</span> },
    { headerName: 'Reason / note', field: 'reason', flex: 2, minWidth: 150 },
    { headerName: 'Decided', valueGetter: (p) => (p.data!.decidedBy ? `${p.data!.decidedBy}${p.data!.decidedLevel ? ` (${p.data!.decidedLevel === 'SUPERVISOR' ? 'supervisor' : 'manager'})` : ''} · ${when(p.data!.decidedAt)}` : ''), minWidth: 190 },
    { headerName: '', width: 190, sortable: false, filter: false, cellRenderer: (p: any) => (
      <span className="flex gap-3 items-center h-full text-[12px]">
        {w && p.data.status === 'REQUESTED' && <><button className="font-semibold text-[#2A7553] underline" aria-label={`Approve ${p.data.employeeName}`} onClick={() => void quickApprove(p.data)}>Approve</button><button className="font-semibold text-[#BC3F3F] underline" aria-label={`Decline ${p.data.employeeName}`} onClick={() => setDrawer(p.data.id)}>Decline</button></>}
        <button className="underline text-[#525252]" aria-label={`Review ${p.data.employeeName}`} onClick={() => setDrawer(p.data.id)}>Review</button>
      </span>) },
  ], [w]);

  const rows = list.data ?? [];
  return (
    <Card title="Time off" sub="Approved time off blocks scheduling for those days. Open a request to see the balance and what it does to cover before you decide."
      actions={<>
        <Seg options={[{ id: 'list', label: 'List' }, { id: 'calendar', label: 'Calendar' }]} value={view} onChange={(v) => setView(v as 'list' | 'calendar')} />
        <MultiSelect ariaLabel="Status" allLabel="All requests" noun={['status', 'statuses']} value={statuses} onChange={setStatuses} options={[{ value: 'REQUESTED', label: 'Waiting' }, { value: 'APPROVED', label: 'Approved' }, { value: 'REJECTED', label: 'Declined' }, { value: 'CANCELLED', label: 'Cancelled' }]} />
        {can('workforce:write') && <Btn variant="primary" onClick={() => { setError(''); setF({ employeeId: '', type: 'VACATION', startDate: '', endDate: '', reason: '', approve: false }); }}><Plus className="w-3.5 h-3.5" />New request</Btn>}
      </>}>
      {f && (
        <div className="border border-[#E5E5E0] rounded-lg p-4 grid grid-cols-1 md:grid-cols-6 gap-4 items-end">
          <div className="md:col-span-2"><Field label="Employee"><PersonPicker ariaLabel="Employee" value={f.employeeId} status="ACTIVE" placeholder="Choose: type a name or number" onChange={(id) => setF({ ...f, employeeId: id })} /></Field></div>
          <Field label="Type"><Select value={f.type} onChange={(e) => setF({ ...f, type: e.target.value })}>{['VACATION', 'SICK', 'PERSONAL', 'HOLIDAY', 'TRAINING', 'LEAVE', 'OTHER'].map((t) => <option key={t} value={t}>{cap(t)}</option>)}</Select></Field>
          <Field label="From"><Input type="date" value={f.startDate} onChange={(e) => setF({ ...f, startDate: e.target.value, endDate: f.endDate || e.target.value })} /></Field>
          <Field label="To"><Input type="date" min={f.startDate} value={f.endDate} onChange={(e) => setF({ ...f, endDate: e.target.value })} /></Field>
          <Field label="Decision"><Select value={f.approve ? 'y' : 'n'} onChange={(e) => setF({ ...f, approve: e.target.value === 'y' })}><option value="n">Leave for approval</option><option value="y">Approve now</option></Select></Field>
          <div className="md:col-span-6"><Field label="Reason (optional)"><Input value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} /></Field></div>
          <div className="md:col-span-6 flex items-center gap-2"><Btn variant="primary" disabled={!f.employeeId || !f.startDate || !f.endDate} onClick={create}>Save</Btn><Btn onClick={() => setF(null)}>Cancel</Btn>{error && <span className="text-[12px] text-[#BC3F3F]">{error}</span>}</div>
        </div>
      )}

      {result && (
        <Banner kind={result.left.length ? 'warn' : 'ok'} onClose={() => setResult(null)}>
          <div className="font-semibold">{result.text}</div>
          {result.left.length > 0 && <ul className="list-disc pl-4 mt-1 space-y-0.5">{result.left.slice(0, 8).map((l) => <li key={l.id}>{l.employeeName ?? 'A request'}: {l.why.join(' ')}</li>)}{result.left.length > 8 && <li>and {result.left.length - 8} more</li>}</ul>}
        </Banner>)}

      {view === 'list' && w && picked.length > 0 && (
        <div role="region" aria-label="Selected requests" className="flex flex-wrap items-center gap-3 rounded-lg border border-[#E5E5E0] bg-[#FAFAF8] px-3.5 py-2.5">
          <span className="text-[13px] font-semibold">{picked.length} selected</span>
          <Btn variant="success" disabled={busy} onClick={() => void runBulk('APPROVED')}>Approve {picked.length} that pass the rules</Btn>
          <Btn disabled={busy} onClick={() => setBulk('decline')}>Decline {picked.length}…</Btn>
          <button className="text-[12px] underline text-[#525252]" onClick={() => gridApi.current?.deselectAll()}>Clear</button>
          <span className="text-[12px] text-[#6B6B6B]">Anything that does not pass is left waiting, with the reason.</span>
        </div>)}

      {view === 'calendar'
        ? <Calendar statuses={statuses} reloadKey={tick} onOpen={setDrawer} />
        : list.data === null ? (list.error ? <LoadFailed what="time-off requests" error={list.error} reload={list.reload} /> : <Waiting what="time-off requests" shape="table" reload={list.reload} />)
          : rows.length === 0 ? <Empty title="No time-off requests">Requests and approved leave appear here.</Empty>
            : <>
              {waiting > 0 && <p className="text-[12px] text-[#6B6B6B]">{waiting} waiting for a decision. Tick the ones you want and approve those that pass the rules together.</p>}
              <Grid<TimeOff> rowData={rows} columnDefs={cols} defaultColDef={{ sortable: true, resizable: true }} loading={list.loading} height={Math.min(560, 90 + rows.length * 42)}
                getRowId={(p) => p.data.id}
                rowSelection={w ? { mode: 'multiRow', checkboxes: true, headerCheckbox: true, enableClickSelection: false, isRowSelectable: (n) => n.data?.status === 'REQUESTED' } : undefined}
                selectionColumnDef={{ pinned: 'left', width: 48, resizable: false, suppressHeaderMenuButton: true }}
                onGridReady={(e) => { gridApi.current = e.api; }} onSelectionChanged={(e) => setPicked(e.api.getSelectedRows())} />
            </>}

      {drawer && <Drawer id={drawer} canDecide={w} onClose={() => setDrawer(null)} onDecided={(text) => { setDrawer(null); setNotice({ kind: 'ok', text }); refresh(); }} />}
      {bulk === 'decline' && (
        <Confirm title={`Decline ${picked.length} request${picked.length === 1 ? '' : 's'}?`} confirmLabel="Decline" danger reason busy={busy} onCancel={() => setBulk(null)} onConfirm={(why) => void runBulk('REJECTED', why)}>
          <p>Each person is told it was declined, with your reason.</p>
        </Confirm>)}
    </Card>
  );
};
