/** Sub-tabs for the three kinds of self-service requests. */
import React, { useEffect, useState } from 'react';
import { Bid, RequestPrefill } from '../types';
import { useLoad } from '../ui';
import { TimeOff } from './TimeOff';
import { Swaps } from './Swaps';
import { Opportunities } from './Opportunities';

type Sub = 'timeoff' | 'swaps' | 'opportunities';
const SUBS: { id: Sub; label: string }[] = [{ id: 'timeoff', label: 'Time off' }, { id: 'swaps', label: 'Swaps' }, { id: 'opportunities', label: 'Opportunities' }];

export const Requests: React.FC<{ prefill?: RequestPrefill | null; onPrefillConsumed?: () => void }> = ({ prefill, onPrefillConsumed }) => {
  const [sub, setSub] = useState<Sub>('timeoff');
  const bids = useLoad<Bid[]>('/me/bids');
  const openBids = (bids.data ?? []).filter((b) => b.status === 'OPEN').length;
  // a prefill that carries a date or a shift is consumed by the tab it opens; a bare one (from the Inbox) only picks the tab, so clear it here
  useEffect(() => { if (!prefill) return; setSub(prefill.tab); if (prefill.tab === 'opportunities' || (prefill.tab === 'swaps' && !prefill.shiftId) || (prefill.tab === 'timeoff' && !prefill.date)) onPrefillConsumed?.(); }, [prefill]);

  return (
    <div className="space-y-4">
      <div className="flex gap-1 bg-[#F0F0EC] rounded-md p-1">
        {SUBS.map((s) => (
          <button key={s.id} onClick={() => setSub(s.id)} className={`flex-1 text-[12px] font-semibold py-1.5 rounded ${sub === s.id ? 'bg-white text-[#171717] shadow-xs' : 'text-[#6B6B6B]'}`}>{s.label}{s.id === 'opportunities' && openBids > 0 && <span className="ml-1.5 inline-block min-w-[16px] px-1 rounded-full bg-[#C84A4A] text-white text-[10px] leading-4" aria-label={`${openBids} open bidding round${openBids === 1 ? '' : 's'}`}>{openBids}</span>}</button>
        ))}
      </div>
      {sub === 'timeoff' && <TimeOff initialDate={prefill?.tab === 'timeoff' ? prefill.date : undefined} onConsumed={onPrefillConsumed} />}
      {sub === 'swaps' && <Swaps initialShiftId={prefill?.tab === 'swaps' ? prefill.shiftId : undefined} onConsumed={onPrefillConsumed} />}
      {sub === 'opportunities' && <Opportunities />}
    </div>
  );
};
