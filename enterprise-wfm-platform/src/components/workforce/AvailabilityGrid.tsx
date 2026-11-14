/**
 * Workforce > Availability: a team-week grid. People down the side, the days of the week across, every cell showing what that person can do that day. Paint many cells at once, copy one
 * person's week to others, or set days for everyone ticked. Changes are held on screen (the cell is marked) and saved together in one step, or discarded.
 *
 * With nothing entered a person can work any time a shift template allows. "Only available" narrows a day to those hours, "Off" removes the day, "Prefers" is a wish the scheduler tries
 * to honour. The rules of the grid (what a day shows, what painting does) are in availabilityRules.ts.
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { api, Team } from '../../services/api';
import { useForecast } from '../../services/forecastStore';
import { useApi } from '../forecasting/hooks';
import { Banner, Btn, Pill, Select } from '../forecasting/ui';
import { applyBrush, brushProblem, copyWeek, DAY_NAMES, daySummary, describeBrush, rectangle, sameWeek, type Brush, type DayState, type Win } from './availabilityRules';

type Person = { id: string; name: string; employeeNumber: string; teamName: string | null; windows: (Win & { id?: string })[]; dated: number };
type Grid = { total: number; people: Person[] };
const PAGE = 100;

const CELL: Record<DayState, string> = {
  ANY: 'bg-white text-[#6B6B6B] hover:bg-[#FAFAF8]', OFF: 'bg-[#FCEBEC] text-[#BC3F3F]', AVAILABLE: 'bg-[#EAF5EF] text-[#2A7553]', PREFERRED: 'bg-[#EDF3F8] text-[#3F628A]',
  BLOCKED: 'bg-[#FFF5DD] text-[#8F6200]', MIXED: 'bg-[#F5F5F2] text-[#525252]',
};
const key = (row: number, day: number) => `${row}:${day}`;
const plain = (w: Win): Win => ({ dayOfWeek: w.dayOfWeek, startTime: w.startTime, endTime: w.endTime, kind: w.kind });

export const AvailabilityGrid: React.FC<{ onOpenDetail: (employeeId: string) => void }> = ({ onOpenDetail }) => {
  const { can, setNotice, groups } = useForecast() as any;
  const canWrite = can('workforce:write');
  const teams = useApi<Team[]>('/workforce/teams?limit=200');         // the full list: the picker shows how many people each team has
  const [teamId, setTeamId] = useState<string | null>(null);        // null until the default is chosen
  const [groupId, setGroupId] = useState('');
  const [find, setFind] = useState('');
  const [offset, setOffset] = useState(0);
  const [tick, setTick] = useState(0);
  // arrive on a team, not on an empty page: the largest one
  useEffect(() => { if (teamId === null && teams.data) setTeamId(teams.data.length ? [...teams.data].sort((a, b) => b.memberCount - a.memberCount)[0].id : ''); }, [teams.data, teamId]);
  const grid = useApi<Grid>(teamId === null ? null : `/workforce/availability/grid?limit=${PAGE}&offset=${offset}${teamId ? `&teamId=${teamId}` : ''}${groupId ? `&groupId=${groupId}` : ''}${find.trim() ? `&q=${encodeURIComponent(find.trim())}` : ''}`, [tick]);
  const people = grid.data?.people ?? [];

  const [draft, setDraft] = useState<Record<string, Win[]>>({});
  const baseOf = (p: Person) => p.windows.map(plain);
  const weekOf = (p: Person) => draft[p.id] ?? baseOf(p);
  const changed = people.filter((p) => draft[p.id] && !sameWeek(draft[p.id], baseOf(p)));
  const dirty = Object.keys(draft).filter((id) => { const p = people.find((x) => x.id === id); return p ? !sameWeek(draft[id], baseOf(p)) : true; }).length;
  useEffect(() => { setDraft({}); setSel(new Set()); setPicked(new Set()); }, [teamId, groupId, find, offset, tick]);   // eslint-disable-line react-hooks/exhaustive-deps

  const [brush, setBrush] = useState<Brush | null>(null);          // null: just selecting cells
  const [from, setFrom] = useState('09:00'); const [to, setTo] = useState('17:00');
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [picked, setPicked] = useState<Set<string>>(new Set());     // people ticked
  const [days, setDays] = useState<Set<number>>(new Set([0, 1, 2, 3, 4]));
  const [source, setSource] = useState<Person | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const drag = useRef<{ row: number; day: number } | null>(null);
  const [hover, setHover] = useState<Set<string>>(new Set());

  const activeBrush = (kind: Brush['type']): Brush => (kind === 'AVAILABLE' || kind === 'PREFERRED' ? { type: kind, from, to } : kind === 'OFF' ? { type: 'OFF' } : { type: 'ANY' });
  const problem = brush ? brushProblem(brush.type === 'AVAILABLE' || brush.type === 'PREFERRED' ? { ...brush, from, to } : brush) : null;
  const live = (): Brush | null => (brush ? (brush.type === 'AVAILABLE' || brush.type === 'PREFERRED' ? { ...brush, from, to } : brush) : null);

  const paint = (cells: { row: number; day: number }[]) => {
    const b = live(); if (!b || brushProblem(b)) return;
    const byRow = new Map<number, number[]>();
    for (const c of cells) byRow.set(c.row, [...(byRow.get(c.row) ?? []), c.day]);
    setDraft((d) => { const n = { ...d }; for (const [row, ds] of byRow) { const p = people[row]; if (p) n[p.id] = applyBrush(n[p.id] ?? baseOf(p), ds, b); } return n; });
  };
  const down = (row: number, day: number, e: React.PointerEvent) => {
    if (!canWrite) return;
    e.preventDefault();
    drag.current = { row, day }; setHover(new Set([key(row, day)]));
  };
  const enter = (row: number, day: number) => { if (drag.current) setHover(new Set(rectangle(drag.current, { row, day }).map((c) => key(c.row, c.day)))); };
  const up = (row: number, day: number) => {
    if (!drag.current) return;
    const cells = rectangle(drag.current, { row, day }); drag.current = null; setHover(new Set());
    if (live()) paint(cells); else setSel((s) => { const n = new Set(s); const all = cells.every((c) => n.has(key(c.row, c.day))); for (const c of cells) { if (all) n.delete(key(c.row, c.day)); else n.add(key(c.row, c.day)); } return n; });
  };
  useEffect(() => { const stop = () => { drag.current = null; setHover(new Set()); }; window.addEventListener('pointerup', stop); return () => window.removeEventListener('pointerup', stop); }, []);

  const paintSelected = () => { const cells = [...sel].map((k) => { const [row, day] = k.split(':').map(Number); return { row, day }; }); paint(cells); setSel(new Set()); };
  const applyToPicked = () => { const b = live(); if (!b) return; const cells = people.flatMap((p, row) => (picked.has(p.id) ? [...days].map((day) => ({ row, day })) : [])); paint(cells); };
  const pasteTo = (targets: Person[]) => { if (!source) return; const w = copyWeek(weekOf(source)); setDraft((d) => { const n = { ...d }; for (const t of targets) if (t.id !== source.id) n[t.id] = copyWeek(w); return n; }); };

  const save = async () => {
    setBusy(true); setError('');
    try {
      const ids = Object.keys(draft).filter((id) => { const p = people.find((x) => x.id === id); return p && !sameWeek(draft[id], baseOf(p)); });
      for (let i = 0; i < ids.length; i += 200) await api('/workforce/availability/bulk', { method: 'PUT', timeoutMs: 120_000, body: { people: ids.slice(i, i + 200).map((id) => ({ employeeId: id, windows: draft[id] })) } });
      setNotice({ kind: 'ok', text: `Availability saved for ${ids.length} ${ids.length === 1 ? 'person' : 'people'}. New schedules will follow it.` });
      setDraft({}); setTick((t) => t + 1);
    } catch (e: any) { setError(e.message); } finally { setBusy(false); }
  };

  const empty = useMemo(() => people.filter((p) => p.windows.length === 0 && p.dated === 0).length, [people]);     // what is saved, not what is being edited
  const chip = (on: boolean) => `px-2.5 py-1.5 rounded-md border text-[12px] font-semibold ${on ? 'border-[#171717] bg-[#171717] text-white' : 'border-[#E5E5E0] bg-white text-[#171717] hover:bg-[#FAFAF8]'}`;
  const needTimes = brush?.type === 'AVAILABLE' || brush?.type === 'PREFERRED';

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-3">
        <label className="text-[12px] font-semibold w-56">Team<Select aria-label="Team" disabled={dirty > 0} value={teamId ?? ''} onChange={(e) => { setTeamId(e.target.value); setOffset(0); }}><option value="">Everyone</option>{teams.data?.map((t) => <option key={t.id} value={t.id}>{t.name} ({t.memberCount})</option>)}</Select></label>
        {Array.isArray(groups) && groups.length > 0 && <label className="text-[12px] font-semibold w-52">WFM group<Select aria-label="WFM group" disabled={dirty > 0} value={groupId} onChange={(e) => { setGroupId(e.target.value); setOffset(0); }}><option value="">Any group</option>{groups.map((g: any) => <option key={g.id} value={g.id}>{g.name}</option>)}</Select></label>}
        <label className="text-[12px] font-semibold w-52">Find a person<input aria-label="Find a person" disabled={dirty > 0} className="mt-1 block w-full rounded-md border border-[#E5E5E0] px-2.5 py-2 text-[13px] font-normal" placeholder="Name or number" value={find} onChange={(e) => { setFind(e.target.value); setOffset(0); }} /></label>
        <div className="ml-auto text-[12px] text-[#6B6B6B]">{grid.data ? `${grid.data.total.toLocaleString('en-US')} ${grid.data.total === 1 ? 'person' : 'people'}` : ''}{grid.data && people.length ? ` · ${people.length - empty} of ${people.length} shown have availability entered` : ''}</div>
      </div>

      {canWrite && (
        <div className="rounded-lg border border-[#E5E5E0] bg-[#FAFAF8] p-3 space-y-3" role="group" aria-label="Paint availability">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[12px] font-semibold text-[#6B6B6B] mr-1">Paint</span>
            <button type="button" className={chip(brush === null)} aria-pressed={brush === null} onClick={() => setBrush(null)}>Select cells</button>
            <button type="button" className={chip(brush?.type === 'ANY')} aria-pressed={brush?.type === 'ANY'} onClick={() => setBrush(activeBrush('ANY'))}>Any time</button>
            <button type="button" className={chip(brush?.type === 'OFF')} aria-pressed={brush?.type === 'OFF'} onClick={() => setBrush(activeBrush('OFF'))}>Off all day</button>
            <button type="button" className={chip(brush?.type === 'AVAILABLE')} aria-pressed={brush?.type === 'AVAILABLE'} onClick={() => setBrush(activeBrush('AVAILABLE'))}>Only available…</button>
            <button type="button" className={chip(brush?.type === 'PREFERRED')} aria-pressed={brush?.type === 'PREFERRED'} onClick={() => setBrush(activeBrush('PREFERRED'))}>Prefers…</button>
            {needTimes && (
              <span className="flex items-center gap-1.5 text-[12px]">
                <input aria-label="From" type="time" step={900} value={from} onChange={(e) => setFrom(e.target.value)} className="rounded border border-[#E5E5E0] px-1.5 py-1 bg-white" />to
                <input aria-label="To" type="time" step={900} value={to === '24:00' ? '23:59' : to} onChange={(e) => setTo(e.target.value === '23:59' ? '24:00' : e.target.value)} className="rounded border border-[#E5E5E0] px-1.5 py-1 bg-white" />
              </span>
            )}
          </div>
          <p className="text-[12px] text-[#525252]">
            {brush === null ? 'Click or drag over cells to select them, then choose what to paint. Or pick what to paint first and drag to paint straight away.' : problem ? <span className="text-[#BC3F3F]">{problem}</span> : `Click or drag over cells to set them to “${describeBrush(live()!)}”.`}
            {brush === null && sel.size > 0 && <> <b>{sel.size}</b> selected. </>}
          </p>
          <div className="flex flex-wrap items-center gap-2">
            {sel.size > 0 && brush === null && <span className="text-[12px] text-[#525252]">{sel.size} {sel.size === 1 ? 'cell' : 'cells'} selected. Now choose what to paint.</span>}
            {sel.size > 0 && brush !== null && <Btn variant="primary" disabled={!!problem} onClick={paintSelected}>Paint {sel.size} selected {sel.size === 1 ? 'cell' : 'cells'}</Btn>}
            {sel.size > 0 && <button className="text-[12px] underline" onClick={() => setSel(new Set())}>Clear selection</button>}
          </div>
          <div className="flex flex-wrap items-center gap-3 border-t border-[#E5E5E0] pt-3">
            <span className="text-[12px] font-semibold text-[#6B6B6B]">For the people ticked</span>
            {DAY_NAMES.map((d, i) => <button key={d} type="button" aria-pressed={days.has(i)} className={chip(days.has(i))} onClick={() => setDays((s) => { const n = new Set(s); if (n.has(i)) n.delete(i); else n.add(i); return n; })}>{d}</button>)}
            <Btn variant="primary" disabled={!brush || !!problem || picked.size === 0 || days.size === 0} onClick={applyToPicked}>Apply to {picked.size} selected {picked.size === 1 ? 'person' : 'people'}</Btn>
            <span className="text-[12px] text-[#6B6B6B]">uses the paint above{brush ? `: ${describeBrush(live()!)}` : ' (choose one)'}</span>
          </div>
          {source && (
            <div className="flex flex-wrap items-center gap-2 border-t border-[#E5E5E0] pt-3 text-[12px]">
              <span>Copying <b>{source.name}</b>’s week:</span>
              <Btn disabled={picked.size === 0} onClick={() => pasteTo(people.filter((p) => picked.has(p.id)))}>Paste to {picked.size} selected</Btn>
              <Btn onClick={() => pasteTo(people)}>Paste to everyone shown</Btn>
              <button className="underline" onClick={() => setSource(null)}>Stop copying</button>
            </div>
          )}
        </div>
      )}

      {error && <Banner kind="err" onClose={() => setError('')}>{error}</Banner>}
      {dirty > 0 && (
        <div className="sticky top-0 z-10 flex flex-wrap items-center gap-3 rounded-lg border border-[#B7791F]/30 bg-[#FFF5DD] px-3.5 py-2.5" role="status">
          <span className="text-[13px] font-semibold text-[#171717]">{dirty} {dirty === 1 ? 'person has' : 'people have'} unsaved changes.</span>
          <Btn variant="primary" disabled={busy} onClick={() => void save()}>{busy ? 'Saving…' : `Save ${dirty} ${dirty === 1 ? 'person' : 'people'}`}</Btn>
          <Btn disabled={busy} onClick={() => { setDraft({}); setSel(new Set()); }}>Discard</Btn>
        </div>
      )}

      {grid.data === null ? (grid.error ? <Banner kind="err">{grid.error} <button className="underline font-semibold" onClick={grid.reload}>Try again</button></Banner> : <div role="status" aria-busy="true" className="text-[13px] text-[#6B6B6B]">Loading the team…</div>)
        : people.length === 0 ? <div className="rounded-lg border border-dashed border-[#E5E5E0] p-8 text-center text-[13px] text-[#6B6B6B]">{find || groupId || teamId ? 'Nobody matches. Try another team or a different search.' : 'No people yet. Add people under Employees.'}</div> : (
        <div className="overflow-x-auto rounded-lg border border-[#E5E5E0]">
          <table className="w-full border-collapse text-[13px]" aria-label="Weekly availability by person">
            <thead>
              <tr className="bg-[#FAFAF8] text-left text-[11px] uppercase tracking-wider text-[#737373]">
                {canWrite && <th className="w-10 p-2"><input type="checkbox" aria-label="Tick everyone shown" checked={people.length > 0 && people.every((p) => picked.has(p.id))} onChange={(e) => setPicked(e.target.checked ? new Set(people.map((p) => p.id)) : new Set())} /></th>}
                <th className="p-2 min-w-[11rem]">Person</th>
                {DAY_NAMES.map((d, i) => <th key={d} className="p-0 text-center"><button type="button" className="w-full p-2 font-semibold uppercase hover:bg-[#F0F0EC]" title={`Select ${d} for everyone shown`} onClick={() => setSel((s) => { const n = new Set(s); const all = people.every((_, r) => n.has(key(r, i))); people.forEach((_, r) => (all ? n.delete(key(r, i)) : n.add(key(r, i)))); return n; })}>{d}</button></th>)}
                <th className="p-2 w-40" />
              </tr>
            </thead>
            <tbody>
              {people.map((p, row) => {
                const wk = weekOf(p), edited = draft[p.id] && !sameWeek(draft[p.id], baseOf(p));
                return (
                  <tr key={p.id} className="border-t border-[#F0F0EC]">
                    {canWrite && <td className="p-2"><input type="checkbox" aria-label={`Tick ${p.name}`} checked={picked.has(p.id)} onChange={() => setPicked((s) => { const n = new Set(s); if (n.has(p.id)) n.delete(p.id); else n.add(p.id); return n; })} /></td>}
                    <td className="p-2"><div className="font-semibold leading-tight">{p.name}{edited && <span className="ml-1.5 text-[11px] font-semibold text-[#8F6200]">edited</span>}</div><div className="text-[11px] text-[#6B6B6B]">{p.employeeNumber}{p.dated > 0 && <span title="Rules that apply only between two dates are not shown here: open the person to see them"> · {p.dated} dated {p.dated === 1 ? 'rule' : 'rules'}</span>}</div></td>
                    {DAY_NAMES.map((d, day) => {
                      const s = daySummary(wk, day), k = key(row, day), on = sel.has(k) || hover.has(k);
                      return (
                        <td key={d} className="p-0.5">
                          <button type="button" aria-label={`${p.name}, ${d}: ${s.label}`} aria-pressed={sel.has(k)} data-cell={k}
                            onPointerDown={(e) => down(row, day, e)} onPointerEnter={() => enter(row, day)} onPointerUp={() => up(row, day)}
                            onKeyDown={(e) => { if ((e.key === 'Enter' || e.key === ' ') && canWrite) { e.preventDefault(); if (live()) paint([{ row, day }]); else setSel((x) => { const n = new Set(x); if (n.has(k)) n.delete(k); else n.add(k); return n; }); } }}
                            className={`w-full h-10 px-1 rounded text-[12px] font-medium select-none touch-none ${CELL[s.state]} ${on ? 'ring-2 ring-[#171717] ring-inset' : ''} ${canWrite ? 'cursor-pointer' : 'cursor-default'}`}>{s.label}</button>
                        </td>
                      );
                    })}
                    <td className="p-2 text-right whitespace-nowrap">
                      {canWrite && <button className="text-[12px] underline mr-3" onClick={() => setSource(p)} title="Copy this week to other people">Copy week</button>}
                      <button className="text-[12px] underline" onClick={() => onOpenDetail(p.id)}>Details</button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <div className="flex flex-wrap items-center gap-3 text-[12px] text-[#525252]">
        <span className="font-semibold">Key</span>
        {([['ANY', 'Any time'], ['AVAILABLE', 'Only these hours'], ['PREFERRED', 'Prefers'], ['OFF', 'Off'], ['BLOCKED', 'Not these hours'], ['MIXED', 'Several rules']] as [DayState, string][]).map(([s, l]) => <span key={s} className="flex items-center gap-1.5"><span className={`inline-block w-4 h-4 rounded border border-[#E5E5E0] ${CELL[s].split(' ').filter((c) => c.startsWith('bg-')).join(' ')}`} />{l}</span>)}
      </div>
      {(grid.data?.total ?? 0) > PAGE && (
        <div className="flex items-center gap-2 text-[12px]"><Btn disabled={offset === 0 || dirty > 0} onClick={() => setOffset(Math.max(0, offset - PAGE))}>Previous {PAGE}</Btn><Btn disabled={offset + PAGE >= (grid.data?.total ?? 0) || dirty > 0} onClick={() => setOffset(offset + PAGE)}>Next {PAGE}</Btn><span className="text-[#6B6B6B]">{offset + 1}–{Math.min(offset + PAGE, grid.data!.total)} of {grid.data!.total.toLocaleString('en-US')}</span></div>
      )}
      <Pill tone="neutral">Windows that apply only between two dates are kept as they are; open Details to edit them.</Pill>
    </div>
  );
};
