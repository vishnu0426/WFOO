/**
 * Configuration › Sites & Skills. Sites are where people work (each has a time zone and country); a WFM group belongs to one.
 * A group can require skills. It then draws its pool from everyone who has all of them at the required level, whichever group they
 * belong to, so cross-trained people serve several groups. The scheduler never books the same person for two groups at once.
 */
import React, { useEffect, useMemo, useState } from 'react';
import { ChevronDown, ChevronRight, Plus, Trash2 } from 'lucide-react';
import { api, Skill } from '../../services/api';
import { useForecast } from '../../services/forecastStore';
import { useApi } from '../forecasting/hooks';
import { Banner, Btn, Busy, Card, Empty, Field, Input, Pill, Select, Table } from '../forecasting/ui';

type Site = { id: string; name: string; code: string; timezone: string; country: string; groups: { id: string; name: string }[] };
type Req = { skillId: string; name?: string; minProficiency: number };
type Pool = { groupId: string; skillBased: boolean; requires: Req[]; counts: { inPool: number; fromOtherGroups: number; leftOut: number }; people: { employeeId: string; name: string; employeeNumber: string; homeGroup: string | null; primary: boolean; inPool: boolean; missing: string[] }[] };
const LEVEL = ['1 · Learning', '2 · Basic', '3 · Competent', '4 · Advanced', '5 · Expert'];

const GroupPool: React.FC<{ groupId: string; name: string; siteId: string | null; sites: Site[]; skills: Skill[]; canWrite: boolean; onChanged: () => void }> = ({ groupId, name, siteId, sites, skills, canWrite, onChanged }) => {
  const [open, setOpen] = useState(false);
  const [tick, setTick] = useState(0);
  const pool = useApi<Pool>(`/config/groups/${groupId}/pool`, [tick]);
  const [reqs, setReqs] = useState<Req[]>([]);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState('');
  useEffect(() => { if (pool.data) setReqs(pool.data.requires); }, [pool.data]);
  const dirty = JSON.stringify(reqs.map((r) => [r.skillId, r.minProficiency])) !== JSON.stringify((pool.data?.requires ?? []).map((r) => [r.skillId, r.minProficiency]));
  const run = async (fn: () => Promise<void>, msg: string) => { setError(''); setSaved(''); try { await fn(); setSaved(msg); setTick((t) => t + 1); onChanged(); } catch (e: any) { setError(e.message); } };
  const free = skills.filter((s) => !reqs.some((r) => r.skillId === s.id));
  const c = pool.data?.counts;
  return (
    <div className="border border-[#E5E5E0] rounded-lg">
      <button className="w-full p-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-left" onClick={() => setOpen(!open)}>
        {open ? <ChevronDown className="w-4 h-4 text-[#737373]" /> : <ChevronRight className="w-4 h-4 text-[#737373]" />}
        <span className="font-semibold text-[14px]">{name}</span>
        {pool.data?.skillBased ? <Pill tone="info">Pool by skill</Pill> : <Pill>Pool by group membership</Pill>}
        {c && <span className="text-[12px] text-[#525252]">{c.inPool} in the pool{c.fromOtherGroups ? `, ${c.fromOtherGroups} from other groups` : ''}{c.leftOut ? `, ${c.leftOut} left out for lack of a skill` : ''}</span>}
      </button>
      {open && (
        <div className="p-3 border-t border-[#E5E5E0] space-y-4">
          {error && <Banner kind="err" onClose={() => setError('')}>{error}</Banner>}
          {saved && <Banner kind="ok">{saved}</Banner>}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4 max-w-4xl">
            <Field label="Site"><Select disabled={!canWrite} value={siteId ?? ''} onChange={(e) => run(async () => { await api(`/config/groups/${groupId}/site`, { method: 'PUT', body: { siteId: e.target.value || null } }); }, 'Saved.')}><option value="">No site</option>{sites.map((s) => <option key={s.id} value={s.id}>{s.name} ({s.timezone})</option>)}</Select></Field>
          </div>
          <div className="space-y-2">
            <div className="text-[12px] font-semibold">Skills required to work for this group</div>
            <p className="text-[11px] text-[#737373]">With none listed, the pool is the people who belong to this group or are marked eligible for it. With skills listed, it is everyone who has all of them at the level shown, from any group.</p>
            {reqs.map((r, i) => (
              <div key={r.skillId} className="flex flex-wrap items-center gap-2">
                <span className="w-56 text-[13px] font-medium">{skills.find((s) => s.id === r.skillId)?.name ?? r.name}</span>
                <span className="text-[12px] text-[#737373]">at least</span>
                <Select className="!w-auto" disabled={!canWrite} value={r.minProficiency} onChange={(e) => setReqs(reqs.map((x, j) => (j === i ? { ...x, minProficiency: Number(e.target.value) } : x)))}>{LEVEL.map((l, k) => <option key={k} value={k + 1}>{l}</option>)}</Select>
                {canWrite && <button aria-label="Remove skill" className="text-[#737373] hover:text-[#C84A4A]" onClick={() => setReqs(reqs.filter((_, j) => j !== i))}><Trash2 className="w-4 h-4" /></button>}
              </div>
            ))}
            {canWrite && (
              <div className="flex flex-wrap items-center gap-2">
                <Select className="!w-auto" value="" onChange={(e) => e.target.value && setReqs([...reqs, { skillId: e.target.value, minProficiency: 3 }])} aria-label="Add a skill"><option value="">Add a required skill…</option>{free.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</Select>
                {dirty && <Btn variant="primary" onClick={() => run(async () => { await api(`/config/groups/${groupId}/skills`, { method: 'PUT', body: { skills: reqs.map((r) => ({ skillId: r.skillId, minProficiency: r.minProficiency })) } }); }, 'Saved. Schedules use this pool from now on.')}>Save skills</Btn>}
              </div>
            )}
          </div>
          {pool.data && pool.data.people.length > 0 && (
            <Table head={['Person', 'Home group', 'In the pool', 'Missing']}>
              {pool.data.people.slice(0, 40).map((p) => (
                <tr key={p.employeeId}><td className="p-2.5">{p.name} <span className="text-[11px] text-[#737373]">#{p.employeeNumber}</span></td><td className="p-2.5 text-[#525252]">{p.homeGroup ?? '–'}</td><td className="p-2.5">{p.inPool ? <Pill tone="good">Yes</Pill> : <Pill tone="warn">No</Pill>}</td><td className="p-2.5 text-[12px] text-[#B7791F]">{p.missing.join(', ')}</td></tr>
              ))}
            </Table>
          )}
        </div>
      )}
    </div>
  );
};

export const SitesPanel: React.FC = () => {
  const { groups, can, reloadGroups } = useForecast();
  const canWrite = can('config:write');
  const [tick, setTick] = useState(0);
  const sites = useApi<Site[]>('/config/sites', [tick]);
  const skills = useApi<Skill[]>('/workforce/skills');
  const [form, setForm] = useState({ name: '', timezone: 'UTC', country: '' });
  const [error, setError] = useState('');
  const zones = useMemo(() => { try { return (Intl as any).supportedValuesOf('timeZone') as string[]; } catch { return ['UTC', 'Asia/Kolkata', 'Europe/London', 'America/New_York']; } }, []);
  const add = async () => { setError(''); try { await api('/config/sites', { method: 'POST', body: form }); setForm({ name: '', timezone: 'UTC', country: '' }); setTick((t) => t + 1); } catch (e: any) { setError(e.message); } };
  const del = async (s: Site) => { if (!confirm(`Delete the site "${s.name}"? Its groups keep working and simply belong to no site.`)) return; try { await api(`/config/sites/${s.id}`, { method: 'DELETE' }); setTick((t) => t + 1); reloadGroups(); } catch (e: any) { setError(e.message); } };

  return (
    <div className="space-y-6">
      {error && <Banner kind="err" onClose={() => setError('')}>{error}</Banner>}
      <Card title="Sites" sub="Where people work. The time zone lets the multi-site view line different sites up on one clock.">
        {sites.loading && !sites.data && <Busy text="Loading…" />}
        {sites.data && sites.data.length === 0 && <Empty title="No sites yet">Add a site for each location. Groups are then assigned to a site below.</Empty>}
        {sites.data && sites.data.length > 0 && (
          <Table head={['Site', 'Time zone', 'Country', 'Groups', '']}>
            {sites.data.map((s) => (
              <tr key={s.id}><td className="p-2.5 font-medium">{s.name}</td><td className="p-2.5 font-mono text-[12px]">{s.timezone}</td><td className="p-2.5">{s.country || '–'}</td><td className="p-2.5 text-[#525252]">{s.groups.map((g) => g.name).join(', ') || '–'}</td>
                <td className="p-2.5 text-right">{canWrite && <button aria-label={`Delete ${s.name}`} className="text-[#737373] hover:text-[#C84A4A]" onClick={() => del(s)}><Trash2 className="w-4 h-4" /></button>}</td></tr>
            ))}
          </Table>
        )}
        {canWrite && (
          <div className="grid grid-cols-1 md:grid-cols-4 gap-3 items-end max-w-4xl">
            <Field label="Name"><Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Chennai" /></Field>
            <Field label="Time zone"><Input list="zones" value={form.timezone} onChange={(e) => setForm({ ...form, timezone: e.target.value })} /><datalist id="zones">{zones.map((z) => <option key={z} value={z} />)}</datalist></Field>
            <Field label="Country"><Input value={form.country} onChange={(e) => setForm({ ...form, country: e.target.value })} placeholder="India" /></Field>
            <div><Btn variant="primary" onClick={add} disabled={!form.name.trim()}><Plus className="w-3.5 h-3.5" />Add site</Btn></div>
          </div>
        )}
      </Card>

      <Card title="Group pools" sub="Which site each WFM group belongs to, and who is in its pool. Open a group to set its required skills.">
        {groups.length === 0 ? <Empty title="No WFM groups yet">Create groups first.</Empty> : (
          <div className="space-y-2">
            {groups.map((g) => <GroupPool key={g.id} groupId={g.id} name={g.name} siteId={(g as any).siteId ?? null} sites={sites.data ?? []} skills={skills.data ?? []} canWrite={canWrite} onChanged={() => { reloadGroups(); setTick((t) => t + 1); }} />)}
          </div>
        )}
      </Card>
    </div>
  );
};
