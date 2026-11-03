/**
 * Choose one person from a drop-down list that opens on click, with a search box in it. The list comes from the gateway a page at a time ("Show more"),
 * so it is as quick for 50,000 people as for 50 (a plain drop-down with every person as an option takes a minute to build once an organisation is large).
 * Each row says who the person is (team, group, supervisor or manager, and their status when it is not Active), so two people with one name can be told apart.
 */
import React, { useEffect, useRef, useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { api, Employee } from '../../services/api';

interface Props {
  value: string;
  onChange: (id: string, person: Employee | null) => void;
  /** Only people with this status are offered (for example ACTIVE); a switch in the list adds people on leave, onboarding or suspended. */
  status?: string;
  /** Several statuses, comma separated (for example ONBOARDING,ACTIVE,LEAVE). Used instead of `status`, with no switch. */
  statuses?: string;
  groupId?: string;
  teamId?: string;
  /** Offer only people marked as supervisors (or managers), with a switch to show everyone. Choosing someone unmarked offers to mark them. */
  only?: 'supervisor' | 'manager';
  placeholder?: string;
  ariaLabel?: string;
  className?: string;
}

const PAGE = 25;
const WIDER = 'ONBOARDING,ACTIVE,LEAVE,SUSPENDED';
const STATUS_WORD: Record<string, string> = { ONBOARDING: 'Onboarding', LEAVE: 'On leave', SUSPENDED: 'Suspended', TERMINATED: 'Left' };

export const PersonPicker: React.FC<Props> = ({ value, onChange, status, statuses, groupId, teamId, only, placeholder = 'Choose a person', ariaLabel = 'Person', className = '' }) => {
  const [text, setText] = useState('');
  const [term, setTerm] = useState('');
  const [items, setItems] = useState<Employee[]>([]);
  const [more, setMore] = useState(false);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState('');
  const [chosen, setChosen] = useState<Employee | null>(null);
  const [wider, setWider] = useState(false);               // people on leave, onboarding or suspended as well
  const [everyone, setEveryone] = useState(false);         // not only the people marked as supervisors / managers
  const [active, setActive] = useState(0);
  const [mark, setMark] = useState<Employee | null>(null); // someone unmarked, waiting for "mark and choose"
  const [markError, setMarkError] = useState('');
  const box = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const id = useRef(`pp-${Math.random().toString(36).slice(2, 8)}`).current;
  const markWord = only === 'manager' ? 'manager' : 'supervisor';

  // a person already chosen elsewhere (editing a record): show their name
  useEffect(() => {
    if (!value) { setChosen(null); return; }
    if (chosen?.id === value) return;
    let live = true;
    api<Employee>(`/workforce/employees/${value}`).then((p) => live && setChosen(p)).catch(() => live && setChosen(null));
    return () => { live = false; };
  }, [value]);   // eslint-disable-line react-hooks/exhaustive-deps

  // what is typed, used after a short pause
  useEffect(() => { const t = setTimeout(() => setTerm(text.trim()), 200); return () => clearTimeout(t); }, [text]);

  const params = (offset: number) => {
    const st = statuses ?? (status ? (wider ? WIDER : status) : '');
    const qs = new URLSearchParams({ limit: String(PAGE), offset: String(offset), sort: 'name' });
    if (term) qs.set('q', term);
    if (st) qs.set(st.includes(',') ? 'statuses' : 'status', st);
    if (groupId) qs.set('groupId', groupId);
    if (teamId) qs.set('teamId', teamId);
    if (only && !everyone) qs.set(only === 'manager' ? 'isManager' : 'isSupervisor', 'true');
    return qs;
  };
  const filterKey = `${term}|${status}|${statuses}|${groupId}|${teamId}|${only}|${wider}|${everyone}`;

  // the first page, whenever the list is opened or what it is filtered by changes
  useEffect(() => {
    if (!open) return;
    let live = true;
    setBusy(true); setFailed('');
    api<Employee[]>(`/workforce/employees?${params(0)}`)
      .then((r) => { if (!live) return; const rows = Array.isArray(r) ? r : []; setItems(rows); setMore(rows.length === PAGE); setActive(0); setBusy(false); })
      .catch((e) => { if (live) { setItems([]); setMore(false); setBusy(false); setFailed(e?.message || 'The list could not be loaded.'); } });
    return () => { live = false; };
  }, [open, filterKey]);   // eslint-disable-line react-hooks/exhaustive-deps

  const showMore = () => {
    setBusy(true);
    api<Employee[]>(`/workforce/employees?${params(items.length)}`)
      .then((r) => { const rows = Array.isArray(r) ? r : []; setItems((cur) => [...cur, ...rows.filter((x) => !cur.some((c) => c.id === x.id))]); setMore(rows.length === PAGE); })
      .catch((e) => setFailed(e?.message || 'The list could not be loaded.'))
      .finally(() => setBusy(false));
  };

  useEffect(() => {
    const away = (e: MouseEvent) => { if (box.current && !box.current.contains(e.target as Node)) { setOpen(false); setMark(null); } };
    document.addEventListener('mousedown', away);
    return () => document.removeEventListener('mousedown', away);
  }, []);

  const close = () => { setOpen(false); setMark(null); setMarkError(''); setText(''); };
  const choose = (p: Employee | null) => { setChosen(p); close(); onChange(p?.id ?? '', p); };
  const pick = (p: Employee) => {
    if (only && !(only === 'manager' ? p.isManager : p.isSupervisor)) { setMark(p); setMarkError(''); return; }
    choose(p);
  };
  const markAndChoose = async () => {
    if (!mark) return;
    try { const saved = await api<Employee>(`/workforce/employees/${mark.id}`, { method: 'PUT', body: { ...(only === 'manager' ? { isManager: true } : { isSupervisor: true }), reason: `Marked as ${markWord} so they can be chosen for the job` } }); choose(saved); }
    catch (e: any) { setMarkError(e?.message || 'That could not be saved.'); }
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); if (!open) setOpen(true); else setActive((i) => Math.min(items.length - 1, i + 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((i) => Math.max(0, i - 1)); }
    else if (e.key === 'Enter') { if (open && items[active]) { e.preventDefault(); pick(items[active]); } }
    else if (e.key === 'Escape' || e.key === 'Tab') { if (open) close(); }
  };

  const describe = (p: Employee) => [p.teamName, p.primaryGroupName].filter(Boolean).join(' · ');
  const empty = failed ? failed
    : term ? `Nobody matches "${term}".${status && !wider && !statuses ? ' People on leave, onboarding or suspended are not shown: tick the box below to include them.' : ''}${only && !everyone ? ` Only people marked as a ${markWord} are listed: tick "Show everyone" to find someone else.` : ''}`
    : `Nobody to show.${only && !everyone ? ` Nobody is marked as a ${markWord} yet: tick "Show everyone", choose the person, and they will be marked.` : ''}`;

  return (
    <div ref={box} className={`relative ${className}`} onKeyDown={onKey}>
      {value && chosen && !open ? (
        <div className="flex items-center justify-between gap-2 w-full rounded-lg border border-[#E5E5E0] bg-white px-3 py-2 text-[13px]">
          <button type="button" className="text-left truncate flex-1" onClick={() => { setOpen(true); setText(''); }} aria-label={`${ariaLabel}: ${chosen.name}. Change`}>
            {chosen.name} <span className="text-[#6B6B6B]">({chosen.employeeNumber}{chosen.teamName ? ` · ${chosen.teamName}` : ''})</span>
          </button>
          <button type="button" className="text-[#6B6B6B] hover:text-[#171717] px-1" aria-label="Clear the choice" onClick={() => choose(null)}>×</button>
          <button type="button" tabIndex={-1} className="text-[#6B6B6B] hover:text-[#171717]" aria-label="Open the list" onClick={() => { setOpen(true); setText(''); }}><ChevronDown className="w-4 h-4" /></button>
        </div>
      ) : (
        <div className="relative">
          <input
            ref={input} type="text" role="combobox" aria-label={ariaLabel} aria-expanded={open} aria-controls={`${id}-list`} aria-autocomplete="list" autoComplete="off"
            aria-activedescendant={open && items[active] ? `${id}-${items[active].id}` : undefined}
            className="w-full rounded-lg border border-[#E5E5E0] bg-white pl-3 pr-9 py-2 text-[13px] outline-none focus:border-[#171717]"
            placeholder={open ? 'Type to search by name or number' : placeholder} value={text}
            onFocus={() => setOpen(true)} onClick={() => setOpen(true)} onChange={(e) => { setText(e.target.value); setOpen(true); }}
          />
          <button type="button" tabIndex={-1} aria-label={open ? 'Close the list' : 'Open the list'} className="absolute inset-y-0 right-0 px-2.5 text-[#6B6B6B] hover:text-[#171717]" onMouseDown={(e) => e.preventDefault()} onClick={() => { if (open) close(); else { setOpen(true); input.current?.focus(); } }}>
            <ChevronDown className={`w-4 h-4 transition-transform ${open ? 'rotate-180' : ''}`} />
          </button>
        </div>
      )}
      {open && (
        <div className="absolute z-30 mt-1 w-full rounded-lg border border-[#E5E5E0] bg-white shadow-lg text-[13px]">
          <div className="flex justify-end border-b border-[#E5E5E0] px-2 py-1"><button type="button" className="text-[12px] font-semibold text-[#6B6B6B] hover:text-[#171717]" onClick={close}>Close ×</button></div>
          {mark ? (
            <div className="p-3 space-y-2">
              <div><b>{mark.name}</b> is not marked as a {markWord} yet.</div>
              <div className="text-[12px] text-[#6B6B6B]">Marking them only says they may be chosen for this. It gives them no access.</div>
              {markError && <div className="text-[12px] text-[#C84A4A]">{markError}</div>}
              <div className="flex gap-2">
                <button type="button" className="px-3 py-1.5 rounded bg-[#171717] text-white text-[12px] font-semibold" onClick={markAndChoose}>Mark as {markWord} and choose</button>
                <button type="button" className="px-3 py-1.5 rounded border border-[#E5E5E0] text-[12px] font-semibold" onClick={() => setMark(null)}>Back</button>
              </div>
            </div>
          ) : (
            <>
              <ul id={`${id}-list`} role="listbox" aria-label={`${ariaLabel} matches`} className="max-h-64 overflow-auto">
                {busy && items.length === 0 && <li className="px-3 py-2 text-[#6B6B6B]">Loading…</li>}
                {!busy && items.length === 0 && <li className="px-3 py-2 text-[#6B6B6B]">{empty}</li>}
                {items.map((p, i) => (
                  <li key={p.id} id={`${id}-${p.id}`} role="option" aria-selected={p.id === value}>
                    <button type="button" className={`w-full text-left px-3 py-2 ${i === active ? 'bg-[#F5F5F0]' : 'hover:bg-[#FAFAF8]'}`} onMouseEnter={() => setActive(i)} onClick={() => pick(p)}>
                      <div className="flex items-center justify-between gap-2">
                        <span>{p.name} <span className="text-[#6B6B6B]">({p.employeeNumber})</span></span>
                        <span className="flex gap-1 shrink-0">
                          {p.isManager && <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded bg-[#EDF3F8] text-[#4F6F8F]">Manager</span>}
                          {p.isSupervisor && <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded bg-[#EAF5EF] text-[#2F7D5A]">Supervisor</span>}
                          {p.status !== 'ACTIVE' && <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded bg-[#FFF5DD] text-[#B7791F]">{STATUS_WORD[p.status] ?? p.status}</span>}
                        </span>
                      </div>
                      {describe(p) && <div className="text-[11px] text-[#6B6B6B]">{describe(p)}</div>}
                    </button>
                  </li>
                ))}
                {more && <li><button type="button" disabled={busy} className="w-full px-3 py-2 text-center text-[12px] font-semibold text-[#171717] hover:bg-[#FAFAF8] disabled:opacity-60" onClick={showMore}>{busy ? 'Loading…' : 'Show more'}</button></li>}
              </ul>
              {(status && !statuses) || only ? (
                <div className="border-t border-[#E5E5E0] px-3 py-2 space-y-1 bg-[#FAFAF8] rounded-b-lg">
                  {only && <label className="flex items-center gap-2 text-[12px]"><input type="checkbox" checked={everyone} onChange={(e) => setEveryone(e.target.checked)} />Show everyone, not only {only === 'manager' ? 'managers' : 'supervisors'}</label>}
                  {status && !statuses && <label className="flex items-center gap-2 text-[12px]"><input type="checkbox" checked={wider} onChange={(e) => setWider(e.target.checked)} />Include people on leave, onboarding or suspended</label>}
                </div>
              ) : null}
            </>
          )}
        </div>
      )}
    </div>
  );
};
