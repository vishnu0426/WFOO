/**
 * A button that opens a small panel under it. Closes on Escape, on a click outside, and when asked to by what is inside.
 * For the "less used" controls of a toolbar, so the toolbar itself stays one tidy row.
 */
import React, { useEffect, useRef, useState } from 'react';
import { ChevronDown } from 'lucide-react';

export const Popover: React.FC<{
  label: React.ReactNode;
  badge?: number;
  align?: 'left' | 'right';
  width?: number;
  ariaLabel?: string;
  /** a plain icon button with no label arrow, e.g. the "more" menu */
  iconOnly?: boolean;
  children: (close: () => void) => React.ReactNode;
}> = ({ label, badge = 0, align = 'left', width = 260, ariaLabel, iconOnly, children }) => {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return undefined;
    const down = (e: MouseEvent) => { if (box.current && !box.current.contains(e.target as Node)) setOpen(false); };
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', down); document.addEventListener('keydown', key);
    return () => { document.removeEventListener('mousedown', down); document.removeEventListener('keydown', key); };
  }, [open]);
  return (
    <div ref={box} className="relative">
      <button type="button" aria-haspopup="true" aria-expanded={open} aria-label={ariaLabel} onClick={() => setOpen((o) => !o)}
        className={`inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-[12px] font-medium ${open ? 'border-[#171717] bg-[#FAFAF8]' : 'border-[#E5E5E0] bg-white hover:bg-[#FAFAF8]'}`}>
        {label}
        {badge > 0 && <span className="min-w-[16px] rounded-full bg-[#171717] px-1 text-center text-[10px] leading-4 text-white">{badge}</span>}
        {!iconOnly && <ChevronDown className="h-3 w-3 text-[#6B6B6B]" />}
      </button>
      {open && (
        <div role="dialog" className={`absolute z-40 mt-1.5 rounded-lg border border-[#E5E5E0] bg-white p-3 shadow-lg ${align === 'right' ? 'right-0' : 'left-0'}`} style={{ width }}>
          {children(() => setOpen(false))}
        </div>
      )}
    </div>
  );
};
