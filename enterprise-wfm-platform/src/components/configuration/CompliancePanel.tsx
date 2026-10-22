/**
 * Configuration › Compliance Packs. A pack is a named set of labour-law rules. The ready-made ones (India, European Union, United States)
 * are read-only: copy one to change it, or start a new one. Say where each pack applies: the whole organisation, a WFM group or a team,
 * and the most specific one wins. The schedule generator will not create shifts a BLOCK rule forbids, and a schedule with BLOCK problems cannot be published.
 */
import React, { useEffect, useMemo, useState } from 'react';
import { Copy, Plus, Trash2 } from 'lucide-react';
import { api, Team } from '../../services/api';
import { useForecast } from '../../services/forecastStore';
import { useApi } from '../forecasting/hooks';
import { Banner, Btn, Busy, Card, Empty, Field, Input, Pill, Select } from '../forecasting/ui';

type Param = { key: string; label: string; kind: 'number' | 'time' | 'boolean'; unit?: string; min?: number; max?: number; default: number | string | boolean };
type Spec = { type: string; label: string; help: string; params: Param[]; defaultSeverity: 'BLOCK' | 'WARN'; informational?: boolean };
type Rule = { id: string; type: string; severity: 'BLOCK' | 'WARN'; params: Record<string, any> };
type Pack = { id: string; code: string; name: string; region: string; description: string; rules: Rule[]; builtIn: boolean; usedBy: number };
type Assignment = { scopeType: 'TENANT' | 'GROUP' | 'TEAM'; scopeId: string | null; scopeName: string; packId: string; packName: string };

export const CompliancePanel: React.FC = () => {
  const { can, groups } = useForecast();
  const canWrite = can('config:write');
  const [tick, setTick] = useState(0);
  const catalog = useApi<Spec[]>('/compliance/catalog');
  const packs = useApi<Pack[]>('/compliance/packs', [tick]);
  const assigns = useApi<Assignment[]>('/compliance/assignments', [tick]);
  const teams = useApi<Team[]>('/workforce/teams');
  const [sel, setSel] = useState<string>('');
  const [draft, setDraft] = useState<Pack | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => { if (packs.data && !packs.data.some((p) => p.id === sel)) setSel(packs.data[0]?.id ?? ''); }, [packs.data]);
  const current = packs.data?.find((p) => p.id === sel) ?? null;
  useEffect(() => { setDraft(current ? JSON.parse(JSON.stringify(current)) : null); setError(''); }, [current?.id, current?.rules]);
  const spec = useMemo(() => new Map((catalog.data ?? []).map((s) => [s.type, s])), [catalog.data]);
  const dirty = !!current && !!draft && JSON.stringify({ n: current.name, r: current.region, d: current.description, x: current.rules }) !== JSON.stringify({ n: draft.name, r: draft.region, d: draft.description, x: draft.rules });

  const run = async (fn: () => Promise<void>) => { setBusy(true); setError(''); setNotice(''); try { await fn(); setTick((t) => t + 1); } catch (e: any) { setError(e.message); } finally { setBusy(false); } };
  const body = (p: Pack) => ({ name: p.name, region: p.region, description: p.description, rules: p.rules.map((r) => ({ id: r.id, type: r.type, severity: r.severity, params: r.params })) });

  const copy = () => current && run(async () => { const c = await api<Pack>('/compliance/packs', { method: 'POST', body: body({ ...current, name: `Copy of ${current.name}`.slice(0, 120) }) }); setSel(c.id); setNotice('Copied. Change the rules below, then save.'); });
  const create = () => run(async () => { const c = await api<Pack>('/compliance/packs', { method: 'POST', body: { name: 'New pack', region: '', description: '', rules: [] } }); setSel(c.id); });
  const save = () => draft && run(async () => { await api(`/compliance/packs/${draft.id}`, { method: 'PUT', body: body(draft) }); setNotice('Saved. Schedules pick the change up straight away.'); });
  const remove = () => current && confirm(`Delete "${current.name}"?`) && run(async () => { await api(`/compliance/packs/${current.id}`, { method: 'DELETE' }); setSel(''); });
  const assign = (scopeType: Assignment['scopeType'], scopeId: string | null, packId: string) => run(async () => { await api('/compliance/assignments', { method: 'PUT', body: { scopeType, scopeId, packId: packId || null } }); setNotice('Saved.'); });
  const at = (t: Assignment['scopeType'], id: string | null) => assigns.data?.find((a) => a.scopeType === t && a.scopeId === id)?.packId ?? '';

  const setRule = (i: number, patch: Partial<Rule>) => setDraft((d) => d && { ...d, rules: d.rules.map((r, j) => (j === i ? { ...r, ...patch } : r)) });
  const setParam = (i: number, k: string, v: any) => setDraft((d) => d && { ...d, rules: d.rules.map((r, j) => (j === i ? { ...r, params: { ...r.params, [k]: v } } : r)) });
  const addRule = (type: string) => { const s = spec.get(type); if (!s) return; setDraft((d) => d && { ...d, rules: [...d.rules, { id: `${type.toLowerCase()}-${d.rules.length + 1}`, type, severity: s.defaultSeverity, params: Object.fromEntries(s.params.map((p) => [p.key, p.default])) }] }); };

  if (packs.loading && !packs.data) return <Busy text="Loading packs…" />;
  const ro = !draft || draft.builtIn || !canWrite;
  return (
    <div className="space-y-6">
      {error && <Banner kind="err" onClose={() => setError('')}>{error}</Banner>}
      {notice && <Banner kind="ok" onClose={() => setNotice('')}>{notice}</Banner>}

      <Card title="Compliance packs" sub="Labour-law rules as data. Pick a pack to see its rules. Ready-made packs are a starting point: rules differ by state, sector and contract, so copy one and adjust it to your situation."
        actions={canWrite && <Btn onClick={create} disabled={busy}><Plus className="w-3.5 h-3.5" />New pack</Btn>}>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          {(packs.data ?? []).map((p) => (
            <button key={p.id} onClick={() => setSel(p.id)} className={`text-left p-3 rounded-lg border transition-colors ${sel === p.id ? 'border-[#171717] bg-[#FAFAF8]' : 'border-[#E5E5E0] hover:bg-[#FAFAF8]'}`}>
              <div className="flex items-center gap-2 flex-wrap"><span className="font-semibold text-[13px]">{p.name}</span>{p.builtIn && <Pill tone="info">Ready-made</Pill>}</div>
              <div className="text-[11px] text-[#737373] mt-1">{p.region || 'No region'} · {p.rules.length} rule{p.rules.length === 1 ? '' : 's'} · used in {p.usedBy} place{p.usedBy === 1 ? '' : 's'}</div>
            </button>
          ))}
        </div>
      </Card>

      {draft && (
        <Card title={draft.builtIn ? draft.name : 'Edit pack'} sub={draft.builtIn ? draft.description : undefined}
          actions={<>
            {draft.builtIn && canWrite && <Btn onClick={copy} disabled={busy}><Copy className="w-3.5 h-3.5" />Copy to edit</Btn>}
            {!draft.builtIn && canWrite && <><Btn variant="primary" onClick={save} disabled={busy || !dirty}>Save changes</Btn><Btn onClick={remove} disabled={busy || draft.usedBy > 0} title={draft.usedBy ? 'Remove where it is used first' : undefined}><Trash2 className="w-3.5 h-3.5" />Delete</Btn></>}
          </>}>
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
                    <div className="w-72 min-w-[16rem]"><div className="font-semibold text-[13px]">{s?.label ?? r.type}</div><div className="text-[11px] text-[#737373]">{s?.help}</div></div>
                    <div className="flex flex-wrap items-center gap-3 flex-1">
                      {s?.params.map((p) => (
                        <label key={p.key} className="flex items-center gap-1.5 text-[12px] text-[#525252]">{p.label}
                          {p.kind === 'boolean'
                            ? <input type="checkbox" checked={!!r.params[p.key]} disabled={ro} onChange={(e) => setParam(i, p.key, e.target.checked)} />
                            : <Input className="!w-24" type={p.kind === 'time' ? 'time' : 'number'} min={p.min} max={p.max} step={p.kind === 'number' && p.max && p.max <= 24 ? 0.5 : 1} value={r.params[p.key]} disabled={ro} onChange={(e) => setParam(i, p.key, p.kind === 'number' ? Number(e.target.value) : e.target.value)} />}
                          {p.unit && <span className="text-[#737373]">{p.unit}</span>}
                        </label>
                      ))}
                    </div>
                    <div className="flex items-center gap-2">
                      <Select className="!w-auto" value={r.severity} disabled={ro || s?.informational} onChange={(e) => setRule(i, { severity: e.target.value as Rule['severity'] })} aria-label="Severity">
                        <option value="BLOCK">Blocks publishing</option><option value="WARN">Warns only</option>
                      </Select>
                      {!ro && <button aria-label="Remove rule" className="text-[#737373] hover:text-[#C84A4A]" onClick={() => setDraft({ ...draft, rules: draft.rules.filter((_, j) => j !== i) })}><Trash2 className="w-4 h-4" /></button>}
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
              <span className="text-[11px] text-[#737373]">A rule that blocks stops publishing and the scheduler leaves out shifts that would break it. A warning is only reported.</span>
            </div>
          )}
        </Card>
      )}

      <Card title="Where each pack applies" sub="The most specific choice wins: a team's pack, else its WFM group's, else the organisation's. With none chosen, only the scheduling rules and each person's contract apply.">
        <div className="space-y-3 max-w-3xl">
          <AssignRow label="Whole organisation" value={at('TENANT', null)} packs={packs.data ?? []} disabled={!canWrite || busy} onChange={(v) => assign('TENANT', null, v)} />
          <div className="text-[11px] font-semibold uppercase tracking-wider text-[#737373] pt-2">WFM groups</div>
          {groups.length === 0 && <p className="text-[12px] text-[#737373]">No WFM groups yet.</p>}
          {groups.map((g) => <AssignRow key={g.id} label={g.name} value={at('GROUP', g.id)} packs={packs.data ?? []} disabled={!canWrite || busy} onChange={(v) => assign('GROUP', g.id, v)} />)}
          {(teams.data?.length ?? 0) > 0 && <div className="text-[11px] font-semibold uppercase tracking-wider text-[#737373] pt-2">Teams</div>}
          {(teams.data ?? []).map((t) => <AssignRow key={t.id} label={t.name} value={at('TEAM', t.id)} packs={packs.data ?? []} disabled={!canWrite || busy} onChange={(v) => assign('TEAM', t.id, v)} />)}
        </div>
      </Card>
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
