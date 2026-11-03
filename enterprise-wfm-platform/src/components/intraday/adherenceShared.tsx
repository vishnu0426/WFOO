/** Things the real-time adherence screens share: how a status looks, the refresh setting, and the box for explaining a stretch out of adherence. */
import React, { useEffect, useState } from 'react';
import { api, AdherenceAgent, AdherenceStatus } from '../../services/api';
import { Banner, Btn, Input, Select } from '../forecasting/ui';

/** Re-fetch every `ms` while the screen is open (only for "today"; a past day never changes). */
export const useTick = (ms: number, on: boolean) => {
  const [t, setT] = useState(0);
  useEffect(() => { if (!on) return; const id = setInterval(() => { if (!document.hidden) setT((x) => x + 1); }, ms); return () => clearInterval(id); }, [ms, on]);
  return t;
};

export const REFRESH_OPTIONS = [0, 5, 10, 15, 30, 60, 300] as const;
const REFRESH_KEY = 'rta-refresh-seconds';
export const refreshLabel = (s: number) => (s < 60 ? `${s} seconds` : `${s / 60} min`);
export const useRefreshSetting = () => {
  const [sec, setSec] = useState<number>(() => {
    try { const v = Number(localStorage.getItem(REFRESH_KEY)); return (REFRESH_OPTIONS as readonly number[]).includes(v) ? v : 15; } catch { return 15; }
  });
  const change = (s: number) => {
    setSec(s);
    try { localStorage.setItem(REFRESH_KEY, String(s)); } catch { /* storage unavailable: keep it for this visit only */ }
  };
  return [sec, change] as const;
};

export const STATUS: Record<AdherenceStatus, { label: string; tone: 'good' | 'bad' | 'warn' | 'neutral' | 'info' }> = {
  IN: { label: 'In adherence', tone: 'good' }, OUT: { label: 'Out of adherence', tone: 'bad' }, UNSCHEDULED: { label: 'Unscheduled', tone: 'warn' },
  IGNORED: { label: 'Ignored', tone: 'neutral' }, UNKNOWN: { label: 'No state yet', tone: 'info' }, NOT_STARTED: { label: 'Not started', tone: 'neutral' }, SHIFT_ENDED: { label: 'Shift ended', tone: 'neutral' },
};
export const RUN_COLOR: Record<AdherenceStatus, string> = { IN: '#2F7D5A', OUT: '#C84A4A', UNSCHEDULED: '#B7791F', IGNORED: '#A3A3A3', UNKNOWN: '#8AA4C8', NOT_STARTED: 'transparent', SHIFT_ENDED: 'transparent' };
export const hm = (min: number) => `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
export const isOut = (s: AdherenceStatus) => s === 'OUT' || s === 'UNSCHEDULED';

// used only until a real activity for that category exists (Configuration › Activity Definitions); once one does,
// its own colour and name take over here and on the Schedule Timeline, instead of each screen picking its own
export const SCHED_FALLBACK: Record<string, string> = { WORK: '#DCE8F5', MEAL: '#F6E3B8', BREAK: '#F4D6EA', TRAINING: '#E0D7F0', COACHING: '#D3EEE9' };
export const SCHED_LABEL_FALLBACK: Record<string, string> = { WORK: 'Work', MEAL: 'Meal', BREAK: 'Break', TRAINING: 'Training', COACHING: 'Coaching' };

/** The colours and names of the scheduled kinds of time come from the real activities (Configuration › Activity Definitions), not a fixed palette, so a recoloured activity
 * shows up here and on the Schedule Timeline the same way. The fallbacks above are used until an activity exists for that kind. */
export const useActivityLooks = (activities: { status: string; category: string; color: string; name: string }[] | null) => {
  const [looks, setLooks] = useState({ color: { ...SCHED_FALLBACK } as Record<string, string>, name: { ...SCHED_LABEL_FALLBACK } as Record<string, string> });
  useEffect(() => {
    const color: Record<string, string> = { ...SCHED_FALLBACK }, name: Record<string, string> = { ...SCHED_LABEL_FALLBACK }, seen = new Set<string>();
    for (const a of activities ?? []) if (a.status === 'ACTIVE' && !seen.has(a.category)) { seen.add(a.category); color[a.category] = a.color; name[a.category] = a.name; }
    setLooks({ color, name });
  }, [activities]);
  return looks;
};

/** An out-of-adherence stretch is explained once an explanation's window covers all of it. */
export const coveredBy = (run: { from: number; to: number }, exceptions: AdherenceAgent['exceptions']) => exceptions.find((x) => x.from <= run.from && x.to >= run.to) ?? null;

/** Say why a stretch out of adherence happened, and whether it counts. */
export const ExplainBox: React.FC<{ agent: { employeeId: string }; day: string; range: { from: number; to: number }; onCancel: () => void; onSaved: () => void }> = ({ agent, day, range, onCancel, onSaved }) => {
  const [category, setCategory] = useState<'COACHING' | 'TRAINING' | 'SYSTEM_ISSUE' | 'MEETING' | 'OTHER'>('COACHING');
  const [note, setNote] = useState('');
  const [excused, setExcused] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const save = async () => {
    setBusy(true); setError('');
    try {
      await api('/intraday/exceptions', { method: 'POST', body: { employeeId: agent.employeeId, day, fromMinute: range.from, toMinute: range.to, category, note: note.trim(), excused } });
      onSaved();
    } catch (e: any) { setError(e.message); } finally { setBusy(false); }
  };

  return (
    <div className="mt-3 pt-3 border-t border-[#E5E5E0] space-y-3">
      {error && <Banner kind="err" onClose={() => setError('')}>{error}</Banner>}
      <div className="grid grid-cols-1 sm:grid-cols-[11rem_1fr] gap-3">
        <label className="block text-[11px] font-semibold uppercase tracking-wider text-[#6B6B6B]">Why
          <Select value={category} onChange={(e) => setCategory(e.target.value as typeof category)} className="mt-1 font-normal normal-case tracking-normal text-[#171717]">
            <option value="COACHING">Coaching</option><option value="TRAINING">Training</option><option value="SYSTEM_ISSUE">System or phone issue</option><option value="MEETING">Meeting</option><option value="OTHER">Other</option>
          </Select>
        </label>
        <label className="block text-[11px] font-semibold uppercase tracking-wider text-[#6B6B6B]">What happened
          <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. Coached on call handling until 10:40" className="mt-1 font-normal normal-case tracking-normal text-[#171717]" />
        </label>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <label className="flex items-center gap-2 text-[13px] text-[#171717] cursor-pointer">
          <input type="checkbox" checked={excused} onChange={(e) => setExcused(e.target.checked)} className="w-4 h-4 accent-[#2F7D5A]" />Count as excused
        </label>
        <div className="flex items-center gap-2">
          <Btn onClick={onCancel}>Cancel</Btn>
          <Btn variant="primary" disabled={busy || note.trim().length < 3} onClick={save}>Save</Btn>
        </div>
      </div>
    </div>
  );
};
