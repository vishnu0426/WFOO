/** Employee form pickers that stay usable with hundreds of groups and skills: a searchable list with chips, instead of a wall of checkboxes. */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { Input, Select } from '../forecasting/ui';

/** Closes a pop-over list on a click outside it or the Escape key. */
function useDismiss(open: boolean, close: () => void) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const down = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) close(); };
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
    document.addEventListener('mousedown', down); document.addEventListener('keydown', key);
    return () => { document.removeEventListener('mousedown', down); document.removeEventListener('keydown', key); };
  }, [open]);
  return ref;
}

export type PickGroup = { id: string; name: string; siteId?: string | null };
export type PickSite = { id: string; name: string };

/** "Can also be scheduled for": chosen groups as chips, a search box to add more, and a shortcut to add every group at a site. */
export const GroupsPicker: React.FC<{ groups: PickGroup[]; sites: PickSite[]; chosen: string[]; exclude?: string; onChange: (ids: string[]) => void }> = ({ groups, sites, chosen, exclude, onChange }) => {
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const boxRef = useDismiss(open, () => { setOpen(false); setQ(''); });
  const siteName = (id?: string | null) => sites.find((s) => s.id === id)?.name;
  const pool = groups.filter((g) => g.id !== exclude);
  const picked = pool.filter((g) => chosen.includes(g.id));
  const matches = useMemo(() => pool.filter((g) => !chosen.includes(g.id) && (!q.trim() || `${g.name} ${siteName(g.siteId) ?? ''}`.toLowerCase().includes(q.trim().toLowerCase()))).slice(0, 30), [pool, chosen, q]);
  const sitesWithGroups = sites.filter((s) => pool.some((g) => g.siteId === s.id && !chosen.includes(g.id)));
  if (pool.length === 0) return <span className="text-[12px] text-[#6B6B6B]">No other groups.</span>;
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-1.5 min-h-[28px]">
        {picked.length === 0 && <span className="text-[12px] text-[#6B6B6B] py-1">Only their main group. Add more if they cover other groups too.</span>}
        {picked.map((g) => (
          <span key={g.id} className="inline-flex items-center gap-1.5 bg-[#F0F4F8] border border-[#D6DEE8] rounded-full pl-2.5 pr-1.5 py-0.5 text-[12px]">
            {g.name}{siteName(g.siteId) && <span className="text-[#6B6B6B]">{siteName(g.siteId)}</span>}
            <button type="button" aria-label={`Remove ${g.name}`} className="p-0.5 text-[#6B6B6B] hover:text-[#171717]" onClick={() => onChange(chosen.filter((x) => x !== g.id))}><X className="w-3 h-3" /></button>
          </span>
        ))}
        {picked.length > 3 && <button type="button" className="text-[12px] underline text-[#525252]" onClick={() => onChange([])}>Clear all</button>}
      </div>
      <div className="flex flex-wrap items-start gap-2">
        <div className="relative w-72" ref={boxRef}>
          <Input aria-label="Find a group to add" placeholder="Find a group or site to add" value={q} onFocus={() => setOpen(true)} onChange={(e) => { setQ(e.target.value); setOpen(true); }} />
          {open && (
            <div className="absolute z-20 mt-1 w-full max-h-64 overflow-y-auto bg-white border border-[#E5E5E0] rounded-md shadow-lg">
              {matches.length === 0 ? <div className="px-3 py-2 text-[12px] text-[#6B6B6B]">{q.trim() ? 'No group matches.' : 'Every group is already added.'}</div> : matches.map((g) => (
                <button key={g.id} type="button" className="w-full flex items-center justify-between gap-3 px-3 py-1.5 text-left text-[13px] hover:bg-[#FAFAF8]" onClick={() => { onChange([...chosen, g.id]); setQ(''); setOpen(false); }}>
                  <span>{g.name}</span><span className="text-[11px] text-[#6B6B6B]">{siteName(g.siteId) ?? 'No site'}</span>
                </button>
              ))}
              <button type="button" className="w-full px-3 py-1.5 text-left text-[12px] text-[#525252] border-t border-[#E5E5E0] hover:bg-[#FAFAF8]" onClick={() => { setOpen(false); setQ(''); }}>Done</button>
            </div>
          )}
        </div>
        {sitesWithGroups.length > 0 && (
          <div className="w-60"><Select aria-label="Add every group at a site" value="" onChange={(e) => e.target.value && onChange([...new Set([...chosen, ...pool.filter((g) => g.siteId === e.target.value).map((g) => g.id)])])}><option value="">Add all groups at a site…</option>{sitesWithGroups.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</Select></div>
        )}
      </div>
    </div>
  );
};

export type PickSkill = { id: string; name: string; status: string };
const LEVELS = ['Learning', 'Basic', 'Competent', 'Advanced', 'Expert'];

/** Skills a person has, as rows with a level; new ones are added from a search box. */
export const SkillsPicker: React.FC<{ skills: PickSkill[]; value: Record<string, number>; onChange: (v: Record<string, number>) => void }> = ({ skills, value, onChange }) => {
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const boxRef = useDismiss(open, () => { setOpen(false); setQ(''); });
  const active = skills.filter((s) => s.status === 'ACTIVE');
  const have = active.filter((s) => s.id in value);
  const matches = active.filter((s) => !(s.id in value) && (!q.trim() || s.name.toLowerCase().includes(q.trim().toLowerCase()))).slice(0, 30);
  if (skills.length === 0) return <span className="text-[12px] text-[#6B6B6B]">No skills defined yet. Add some under Workforce › Skills.</span>;
  return (
    <div className="space-y-2">
      {have.length === 0 ? <p className="text-[12px] text-[#6B6B6B]">No skills yet. Add the ones this person can do.</p> : (
        <ul className="divide-y divide-[#F0F0EC] border border-[#E5E5E0] rounded-lg max-w-xl">
          {have.map((s) => (
            <li key={s.id} className="flex items-center gap-3 px-3 py-1.5 text-[13px]">
              <span className="flex-1 font-medium">{s.name}</span>
              <div className="flex items-center gap-1" role="radiogroup" aria-label={`Level for ${s.name}`}>
                {[1, 2, 3, 4, 5].map((n) => <button key={n} type="button" role="radio" aria-checked={value[s.id] === n} title={`${n}: ${LEVELS[n - 1]}`} onClick={() => onChange({ ...value, [s.id]: n })} className={`w-6 h-6 rounded text-[11px] font-semibold border ${value[s.id] >= n ? 'bg-[#171717] text-white border-[#171717]' : 'bg-white text-[#6B6B6B] border-[#E5E5E0] hover:border-[#A3A3A3]'}`}>{n}</button>)}
              </div>
              <span className="w-20 text-[11px] text-[#6B6B6B]">{LEVELS[(value[s.id] ?? 3) - 1]}</span>
              <button type="button" aria-label={`Remove ${s.name}`} className="text-[#6B6B6B] hover:text-[#BC3F3F]" onClick={() => { const n = { ...value }; delete n[s.id]; onChange(n); }}><X className="w-3.5 h-3.5" /></button>
            </li>
          ))}
        </ul>
      )}
      <div className="relative w-72" ref={boxRef}>
        <Input aria-label="Find a skill to add" placeholder="Add a skill" value={q} onFocus={() => setOpen(true)} onChange={(e) => { setQ(e.target.value); setOpen(true); }} />
        {open && (
          <div className="absolute z-20 mt-1 w-full max-h-56 overflow-y-auto bg-white border border-[#E5E5E0] rounded-md shadow-lg">
            {matches.length === 0 ? <div className="px-3 py-2 text-[12px] text-[#6B6B6B]">{q.trim() ? 'No skill matches.' : 'Every skill is added.'}</div> : matches.map((s) => (
              <button key={s.id} type="button" className="w-full px-3 py-1.5 text-left text-[13px] hover:bg-[#FAFAF8]" onClick={() => { onChange({ ...value, [s.id]: 3 }); setQ(''); setOpen(false); }}>{s.name}</button>
            ))}
            <button type="button" className="w-full px-3 py-1.5 text-left text-[12px] text-[#525252] border-t border-[#E5E5E0] hover:bg-[#FAFAF8]" onClick={() => { setOpen(false); setQ(''); }}>Done</button>
          </div>
        )}
      </div>
      <p className="text-[11px] text-[#6B6B6B]">1 learning, 3 competent, 5 expert.</p>
    </div>
  );
};
