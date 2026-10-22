/** Incoming proposals to answer, your own requests, the open board, and starting a new swap or giveaway. */
import React, { useEffect, useState } from 'react';
import { api, ApiError } from '../api';
import { DaySummary, Swap, SwapCandidate } from '../types';
import { useLoad, Banner, Btn, Busy, Card, Empty, Pill, hm, dayLabel, todayIso, addDays } from '../ui';

const STATUS_TONE: Record<string, 'good' | 'bad' | 'warn' | 'neutral' | 'info'> = { OPEN: 'info', PENDING_PARTNER: 'warn', PENDING_APPROVAL: 'warn', APPROVED: 'good', REJECTED: 'bad', FAILED: 'bad', EXPIRED: 'neutral', CANCELLED: 'neutral' };

const SwapRow: React.FC<{ s: Swap; children?: React.ReactNode }> = ({ s, children }) => (
  <div className="border border-[#E5E5E0] rounded-md p-2.5 space-y-1">
    <div className="flex items-center justify-between">
      <div className="text-[13px] font-semibold text-[#171717]">{s.kind === 'SWAP' ? 'Swap' : 'Giveaway'}</div>
      <Pill tone={STATUS_TONE[s.status] ?? 'neutral'}>{s.status.replace(/_/g, ' ').toLowerCase()}</Pill>
    </div>
    <div className="text-[12px] text-[#525252]">Give: {dayLabel(s.give.day)}, {hm(s.give.startTime)}–{hm(s.give.endTime)}</div>
    {s.get && <div className="text-[12px] text-[#525252]">Get: {dayLabel(s.get.day)}, {hm(s.get.startTime)}–{hm(s.get.endTime)}</div>}
    {s.requesterName && <div className="text-[11px] text-[#737373]">From {s.requesterName}</div>}
    {s.decisionReason && <div className="text-[11px] text-[#737373]">{s.decisionReason}</div>}
    {children}
  </div>
);

const NewRequest: React.FC<{ initialShiftId?: string; onDone: () => void }> = ({ initialShiftId, onDone }) => {
  const from = todayIso();
  const to = addDays(from, 21);
  const { data } = useLoad<{ days: DaySummary[] }>(`/me/schedule?from=${from}&to=${to}`);
  const [shiftId, setShiftId] = useState(initialShiftId ?? '');
  const [candidates, setCandidates] = useState<SwapCandidate[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const upcoming = (data?.days ?? []).filter((d) => d.shift && !d.timeOff && !d.swap).map((d) => d.shift!);

  const findPartners = async () => {
    setBusy(true); setErr(''); setCandidates(null);
    try { setCandidates(await api<SwapCandidate[]>(`/me/swaps/candidates?shiftId=${shiftId}`)); } catch (e: any) { setErr(e instanceof ApiError ? e.message : 'Could not load candidates'); } finally { setBusy(false); }
  };
  const giveAway = async () => {
    setBusy(true); setErr('');
    try { await api('/me/swaps', { method: 'POST', body: { kind: 'GIVEAWAY', shiftId } }); onDone(); } catch (e: any) { setErr(e instanceof ApiError ? e.message : 'Could not submit'); } finally { setBusy(false); }
  };
  const swapWith = async (partnerShiftId: string) => {
    setBusy(true); setErr('');
    try { await api('/me/swaps', { method: 'POST', body: { kind: 'SWAP', shiftId, partnerShiftId } }); onDone(); } catch (e: any) { setErr(e instanceof ApiError ? e.message : 'Could not submit'); } finally { setBusy(false); }
  };

  return (
    <Card title="New request">
      {err && <Banner kind="err" onClose={() => setErr('')}>{err}</Banner>}
      {!shiftId ? (
        upcoming.length === 0 ? <Empty title="No upcoming shifts to swap" /> : (
          <div className="space-y-1.5">
            <div className="text-[12px] text-[#737373]">Which of your shifts?</div>
            {upcoming.map((s) => (
              <button key={s.id} onClick={() => setShiftId(s.id)} className="w-full text-left border border-[#E5E5E0] rounded-md p-2 text-[13px] hover:bg-[#FAFAF8]">
                {dayLabel(s.day)} · {hm(s.startTime)}–{hm(s.endTime)}
              </button>
            ))}
          </div>
        )
      ) : candidates === null ? (
        <div className="flex flex-col gap-2">
          <Btn variant="primary" disabled={busy} onClick={findPartners}>{busy ? 'Looking…' : 'Find someone to swap with'}</Btn>
          <Btn disabled={busy} onClick={giveAway}>Give it away instead (open to anyone)</Btn>
          <Btn onClick={() => setShiftId('')}>Back</Btn>
        </div>
      ) : (
        <div className="space-y-1.5">
          {candidates.length === 0 ? <Empty title="No one else can take this shift right now" /> : candidates.map((c) => (
            <div key={c.shiftId} className="border border-[#E5E5E0] rounded-md p-2 flex items-center justify-between gap-2">
              <div>
                <div className="text-[13px] font-semibold text-[#171717]">{c.name}</div>
                <div className="text-[12px] text-[#737373]">{dayLabel(c.day)} · {hm(c.startTime)}–{hm(c.endTime)}</div>
                {c.verdict.warnings.length > 0 && <div className="text-[11px] text-[#B7791F]">{c.verdict.warnings.join('; ')}</div>}
              </div>
              <Btn variant="primary" disabled={busy || !c.verdict.ok} onClick={() => swapWith(c.shiftId)}>Request</Btn>
            </div>
          ))}
          <Btn onClick={() => setCandidates(null)}>Back</Btn>
        </div>
      )}
    </Card>
  );
};

export const Swaps: React.FC<{ initialShiftId?: string; onConsumed?: () => void }> = ({ initialShiftId, onConsumed }) => {
  const { data, error, loading, reload } = useLoad<{ mine: Swap[]; incoming: Swap[]; board: Swap[] }>('/me/swaps');
  const [showNew, setShowNew] = useState(false);
  const [newShiftId, setNewShiftId] = useState<string | undefined>(undefined);
  const [err, setErr] = useState('');

  // Capture the incoming id into local state (rather than reading the prop again from NewRequest) because
  // onConsumed clears it in the same batch -- by the time NewRequest would mount, the prop is already undefined.
  useEffect(() => { if (initialShiftId) { setNewShiftId(initialShiftId); setShowNew(true); onConsumed?.(); } }, [initialShiftId]);

  const act = async (path: string) => {
    try { await api(path, { method: 'POST' }); reload(); } catch (e: any) { setErr(e instanceof ApiError ? e.message : 'Could not complete that'); }
  };

  if (loading && !data) return <Busy />;
  if (error) return <Banner kind="err">{error}</Banner>;
  if (!data) return null;

  return (
    <div className="space-y-4">
      {err && <Banner kind="err" onClose={() => setErr('')}>{err}</Banner>}
      {!showNew ? <Btn variant="primary" className="w-full" onClick={() => setShowNew(true)}>Swap or give away a shift</Btn> : <NewRequest initialShiftId={newShiftId} onDone={() => { setShowNew(false); setNewShiftId(undefined); reload(); }} />}

      {data.incoming.length > 0 && (
        <Card title="Waiting on you">
          <div className="space-y-2">{data.incoming.map((s) => (
            <SwapRow key={s.id} s={s}>
              <div className="flex gap-2 pt-1">
                <Btn variant="primary" onClick={() => act(`/me/swaps/${s.id}/accept`)}>Accept</Btn>
                <Btn onClick={() => act(`/me/swaps/${s.id}/decline`)}>Decline</Btn>
              </div>
            </SwapRow>
          ))}</div>
        </Card>
      )}

      <Card title="Open board">
        {data.board.length === 0 ? <Empty title="Nothing open right now" /> : (
          <div className="space-y-2">{data.board.map((s) => (
            <SwapRow key={s.id} s={s}><Btn variant="primary" className="mt-1" onClick={() => act(`/me/swaps/${s.id}/take`)}>Take this shift</Btn></SwapRow>
          ))}</div>
        )}
      </Card>

      <Card title="My requests">
        {data.mine.length === 0 ? <Empty title="No requests yet" /> : (
          <div className="space-y-2">{data.mine.map((s) => (
            <SwapRow key={s.id} s={s}>
              {(s.status === 'OPEN' || s.status === 'PENDING_PARTNER') && <button onClick={() => act(`/me/swaps/${s.id}/cancel`)} className="text-[11px] text-[#C84A4A] underline mt-1">Withdraw</button>}
            </SwapRow>
          ))}</div>
        )}
      </Card>
    </div>
  );
};
