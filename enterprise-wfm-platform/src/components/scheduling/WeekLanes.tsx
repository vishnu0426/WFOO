/**
 * Schedule Timeline, week view: one lane per person, one column per day, each shift drawn as a bar placed by its start and length within the day.
 * Read at a glance (who works when, who is off, where a rule is broken, how many hours); click a cell to open that day.
 */
import React, { useState } from 'react';
import { DOW, dowOfDay, ScheduleShift } from '../../services/api';

const LEFT = 200;
const RIGHT = 64;

export const WeekLanes: React.FC<{
  shifts: ScheduleShift[];
  days: string[];
  bad: Set<string>;
  groupBy: boolean;
  compact: boolean;
  dayPercent: Map<string, number>;
  onPickDay: (day: string) => void;
  onOpen: (employeeId: string) => void;
}> = ({ shifts, days, bad, groupBy, compact, dayPercent, onPickDay, onOpen }) => {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const rowH = compact ? 30 : 42;

  const people = new Map<string, { id: string; name: string; number: string; team: string; byDay: Map<string, ScheduleShift>; hours: number }>();
  for (const s of shifts) {
    if (!days.includes(s.day)) continue;
    const p = people.get(s.employeeId) ?? { id: s.employeeId, name: s.employeeName, number: s.employeeNumber, team: s.teamName ?? 'No team', byDay: new Map(), hours: 0 };
    const meal = s.activities.filter((a) => a.type === 'MEAL').reduce((n, a) => n + a.slots, 0);
    p.byDay.set(s.day, s); p.hours += (s.lengthSlots - meal) / 4; people.set(s.employeeId, p);
  }
  const rows = [...people.values()].sort((a, b) => (groupBy ? a.team.localeCompare(b.team) : 0) || a.name.localeCompare(b.name));
  const sections = groupBy
    ? rows.reduce<{ team: string | null; items: typeof rows }[]>((o, p) => { const last = o[o.length - 1]; if (last && last.team === p.team) last.items.push(p); else o.push({ team: p.team, items: [p] }); return o; }, [])
    : [{ team: null, items: rows }];
  const toggle = (t: string) => setCollapsed((c) => { const n = new Set(c); if (n.has(t)) n.delete(t); else n.add(t); return n; });
  const grid = `${LEFT}px repeat(${days.length}, minmax(96px, 1fr)) ${RIGHT}px`;

  if (rows.length === 0) return <div className="border border-[#E5E5E0] rounded-lg p-6 text-[13px] text-[#6B6B6B]">Nobody matches this week.</div>;

  const cell = (p: (typeof rows)[number], d: string) => {
    const s = p.byDay.get(d);
    const flagged = bad.has(`${p.id}|${d}`);
    if (!s) return <button key={d} type="button" aria-label={`${p.name}, ${d}: off`} onClick={() => onPickDay(d)} className="border-l border-[#F0F0EC] text-[#C9C9C2] text-[11px] hover:bg-[#F3F6FB]">·</button>;
    const left = (s.startSlot / 96) * 100, width = Math.max(4, (Math.min(s.lengthSlots, 96 - s.startSlot) / 96) * 100);
    return (
      <button key={d} type="button" aria-label={`${p.name}, ${d}: ${s.startTime} to ${s.endTime}${flagged ? ', breaks a rule' : ''}`} title={`${s.startTime}–${s.endTime}${s.templateName ? ` · ${s.templateName}` : ''}${flagged ? ' · breaks a rule' : ''}`}
        onClick={() => onPickDay(d)} className="relative border-l border-[#F0F0EC] hover:bg-[#F3F6FB] px-1">
        <div className="absolute inset-x-1 top-1/2 -translate-y-1/2 h-4 rounded-sm bg-[#F0F0EC]">
          <div className={`absolute top-0 h-full rounded-sm ${flagged ? 'bg-[#C9605F]' : s.source === 'MANUAL' ? 'bg-[#6B7F99]' : 'bg-[#7B6CA6]'}`} style={{ left: `${left}%`, width: `${width}%` }} />
        </div>
        {!compact && <span className="absolute inset-x-0 -bottom-px text-[9px] leading-none text-[#6B6B6B] font-mono pb-0.5">{s.startTime}–{s.endTime}{s.overnight ? ' →' : ''}</span>}
      </button>
    );
  };

  return (
    <div className="border border-[#E5E5E0] rounded-lg bg-white overflow-auto max-h-[70vh]">
      <div style={{ minWidth: LEFT + RIGHT + days.length * 96 }}>
        <div className="grid sticky top-0 z-20 bg-[#FAFAF8] border-b border-[#E5E5E0] text-[11px]" style={{ gridTemplateColumns: grid }}>
          <div className="sticky left-0 z-30 bg-[#FAFAF8] border-r-2 border-[#D6D6D0] px-3 py-1.5 font-semibold uppercase tracking-wider text-[#6B6B6B]">Person</div>
          {days.map((d) => {
            const pct = dayPercent.get(d);
            return (
              <button key={d} type="button" onClick={() => onPickDay(d)} className="px-2 py-1.5 text-center border-l border-[#F0F0EC] hover:bg-white">
                <div className="font-semibold text-[#171717]">{DOW[dowOfDay(d)]} {d.slice(8)}</div>
                {pct !== undefined && <div className={`tabular-nums ${pct >= 95 ? 'text-[#2A7553]' : pct >= 85 ? 'text-[#8F6200]' : 'text-[#BC3F3F]'}`}>{Math.round(pct)}%</div>}
              </button>
            );
          })}
          <div className="px-2 py-1.5 text-right font-semibold uppercase tracking-wider text-[#6B6B6B]">Hours</div>
        </div>
        {sections.map((sec) => (
          <React.Fragment key={sec.team ?? 'all'}>
            {sec.team !== null && (
              <button type="button" aria-expanded={!collapsed.has(sec.team)} onClick={() => toggle(sec.team!)} className="sticky left-0 w-full text-left px-3 py-1 bg-[#F5F5F1] border-b border-[#E5E5E0] text-[12px] font-semibold">
                {collapsed.has(sec.team) ? '▸' : '▾'} {sec.team} <span className="font-normal text-[#6B6B6B]">({sec.items.length})</span>
              </button>
            )}
            {!(sec.team !== null && collapsed.has(sec.team)) && sec.items.map((p) => (
              <div key={p.id} className="grid border-b border-[#F0F0EC] last:border-0 hover:bg-[#FBFBF9]" style={{ gridTemplateColumns: grid, height: rowH }}>
                <button type="button" onClick={() => onOpen(p.id)} className="sticky left-0 z-10 bg-inherit bg-white border-r-2 border-[#D6D6D0] px-3 text-left min-w-0">
                  <div className="text-[13px] font-semibold truncate hover:underline">{p.name}</div>
                  {!compact && <div className="text-[11px] text-[#6B6B6B] truncate">{p.number} · {p.team}</div>}
                </button>
                {days.map((d) => cell(p, d))}
                <div className="px-2 flex items-center justify-end text-[12px] tabular-nums font-semibold border-l border-[#F0F0EC]">{Math.round(p.hours * 10) / 10}</div>
              </div>
            ))}
          </React.Fragment>
        ))}
      </div>
    </div>
  );
};
