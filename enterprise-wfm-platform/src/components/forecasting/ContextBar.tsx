/**
 * The one bar that says what the Forecasting screens are looking at: Group · Forecast · Date range, with an "Advanced" box for the interval and the queue. The choices live in the shared
 * forecasting state (see services/forecastView.ts), so they carry from page to page and from one visit to the next.
 */
import React, { useEffect, useRef, useState } from 'react';
import { CalendarDays, ChevronDown, Layers, LineChart, SlidersHorizontal } from 'lucide-react';
import { isNew, STATUS_LABEL } from '../../services/api';
import { useForecast } from '../../services/forecastStore';
import { DEFAULT_GRAIN, GRAINS, RANGES, advancedCount, covers, rangeForGrain, resolveWindow, type Grain, type Range } from '../../services/forecastView';
import { fmtDate } from '../../services/api';

const RANGE_LABEL: Record<Range, string> = { Day: 'Day', Week: 'Week', Month: 'All', 'Custom Range': 'Custom' };
const field = 'flex h-9 items-center gap-2 rounded-lg border bg-background px-3';
const shortDate = (d: string) => new Date(`${d}T00:00:00`).toLocaleDateString('en', { day: 'numeric', month: 'short', year: 'numeric' });

/** The less-used choices in one small box, so the bar itself stays one row. */
const Advanced: React.FC<{ count: number; children: (close: () => void) => React.ReactNode }> = ({ count, children }) => {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return undefined;
    const down = (e: MouseEvent) => { if (box.current && !box.current.contains(e.target as Node)) setOpen(false); };
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') { setOpen(false); box.current?.querySelector<HTMLElement>('button[aria-haspopup]')?.focus(); } };
    document.addEventListener('mousedown', down); document.addEventListener('keydown', key);
    return () => { document.removeEventListener('mousedown', down); document.removeEventListener('keydown', key); };
  }, [open]);
  return (
    <div ref={box} className="relative">
      <button type="button" aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen((o) => !o)} className={`${field} ${open ? 'border-foreground' : ''} hover:bg-surface`}>
        <SlidersHorizontal className="size-3.5 text-subtle-foreground" />
        <span className="font-medium">Advanced</span>
        {count > 0 && <span className="min-w-[18px] rounded-full bg-foreground px-1 text-center text-[11px] leading-[18px] text-background">{count}</span>}
        <ChevronDown className="size-3.5 text-subtle-foreground" />
      </button>
      {open && (
        <div role="dialog" aria-label="Advanced filters" className="absolute left-0 z-40 mt-1.5 w-72 space-y-3 rounded-lg border bg-background p-4 shadow-lg">
          {children(() => setOpen(false))}
        </div>
      )}
    </div>
  );
};

/** `mode="day"` is for pages that work on one day (Adjustments): no date-range switch, one Day box, and Queue alone behind Advanced. */
export function ContextBar({ shownGrain, actions, mode = 'full' }: { shownGrain: Grain; actions?: React.ReactNode; mode?: 'full' | 'day' }) {
  const { groups, group, setGroupId, versions, version, setVersionId, kind, view, setView } = useForecast();
  if (!group || !version || !view) return null;
  const win = resolveWindow(view, version, kind);
  const today = fmtDate(new Date());
  const oneDay = ((d: string) => (d < version.fromDay ? version.fromDay : d > version.toDay ? version.toDay : d))(view.start || version.fromDay);
  const canToday = covers(version, today) && (mode === 'day' ? oneDay !== today : !(view.range === 'Day' && win.from === today));
  const short = versions.filter((v) => v.kind === 'SHORT'), long = versions.filter((v) => v.kind === 'LONG');
  const label = (v: (typeof versions)[number]) => `${v.status === 'PUBLISHED' ? '● ' : ''}${v.name} — ${STATUS_LABEL[v.status].toLowerCase()}${isNew(v) ? ' — NEW' : ''}`;
  const queues = group.queues;

  return (
    <div className="flex flex-wrap items-center gap-3 border-b bg-surface px-6 py-3 text-[13px]" role="group" aria-label="What this page is showing">
      <label className={field}>
        <Layers className="size-3.5 text-subtle-foreground" />
        <span className="text-subtle-foreground">Group</span>
        <select value={group.id} onChange={(e) => setGroupId(e.target.value)} aria-label="Group" className="max-w-[150px] bg-transparent font-medium outline-none">
          {groups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
        </select>
      </label>

      <label className={field}>
        <LineChart className="size-3.5 text-subtle-foreground" />
        <span className="text-subtle-foreground">Forecast</span>
        <select value={version.id} onChange={(e) => setVersionId(e.target.value)} aria-label="Forecast" title={version.name} className="max-w-[230px] bg-transparent font-medium outline-none">
          {short.length > 0 && <optgroup label="Short-term">{short.map((v) => <option key={v.id} value={v.id}>{label(v)}</option>)}</optgroup>}
          {long.length > 0 && <optgroup label="Long-term">{long.map((v) => <option key={v.id} value={v.id}>{label(v)}</option>)}</optgroup>}
        </select>
      </label>

      {mode === 'day' ? (
        <div className="flex items-center gap-2">
          <label className={field}>
            <CalendarDays className="size-3.5 text-subtle-foreground" />
            <span className="text-subtle-foreground">Day</span>
            <input type="date" value={oneDay} min={version.fromDay} max={version.toDay} aria-label="Day" onChange={(e) => e.target.value && setView({ start: e.target.value })} className="bg-transparent font-medium outline-none" />
          </label>
          {canToday && <button type="button" onClick={() => setView({ start: today })} className="h-9 rounded-lg border bg-background px-3 font-medium hover:bg-surface">Today</button>}
        </div>
      ) : (
      <div className="flex items-center gap-2" role="group" aria-label="Date range">
        <div className="flex h-9 items-center rounded-lg border bg-background p-0.5">
          {RANGES.map((r) => (
            <button key={r} type="button" aria-pressed={view.range === r} onClick={() => setView({ range: r, grain: DEFAULT_GRAIN[r] })}
              className={`h-8 rounded-md px-3 transition-colors ${view.range === r ? 'bg-foreground font-medium text-background' : 'text-muted-foreground hover:bg-surface'}`}>{RANGE_LABEL[r]}</button>))}
        </div>
        {view.range !== 'Month' ? (
          <label className={field}>
            <CalendarDays className="size-3.5 text-subtle-foreground" />
            <span className="text-subtle-foreground">{view.range === 'Custom Range' ? 'From' : view.range === 'Week' ? 'Week from' : 'On'}</span>
            <input type="date" value={win.from} min={version.fromDay} max={version.toDay} aria-label={view.range === 'Custom Range' ? 'From' : 'Starting'} onChange={(e) => e.target.value && setView({ start: e.target.value })} className="bg-transparent font-medium outline-none" />
          </label>
        ) : <span className="text-muted-foreground">{shortDate(version.fromDay)} to {shortDate(version.toDay)}</span>}
        {view.range === 'Custom Range' && (
          <label className={field}>
            <span className="text-subtle-foreground">To</span>
            <input type="date" value={win.to} min={win.from} max={version.toDay} aria-label="To" onChange={(e) => e.target.value && setView({ end: e.target.value })} className="bg-transparent font-medium outline-none" />
          </label>)}
        {canToday && <button type="button" onClick={() => setView({ start: today, range: view.range === 'Month' ? 'Day' : view.range, grain: view.range === 'Month' ? DEFAULT_GRAIN.Day : view.grain })} className="h-9 rounded-lg border bg-background px-3 font-medium hover:bg-surface">Today</button>}
      </div>
      )}

      <Advanced count={mode === 'day' ? (view.queueId ? 1 : 0) : advancedCount(view, shownGrain)}>
        {(close) => (
          <>
            {mode === 'full' && (
            <label className="block space-y-1">
              <span className="text-[12px] font-medium text-subtle-foreground">Interval</span>
              <select value={shownGrain} onChange={(e) => { const g = e.target.value as Grain; setView({ grain: g, range: rangeForGrain(view.range, g) }); }} aria-label="Interval" className="h-9 w-full rounded-md border bg-background px-2">
                {GRAINS.map((g) => <option key={g.id} value={g.id}>{g.label}</option>)}
              </select>
            </label>
            )}
            <label className="block space-y-1">
              <span className="text-[12px] font-medium text-subtle-foreground">Queue</span>
              <select value={view.queueId} onChange={(e) => setView({ queueId: e.target.value })} aria-label="Queue" className="h-9 w-full rounded-md border bg-background px-2">
                <option value="">All queues</option>
                {queues.map((q) => <option key={q.id} value={q.id}>{q.name}</option>)}
              </select>
            </label>
            <div className="flex items-center justify-between pt-1">
              <button type="button" className="text-[12px] underline text-muted-foreground" onClick={() => setView(mode === 'day' ? { queueId: '' } : { grain: DEFAULT_GRAIN[view.range], queueId: '' })}>Reset</button>
              <button type="button" className="h-8 rounded-md border bg-background px-3 font-medium hover:bg-surface" onClick={close}>Done</button>
            </div>
          </>)}
      </Advanced>

      {actions && <div className="ml-auto flex items-center gap-2">{actions}</div>}
    </div>
  );
}
