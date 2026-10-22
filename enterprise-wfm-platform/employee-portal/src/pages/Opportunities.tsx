/** VTO/overtime offers to accept or decline, and open shift-bidding rounds to rank. */
import React, { useEffect, useState } from 'react';
import { api, ApiError } from '../api';
import { Bid, Offer } from '../types';
import { useLoad, Banner, Btn, Busy, Card, Empty, Pill, hm, dayLabel } from '../ui';

const OfferCard: React.FC<{ o: Offer; onDone: () => void }> = ({ o, onDone }) => {
  const [busy, setBusy] = useState(false); const [err, setErr] = useState('');
  const act = async (path: string) => { setBusy(true); setErr(''); try { await api(path, { method: 'POST' }); onDone(); } catch (e: any) { setErr(e instanceof ApiError ? e.message : 'Could not complete that'); } finally { setBusy(false); } };
  const open = o.myStatus === 'INVITED' || o.myStatus === 'QUEUED';
  return (
    <div className="border border-[#E5E5E0] rounded-md p-2.5 space-y-1">
      <div className="flex items-center justify-between">
        <div className="text-[13px] font-semibold text-[#171717]">{o.kind === 'VTO' ? 'Voluntary time off' : 'Overtime'}</div>
        <Pill tone={o.myStatus === 'ACCEPTED' ? 'good' : o.myStatus === 'DECLINED' ? 'neutral' : 'info'}>{o.myStatus.toLowerCase()}</Pill>
      </div>
      <div className="text-[12px] text-[#525252]">{dayLabel(o.day)} · {hm(o.startTime)}–{hm(o.endTime)}</div>
      {o.note && <div className="text-[12px] text-[#737373]">{o.note}</div>}
      {err && <div className="text-[11px] text-[#C84A4A]">{err}</div>}
      {open && <div className="flex gap-2 pt-1"><Btn variant="primary" disabled={busy} onClick={() => act(`/me/offers/${o.id}/accept`)}>Accept</Btn><Btn disabled={busy} onClick={() => act(`/me/offers/${o.id}/decline`)}>Decline</Btn></div>}
    </div>
  );
};

const BidCard: React.FC<{ b: Bid; onDone: () => void }> = ({ b, onDone }) => {
  const [ranking, setRanking] = useState<string[]>(b.myRanking);
  useEffect(() => setRanking(b.myRanking), [b.id, b.myRanking]);
  const [busy, setBusy] = useState(false); const [err, setErr] = useState('');
  const byId = new Map(b.patterns.map((p) => [p.id, p]));
  const unranked = b.patterns.filter((p) => p.fits && !ranking.includes(p.id));
  const move = (i: number, d: number) => { const next = [...ranking]; const [x] = next.splice(i, 1); next.splice(i + d, 0, x); setRanking(next); };

  const save = async () => {
    setBusy(true); setErr('');
    try { await api(`/me/bids/${b.id}/ranking`, { method: 'PUT', body: { patternIds: ranking } }); onDone(); } catch (e: any) { setErr(e instanceof ApiError ? e.message : 'Could not save'); } finally { setBusy(false); }
  };

  return (
    <Card title={b.name} sub={`Closes ${b.closesAt ? new Date(b.closesAt).toLocaleDateString() : 'soon'}`}>
      {b.status === 'AWARDED' ? (
        <Banner kind={b.myAward ? 'ok' : 'warn'}>{b.myAward ? `Awarded: ${b.myAward.patternName} (your rank ${b.myAward.rank})` : 'Not awarded a pattern this round.'}</Banner>
      ) : b.status === 'CLOSED' ? <Banner kind="warn">Closed, awaiting results.</Banner> : (
        <>
          {err && <Banner kind="err" onClose={() => setErr('')}>{err}</Banner>}
          <div className="text-[11px] font-semibold text-[#737373] uppercase tracking-wider">Your ranking</div>
          {ranking.length === 0 ? <div className="text-[12px] text-[#A3A3A3] py-1">Add a pattern below</div> : ranking.map((id, i) => {
            const p = byId.get(id); if (!p) return null;
            return (
              <div key={id} className="flex items-center justify-between border border-[#E5E5E0] rounded-md p-2 text-[13px]">
                <span>{i + 1}. {p.name} · {p.days.join(' ')} {hm(p.startTime)}–{hm(p.endTime)}</span>
                <span className="flex gap-1">
                  <button disabled={i === 0} onClick={() => move(i, -1)} className="disabled:opacity-30">↑</button>
                  <button disabled={i === ranking.length - 1} onClick={() => move(i, 1)} className="disabled:opacity-30">↓</button>
                  <button onClick={() => setRanking(ranking.filter((x) => x !== id))} className="text-[#C84A4A]">×</button>
                </span>
              </div>
            );
          })}
          {unranked.length > 0 && (
            <>
              <div className="text-[11px] font-semibold text-[#737373] uppercase tracking-wider pt-1">Add</div>
              {unranked.map((p) => (
                <button key={p.id} onClick={() => setRanking([...ranking, p.id])} className="w-full text-left border border-dashed border-[#E5E5E0] rounded-md p-2 text-[13px] hover:bg-[#FAFAF8]">
                  + {p.name} · {p.days.join(' ')} {hm(p.startTime)}–{hm(p.endTime)}
                </button>
              ))}
            </>
          )}
          <Btn variant="primary" disabled={busy} onClick={save}>{busy ? 'Saving…' : 'Save ranking'}</Btn>
        </>
      )}
    </Card>
  );
};

export const Opportunities: React.FC = () => {
  const offers = useLoad<{ open: Offer[]; recent: Offer[] }>('/me/offers');
  const bids = useLoad<Bid[]>('/me/bids');
  if ((offers.loading && !offers.data) || (bids.loading && !bids.data)) return <Busy />;
  return (
    <div className="space-y-4">
      {offers.error && <Banner kind="err">{offers.error}</Banner>}
      <Card title="Offers">
        {!offers.data || offers.data.open.length === 0 ? <Empty title="No open offers" /> : <div className="space-y-2">{offers.data.open.map((o) => <OfferCard key={o.id} o={o} onDone={offers.reload} />)}</div>}
      </Card>
      {bids.error && <Banner kind="err">{bids.error}</Banner>}
      {(bids.data ?? []).map((b) => <BidCard key={b.id} b={b} onDone={bids.reload} />)}
      {offers.data && offers.data.recent.length > 0 && (
        <Card title="Recent offers">
          <div className="space-y-2">{offers.data.recent.map((o) => <OfferCard key={o.id} o={o} onDone={offers.reload} />)}</div>
        </Card>
      )}
    </div>
  );
};
