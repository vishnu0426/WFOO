/** VTO/overtime offers to accept or decline, and open shift-bidding rounds to rank. */
import React, { useEffect, useState } from 'react';
import { api, ApiError } from '../api';
import { Bid, BidPattern, Offer } from '../types';
import { useLoad, Banner, Btn, Busy, Card, Empty, Pill, hm, dayLabel } from '../ui';

const OFFER_STATUS: Record<string, string> = { INVITED: 'Waiting for your answer', QUEUED: 'On the waiting list', ACCEPTED: 'You accepted', DECLINED: 'You declined' };
const dayFull = (iso: string) => new Date(`${iso}T00:00:00`).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });

const OfferCard: React.FC<{ o: Offer; onDone: () => void }> = ({ o, onDone }) => {
  const [busy, setBusy] = useState(false); const [err, setErr] = useState('');
  const act = async (path: string) => { setBusy(true); setErr(''); try { await api(path, { method: 'POST' }); onDone(); } catch (e: any) { setErr(e instanceof ApiError ? e.message : 'Could not complete that'); } finally { setBusy(false); } };
  const open = o.myStatus === 'INVITED' || o.myStatus === 'QUEUED';
  return (
    <div className="border border-[#E5E5E0] rounded-md p-3 space-y-1.5">
      <div className="flex items-center justify-between gap-2">
        <div className="text-[13px] font-semibold text-[#171717]">{o.kind === 'VTO' ? 'Voluntary time off' : 'Extra hours (overtime)'}</div>
        <Pill tone={o.myStatus === 'ACCEPTED' ? 'good' : o.myStatus === 'DECLINED' ? 'neutral' : 'info'}>{OFFER_STATUS[o.myStatus] ?? o.myStatus.toLowerCase()}</Pill>
      </div>
      <div className="text-[12px] text-[#525252]">{dayFull(o.day)} · {hm(o.startTime)}–{hm(o.endTime)}</div>
      {o.note && <div className="text-[12px] text-[#6B6B6B]">{o.note}</div>}
      {err && <div className="text-[11px] text-[#BC3F3F]">{err}</div>}
      {open && <div className="flex gap-2 pt-1"><Btn variant="primary" disabled={busy} onClick={() => act(`/me/offers/${o.id}/accept`)}>{o.kind === 'VTO' ? 'Take the time off' : 'Accept the extra hours'}</Btn><Btn disabled={busy} onClick={() => act(`/me/offers/${o.id}/decline`)}>Decline</Btn></div>}
    </div>
  );
};

const METHOD_TEXT: Record<string, string> = { SENIORITY: 'seniority', LOTTERY: 'a lottery' };
const closesText = (iso: string | null) => (iso ? new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : null);

const PatternInfo: React.FC<{ p: BidPattern }> = ({ p }) => (
  <div className="space-y-0.5 min-w-0">
    <div className="text-[13px] font-semibold text-[#171717]">{p.name}</div>
    <div className="text-[12px] text-[#525252]">{hm(p.startTime)}–{hm(p.endTime)}{p.overnight ? ' (ends after midnight)' : ''} · {p.paidHours} h paid</div>
    <div className="flex flex-wrap gap-1 pt-0.5">{p.days.map((d) => <span key={d} className="text-[10px] font-semibold px-1.5 py-0.5 rounded bg-[#F5F5F2] text-[#525252] border border-[#E5E5E0]">{d}</span>)}</div>
  </div>
);

const BidCard: React.FC<{ b: Bid; onDone: () => void }> = ({ b, onDone }) => {
  const [ranking, setRanking] = useState<string[]>(b.myRanking);
  useEffect(() => setRanking(b.myRanking), [b.id, b.myRanking]);
  const [busy, setBusy] = useState(false); const [err, setErr] = useState(''); const [saved, setSaved] = useState(false);
  const byId = new Map(b.patterns.map((p) => [p.id, p]));
  const unranked = b.patterns.filter((p) => !ranking.includes(p.id));
  const changed = ranking.join() !== b.myRanking.join();
  const edit = (next: string[]) => { setRanking(next); setSaved(false); };
  const move = (i: number, d: number) => { const next = [...ranking]; const [x] = next.splice(i, 1); next.splice(i + d, 0, x); edit(next); };

  const save = async () => {
    setBusy(true); setErr(''); setSaved(false);
    try { await api(`/me/bids/${b.id}/ranking`, { method: 'PUT', body: { patternIds: ranking } }); setSaved(true); onDone(); } catch (e: any) { setErr(e instanceof ApiError ? e.message : 'Could not save'); } finally { setBusy(false); }
  };

  const closes = closesText(b.closesAt);
  const decidedBy = METHOD_TEXT[b.method] ?? 'the best overall outcome';
  return (
    <Card title={b.name} sub={`${b.weeks} week${b.weeks === 1 ? '' : 's'} from ${dayLabel(b.periodStart)}${closes ? ` · closes ${closes}` : ''}`}>
      {b.status === 'AWARDED' ? (
        b.myAward?.patternName
          ? <Banner kind="ok">You got “{b.myAward.patternName}”{b.myAward.rank ? ` (your choice ${b.myAward.rank})` : ' (a pattern that was left over)'}. It becomes final when the schedule is published.</Banner>
          : <Banner kind="warn">No pattern could be given to you. Your manager will be in touch.</Banner>
      ) : b.status === 'CLOSED' ? <Banner kind="warn">Bidding is closed and your ranking is final. The result is being decided.</Banner> : (
        <>
          <p className="text-[12px] text-[#525252]">Put the patterns in the order you would like them, best first. It is decided by {decidedBy}. You can change your ranking until bidding closes.</p>
          {err && <Banner kind="err" onClose={() => setErr('')}>{err}</Banner>}
          <div className="text-[11px] font-semibold text-[#6B6B6B] uppercase tracking-wider">Your ranking</div>
          {ranking.length === 0 ? <div className="text-[12px] text-[#6B6B6B] py-1">Nothing ranked yet. Add patterns below.</div> : ranking.map((id, i) => {
            const p = byId.get(id); if (!p) return null;
            return (
              <div key={id} className="flex items-start gap-3 border border-[#E5E5E0] rounded-md p-2.5">
                <span className="w-6 h-6 shrink-0 rounded-full bg-[#171717] text-white text-[12px] font-bold flex items-center justify-center" aria-hidden>{i + 1}</span>
                <div className="flex-1 min-w-0"><PatternInfo p={p} /></div>
                <span className="flex gap-1 shrink-0">
                  <button disabled={i === 0} onClick={() => move(i, -1)} aria-label={`Move ${p.name} up`} className="px-1.5 disabled:opacity-30">↑</button>
                  <button disabled={i === ranking.length - 1} onClick={() => move(i, 1)} aria-label={`Move ${p.name} down`} className="px-1.5 disabled:opacity-30">↓</button>
                  <button onClick={() => edit(ranking.filter((x) => x !== id))} aria-label={`Remove ${p.name}`} className="px-1.5 text-[#BC3F3F]">×</button>
                </span>
              </div>
            );
          })}
          <div className="text-[11px] font-semibold text-[#6B6B6B] uppercase tracking-wider pt-1">Patterns you have not ranked</div>
          {unranked.length === 0 ? <div className="text-[12px] text-[#6B6B6B] py-1">You have ranked everything on offer.</div> : unranked.map((p) => (
            <div key={p.id} className={`flex items-start justify-between gap-3 border border-dashed border-[#E5E5E0] rounded-md p-2.5 ${p.fits ? '' : 'opacity-60'}`}>
              <div className="min-w-0">
                <PatternInfo p={p} />
                {!p.fits && <div className="text-[11px] text-[#BC3F3F] mt-1">Not available to you: {p.why}</div>}
              </div>
              {p.fits && <Btn onClick={() => edit([...ranking, p.id])} className="shrink-0">Add to my ranking</Btn>}
            </div>
          ))}
          {saved && !changed && <Banner kind="ok">Saved. Your choices are recorded.</Banner>}
          <Btn variant="primary" disabled={busy || !changed} onClick={save}>{busy ? 'Saving…' : 'Save my ranking'}</Btn>
        </>
      )}
    </Card>
  );
};

export const Opportunities: React.FC = () => {
  const offers = useLoad<{ open: Offer[]; recent: Offer[] }>('/me/offers');
  const bids = useLoad<Bid[]>('/me/bids');
  if ((offers.loading && !offers.data) || (bids.loading && !bids.data)) return <Busy />;
  const rounds = bids.data ?? [];
  return (
    <div className="grid gap-4 lg:grid-cols-2 items-start">
      <div className="space-y-4">
        {offers.error && <Banner kind="err">{offers.error}</Banner>}
        <Card title="Offers for you" sub="Extra hours or voluntary time off your manager has offered">
          {!offers.data || offers.data.open.length === 0 ? <Empty title="No open offers">When extra hours or time off are offered to you, you can answer them here.</Empty> : <div className="space-y-2">{offers.data.open.map((o) => <OfferCard key={o.id} o={o} onDone={offers.reload} />)}</div>}
        </Card>
        {offers.data && offers.data.recent.length > 0 && (
          <Card title="Earlier offers">
            <div className="space-y-2">{offers.data.recent.map((o) => <OfferCard key={o.id} o={o} onDone={offers.reload} />)}</div>
          </Card>
        )}
      </div>
      <div className="space-y-4">
        {bids.error && <Banner kind="err">{bids.error}</Banner>}
        {rounds.length === 0 ? (
          <Card title="Shift bidding"><Empty title="No bidding round right now">When your organisation opens a round, you will rank the shift patterns you want here.</Empty></Card>
        ) : rounds.map((b) => <BidCard key={b.id} b={b} onDone={bids.reload} />)}
      </div>
    </div>
  );
};
