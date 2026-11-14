/**
 * How the app waits. One set of rules, so every screen behaves the same:
 *   - Nothing at all for the first moment (a fast answer must not flash a skeleton).
 *   - Then a skeleton in the shape of what is coming (tables, cards, pages), so the layout does not jump when the data arrives; once shown it stays for a
 *     moment, so it does not flicker.
 *   - Information already on screen stays on screen while it refreshes ("Updating…"), and stays if the refresh fails (with a retry), instead of vanishing.
 *   - After a long wait it says so, and offers a retry.
 *   - Loading, empty, failed and "nothing yet" are four different things: "No groups yet" is never shown while the groups are still loading.
 * Actions (a save, a delete) use the small spinner (`Busy`); long jobs use their own progress card.
 */
import React, { useEffect, useRef, useState } from 'react';
import { Banner, Btn } from '../forecasting/ui';

/** True once `on` has been true for `delay` ms, and then for at least `minShow` ms more, however quickly `on` ends. */
export function useDelayed(on: boolean, delay = 200, minShow = 400): boolean {
  const [shown, setShown] = useState(() => delay <= 0 && on);
  const since = useRef(0);
  useEffect(() => {
    if (on && !shown) { const t = setTimeout(() => { since.current = Date.now(); setShown(true); }, Math.max(0, delay)); return () => clearTimeout(t); }
    if (!on && shown) { const left = Math.max(0, minShow - (Date.now() - since.current)); const t = setTimeout(() => setShown(false), left); return () => clearTimeout(t); }
    return undefined;
  }, [on, shown, delay, minShow]);
  useEffect(() => { if (shown && since.current === 0) since.current = Date.now(); }, [shown]);
  return shown;
}

/** True once `on` has lasted `ms`. For "this is taking longer than usual". */
export function useAfter(on: boolean, ms: number): boolean {
  const [late, setLate] = useState(false);
  useEffect(() => {
    if (!on) { setLate(false); return undefined; }
    const t = setTimeout(() => setLate(true), ms);
    return () => clearTimeout(t);
  }, [on, ms]);
  return late;
}

// ---------------------------------------------------------------- skeletons

const PULSE = 'bg-[#EDEDE8] rounded motion-safe:animate-pulse';
const WIDTHS = ['62%', '45%', '78%', '38%', '55%', '70%'];

export const SkeletonLine: React.FC<{ w?: string | number; h?: number; className?: string }> = ({ w = '100%', h = 12, className = '' }) => (
  <div aria-hidden="true" className={`${PULSE} ${className}`} style={{ width: w, height: h }} />
);
export const SkeletonBlock: React.FC<{ h?: number; className?: string }> = ({ h = 120, className = '' }) => <div aria-hidden="true" className={`${PULSE} w-full ${className}`} style={{ height: h }} />;

/** A table's header and rows, as grey bars. */
export const TableSkeleton: React.FC<{ rows?: number; cols?: number }> = ({ rows = 6, cols = 5 }) => (
  <div aria-hidden="true" className="border border-[#E5E5E0] rounded-lg overflow-hidden bg-white">
    <div className="flex gap-4 px-3 py-3 bg-[#FAFAF8] border-b border-[#E5E5E0]">{Array.from({ length: cols }, (_, c) => <SkeletonLine key={c} w={c === 0 ? '18%' : '10%'} h={9} />)}</div>
    {Array.from({ length: rows }, (_, r) => (
      <div key={r} className="flex gap-4 px-3 py-3.5 border-b border-[#F0F0EB] last:border-0">
        {Array.from({ length: cols }, (_, c) => <SkeletonLine key={c} w={c === 0 ? '22%' : WIDTHS[(r + c) % WIDTHS.length]} className={c === 0 ? '' : 'flex-1'} />)}
      </div>
    ))}
  </div>
);

/** A row of summary cards. */
export const CardsSkeleton: React.FC<{ n?: number }> = ({ n = 4 }) => (
  <div aria-hidden="true" className="grid grid-cols-2 md:grid-cols-4 gap-4">
    {Array.from({ length: n }, (_, i) => <div key={i} className="border border-[#E5E5E0] rounded-lg p-4 bg-white space-y-3"><SkeletonLine w="40%" h={9} /><SkeletonLine w="55%" h={22} /><SkeletonLine w="70%" h={9} /></div>)}
  </div>
);

/** The content area while a whole screen's code and first data arrive: header, cards, table. The menu and top bar stay where they are. */
export const PageSkeleton: React.FC<{ label?: string }> = ({ label = 'the page' }) => (
  <div role="status" aria-busy="true" className="p-6 space-y-5">
    <span className="sr-only">Loading {label}</span>
    <div className="space-y-2"><SkeletonLine w={220} h={22} /><SkeletonLine w={380} h={11} /></div>
    <CardsSkeleton />
    <TableSkeleton rows={7} cols={6} />
  </div>
);

// ---------------------------------------------------------------- drop-ins for screens that already branch on loading / error themselves

type Shape = 'table' | 'cards' | 'panel' | 'lines';
const shapeOf = (shape: Shape) => shape === 'cards' ? <CardsSkeleton /> : shape === 'panel' ? <SkeletonBlock h={160} /> : shape === 'lines' ? <div className="space-y-2"><SkeletonLine w="60%" /><SkeletonLine w="85%" /><SkeletonLine w="45%" /></div> : <TableSkeleton rows={5} cols={5} />;

/**
 * The first-load placeholder, for where a screen wrote `if (x.loading && !x.data) return <Busy …/>`:
 * nothing for a moment, then a skeleton in the shape of the data, and a "taking longer than usual" note with a retry after a while.
 */
export const Waiting: React.FC<{ what: string; shape?: Shape; skeleton?: React.ReactNode; reload?: () => void; slowAfterMs?: number; delayMs?: number }> = ({ what, shape = 'table', skeleton, reload, slowAfterMs = 10000, delayMs = 200 }) => {
  const show = useDelayed(true, delayMs);
  const slow = useAfter(true, slowAfterMs);
  return (
    <div role="status" aria-busy="true" className="min-h-[96px]">
      <span className="sr-only">Loading {what}</span>
      {show && (skeleton ?? shapeOf(shape))}
      {slow && <div className="mt-3 text-[12px] text-[#737373] flex items-center gap-3">Still loading {what}. This is taking longer than usual. {reload && <Btn onClick={reload}>Try again</Btn>}</div>}
    </div>
  );
};

/** A load that failed with nothing to show: says what, why, and offers a retry. */
export const LoadFailed: React.FC<{ what: string; error: string; reload?: () => void }> = ({ what, error, reload }) => (
  <div role="alert" className="border border-[#C84A4A]/30 bg-[#FCEBEC] rounded-lg p-4 space-y-2">
    <div className="text-[13px] text-[#C84A4A] font-semibold">{what[0].toUpperCase() + what.slice(1)} could not be loaded.</div>
    <div className="text-[12px] text-[#525252]">{error}</div>
    {reload && <Btn onClick={reload}>Try again</Btn>}
  </div>
);

/** For a screen that keeps its own data on screen: when a refresh fails the last information stays, with this warning and a retry. */
export const StaleNote: React.FC<{ state: LoadSource<unknown>; what: string }> = ({ state, what }) => state.data !== null && state.error
  ? <div role="alert" className="mb-3"><Banner kind="warn"><span>Could not refresh {what}: {state.error} The last information is shown.</span> {state.reload && <Btn onClick={state.reload}>Try again</Btn>}</Banner></div>
  : null;

// ---------------------------------------------------------------- the whole state of one piece of data

export interface LoadSource<T> { data: T | null; error: string; loading: boolean; refreshing?: boolean; reload?: () => void }

/**
 * Shows the right thing for a piece of data loaded with `useApi`:
 *   first load            -> `skeleton` (after a short pause), plus a "taking longer than usual" note after `slowAfterMs`
 *   data, refreshing      -> the data, with a small "Updating…"
 *   data, refresh failed  -> the data, with a warning and a retry
 *   no data, failed       -> an error card with a retry
 *   data, nothing in it   -> `empty` (only when `isEmpty` says so)
 */
export function LoadState<T>({ state, what, skeleton, isEmpty, empty, slowAfterMs = 10000, delayMs = 200, children }: {
  state: LoadSource<T>; what: string; skeleton?: React.ReactNode; isEmpty?: (d: T) => boolean; empty?: React.ReactNode; slowAfterMs?: number; delayMs?: number; children: (d: T) => React.ReactNode;
}) {
  const first = state.loading && state.data === null;
  const showSkeleton = useDelayed(first, delayMs);
  const slow = useAfter(first, slowAfterMs);
  const retry = state.reload ? <Btn onClick={state.reload}>Try again</Btn> : null;

  if (state.data !== null) {
    return (
      <div aria-busy={state.refreshing || undefined}>
        {state.error && <div role="alert" className="mb-3"><Banner kind="warn"><span>Could not refresh {what}: {state.error} The last information is shown.</span> {retry}</Banner></div>}
        {state.refreshing && !state.error && <div role="status" aria-live="polite" className="text-[11px] text-[#737373] text-right mb-1">Updating…</div>}
        {isEmpty?.(state.data) ? empty ?? null : children(state.data)}
      </div>
    );
  }
  if (state.error) {
    return <div role="alert" className="border border-[#C84A4A]/30 bg-[#FCEBEC] rounded-lg p-4 space-y-2"><div className="text-[13px] text-[#C84A4A] font-semibold">{what[0].toUpperCase() + what.slice(1)} could not be loaded.</div><div className="text-[12px] text-[#525252]">{state.error}</div>{retry}</div>;
  }
  if (first) {
    return (
      <div role="status" aria-busy="true" className="min-h-[96px]">
        <span className="sr-only">Loading {what}</span>
        {showSkeleton && (skeleton ?? <TableSkeleton />)}
        {slow && <div className="mt-3 text-[12px] text-[#737373] flex items-center gap-3">Still loading {what}. This is taking longer than usual. {retry}</div>}
      </div>
    );
  }
  return null;
}
