/**
 * Enterprise Command Palette (Ctrl/Cmd + K)
 * Search across the app's screens, the people in the workforce and the WFM groups. Everything shown is live data from the
 * platform (or the real list of screens), nothing is sample content.
 */

import React, { useState, useEffect, useRef } from 'react';
import { Search, Users, Layers, ArrowRight, X } from 'lucide-react';
import { api } from '../../services/api';
import { NAV_ITEMS } from '../layout/NavigationSidebar';

interface CommandPaletteProps {
  isOpen: boolean;
  onClose: () => void;
  onSelectAction: (actionType: string, payload?: any) => void;
}

type Person = { id: string; firstName: string; lastName: string; employeeNumber?: string; status?: string };
type Group = { id: string; name: string; code?: string };
type Item = { id: string; title: string; subtitle?: string; category: string; icon: React.ElementType; handler: () => void };

export const CommandPalette: React.FC<CommandPaletteProps> = ({ isOpen, onClose, onSelectAction }) => {
  const [query, setQuery] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [people, setPeople] = useState<Person[]>([]);
  const [groups, setGroups] = useState<Group[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (isOpen) {
      setTimeout(() => inputRef.current?.focus(), 50);
      api<Group[]>('/config/groups').then(setGroups).catch(() => setGroups([]));
    } else {
      setQuery('');
      setSelectedIndex(0);
      setPeople([]);
    }
  }, [isOpen]);

  // people are searched on the server as the user types (the list can be thousands long)
  useEffect(() => {
    const term = query.trim();
    if (!isOpen || term.length < 2) { setPeople([]); return; }
    let live = true;
    const t = setTimeout(() => { api<Person[]>(`/workforce/employees?q=${encodeURIComponent(term)}&limit=6`).then((r) => live && setPeople(Array.isArray(r) ? r : [])).catch(() => live && setPeople([])); }, 200);
    return () => { live = false; clearTimeout(t); };
  }, [query, isOpen]);

  const q = query.trim().toLowerCase();
  const screens: Item[] = NAV_ITEMS.flatMap((m) => (m.subItems ?? [{ id: undefined as string | undefined, label: m.label }]).map((s) => ({
    id: `screen-${m.id}-${s.id ?? ''}`, title: s.label, subtitle: m.label, category: 'SCREENS', icon: m.icon,
    handler: () => onSelectAction('NAVIGATE', { module: m.id, subSection: s.id }),
  }))).filter((s) => !q || s.title.toLowerCase().includes(q) || (s.subtitle ?? '').toLowerCase().includes(q));
  const peopleItems: Item[] = people.map((e) => ({
    id: e.id, title: `${e.firstName} ${e.lastName}`, subtitle: [e.employeeNumber, e.status].filter(Boolean).join(' · '), category: 'EMPLOYEES', icon: Users,
    handler: () => onSelectAction('NAVIGATE', { module: 'workforce', subSection: 'employees' }),
  }));
  const groupItems: Item[] = groups.filter((g) => !q || g.name.toLowerCase().includes(q) || (g.code ?? '').toLowerCase().includes(q)).slice(0, 8).map((g) => ({
    id: g.id, title: g.name, subtitle: g.code, category: 'WFM GROUPS', icon: Layers,
    handler: () => onSelectAction('NAVIGATE', { module: 'configuration', subSection: 'wfm-groups' }),
  }));
  const combinedItems: Item[] = [...screens.slice(0, 12), ...peopleItems, ...groupItems];

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        if (isOpen) onClose();
        else onSelectAction('OPEN_PALETTE');
        return;
      }
      if (!isOpen) return;
      if (e.key === 'Escape') onClose();
      else if (e.key === 'ArrowDown') { e.preventDefault(); setSelectedIndex((i) => Math.min(i + 1, Math.max(0, combinedItems.length - 1))); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); setSelectedIndex((i) => Math.max(0, i - 1)); }
      else if (e.key === 'Enter') { const it = combinedItems[selectedIndex]; if (it) { e.preventDefault(); it.handler(); onClose(); } }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  });

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 bg-black/40 backdrop-blur-xs flex items-start justify-center pt-24 p-4" onClick={onClose}>
      <div
        role="dialog" aria-modal="true" aria-label="Search"
        className="w-full max-w-2xl bg-[#FFFFFF] rounded-lg shadow-2xl border border-[#E5E5E0] overflow-hidden flex flex-col max-h-[75vh]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="p-3 border-b border-[#E5E5E0] flex items-center gap-3 bg-[#FAFAF8]">
          <Search className="w-5 h-5 text-[#6B6B6B]" aria-hidden="true" />
          <input
            ref={inputRef}
            type="text"
            value={query}
            aria-label="Search screens, people and WFM groups"
            onChange={(e) => { setQuery(e.target.value); setSelectedIndex(0); }}
            placeholder="Search screens, people and WFM groups..."
            className="flex-1 bg-transparent border-none outline-none text-[14px] text-[#171717] placeholder:text-[#6B6B6B]"
          />
          <button type="button" onClick={onClose} aria-label="Close search" className="p-1 rounded text-[#6B6B6B] hover:text-[#171717] hover:bg-[#E5E5E0]">
            <X className="w-4 h-4" aria-hidden="true" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-2 divide-y divide-[#F5F5F2]">
          {combinedItems.length === 0 ? (
            <div className="py-12 text-center text-[#6B6B6B] text-[13px]">Nothing matches "{query}".</div>
          ) : (
            combinedItems.map((item, idx) => {
              const Icon = item.icon;
              return (
                <div
                  key={item.id}
                  onClick={() => { item.handler(); onClose(); }}
                  onMouseEnter={() => setSelectedIndex(idx)}
                  className={`p-2.5 rounded flex items-center justify-between cursor-pointer transition-colors ${idx === selectedIndex ? 'bg-[#FAFAF8] border border-[#E5E5E0]' : 'hover:bg-[#F5F5F2]'}`}
                >
                  <div className="flex items-center gap-3">
                    <div className="w-7 h-7 rounded bg-[#F5F5F2] flex items-center justify-center text-[#171717]">
                      <Icon className="w-3.5 h-3.5 text-[#525252]" aria-hidden="true" />
                    </div>
                    <div>
                      <div className="text-[13px] font-semibold text-[#171717] flex items-center gap-2">
                        <span>{item.title}</span>
                        <span className="text-[10px] font-medium px-1.5 py-0.2 rounded bg-[#F5F5F2] border border-[#E5E5E0] text-[#6B6B6B]">{item.category}</span>
                      </div>
                      {item.subtitle && <div className="text-[11px] text-[#6B6B6B]">{item.subtitle}</div>}
                    </div>
                  </div>
                  <ArrowRight className="w-4 h-4 text-[#6B6B6B]" aria-hidden="true" />
                </div>
              );
            })
          )}
        </div>

        <div className="p-2 border-t border-[#E5E5E0] bg-[#FAFAF8] flex items-center justify-between text-[11px] text-[#6B6B6B]">
          <div className="flex items-center gap-4">
            <span><kbd className="px-1.5 py-0.5 rounded bg-[#FFFFFF] border border-[#E5E5E0] font-mono text-[10px]">↑</kbd> <kbd className="px-1.5 py-0.5 rounded bg-[#FFFFFF] border border-[#E5E5E0] font-mono text-[10px]">↓</kbd> to navigate</span>
            <span><kbd className="px-1.5 py-0.5 rounded bg-[#FFFFFF] border border-[#E5E5E0] font-mono text-[10px]">Enter</kbd> to open</span>
            <span><kbd className="px-1.5 py-0.5 rounded bg-[#FFFFFF] border border-[#E5E5E0] font-mono text-[10px]">Esc</kbd> to close</span>
          </div>
        </div>
      </div>
    </div>
  );
};
