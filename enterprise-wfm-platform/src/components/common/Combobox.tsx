/**
 * A searchable list for choosing one value from a long list (time zones, countries): a box showing the choice, and under it a search field and the list in groups, each item with grey text on
 * the right. Arrow keys move, Enter chooses, Escape closes. The list opens over the page (not clipped by a dialog) and flips upward near the bottom of the screen. On a phone or tablet it is
 * the device's own picker instead. Rules for searching and moving are in services/comboFilter.ts.
 */
import React, { useEffect, useId, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronDown, Search } from 'lucide-react';
import { filterGroups, flatten, labelFor, step, type ComboGroup } from '../../services/comboFilter';

const isCoarsePointer = () => typeof window !== 'undefined' && !!window.matchMedia?.('(pointer: coarse)').matches;

export const Combobox: React.FC<{
  value: string; onChange: (value: string) => void; groups: ComboGroup[]; ariaLabel: string; id?: string; disabled?: boolean; placeholder?: string; searchPlaceholder?: string; className?: string;
}> = ({ value, onChange, groups, ariaLabel, id, disabled, placeholder = 'Choose…', searchPlaceholder = 'Search…', className = '' }) => {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(-1);
  const [box, setBox] = useState<{ top: number; left: number; width: number; up: boolean; max: number } | null>(null);
  const trigger = useRef<HTMLButtonElement>(null), panel = useRef<HTMLDivElement>(null), list = useRef<HTMLDivElement>(null), search = useRef<HTMLInputElement>(null);
  const listId = useId();
  const shown = useMemo(() => filterGroups(groups, query), [groups, query]);
  const flat = useMemo(() => flatten(shown), [shown]);
  const coarse = useMemo(isCoarsePointer, []);

  const place = () => {
    const r = trigger.current?.getBoundingClientRect(); if (!r) return;
    const below = window.innerHeight - r.bottom, up = below < 300 && r.top > below;
    setBox({ left: r.left, width: Math.max(r.width, 340), top: up ? r.top : r.bottom, up, max: Math.max(180, Math.min(360, (up ? r.top : below) - 70)) });
  };
  useEffect(() => {
    if (!open) return undefined;
    place();
    const down = (e: MouseEvent) => { const t = e.target as Node; if (!panel.current?.contains(t) && !trigger.current?.contains(t)) setOpen(false); };
    const move = () => place();
    document.addEventListener('mousedown', down); window.addEventListener('resize', move); window.addEventListener('scroll', move, true);
    const t = setTimeout(() => search.current?.focus(), 0);
    return () => { document.removeEventListener('mousedown', down); window.removeEventListener('resize', move); window.removeEventListener('scroll', move, true); clearTimeout(t); };
  }, [open]);
  // the highlight starts on the current choice, and follows the first match while typing
  useEffect(() => { if (open) setActive(query ? (flat.length ? 0 : -1) : Math.max(0, flat.findIndex((i) => i.value === value))); }, [open, query, flat.length]);
  useEffect(() => { if (open && active >= 0) list.current?.querySelector(`[data-i="${active}"]`)?.scrollIntoView({ block: 'nearest' }); }, [active, open]);

  const choose = (v: string) => { onChange(v); setOpen(false); setQuery(''); trigger.current?.focus(); };
  const key = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive((i) => step(i, 1, flat.length)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((i) => step(i, -1, flat.length)); }
    else if (e.key === 'Enter') { e.preventDefault(); if (flat[active]) choose(flat[active].value); }
    else if (e.key === 'Escape') { e.preventDefault(); setOpen(false); trigger.current?.focus(); }
    else if (e.key === 'Tab') setOpen(false);
  };

  if (coarse) {
    return (
      <select id={id} aria-label={ariaLabel} disabled={disabled} value={value} onChange={(e) => onChange(e.target.value)} className={`w-full p-2 border border-[#E5E5E0] rounded text-[13px] bg-white ${className}`}>
        {groups.map((g) => <optgroup key={g.label} label={g.label}>{g.items.map((i) => <option key={`${g.label}-${i.value}`} value={i.value}>{i.label}</option>)}</optgroup>)}
      </select>
    );
  }

  let n = -1;
  return (
    <>
      <button ref={trigger} id={id} type="button" disabled={disabled} aria-label={`${ariaLabel}: ${labelFor(groups, value) || placeholder}`} aria-haspopup="listbox" aria-expanded={open} aria-controls={open ? listId : undefined}
        onClick={() => setOpen((o) => !o)} onKeyDown={(e) => { if (e.key === 'ArrowDown' && !open) { e.preventDefault(); setOpen(true); } }}
        className={`flex w-full items-center justify-between gap-2 rounded border bg-white p-2 text-left text-[13px] text-[#171717] disabled:bg-[#FAFAF8] disabled:text-[#6B6B6B] ${open ? 'border-[#171717]' : 'border-[#E5E5E0] hover:border-[#C9C9C2]'} ${className}`}>
        <span className="truncate">{value ? labelFor(groups, value) : <span className="text-[#6B6B6B]">{placeholder}</span>}</span>
        <ChevronDown className={`h-4 w-4 shrink-0 text-[#6B6B6B] transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && box && createPortal(
        <div ref={panel} role="dialog" aria-label={ariaLabel} onKeyDown={key}
          style={{ position: 'fixed', left: box.left, width: box.width, zIndex: 2000, ...(box.up ? { bottom: window.innerHeight - box.top + 4 } : { top: box.top + 4 }) }}
          className="overflow-hidden rounded-lg border border-[#E5E5E0] bg-white shadow-xl">
          <div className="flex items-center gap-2 border-b border-[#E5E5E0] px-3 py-2">
            <Search className="h-3.5 w-3.5 shrink-0 text-[#6B6B6B]" />
            <input ref={search} role="combobox" aria-expanded aria-controls={listId} aria-activedescendant={active >= 0 ? `${listId}-${active}` : undefined} aria-autocomplete="list"
              value={query} onChange={(e) => setQuery(e.target.value)} placeholder={searchPlaceholder} className="w-full bg-transparent text-[13px] outline-none placeholder:text-[#9A9A94]" />
          </div>
          <div ref={list} id={listId} role="listbox" aria-label={ariaLabel} style={{ maxHeight: box.max }} className="overflow-auto py-1">
            {shown.length === 0 && <div className="px-3 py-3 text-[12px] text-[#6B6B6B]">Nothing matches “{query}”.</div>}
            {shown.map((g) => (
              <div key={g.label} role="group" aria-label={g.label}>
                <div className="px-3 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-wide text-[#8A8A84]">{g.label}</div>
                {g.items.map((it) => {
                  n += 1; const idx = n, on = it.value === value;
                  return (
                    <div key={`${g.label}-${it.value}`} id={`${listId}-${idx}`} data-i={idx} role="option" aria-selected={on} onMouseEnter={() => setActive(idx)} onMouseDown={(e) => { e.preventDefault(); choose(it.value); }}
                      className={`flex cursor-pointer items-center gap-2 px-3 py-1.5 text-[13px] ${idx === active ? 'bg-[#F5F5F0]' : ''}`}>
                      <Check className={`h-3.5 w-3.5 shrink-0 ${on ? 'text-[#171717]' : 'invisible'}`} />
                      <span className={`flex-1 truncate ${on ? 'font-semibold' : ''}`}>{it.label}</span>
                      {it.right && <span className="shrink-0 text-[12px] tabular-nums text-[#8A8A84]">{it.right}</span>}
                    </div>
                  );
                })}
              </div>
            ))}
          </div>
        </div>, document.body)}
    </>
  );
};
