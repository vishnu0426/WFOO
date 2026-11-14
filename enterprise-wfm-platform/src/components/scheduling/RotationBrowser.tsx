/**
 * Rotation Patterns › choose a pattern. The library is grouped into categories. Each card shows the cycle as a small calendar and the facts that matter when comparing
 * patterns (cycle length, crews, days a week, longest run, whether every shift is covered every day). Picking one shows its details and the reminder about its source.
 */
import React, { useMemo, useState } from 'react';
import { CATEGORIES, coverageText, cycleOf, presetFacts, type CategoryId } from './rotationLibrary';
import type { Preset } from './rotationPresets';

const DAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

const letterColour = (label: string): { bg: string; fg: string } => {
  const l = label.toLowerCase();
  if (l.includes('night')) return { bg: '#3E4A7A', fg: '#FFFFFF' };
  if (l.includes('late') || l.includes('evening')) return { bg: '#D98B4A', fg: '#171717' };
  if (l.includes('early')) return { bg: '#E8C458', fg: '#171717' };
  if (l.includes('day')) return { bg: '#7FB1DD', fg: '#171717' };
  return { bg: '#5E9C7B', fg: '#171717' };
};

/** One crew's cycle as rows of seven days; a coloured cell is a worked day, a pale one a day off. */
export const MiniCalendar: React.FC<{ preset: Preset; big?: boolean }> = ({ preset, big }) => {
  const seq = cycleOf(preset).flat() as (string | null)[];
  const colour = useMemo(() => new Map(preset.letters.map((l) => [l.letter, letterColour(l.label)])), [preset]);
  const rows: (string | null)[][] = [];
  for (let i = 0; i < seq.length; i += 7) rows.push(seq.slice(i, i + 7));
  const size = big ? 'w-8 h-6 text-[11px]' : 'w-4 h-3.5 text-[0px]';
  return (
    <div className="inline-block" role="img" aria-label={`${seq.length}-day cycle: ${seq.map((l) => l ?? 'off').join(', ')}`}>
      {big && <div className="flex gap-0.5 mb-0.5 text-[10px] text-[#737373]">{DAY_NAMES.map((d) => <span key={d} className="w-8 text-center">{d}</span>)}</div>}
      <div className="space-y-0.5">
        {rows.map((r, i) => (
          <div key={i} className="flex gap-0.5">
            {Array.from({ length: 7 }, (_, d) => {
              if (d >= r.length) return <span key={d} className={`${size} inline-block`} />;
              const l = r[d]; const c = l ? colour.get(l) : null;
              return <span key={d} className={`${size} inline-flex items-center justify-center rounded-sm`} style={{ background: c ? c.bg : '#EDEDE8', color: c?.fg }}>{big ? l ?? '' : ''}</span>;
            })}
          </div>
        ))}
      </div>
    </div>
  );
};

export const RotationLibrary: React.FC<{
  presets: Preset[]; selectedId: string; onSelect: (id: string) => void; onDeleteSaved?: (savedId: string, name: string) => void;
}> = ({ presets, selectedId, onSelect, onDeleteSaved }) => {
  const [cat, setCat] = useState<CategoryId | 'ALL'>('ALL');
  const [q, setQ] = useState('');
  const [all, setAll] = useState(false);
  const counts = (c: CategoryId) => presets.filter((p) => (p.category ?? 'STANDARD') === c).length;
  const matching = presets.filter((p) => (cat === 'ALL' || (p.category ?? 'STANDARD') === cat) && (!q.trim() || `${p.label} ${p.summary}`.toLowerCase().includes(q.trim().toLowerCase())));
  // first look: the most common handful; everything once the planner asks, filters or searches
  const COMMON = ['5on2off', '4on4off', '223', 'dupont', 'continental', 'weekly-dln'];
  const compact = !all && cat === 'ALL' && !q.trim() && matching.length > 6;
  const shown = compact ? [...COMMON.map((id) => matching.find((p) => p.id === id)).filter(Boolean) as Preset[], ...matching.filter((p) => !COMMON.includes(p.id))].slice(0, 6) : matching;
  const selected = presets.find((p) => p.id === selectedId);
  const facts = selected ? presetFacts(selected) : null;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex flex-wrap gap-1.5" role="group" aria-label="Pattern category">
          {([{ id: 'ALL', label: 'All' }, ...CATEGORIES] as { id: CategoryId | 'ALL'; label: string }[]).filter((c) => c.id === 'ALL' || counts(c.id as CategoryId) > 0 || c.id === 'CUSTOM').map((c) => (
            <button key={c.id} type="button" aria-pressed={cat === c.id} onClick={() => setCat(c.id)} className={`px-3 py-1 rounded-md border text-[12px] ${cat === c.id ? 'bg-[#1A1A1A] text-white border-[#1A1A1A]' : 'border-[#E5E5E0] text-[#171717]'}`}>
              {c.label}{c.id !== 'ALL' ? ` (${counts(c.id as CategoryId)})` : ''}
            </button>
          ))}
        </div>
        <input aria-label="Search patterns" placeholder="Search patterns" value={q} onChange={(e) => setQ(e.target.value)} className="ml-auto w-56 p-1.5 border border-[#E5E5E0] rounded text-[12px]" />
      </div>

      {shown.length === 0 ? (
        <p className="text-[13px] text-[#6B6B6B] py-4">{cat === 'CUSTOM' && !q ? 'Nothing saved yet. Open a pattern and choose "Save to library", or import one from a file.' : 'No pattern matches.'}</p>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3" role="radiogroup" aria-label="Patterns">
          {shown.map((p) => {
            const f = presetFacts(p);
            const on = p.id === selectedId;
            return (
              <button key={p.id} type="button" role="radio" aria-checked={on} onClick={() => onSelect(on ? '' : p.id)} className={`text-left rounded-lg border p-3 space-y-2 ${on ? 'border-[#171717] ring-1 ring-[#171717] bg-white' : 'border-[#E5E5E0] bg-white hover:border-[#A3A3A3]'}`}>
                <div className="text-[13px] font-semibold text-[#171717]">{p.label}</div>
                <MiniCalendar preset={p} />
                <div className="text-[11px] text-[#525252]">
                  {f.cycleDays}-day cycle, {f.crews} crew{f.crews === 1 ? '' : 's'}, {f.daysPerWeek} days a week, longest run {f.longestRun}
                </div>
                <div className={`text-[11px] ${f.coverage === 'GAPS' ? 'text-[#8F6200]' : 'text-[#2A7553]'}`}>{coverageText(f.coverage, p.letters.length)}{f.nightsPerCycle ? `, ${f.nightsPerCycle} night shifts a cycle` : ''}</div>
                {p.saved && <div className="text-[11px] text-[#737373]">Used by {p.saved.usedBy} pattern{p.saved.usedBy === 1 ? '' : 's'}</div>}
              </button>
            );
          })}
        </div>
      )}
      {compact && <button type="button" className="text-[12px] underline text-[#525252]" onClick={() => setAll(true)}>Show all {matching.length} patterns</button>}

      {selected && facts && (
        <div className="border border-[#E5E5E0] rounded-lg bg-[#FAFAF8] p-4 flex flex-wrap gap-6 items-start">
          <MiniCalendar preset={selected} big />
          <div className="flex-1 min-w-[260px] space-y-1.5">
            <div className="text-[13px] font-semibold text-[#171717]">{selected.label}</div>
            <p className="text-[12px] text-[#525252]">{selected.summary}</p>
            <p className={`text-[12px] ${facts.coverage === 'GAPS' ? 'text-[#8F6200]' : 'text-[#2A7553]'}`}>
              {facts.cycleDays}-day cycle with {facts.crews} crew{facts.crews === 1 ? '' : 's'}. {coverageText(facts.coverage, selected.letters.length)}{facts.nightsPerCycle ? `, with ${facts.nightsPerCycle} night shift${facts.nightsPerCycle === 1 ? '' : 's'} per crew each cycle` : ''}.
            </p>
            <div className="flex flex-wrap gap-x-4 gap-y-1 text-[12px] text-[#171717]">
              {selected.letters.map((l) => <span key={l.letter} className="inline-flex items-center gap-1.5"><span className="inline-block w-3 h-3 rounded-sm" style={{ background: letterColour(l.label).bg }} />{l.letter}: {l.label}</span>)}
            </div>
            {selected.note && <p className="text-[11px] text-[#737373]">{selected.note}</p>}
            {selected.saved && onDeleteSaved && <button type="button" className="text-[12px] text-[#BC3F3F] underline" onClick={() => onDeleteSaved(selected.saved!.id, selected.label)}>Remove from the library</button>}
          </div>
        </div>
      )}
    </div>
  );
};
