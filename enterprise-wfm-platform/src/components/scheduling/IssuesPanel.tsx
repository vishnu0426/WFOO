/**
 * The panel beside the schedule: the numbers for the whole schedule, the person selected (with what is wrong with their day), the rule violations and the stretches where cover is short.
 * Clicking an issue takes the planner to it: the day opens, the person's row scrolls into view and flashes, or the time on the staffing strip does.
 */
import React, { useState } from 'react';
import { Redo2, Undo2 } from 'lucide-react';
import { dec, dayName, ScheduleShift, ScheduleVersion, Violation } from '../../services/api';
import { gapLabel, gapMinutes, issueLabel, orderIssues, peopleLine, violationsNote, type Gap } from '../../services/scheduleIssues';
import { Btn, Pill } from '../forecasting/ui';

type History = { canUndo: boolean; canRedo: boolean; undoLabel: string; redoLabel: string };
const tone = (p: number) => (p >= 95 ? 'text-[#2A7553]' : p >= 85 ? 'text-[#8F6200]' : 'text-[#BC3F3F]');
const SHOW = 8;

export const IssuesPanel: React.FC<{
  version: ScheduleVersion;
  stats: ScheduleVersion['stats'];
  onDay: number;
  day: string;
  violations: Violation[];
  warnings: Violation[];
  gaps: Gap[];
  selected: ScheduleShift | null;
  selectedIssues: Violation[];
  canEdit: boolean;
  busy: boolean;
  history: History;
  onUndo: () => void;
  onRedo: () => void;
  onFocusIssue: (v: Violation) => void;
  onFocusGap: (g: Gap) => void;
  onFillGap?: (g: Gap) => void;
  onRemove: (s: ScheduleShift) => void;
  onOpenWeek: (employeeId: string) => void;
  onClearSelection: () => void;
  onHide?: () => void;
}> = ({ version, stats, onDay, day, violations, warnings, gaps, selected, selectedIssues, canEdit, busy, history, onUndo, onRedo, onFocusIssue, onFocusGap, onFillGap, onRemove, onOpenWeek, onClearSelection, onHide }) => {
  const [allV, setAllV] = useState(false);
  const [allW, setAllW] = useState(false);
  const ordered = orderIssues(violations, day);
  const orderedW = orderIssues(warnings, day);
  const shownV = allV ? ordered : ordered.slice(0, SHOW);
  const shownW = allW ? orderedW : orderedW.slice(0, 4);
  const chip = 'rounded-md border border-[#E5E5E0] bg-white px-2 py-1.5';
  const item = 'flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left text-[12px] hover:bg-[#F3F6FB] focus:outline-none focus-visible:ring-2 focus-visible:ring-[#171717]';
  return (
    <aside aria-label="Issues and details" data-testid="issues-panel" className="w-[300px] shrink-0 overflow-y-auto rounded-lg border border-[#E5E5E0] bg-[#FAFAF8] p-3 space-y-4 text-[13px]">
      <section aria-label="Schedule totals" className="space-y-1.5">
        <div className="flex items-center justify-between"><div className="text-[11px] font-semibold uppercase tracking-wider text-[#6B6B6B]">This schedule</div>{onHide && <button type="button" onClick={onHide} className="rounded border border-[#E5E5E0] bg-white px-2 py-0.5 text-[11px] font-medium text-[#525252] hover:bg-[#F3F6FB]" title="Put the panel away to give the schedule the full width">Hide</button>}</div>
        <div className="grid grid-cols-2 gap-1.5 text-[12px] text-[#525252]">
          <div className={chip}>Coverage <b className={tone(stats.coverage.percent)}>{dec(stats.coverage.percent, 1)}%</b></div>
          <div className={chip}>Violations <b className={stats.violations ? 'text-[#BC3F3F]' : 'text-[#171717]'}>{stats.violations}</b></div>
          <div className={chip}><b className="text-[#171717]">{dec(stats.hours.paid, 0)}h</b> paid of {dec(stats.hours.required, 0)}h</div>
          <div className={chip}>Overtime <b className="text-[#171717]">{dec(stats.hours.overtime, 0)}h</b></div>
        </div>
        <div className="text-[12px] text-[#525252]" data-testid="people-line">{peopleLine(stats.people, onDay)}</div>
        <div className="text-[12px] text-[#525252]" title="Quarter-hours where fewer people are scheduled than needed, across the whole schedule">Short <b className="text-[#171717]">{stats.coverage.underIntervals}</b> × 15 min · <b className="text-[#171717]">{stats.coverage.criticalIntervals}</b> critical</div>
      </section>

      {canEdit && (
        <section aria-label="Undo and redo" className="flex items-center gap-1.5">
          <Btn disabled={!history.canUndo || busy} onClick={onUndo} title={history.canUndo ? `Undo: ${history.undoLabel} (Ctrl+Z)` : 'Nothing to undo'}><Undo2 className="h-3.5 w-3.5" />Undo</Btn>
          <Btn disabled={!history.canRedo || busy} onClick={onRedo} title={history.canRedo ? `Redo: ${history.redoLabel} (Ctrl+Shift+Z)` : 'Nothing to redo'}><Redo2 className="h-3.5 w-3.5" />Redo</Btn>
          <span className="min-w-0 truncate text-[11px] text-[#6B6B6B]">{history.canUndo ? history.undoLabel : 'No edits yet'}</span>
        </section>
      )}

      {selected && (
        <section aria-label="Selected shift" data-testid="selected-card" className="space-y-2 rounded-lg border border-[#C9D6EA] bg-[#EEF3FA] p-2.5">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0"><div className="truncate text-[14px] font-semibold">{selected.employeeName}</div><div className="text-[12px] text-[#525252]">{dayName(selected.day)}</div></div>
            <button type="button" aria-label="Clear selection" className="text-[12px] text-[#6B6B6B] underline" onClick={onClearSelection}>Clear</button>
          </div>
          <div className="text-[12px]">{selected.startTime}–{selected.endTime}{selected.overnight ? ' (overnight)' : ''} · {selected.templateName ?? 'shift'}</div>
          <div className="text-[12px] text-[#6B6B6B]">{selected.source === 'MANUAL' ? 'Added by hand' : 'From the solver'} · {selected.employeeNumber}</div>
          {selectedIssues.length > 0 && <ul className="space-y-1">{selectedIssues.map((v, i) => <li key={i} className="rounded bg-[#FCEBEC] px-2 py-1 text-[12px] text-[#8E2F2F]">{v.message}</li>)}</ul>}
          <div className="flex flex-wrap gap-1.5">
            <Btn onClick={() => onOpenWeek(selected.employeeId)}>Their week</Btn>
            {canEdit && <Btn onClick={() => onRemove(selected)}>Remove shift</Btn>}
          </div>
        </section>
      )}

      <section aria-label="Rule violations" className="space-y-1">
        <div className="flex items-baseline justify-between"><h3 className="text-[11px] font-semibold uppercase tracking-wider text-[#6B6B6B]">Rule violations ({violations.length})</h3></div>
        {violations.length === 0 ? <p className="text-[12px] text-[#2A7553]">No rules are broken.</p> : (
          <>
            <p className="text-[12px] text-[#525252]" data-testid="violations-note">{violationsNote(version.status, violations.length)}</p>
            <ul className="space-y-0.5">
              {shownV.map((v, i) => (
                <li key={`${v.employeeId}|${v.day}|${v.type}|${i}`}>
                  <button type="button" data-testid="issue-item" className={`${item} ${v.day === day ? 'bg-[#FFF8EB]' : ''}`} onClick={() => onFocusIssue(v)} title="Show on the schedule">
                    <Pill tone="bad">{issueLabel(v.type)}</Pill>
                    <span className="min-w-0"><span className="block truncate font-semibold">{v.employeeName}<span className="font-normal text-[#6B6B6B]"> · {v.day === day ? 'this day' : dayName(v.day)}</span></span><span className="block text-[#525252]">{v.message}</span></span>
                  </button>
                </li>))}
            </ul>
            {ordered.length > SHOW && <button type="button" className="text-[12px] underline text-[#525252]" onClick={() => setAllV((x) => !x)}>{allV ? 'Show fewer' : `Show all ${ordered.length}`}</button>}
          </>)}
      </section>

      <section aria-label="Short intervals" className="space-y-1">
        <h3 className="text-[11px] font-semibold uppercase tracking-wider text-[#6B6B6B]">Short on this day ({gaps.length})</h3>
        {gaps.length === 0 ? <p className="text-[12px] text-[#2A7553]">Cover meets the need all day.</p> : (
          <ul className="space-y-0.5">
            {gaps.map((g) => (
              <li key={g.from} className="flex items-center gap-1">
                <button type="button" data-testid="gap-item" className={`${item} items-center`} onClick={() => onFocusGap(g)} title="Show on the schedule">
                  <span className="font-mono text-[12px] font-semibold">{gapLabel(g)}</span><span className="text-[#8E2F2F]">short by {g.need}</span><span className="ml-auto text-[11px] text-[#6B6B6B]">{gapMinutes(g)} min</span>
                </button>
                {canEdit && onFillGap && <button type="button" className="shrink-0 rounded border border-[#E5E5E0] bg-white px-2 py-1 text-[11px] hover:bg-[#F3F6FB]" onClick={() => onFillGap(g)}>Add shift</button>}
              </li>))}
          </ul>)}
      </section>

      {warnings.length > 0 && (
        <section aria-label="Labour-law warnings" className="space-y-1">
          <h3 className="text-[11px] font-semibold uppercase tracking-wider text-[#6B6B6B]">Labour-law warnings ({warnings.length})</h3>
          <p className="text-[12px] text-[#525252]">These do not stop publishing, but the labour-law pack for this group asks you to look at them.</p>
          <ul className="space-y-0.5">
            {shownW.map((v, i) => (
              <li key={`${v.employeeId}|${v.day}|${v.type}|${i}`}>
                <button type="button" className={item} onClick={() => onFocusIssue(v)}>
                  <Pill tone="warn">{issueLabel(v.type, false)}</Pill>
                  <span className="min-w-0"><span className="block truncate font-semibold">{v.employeeName}<span className="font-normal text-[#6B6B6B]"> · {v.day === day ? 'this day' : dayName(v.day)}</span></span><span className="block text-[#525252]">{v.message}</span></span>
                </button>
              </li>))}
          </ul>
          {orderedW.length > 4 && <button type="button" className="text-[12px] underline text-[#525252]" onClick={() => setAllW((x) => !x)}>{allW ? 'Show fewer' : `Show all ${orderedW.length}`}</button>}
        </section>)}
    </aside>
  );
};
