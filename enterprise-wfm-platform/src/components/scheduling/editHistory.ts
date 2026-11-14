/**
 * Undo and redo for edits made on the Schedule Timeline. Every edit is recorded as "how those people's shifts looked before" and "after"; undoing puts
 * the before back with the same endpoints the edit used (so the server still re-checks rules and keeps its change history), redoing puts the after back.
 * The history lives in this browser tab only and is cleared when another schedule is opened.
 */
import { useCallback, useEffect, useState } from 'react';
import { api, ScheduleShift, slotHHMM } from '../../services/api';

type Act = { type: 'MEAL' | 'BREAK' | 'TRAINING' | 'COACHING'; startSlot: number; slots: number };
export type Snap = { employeeId: string; day: string; exists: boolean; templateId: string | null; startSlot: number; lengthSlots: number; activities: Act[] };
type Entry = { label: string; before: Snap[]; after: Snap[] };
const LIMIT = 25;

const snapOf = (employeeId: string, day: string, s?: ScheduleShift): Snap => s
  ? { employeeId, day, exists: true, templateId: s.templateId, startSlot: s.startSlot, lengthSlots: s.lengthSlots, activities: s.activities.map((a) => ({ type: a.type as Act['type'], startSlot: a.startSlot, slots: a.slots })) }
  : { employeeId, day, exists: false, templateId: null, startSlot: 0, lengthSlots: 0, activities: [] };

const dayShifts = (versionId: string, day: string) => api<ScheduleShift[]>(`/scheduling/versions/${versionId}/shifts?from=${day}&to=${day}`);

/** Puts each person's day back to the given state. */
async function restore(versionId: string, snaps: Snap[], why: string) {
  for (const s of snaps) {
    if (s.exists) {
      if (!s.templateId) throw new Error('A shift without a template cannot be put back by undo. Add it again by hand.');
      const r = await api<{ id: string }>(`/scheduling/versions/${versionId}/shifts`, { method: 'POST', body: { employeeId: s.employeeId, day: s.day, templateId: s.templateId, startTime: slotHHMM(s.startSlot), lengthHours: s.lengthSlots / 4, reason: why } });
      if (s.activities.length) await api(`/scheduling/versions/${versionId}/shifts/${r.id}/activities`, { method: 'PUT', body: { activities: s.activities, reason: why } });
    } else {
      const now = (await dayShifts(versionId, s.day)).find((x) => x.employeeId === s.employeeId);
      if (now) await api(`/scheduling/versions/${versionId}/shifts/${now.id}?reason=${encodeURIComponent(why)}`, { method: 'DELETE' });
    }
  }
}

export function useEditHistory(versionId: string | undefined, reload: (id?: string) => Promise<void>) {
  const [undoStack, setUndo] = useState<Entry[]>([]);
  const [redoStack, setRedo] = useState<Entry[]>([]);
  useEffect(() => { setUndo([]); setRedo([]); }, [versionId]);

  /** Runs an edit and remembers how to take it back. `current` is the shifts on screen before the edit. */
  const record = useCallback(async (label: string, touched: { employeeId: string; day: string }[], current: ScheduleShift[], edit: () => Promise<void>) => {
    if (!versionId) return;
    const uniq = [...new Map(touched.map((t) => [`${t.employeeId}|${t.day}`, t])).values()];
    const before = uniq.map((t) => snapOf(t.employeeId, t.day, current.find((s) => s.employeeId === t.employeeId && s.day === t.day)));
    await edit();
    const after: Snap[] = [];
    for (const day of [...new Set(uniq.map((t) => t.day))]) {
      const rows = await dayShifts(versionId, day);
      for (const t of uniq.filter((x) => x.day === day)) after.push(snapOf(t.employeeId, day, rows.find((s) => s.employeeId === t.employeeId)));
    }
    setUndo((u) => [...u.slice(-(LIMIT - 1)), { label, before, after }]);
    setRedo([]);
  }, [versionId]);

  const undo = useCallback(async () => {
    const e = undoStack[undoStack.length - 1]; if (!e || !versionId) return;
    await restore(versionId, e.before, `Undo: ${e.label}`);
    setUndo((u) => u.slice(0, -1)); setRedo((r) => [...r, e]);
    await reload(versionId);
  }, [undoStack, versionId, reload]);

  const redo = useCallback(async () => {
    const e = redoStack[redoStack.length - 1]; if (!e || !versionId) return;
    await restore(versionId, e.after, `Redo: ${e.label}`);
    setRedo((r) => r.slice(0, -1)); setUndo((u) => [...u, e]);
    await reload(versionId);
  }, [redoStack, versionId, reload]);

  return { record, undo, redo, canUndo: undoStack.length > 0, canRedo: redoStack.length > 0, undoLabel: undoStack[undoStack.length - 1]?.label ?? '', redoLabel: redoStack[redoStack.length - 1]?.label ?? '' };
}
