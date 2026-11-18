/**
 * Choose a range of days in one field: it shows "18 Nov 2026 → 29 Dec 2026", and opens a two-month calendar. The first click starts the range and the second ends it (either order); days outside
 * what is allowed are greyed out. The list opens over the page (not clipped by a dialog). Rules are in services/dateRange.ts.
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { CalendarDays, ChevronLeft, ChevronRight } from 'lucide-react';
import { click, fmtLong, isDisabled, monthGrid, monthTitle, openingMonth, preview, shiftMonth, weekdayHeads, type Limits } from '../../services/dateRange';

const todayText = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

export const DateRangeField: React.FC<{
  from: string; to: string; onChange: (from: string, to: string) => void; ariaLabel: string; min?: string; max?: string; maxDays?: number; disabled?: boolean; weekStart?: number;
  /** a note under the calendar, e.g. "Greyed days have no data" */
  note?: string; className?: string;
}> = ({ from, to, onChange, ariaLabel, min, max, maxDays, disabled, weekStart = 1, note, className = '' }) => {
  const [open, setOpen] = useState(false);
  const [month, setMonth] = useState(() => openingMonth(from, todayText()));
  const [anchor, setAnchor] = useState<string | null>(null);
  const [hover, setHover] = useState<string | null>(null);
  const [box, setBox] = useState<{ top: number; left: number; up: boolean } | null>(null);
  const trigger = useRef<HTMLButtonElement>(null), panel = useRef<HTMLDivElement>(null);
  const lim: Limits = { min, max, maxDays };
  const heads = weekdayHeads(weekStart);

  const place = () => {
    const r = trigger.current?.getBoundingClientRect(); if (!r) return;
    const up = window.innerHeight - r.bottom < 380 && r.top > window.innerHeight - r.bottom, W = 620;
    setBox({ left: Math.max(8, Math.min(r.left, window.innerWidth - W - 8)), top: up ? r.top : r.bottom, up });
  };
  useEffect(() => {
    if (!open) return undefined;
    place(); setAnchor(null); setHover(null); setMonth(openingMonth(from, todayText()));
    const down = (e: MouseEvent) => { const t = e.target as Node; if (!panel.current?.contains(t) && !trigger.current?.contains(t)) setOpen(false); };
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') { setOpen(false); trigger.current?.focus(); } };
    const move = () => place();
    document.addEventListener('mousedown', down); document.addEventListener('keydown', key); window.addEventListener('resize', move); window.addEventListener('scroll', move, true);
    return () => { document.removeEventListener('mousedown', down); document.removeEventListener('keydown', key); window.removeEventListener('resize', move); window.removeEventListener('scroll', move, true); };
  }, [open]);

  const shown = anchor ? preview(anchor, hover) : (from && to ? { from, to } : null);
  const pick = (day: string) => {
    if (isDisabled(day, lim, anchor)) return;
    const r = click(anchor, day);
    setAnchor(r.anchor);
    if (r.range) { onChange(r.range.from, r.range.to); setOpen(false); trigger.current?.focus(); }
  };
  const months = useMemo(() => [month, shiftMonth(month, 1)], [month]);
  const today = todayText();

  return (
    <>
      <button ref={trigger} type="button" disabled={disabled} aria-label={`${ariaLabel}: ${fmtLong(from)} to ${fmtLong(to)}`} aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen((o) => !o)}
        className={`flex w-full items-center justify-between gap-2 rounded border bg-white p-2 text-left text-[13px] text-[#171717] disabled:bg-[#FAFAF8] disabled:text-[#6B6B6B] ${open ? 'border-[#171717]' : 'border-[#E5E5E0] hover:border-[#C9C9C2]'} ${className}`}>
        <span className="tabular-nums">{from ? <>{fmtLong(from)} <span className="px-1 text-[#8A8A84]">→</span> {fmtLong(to)}</> : <span className="text-[#6B6B6B]">Choose the dates</span>}</span>
        <CalendarDays className="h-4 w-4 shrink-0 text-[#6B6B6B]" />
      </button>
      {open && box && createPortal(
        <div ref={panel} role="dialog" aria-label={ariaLabel} style={{ position: 'fixed', left: box.left, zIndex: 2000, ...(box.up ? { bottom: window.innerHeight - box.top + 4 } : { top: box.top + 4 }) }}
          className="rounded-lg border border-[#E5E5E0] bg-white p-4 shadow-xl">
          <div className="flex gap-6">
            {months.map((ym, mi) => (
              <div key={ym} className="w-[266px]">
                <div className="mb-2 flex items-center justify-between">
                  {mi === 0 ? <button type="button" aria-label="Earlier month" className="rounded p-1 hover:bg-[#F5F5F0]" onClick={() => setMonth(shiftMonth(month, -1))}><ChevronLeft className="h-4 w-4" /></button> : <span className="w-6" />}
                  <div className="text-[13px] font-semibold">{monthTitle(ym)}</div>
                  {mi === 1 ? <button type="button" aria-label="Later month" className="rounded p-1 hover:bg-[#F5F5F0]" onClick={() => setMonth(shiftMonth(month, 1))}><ChevronRight className="h-4 w-4" /></button> : <span className="w-6" />}
                </div>
                <div className="grid grid-cols-7 text-center text-[11px] text-[#8A8A84]">{heads.map((h) => <div key={h} className="py-1">{h}</div>)}</div>
                <div className="grid grid-cols-7">
                  {monthGrid(ym, weekStart).flat().map(({ day, inMonth }) => {
                    if (!inMonth) return <div key={day} className="h-9" />;
                    const off = isDisabled(day, lim, anchor), inRange = !!shown && day >= shown.from && day <= shown.to, edge = !!shown && (day === shown.from || day === shown.to);
                    return (
                      <button key={day} type="button" disabled={off} aria-label={fmtLong(day)} aria-pressed={edge} onClick={() => pick(day)} onMouseEnter={() => anchor && setHover(day)}
                        className={`relative h-9 text-[13px] tabular-nums ${off ? 'cursor-not-allowed text-[#C4C4BE]' : 'hover:bg-[#F5F5F0]'} ${inRange && !edge ? 'bg-[#EFEFEA]' : ''} ${edge ? 'rounded bg-[#171717] font-semibold text-white hover:bg-[#171717]' : ''}`}>
                        {+day.slice(8, 10)}
                        {day === today && !edge && <span className="absolute bottom-1 left-1/2 h-1 w-1 -translate-x-1/2 rounded-full bg-[#171717]" />}
                      </button>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
          <div className="mt-3 flex items-center justify-between border-t border-[#E5E5E0] pt-2 text-[12px] text-[#6B6B6B]">
            <span>{anchor ? `Starts ${fmtLong(anchor)}. Choose the last day.` : 'Choose the first day, then the last day.'}{note ? ` ${note}` : ''}</span>
            <button type="button" className="underline" onClick={() => setOpen(false)}>Close</button>
          </div>
        </div>, document.body)}
    </>
  );
};
