/**
 * Generate Schedule › which shift templates the build may use. A summary with a 24-hour coverage strip, and a searchable list to choose from:
 * filter by time of day, tick one by one, or select everything shown. Nothing is chosen behind the planner's back; the default is every active template.
 */
import React, { useMemo, useState } from 'react';
import type { ShiftTemplate } from '../../services/api';
import { templateLabel } from '../../services/generateFixes';
import { Btn, Input } from '../forecasting/ui';

const minutes = (t: string) => { const [h, m] = t.split(':').map(Number); return h * 60 + (m || 0); };
const DAY_SHORT = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

export type Band = 'Early' | 'Day' | 'Late' | 'Night';
const BANDS: Band[] = ['Early', 'Day', 'Late', 'Night'];
/** Time of day: a shift that is still running at 02:00 is a Night shift; otherwise by the earliest start: Early 06:00 to 08:59, Day 09:00 to 13:59, Late 14:00 to 19:59, Night 20:00 to 05:59. */
export const bandOf = (t: ShiftTemplate): Band => {
  const m = minutes(t.earliestStart);
  if (((120 - m + 1440) % 1440) < Math.round(t.durationHours * 60)) return 'Night';
  return m >= 360 && m < 540 ? 'Early' : m >= 540 && m < 840 ? 'Day' : m >= 840 && m < 1200 ? 'Late' : 'Night';
};

const daysText = (d: number[]) => {
  const days = [...d].sort((a, b) => a - b);
  if (days.length === 7) return 'Every day';
  if (days.join() === '0,1,2,3,4') return 'Mon to Fri';
  if (days.join() === '5,6') return 'Sat, Sun';
  return days.map((x) => DAY_SHORT[x]).join(', ');
};
const windowText = (t: ShiftTemplate) => (t.earliestStart === t.latestStart ? `starts ${t.earliestStart}` : `starts ${t.earliestStart} to ${t.latestStart}`);

/** Which hours of the day some chosen template can have someone working, as 24 flags. */
const coverage = (chosen: ShiftTemplate[]) => {
  const covered = new Array(24).fill(false);
  for (const t of chosen) {
    const a = minutes(t.earliestStart), b = minutes(t.latestStart), len = Math.round(t.durationHours * 60), step = Math.max(15, t.startStepMinutes || 60);
    for (let st = a; st <= b; st += step) for (let m = st; m < st + len; m += 30) covered[Math.floor(m / 60) % 24] = true;
  }
  return covered;
};

export const TemplatePicker: React.FC<{ templates: ShiftTemplate[]; skip: string[]; setSkip: (ids: string[]) => void }> = ({ templates, skip, setSkip }) => {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [band, setBand] = useState<Band | 'All'>('All');

  const chosen = templates.filter((t) => !skip.includes(t.id));
  const covered = useMemo(() => coverage(chosen), [chosen.map((t) => t.id).join()]);   // eslint-disable-line react-hooks/exhaustive-deps
  const sorted = useMemo(() => [...templates].sort((a, b) => minutes(a.earliestStart) - minutes(b.earliestStart) || a.name.localeCompare(b.name)), [templates]);
  const shown = sorted.filter((t) => (band === 'All' || bandOf(t) === band) && (!q.trim() || `${t.name} ${t.code}`.toLowerCase().includes(q.trim().toLowerCase())));
  const counts = (b: Band) => templates.filter((t) => bandOf(t) === b);

  const setMany = (ids: string[], on: boolean) => setSkip(on ? skip.filter((x) => !ids.includes(x)) : [...new Set([...skip, ...ids])]);
  const shownIds = shown.map((t) => t.id);
  const allShownOn = shown.length > 0 && shown.every((t) => !skip.includes(t.id));

  return (
    <div>
      <div className="text-[12px] font-semibold mb-1.5">Shift templates to use</div>
      <div className="flex flex-wrap items-center gap-3">
        <span className="text-[13px] text-[#171717]"><strong>{chosen.length}</strong> of {templates.length} selected</span>
        <Btn type="button" onClick={() => setOpen(true)}>Choose templates</Btn>
        {skip.length > 0 && <button type="button" className="text-[12px] underline text-[#525252]" onClick={() => setSkip([])}>Use all</button>}
      </div>
      <div className="mt-2.5" aria-label="Hours of the day the chosen templates can cover">
        <div className="flex h-2 rounded overflow-hidden border border-[#E5E5E0]" role="img" aria-label={covered.filter(Boolean).length === 24 ? 'All 24 hours can be covered' : `${covered.filter(Boolean).length} of 24 hours can be covered`}>
          {covered.map((on, h) => <div key={h} className={`flex-1 ${on ? 'bg-[#2F7D5A]' : 'bg-[#EDEDE8]'}`} title={`${String(h).padStart(2, '0')}:00 ${on ? 'can be covered' : 'not covered by a chosen template'}`} />)}
        </div>
        <div className="flex justify-between text-[10px] text-[#737373] mt-0.5"><span>00:00</span><span>06:00</span><span>12:00</span><span>18:00</span><span>24:00</span></div>
      </div>

      {open && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center p-4 z-50" role="dialog" aria-modal="true" aria-label="Choose shift templates">
          <div className="bg-white border border-[#E5E5E0] rounded-lg shadow-2xl w-full max-w-4xl max-h-[88vh] flex flex-col">
            <div className="px-5 py-3.5 border-b border-[#E5E5E0] flex items-center justify-between">
              <h3 className="text-[15px] font-semibold text-[#171717]">Shift templates</h3>
              <button type="button" onClick={() => setOpen(false)} className="text-[13px] text-[#525252] hover:underline">Close</button>
            </div>
            <div className="px-5 py-3 border-b border-[#E5E5E0] flex flex-wrap items-center gap-3">
              <div className="w-64"><Input aria-label="Search templates" placeholder="Search by name" value={q} onChange={(e) => setQ(e.target.value)} autoFocus /></div>
              <div className="flex gap-1.5" role="group" aria-label="Time of day">
                {(['All', ...BANDS] as const).map((b) => (
                  <button key={b} type="button" aria-pressed={band === b} onClick={() => setBand(b)} className={`px-3 py-1 rounded-md border text-[12px] ${band === b ? 'bg-[#1A1A1A] text-white border-[#1A1A1A]' : 'border-[#E5E5E0] text-[#171717]'}`}>
                    {b}{b !== 'All' ? ` (${counts(b).length})` : ''}
                  </button>
                ))}
              </div>
              <div className="ml-auto flex gap-2">
                <Btn type="button" onClick={() => setMany(shownIds, true)} disabled={allShownOn || !shown.length}>Select shown</Btn>
                <Btn type="button" onClick={() => setMany(shownIds, false)} disabled={!shown.some((t) => !skip.includes(t.id))}>Clear shown</Btn>
              </div>
            </div>
            <div className="overflow-y-auto flex-1">
              {shown.length === 0 ? <p className="p-6 text-[13px] text-[#6B6B6B]">No template matches. Clear the search or the time-of-day filter.</p> : (
                <table className="w-full text-left text-[13px]">
                  <thead className="bg-[#FAFAF8] text-[#737373] text-[11px] uppercase tracking-wider border-b border-[#E5E5E0] sticky top-0">
                    <tr><th className="px-4 py-2 w-10" /><th className="px-2 py-2">Template</th><th className="px-2 py-2">Starts</th><th className="px-2 py-2">Length</th><th className="px-2 py-2">Meal and breaks</th><th className="px-2 py-2">Works</th><th className="px-2 py-2">Time of day</th></tr>
                  </thead>
                  <tbody className="divide-y divide-[#E5E5E0]">
                    {shown.map((t) => {
                      const on = !skip.includes(t.id);
                      return (
                        <tr key={t.id} className={on ? '' : 'text-[#737373]'}>
                          <td className="px-4 py-2"><input type="checkbox" aria-label={`Use ${t.name}`} checked={on} onChange={() => setMany([t.id], !on)} /></td>
                          <td className="px-2 py-2 font-medium text-[#171717]" title={templateLabel(t)}>{t.name}</td>
                          <td className="px-2 py-2 tabular-nums">{windowText(t)}</td>
                          <td className="px-2 py-2 tabular-nums">{t.durationHours} h{t.paidHours !== t.durationHours ? <span className="text-[#737373]"> ({t.paidHours} paid)</span> : null}</td>
                          <td className="px-2 py-2 text-[#525252]">{t.mealMinutes ? `${t.mealMinutes} min meal` : 'No meal'}, {t.breakCount} break{t.breakCount === 1 ? '' : 's'}</td>
                          <td className="px-2 py-2 text-[#525252]">{daysText(t.workDays)}</td>
                          <td className="px-2 py-2"><span className="text-[11px] px-2 py-0.5 rounded border border-[#E5E5E0] bg-[#FAFAF8] text-[#525252]">{bandOf(t)}</span></td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}
            </div>
            <div className="px-5 py-3.5 border-t border-[#E5E5E0] flex items-center justify-between">
              <span className="text-[13px] text-[#171717]"><strong>{chosen.length}</strong> of {templates.length} selected{shown.length !== templates.length ? ` (${shown.length} shown)` : ''}</span>
              <Btn variant="primary" type="button" onClick={() => setOpen(false)}>Done</Btn>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
