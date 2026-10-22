/**
 * Configuration › WFM Groups. A group is a set of queues that share one pool of agents, with the service targets that
 * turn a forecast into a staffing number. Saved to the gateway; changing targets recalculates staffing immediately.
 */
import React, { useMemo, useState } from 'react';
import { Pencil, Plus, Trash2 } from 'lucide-react';
import { api, CHANNEL_LABEL, Channel, CoverageWindow, DOW, Employee, GroupDto, MODEL_LABEL, Queue, ShrinkageCategory, Team } from '../../services/api';
import { useForecast } from '../../services/forecastStore';
import { useApi } from '../forecasting/hooks';
import { Banner, Btn, Card, Empty, Field, Input, Pill, Select, Table } from '../forecasting/ui';

type Form = { name: string; description: string; timezone: string; serviceLevelGoal: number; serviceLevelThresholdSec: number; targetOccupancy: number; shrinkagePercent: number; method: 'erlang_c' | 'erlang_a'; patienceSec: number; blended: boolean; model: string; fteHoursWeek: number };
const DEFAULTS: Form = { name: '', description: '', timezone: 'UTC', serviceLevelGoal: 80, serviceLevelThresholdSec: 20, targetOccupancy: 85, shrinkagePercent: 30, method: 'erlang_c', patienceSec: 120, blended: false, model: 'auto', fteHoursWeek: 40 };

export const WfmGroupsPanel: React.FC = () => {
  const { can, reloadGroups, setNotice } = useForecast();
  const [tick, setTick] = useState(0);
  const groups = useApi<GroupDto[]>('/config/groups', [tick]);
  const queues = useApi<Queue[]>('/config/queues', [tick]);
  const teams = useApi<Team[]>('/workforce/teams', [tick]);
  const [editing, setEditing] = useState<{ id: string | null; form: Form } | null>(null);
  const [error, setError] = useState('');
  const canWrite = can('config:write');
  const zones = useMemo(() => { try { return (Intl as any).supportedValuesOf('timeZone') as string[]; } catch { return ['UTC', 'Asia/Kolkata', 'Europe/London', 'America/New_York']; } }, []);
  const refresh = async () => { setTick((t) => t + 1); await reloadGroups(); };

  const save = async () => {
    if (!editing) return;
    setError('');
    try {
      if (editing.id) await api(`/config/groups/${editing.id}`, { method: 'PUT', body: editing.form });
      else await api('/config/groups', { method: 'POST', body: editing.form });
      setNotice({ kind: 'ok', text: editing.id ? 'Group saved. Staffing numbers use the new targets straight away.' : 'Group created. Add its queues next.' });
      setEditing(null); await refresh();
    } catch (e: any) { setError(e.message); }
  };
  const num = (k: keyof Form) => (e: React.ChangeEvent<HTMLInputElement>) => setEditing((s) => s && { ...s, form: { ...s.form, [k]: Number(e.target.value) } });

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-[16px] font-semibold text-[#171717]">Configured WFM Groups</h2>
        {canWrite && <Btn variant="primary" onClick={() => { setError(''); setEditing({ id: null, form: DEFAULTS }); }}><Plus className="w-3.5 h-3.5" />Create WFM Group</Btn>}
      </div>

      {editing && (
        <Card title={editing.id ? 'Edit WFM group' : 'New WFM group'}>
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-4">
            <div className="xl:col-span-2"><Field label="Name"><Input value={editing.form.name} onChange={(e) => setEditing({ ...editing, form: { ...editing.form, name: e.target.value } })} /></Field></div>
            <div className="xl:col-span-2"><Field label="Description"><Input value={editing.form.description} onChange={(e) => setEditing({ ...editing, form: { ...editing.form, description: e.target.value } })} /></Field></div>
            <Field label="Timezone" hint="The clock this group's days, schedules and adherence run on">
              <Select value={editing.form.timezone} onChange={(e) => setEditing({ ...editing, form: { ...editing.form, timezone: e.target.value } })}>{zones.map((z) => <option key={z} value={z}>{z}</option>)}</Select>
            </Field>
            <Field label="Service level goal (%)" hint="Share of contacts answered in time"><Input type="number" min={1} max={99} value={editing.form.serviceLevelGoal} onChange={num('serviceLevelGoal')} /></Field>
            <Field label="Answer within (seconds)"><Input type="number" min={1} max={600} value={editing.form.serviceLevelThresholdSec} onChange={num('serviceLevelThresholdSec')} /></Field>
            <Field label="Occupancy cap (%)" hint="Most time agents should be busy"><Input type="number" min={31} max={100} value={editing.form.targetOccupancy} onChange={num('targetOccupancy')} /></Field>
            <Field label="Shrinkage (%)" hint="Breaks, training, absence"><Input type="number" min={0} max={90} value={editing.form.shrinkagePercent} onChange={num('shrinkagePercent')} /></Field>
            <Field label="Staffing method" hint="Erlang A allows for customers who hang up">
              <Select value={editing.form.method} onChange={(e) => setEditing({ ...editing, form: { ...editing.form, method: e.target.value as Form['method'] } })}><option value="erlang_c">Erlang C</option><option value="erlang_a">Erlang A (with abandonment)</option></Select>
            </Field>
            <Field label="Customer patience (seconds)" hint="Used by Erlang A"><Input type="number" min={10} max={3600} value={editing.form.patienceSec} onChange={num('patienceSec')} /></Field>
            <Field label="Default forecast model"><Select value={editing.form.model} onChange={(e) => setEditing({ ...editing, form: { ...editing.form, model: e.target.value } })}>{Object.entries(MODEL_LABEL).map(([id, l]) => <option key={id} value={id}>{l}</option>)}</Select></Field>
            <Field label="Full-time hours per week"><Input type="number" min={10} max={60} value={editing.form.fteHoursWeek} onChange={num('fteHoursWeek')} /></Field>
            <Field label="Voice and chat share agents?" hint="Blend the two into one pool">
              <Select value={editing.form.blended ? 'yes' : 'no'} onChange={(e) => setEditing({ ...editing, form: { ...editing.form, blended: e.target.value === 'yes' } })}><option value="no">No, separate</option><option value="yes">Yes, blended</option></Select>
            </Field>
          </div>
          {error && <Banner kind="err">{error}</Banner>}
          <div className="flex gap-2"><Btn variant="primary" disabled={!editing.form.name.trim()} onClick={save}>Save group</Btn><Btn onClick={() => setEditing(null)}>Cancel</Btn></div>
        </Card>
      )}

      {groups.error && <Banner kind="err">{groups.error}</Banner>}
      {groups.data?.length === 0 && !editing && <Empty title="No WFM groups yet">A group is a set of queues that share one pool of agents. {canWrite ? 'Create the first one above.' : 'Ask an administrator to create one.'}</Empty>}

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
        {groups.data?.map((g) => (
          <div key={g.id} className="p-4 rounded-lg border border-[#E5E5E0] bg-[#FFFFFF] shadow-xs space-y-3">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h3 className="text-[15px] font-semibold text-[#171717]">{g.name}</h3>
                <div className="text-[11px] font-mono text-[#737373]">{g.code} · {g.timezone}</div>
              </div>
              <div className="flex items-center gap-2">
                {g.status !== 'ACTIVE' && <Pill>Inactive</Pill>}
                {canWrite && <button aria-label="Edit group" className="text-[#737373] hover:text-[#171717]" onClick={() => { setError(''); setEditing({ id: g.id, form: { ...DEFAULTS, ...g } }); }}><Pencil className="w-4 h-4" /></button>}
              </div>
            </div>
            {g.description && <p className="text-[12px] text-[#737373] leading-relaxed">{g.description}</p>}
            <div className="border-t border-[#E5E5E0] pt-3 grid grid-cols-2 gap-x-6 gap-y-1.5 text-[12px]">
              <Row k="Service goal" v={`${g.serviceLevelGoal}% in ${g.serviceLevelThresholdSec}s`} />
              <Row k="Occupancy cap" v={`${g.targetOccupancy}%`} />
              <Row k="Shrinkage" v={`${g.shrinkagePercent}%`} />
              <Row k="Method" v={g.method === 'erlang_a' ? 'Erlang A' : 'Erlang C'} />
              <Row k="Forecast model" v={MODEL_LABEL[g.model] ?? g.model} />
              <Row k="Blended pool" v={g.blended ? 'Yes' : 'No'} />
            </div>
            <ShrinkageCategories group={g} canWrite={canWrite} />
            <CoverageWindows group={g} canWrite={canWrite} />
            <GroupEmployees group={g} teams={teams.data ?? []} canWrite={canWrite} />
            <QueueList group={g} queues={(queues.data ?? []).filter((q) => q.wfmGroupId === g.id)} canWrite={canWrite} onChange={refresh} />
          </div>
        ))}
      </div>
    </div>
  );
};

const Row: React.FC<{ k: string; v: string }> = ({ k, v }) => (
  <div className="flex justify-between gap-2"><span className="text-[#737373]">{k}</span><span className="font-medium text-[#171717] text-right">{v}</span></div>
);

const ShrinkageCategories: React.FC<{ group: GroupDto; canWrite: boolean }> = ({ group, canWrite }) => {
  const [tick, setTick] = useState(0);
  const cats = useApi<ShrinkageCategory[]>(`/config/groups/${group.id}/shrinkage-categories`, [tick]);
  const [f, setF] = useState<{ name: string; pct: number } | null>(null);
  const [error, setError] = useState('');
  const total = (cats.data ?? []).reduce((s, c) => s + c.pct, 0);
  const add = async () => {
    if (!f) return;
    setError('');
    try { await api(`/config/groups/${group.id}/shrinkage-categories`, { method: 'POST', body: f }); setF(null); setTick((t) => t + 1); }
    catch (e: any) { setError(e.message); }
  };
  const remove = async (c: ShrinkageCategory) => {
    setError('');
    try { await api(`/config/groups/${group.id}/shrinkage-categories/${c.id}`, { method: 'DELETE' }); setTick((t) => t + 1); }
    catch (e: any) { setError(e.message); }
  };
  return (
    <div className="border-t border-[#E5E5E0] pt-3 space-y-2">
      <div className="flex items-center justify-between gap-2">
        <div className="text-[11px] font-semibold text-[#737373] uppercase tracking-wider">Shrinkage</div>
        <div className="flex items-center gap-3 text-[12px]">
          {(cats.data?.length ?? 0) > 0 && <span className="font-mono text-[#525252]">{total}% total</span>}
          {canWrite && !f && <button className="font-medium text-[#171717] underline underline-offset-2" onClick={() => setF({ name: '', pct: 5 })}>Add category</button>}
        </div>
      </div>
      {(cats.data?.length ?? 0) === 0 ? <p className="text-[12px] text-[#737373]">None. Staffing uses the flat {group.shrinkagePercent}% above.</p> : (
        <Table head={['Category', 'Percent', '']} right={[1]}>
          {cats.data!.map((c) => (
            <tr key={c.id}>
              <td className="p-2.5">{c.name}</td>
              <td className="p-2.5 text-right font-mono">{c.pct}%</td>
              <td className="p-2.5 text-right">{canWrite && <button aria-label={`Delete ${c.name}`} className="text-[#737373] hover:text-[#C84A4A]" onClick={() => remove(c)}><Trash2 className="w-4 h-4" /></button>}</td>
            </tr>
          ))}
        </Table>
      )}
      {error && <Banner kind="err" onClose={() => setError('')}>{error}</Banner>}
      {canWrite && f && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-2 items-end">
          <div className="col-span-2"><Field label="Name"><Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="e.g. Training" /></Field></div>
          <Field label="Percent"><Input type="number" min={0} max={90} value={f.pct} onChange={(e) => setF({ ...f, pct: Number(e.target.value) })} /></Field>
          <div className="flex gap-2"><Btn variant="primary" disabled={!f.name.trim()} onClick={add}>Add</Btn><Btn onClick={() => setF(null)}>Cancel</Btn></div>
        </div>
      )}
    </div>
  );
};

const CoverageWindows: React.FC<{ group: GroupDto; canWrite: boolean }> = ({ group, canWrite }) => {
  const [tick, setTick] = useState(0);
  const windows = useApi<CoverageWindow[]>(`/config/groups/${group.id}/coverage-windows`, [tick]);
  const [f, setF] = useState<{ dayOfWeek: number; startTime: string; endTime: string; headcount: number } | null>(null);
  const [error, setError] = useState('');
  const add = async () => {
    if (!f) return;
    setError('');
    try { await api(`/config/groups/${group.id}/coverage-windows`, { method: 'POST', body: f }); setF(null); setTick((t) => t + 1); }
    catch (e: any) { setError(e.message); }
  };
  const remove = async (w: CoverageWindow) => {
    setError('');
    try { await api(`/config/groups/${group.id}/coverage-windows/${w.id}`, { method: 'DELETE' }); setTick((t) => t + 1); }
    catch (e: any) { setError(e.message); }
  };
  return (
    <div className="border-t border-[#E5E5E0] pt-3 space-y-2">
      <div className="flex items-center justify-between gap-2">
        <div className="text-[11px] font-semibold text-[#737373] uppercase tracking-wider">Manual coverage</div>
        {canWrite && !f && <button className="text-[12px] font-medium text-[#171717] underline underline-offset-2" onClick={() => setF({ dayOfWeek: 0, startTime: '09:00', endTime: '17:00', headcount: 1 })}>Add window</button>}
      </div>
      {(windows.data?.length ?? 0) === 0 ? <p className="text-[12px] text-[#737373]">None. Add windows so Generate Schedule can build without a forecast.</p> : (
        <Table head={['Day', 'Window', 'People needed', '']} right={[2]}>
          {windows.data!.map((w) => (
            <tr key={w.id}>
              <td className="p-2.5">{DOW[w.dayOfWeek]}</td>
              <td className="p-2.5 font-mono text-[12px]">{w.startTime}–{w.endTime}</td>
              <td className="p-2.5 text-right">{w.headcount}</td>
              <td className="p-2.5 text-right">{canWrite && <button aria-label={`Delete ${DOW[w.dayOfWeek]} ${w.startTime}-${w.endTime}`} className="text-[#737373] hover:text-[#C84A4A]" onClick={() => remove(w)}><Trash2 className="w-4 h-4" /></button>}</td>
            </tr>
          ))}
        </Table>
      )}
      {error && <Banner kind="err" onClose={() => setError('')}>{error}</Banner>}
      {canWrite && f && (
        <div className="grid grid-cols-2 md:grid-cols-5 gap-2 items-end">
          <Field label="Day"><Select value={f.dayOfWeek} onChange={(e) => setF({ ...f, dayOfWeek: Number(e.target.value) })}>{DOW.map((d, n) => <option key={d} value={n}>{d}</option>)}</Select></Field>
          <Field label="Start"><Input type="time" step={900} value={f.startTime} onChange={(e) => setF({ ...f, startTime: e.target.value })} /></Field>
          <Field label="End"><Input type="time" step={900} value={f.endTime} onChange={(e) => setF({ ...f, endTime: e.target.value })} /></Field>
          <Field label="People needed"><Input type="number" min={0} max={500} value={f.headcount} onChange={(e) => setF({ ...f, headcount: Number(e.target.value) })} /></Field>
          <div className="flex gap-2"><Btn variant="primary" disabled={f.endTime <= f.startTime} onClick={add}>Add</Btn><Btn onClick={() => setF(null)}>Cancel</Btn></div>
        </div>
      )}
    </div>
  );
};

const GroupEmployees: React.FC<{ group: GroupDto; teams: Team[]; canWrite: boolean }> = ({ group, teams, canWrite }) => {
  const [tick, setTick] = useState(0);
  const members = useApi<Employee[]>(`/workforce/employees?groupId=${group.id}`, [tick]);
  const [query, setQuery] = useState('');
  const search = useApi<Employee[]>(query.trim().length >= 2 ? `/workforce/employees?q=${encodeURIComponent(query.trim())}&status=ACTIVE` : null, [query]);
  const [error, setError] = useState('');
  const [adding, setAdding] = useState(false);
  const [linking, setLinking] = useState(false);
  const memberIds = new Set((members.data ?? []).map((e) => e.id));

  const addEmployee = async (e: Employee) => {
    setError('');
    try { await api(`/workforce/employees/${e.id}`, { method: 'PUT', body: { eligibleGroupIds: [...new Set([...e.eligibleGroupIds, group.id])] } }); setQuery(''); setTick((t) => t + 1); }
    catch (err: any) { setError(err.message); }
  };
  const removeEmployee = async (e: Employee) => {
    setError('');
    if (e.primaryGroupId === group.id) { setError(`${e.name}’s primary group is this group — change their primary group on their profile instead.`); return; }
    try { await api(`/workforce/employees/${e.id}`, { method: 'PUT', body: { eligibleGroupIds: e.eligibleGroupIds.filter((id) => id !== group.id) } }); setTick((t) => t + 1); }
    catch (err: any) { setError(err.message); }
  };
  const linkTeam = async (teamId: string) => {
    if (!teamId) return;
    setError('');
    try {
      const teamMembers = await api<Employee[]>(`/workforce/employees?teamId=${teamId}&status=ACTIVE`);
      for (const e of teamMembers.filter((e) => !e.eligibleGroupIds.includes(group.id))) await api(`/workforce/employees/${e.id}`, { method: 'PUT', body: { eligibleGroupIds: [...new Set([...e.eligibleGroupIds, group.id])] } });
      setLinking(false); setTick((t) => t + 1);
    } catch (err: any) { setError(err.message); }
  };
  // drag a person's chip onto another team's bucket (or "No team") to move them there
  const assignTeam = async (employeeId: string, teamId: string | null) => {
    setError('');
    try { await api(`/workforce/employees/${employeeId}`, { method: 'PUT', body: { teamId } }); setTick((t) => t + 1); }
    catch (err: any) { setError(err.message); }
  };
  const onDropTeam = (teamId: string | null) => (ev: React.DragEvent) => {
    ev.preventDefault();
    const id = ev.dataTransfer.getData('text/plain');
    if (id) assignTeam(id, teamId);
  };

  const byTeam = new Map<string, { teamId: string | null; emps: Employee[] }>();
  for (const e of members.data ?? []) {
    const k = e.teamName ?? 'No team';
    const bucket = byTeam.get(k) ?? { teamId: e.teamId, emps: [] };
    bucket.emps.push(e); byTeam.set(k, bucket);
  }

  return (
    <div className="border-t border-[#E5E5E0] pt-3 space-y-2">
      <div className="text-[11px] font-semibold text-[#737373] uppercase tracking-wider">Employees ({members.data?.length ?? 0})</div>
      {(members.data?.length ?? 0) === 0 ? <p className="text-[12px] text-[#737373]">No one is linked to this group yet.</p> : (
        <div className="space-y-2">
          {canWrite && <p className="text-[11px] text-[#737373]">Drag a person onto another team below to move them there.</p>}
          {[...byTeam.entries()].map(([teamName, { teamId, emps }]) => (
            <div key={teamName} onDragOver={canWrite ? (e) => e.preventDefault() : undefined} onDrop={canWrite ? onDropTeam(teamId) : undefined}
              className={canWrite ? 'rounded-md border border-dashed border-transparent hover:border-[#D6D6D0] -m-1 p-1 transition-colors' : undefined}>
              <div className="text-[11px] font-medium text-[#737373] mb-1">{teamName}</div>
              <div className="flex flex-wrap gap-1.5">
                {emps.map((e) => (
                  <span key={e.id} draggable={canWrite} onDragStart={(ev) => ev.dataTransfer.setData('text/plain', e.id)}
                    className={`inline-flex items-center gap-1 text-[12px] bg-[#F5F5F0] rounded-full pl-2 pr-1 py-0.5 ${canWrite ? 'cursor-grab active:cursor-grabbing' : ''}`}>
                    {e.name}{e.primaryGroupId === group.id && <span className="text-[#737373]">(primary)</span>}
                    {canWrite && <button aria-label={`Remove ${e.name}`} className="text-[#737373] hover:text-[#C84A4A]" onClick={() => removeEmployee(e)}><Trash2 className="w-3 h-3" /></button>}
                  </span>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
      {error && <Banner kind="err" onClose={() => setError('')}>{error}</Banner>}
      {canWrite && (
        <div className="space-y-2">
          {adding && (
            <div className="space-y-2">
              <Field label="Add an employee"><Input autoFocus value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search by name..." /></Field>
              {query.trim().length >= 2 && (
                <div className="border border-[#E5E5E0] rounded-md divide-y divide-[#E5E5E0] max-h-40 overflow-auto">
                  {(search.data ?? []).filter((e) => !memberIds.has(e.id)).length === 0
                    ? <div className="p-2 text-[12px] text-[#737373]">{(search.data ?? []).length > 0 ? 'Everyone matching that name is already in this group.' : 'No match.'}</div>
                    : (search.data ?? []).filter((e) => !memberIds.has(e.id)).map((e) => (
                      <button key={e.id} className="w-full text-left p-2 text-[12px] hover:bg-[#F5F5F0]" onClick={() => addEmployee(e)}>{e.name} <span className="text-[#737373]">{e.teamName ?? 'no team'}</span></button>
                    ))}
                </div>
              )}
              <Btn onClick={() => { setAdding(false); setQuery(''); }}>Done</Btn>
            </div>
          )}
          {linking && (
            <div className="flex gap-2 items-end">
              <div className="flex-1"><Field label="Link every active member of a team"><Select defaultValue="" onChange={(e) => linkTeam(e.target.value)}><option value="" disabled>Choose a team</option>{teams.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</Select></Field></div>
              <Btn onClick={() => setLinking(false)}>Cancel</Btn>
            </div>
          )}
          {!adding && !linking && (
            <div className="flex gap-2">
              <Btn onClick={() => setAdding(true)}><Plus className="w-3.5 h-3.5" />Add employee</Btn>
              <Btn onClick={() => setLinking(true)}><Plus className="w-3.5 h-3.5" />Link a team</Btn>
            </div>
          )}
        </div>
      )}
    </div>
  );
};

const QueueList: React.FC<{ group: GroupDto; queues: Queue[]; canWrite: boolean; onChange: () => Promise<void> }> = ({ group, queues, canWrite, onChange }) => {
  const [f, setF] = useState<{ name: string; channel: Channel; ahtDefault: number; concurrency: number; turnaroundHours: number } | null>(null);
  const [error, setError] = useState('');
  const add = async () => {
    if (!f) return;
    setError('');
    try {
      await api('/config/queues', { method: 'POST', body: { name: f.name, channel: f.channel, ahtDefault: f.ahtDefault, wfmGroupId: group.id, ...(f.channel === 'CHAT' ? { concurrency: f.concurrency } : {}), ...(f.channel === 'BACKOFFICE' ? { turnaroundHours: f.turnaroundHours } : {}) } });
      setF(null); await onChange();
    } catch (e: any) { setError(e.message); }
  };
  const remove = async (q: Queue, force = false) => {
    try { await api(`/config/queues/${q.id}${force ? '?force=true' : ''}`, { method: 'DELETE' }); await onChange(); }
    catch (e: any) { if (e.status === 409 && confirm(`${e.message}\n\nDelete anyway?`)) await remove(q, true); else if (e.status !== 409) setError(e.message); }
  };
  const turnaroundLabel = (h: number | null) => (!h || h <= 24 ? 'same day' : h % 24 === 0 ? `${h / 24}d turnaround` : `${h}h turnaround`);
  return (
    <div className="border-t border-[#E5E5E0] pt-3 space-y-2">
      <div className="text-[11px] font-semibold text-[#737373] uppercase tracking-wider">Queues</div>
      {queues.length === 0 ? <p className="text-[12px] text-[#737373]">No queues yet.</p> : (
        <Table head={['Queue', 'Channel', 'Handle time', '']} right={[2]}>
          {queues.map((q) => (
            <tr key={q.id}>
              <td className="p-2.5 font-medium">{q.name}</td>
              <td className="p-2.5">{CHANNEL_LABEL[q.channel]}{q.channel === 'CHAT' ? ` · ${q.concurrency} at once` : q.channel === 'BACKOFFICE' ? ` · ${turnaroundLabel(q.turnaroundHours)}` : ''}</td>
              <td className="p-2.5 text-right font-mono">{q.ahtDefault}s</td>
              <td className="p-2.5 text-right">{canWrite && <button aria-label={`Delete ${q.name}`} className="text-[#737373] hover:text-[#C84A4A]" onClick={() => remove(q)}><Trash2 className="w-4 h-4" /></button>}</td>
            </tr>
          ))}
        </Table>
      )}
      {error && <Banner kind="err" onClose={() => setError('')}>{error}</Banner>}
      {canWrite && (f ? (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-2 items-end">
          <div className="col-span-2"><Field label="Queue name"><Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field></div>
          <Field label="Channel"><Select value={f.channel} onChange={(e) => setF({ ...f, channel: e.target.value as Channel })}>{(['VOICE', 'CHAT', 'EMAIL', 'BACKOFFICE'] as Channel[]).map((c) => <option key={c} value={c}>{CHANNEL_LABEL[c]}</option>)}</Select></Field>
          <Field label="Handle time (s)"><Input type="number" min={1} value={f.ahtDefault} onChange={(e) => setF({ ...f, ahtDefault: Number(e.target.value) })} /></Field>
          {f.channel === 'BACKOFFICE' && <Field label="Turnaround (hours)" hint="0 or 24 = same day"><Input type="number" min={0} max={720} value={f.turnaroundHours} onChange={(e) => setF({ ...f, turnaroundHours: Number(e.target.value) })} /></Field>}
          {f.channel === 'CHAT' && <Field label="Chats at once"><Input type="number" min={1} max={10} value={f.concurrency} onChange={(e) => setF({ ...f, concurrency: Number(e.target.value) })} /></Field>}
          <div className="flex gap-2 col-span-2"><Btn variant="primary" disabled={!f.name.trim()} onClick={add}>Add queue</Btn><Btn onClick={() => setF(null)}>Cancel</Btn></div>
        </div>
      ) : <Btn onClick={() => setF({ name: '', channel: 'VOICE', ahtDefault: 300, concurrency: 2, turnaroundHours: 24 })}><Plus className="w-3.5 h-3.5" />Add queue</Btn>)}
    </div>
  );
};
