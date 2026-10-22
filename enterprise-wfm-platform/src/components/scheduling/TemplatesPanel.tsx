/**
 * Scheduling › Shift Templates. A template is a pattern of shift, not one shift: a start window (for example 06:00 to 10:00
 * every 30 minutes), a length, a meal and breaks. The generator chooses the best start for each person.
 */
import React, { useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { api, DOW, ShiftTemplate } from '../../services/api';
import { useForecast } from '../../services/forecastStore';
import { useApi } from '../forecasting/hooks';
import { Banner, Btn, Card, Empty, Field, Input, Pill, Select, Table } from '../forecasting/ui';

type Form = { id: string | null; name: string; description: string; workDays: number[]; mode: 'FIXED' | 'FLEXIBLE'; earliestStart: string; latestStart: string; endTime: string; startStepMinutes: number; durationHours: number; mealMinutes: number; breakCount: number; breakMinutes: number; flexMinutes: number; status: 'ACTIVE' | 'INACTIVE'; mealAnchorMinutes: number | null; breakAnchorMinutes: (number | null)[] };
const blank = (): Form => ({ id: null, name: '', description: '', workDays: [0, 1, 2, 3, 4, 5, 6], mode: 'FLEXIBLE', earliestStart: '08:00', latestStart: '10:00', endTime: '16:30', startStepMinutes: 30, durationHours: 8.5, mealMinutes: 30, breakCount: 2, breakMinutes: 15, flexMinutes: 30, status: 'ACTIVE', mealAnchorMinutes: null, breakAnchorMinutes: [null, null] });
const resizeBreaks = (arr: (number | null)[], n: number): (number | null)[] => (arr.length === n ? arr : arr.length < n ? [...arr, ...new Array(n - arr.length).fill(null)] : arr.slice(0, n));

const timeToMin = (t: string) => { const [h, m] = t.split(':').map(Number); return h * 60 + (m || 0); };
const minToTime = (m: number) => { m = ((m % 1440) + 1440) % 1440; return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`; };
const durationFromTimes = (start: string, end: string) => { let diff = timeToMin(end) - timeToMin(start); if (diff <= 0) diff += 1440; return Math.round((diff / 60) * 4) / 4; };

export const TemplatesPanel: React.FC = () => {
  const { can, setNotice } = useForecast();
  const [tick, setTick] = useState(0);
  const list = useApi<ShiftTemplate[]>('/scheduling/templates', [tick]);
  const [f, setF] = useState<Form | null>(null);
  const [error, setError] = useState('');
  const w = can('workforce:write');

  const save = async () => {
    if (!f) return; setError('');
    const { id, mode, endTime, ...body } = f;
    try { if (id) await api(`/scheduling/templates/${id}`, { method: 'PUT', body }); else await api('/scheduling/templates', { method: 'POST', body }); setF(null); setTick((t) => t + 1); }
    catch (e: any) { setError(e.message); }
  };
  const del = async (t: ShiftTemplate) => { if (!confirm(`Delete “${t.name}”?`)) return; try { await api(`/scheduling/templates/${t.id}`, { method: 'DELETE' }); setTick((x) => x + 1); } catch (e: any) { setNotice({ kind: 'err', text: e.message }); } };
  const num = (k: keyof Form) => (e: React.ChangeEvent<HTMLInputElement>) => setF((s) => s && { ...s, [k]: Number(e.target.value) });

  return (
    <Card title="Shift templates" sub="The generator picks the best start time for each person inside the window you give here."
      actions={w && <Btn variant="primary" onClick={() => { setError(''); setF(blank()); }}><Plus className="w-3.5 h-3.5" />Add template</Btn>}>
      {f && (
        <div className="border border-[#E5E5E0] rounded-lg p-4 space-y-4">
          <div>
            <div className="text-[12px] font-semibold mb-1.5">Shift start</div>
            <div className="flex gap-1.5 text-[13px]">
              <button type="button" className={`px-3 py-1 rounded-md border ${f.mode === 'FIXED' ? 'bg-[#1A1A1A] text-white border-[#1A1A1A]' : 'border-[#E5E5E0]'}`}
                onClick={() => setF({ ...f, mode: 'FIXED', latestStart: f.earliestStart, endTime: minToTime(timeToMin(f.earliestStart) + f.durationHours * 60) })}>Fixed</button>
              <button type="button" className={`px-3 py-1 rounded-md border ${f.mode === 'FLEXIBLE' ? 'bg-[#1A1A1A] text-white border-[#1A1A1A]' : 'border-[#E5E5E0]'}`}
                onClick={() => setF({ ...f, mode: 'FLEXIBLE' })}>Flexible (a start window)</button>
            </div>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-4">
            <div className="md:col-span-2"><Field label="Name"><Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="e.g. Day shift" /></Field></div>
            {f.mode === 'FIXED' ? (
              <>
                <Field label="Start time"><Input type="time" step={900} value={f.earliestStart} onChange={(e) => { const v = e.target.value; setF({ ...f, earliestStart: v, latestStart: v, durationHours: durationFromTimes(v, f.endTime) }); }} /></Field>
                <Field label="End time"><Input type="time" step={900} value={f.endTime} onChange={(e) => { const v = e.target.value; setF({ ...f, endTime: v, durationHours: durationFromTimes(f.earliestStart, v) }); }} /></Field>
                <Field label="Length incl. meal (hours)"><Input type="number" value={f.durationHours} disabled /></Field>
              </>
            ) : (
              <>
                <Field label="Earliest start"><Input type="time" step={900} value={f.earliestStart} onChange={(e) => setF({ ...f, earliestStart: e.target.value })} /></Field>
                <Field label="Latest start"><Input type="time" step={900} value={f.latestStart} onChange={(e) => setF({ ...f, latestStart: e.target.value })} /></Field>
                <Field label="Start every" hint="Spacing of possible start times"><Select value={f.startStepMinutes} onChange={(e) => setF({ ...f, startStepMinutes: Number(e.target.value) })}>{[15, 30, 60, 120].map((m) => <option key={m} value={m}>{m} minutes</option>)}</Select></Field>
                <Field label="Length incl. meal (hours)"><Input type="number" min={1} max={14} step={0.25} value={f.durationHours} onChange={num('durationHours')} /></Field>
              </>
            )}
            <Field label="Unpaid meal (minutes)"><Input type="number" min={0} max={120} step={15} value={f.mealMinutes} onChange={(e) => setF({ ...f, mealMinutes: Number(e.target.value), mealAnchorMinutes: null })} /></Field>
            <Field label="Paid breaks"><Input type="number" min={0} max={4} value={f.breakCount} onChange={(e) => { const n = Number(e.target.value); setF({ ...f, breakCount: n, breakAnchorMinutes: resizeBreaks(f.breakAnchorMinutes, n) }); }} /></Field>
            <Field label="Break length (minutes)"><Input type="number" min={15} max={60} step={15} value={f.breakMinutes} onChange={(e) => setF({ ...f, breakMinutes: Number(e.target.value), breakAnchorMinutes: f.breakAnchorMinutes.map(() => null) })} /></Field>
            <Field label="Break/meal placement window (min)" hint="How far the generator can still nudge a meal or break from where you drop it below, to smooth coverage"><Input type="number" min={0} max={120} step={15} value={f.flexMinutes} onChange={num('flexMinutes')} /></Field>
            <Field label="Status"><Select value={f.status} onChange={(e) => setF({ ...f, status: e.target.value as Form['status'] })}><option value="ACTIVE">Active</option><option value="INACTIVE">Inactive</option></Select></Field>
          </div>
          <ActivityTimeline durationHours={f.durationHours} mealMinutes={f.mealMinutes} breakCount={f.breakCount} breakMinutes={f.breakMinutes}
            mealAnchor={f.mealAnchorMinutes} breakAnchors={f.breakAnchorMinutes}
            onMealAnchor={(m) => setF((s) => s && { ...s, mealAnchorMinutes: m })}
            onBreakAnchor={(i, m) => setF((s) => s && { ...s, breakAnchorMinutes: s.breakAnchorMinutes.map((x, j) => (j === i ? m : x)) })} />
          <div>
            <div className="text-[12px] font-semibold mb-1.5">Days it can be used</div>
            <div className="flex flex-wrap gap-3 text-[13px]">{DOW.map((d, n) => <label key={d} className="flex items-center gap-1.5"><input type="checkbox" checked={f.workDays.includes(n)} onChange={(e) => setF({ ...f, workDays: e.target.checked ? [...f.workDays, n].sort() : f.workDays.filter((x) => x !== n) })} />{d}</label>)}</div>
          </div>
          {error && <Banner kind="err">{error}</Banner>}
          <div className="flex gap-2"><Btn variant="primary" disabled={!f.name.trim() || f.workDays.length === 0} onClick={save}>Save template</Btn><Btn onClick={() => setF(null)}>Cancel</Btn></div>
        </div>
      )}
      {list.data?.length === 0 && !f ? <Empty title="No shift templates yet">Add a few (for example Early, Day, Late) so the generator has shapes to work with.</Empty> : (
        <Table head={['Template', 'Start window', 'Length', 'Paid', 'Meal / breaks', 'Days', 'Status', '']}>
          {list.data?.map((t) => (
            <tr key={t.id}>
              <td className="p-3 font-semibold">{t.name}</td>
              <td className="p-3 font-mono text-[12px]">{t.earliestStart}–{t.latestStart} <span className="text-[#737373]">every {t.startStepMinutes}m</span></td>
              <td className="p-3">{t.durationHours}h</td><td className="p-3">{t.paidHours}h</td>
              <td className="p-3 text-[12px]">{t.mealMinutes ? `${t.mealMinutes}m meal` : 'no meal'} · {t.breakCount}×{t.breakMinutes}m</td>
              <td className="p-3 text-[12px]">{t.workDays.length === 7 ? 'Every day' : t.workDays.map((d) => DOW[d]).join(' ')}</td>
              <td className="p-3"><Pill tone={t.status === 'ACTIVE' ? 'good' : 'neutral'}>{t.status === 'ACTIVE' ? 'Active' : 'Inactive'}</Pill></td>
              <td className="p-3 text-right whitespace-nowrap">{w && <><button className="text-[12px] underline mr-3" onClick={() => { setError(''); setF({ id: t.id, name: t.name, description: t.description, workDays: t.workDays, mode: t.earliestStart === t.latestStart ? 'FIXED' : 'FLEXIBLE', earliestStart: t.earliestStart, latestStart: t.latestStart, endTime: minToTime(timeToMin(t.earliestStart) + t.durationHours * 60), startStepMinutes: t.startStepMinutes, durationHours: t.durationHours, mealMinutes: t.mealMinutes, breakCount: t.breakCount, breakMinutes: t.breakMinutes, flexMinutes: t.flexMinutes, status: t.status, mealAnchorMinutes: t.mealAnchorMinutes, breakAnchorMinutes: resizeBreaks(t.breakAnchorMinutes ?? [], t.breakCount) }); }}>Edit</button><button aria-label="Delete template" className="text-[#737373] hover:text-[#C84A4A]" onClick={() => del(t)}><Trash2 className="w-4 h-4 inline" /></button></>}</td>
            </tr>
          ))}
        </Table>
      )}
    </Card>
  );
};

const minToHHMM = (m: number) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

/** Drag Meal or a Break onto the bar to anchor its start time; the generator (placeActivities in scheduleRoutes.ts)
 * still nudges it within the flex window above to smooth coverage, it just starts from here instead of the middle
 * of the shift. Unplaced stays fully automatic -- same native-DnD pattern as the shift timeline's drag-to-retime. */
const ActivityTimeline: React.FC<{
  durationHours: number; mealMinutes: number; breakCount: number; breakMinutes: number;
  mealAnchor: number | null; breakAnchors: (number | null)[];
  onMealAnchor: (m: number | null) => void; onBreakAnchor: (i: number, m: number | null) => void;
}> = ({ durationHours, mealMinutes, breakCount, breakMinutes, mealAnchor, breakAnchors, onMealAnchor, onBreakAnchor }) => {
  const total = Math.round(durationHours * 60);
  const [dragId, setDragId] = useState<string | null>(null);
  const pct = (m: number) => `${Math.min(100, Math.max(0, (m / total) * 100))}%`;

  const items = [
    ...(mealMinutes > 0 ? [{ id: 'meal', label: 'Meal', start: mealAnchor, dur: mealMinutes, color: '#F2C46D' }] : []),
    ...Array.from({ length: breakCount }, (_, i) => ({ id: `break:${i}`, label: `Break ${i + 1}`, start: breakAnchors[i] ?? null, dur: breakMinutes, color: '#BBD0E6' })),
  ];
  if (!items.length) return null;
  const clear = (id: string) => (id === 'meal' ? onMealAnchor(null) : onBreakAnchor(Number(id.split(':')[1]), null));
  const place = (id: string, m: number) => (id === 'meal' ? onMealAnchor(m) : onBreakAnchor(Number(id.split(':')[1]), m));

  const drop = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    const id = dragId; setDragId(null);
    const item = items.find((x) => x.id === id);
    if (!item) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const relX = Math.min(Math.max(e.clientX - rect.left, 0), rect.width);
    const raw = (relX / rect.width) * total - item.dur / 2;
    const snapped = Math.round(raw / 15) * 15;
    place(id, Math.min(Math.max(snapped, 0), Math.max(0, total - item.dur)));
  };

  return (
    <div className="space-y-2">
      <div className="text-[12px] font-semibold">Where meals and breaks sit in the shift</div>
      <p className="text-[11px] text-[#737373]">Drag onto the bar to anchor it there. Leave unplaced for fully automatic placement.</p>
      {items.some((x) => x.start == null) && (
        <div className="flex flex-wrap gap-1.5">
          {items.filter((x) => x.start == null).map((x) => (
            <span key={x.id} draggable onDragStart={() => setDragId(x.id)}
              className="text-[11px] font-medium px-2 py-1 rounded border border-dashed border-[#D6D6D0] bg-white cursor-grab active:cursor-grabbing">
              {x.label} <span className="text-[#A3A3A3]">(auto, {x.dur}m)</span>
            </span>
          ))}
        </div>
      )}
      <div onDragOver={(e) => e.preventDefault()} onDrop={drop} className="relative h-11 border border-[#E5E5E0] rounded-lg bg-[#FAFAF8]">
        {Array.from({ length: Math.floor(total / 60) + 1 }, (_, h) => (
          <span key={h} className="absolute top-0.5 text-[9px] text-[#A3A3A3] font-mono -translate-x-1/2" style={{ left: pct(h * 60) }}>{h}h</span>
        ))}
        {items.filter((x) => x.start != null).map((x) => (
          <div key={x.id} draggable onDragStart={() => setDragId(x.id)} title={`${x.label}: ${minToHHMM(x.start!)}, drag to move`}
            className="absolute top-4 h-6 rounded-sm flex items-center justify-center text-[11px] font-semibold text-[#171717] cursor-grab active:cursor-grabbing group"
            style={{ left: pct(x.start!), width: pct(x.dur), backgroundColor: x.color }}>
            <span className="truncate px-1 pointer-events-none">{x.label}</span>
            <button type="button" aria-label={`Clear ${x.label} placement`} onClick={(e) => { e.stopPropagation(); clear(x.id); }}
              className="absolute -top-1.5 -right-1.5 hidden group-hover:flex items-center justify-center w-3.5 h-3.5 rounded-full bg-[#171717] text-white text-[9px] leading-none">×</button>
          </div>
        ))}
      </div>
    </div>
  );
};
