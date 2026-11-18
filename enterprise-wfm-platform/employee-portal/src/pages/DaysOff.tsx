/**
 * Days off: what the person's schedule is held to (days off together each week, full weekends off each month), a request for the weekends in some dates to be off together, and a request
 * for a standing rule of their own. A request can only ask for more than the person already has; their supervisor or manager decides it. The list below shows what was asked and how it went.
 */
import React, { useState } from 'react';
import { api, ApiError } from '../api';
import { approvalLine } from '../approval';
import { OffLimits, OffRequestDto } from '../types';
import { useLoad, Banner, Btn, Busy, Card, Empty, Field, Input, Pill, Select, Textarea, todayIso } from '../ui';

const STATUS_TONE: Record<string, 'good' | 'bad' | 'warn' | 'neutral'> = { APPROVED: 'good', REJECTED: 'bad', CANCELLED: 'neutral', REQUESTED: 'warn' };
const STATUS_TEXT: Record<string, string> = { APPROVED: 'Approved', REJECTED: 'Declined', CANCELLED: 'Cancelled', REQUESTED: 'Pending' };
const fmt = (iso: string, year = true) => new Date(`${iso}T00:00:00`).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', ...(year ? { year: 'numeric' as const } : {}) });
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
const addDays = (iso: string, n: number) => { const d = new Date(`${iso}T00:00:00`); d.setDate(d.getDate() + n); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const dow = (iso: string) => (new Date(`${iso}T00:00:00`).getDay() + 6) % 7;      // Monday = 0

/** The weekends a date range touches, each as its first and last day, whole (a Saturday alone takes the whole weekend). */
export function weekendsTouched(from: string, to: string, weekend: number[]): { from: string; to: string }[] {
  const set = new Set(weekend), out: { from: string; to: string }[] = [];
  if (!set.size || set.size >= 7 || to < from) return out;
  for (let d = from; d <= to; d = addDays(d, 1)) {
    if (!set.has(dow(d))) continue;
    let a = d; while (set.has(dow(addDays(a, -1)))) a = addDays(a, -1);
    let b = d; while (set.has(dow(addDays(b, 1)))) b = addDays(b, 1);
    if (!out.some((x) => x.from === a)) out.push({ from: a, to: b });
  }
  return out;
}

const asked = (r: OffRequestDto) => r.kind === 'WEEKEND_OFF'
  ? `Weekends off together: ${fmt(r.startDate!, false)}${r.endDate !== r.startDate ? ` – ${fmt(r.endDate!)}` : `, ${new Date(`${r.startDate}T00:00:00`).getFullYear()}`}`
  : `Standing rule: ${[r.minDaysTogether ? `${r.minDaysTogether} days off together each week` : '', r.minWeekendsMonth ? `${plural(r.minWeekendsMonth, 'full weekend', 'full weekends')} off each month` : ''].filter(Boolean).join(' and ')}`;

export const DaysOff: React.FC = () => {
  const { data, error, loading, reload } = useLoad<{ requests: OffRequestDto[]; weekendDays: number[]; today: string; limits: OffLimits }>('/me/off-requests');
  const [form, setForm] = useState<null | 'weekend' | 'standing'>(null);
  const [from, setFrom] = useState(todayIso());
  const [to, setTo] = useState(todayIso());
  const [days, setDays] = useState(0);
  const [weekends, setWeekends] = useState(0);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [sent, setSent] = useState('');
  const [toCancel, setToCancel] = useState<OffRequestDto | null>(null);

  if (loading && !data) return <Busy />;
  if (error) return <Banner kind="err">{error}</Banner>;
  if (!data) return null;
  const eff = data.limits.effective, today = data.today || todayIso();
  const touched = weekendsTouched(from, to, data.weekendDays);
  const open = (f: 'weekend' | 'standing') => { setForm(f); setErr(''); setSent(''); setNote(''); setDays(0); setWeekends(0); };

  const submit = async () => {
    setBusy(true); setErr('');
    try {
      await api('/me/off-requests', { method: 'POST', body: form === 'weekend' ? { kind: 'WEEKEND_OFF', startDate: from, endDate: to, reason: note.trim() } : { kind: 'STANDING', ...(days ? { minDaysTogether: days } : {}), ...(weekends ? { minWeekendsMonth: weekends } : {}), reason: note.trim() } });
      setForm(null); setSent('Sent. You will be told when it is decided.'); reload();
    } catch (e: any) { setErr(e instanceof ApiError ? e.message : 'Could not send the request'); } finally { setBusy(false); }
  };
  const doCancel = async () => {
    if (!toCancel) return;
    setBusy(true);
    try { await api(`/me/off-requests/${toCancel.id}/cancel`, { method: 'POST' }); setToCancel(null); reload(); }
    catch (e: any) { setToCancel(null); setErr(e instanceof ApiError ? e.message : 'Could not cancel'); } finally { setBusy(false); }
  };
  const canCancel = (r: OffRequestDto) => r.status === 'REQUESTED' || (r.kind === 'WEEKEND_OFF' && r.status === 'APPROVED' && (r.startDate ?? '') > today);
  const upcoming = data.requests.filter((r) => r.status === 'REQUESTED' || (r.kind === 'WEEKEND_OFF' && r.status === 'APPROVED' && (r.endDate ?? '') >= today));
  const past = data.requests.filter((r) => !upcoming.includes(r));

  const Row = (r: OffRequestDto) => (
    <div key={r.id} className="border border-[#E5E5E0] rounded-md p-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 text-[13px] font-semibold text-[#171717]">{asked(r)}</div>
        <Pill tone={STATUS_TONE[r.status] ?? 'neutral'}>{STATUS_TEXT[r.status] ?? r.status}</Pill>
      </div>
      {r.reason && <div className="text-[12px] text-[#6B6B6B] mt-1.5">Your note: {r.reason}</div>}
      {approvalLine(r) && <div className="text-[12px] text-[#525252] mt-1.5">{approvalLine(r)}</div>}
      {r.decisionNote && <div className="text-[12px] text-[#6B6B6B] mt-1">Reply: {r.decisionNote}</div>}
      {r.kind === 'STANDING' && r.status === 'APPROVED' && <div className="text-[12px] text-[#2A7553] mt-1">Added to your limits. Your schedules are built with it from now on.</div>}
      {canCancel(r) && <div className="mt-2"><button onClick={() => setToCancel(r)} className="text-[12px] font-semibold text-[#BC3F3F] hover:underline">Cancel request</button></div>}
    </div>
  );

  return (
    <div className="space-y-4">
      {err && <Banner kind="err" onClose={() => setErr('')}>{err}</Banner>}
      {sent && <Banner kind="ok" onClose={() => setSent('')}>{sent}</Banner>}
      <div className="grid gap-4 lg:grid-cols-[minmax(0,380px)_minmax(0,1fr)] items-start">
        <div className="space-y-4">
          <Card title="What your schedule keeps to" sub="The strictest of your own setting, the company's and the labour-law rule applies.">
            <ul className="text-[13px] text-[#171717] space-y-1.5">
              <li>{eff.daysTogether > 0 ? <>At least <span className="font-semibold">{plural(eff.daysTogether, 'day', 'days')}</span> off together each week.</> : <span className="text-[#6B6B6B]">No rule on days off together each week.</span>}</li>
              <li>{eff.weekendsMonth > 0 ? <>At least <span className="font-semibold">{plural(eff.weekendsMonth, 'full weekend', 'full weekends')}</span> off each month.</> : <span className="text-[#6B6B6B]">No rule on weekends off each month.</span>}</li>
            </ul>
          </Card>

          {!form ? (
            <div className="flex flex-wrap gap-2">
              <Btn variant="primary" onClick={() => open('weekend')}>Ask for weekends off</Btn>
              <Btn onClick={() => open('standing')}>Ask for a standing rule</Btn>
            </div>
          ) : form === 'weekend' ? (
            <Card title="Weekends off together">
              <div className="grid grid-cols-2 gap-3">
                <Field label="From"><Input type="date" min={today} value={from} onChange={(e) => { setFrom(e.target.value); if (e.target.value > to) setTo(e.target.value); }} /></Field>
                <Field label="To"><Input type="date" min={from} value={to} onChange={(e) => setTo(e.target.value)} /></Field>
              </div>
              <div className="text-[12px] text-[#525252]">
                {touched.length === 0 ? 'There is no weekend in these dates.' : <>{plural(touched.length, 'weekend', 'weekends')}: {touched.map((w) => (w.from === w.to ? fmt(w.from, false) : `${fmt(w.from, false)} – ${fmt(w.to, false)}`)).join(', ')}</>}
              </div>
              <Field label="Note for your supervisor (optional)"><Textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} /></Field>
              <Banner kind="warn">Your supervisor or manager decides. If it is approved, you are left off both days in the next schedule that is built; a schedule that is already published is not changed.</Banner>
              <div className="flex gap-2">
                <Btn variant="primary" disabled={busy || touched.length === 0 || to < from} onClick={submit}>{busy ? 'Sending…' : 'Send request'}</Btn>
                <Btn onClick={() => setForm(null)}>Close</Btn>
              </div>
            </Card>
          ) : (
            <Card title="A standing rule for you" sub="Ask for more than you have now. It stays until your manager changes it.">
              <Field label="Days off together each week" hint={eff.daysTogether ? `You have ${eff.daysTogether} now` : 'You have no rule now'}>
                <Select value={days} onChange={(e) => setDays(Number(e.target.value))}>
                  <option value={0}>No change</option>
                  {[1, 2, 3].filter((n) => n > eff.daysTogether).map((n) => <option key={n} value={n}>{n} {n === 1 ? 'day' : 'days'} together</option>)}
                </Select>
              </Field>
              <Field label="Full weekends off each month" hint={eff.weekendsMonth ? `You have ${eff.weekendsMonth} now` : 'You have no rule now'}>
                <Select value={weekends} onChange={(e) => setWeekends(Number(e.target.value))}>
                  <option value={0}>No change</option>
                  {[1, 2, 3, 4].filter((n) => n > eff.weekendsMonth).map((n) => <option key={n} value={n}>{n} {n === 1 ? 'weekend' : 'weekends'}</option>)}
                </Select>
              </Field>
              <Field label="Note for your supervisor (optional)"><Textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} /></Field>
              <Banner kind="warn">This can make it harder to cover the team, so it is decided by your supervisor or manager.</Banner>
              <div className="flex gap-2">
                <Btn variant="primary" disabled={busy || (!days && !weekends)} onClick={submit}>{busy ? 'Sending…' : 'Send request'}</Btn>
                <Btn onClick={() => setForm(null)}>Close</Btn>
              </div>
            </Card>
          )}
        </div>

        <Card title="Your requests">
          {data.requests.length === 0 ? <Empty title="No requests yet">Ask for the weekends of a trip or an event, or for a standing rule, and it will be listed here with its status.</Empty> : (
            <div className="space-y-4">
              {upcoming.length > 0 && <section><div className="text-[11px] font-semibold uppercase tracking-wider text-[#6B6B6B] mb-2">Open and upcoming</div><div className="space-y-2">{upcoming.map(Row)}</div></section>}
              {past.length > 0 && <section><div className="text-[11px] font-semibold uppercase tracking-wider text-[#6B6B6B] mb-2">Past and closed</div><div className="space-y-2">{past.map(Row)}</div></section>}
            </div>
          )}
        </Card>
      </div>

      {toCancel && (
        <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4" role="dialog" aria-modal="true" onClick={() => !busy && setToCancel(null)}>
          <div className="bg-white rounded-lg shadow-lg max-w-sm w-full p-5 space-y-3" onClick={(e) => e.stopPropagation()}>
            <div className="text-[15px] font-semibold text-[#171717]">Cancel this request?</div>
            <div className="text-[13px] text-[#525252]">{asked(toCancel)}.{toCancel.status === 'APPROVED' ? ' It is approved: the weekends go back to being worked as the schedule says.' : ''}</div>
            <div className="flex gap-2 justify-end">
              <Btn onClick={() => setToCancel(null)} disabled={busy}>Keep it</Btn>
              <Btn variant="danger" onClick={doCancel} disabled={busy}>{busy ? 'Cancelling…' : 'Cancel request'}</Btn>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
