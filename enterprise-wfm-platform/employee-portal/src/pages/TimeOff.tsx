/** Balances, a request form with a live "would this be auto-approved" preview, and your request history (upcoming first, then past). */
import { approvalLine } from '../approval';
import React, { useEffect, useState } from 'react';
import { api, ApiError } from '../api';
import { TimeOff as TimeOffDto, TimeOffBalance, TimeOffCheck, TimeOffRules, TimeOffType } from '../types';
import { useLoad, Banner, Btn, Busy, Card, Empty, Field, Input, Pill, Textarea, todayIso } from '../ui';

const TYPES: TimeOffType[] = ['VACATION', 'SICK', 'PERSONAL', 'HOLIDAY', 'TRAINING', 'LEAVE', 'OTHER'];
const STATUS_TONE: Record<string, 'good' | 'bad' | 'warn' | 'neutral'> = { APPROVED: 'good', REJECTED: 'bad', CANCELLED: 'neutral', PENDING: 'warn', REQUESTED: 'warn' };
const STATUS_TEXT: Record<string, string> = { APPROVED: 'Approved', REJECTED: 'Declined', CANCELLED: 'Cancelled', PENDING: 'Pending', REQUESTED: 'Pending' };
const FILTERS = [['ALL', 'All'], ['PENDING', 'Pending'], ['APPROVED', 'Approved'], ['CLOSED', 'Declined or cancelled']] as const;
type Filter = typeof FILTERS[number][0];

const nice = (t: string) => { const s = t.replace(/_/g, ' ').toLowerCase(); return s[0].toUpperCase() + s.slice(1); };
const fmt = (iso: string, year = true) => new Date(`${iso}T00:00:00`).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', ...(year ? { year: 'numeric' as const } : {}) });
const range = (a: string, b: string) => (a === b ? fmt(a) : `${fmt(a, false)} – ${fmt(b)}`);
const isWaiting = (s: string) => s === 'PENDING' || s === 'REQUESTED';
const matches = (f: Filter, s: string) => f === 'ALL' || (f === 'PENDING' ? isWaiting(s) : f === 'APPROVED' ? s === 'APPROVED' : s === 'REJECTED' || s === 'CANCELLED');

const BalanceCard: React.FC<{ b: TimeOffBalance; pending: number }> = ({ b, pending }) => {
  const total = b.entitledDays || 0, usedPct = total ? Math.min(100, (b.usedDays / total) * 100) : 0, pendPct = total ? Math.min(100 - usedPct, (pending / total) * 100) : 0;
  return (
    <div className="border border-[#E5E5E0] rounded-md p-3">
      <div className="flex items-baseline justify-between gap-2">
        <div className="text-[13px] font-semibold text-[#171717]">{nice(b.type)}</div>
        <div className="text-[18px] font-bold text-[#171717] leading-none">{b.remainingDays}<span className="text-[11px] font-normal text-[#6B6B6B]"> {b.remainingDays === 1 ? 'day' : 'days'} left</span></div>
      </div>
      <div className="mt-2 h-1.5 rounded-full bg-[#F0F0EC] overflow-hidden flex" role="img" aria-label={`${b.usedDays} used, ${pending} pending, of ${total}`}>
        <div className="bg-accent" style={{ width: `${usedPct}%` }} />
        <div className="bg-[#E3B341]" style={{ width: `${pendPct}%` }} />
      </div>
      <div className="mt-1.5 text-[11px] text-[#6B6B6B]">{b.usedDays} used{pending > 0 ? ` · ${pending} pending` : ''} · {total} in total</div>
      {(b.carriedOverDays ?? 0) > 0 && (b.expiredDays ?? 0) < (b.carriedOverDays ?? 0) && (
        <div className="text-[11px] text-[#6B6B6B]">Includes {(b.carriedOverDays ?? 0) - (b.expiredDays ?? 0)} {((b.carriedOverDays ?? 0) - (b.expiredDays ?? 0)) === 1 ? 'day' : 'days'} carried over from last year{b.carryExpiresOn && b.carryExpiresOn >= todayIso() ? <span className="text-[#8F6200]"> · use by {fmt(b.carryExpiresOn)}</span> : ''}</div>
      )}
      {(b.expiredDays ?? 0) > 0 && <div className="text-[11px] text-[#8F6200]">{b.expiredDays} carried {b.expiredDays === 1 ? 'day' : 'days'} lapsed{b.carryExpiresOn ? ` on ${fmt(b.carryExpiresOn)}` : ''}</div>}
      {(b.adjustedDays ?? 0) !== 0 && <div className="text-[11px] text-[#6B6B6B]">{(b.adjustedDays ?? 0) > 0 ? '+' : ''}{b.adjustedDays} {Math.abs(b.adjustedDays ?? 0) === 1 ? 'day' : 'days'} adjusted by your manager</div>}
    </div>
  );
};

export const TimeOff: React.FC<{ initialDate?: string; onConsumed?: () => void }> = ({ initialDate, onConsumed }) => {
  const { data, error, loading, reload } = useLoad<{ requests: TimeOffDto[]; balances: TimeOffBalance[]; rules: TimeOffRules; today: string }>('/me/time-off');
  const [form, setForm] = useState(false);
  const [type, setType] = useState<TimeOffType>('VACATION');
  const [start, setStart] = useState(todayIso());
  const [end, setEnd] = useState(todayIso());
  const [reason, setReason] = useState('');
  const [check, setCheck] = useState<TimeOffCheck | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [filter, setFilter] = useState<Filter>('ALL');
  const [toCancel, setToCancel] = useState<TimeOffDto | null>(null);

  useEffect(() => {
    if (!initialDate) return;
    setForm(true); setStart(initialDate); setEnd(initialDate);
    onConsumed?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialDate]);

  useEffect(() => {
    if (!form || end < start) { setCheck(null); return; }
    let live = true;
    api<TimeOffCheck>('/me/time-off/check', { method: 'POST', body: { type, startDate: start, endDate: end } }).then((c) => live && setCheck(c)).catch(() => live && setCheck(null));
    return () => { live = false; };
  }, [form, type, start, end]);

  const submit = async () => {
    setBusy(true); setErr('');
    try { await api('/me/time-off', { method: 'POST', body: { type, startDate: start, endDate: end, reason: reason.trim() || undefined } }); setForm(false); setReason(''); reload(); }
    catch (e: any) { setErr(e instanceof ApiError ? e.message : 'Could not submit the request'); } finally { setBusy(false); }
  };
  const doCancel = async () => {
    if (!toCancel) return;
    setBusy(true);
    try { await api(`/me/time-off/${toCancel.id}/cancel`, { method: 'POST' }); setToCancel(null); reload(); }
    catch (e: any) { setToCancel(null); setErr(e instanceof ApiError ? e.message : 'Could not cancel'); } finally { setBusy(false); }
  };

  if (loading && !data) return <Busy />;
  if (error) return <Banner kind="err">{error}</Banner>;
  if (!data) return null;

  const today = data.today || todayIso(), year = today.slice(0, 4);
  const pendingOf = (t: string) => data.requests.filter((r) => r.type === t && isWaiting(r.status) && r.startDate.slice(0, 4) === year).reduce((n, r) => n + r.days, 0);
  const shown = data.requests.filter((r) => matches(filter, r.status));
  const live = (r: TimeOffDto) => r.endDate >= today && r.status !== 'REJECTED' && r.status !== 'CANCELLED';
  const upcoming = shown.filter(live).sort((a, b) => a.startDate.localeCompare(b.startDate));
  const past = shown.filter((r) => !live(r));
  const canCancel = (r: TimeOffDto) => isWaiting(r.status) || (r.status === 'APPROVED' && r.endDate >= today);

  const Row = (r: TimeOffDto) => (
    <div key={r.id} className="border border-[#E5E5E0] rounded-md p-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-[13px] font-semibold text-[#171717]">{nice(r.type)} · {r.days} {r.days === 1 ? 'day' : 'days'}</div>
          <div className="text-[12px] text-[#525252]">{range(r.startDate, r.endDate)}</div>
        </div>
        <Pill tone={STATUS_TONE[r.status] ?? 'neutral'}>{STATUS_TEXT[r.status] ?? nice(r.status)}</Pill>
      </div>
      {r.reason && <div className="text-[12px] text-[#6B6B6B] mt-1.5">Your note: {r.reason}</div>}
      {approvalLine(r) && <div className="text-[12px] text-[#525252] mt-1.5">{approvalLine(r)}</div>}
      {r.decisionNote && <div className="text-[12px] text-[#6B6B6B] mt-1">Reply: {r.decisionNote}</div>}
      {canCancel(r) && <div className="mt-2"><button onClick={() => setToCancel(r)} className="text-[12px] font-semibold text-[#BC3F3F] hover:underline">Cancel request</button></div>}
    </div>
  );

  return (
    <div className="space-y-4">
      {err && <Banner kind="err" onClose={() => setErr('')}>{err}</Banner>}
      <div className="grid gap-4 lg:grid-cols-[minmax(0,380px)_minmax(0,1fr)] items-start">
        <div className="space-y-4">
          <Card title="Your balances" sub={`Leave year ${year}`}>
            {data.balances.length === 0 ? <div className="text-[13px] text-[#6B6B6B]">No leave allowance has been set up for you yet.</div> : (
              <div className="space-y-2.5">{data.balances.map((b) => <BalanceCard key={b.type} b={b} pending={pendingOf(b.type)} />)}</div>
            )}
          </Card>

          {!form ? <Btn variant="primary" onClick={() => setForm(true)} className="w-full lg:w-auto">Request time off</Btn> : (
            <Card title="New request">
              <Field label="Type">
                <div className="flex flex-wrap gap-1.5">
                  {TYPES.map((t) => (
                    <button key={t} type="button" onClick={() => setType(t)} aria-pressed={type === t}
                      className={`text-[12px] font-semibold px-2.5 py-1.5 rounded-full border ${type === t ? 'bg-accent text-white border-accent' : 'bg-white text-[#171717] border-[#E5E5E0] hover:bg-[#FAFAF8]'}`}>{nice(t)}</button>
                  ))}
                </div>
              </Field>
              <div className="grid grid-cols-2 gap-3">
                <Field label="From"><Input type="date" value={start} onChange={(e) => { setStart(e.target.value); if (e.target.value > end) setEnd(e.target.value); }} /></Field>
                <Field label="To"><Input type="date" min={start} value={end} onChange={(e) => setEnd(e.target.value)} /></Field>
              </div>
              {end >= start && <div className="text-[12px] text-[#525252]">{range(start, end)}{check ? ` · ${check.days} ${check.days === 1 ? 'day' : 'days'}` : ''}</div>}
              <Field label="Note for your manager (optional)"><Textarea rows={2} value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
              {end < start && <Banner kind="err">The end date is before the start date.</Banner>}
              {end >= start && check && (
                <Banner kind={check.willBeApprovedAutomatically ? 'ok' : 'warn'}>
                  {check.willBeApprovedAutomatically ? 'This will be approved automatically.' : `Needs a manager's approval${check.reasonsForReview.length ? `: ${check.reasonsForReview.join('; ')}` : '.'}`}
                  {check.blockers.length > 0 && <div className="mt-1 text-[#BC3F3F] font-semibold">{check.blockers.join('; ')}</div>}
                </Banner>
              )}
              <div className="flex gap-2">
                <Btn variant="primary" disabled={busy || end < start || !!check?.blockers.length} onClick={submit}>{busy ? 'Submitting…' : 'Submit request'}</Btn>
                <Btn onClick={() => setForm(false)}>Close</Btn>
              </div>
            </Card>
          )}
        </div>

        <Card title="Your requests" actions={data.requests.length > 0 ? (
          <div className="flex flex-wrap gap-1">
            {FILTERS.map(([k, label]) => <button key={k} onClick={() => setFilter(k)} aria-pressed={filter === k} className={`text-[11px] font-semibold px-2 py-1 rounded ${filter === k ? 'bg-[#171717] text-white' : 'text-[#6B6B6B] hover:bg-[#F0F0EC]'}`}>{label}</button>)}
          </div>
        ) : undefined}>
          {data.requests.length === 0 ? (
            <div className="py-6 text-center space-y-3">
              <Empty title="No requests yet">Plan some time off and your requests will be listed here with their status.</Empty>
              {!form && <Btn variant="primary" onClick={() => setForm(true)}>Request time off</Btn>}
            </div>
          ) : shown.length === 0 ? <div className="text-[13px] text-[#6B6B6B]">Nothing matches this filter.</div> : (
            <div className="space-y-4">
              {upcoming.length > 0 && <section><div className="text-[11px] font-semibold uppercase tracking-wider text-[#6B6B6B] mb-2">Upcoming</div><div className="space-y-2">{upcoming.map(Row)}</div></section>}
              {past.length > 0 && <section><div className="text-[11px] font-semibold uppercase tracking-wider text-[#6B6B6B] mb-2">Past and closed</div><div className="space-y-2">{past.map(Row)}</div></section>}
            </div>
          )}
        </Card>
      </div>

      {toCancel && (
        <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4" role="dialog" aria-modal="true" onClick={() => !busy && setToCancel(null)}>
          <div className="bg-white rounded-lg shadow-lg max-w-sm w-full p-5 space-y-3" onClick={(e) => e.stopPropagation()}>
            <div className="text-[15px] font-semibold text-[#171717]">Cancel this request?</div>
            <div className="text-[13px] text-[#525252]">{nice(toCancel.type)}, {range(toCancel.startDate, toCancel.endDate)} ({toCancel.days} {toCancel.days === 1 ? 'day' : 'days'}).{toCancel.status === 'APPROVED' ? ' It is approved, so your days will be given back and your manager will see it was cancelled.' : ''}</div>
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
