/**
 * Configuration › Compliance Packs. A pack is a named set of labour-law rules. The ready-made ones (India, European Union, United States)
 * are read-only: copy one to change it, or start a new one. Say where each pack applies: the whole organisation, a WFM group or a team,
 * and the most specific one wins. The schedule generator will not create shifts a BLOCK rule forbids, and a schedule with BLOCK problems cannot be published.
 */
import { Waiting, LoadFailed } from '../common/loading';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Copy, Plus, Trash2 } from 'lucide-react';
import { api, Team } from '../../services/api';
import { useForecast } from '../../services/forecastStore';
import { useApi } from '../forecasting/hooks';
import { Banner, Btn, Busy, Card, Empty, Field, Input, Pill, Select } from '../forecasting/ui';
import { headline, scopeText } from './complianceText';
import { PackDrawer } from './PackDrawer';

type Param = { key: string; label: string; kind: 'number' | 'time' | 'boolean'; unit?: string; min?: number; max?: number; default: number | string | boolean };
type Spec = { type: string; label: string; help: string; params: Param[]; defaultSeverity: 'BLOCK' | 'WARN'; informational?: boolean };
type Rule = { id: string; type: string; severity: 'BLOCK' | 'WARN'; params: Record<string, any> };
export type Pack = { id: string; code: string; name: string; region: string; description: string; rules: Rule[]; builtIn: boolean; usedBy: number; law?: string | null; notes?: string | null; starter?: boolean };
export type Assignment = { scopeType: 'TENANT' | 'REGION' | 'SITE' | 'GROUP' | 'TEAM' | 'EMPLOYEE'; scopeId: string | null; scopeName: string; packId: string; packName: string };


export const CompliancePanel: React.FC = () => {
  const { can, groups } = useForecast();
  const canWrite = can('config:write');
  const [tick, setTick] = useState(0);
  const catalog = useApi<Spec[]>('/compliance/catalog');
  const packs = useApi<Pack[]>('/compliance/packs', [tick]);
  const assigns = useApi<Assignment[]>('/compliance/assignments', [tick]);
  const teams = useApi<Team[]>('/workforce/teams?fields=pick');
  const sites = useApi<{ id: string; name: string; status: string; regionName: string | null }[]>('/config/sites');
  const regions = useApi<{ id: string; name: string }[]>('/config/regions');
  const [sel, setSel] = useState<string>('');
  const [draft, setDraft] = useState<Pack | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => { if (packs.data && !packs.data.some((p) => p.id === sel)) setSel(packs.data[0]?.id ?? ''); }, [packs.data]);
  const [find, setFind] = useState('');
  const whereRef = useRef<HTMLDivElement>(null);
  const editRef = useRef<HTMLDivElement>(null);
  const [drawer, setDrawer] = useState(false);
  // which packs are in use, and where: from the assignments the screen already loads (the same rows the schedule generator reads)
  const usage = useMemo(() => { const m = new Map<string, Assignment[]>(); for (const a of assigns.data ?? []) m.set(a.packId, [...(m.get(a.packId) ?? []), a]); return m; }, [assigns.data]);
  const current = packs.data?.find((p) => p.id === sel) ?? null;
  useEffect(() => { setDraft(current ? JSON.parse(JSON.stringify(current)) : null); setError(''); }, [current?.id, current?.rules]);
  const spec = useMemo(() => new Map((catalog.data ?? []).map((s) => [s.type, s])), [catalog.data]);
  const dirty = !!current && !!draft && JSON.stringify({ n: current.name, r: current.region, d: current.description, x: current.rules }) !== JSON.stringify({ n: draft.name, r: draft.region, d: draft.description, x: draft.rules });

  const run = async (fn: () => Promise<void>) => { setBusy(true); setError(''); setNotice(''); try { await fn(); setTick((t) => t + 1); } catch (e: any) { setError(e.message); } finally { setBusy(false); } };
  const body = (p: Pack) => ({ name: p.name, region: p.region, description: p.description, rules: p.rules.map((r) => ({ id: r.id, type: r.type, severity: r.severity, params: r.params })) });

  const copy = () => current && run(async () => { const c = await api<Pack>('/compliance/packs', { method: 'POST', body: body({ ...current, name: `Copy of ${current.name}`.slice(0, 120), description: `${current.description}${current.law ? ` Based on ${current.law}; checked and adjusted by your organisation.` : ''}`.slice(0, 480) }) }); setSel(c.id); setDrawer(false); setNotice('Copied. Change the rules below, then save.'); setTimeout(() => editRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 80); });
  const create = () => run(async () => { const c = await api<Pack>('/compliance/packs', { method: 'POST', body: { name: 'New pack', region: '', description: '', rules: [] } }); setSel(c.id); });
  const save = () => draft && run(async () => { await api(`/compliance/packs/${draft.id}`, { method: 'PUT', body: body(draft) }); setNotice('Saved. Schedules pick the change up straight away.'); });
  const remove = () => current && confirm(`Delete "${current.name}"?`) && run(async () => { await api(`/compliance/packs/${current.id}`, { method: 'DELETE' }); setSel(''); setDrawer(false); });
  const assign = (scopeType: Assignment['scopeType'], scopeId: string | null, packId: string) => run(async () => { await api('/compliance/assignments', { method: 'PUT', body: { scopeType, scopeId, packId: packId || null } }); setNotice('Saved.'); });
  /** Used by the drawer: errors go back to it (the page behind is covered), so these do not use `run`. */
  const applyHere = async (kind: Assignment['scopeType'], id: string | null) => {
    if (!current) return;
    setBusy(true);
    try { await api('/compliance/assignments', { method: 'PUT', body: { scopeType: kind, scopeId: id, packId: current.id } }); setNotice(`Saved. "${current.name}" is now in use there.`); setTick((t) => t + 1); }
    finally { setBusy(false); }
  };
  const removeHere = async (a: Assignment) => {
    setBusy(true);
    try { await api('/compliance/assignments', { method: 'PUT', body: { scopeType: a.scopeType, scopeId: a.scopeId, packId: null } }); setNotice('Saved. That place no longer uses this pack.'); setTick((t) => t + 1); }
    finally { setBusy(false); }
  };
  const at = (t: Assignment['scopeType'], id: string | null) => assigns.data?.find((a) => a.scopeType === t && a.scopeId === id)?.packId ?? '';

  const setRule = (i: number, patch: Partial<Rule>) => setDraft((d) => d && { ...d, rules: d.rules.map((r, j) => (j === i ? { ...r, ...patch } : r)) });
  const setParam = (i: number, k: string, v: any) => setDraft((d) => d && { ...d, rules: d.rules.map((r, j) => (j === i ? { ...r, params: { ...r.params, [k]: v } } : r)) });
  const addRule = (type: string) => { const s = spec.get(type); if (!s) return; setDraft((d) => d && { ...d, rules: [...d.rules, { id: `${type.toLowerCase()}-${d.rules.length + 1}`, type, severity: s.defaultSeverity, params: Object.fromEntries(s.params.map((p) => [p.key, p.default])) }] }); };

  if (packs.loading && !packs.data) return <Waiting what="compliance packs" shape="cards" reload={packs.reload} />;
  if (packs.error && !packs.data) return <LoadFailed what="compliance packs" error={packs.error} reload={packs.reload} />;
  const ro = !draft || draft.builtIn || !canWrite;
  return (
    <div className="space-y-6">
      {error && <Banner kind="err" onClose={() => setError('')}>{error}</Banner>}
      {notice && <Banner kind="ok" onClose={() => setNotice('')}>{notice}</Banner>}

      <Card title="In use now" sub="The packs that are applied somewhere, and where. A more specific choice (a team, a group) overrides a broader one (the whole organisation)."
        actions={<Btn onClick={() => whereRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })}>Change where they apply</Btn>}>
        {assigns.error && !assigns.data ? <LoadFailed what="where packs apply" error={assigns.error} reload={assigns.reload} />
          : assigns.data && usage.size === 0 ? <Banner kind="info">No pack is in use. Only the scheduling rules and each person's contract apply. Pick a pack below, then choose where it applies.</Banner>
          : (
            <div className="divide-y divide-[#E5E5E0] border border-[#E5E5E0] rounded-lg">
              {[...usage].map(([id, list]) => {
                const pk = (packs.data ?? []).find((x) => x.id === id);
                if (!pk) return null;
                const h = headline(pk, 4), names = list.map((a) => a.scopeName);
                return (
                  <div key={id} className="p-3 flex flex-wrap items-start gap-x-6 gap-y-1.5">
                    <div className="min-w-[16rem] flex-1">
                      <button className="font-semibold text-[13px] underline-offset-2 hover:underline text-left" onClick={() => { setSel(id); setDrawer(true); }}>{pk.name}</button>
                      <div className="text-[12px] text-[#525252] mt-0.5">{h.shown.length ? <>{h.shown.join(' · ')}{h.more > 0 && <span className="text-[#6B6B6B]"> · +{h.more} more</span>}</> : <span className="text-[#6B6B6B]">{pk.rules.length} rule{pk.rules.length === 1 ? '' : 's'}</span>}{h.warnOnly && <span className="text-[#8F6200]"> · warns only, blocks nothing</span>}</div>
                    </div>
                    <div className="flex flex-wrap items-center gap-1.5 flex-1 min-w-[16rem]">
                      {names.slice(0, 6).map((n, i) => <Pill key={n + i} tone="good">{n}</Pill>)}
                      {names.length > 6 && <span className="text-[11px] text-[#6B6B6B]" title={names.slice(6).join(', ')}>+{names.length - 6} more</span>}
                    </div>
                  </div>
                );
              })}
            </div>)}
      </Card>

      <Card title="Compliance packs" sub="Labour-law rules as data. Pick a pack to see its rules. Ready-made packs are a starting point: rules differ by state, sector and contract, so copy one and adjust it to your situation."
        actions={<>
          <Input value={find} onChange={(e) => setFind(e.target.value)} placeholder={`Find a country or law (${(packs.data ?? []).length} packs)`} aria-label="Find a pack" className="w-64" />
          {canWrite && <Btn onClick={create} disabled={busy}><Plus className="w-3.5 h-3.5" />New pack</Btn>}
        </>}>
        {(packs.data ?? []).some((p) => p.starter) && <p className="text-[11px] text-[#8F6200]">Country packs marked “Starter” are written from each law's general rules and have not been reviewed by a local lawyer. Check one against your own contracts, agreements and region, then copy it to adjust.</p>}
        <p className="text-[11px] text-[#6B6B6B]"><span className="inline-block w-2 h-2 rounded-full bg-[#2F7D5A] align-middle mr-1" />Green = in use somewhere. The dark outline only marks the pack shown below.</p>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          {(packs.data ?? []).filter((p) => !find.trim() || `${p.name} ${p.region} ${p.law ?? ''} ${p.code}`.toLowerCase().includes(find.trim().toLowerCase()))
            .sort((a, b) => Number(usage.has(b.id)) - Number(usage.has(a.id))).map((p) => {
            const used = usage.get(p.id), h = headline(p);
            return (
              <button key={p.id} onClick={() => { setSel(p.id); setDrawer(true); }} aria-pressed={sel === p.id} aria-label={`${p.name}${used ? `, in use: ${scopeText(used)}` : ''}`}
                className={`text-left p-3 rounded-lg border transition-colors min-h-[124px] flex flex-col justify-between gap-2 ${used ? 'border-l-4 border-l-[#2F7D5A]' : ''} ${sel === p.id ? 'border-[#171717] bg-[#FAFAF8] ring-1 ring-[#171717]' : 'border-[#E5E5E0] hover:bg-[#FAFAF8]'}`}>
                <div>
                  <div className="font-semibold text-[13px] leading-snug line-clamp-2">{p.name}</div>
                  <div className="text-[11px] text-[#6B6B6B] mt-0.5">{p.region || 'No region'}</div>
                  <div className="text-[12px] text-[#525252] mt-1.5">{h.shown.length ? <>{h.shown.join(' · ')}{h.more > 0 && <span className="text-[#6B6B6B]"> · +{h.more} more</span>}</> : <span className="text-[#6B6B6B]">{p.rules.length ? `${p.rules.length} rule${p.rules.length === 1 ? '' : 's'}` : 'No rules yet'}</span>}</div>
                </div>
                <div className="flex items-center gap-1.5 flex-wrap">
                  {used && <Pill tone="good" title={used.map((a) => a.scopeName).join(', ')}>Active · {scopeText(used)}</Pill>}
                  {p.builtIn ? (p.starter ? <Pill tone="warn">Starter</Pill> : <Pill tone="info">Ready-made</Pill>) : <Pill>Custom</Pill>}
                  {h.warnOnly && <Pill title="Every rule in this pack only warns: nothing stops a schedule being published">Warns only</Pill>}
                </div>
              </button>
            );
          })}
        </div>
      </Card>

      <div ref={editRef} />
      {draft && !draft.builtIn && (
        <Card title={draft.builtIn ? draft.name : 'Edit pack'} sub={draft.builtIn ? draft.description : undefined}
          actions={<>
            {draft.builtIn && canWrite && <Btn onClick={copy} disabled={busy}><Copy className="w-3.5 h-3.5" />Copy to edit</Btn>}
            {!draft.builtIn && canWrite && <><Btn variant="primary" onClick={save} disabled={busy || !dirty}>Save changes</Btn><Btn onClick={remove} disabled={busy || draft.usedBy > 0} title={draft.usedBy ? 'Remove where it is used first' : undefined}><Trash2 className="w-3.5 h-3.5" />Delete</Btn></>}
          </>}>
          {usage.get(draft.id) && <Banner kind="ok">In use: {usage.get(draft.id)!.map((a) => a.scopeName).join(', ')}.</Banner>}
          {draft.starter && <Banner kind="warn">Starter pack{draft.law ? `, based on ${draft.law}` : ''}. Written from the law's general rules and not reviewed by a local lawyer.{draft.notes ? ` ${draft.notes}` : ''}</Banner>}
          {!draft.builtIn && (
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <Field label="Name"><Input value={draft.name} disabled={ro} onChange={(e) => setDraft({ ...draft, name: e.target.value })} /></Field>
              <Field label="Country or region"><Input value={draft.region} disabled={ro} onChange={(e) => setDraft({ ...draft, region: e.target.value })} /></Field>
              <Field label="Notes"><Input value={draft.description} disabled={ro} onChange={(e) => setDraft({ ...draft, description: e.target.value })} placeholder="What this pack is based on" /></Field>
            </div>
          )}
          {draft.rules.length === 0 ? <Empty title="No rules yet">Add the rules this pack should enforce.</Empty> : (
            <div className="border border-[#E5E5E0] rounded-lg divide-y divide-[#E5E5E0]">
              {draft.rules.map((r, i) => {
                const s = spec.get(r.type);
                return (
                  <div key={r.id + i} className="p-3 flex flex-wrap items-center gap-x-4 gap-y-2">
                    <div className="w-72 min-w-[16rem]"><div className="font-semibold text-[13px]">{s?.label ?? r.type}</div><div className="text-[11px] text-[#6B6B6B]">{s?.help}</div></div>
                    <div className="flex flex-wrap items-center gap-3 flex-1">
                      {s?.params.map((p) => (
                        <label key={p.key} className="flex items-center gap-1.5 text-[12px] text-[#525252]">{p.label}
                          {p.kind === 'boolean'
                            ? <input type="checkbox" checked={!!r.params[p.key]} disabled={ro} onChange={(e) => setParam(i, p.key, e.target.checked)} />
                            : <Input className="!w-24" type={p.kind === 'time' ? 'time' : 'number'} min={p.min} max={p.max} step={p.kind === 'number' && p.max && p.max <= 24 ? 0.5 : 1} value={r.params[p.key]} disabled={ro} onChange={(e) => setParam(i, p.key, p.kind === 'number' ? Number(e.target.value) : e.target.value)} />}
                          {p.unit && <span className="text-[#6B6B6B]">{p.unit}</span>}
                        </label>
                      ))}
                    </div>
                    <div className="flex items-center gap-2">
                      <Select className="!w-auto" value={r.severity} disabled={ro || s?.informational} onChange={(e) => setRule(i, { severity: e.target.value as Rule['severity'] })} aria-label="Severity">
                        <option value="BLOCK">Blocks publishing</option><option value="WARN">Warns only</option>
                      </Select>
                      {!ro && <button aria-label="Remove rule" className="text-[#6B6B6B] hover:text-[#BC3F3F]" onClick={() => setDraft({ ...draft, rules: draft.rules.filter((_, j) => j !== i) })}><Trash2 className="w-4 h-4" /></button>}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
          {!ro && (
            <div className="flex items-center gap-2">
              <Select className="!w-auto" value="" onChange={(e) => e.target.value && addRule(e.target.value)} aria-label="Add a rule">
                <option value="">Add a rule…</option>
                {(catalog.data ?? []).map((s) => <option key={s.type} value={s.type}>{s.label}</option>)}
              </Select>
              <span className="text-[11px] text-[#6B6B6B]">A rule that blocks stops publishing and the scheduler leaves out shifts that would break it. A warning is only reported.</span>
            </div>
          )}
        </Card>
      )}

      <div ref={whereRef} />
      <Card title="Where each pack applies" sub="The most specific choice wins: a person's, else their team's, else the WFM group's, else the site's, else the region's, else the organisation's. With none chosen, only the scheduling rules and each person's contract apply.">
        <div className="space-y-3 max-w-3xl">
          <AssignRow label="Whole organisation" value={at('TENANT', null)} packs={packs.data ?? []} disabled={!canWrite || busy} onChange={(v) => assign('TENANT', null, v)} />
          {(regions.data?.length ?? 0) > 0 && <div className="text-[11px] font-semibold uppercase tracking-wider text-[#6B6B6B] pt-2">Regions</div>}
          {(regions.data ?? []).map((r) => <AssignRow key={r.id} label={r.name} value={at('REGION', r.id)} packs={packs.data ?? []} disabled={!canWrite || busy} onChange={(v) => assign('REGION', r.id, v)} />)}
          {(sites.data?.length ?? 0) > 0 && <div className="text-[11px] font-semibold uppercase tracking-wider text-[#6B6B6B] pt-2">Sites</div>}
          {(sites.data ?? []).filter((s) => s.status !== 'CLOSED' || at('SITE', s.id)).map((s) => <AssignRow key={s.id} label={`${s.name}${s.regionName ? ` (${s.regionName})` : ''}`} value={at('SITE', s.id)} packs={packs.data ?? []} disabled={!canWrite || busy} onChange={(v) => assign('SITE', s.id, v)} />)}
          <div className="text-[11px] font-semibold uppercase tracking-wider text-[#6B6B6B] pt-2">WFM groups</div>
          {groups.length === 0 && <p className="text-[12px] text-[#6B6B6B]">No WFM groups yet.</p>}
          {groups.map((g) => <AssignRow key={g.id} label={g.name} value={at('GROUP', g.id)} packs={packs.data ?? []} disabled={!canWrite || busy} onChange={(v) => assign('GROUP', g.id, v)} />)}
          {(teams.data?.length ?? 0) > 0 && <div className="text-[11px] font-semibold uppercase tracking-wider text-[#6B6B6B] pt-2">Teams</div>}
          {(teams.data ?? []).map((t) => <AssignRow key={t.id} label={t.name} value={at('TEAM', t.id)} packs={packs.data ?? []} disabled={!canWrite || busy} onChange={(v) => assign('TEAM', t.id, v)} />)}
        </div>
      </Card>
      {drawer && current && (
        <PackDrawer pack={current} usage={usage.get(current.id) ?? []} all={assigns.data ?? []} packs={packs.data ?? []} canWrite={canWrite} busy={busy}
          places={{ regions: regions.data ?? [], sites: (sites.data ?? []).filter((x) => x.status !== 'CLOSED').map((x) => ({ id: x.id, name: x.name })), groups: groups.map((g) => ({ id: g.id, name: g.name })), teams: teams.data ?? [] }}
          onClose={() => setDrawer(false)} onCopy={copy} onDelete={remove} onApply={applyHere} onRemove={removeHere}
          onEdit={() => { setDrawer(false); setTimeout(() => editRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 80); }} />)}
    </div>
  );
};

const AssignRow: React.FC<{ label: string; value: string; packs: Pack[]; disabled: boolean; onChange: (packId: string) => void }> = ({ label, value, packs, disabled, onChange }) => (
  <div className="flex items-center gap-3">
    <div className="w-56 text-[13px] font-medium truncate">{label}</div>
    <Select value={value} disabled={disabled} onChange={(e) => onChange(e.target.value)} aria-label={`Pack for ${label}`}>
      <option value="">No pack (or inherit)</option>
      {packs.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
    </Select>
  </div>
);
