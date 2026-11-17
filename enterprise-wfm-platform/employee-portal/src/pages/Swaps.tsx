/** Swaps and giveaways: proposals waiting on you, the open board, your own requests (active first), and starting a new swap or giveaway. */
import React, { useEffect, useState } from 'react';
import { api, ApiError } from '../api';
import { DaySummary, Swap, SwapCandidate } from '../types';
import { useLoad, Banner, Btn, Busy, Card, Empty, Pill, hm, dayLabel, todayIso, addDays } from '../ui';
import { approvalLine } from '../approval';

const STATUS_TONE: Record<string, 'good' | 'bad' | 'warn' | 'neutral' | 'info'> = { OPEN: 'info', PENDING_PARTNER: 'warn', PENDING_APPROVAL: 'warn', APPROVED: 'good', REJECTED: 'bad', FAILED: 'bad', EXPIRED: 'neutral', CANCELLED: 'neutral' };
const STATUS_TEXT: Record<string, string> = { OPEN: 'Open to anyone', PENDING_PARTNER: 'Waiting for your colleague', PENDING_APPROVAL: 'Waiting for approval', APPROVED: 'Approved', REJECTED: 'Declined', FAILED: 'Could not be applied', EXPIRED: 'Expired', CANCELLED: 'Withdrawn' };
const ACTIVE = new Set(['OPEN', 'PENDING_PARTNER', 'PENDING_APPROVAL']);
const dayFull = (iso: string) => new Date(`${iso}T00:00:00`).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });

type Shift = { day: string; startTime: string; endTime: string };
const ShiftLine: React.FC<{ label: string; s: Shift; tone: string }> = ({ label, s, tone }) => (
  <div className="flex items-center gap-2 text-[12px]">
    <span className={`w-12 shrink-0 text-[10px] font-semibold uppercase tracking-wider ${tone}`}>{label}</span>
    <span className="font-semibold text-[#171717]">{dayFull(s.day)}</span>
    <span className="text-[#525252]">{hm(s.startTime)}–{hm(s.endTime)}</span>
  </div>
);

const SwapRow: React.FC<{ s: Swap; mine?: boolean; children?: React.ReactNode }> = ({ s, mine, children }) => (
  <div className="border border-[#E5E5E0] rounded-md p-3 space-y-1.5">
    <div className="flex items-center justify-between gap-2">
      <div className="text-[13px] font-semibold text-[#171717]">{s.kind === 'SWAP' ? 'Shift swap' : 'Shift giveaway'}{!mine && s.requesterName ? ` · from ${s.requesterName}` : ''}</div>
      <Pill tone={STATUS_TONE[s.status] ?? 'neutral'}>{STATUS_TEXT[s.status] ?? s.status.replace(/_/g, ' ').toLowerCase()}</Pill>
    </div>
    <ShiftLine label={mine ? 'You give' : 'Gives'} s={s.give} tone="text-[#B7791F]" />
    {s.get && <ShiftLine label={mine ? 'You get' : 'Wants'} s={s.get} tone="text-[#2F7D5A]" />}
    {mine && s.kind === 'SWAP' && s.partnerName && <div className="text-[11px] text-[#6B6B6B]">With {s.partnerName}</div>}
    {s.note && <div className="text-[11px] text-[#6B6B6B]">Note: {s.note}</div>}
    {s.decisionReason && <div className="text-[11px] text-[#6B6B6B]">{s.decisionReason}</div>}
    {approvalLine(s) && <div className="text-[11px] text-[#525252]">{approvalLine(s)}</div>}
    {children}
  </div>
);

const NewRequest: React.FC<{ initialShiftId?: string; onDone: () => void; onClose: () => void }> = ({ initialShiftId, onDone, onClose }) => {
  const from = todayIso();
  const to = addDays(from, 21);
  const { data } = useLoad<{ days: DaySummary[] }>(`/me/schedule?from=${from}&to=${to}`);
  const [shiftId, setShiftId] = useState(initialShiftId ?? '');
  const [candidates, setCandidates] = useState<SwapCandidate[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const upcoming = (data?.days ?? []).filter((d) => d.shift && !d.timeOff && !d.swap).map((d) => d.shift!);
  const chosen = upcoming.find((s) => s.id === shiftId);

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
    <Card title="Swap or give away a shift" sub={!shiftId ? 'Step 1 of 2 · choose the shift you want to hand over' : candidates === null ? 'Step 2 of 2 · how do you want to do it?' : 'Step 2 of 2 · pick who to swap with'}>
      {err && <Banner kind="err" onClose={() => setErr('')}>{err}</Banner>}
      {chosen && <div className="rounded-md bg-[#F5F5F2] px-3 py-2 text-[13px] text-[#171717]">Your shift: <span className="font-semibold">{dayFull(chosen.day)} · {hm(chosen.startTime)}–{hm(chosen.endTime)}</span></div>}
      {!shiftId ? (
        <>
          {data && upcoming.length === 0 ? <Empty title="No upcoming shifts to swap">Only published shifts in the next three weeks that are not already on leave or in a request can be swapped.</Empty> : (
            <div className="space-y-1.5">
              {upcoming.map((s) => (
                <button key={s.id} onClick={() => setShiftId(s.id)} className="w-full text-left border border-[#E5E5E0] rounded-md px-3 py-2 text-[13px] hover:bg-[#FAFAF8] flex items-center justify-between gap-3">
                  <span className="font-semibold text-[#171717]">{dayFull(s.day)}</span><span className="text-[#525252]">{hm(s.startTime)}–{hm(s.endTime)}</span>
                </button>
              ))}
            </div>
          )}
          <Btn onClick={onClose}>Close</Btn>
        </>
      ) : candidates === null ? (
        <div className="flex flex-col gap-2">
          <Btn variant="primary" disabled={busy} onClick={findPartners}>{busy ? 'Looking…' : 'Swap with a colleague (you get one of theirs)'}</Btn>
          <Btn disabled={busy} onClick={giveAway}>Give it away (anyone eligible can take it)</Btn>
          <Btn onClick={() => { setShiftId(''); setErr(''); }}>Back</Btn>
        </div>
      ) : (
        <div className="space-y-1.5">
          {candidates.length === 0 ? <Empty title="No one can take this shift right now">You can still give it away so anyone eligible can pick it up.</Empty> : candidates.map((c) => (
            <div key={c.shiftId} className="border border-[#E5E5E0] rounded-md p-3 flex items-center justify-between gap-3">
              <div className="min-w-0">
                <div className="text-[13px] font-semibold text-[#171717]">{c.name}</div>
                <div className="text-[12px] text-[#6B6B6B]">You would get {dayFull(c.day)} · {hm(c.startTime)}–{hm(c.endTime)}</div>
                {c.verdict.warnings.length > 0 && <div className="text-[11px] text-[#8F6200]">{c.verdict.warnings.join('; ')}</div>}
                {!c.verdict.ok && <div className="text-[11px] text-[#BC3F3F]">Not possible with this person.</div>}
              </div>
              <Btn variant="primary" disabled={busy || !c.verdict.ok} onClick={() => swapWith(c.shiftId)}>Ask</Btn>
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
  const [busy, setBusy] = useState(false);
  const [toWithdraw, setToWithdraw] = useState<Swap | null>(null);

  // Capture the incoming id into local state (rather than reading the prop again from NewRequest) because
  // onConsumed clears it in the same batch -- by the time NewRequest would mount, the prop is already undefined.
  useEffect(() => { if (initialShiftId) { setNewShiftId(initialShiftId); setShowNew(true); onConsumed?.(); } }, [initialShiftId]);

  const act = async (path: string) => {
    setBusy(true);
    try { await api(path, { method: 'POST' }); reload(); } catch (e: any) { setErr(e instanceof ApiError ? e.message : 'Could not complete that'); } finally { setBusy(false); }
  };
  const withdraw = async () => { if (!toWithdraw) return; const id = toWithdraw.id; setToWithdraw(null); await act(`/me/swaps/${id}/cancel`); };

  if (loading && !data) return <Busy />;
  if (error) return <Banner kind="err">{error}</Banner>;
  if (!data) return null;

  const active = data.mine.filter((s) => ACTIVE.has(s.status)), closed = data.mine.filter((s) => !ACTIVE.has(s.status));
  const canWithdraw = (s: Swap) => s.status === 'OPEN' || s.status === 'PENDING_PARTNER';

  return (
    <div className="space-y-4">
      {err && <Banner kind="err" onClose={() => setErr('')}>{err}</Banner>}
      <div className="grid gap-4 lg:grid-cols-2 items-start">
        <div className="space-y-4">
          {!showNew ? <Btn variant="primary" className="w-full lg:w-auto" onClick={() => setShowNew(true)}>Swap or give away a shift</Btn>
            : <NewRequest initialShiftId={newShiftId} onClose={() => { setShowNew(false); setNewShiftId(undefined); }} onDone={() => { setShowNew(false); setNewShiftId(undefined); reload(); }} />}

          {data.incoming.length > 0 && (
            <Card title="Waiting on you" sub="A colleague has asked you to take or swap a shift">
              <div className="space-y-2">{data.incoming.map((s) => (
                <SwapRow key={s.id} s={s}>
                  <div className="flex gap-2 pt-1">
                    <Btn variant="primary" disabled={busy} onClick={() => act(`/me/swaps/${s.id}/accept`)}>Accept</Btn>
                    <Btn disabled={busy} onClick={() => act(`/me/swaps/${s.id}/decline`)}>Decline</Btn>
                  </div>
                </SwapRow>
              ))}</div>
            </Card>
          )}

          <Card title="Open board" sub="Shifts colleagues have given away. Take one to add it to your schedule">
            {data.board.length === 0 ? <Empty title="Nothing open right now">When a colleague gives a shift away, it will show here.</Empty> : (
              <div className="space-y-2">{data.board.map((s) => (
                <SwapRow key={s.id} s={s}><Btn variant="primary" className="mt-1" disabled={busy} onClick={() => act(`/me/swaps/${s.id}/take`)}>Take this shift</Btn></SwapRow>
              ))}</div>
            )}
          </Card>
        </div>

        <Card title="Your requests">
          {data.mine.length === 0 ? <Empty title="No requests yet">Swaps and giveaways you start will be listed here with where they stand.</Empty> : (
            <div className="space-y-4">
              {active.length > 0 && <section><div className="text-[11px] font-semibold uppercase tracking-wider text-[#6B6B6B] mb-2">In progress</div><div className="space-y-2">{active.map((s) => (
                <SwapRow key={s.id} s={s} mine>{canWithdraw(s) && <button onClick={() => setToWithdraw(s)} className="text-[12px] font-semibold text-[#BC3F3F] hover:underline">Withdraw request</button>}</SwapRow>
              ))}</div></section>}
              {closed.length > 0 && <section><div className="text-[11px] font-semibold uppercase tracking-wider text-[#6B6B6B] mb-2">Finished</div><div className="space-y-2">{closed.map((s) => <SwapRow key={s.id} s={s} mine />)}</div></section>}
            </div>
          )}
        </Card>
      </div>

      {toWithdraw && (
        <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4" role="dialog" aria-modal="true" onClick={() => setToWithdraw(null)}>
          <div className="bg-white rounded-lg shadow-lg max-w-sm w-full p-5 space-y-3" onClick={(e) => e.stopPropagation()}>
            <div className="text-[15px] font-semibold text-[#171717]">Withdraw this request?</div>
            <div className="text-[13px] text-[#525252]">Your shift on {dayFull(toWithdraw.give.day)} stays as it is, and {toWithdraw.partnerName ? toWithdraw.partnerName : 'nobody'} will no longer be asked.</div>
            <div className="flex gap-2 justify-end"><Btn onClick={() => setToWithdraw(null)}>Keep it</Btn><Btn variant="danger" onClick={withdraw}>Withdraw</Btn></div>
          </div>
        </div>
      )}
    </div>
  );
};
