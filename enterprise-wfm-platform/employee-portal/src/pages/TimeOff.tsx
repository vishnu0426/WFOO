/** Balances, a request form with a live "would this be auto-approved" preview, and your request history. */
import React, { useEffect, useState } from 'react';
import { api, ApiError } from '../api';
import { TimeOff as TimeOffDto, TimeOffBalance, TimeOffCheck, TimeOffRules, TimeOffType } from '../types';
import { useLoad, Banner, Btn, Busy, Card, Empty, Field, Input, Pill, Select, Textarea, todayIso } from '../ui';

const TYPES: TimeOffType[] = ['VACATION', 'SICK', 'PERSONAL', 'HOLIDAY', 'TRAINING', 'LEAVE', 'OTHER'];
const STATUS_TONE: Record<string, 'good' | 'bad' | 'warn' | 'neutral'> = { APPROVED: 'good', REJECTED: 'bad', CANCELLED: 'neutral', PENDING: 'warn' };

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
  const cancel = async (id: string) => {
    if (!confirm('Cancel this request?')) return;
    try { await api(`/me/time-off/${id}/cancel`, { method: 'POST' }); reload(); } catch (e: any) { setErr(e instanceof ApiError ? e.message : 'Could not cancel'); }
  };

  if (loading && !data) return <Busy />;
  if (error) return <Banner kind="err">{error}</Banner>;
  if (!data) return null;

  return (
    <div className="space-y-4">
      {err && <Banner kind="err" onClose={() => setErr('')}>{err}</Banner>}
      <Card title="Balances">
        <div className="grid grid-cols-2 gap-2">
          {data.balances.map((b) => (
            <div key={b.type} className="border border-[#E5E5E0] rounded-md p-2.5">
              <div className="text-[11px] text-[#737373]">{b.type.replace(/_/g, ' ').toLowerCase()}</div>
              <div className="text-[15px] font-semibold text-[#171717]">{b.remainingDays}<span className="text-[11px] font-normal text-[#737373]"> / {b.entitledDays}d left</span></div>
            </div>
          ))}
        </div>
      </Card>

      {!form ? <Btn variant="primary" onClick={() => setForm(true)} className="w-full">Request time off</Btn> : (
        <Card title="New request">
          <Field label="Type"><Select value={type} onChange={(e) => setType(e.target.value as TimeOffType)}>{TYPES.map((t) => <option key={t} value={t}>{t.replace(/_/g, ' ')}</option>)}</Select></Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Start"><Input type="date" value={start} onChange={(e) => { setStart(e.target.value); if (e.target.value > end) setEnd(e.target.value); }} /></Field>
            <Field label="End"><Input type="date" min={start} value={end} onChange={(e) => setEnd(e.target.value)} /></Field>
          </div>
          <Field label="Reason (optional)"><Textarea rows={2} value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
          {check && (
            <Banner kind={check.willBeApprovedAutomatically ? 'ok' : 'warn'}>
              {check.days} day{check.days === 1 ? '' : 's'}. {check.willBeApprovedAutomatically ? 'This will be approved automatically.' : `Needs a manager's approval${check.reasonsForReview.length ? `: ${check.reasonsForReview.join('; ')}` : '.'}`}
              {check.blockers.length > 0 && <div className="mt-1 text-[#C84A4A] font-semibold">{check.blockers.join('; ')}</div>}
            </Banner>
          )}
          <div className="flex gap-2">
            <Btn variant="primary" disabled={busy || !!check?.blockers.length} onClick={submit}>{busy ? 'Submitting…' : 'Submit request'}</Btn>
            <Btn onClick={() => setForm(false)}>Cancel</Btn>
          </div>
        </Card>
      )}

      <Card title="History">
        {data.requests.length === 0 ? <Empty title="No requests yet" /> : (
          <div className="space-y-2">
            {data.requests.map((r) => (
              <div key={r.id} className="border border-[#E5E5E0] rounded-md p-2.5">
                <div className="flex items-center justify-between">
                  <div className="text-[13px] font-semibold text-[#171717]">{r.type.replace(/_/g, ' ').toLowerCase()} · {r.days}d</div>
                  <Pill tone={STATUS_TONE[r.status] ?? 'neutral'}>{r.status.toLowerCase()}</Pill>
                </div>
                <div className="text-[12px] text-[#737373]">{r.startDate} – {r.endDate}</div>
                {r.decisionNote && <div className="text-[12px] text-[#737373] mt-1">{r.decisionNote}</div>}
                {(r.status === 'PENDING' || r.status === 'APPROVED') && <button onClick={() => cancel(r.id)} className="text-[11px] text-[#C84A4A] underline mt-1">Cancel</button>}
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
};
