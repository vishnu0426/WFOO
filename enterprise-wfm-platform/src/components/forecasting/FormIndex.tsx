/**
 * A section index for a long form: a list of its sections that follows the reader (the one in view is marked) and jumps to a section when clicked. A rail down the left on wide screens, a
 * strip along the top on narrower ones. The template for the other long forms: give each section an element with id "sec-<id>", list them here, and put the form's buttons in a
 * sticky footer (see StickyFooter).
 */
import React, { useEffect, useRef, useState } from 'react';
import { activeSection } from '../../services/forecastForm';

export interface FormSection { id: string; label: string; badge?: { text: string; tone: 'warn' | 'bad' | 'good' } | null }

const TONE = { warn: 'bg-warning-bg text-warning', bad: 'bg-critical-bg text-critical', good: 'bg-success-bg text-success' } as const;
const HEADER = 56;      // how far below the top of the scrolling area a section stops when jumped to (room for the strip)

/** The scrolling area a form sits in: its nearest ancestor that scrolls. */
export function scrollParent(el: HTMLElement | null): HTMLElement | null {
  for (let p = el?.parentElement ?? null; p; p = p.parentElement) { const o = getComputedStyle(p).overflowY; if ((o === 'auto' || o === 'scroll') && p.scrollHeight > p.clientHeight + 1) return p; }     // one that really scrolls
  return (document.scrollingElement as HTMLElement | null) ?? null;                                                                                                                  // else the page itself
}

/**
 * Scroll the page's own scrolling area so `el` is `offset` px from its top. (Not `scrollIntoView`: that also scrolls the app's overflow-hidden frame and pushes the sidebar and header out of place.)
 */
export function scrollToEl(el: HTMLElement, offset = HEADER, behavior: ScrollBehavior = 'smooth') {
  const root = scrollParent(el);
  if (!root) return;
  const base = root === document.scrollingElement ? 0 : root.getBoundingClientRect().top;
  root.scrollTo({ top: root.scrollTop + el.getBoundingClientRect().top - base - offset, behavior });
}

/** Which section is in view as the page scrolls, and a way to jump to one. `anchor` is any element inside the form. */
export function useScrollSpy(ids: string[], anchor: React.RefObject<HTMLElement | null>) {
  const [active, setActive] = useState(ids[0] ?? '');
  const lock = useRef(0);                                   // after a click, the smooth scroll passes other sections: do not let the mark follow it
  useEffect(() => {
    const root = scrollParent(anchor.current);
    if (!root) return undefined;
    const doc = root === document.scrollingElement, target: HTMLElement | Window = doc ? window : root;
    let raf = 0;
    const compute = () => {
      raf = 0;
      if (Date.now() < lock.current) return;
      const base = doc ? 0 : root.getBoundingClientRect().top;
      const seen = doc ? window.innerHeight : root.clientHeight;
      if (root.scrollTop + seen >= root.scrollHeight - 4 && root.scrollTop > 0) { setActive(ids[ids.length - 1]); return; }      // at the very bottom the last section is the one being read
      const pos = ids.flatMap((id) => { const el = document.getElementById(`sec-${id}`); return el ? [{ id, top: el.getBoundingClientRect().top - base }] : []; });
      const a = activeSection(pos, HEADER + 64);
      if (a) setActive(a);
    };
    const on = () => { if (!raf) raf = requestAnimationFrame(compute); };
    target.addEventListener('scroll', on, { passive: true }); window.addEventListener('resize', on); compute();
    return () => { target.removeEventListener('scroll', on); window.removeEventListener('resize', on); if (raf) cancelAnimationFrame(raf); };
  }, [ids.join('|')]);                                     // eslint-disable-line react-hooks/exhaustive-deps
  const go = (id: string) => {
    const el = document.getElementById(`sec-${id}`), root = scrollParent(anchor.current);
    if (!el || !root) return;
    setActive(id); lock.current = Date.now() + 800;
    const base = root === document.scrollingElement ? 0 : root.getBoundingClientRect().top;
    root.scrollTo({ top: root.scrollTop + el.getBoundingClientRect().top - base - HEADER, behavior: 'smooth' });
  };
  return { active, go };
}

export const SectionNav: React.FC<{ sections: FormSection[]; active: string; onGo: (id: string) => void; variant: 'rail' | 'strip' }> = ({ sections, active, onGo, variant }) => {
  const item = (s: FormSection) => (
    <button key={s.id} type="button" onClick={() => onGo(s.id)} aria-current={active === s.id ? 'true' : undefined}
      className={`flex items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-[13px] whitespace-nowrap transition-colors ${active === s.id ? 'bg-surface-subtle font-semibold text-foreground' : 'text-muted-foreground hover:bg-surface hover:text-foreground'}`}>
      {s.label}
      {s.badge && <span className={`rounded-full px-1.5 py-0.5 text-[11px] font-medium ${TONE[s.badge.tone]}`}>{s.badge.text}</span>}
    </button>
  );
  return variant === 'rail'
    ? <nav aria-label="Sections of this form" className="sticky top-4 hidden space-y-0.5 self-start py-6 pl-6 pr-2 2xl:block">{sections.map(item)}</nav>
    : <nav aria-label="Jump to a section" className="sticky top-0 z-20 flex gap-1 overflow-x-auto border-b bg-background px-6 py-2 2xl:hidden">{sections.map(item)}</nav>;
};

/** The buttons of a long form, always in reach at the foot of the screen, with a line on the left for what will happen or what is in the way. */
export const StickyFooter: React.FC<{ summary: React.ReactNode; notes?: React.ReactNode; children: React.ReactNode }> = ({ summary, notes, children }) => (
  <div className="sticky bottom-0 z-30 flex flex-wrap items-center gap-x-6 gap-y-2 border-t bg-background px-6 py-3 shadow-[0_-4px_12px_rgba(0,0,0,0.04)]" role="region" aria-label="Form actions">
    <div className="min-w-0 flex-1 text-[13px]">
      <div className="truncate font-medium">{summary}</div>
      {notes && <div className="mt-0.5 space-y-0.5 text-[12px]">{notes}</div>}
    </div>
    <div className="flex items-center gap-2">{children}</div>
  </div>
);
