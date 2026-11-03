/**
 * A drop-down that lets you tick several values (several groups, teams, statuses...). Nothing ticked means "all", which is how a filter
 * behaves when it is not set. Same look as the single drop-downs so a row of filters stays tidy.
 */
import React, { useEffect, useId, useMemo, useRef, useState } from 'react';
import { Check, ChevronDown } from 'lucide-react';

export type MultiOption = { value: string; label: string; hint?: string };

/** "All groups", "Billing", "Billing, Chat" or "3 groups": short enough to sit in a filter bar. */
export function summarise(selected: string[], options: MultiOption[], allLabel: string, noun: [string, string]): string {
  const names = options.filter((o) => selected.includes(o.value)).map((o) => o.label);
  if (names.length === 0) return allLabel;
  if (names.length === 1) return names[0];
  const joined = names.join(', ');
  return joined.length <= 24 ? joined : `${names.length} ${noun[1]}`;
}

export const MultiSelect: React.FC<{
  value: string[]; onChange: (v: string[]) => void; options: MultiOption[];
  allLabel: string; ariaLabel: string; noun?: [string, string]; className?: string; disabled?: boolean; searchable?: boolean;
}> = ({ value, onChange, options, allLabel, ariaLabel, noun = ['item', 'items'], className = '', disabled, searchable }) => {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const box = useRef<HTMLDivElement>(null);
  const id = useId();

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => { if (box.current && !box.current.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDown); document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey); };
  }, [open]);
  useEffect(() => { if (!open) setQ(''); }, [open]);

  const shown = useMemo(() => (q.trim() ? options.filter((o) => o.label.toLowerCase().includes(q.trim().toLowerCase())) : options), [options, q]);
  const toggle = (v: string) => onChange(value.includes(v) ? value.filter((x) => x !== v) : [...value, v]);
  const showSearch = searchable ?? options.length > 8;
  const active = value.length > 0;

  return (
    <div ref={box} className={`relative inline-block ${className}`}>
      <button type="button" disabled={disabled} aria-label={ariaLabel} aria-haspopup="listbox" aria-expanded={open} aria-controls={id} onClick={() => setOpen((o) => !o)}
        className={`w-full min-w-[9rem] flex items-center justify-between gap-2 p-2 border rounded text-[13px] bg-white text-left disabled:bg-[#FAFAF8] disabled:text-[#6B6B6B] ${active ? 'border-[#171717]' : 'border-[#E5E5E0]'}`}>
        <span className="truncate">{summarise(value, options, allLabel, noun)}</span>
        <ChevronDown className="w-3.5 h-3.5 text-[#737373] shrink-0" />
      </button>
      {open && (
        <div id={id} role="listbox" aria-multiselectable="true" className="absolute z-30 mt-1 w-64 max-w-[80vw] bg-white border border-[#E5E5E0] rounded-lg shadow-lg">
          {showSearch && <div className="p-2 border-b border-[#E5E5E0]"><input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search…" aria-label={`Search ${noun[1]}`} className="w-full p-1.5 border border-[#E5E5E0] rounded text-[12px]" /></div>}
          <div className="flex items-center justify-between px-3 py-1.5 text-[12px] border-b border-[#E5E5E0]">
            <button type="button" className="underline text-[#525252]" onClick={() => onChange([...new Set([...value, ...shown.map((o) => o.value)])])}>Select {q.trim() ? 'shown' : 'all'}</button>
            <button type="button" className="underline text-[#525252] disabled:opacity-40" disabled={!active} onClick={() => onChange([])}>Clear</button>
          </div>
          <div className="max-h-64 overflow-y-auto py-1">
            {shown.length === 0 && <div className="px-3 py-2 text-[12px] text-[#737373]">Nothing matches.</div>}
            {shown.map((o) => {
              const on = value.includes(o.value);
              return (
                <label key={o.value} role="option" aria-selected={on} className="flex items-center gap-2 px-3 py-1.5 text-[13px] cursor-pointer hover:bg-[#FAFAF8] focus-within:bg-[#F5F5F2]">
                  <input type="checkbox" checked={on} onChange={() => toggle(o.value)} className="sr-only" />
                  <span className={`w-4 h-4 rounded border flex items-center justify-center shrink-0 ${on ? 'bg-[#171717] border-[#171717] text-white' : 'border-[#D6D6D0] bg-white'}`}>{on && <Check className="w-3 h-3" />}</span>
                  <span className="flex-1 truncate">{o.label}</span>
                  {o.hint && <span className="text-[11px] text-[#737373]">{o.hint}</span>}
                </label>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
};
