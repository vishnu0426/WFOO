/**
 * Approvals: the time-off and swap requests waiting for a team lead (a supervisor, deputy or whoever covers), or for a manager. Each card has what is needed
 * to decide, and Approve / Decline. The gateway applies the same checks as the admin app, so a request that can no longer be approved says why.
 */
import React, { useState } from 'react';
import { api, ApiError } from '../api';
import { ApprovalOff, ApprovalSwap, ApprovalTimeOff, Approvals as ApprovalsDto } from '../types';
import { useLoad, Banner, Btn, Busy, Card, Empty, Pill, Textarea, hm } from '../ui';

const nice = (t: string) => { const s = t.replace(/_/g, ' ').toLowerCase(); return s[0].toUpperCase() + s.slice(1); };
const fmt = (iso: string, year = true) => new Date(`${iso}T00:00:00`).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', ...(year ? { year: 'numeric' as const } : {}) });
const range = (a: string, b: string) => (a === b ? fmt(a) : `${fmt(a, false)} – ${fmt(b)}`);
const waited = (iso: string) => {
  const h = Math.floor((Date.now() - new Date(iso).getTime()) / 3.6e6);
  return h < 1 ? 'Just now' : h < 24 ? `Waiting ${h} h` : `Waiting ${Math.floor(h / 24)} ${Math.floor(h / 24) === 1 ? 'day' : 'days'}`;
};
const dayFull = (iso: string) => new Date(`${iso}T00:00:00`).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });

type Target = { kind: 'timeoff' | 'swap' | 'off'; id: string; who: string; what: string };
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
/** What the person asked for, in a line. */
const offAsked = (r: ApprovalOff) => r.kind === 'WEEKEND_OFF'
  ? `Weekends off together: ${range(r.startDate!, r.endDate!)}`
  : `Standing rule: ${[r.minDaysTogether ? `${r.minDaysTogether} days off together each week` : '', r.minWeekendsMonth ? `${plural(r.minWeekendsMonth, 'full weekend', 'full weekends')} off each month` : ''].filter(Boolean).join(' and ')}`;

export const Approvals: React.FC<{ onChanged?: () => void }> = ({ onChanged }) => {
  const { data, error, loading, reload } = useLoad<ApprovalsDto>('/me/approvals');
  const [sub, setSub] = useState<'timeoff' | 'daysoff' | 'swaps'>('timeoff');
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState('');
  const [note, setNote] = useState('');
  const [declining, setDeclining] = useState<Target | null>(null);
  const [reason, setReason] = useState('');

  const done = (text: string) => { setNote(text); setErr(''); reload(); onChanged?.(); };
  const approve = async (t: Target) => {
    setBusy(t.id); setErr(''); setNote('');
    try {
      if (t.kind === 'timeoff') await api(`/workforce/time-off/${t.id}/decide`, { method: 'POST', body: { status: 'APPROVED' } });
      else if (t.kind === 'off') { const out = await api<{ warnings?: string[] }>(`/workforce/off-requests/${t.id}/decide`, { method: 'POST', body: { status: 'APPROVED' } }); if (out.warnings?.length) { done(`Approved: ${t.who}, ${t.what}. ${out.warnings.join(' ')}`); return; } }
      else await api(`/scheduling/swaps/${t.id}/decide`, { method: 'POST', body: { approve: true } });
      done(`Approved: ${t.who}, ${t.what}.`);
    } catch (e: any) { setErr(e instanceof ApiError ? e.message : 'Could not approve'); reload(); } finally { setBusy(null); }
  };
  const decline = async () => {
    if (!declining) return;
    const t = declining; setBusy(t.id); setErr(''); setNote('');
    try {
      if (t.kind === 'timeoff') await api(`/workforce/time-off/${t.id}/decide`, { method: 'POST', body: { status: 'REJECTED', reason: reason.trim() } });
      else if (t.kind === 'off') await api(`/workforce/off-requests/${t.id}/decide`, { method: 'POST', body: { status: 'REJECTED', reason: reason.trim() } });
      else await api(`/scheduling/swaps/${t.id}/decide`, { method: 'POST', body: { approve: false, reason: reason.trim() } });
      setDeclining(null); setReason(''); done(`Declined: ${t.who}, ${t.what}.`);
    } catch (e: any) { setErr(e instanceof ApiError ? e.message : 'Could not decline'); } finally { setBusy(null); }
  };

  if (loading && !data) return <Busy />;
  if (error) return <Banner kind="err">{error}</Banner>;
  if (!data) return null;
  if (!data.access) return <Empty title="Nothing for you to approve">Requests from the people you lead show up here when you are a team supervisor, deputy or cover, or a manager.</Empty>;

  const offs = data.offRequests ?? [];
  const tabs = [['timeoff', 'Time off', data.timeOff.length], ...(offs.length ? [['daysoff', 'Days off', offs.length] as const] : []), ['swaps', 'Shift swaps', data.swaps.length]] as const;
  const actions = (t: Target) => (
    <div className="flex gap-2 pt-2">
      <Btn variant="primary" disabled={busy === t.id} onClick={() => approve(t)}>{busy === t.id ? 'Working…' : 'Approve'}</Btn>
      <Btn disabled={busy === t.id} onClick={() => { setDeclining(t); setReason(''); setErr(''); }}>Decline</Btn>
    </div>
  );

  const TimeOffCard = (r: ApprovalTimeOff) => {
    const crowded = r.teamSize > 0 && r.teamOff > 0;
    return (
      <div key={r.id} className="border border-[#E5E5E0] rounded-md p-3 space-y-1.5">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="text-[14px] font-semibold text-[#171717]">{r.employeeName}</div>
            <div className="text-[12px] text-[#6B6B6B]">{r.team ?? 'No team'}</div>
          </div>
          <div className="flex items-center gap-1.5 shrink-0">{r.escalated && <Pill tone="bad">Overdue</Pill>}<Pill tone="warn">{waited(r.createdAt)}</Pill></div>
        </div>
        <div className="text-[13px] text-[#171717]"><span className="font-semibold">{nice(r.type)}</span> · {r.days} {r.days === 1 ? 'day' : 'days'}</div>
        <div className="text-[12px] text-[#525252]">{range(r.startDate, r.endDate)}</div>
        {r.reason && <div className="text-[12px] text-[#6B6B6B]">Their note: {r.reason}</div>}
        {r.teamSize > 0 && <div className={`text-[12px] ${crowded ? 'text-[#8F6200] font-medium' : 'text-[#2A7553]'}`}>{crowded ? `${r.teamOff} of ${r.teamSize} teammates are already off in these days` : 'No teammates are off in these days'}</div>}
        {actions({ kind: 'timeoff', id: r.id, who: r.employeeName, what: `${nice(r.type).toLowerCase()} ${range(r.startDate, r.endDate)}` })}
      </div>
    );
  };

  const OffCard = (r: ApprovalOff) => {
    const c = r.context;
    const weigh = !c ? '' : 'weekends' in c
      ? [c.teamSize > 0 ? (c.teamOff > 0 ? `${c.teamOff} of ${c.teamSize} teammates are already off on those days` : 'No teammates are off on those days') : '', c.scheduledShifts ? `${plural(c.scheduledShifts, 'shift', 'shifts')} already scheduled on them` : ''].filter(Boolean).join(' · ')
      : `Their own limits go from ${[r.minDaysTogether ? `${c.now.daysTogether || 'none'} to ${c.after.daysTogether} days together` : '', r.minWeekendsMonth ? `${c.now.weekendsMonth || 'none'} to ${c.after.weekendsMonth} weekends a month` : ''].filter(Boolean).join(' and ')}`;
    const crowded = !!c && 'weekends' in c && c.teamOff > 0;
    return (
      <div key={r.id} className="border border-[#E5E5E0] rounded-md p-3 space-y-1.5">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="text-[14px] font-semibold text-[#171717]">{r.employeeName}</div>
            <div className="text-[12px] text-[#6B6B6B]">{r.team ?? 'No team'}</div>
          </div>
          <div className="flex items-center gap-1.5 shrink-0">{r.escalated && <Pill tone="bad">Overdue</Pill>}<Pill tone="warn">{waited(r.createdAt)}</Pill></div>
        </div>
        <div className="text-[13px] font-semibold text-[#171717]">{offAsked(r)}</div>
        {r.reason && <div className="text-[12px] text-[#6B6B6B]">Their note: {r.reason}</div>}
        {weigh && <div className={`text-[12px] ${crowded ? 'text-[#8F6200] font-medium' : 'text-[#525252]'}`}>{weigh}</div>}
        {actions({ kind: 'off', id: r.id, who: r.employeeName, what: offAsked(r).toLowerCase() })}
      </div>
    );
  };

  const SwapCard = (s: ApprovalSwap) => (
    <div key={s.id} className="border border-[#E5E5E0] rounded-md p-3 space-y-1.5">
      <div className="flex items-start justify-between gap-3">
        <div className="text-[14px] font-semibold text-[#171717]">{s.kind === 'SWAP' ? 'Shift swap' : 'Shift giveaway'}: {s.requesterName}{s.partnerName ? ` and ${s.partnerName}` : ''}</div>
        <div className="flex items-center gap-1.5 shrink-0">{s.escalated && <Pill tone="bad">Overdue</Pill>}<Pill tone="warn">{waited(s.updatedAt)}</Pill></div>
      </div>
      <div className="text-[12px] text-[#525252]"><span className="font-semibold text-[#B7791F]">{s.requesterName} gives</span> {dayFull(s.give.day)}, {hm(s.give.startTime)}–{hm(s.give.endTime)}</div>
      {s.get ? <div className="text-[12px] text-[#525252]"><span className="font-semibold text-[#2F7D5A]">{s.partnerName} gives</span> {dayFull(s.get.day)}, {hm(s.get.startTime)}–{hm(s.get.endTime)}</div>
        : s.partnerName && <div className="text-[12px] text-[#525252]"><span className="font-semibold text-[#2F7D5A]">{s.partnerName} takes it</span></div>}
      {s.note && <div className="text-[12px] text-[#6B6B6B]">Note: {s.note}</div>}
      {s.warnings.length > 0 && <ul className="text-[12px] text-[#8F6200] list-disc ml-4">{s.warnings.map((w, i) => <li key={i}>{w}</li>)}</ul>}
      {actions({ kind: 'swap', id: s.id, who: s.requesterName, what: `shift on ${dayFull(s.give.day)}` })}
    </div>
  );

  return (
    <div className="max-w-3xl space-y-4">
      <div>
        <div className="text-[20px] font-semibold text-[#171717]">Approvals</div>
        <div className="text-[12px] text-[#6B6B6B]">{data.timeOff.length + data.swaps.length + offs.length === 0 ? 'Nothing is waiting for you' : `${data.timeOff.length + data.swaps.length + offs.length} waiting for you, oldest first`}</div>
      </div>
      {note && <Banner kind="ok" onClose={() => setNote('')}>{note}</Banner>}
      {err && <Banner kind="err" onClose={() => setErr('')}>{err}</Banner>}
      <div className="flex gap-1 bg-[#F0F0EC] rounded-md p-1" role="tablist">
        {tabs.map(([k, label, n]) => (
          <button key={k} role="tab" aria-selected={sub === k} onClick={() => setSub(k)} className={`flex-1 text-[12px] font-semibold py-1.5 rounded ${sub === k ? 'bg-white text-[#171717] shadow-xs' : 'text-[#6B6B6B]'}`}>
            {label}{n > 0 && <span className="ml-1.5 inline-block min-w-[16px] px-1 rounded-full bg-[#C84A4A] text-white text-[10px] leading-4">{n}</span>}
          </button>
        ))}
      </div>
      {data.truncated && sub === 'timeoff' && <Banner kind="warn">Only the oldest 100 requests are shown. Decide these and the rest will follow.</Banner>}
      <Card>
        {sub === 'timeoff'
          ? (data.timeOff.length === 0 ? <Empty title="No time-off requests waiting">New requests from your team will show here and in your Inbox.</Empty> : <div className="space-y-2.5">{data.timeOff.map(TimeOffCard)}</div>)
          : sub === 'daysoff' ? (offs.length === 0 ? <Empty title="No days-off requests waiting">Weekends-off requests and standing rules from your team will show here.</Empty> : <div className="space-y-2.5">{offs.map(OffCard)}</div>)
          : (data.swaps.length === 0 ? <Empty title="No swap requests waiting">Swaps that need a decision will show here.</Empty> : <div className="space-y-2.5">{data.swaps.map(SwapCard)}</div>)}
      </Card>

      {declining && (
        <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4" role="dialog" aria-modal="true" onClick={() => busy !== declining.id && setDeclining(null)}>
          <div className="bg-white rounded-lg shadow-lg max-w-sm w-full p-5 space-y-3" onClick={(e) => e.stopPropagation()}>
            <div className="text-[15px] font-semibold text-[#171717]">Decline this request?</div>
            <div className="text-[13px] text-[#525252]">{declining.who}: {declining.what}. Tell them why; they will see it.</div>
            <Textarea rows={3} autoFocus value={reason} onChange={(e) => setReason(e.target.value)} placeholder="For example: too many people are off that week" />
            {err && <Banner kind="err" onClose={() => setErr('')}>{err}</Banner>}
            <div className="flex gap-2 justify-end">
              <Btn onClick={() => setDeclining(null)} disabled={busy === declining.id}>Cancel</Btn>
              <Btn variant="danger" onClick={decline} disabled={busy === declining.id || reason.trim().length < 3}>{busy === declining.id ? 'Declining…' : 'Decline request'}</Btn>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
