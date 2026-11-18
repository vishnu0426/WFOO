/**
 * Configuration › Compliance Packs: the drawer that opens on a pack. It reads the pack's rules as sentences (what blocks publishing, what only warns), says where the pack is in use,
 * and lets someone apply it to a place (the whole organisation, a region, a site, a WFM group or a team) after seeing how many people that touches and which pack they follow now.
 */
import React, { useEffect, useRef, useState } from 'react';
import { Copy, Pencil, Trash2, X } from 'lucide-react';
import { api } from '../../services/api';
import { Banner, Btn, Pill, Select } from '../forecasting/ui';
import { ruleLine, scopeText } from './complianceText';
import type { Assignment, Pack } from './CompliancePanel';

type Place = { id: string; name: string };
export interface DrawerPlaces { regions: Place[]; sites: Place[]; groups: Place[]; teams: Place[] }
const KINDS = [['TENANT', 'The whole organisation'], ['REGION', 'A region'], ['SITE', 'A site'], ['GROUP', 'A WFM group'], ['TEAM', 'A team']] as const;
type Kind = typeof KINDS[number][0];
const LIST_OF: Record<Exclude<Kind, 'TENANT'>, keyof DrawerPlaces> = { REGION: 'regions', SITE: 'sites', GROUP: 'groups', TEAM: 'teams' };

export const PackDrawer: React.FC<{
  pack: Pack; usage: Assignment[]; all: Assignment[]; packs: Pack[]; places: DrawerPlaces; canWrite: boolean; busy: boolean;
  onClose: () => void; onCopy: () => void; onEdit: () => void; onDelete: () => void;
  onApply: (kind: Kind, id: string | null) => Promise<void>; onRemove: (a: Assignment) => Promise<void>;
}> = ({ pack, usage, all, packs, places, canWrite, busy, onClose, onCopy, onEdit, onDelete, onApply, onRemove }) => {
  const [kind, setKind] = useState<Kind>('TENANT');
  const [target, setTarget] = useState('');
  const [people, setPeople] = useState<number | null>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => { closeRef.current?.focus(); }, [pack.id]);
  useEffect(() => { const k = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); }; window.addEventListener('keydown', k); return () => window.removeEventListener('keydown', k); }, [onClose]);
  useEffect(() => { setTarget(''); }, [kind]);

  const list = kind === 'TENANT' ? [] : places[LIST_OF[kind]];
  const ready = kind === 'TENANT' || !!target;
  // how many people the choice touches, and what that place follows today
  useEffect(() => {
    if (!ready) { setPeople(null); return; }
    let live = true; setPeople(null);
    api<{ people: number }>(`/compliance/impact?scopeType=${kind}${kind === 'TENANT' ? '' : `&scopeId=${target}`}`).then((r) => live && setPeople(r.people)).catch(() => live && setPeople(null));
    return () => { live = false; };
  }, [kind, target, ready]);
  const today = ready ? all.find((a) => a.scopeType === kind && (kind === 'TENANT' || a.scopeId === target)) : undefined;
  const already = today?.packId === pack.id;
  const placeName = kind === 'TENANT' ? 'the whole organisation' : list.find((p) => p.id === target)?.name ?? '';
  const blocks = pack.rules.filter((r) => r.severity === 'BLOCK'), warns = pack.rules.filter((r) => r.severity === 'WARN');
  const [err, setErr] = useState('');
  const apply = async () => { setErr(''); try { await onApply(kind, kind === 'TENANT' ? null : target); setTarget(''); } catch (e: any) { setErr(e.message); } };

  const Rules = ({ rules, title, tone }: { rules: Pack['rules']; title: string; tone: 'bad' | 'neutral' }) => rules.length === 0 ? null : (
    <section aria-label={title} className="space-y-1.5">
      <h3 className="text-[12px] font-semibold uppercase tracking-wide text-[#6B6B6B]">{title}</h3>
      <ul className="border border-[#E5E5E0] rounded-lg divide-y divide-[#E5E5E0]">
        {rules.map((r, i) => <li key={r.id + i} className="px-3 py-2 text-[13px] flex items-start justify-between gap-3"><span>{ruleLine(r)}</span><Pill tone={tone === 'bad' ? 'warn' : 'neutral'}>{r.severity === 'BLOCK' ? 'Blocks' : 'Warns'}</Pill></li>)}
      </ul>
    </section>);

  return (
    <div role="dialog" aria-modal="true" aria-label={`${pack.name}: rules and where it applies`} className="fixed inset-0 z-40 bg-black/20 flex justify-end" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <aside className="w-full max-w-xl bg-white border-l border-[#E5E5E0] shadow-xl h-full overflow-y-auto p-5 space-y-4 select-text">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="text-[16px] font-semibold text-[#171717]">{pack.name}</h2>
            <p className="text-[12px] text-[#6B6B6B] mt-0.5">{pack.region || 'No region'}</p>
            <div className="flex flex-wrap items-center gap-1.5 mt-2">
              {usage.length > 0 ? <Pill tone="good">Active · {scopeText(usage)}</Pill> : <Pill>Not in use</Pill>}
              {pack.builtIn ? (pack.starter ? <Pill tone="warn">Starter</Pill> : <Pill tone="info">Ready-made</Pill>) : <Pill>Custom</Pill>}
            </div>
          </div>
          <button ref={closeRef} onClick={onClose} aria-label="Close" className="p-1 rounded hover:bg-[#FAFAF8]"><X className="w-4 h-4" /></button>
        </div>

        {pack.description && <p className="text-[13px] text-[#525252]">{pack.description}</p>}
        {pack.starter && <Banner kind="warn">{pack.law ? `Based on ${pack.law}. ` : ''}Written from the law's general rules and not reviewed by a local lawyer.{pack.notes ? ` ${pack.notes}` : ''} Check it against your contracts, then copy it to adjust.</Banner>}

        {pack.rules.length === 0 ? <p className="text-[13px] text-[#6B6B6B]">This pack has no rules yet.</p> : <>
          <Rules rules={blocks} title="Stops a schedule being published" tone="bad" />
          <Rules rules={warns} title="Only warns" tone="neutral" />
          <p className="text-[11px] text-[#6B6B6B]">A rule that blocks also keeps the scheduler from creating shifts that would break it. A warning is only reported.</p>
        </>}

        <section aria-label="Where it applies now" className="space-y-1.5">
          <h3 className="text-[12px] font-semibold uppercase tracking-wide text-[#6B6B6B]">Where it applies now</h3>
          {usage.length === 0 ? <p className="text-[13px] text-[#6B6B6B]">Nowhere yet.</p> : (
            <ul className="border border-[#E5E5E0] rounded-lg divide-y divide-[#E5E5E0]">
              {usage.map((a) => (
                <li key={`${a.scopeType}-${a.scopeId}`} className="px-3 py-2 text-[13px] flex items-center justify-between gap-3">
                  <span>{a.scopeName}<span className="text-[11px] text-[#6B6B6B]"> · {a.scopeType === 'TENANT' ? 'organisation' : a.scopeType.toLowerCase()}</span></span>
                  {canWrite && <button className="text-[12px] underline text-[#BC3F3F] disabled:opacity-50" disabled={busy} onClick={() => { setErr(''); onRemove(a).catch((e: any) => setErr(e.message)); }}>Stop using here</button>}
                </li>))}
            </ul>)}
        </section>

        {canWrite && (
          <section aria-label="Use this pack" className="space-y-2 border border-[#E5E5E0] rounded-lg p-3 bg-[#FAFAF8]">
            <h3 className="text-[12px] font-semibold uppercase tracking-wide text-[#6B6B6B]">Use this pack for</h3>
            <div className="flex flex-wrap items-center gap-2">
              <Select className="!w-auto" value={kind} onChange={(e) => setKind(e.target.value as Kind)} aria-label="Kind of place">{KINDS.map(([k, label]) => <option key={k} value={k}>{label}</option>)}</Select>
              {kind !== 'TENANT' && (
                <Select className="!w-auto min-w-[12rem]" value={target} onChange={(e) => setTarget(e.target.value)} aria-label="Which one">
                  <option value="">{list.length ? 'Choose…' : 'None set up'}</option>
                  {list.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                </Select>)}
            </div>
            {ready && (
              <p className="text-[12px] text-[#525252]" role="status">
                {people === null ? 'Counting the people this touches…' : <>It would apply to <span className="font-semibold">{people.toLocaleString('en-US')} {people === 1 ? 'person' : 'people'}</span> in {placeName}.</>}
                {' '}{already ? 'They already follow this pack here.' : today ? <>It replaces <span className="font-semibold">{packs.find((p) => p.id === today.packId)?.name ?? today.packName}</span> there.</> : 'There is no pack set for this place today.'}
                {kind === 'TENANT' ? ' Anything set for a region, site, group, team or person still takes priority.' : ''}
              </p>)}
            {err && <Banner kind="err" onClose={() => setErr('')}>{err}</Banner>}
            <Btn variant="primary" disabled={busy || !ready || already} onClick={() => void apply()}>{already ? 'Already in use here' : `Use for ${placeName || '…'}`}</Btn>
            <p className="text-[11px] text-[#6B6B6B]">Schedules pick the change up straight away. A schedule that breaks a blocking rule cannot be published.</p>
          </section>)}

        {canWrite && (
          <div className="flex flex-wrap items-center gap-2 pt-1">
            {pack.builtIn && <Btn onClick={onCopy} disabled={busy}><Copy className="w-3.5 h-3.5" />Copy to edit</Btn>}
            {!pack.builtIn && <Btn onClick={onEdit} disabled={busy}><Pencil className="w-3.5 h-3.5" />Edit rules</Btn>}
            {!pack.builtIn && <Btn onClick={onDelete} disabled={busy || usage.length > 0} title={usage.length ? 'Stop using it everywhere first' : undefined}><Trash2 className="w-3.5 h-3.5" />Delete</Btn>}
          </div>)}
      </aside>
    </div>
  );
};
