/** Sub-tabs for the three kinds of self-service requests. */
import React, { useEffect, useState } from 'react';
import { RequestPrefill } from '../types';
import { TimeOff } from './TimeOff';
import { Swaps } from './Swaps';
import { Opportunities } from './Opportunities';

type Sub = 'timeoff' | 'swaps' | 'opportunities';
const SUBS: { id: Sub; label: string }[] = [{ id: 'timeoff', label: 'Time off' }, { id: 'swaps', label: 'Swaps' }, { id: 'opportunities', label: 'Opportunities' }];

export const Requests: React.FC<{ prefill?: RequestPrefill | null; onPrefillConsumed?: () => void }> = ({ prefill, onPrefillConsumed }) => {
  const [sub, setSub] = useState<Sub>('timeoff');
  useEffect(() => { if (prefill) setSub(prefill.tab); }, [prefill]);

  return (
    <div className="space-y-4">
      <div className="flex gap-1 bg-[#F0F0EC] rounded-md p-1">
        {SUBS.map((s) => (
          <button key={s.id} onClick={() => setSub(s.id)} className={`flex-1 text-[12px] font-semibold py-1.5 rounded ${sub === s.id ? 'bg-white text-[#171717] shadow-xs' : 'text-[#737373]'}`}>{s.label}</button>
        ))}
      </div>
      {sub === 'timeoff' && <TimeOff initialDate={prefill?.tab === 'timeoff' ? prefill.date : undefined} onConsumed={onPrefillConsumed} />}
      {sub === 'swaps' && <Swaps initialShiftId={prefill?.tab === 'swaps' ? prefill.shiftId : undefined} onConsumed={onPrefillConsumed} />}
      {sub === 'opportunities' && <Opportunities />}
    </div>
  );
};
