/**
 * The panel that opens when a name is clicked on the Schedule Timeline: contract and this week's hours, skills with
 * proficiency, and the weekly schedule distribution (any week, past or future).
 */
import React, { useEffect, useState } from 'react';
import { addDays, DOW, Employee } from '../../services/api';
import { useApi } from '../forecasting/hooks';

export type HistoryShift = {
  id: string; day: string; startTime: string; endTime: string; startSlot: number; lengthSlots: number; templateName: string | null; source: string;
  versionId: string; versionName: string; versionStatus: 'DRAFT' | 'PUBLISHED' | 'ARCHIVED'; versionSeq: number;
  activities: { type: string; startSlot: number; slots: number; startTime: string; endTime: string }[];
};

const PROF: Record<number, string> = { 5: 'Expert', 4: 'Advanced', 3: 'Intermediate', 2: 'Basic', 1: 'Beginner' };
const dowOf = (day: string) => (new Date(`${day}T00:00:00Z`).getUTCDay() + 6) % 7;
const paidOf = (s: HistoryShift) => (s.lengthSlots - s.activities.filter((a) => a.type === 'MEAL').reduce((n, a) => n + a.slots, 0)) / 4;

export const EmployeeDrawer: React.FC<{
  employee: Employee | null; currentVersionId: string | null; periodStart?: string; periodEnd?: string; day: string; onClose: () => void;
}> = ({ employee, currentVersionId, periodStart, periodEnd, day, onClose }) => {
  const [anchor, setAnchor] = useState(day);
  useEffect(() => setAnchor(day), [day, employee?.id]);
  const monday = addDays(anchor, -dowOf(anchor));
  const sunday = addDays(monday, 6);
  const history = useApi<HistoryShift[]>(employee ? `/scheduling/employees/${employee.id}/shifts?from=${monday}&to=${sunday}` : null, [employee?.id, monday]);
  if (!employee) return null;

  const week = Array.from({ length: 7 }, (_, i) => addDays(monday, i));
  const shifts = history.data ?? [];
  // this schedule's shifts first; for days it does not cover, fall back to whatever version the day belongs to
  // inside the schedule being viewed, only that schedule counts (a day with no shift there is a rest day);
  // outside it, show the published history for that day, one schedule only, so nothing is listed twice
  const inPeriod = (d: string) => !!periodStart && !!periodEnd && d >= periodStart && d <= periodEnd;
  const shiftsOn = (d: string) => {
    if (inPeriod(d)) return shifts.filter((s) => s.day === d && s.versionId === currentVersionId);
    const pub = shifts.filter((s) => s.day === d && s.versionStatus === 'PUBLISHED');
    const latest = pub.reduce<string | null>((best, s) => (best === null || s.versionSeq > (pub.find((x) => x.versionId === best)?.versionSeq ?? 0) ? s.versionId : best), null);
    return latest ? pub.filter((s) => s.versionId === latest) : [];
  };
  const scheduled = week.reduce((n, d) => n + shiftsOn(d).filter((s) => s.versionId === currentVersionId).reduce((m, s) => m + paidOf(s), 0), 0);
  const initials = `${employee.firstName[0] ?? ''}${employee.lastName[0] ?? ''}`.toUpperCase();

  return (
    <aside className="fixed inset-y-0 right-0 z-40 w-[400px] bg-white border-l border-[#E5E5E0] shadow-xl overflow-y-auto">
      <div className="flex items-center gap-3 p-4 border-b border-[#E5E5E0]">
        <div className="w-10 h-10 rounded-full bg-[#171717] text-white flex items-center justify-center text-[13px] font-semibold">{initials}</div>
        <div className="flex-1 min-w-0">
          <div className="font-semibold truncate">{employee.name}</div>
          <div className="text-[12px] text-[#737373] font-mono">EMP-{employee.employeeNumber} · {employee.teamName ?? 'No team'}</div>
        </div>
        <button aria-label="Close" className="text-[#737373] hover:text-[#171717] text-[18px] leading-none px-2" onClick={onClose}>×</button>
      </div>

      <section className="p-4 space-y-2">
        <div className="text-[11px] font-semibold uppercase tracking-wider text-[#737373]">Employment metrics</div>
        <div className="grid grid-cols-2 gap-2">
          <Metric label="Contract" value={`${employee.weeklyContractHours}h/week`} />
          <Metric label="Scheduled this week" value={`${scheduled.toFixed(1)}h`} tone={scheduled > employee.maxWeeklyHours ? 'bad' : undefined} />
          <Metric label="Max overtime" value={`${Math.max(0, employee.maxWeeklyHours - employee.weeklyContractHours)}h`} />
          <Metric label="Status" value={scheduled > employee.maxWeeklyHours ? 'OVER MAXIMUM' : 'ELIGIBLE'} tone={scheduled > employee.maxWeeklyHours ? 'bad' : 'good'} />
        </div>
      </section>

      <section className="p-4 space-y-2 border-t border-[#E5E5E0]">
        <div className="text-[11px] font-semibold uppercase tracking-wider text-[#737373]">Skills & proficiencies</div>
        {employee.skills.length === 0 && <div className="text-[12px] text-[#737373]">No skills recorded yet.</div>}
        {employee.skills.map((s) => (
          <div key={s.skillId} className="flex items-center justify-between rounded-md border border-[#E5E5E0] px-3 py-2 text-[13px]">
            <span>{s.name}</span>
            <span className="font-semibold">Level {s.proficiency} <span className="text-[#737373] font-normal">({PROF[s.proficiency] ?? '—'})</span></span>
          </div>
        ))}
      </section>

      <section className="p-4 space-y-2 border-t border-[#E5E5E0]">
        <div className="flex items-center justify-between">
          <div className="text-[11px] font-semibold uppercase tracking-wider text-[#737373]">Weekly schedule distribution</div>
          <div className="flex items-center gap-1 text-[12px]">
            <button className="px-2 py-0.5 rounded border border-[#E5E5E0] hover:bg-[#FAFAF8]" onClick={() => setAnchor(addDays(monday, -7))}>‹</button>
            <button className="px-2 py-0.5 rounded border border-[#E5E5E0] hover:bg-[#FAFAF8]" onClick={() => setAnchor(day)}>Today</button>
            <button className="px-2 py-0.5 rounded border border-[#E5E5E0] hover:bg-[#FAFAF8]" onClick={() => setAnchor(addDays(monday, 7))}>›</button>
          </div>
        </div>
        <div className="border border-[#E5E5E0] rounded-md divide-y divide-[#E5E5E0] text-[13px]">
          {week.map((d) => {
            const dayShifts = shiftsOn(d);
            const isToday = d === day;
            return (
              <div key={d} className={`flex items-center justify-between px-3 py-2.5 ${isToday ? 'bg-[#EAF5EF]' : ''}`}>
                <span className={isToday ? 'font-semibold text-[#2F7D5A]' : dayShifts.length ? 'text-[#171717]' : 'text-[#737373]'}>
                  {DOW[dowOf(d)]}, {new Date(`${d}T00:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })}{isToday ? ' (Today)' : ''}
                </span>
                {dayShifts.length
                  ? <span className={`font-mono ${isToday ? 'font-bold text-[#2F7D5A]' : ''}`}>{dayShifts.map((s) => `${s.startTime} – ${s.endTime}`).join(', ')}</span>
                  : <span className="text-[#737373]">Rest Day</span>}
              </div>
            );
          })}
        </div>
        {history.loading && <div className="text-[12px] text-[#737373]">Loading…</div>}
      </section>
    </aside>
  );
};

const Metric: React.FC<{ label: string; value: string; tone?: 'good' | 'bad' }> = ({ label, value, tone }) => (
  <div className="rounded-md border border-[#E5E5E0] p-3">
    <div className="text-[11px] text-[#737373]">{label}</div>
    <div className={`text-[14px] font-semibold ${tone === 'bad' ? 'text-[#C84A4A]' : tone === 'good' ? 'text-[#2F7D5A]' : ''}`}>{value}</div>
  </div>
);
