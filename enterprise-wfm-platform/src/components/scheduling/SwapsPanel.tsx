/**
 * Scheduling › Shift Swaps. Colleagues trade shifts in the app (a swap with a named person, or a shift offered on the board).
 * Each change is tried on a copy of the published schedule first, with the scheduler's own rules and the labour-law pack, so this list
 * shows what would happen: problems that would stop it, warnings, and the effect on cover. Clean changes can be approved automatically
 * (Configuration › Self-Service Rules); the rest wait here.
 */
import React, { useState } from 'react';
import { Check, X } from 'lucide-react';
import { api, dec, when } from '../../services/api';
import { useForecast } from '../../services/forecastStore';
import { useApi } from '../forecasting/hooks';
import { Banner, Btn, Busy, Card, Empty, Pill } from '../forecasting/ui';

type Verdict = { ok: boolean; auto: boolean; blockers: string[]; warnings: string[]; extraGapSlots: number; coverageBefore: number; coverageAfter: number };
type Shift = { shiftId: string; day: string; startTime: string; endTime: string };
type Swap = {
  id: string; kind: 'SWAP' | 'GIVEAWAY'; status: string; note: string; versionName: string; requesterName: string; partnerName: string | null; give: Shift; get: Shift | null;
  decisionReason: string | null; decidedBy: string | null; decidedAt: string | null; autoApproved: boolean; checks: Partial<Verdict>; createdAt: string; updatedAt: string;
};
const STATUS: Record<string, { label: string; tone: 'good' | 'warn' | 'bad' | 'info' | 'neutral' }> = {
  OPEN: { label: 'On the board', tone: 'info' }, PENDING_PARTNER: { label: 'Waiting for colleague', tone: 'neutral' }, PENDING_APPROVAL: { label: 'Needs approval', tone: 'warn' },
  APPROVED: { label: 'Approved', tone: 'good' }, REJECTED: { label: 'Declined', tone: 'bad' }, CANCELLED: { label: 'Withdrawn', tone: 'neutral' }, EXPIRED: { label: 'Expired', tone: 'neutral' }, FAILED: { label: 'Not possible', tone: 'bad' },
};
const day = (d: string) => new Date(d + 'T00:00:00').toLocaleDateString('en', { weekday: 'short', month: 'short', day: 'numeric' });

export const SwapsPanel: React.FC = () => {
  const { can } = useForecast();
  const [filter, setFilter] = useState<'PENDING_APPROVAL' | ''>('PENDING_APPROVAL');
  const [tick, setTick] = useState(0);
  const list = useApi<Swap[]>(`/scheduling/swaps${filter ? `?status=${filter}` : ''}`, [tick]);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const canDecide = can('schedule:edit');

  const decide = async (s: Swap, approve: boolean) => {
    let reason = '';
    if (!approve) { reason = (prompt('Why is this being declined? The people involved will see it.') ?? '').trim(); if (reason.length < 3) return; }
    setBusy(s.id); setError(''); setNotice('');
    try { await api(`/scheduling/swaps/${s.id}/decide`, { method: 'POST', body: { approve, reason } }); setNotice(approve ? 'Approved. The published schedule has been updated.' : 'Declined.'); setTick((t) => t + 1); }
    catch (e: any) { setError(e.message); } finally { setBusy(''); }
  };

  return (
    <div className="space-y-6">
      {error && <Banner kind="err" onClose={() => setError('')}>{error}</Banner>}
      {notice && <Banner kind="ok" onClose={() => setNotice('')}>{notice}</Banner>}
      <Card title="Shift swaps" sub="Requests from colleagues to trade shifts. Approving changes the published schedule and tells both people."
        actions={<div className="flex rounded border border-[#E5E5E0] bg-[#FAFAF8] p-0.5 text-[12px]">
          {([['PENDING_APPROVAL', 'Needs approval'], ['', 'All requests']] as const).map(([id, label]) => (
            <button key={id} onClick={() => setFilter(id)} className={`px-3 py-1.5 rounded font-semibold ${filter === id ? 'bg-white shadow-xs text-[#171717]' : 'text-[#737373]'}`}>{label}</button>
          ))}
        </div>}>
        {list.loading && !list.data && <Busy text="Loading…" />}
        {list.error && <Banner kind="err">{list.error}</Banner>}
        {list.data && list.data.length === 0 && <Empty title={filter ? 'Nothing is waiting' : 'No swap requests yet'}>{filter ? 'Requests that need a manager show up here.' : 'When colleagues trade shifts in the app, the requests are listed here.'}</Empty>}
        <div className="space-y-3">
          {(list.data ?? []).map((s) => {
            const c = s.checks ?? {}, st = STATUS[s.status] ?? { label: s.status, tone: 'neutral' as const };
            return (
              <div key={s.id} className="border border-[#E5E5E0] rounded-lg p-4 space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="flex items-center gap-2 flex-wrap">
                    <Pill tone={st.tone}>{st.label}</Pill>
                    <span className="font-semibold text-[14px]">{s.kind === 'SWAP' ? `${s.requesterName} and ${s.partnerName}` : `${s.requesterName} gives away a shift${s.partnerName ? ` to ${s.partnerName}` : ''}`}</span>
                    {s.autoApproved && <Pill tone="info">Approved by the rules</Pill>}
                  </div>
                  <span className="text-[11px] text-[#737373]">{when(s.updatedAt)} · {s.versionName}</span>
                </div>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-[13px]">
                  <div className="p-2.5 rounded bg-[#FAFAF8] border border-[#E5E5E0]"><div className="text-[11px] text-[#737373]">{s.requesterName} works</div><div className="font-medium">{day(s.give.day)} · {s.give.startTime}–{s.give.endTime}</div></div>
                  {s.get && <div className="p-2.5 rounded bg-[#FAFAF8] border border-[#E5E5E0]"><div className="text-[11px] text-[#737373]">{s.partnerName} works</div><div className="font-medium">{day(s.get.day)} · {s.get.startTime}–{s.get.endTime}</div></div>}
                </div>
                {s.note && <p className="text-[12px] text-[#525252]">“{s.note}”</p>}
                {(c.blockers?.length || c.warnings?.length || c.coverageBefore !== undefined) && (
                  <div className="text-[12px] space-y-1">
                    {c.blockers?.map((m, i) => <div key={i} className="text-[#C84A4A]">✕ {m}</div>)}
                    {c.warnings?.map((m, i) => <div key={i} className="text-[#B7791F]">! {m}</div>)}
                    {c.ok && !c.warnings?.length && <div className="text-[#2F7D5A]">✓ Every rule is met</div>}
                    {c.coverageBefore !== undefined && <div className="text-[#737373]">Coverage {dec(c.coverageBefore)}% to {dec(c.coverageAfter ?? c.coverageBefore)}%</div>}
                  </div>
                )}
                {s.decisionReason && <p className="text-[12px] text-[#525252]">{s.decidedBy ? `${s.decidedBy}: ` : ''}{s.decisionReason}</p>}
                {s.status === 'PENDING_APPROVAL' && canDecide && (
                  <div className="flex gap-2">
                    <Btn variant="primary" disabled={busy === s.id || c.ok === false} onClick={() => decide(s, true)}><Check className="w-3.5 h-3.5" />Approve</Btn>
                    <Btn disabled={busy === s.id} onClick={() => decide(s, false)}><X className="w-3.5 h-3.5" />Decline</Btn>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </Card>
    </div>
  );
};
