/**
 * The Roster view of a schedule: one row per person, one column per day. It shows the same people as the timeline, under the same filters and beside the same issues panel. Days that break a rule are red;
 * clicking a cell opens that person's day on the timeline. Only the rows in view are drawn, so a large group stays quick to scroll.
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { DOW, dowOfDay, dec } from '../../services/api';
import { layoutRows, windowOf } from '../../services/scheduleIssues';
import { cellText, rosterItems, type RosterRow, type RosterShow } from '../../services/rosterView';

const ROW_H = 34, GROUP_H = 28, NAME_W = 210;

export const RosterView: React.FC<{
  rows: RosterRow[];
  days: string[];
  groupByTeam: boolean;
  show: RosterShow;
  dayPercent: Map<string, number>;
  today: string;
  onPick: (employeeId: string, day: string) => void;
  onOpenPerson: (employeeId: string) => void;
}> = ({ rows, days, groupByTeam, show, dayPercent, today, onPick, onOpenPerson }) => {
  const [el, setEl] = useState<HTMLDivElement | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewH, setViewH] = useState(600);
  const [folded, setFolded] = useState<Set<string>>(new Set());
  useEffect(() => {
    if (!el) return undefined;
    const measure = () => setViewH(el.clientHeight);
    measure();
    const ro = new ResizeObserver(measure); ro.observe(el);
    return () => ro.disconnect();
  }, [el]);
  const items = useMemo(() => rosterItems(rows, groupByTeam, folded), [rows, groupByTeam, folded]);
  const heights = useMemo(() => items.map((i) => (i.kind === 'group' ? GROUP_H : ROW_H)), [items]);
  const layout = useMemo(() => layoutRows(heights), [heights]);
  const headH = 44;
  const [a, b] = windowOf(layout, heights, scrollTop - headH, scrollTop - headH + viewH, 8);
  const topPad = a < items.length ? layout.tops[a] : layout.total;
  const bottomPad = Math.max(0, layout.total - (b < items.length ? layout.tops[b] : layout.total));
  const toggle = (t: string) => setFolded((f) => { const n = new Set(f); if (n.has(t)) n.delete(t); else n.add(t); return n; });
  if (!rows.length) return <p className="rounded-lg border border-[#E5E5E0] p-6 text-[13px] text-[#6B6B6B]">Nobody matches the current filters.</p>;
  const cols = days.length + 3;

  return (
    <div ref={setEl} data-testid="roster-scroll" data-rows={rows.length} onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)} className="h-full overflow-auto rounded-lg border border-[#E5E5E0] bg-white">
      <table className="w-full border-separate border-spacing-0 text-[12px]" style={{ minWidth: NAME_W + days.length * 96 + 140 }} aria-label="Roster: one row per person, one column per day">
        <thead>
          <tr>
            <th scope="col" className="sticky left-0 top-0 z-30 border-b border-r-2 border-[#D6D6D0] bg-[#FAFAF8] px-3 text-left text-[11px] font-semibold uppercase tracking-wider text-[#6B6B6B]" style={{ width: NAME_W, minWidth: NAME_W, height: headH }}>Person</th>
            {days.map((d) => {
              const pct = dayPercent.get(d);
              return (
                <th key={d} scope="col" className={`sticky top-0 z-20 border-b border-[#E5E5E0] px-1 text-center font-medium ${d === today ? 'bg-[#EEF3FA]' : 'bg-[#FAFAF8]'}`} style={{ height: headH, minWidth: 96 }}>
                  <div className="text-[12px] font-semibold">{DOW[dowOfDay(d)]} {d.slice(8)}</div>
                  <div className={`text-[10px] tabular-nums ${pct === undefined ? 'text-[#A3A3A3]' : pct >= 95 ? 'text-[#2A7553]' : pct >= 85 ? 'text-[#8F6200]' : 'text-[#BC3F3F]'}`}>{pct === undefined ? '·' : `${dec(pct, 0)}% covered`}</div>
                </th>
              );
            })}
            <th scope="col" className="sticky top-0 z-20 border-b border-[#E5E5E0] bg-[#FAFAF8] px-2 text-right text-[11px] font-semibold uppercase tracking-wider text-[#6B6B6B]" style={{ height: headH, minWidth: 70 }}>Paid</th>
            <th scope="col" className="sticky top-0 z-20 border-b border-[#E5E5E0] bg-[#FAFAF8] px-2 text-right text-[11px] font-semibold uppercase tracking-wider text-[#6B6B6B]" style={{ height: headH, minWidth: 64 }}>Issues</th>
          </tr>
        </thead>
        <tbody>
          {topPad > 0 && <tr aria-hidden style={{ height: topPad }}><td colSpan={cols} /></tr>}
          {items.slice(a, b).map((it) => it.kind === 'group' ? (
            <tr key={`g-${it.team}`} style={{ height: GROUP_H }}>
              <th scope="rowgroup" colSpan={cols} className="sticky left-0 border-b border-[#E5E5E0] bg-[#F5F5F1] px-3 text-left text-[12px] font-semibold">
                <button type="button" aria-expanded={!folded.has(it.team)} onClick={() => toggle(it.team)} className="text-left">{folded.has(it.team) ? '▸' : '▾'} {it.team} <span className="font-normal text-[#6B6B6B]">({it.count})</span></button>
              </th>
            </tr>
          ) : (
            <tr key={it.row.id} data-person={it.row.id} className="group hover:bg-[#F3F6FB]" style={{ height: ROW_H }}>
              <th scope="row" className="sticky left-0 z-10 truncate border-b border-r-2 border-[#D6D6D0] bg-white px-3 text-left font-normal group-hover:bg-[#F3F6FB]" style={{ width: NAME_W, maxWidth: NAME_W }}>
                <button type="button" className={`max-w-full truncate text-left text-[13px] hover:underline ${it.row.violations ? 'font-semibold text-[#BC3F3F]' : 'font-semibold text-[#171717]'}`} onClick={() => onOpenPerson(it.row.id)} title="Open their week">{it.row.violations ? '! ' : ''}{it.row.name}</button>
              </th>
              {days.map((d) => {
                const c = it.row.cells[d];
                return (
                  <td key={d} className={`border-b border-[#F0F0EC] p-0 text-center ${c?.bad ? 'bg-[#FCEBEC]' : ''}`}>
                    {c ? (
                      <button type="button" data-cell={`${it.row.id}|${d}`} onClick={() => onPick(it.row.id, d)} title={`${it.row.name}, ${d}: ${c.times}${c.bad ? ' (breaks a rule)' : ''}. Open on the timeline`}
                        className={`h-full w-full px-1 font-mono text-[11px] hover:bg-[#E6EDF8] ${c.bad ? 'font-semibold text-[#8E2F2F]' : 'text-[#171717]'}`} style={{ height: ROW_H }}>{cellText(c, show)}</button>
                    ) : <span className="text-[#C4C4BE]">·</span>}
                  </td>
                );
              })}
              <td className="border-b border-[#F0F0EC] px-2 text-right tabular-nums">{it.row.hours}</td>
              <td className={`border-b border-[#F0F0EC] px-2 text-right tabular-nums ${it.row.violations ? 'font-semibold text-[#BC3F3F]' : 'text-[#A3A3A3]'}`}>{it.row.violations || '·'}</td>
            </tr>
          ))}
          {bottomPad > 0 && <tr aria-hidden style={{ height: bottomPad }}><td colSpan={cols} /></tr>}
        </tbody>
      </table>
    </div>
  );
};
