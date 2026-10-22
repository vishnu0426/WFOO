/**
 * Schedule Timeline for one day. A staffing heatmap sits above the people rows on the same time axis, so every 15 minutes
 * lines up vertically. Shifts and their meal, break, training and coaching blocks carry visible labels; hover explains
 * anything. Activity blocks can be dragged to move and dragged at their right edge to resize, in 15-minute steps, and each
 * change asks for a reason before it is saved.
 */
import React, { useMemo, useState } from 'react';
import { Activity, Employee, ScheduleShift, SchedulingPolicy, slotHHMM } from '../../services/api';
import { useApi } from '../forecasting/hooks';
import { Banner, Btn, Input } from '../forecasting/ui';

export type Act = { type: 'MEAL' | 'BREAK' | 'TRAINING' | 'COACHING'; startSlot: number; slots: number };
// used only until a real activity for that category exists (Configuration › Activity Definitions); once one does,
// its own colour and name take over, same as on the RTA Timelines card -- the two screens read the same source
const ACT_FALLBACK: Record<Act['type'], { label: string; bg: string }> = {
  MEAL: { label: 'Meal', bg: '#E7C27D' },
  BREAK: { label: 'Break', bg: '#A9C4DE' },
  TRAINING: { label: 'Training', bg: '#B8A9D6' },
  COACHING: { label: 'Coaching', bg: '#9ACFC4' },
};
/** Picks readable text colour for a background, since an activity only has the one colour to configure. */
const textFor = (bg: string) => {
  const h = bg.replace('#', '');
  const r = parseInt(h.slice(0, 2), 16), g = parseInt(h.slice(2, 4), 16), b = parseInt(h.slice(4, 6), 16);
  return (r * 299 + g * 587 + b * 114) / 1000 >= 150 ? '#171717' : '#FFFFFF';
};
/** pixels per 15 minutes at each zoom level */
const PX: Record<string, number> = { '15': 30, '30': 20, '60': 12, '120': 7 };
/** how often a time label is drawn, in 15-minute slots */
const LABEL_EVERY: Record<string, number> = { '15': 4, '30': 4, '60': 8, '120': 16 };
const ROW_H = 52;
const LEFT = 224;

const hm = (slot: number) => slotHHMM(slot);
const hoursOf = (s: ScheduleShift) => (s.lengthSlots - s.activities.filter((a) => a.type === 'MEAL').reduce((n, a) => n + a.slots, 0)) / 4;

type Drag = { shiftId: string; idx: number; mode: 'move' | 'resize' | 'shift'; startX: number; origStart: number; origSlots: number; delta: number };
type Pending =
  | { kind: 'acts'; shift: ScheduleShift; acts: Act[]; what: string }
  | { kind: 'shift'; shift: ScheduleShift; newStart: number; what: string };
type Tip = { x: number; y: number; title: string; lines: string[] };

export const DayTimeline: React.FC<{
  shifts: ScheduleShift[];
  bad: Set<string>;
  coverage: { time: string; required: number; scheduled: number; delta: number }[];
  people: Map<string, Employee>;
  zoom: string;
  focus: boolean;
  problem: 'ALL' | 'UNDERSTAFFED' | 'VIOLATIONS';
  canEdit: boolean;
  selected: string | null;
  onSelect: (s: ScheduleShift) => void;
  onOpen: (employeeId: string) => void;
  onSaveActivities: (shift: ScheduleShift, acts: Act[], reason: string) => Promise<void>;
  onMoveShift: (shift: ScheduleShift, newStartSlot: number, reason: string) => Promise<void>;
}> = ({ shifts, bad, coverage, people, zoom, focus, problem, canEdit, selected, onSelect, onOpen, onSaveActivities, onMoveShift }) => {
  const px = PX[zoom] ?? 20;
  const every = LABEL_EVERY[zoom] ?? 4;
  const [drag, setDrag] = useState<Drag | null>(null);
  const [editing, setEditing] = useState<{ shiftId: string; idx: number } | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [reason, setReason] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [tip, setTip] = useState<Tip | null>(null);
  const activities = useApi<Activity[]>('/config/activities', []);
  const policy = useApi<SchedulingPolicy>('/config/scheduling-policy', []);
  const timelineColors = policy.data?.timelineColors ?? { shift: '#7B6CA6', manual: '#6B7F99', violation: '#C9605F' };
  const ACT = useMemo(() => {
    const byCat = new Map<string, Activity>();
    for (const a of activities.data ?? []) if (a.status === 'ACTIVE' && !byCat.has(a.category)) byCat.set(a.category, a);
    const build = (t: Act['type']) => { const a = byCat.get(t); const bg = a?.color ?? ACT_FALLBACK[t].bg; return { label: a?.name ?? ACT_FALLBACK[t].label, bg, text: a?.textColor ?? textFor(bg) }; };
    return { MEAL: build('MEAL'), BREAK: build('BREAK'), TRAINING: build('TRAINING'), COACHING: build('COACHING') } as Record<Act['type'], { label: string; bg: string; text: string }>;
  }, [activities.data]);

  // slots (15 minutes each, counted from midnight) where the schedule is short of what is needed
  const short = new Set<number>();
  coverage.forEach((c, i) => { if (c.delta < 0) short.add(i); });
  const hasGap = (s: ScheduleShift) => { for (let q = s.startSlot; q < s.startSlot + s.lengthSlots; q++) if (short.has(q)) return true; return false; };

  let rows = [...shifts].sort((a, b) => a.startSlot - b.startSlot || a.employeeName.localeCompare(b.employeeName));
  if (problem === 'UNDERSTAFFED' || focus) rows = rows.filter(hasGap);
  if (problem === 'VIOLATIONS') rows = rows.filter((s) => bad.has(`${s.employeeId}|${s.day}`));

  const lo = rows.length ? Math.max(0, Math.floor(Math.min(...rows.map((s) => s.startSlot)) / 4) * 4 - 4) : 24;
  const hi = rows.length ? Math.min(96, Math.ceil(Math.max(...rows.map((s) => s.startSlot + s.lengthSlots)) / 4) * 4 + 4) : 80;
  const x = (slot: number) => (slot - lo) * px;
  const track = (hi - lo) * px;
  const ticks: number[] = [];
  for (let q = Math.ceil(lo / every) * every; q <= hi; q += every) ticks.push(q);

  const show = (title: string, lines: string[]) => (e: React.MouseEvent) => setTip({ x: e.clientX, y: e.clientY, title, lines: lines.filter(Boolean) });
  const hide = () => setTip(null);

  const withActs = (shift: ScheduleShift, next: Act[], what: string) => {
    const overlap = next.some((a, i) => next.some((b, j) => i !== j && a.startSlot < b.startSlot + b.slots && b.startSlot < a.startSlot + a.slots));
    const outside = next.some((a) => a.slots < 1 || a.startSlot < shift.startSlot || a.startSlot + a.slots > shift.startSlot + shift.lengthSlots);
    if (overlap) return setError('Two activities cannot overlap.');
    if (outside) return setError('An activity must stay inside the shift.');
    setError(''); setEditing(null); setPending({ kind: 'acts', shift, acts: next, what }); setReason('');
  };

  /** Dragging the whole work bar retimes that person's shift; the new start is kept inside the day and on a 15-minute step. */
  const finishShiftDrag = (shift: ScheduleShift) => {
    if (!drag) return;
    const d = drag;
    setDrag(null);
    if (d.delta === 0) return;
    const newStart = Math.min(Math.max(d.origStart + d.delta, 0), 96 - shift.lengthSlots);
    if (newStart === shift.startSlot) return;
    setError(''); setPending({ kind: 'shift', shift, newStart, what: `shift moving to ${hm(newStart)}` }); setReason('');
  };

  const finishDrag = (shift: ScheduleShift, acts: Act[]) => {
    if (!drag) return;
    const d = drag;
    setDrag(null);
    if (d.delta === 0) { setEditing({ shiftId: shift.id, idx: d.idx }); return; }
    const a = acts[d.idx];
    const start = d.mode === 'move' ? Math.min(Math.max(d.origStart + d.delta, shift.startSlot), shift.startSlot + shift.lengthSlots - a.slots) : d.origStart;
    const slots = d.mode === 'resize' ? Math.min(Math.max(d.origSlots + d.delta, 1), shift.startSlot + shift.lengthSlots - a.startSlot) : a.slots;
    withActs(shift, acts.map((x, i) => (i === d.idx ? { ...x, startSlot: start, slots } : x)),
      `${ACT[a.type].label.toLowerCase()} ${d.mode === 'move' ? `moving to ${hm(start)}` : `now ${slots * 15} minutes`}`);
  };

  const save = async () => {
    if (!pending || reason.trim().length < 3) return;
    setBusy(true); setError('');
    try {
      if (pending.kind === 'acts') await onSaveActivities(pending.shift, pending.acts, reason.trim());
      else await onMoveShift(pending.shift, pending.newStart, reason.trim());
      setPending(null); setReason('');
    }
    catch (e: any) { setError(e.message); } finally { setBusy(false); }
  };

  const cellTone = (d: number) => (d <= -6 ? 'bg-[#EFA9A9]' : d < 0 ? 'bg-[#F8D4D4]' : d >= 3 ? 'bg-[#F6E3B4]' : 'bg-[#D7EEDF]');

  return (
    <div className="space-y-2" onMouseMove={(e) => setTip((t) => (t ? { ...t, x: e.clientX, y: e.clientY } : t))}>
      {error && <Banner kind="err" onClose={() => setError('')}>{error}</Banner>}
      {pending && (
        <div className="border border-[#E9D9B4] rounded-lg p-3 bg-[#FFF5DD] flex flex-wrap items-center gap-2">
          <div className="text-[13px] flex-1 min-w-[260px]">Why is {pending.shift.employeeName}'s {pending.what}?</div>
          <Input autoFocus value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Reason (required)" className="max-w-xs" />
          <Btn variant="primary" disabled={busy || reason.trim().length < 3} onClick={save}>Confirm</Btn>
          <Btn onClick={() => setPending(null)}>Cancel</Btn>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-x-5 gap-y-1 px-1 text-[11px] text-[#525252]">
        <span className="flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-sm" style={{ backgroundColor: timelineColors.shift }} />Shift</span>
        <span className="flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-sm" style={{ backgroundColor: timelineColors.manual }} />By hand</span>
        {(Object.keys(ACT) as Act['type'][]).map((t) => <span key={t} className="flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-sm" style={{ backgroundColor: ACT[t].bg }} />{ACT[t].label}</span>)}
        <span className="flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-sm" style={{ backgroundColor: timelineColors.violation }} />Breaks a rule</span>
        <span className="ml-auto flex items-center gap-3"><span className="flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-sm bg-[#D7EEDF]" />On target</span><span className="flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-sm bg-[#F6E3B4]" />Over</span><span className="flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-sm bg-[#F8D4D4]" />Short</span></span>
      </div>
      {rows.length === 0 ? (
        <div className="border border-[#E5E5E0] rounded-lg p-6 text-[13px] text-[#737373]">
          {problem !== 'ALL' || focus ? 'Nobody matches this filter on this day.' : 'Nobody is scheduled on this day.'}
        </div>
      ) : (
        <div className="border border-[#E5E5E0] rounded-lg bg-white overflow-auto max-h-[70vh]">
          <div style={{ minWidth: LEFT + track }}>
            <div className="flex sticky top-0 z-20 bg-[#FAFAF8] border-b border-[#E5E5E0] h-7">
              <div className="sticky left-0 z-30 bg-[#FAFAF8] shrink-0 shadow-[4px_0_6px_-6px_rgba(23,23,23,0.25)] border-r-2 border-[#D6D6D0] px-3 flex items-center text-[11px] font-semibold uppercase tracking-wider text-[#737373]" style={{ width: LEFT }}>Time (local)</div>
              <div className="relative h-full" style={{ width: track }}>
                {ticks.map((q) => <span key={q} className="absolute top-1.5 text-[11px] font-mono text-[#525252] -translate-x-1/2" style={{ left: x(q) }}>{hm(q)}</span>)}
              </div>
            </div>

            <div className="flex sticky top-7 z-20 bg-white border-b border-[#E5E5E0]" style={{ height: 40 }}>
              <div className="sticky left-0 z-30 bg-white shrink-0 shadow-[4px_0_6px_-6px_rgba(23,23,23,0.25)] border-r-2 border-[#D6D6D0] px-3 py-1.5 flex flex-col justify-center" style={{ width: LEFT }}
                onMouseEnter={show('Staffing net', ['Scheduled against needed, per 15 minutes', 'Green: on target · amber: over · red: short'])} onMouseLeave={hide}>
                <div className="text-[12px] font-semibold text-[#171717]">Staffing net</div>
                <div className="text-[11px] text-[#737373]">scheduled / needed</div>
              </div>
              <div className="relative h-full" style={{ width: track }}>
                {Array.from({ length: hi - lo }, (_, i) => lo + i).map((q) => {
                  const c = coverage[q];
                  if (!c) return null;
                  const d = c.scheduled - c.required;
                  return (
                    <div key={q} className={`absolute top-2 h-6 rounded-[2px] flex items-center justify-center text-[9px] font-mono font-semibold ${cellTone(d)}`}
                      style={{ left: x(q), width: px - 1 }}
                      onMouseEnter={show(c.time, [`Needed ${c.required}`, `Scheduled ${c.scheduled}`, d < 0 ? `Short by ${-d}` : d > 0 ? `Over by ${d}` : 'On target'])}
                      onMouseLeave={hide}>
                      
                    </div>
                  );
                })}
              </div>
            </div>

            {rows.map((s, idx) => {
              const flagged = bad.has(`${s.employeeId}|${s.day}`);
              const person = people.get(s.employeeId);
              const paid = hoursOf(s);
              const isSel = selected === s.id;
              const acts = s.activities.map((a) => ({ type: a.type, startSlot: a.startSlot, slots: a.slots }));
              return (
                <div key={s.id} className={`flex border-b border-[#F0F0EC] last:border-0 ${isSel ? 'bg-[#EEF3FA]' : 'bg-white'} hover:bg-[#F3F6FB]`} style={{ height: ROW_H }}>
                  <div className="sticky left-0 z-10 bg-inherit shrink-0 shadow-[4px_0_6px_-6px_rgba(23,23,23,0.25)] border-r-2 border-[#D6D6D0] px-3 flex flex-col justify-center cursor-pointer min-w-0" style={{ width: LEFT }}
                    onClick={() => onOpen(s.employeeId)}>
                    <div className={`text-[13px] truncate hover:underline ${flagged ? 'text-[#C84A4A] font-semibold' : 'font-semibold text-[#171717]'}`}>{s.employeeName}</div>
                    <div className="text-[11px] text-[#737373] truncate">{s.employeeNumber} · {person?.teamName ?? 'No team'} · {paid}h</div>
                  </div>

                  <div className="relative h-full" style={{ width: track }} onClick={() => onSelect(s)}>
                    {/* the work bar */}
                    <div className={`absolute top-2.5 h-7 rounded-md px-2 flex items-center text-[11px] font-semibold text-white whitespace-nowrap overflow-hidden ${isSel ? 'ring-2 ring-[#171717]' : ''}`}
                      style={{ left: x(drag && drag.shiftId === s.id && drag.mode === 'shift' ? Math.min(Math.max(s.startSlot + drag.delta, 0), 96 - s.lengthSlots) : s.startSlot), width: s.lengthSlots * px, cursor: canEdit && s.templateId ? 'grab' : 'default', touchAction: 'none', backgroundColor: flagged ? timelineColors.violation : s.source === 'MANUAL' ? timelineColors.manual : timelineColors.shift }}
                      onPointerDown={(e) => {
                        if (!canEdit || !s.templateId) return;
                        e.currentTarget.setPointerCapture(e.pointerId);
                        setDrag({ shiftId: s.id, idx: -1, mode: 'shift', startX: e.clientX, origStart: s.startSlot, origSlots: s.lengthSlots, delta: 0 });
                      }}
                      onPointerMove={(e) => {
                        if (!drag || drag.shiftId !== s.id || drag.mode !== 'shift') return;
                        const delta = Math.round((e.clientX - drag.startX) / px);
                        if (delta !== drag.delta) setDrag({ ...drag, delta });
                      }}
                      onPointerUp={() => { if (drag && drag.shiftId === s.id && drag.mode === 'shift') finishShiftDrag(s); }}
                      onMouseEnter={show(`${s.employeeName} · ${s.startTime}–${s.endTime}`, [s.templateName ?? 'Shift', s.source === 'MANUAL' ? 'Added by hand' : 'From the solver', `${paid}h paid`, flagged ? 'Breaks a rule' : ''])}
                      onMouseLeave={hide}>
                      {s.startTime}–{s.endTime}
                    </div>

                    {/* meal, breaks, training, coaching: drag to move, drag the right edge to resize, click to change */}
                    {acts.map((a, i) => {
                      const live = drag && drag.shiftId === s.id && drag.idx === i ? drag : null;
                      const start = live && live.mode === 'move' ? Math.min(Math.max(a.startSlot + live.delta, s.startSlot), s.startSlot + s.lengthSlots - a.slots) : a.startSlot;
                      const slots = live && live.mode === 'resize' ? Math.min(Math.max(a.slots + live.delta, 1), s.startSlot + s.lengthSlots - a.startSlot) : a.slots;
                      const st = ACT[a.type];
                      const w = slots * px;
                      return (
                        <div key={i} className={`absolute top-2.5 h-7 rounded-sm flex items-center px-1.5 text-[11px] font-semibold overflow-hidden whitespace-nowrap select-none ${canEdit ? 'cursor-grab' : ''} ${live ? 'ring-2 ring-[#171717] opacity-90' : 'shadow-xs'}`}
                          style={{ left: x(start), width: w, backgroundColor: st.bg, color: st.text, zIndex: 3 }}
                          onClick={(e) => e.stopPropagation()}
                          onMouseEnter={show(st.label, [`${hm(start)}–${hm(start + slots)}`, `${slots * 15} minutes`, `in ${s.employeeName}'s shift`, canEdit ? 'Drag to move, right edge to resize, click to change' : ''])}
                          onMouseLeave={hide}
                          onPointerDown={(e) => {
                            if (!canEdit) return;
                            e.stopPropagation();
                            const onEdge = e.clientX > e.currentTarget.getBoundingClientRect().right - 6;
                            e.currentTarget.setPointerCapture(e.pointerId);
                            setDrag({ shiftId: s.id, idx: i, mode: onEdge ? 'resize' : 'move', startX: e.clientX, origStart: a.startSlot, origSlots: a.slots, delta: 0 });
                          }}
                          onPointerMove={(e) => {
                            if (!drag || drag.shiftId !== s.id || drag.idx !== i) return;
                            const delta = Math.round((e.clientX - drag.startX) / px);
                            if (delta !== drag.delta) setDrag({ ...drag, delta });
                          }}
                          onPointerUp={() => { if (drag && drag.shiftId === s.id && drag.idx === i) finishDrag(s, acts); }}>
                          {w >= 56 && <span className="truncate">{st.label} {hm(start)}</span>}
                          {canEdit && <span className="absolute right-0 top-0 h-full w-1.5 cursor-ew-resize" />}
                          {editing && editing.shiftId === s.id && editing.idx === i && (
                            <div className="absolute top-8 left-0 z-40 bg-white border border-[#E5E5E0] rounded-md shadow-lg p-2 flex flex-wrap gap-1 w-56 text-[#171717]" onPointerDown={(e) => e.stopPropagation()} onClick={(e) => e.stopPropagation()}>
                              {(Object.keys(ACT) as Act['type'][]).map((t) => (
                                <button key={t} className={`px-2 py-1 rounded text-[11px] border ${t === a.type ? 'bg-[#171717] text-white border-[#171717]' : 'border-[#E5E5E0]'}`}
                                  onClick={() => withActs(s, acts.map((x, j) => (j === i ? { ...x, type: t } : x)), `changing it to ${ACT[t].label.toLowerCase()}`)}>{ACT[t].label}</button>
                              ))}
                              <button className="px-2 py-1 rounded text-[11px] text-[#C84A4A] border border-[#E5E5E0]" onClick={() => withActs(s, acts.filter((_, j) => j !== i), `removing the ${st.label.toLowerCase()}`)}>Remove</button>
                              <button className="px-2 py-1 rounded text-[11px] text-[#737373] ml-auto" onClick={() => setEditing(null)}>Close</button>
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}


      {tip && (
        <div className="fixed z-50 pointer-events-none bg-[#171717] text-white text-[12px] rounded-md shadow-lg px-3 py-2 max-w-xs" style={{ left: tip.x + 14, top: tip.y + 14 }}>
          <div className="font-semibold">{tip.title}</div>
          {tip.lines.map((l, i) => <div key={i} className="text-white/80">{l}</div>)}
        </div>
      )}
    </div>
  );
};
