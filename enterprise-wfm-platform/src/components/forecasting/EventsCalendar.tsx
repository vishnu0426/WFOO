/**
 * Special events on a month calendar: what is already recorded, on which days, and a way to pick the days of a new one by clicking (first click the first day, second click the last).
 * Days in an event's ramp (the build-up before it and the tail after) are shown lighter.
 */
import React, { useMemo, useState } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { eventsOnDay, monthWeeks, type EventSpan } from '../../services/forecastForm';

const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const KIND: Record<string, string> = {
  campaign: 'bg-[#EDF3F8] text-[#34546F] border-[#4F6F8F]/40', holiday: 'bg-[#EAF5EF] text-[#2A7553] border-[#2F7D5A]/40',
  outage: 'bg-[#FCEBEC] text-[#9B2F2F] border-[#C84A4A]/40', other: 'bg-[#F4F4F1] text-[#525252] border-[#B5B5AE]',
};
const dayLabel = (d: string) => new Date(`${d}T00:00:00`).toLocaleDateString('en', { day: 'numeric', month: 'short', year: 'numeric' });

export const EventsCalendar: React.FC<{ events: (EventSpan & { queueName?: string | null })[]; range: { start: string; end: string } | null; onPick?: (day: string) => void }> = ({ events, range, onPick }) => {
  const now = new Date();
  const [ym, setYm] = useState({ y: now.getFullYear(), m: now.getMonth() });
  const weeks = useMemo(() => monthWeeks(ym.y, ym.m), [ym]);
  const today = new Date().toISOString().slice(0, 10);
  const step = (n: number) => setYm((v) => { const d = new Date(v.y, v.m + n, 1); return { y: d.getFullYear(), m: d.getMonth() }; });
  const inRange = (d: string) => !!range && d >= range.start && d <= range.end;
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <button type="button" aria-label="Previous month" onClick={() => step(-1)} className="rounded border border-[#E5E5E0] p-1.5 hover:bg-[#FAFAF8]"><ChevronLeft className="h-4 w-4" /></button>
        <h3 className="w-36 text-center text-[13px] font-semibold" aria-live="polite">{MONTHS[ym.m]} {ym.y}</h3>
        <button type="button" aria-label="Next month" onClick={() => step(1)} className="rounded border border-[#E5E5E0] p-1.5 hover:bg-[#FAFAF8]"><ChevronRight className="h-4 w-4" /></button>
        <button type="button" onClick={() => setYm({ y: now.getFullYear(), m: now.getMonth() })} className="rounded border border-[#E5E5E0] px-2.5 py-1 text-[12px] hover:bg-[#FAFAF8]">This month</button>
        {onPick && <span className="ml-auto text-[12px] text-[#6B6B6B]">Click a day to start an event, then another for its last day.</span>}
      </div>
      <table aria-label="Special events calendar" className="w-full table-fixed border-collapse text-[12px]">
        <thead><tr>{WEEKDAYS.map((d) => <th key={d} scope="col" className="border border-[#E5E5E0] bg-[#FAFAF8] px-2 py-1 text-left text-[11px] font-semibold uppercase tracking-wide text-[#6B6B6B]">{d}</th>)}</tr></thead>
        <tbody>
          {weeks.map((w) => (
            <tr key={w[0]}>
              {w.map((d) => {
                const here = eventsOnDay(events, d), inMonth = Number(d.slice(5, 7)) - 1 === ym.m, picked = inRange(d), end = !!range && (d === range.start || d === range.end);
                const names = here.map((h) => `${h.event.name}${h.phase === 'on' ? '' : h.phase === 'ramp-in' ? ' (build-up)' : ' (tail)'}`);
                const label = `${dayLabel(d)}${names.length ? `: ${names.join(', ')}` : ''}`;
                return (
                  <td key={d} className={`h-[74px] border border-[#E5E5E0] p-0 align-top ${picked ? 'bg-[#FFF5DD]' : inMonth ? 'bg-white' : 'bg-[#FAFAF8]'}`}>
                    <button type="button" disabled={!onPick} aria-pressed={onPick ? end : undefined} onClick={() => onPick?.(d)}
                      className={`flex h-full w-full flex-col items-stretch gap-0.5 p-1 text-left ${onPick ? 'hover:bg-[#F5F5F2]' : 'cursor-default'} ${end ? 'ring-2 ring-inset ring-[#171717]' : ''}`}>
                      <span className="sr-only">{label}</span>
                      <span aria-hidden="true" className={`text-[11px] ${d === today ? 'inline-block self-start rounded bg-[#171717] px-1 font-semibold text-white' : inMonth ? 'text-[#171717]' : 'text-[#6B6B6B]'}`}>{Number(d.slice(8))}</span>
                      {here.slice(0, 2).map((h) => (
                        <span key={h.event.id} title={`${h.event.name} (${h.event.kind}${h.event.upliftPct ? `, ${h.event.upliftPct > 0 ? '+' : ''}${h.event.upliftPct}%` : ''})`}
                          className={`block truncate rounded border px-1 text-[11px] ${KIND[h.event.kind] ?? KIND.other} ${h.phase === 'on' ? '' : 'border-dashed opacity-60'}`}>{h.event.name}{h.phase === 'on' && h.event.upliftPct ? ` ${h.event.upliftPct > 0 ? '+' : ''}${h.event.upliftPct}%` : ''}</span>))}
                      {here.length > 2 && <span className="text-[11px] text-[#6B6B6B]">+{here.length - 2} more</span>}
                    </button>
                  </td>
                );
              })}
            </tr>))}
        </tbody>
      </table>
      <p className="flex flex-wrap gap-3 text-[11px] text-[#6B6B6B]">
        {Object.keys(KIND).map((k) => <span key={k} className="flex items-center gap-1"><i className={`inline-block h-2.5 w-2.5 rounded-sm border ${KIND[k]}`} />{k[0].toUpperCase() + k.slice(1)}</span>)}
        <span className="flex items-center gap-1"><i className="inline-block h-2.5 w-2.5 rounded-sm border border-dashed border-[#B5B5AE] opacity-60" />Build-up or tail days (lighter)</span>
      </p>
    </div>
  );
};
