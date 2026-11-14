/** Contextual help: an info icon with a small pop-over, and a "How this works" side panel. Longer explanations live here instead of in grey paragraphs. */
import React, { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { CircleHelp, Info, X } from 'lucide-react';
import { GLOSSARY, type HelpEntry, type HelpTopic } from '../../help/glossary';

type TipProps = { topic?: HelpTopic; title?: string; text?: React.ReactNode; example?: string; className?: string };

/** Info icon beside a label. Opens on hover, focus or click; closes on Escape, a click elsewhere or leaving it. */
export const HelpTip: React.FC<TipProps> = ({ topic, title, text, example, className = '' }) => {
  const entry: HelpEntry | undefined = topic ? GLOSSARY[topic] : undefined;
  const heading = title ?? entry?.title;
  const body = text ?? entry?.body;
  const eg = example ?? entry?.example;
  const [hover, setHover] = useState(false);
  const [pinned, setPinned] = useState(false);
  const [pos, setPos] = useState<{ left: number; top: number; above: boolean } | null>(null);
  const btn = useRef<HTMLButtonElement>(null);
  const pop = useRef<HTMLDivElement>(null);
  const id = useId();
  const open = hover || pinned;

  useLayoutEffect(() => {
    if (!open || !btn.current) { setPos(null); return; }
    const r = btn.current.getBoundingClientRect();
    const w = 300;
    const left = Math.min(Math.max(8, r.left + r.width / 2 - w / 2), window.innerWidth - w - 8);
    const above = r.bottom + 180 > window.innerHeight && r.top > 200;
    setPos({ left, top: above ? r.top - 6 : r.bottom + 6, above });
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const down = (e: MouseEvent) => {
      const t = e.target as Node;
      if (btn.current?.contains(t) || pop.current?.contains(t)) return;
      setPinned(false); setHover(false);
    };
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') { setPinned(false); setHover(false); } };
    const close = () => { setPinned(false); setHover(false); };
    document.addEventListener('mousedown', down); document.addEventListener('keydown', key);
    window.addEventListener('scroll', close, true); window.addEventListener('resize', close);
    return () => { document.removeEventListener('mousedown', down); document.removeEventListener('keydown', key); window.removeEventListener('scroll', close, true); window.removeEventListener('resize', close); };
  }, [open]);

  if (!body) return null;
  return (
    <>
      <button
        ref={btn} type="button" aria-label={`About ${heading ?? 'this field'}`} aria-expanded={open} aria-describedby={open ? id : undefined}
        className={`inline-flex items-center justify-center align-middle ml-1 text-[#8A8A85] hover:text-[#171717] focus:text-[#171717] focus:outline-none focus-visible:ring-2 focus-visible:ring-[#171717] rounded-full ${className}`}
        onClick={(e) => { e.preventDefault(); e.stopPropagation(); setPinned((p) => !p); }}
        onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)} onFocus={() => setHover(true)} onBlur={() => setHover(false)}
      >
        <Info className="w-3.5 h-3.5" />
      </button>
      {open && pos && createPortal(
        <div
          ref={pop} id={id} role="tooltip"
          style={{ position: 'fixed', left: pos.left, top: pos.top, width: 300, transform: pos.above ? 'translateY(-100%)' : undefined, zIndex: 80 }}
          className="bg-white border border-[#E5E5E0] rounded-lg shadow-lg p-3 text-left font-normal normal-case tracking-normal"
          onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}
        >
          {heading && <div className="text-[12px] font-semibold text-[#171717]">{heading}</div>}
          <div className="text-[12px] leading-relaxed text-[#525252] mt-0.5">{body}</div>
          {eg && <div className="mt-2 text-[12px] leading-relaxed text-[#525252] bg-[#FAFAF8] border border-[#EDEDE8] rounded px-2 py-1.5"><span className="font-semibold text-[#171717]">Example: </span>{eg}</div>}
        </div>,
        document.body,
      )}
    </>
  );
};

/** "How this works" button that opens a side panel. Closed by default; Escape or the close button dismisses it. */
export const PageHelp: React.FC<{ title: string; children: React.ReactNode }> = ({ title, children }) => {
  const [open, setOpen] = useState(false);
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    closeRef.current?.focus();
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('keydown', key);
    return () => document.removeEventListener('keydown', key);
  }, [open]);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)} className="inline-flex items-center gap-1.5 px-3 py-1.5 border border-[#E5E5E0] rounded-md text-[13px] text-[#525252] bg-white hover:bg-[#FAFAF8] hover:text-[#171717]">
        <CircleHelp className="w-4 h-4" />How this works
      </button>
      {open && createPortal(
        <div className="fixed inset-0 z-[70]" role="dialog" aria-modal="true" aria-label={title}>
          <div className="absolute inset-0 bg-black/20" onClick={() => setOpen(false)} />
          <aside className="absolute right-0 top-0 h-full w-full max-w-md bg-white border-l border-[#E5E5E0] shadow-xl flex flex-col">
            <header className="flex items-start justify-between gap-3 px-5 py-4 border-b border-[#E5E5E0]">
              <h2 className="text-[16px] font-semibold text-[#171717]">{title}</h2>
              <button ref={closeRef} type="button" aria-label="Close" className="p-1 text-[#6B6B6B] hover:text-[#171717]" onClick={() => setOpen(false)}><X className="w-4 h-4" /></button>
            </header>
            <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4 text-[13px] leading-relaxed text-[#404040]">{children}</div>
          </aside>
        </div>,
        document.body,
      )}
    </>
  );
};

/** A titled block inside a PageHelp panel. */
export const HelpSection: React.FC<{ title: string; children: React.ReactNode }> = ({ title, children }) => (
  <section><h3 className="text-[13px] font-semibold text-[#171717] mb-1">{title}</h3><div className="space-y-2">{children}</div></section>
);
