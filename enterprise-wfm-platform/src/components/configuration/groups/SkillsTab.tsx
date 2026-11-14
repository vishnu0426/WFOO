/**
 * WFM group › Skills. Who can work for this group. With no skills required, that is the group's own people plus anyone marked eligible for it. With skills required, it is everyone
 * who has all of them at the level asked, whichever group they belong to, so cross-trained people serve several groups. The scheduler never books one person for two groups at once.
 * The skills themselves (and each person's level) are kept under Workforce › Skills.
 */
import React, { useEffect, useState } from 'react';
import { Trash2 } from 'lucide-react';
import { api, Skill } from '../../../services/api';
import { useApi } from '../../forecasting/hooks';
import { Banner, Btn, Card, Pill, Select, Table } from '../../forecasting/ui';
import type { GroupDto } from '../../../services/api';

type Req = { skillId: string; name?: string; minProficiency: number };
type Pool = {
  groupId: string; skillBased: boolean; requires: Req[]; counts: { inPool: number; fromOtherGroups: number; leftOut: number };
  people: { employeeId: string; name: string; employeeNumber: string; homeGroup: string | null; primary: boolean; listed: boolean; inPool: boolean; missing: string[] }[];
};
const LEVEL = ['1 · Learning', '2 · Basic', '3 · Competent', '4 · Advanced', '5 · Expert'];

export const SkillsTab: React.FC<{ group: GroupDto; canWrite: boolean; onChanged?: () => void }> = ({ group, canWrite, onChanged }) => {
  const [tick, setTick] = useState(0);
  const skills = useApi<Skill[]>('/workforce/skills');
  const pool = useApi<Pool>(`/config/groups/${group.id}/pool`, [group.id, tick]);
  const [reqs, setReqs] = useState<Req[]>([]);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState('');
  useEffect(() => { if (pool.data) setReqs(pool.data.requires); }, [pool.data]);
  const dirty = JSON.stringify(reqs.map((r) => [r.skillId, r.minProficiency])) !== JSON.stringify((pool.data?.requires ?? []).map((r) => [r.skillId, r.minProficiency]));
  const free = (skills.data ?? []).filter((s) => !reqs.some((r) => r.skillId === s.id));
  const c = pool.data?.counts;
  const save = async () => {
    setError(''); setSaved('');
    try { await api(`/config/groups/${group.id}/skills`, { method: 'PUT', body: { skills: reqs.map((r) => ({ skillId: r.skillId, minProficiency: r.minProficiency })) } }); setSaved('Saved. The next schedule uses the new pool.'); setTick((t) => t + 1); onChanged?.(); } catch (e: any) { setError(e.message); }
  };

  return (
    <Card title="Who can work for this group" sub={reqs.length ? 'Anyone who has all of these skills at the level asked, from any group.' : 'Everyone in this group, plus anyone marked eligible for it. Require skills below to draw on people from other groups too.'}>
      {error && <Banner kind="err" onClose={() => setError('')}>{error}</Banner>}
      {saved && <Banner kind="ok" onClose={() => setSaved('')}>{saved}</Banner>}
      <div className="space-y-2">
        <div className="text-[12px] font-semibold">Skills required <span className="font-normal text-[#6B6B6B]">(optional)</span></div>
        {reqs.length === 0 && <p className="text-[12px] text-[#6B6B6B]">None. Add one when only people with a certain skill can do this group's work, for example a language or billing.</p>}
        {reqs.map((r, i) => (
          <div key={r.skillId} className="flex flex-wrap items-center gap-2">
            <span className="w-56 text-[13px] font-medium">{skills.data?.find((s) => s.id === r.skillId)?.name ?? r.name}</span>
            <span className="text-[12px] text-[#6B6B6B]">at least</span>
            <Select className="!w-auto" disabled={!canWrite} aria-label={`Level for ${skills.data?.find((s) => s.id === r.skillId)?.name ?? 'skill'}`} value={r.minProficiency} onChange={(e) => setReqs(reqs.map((x, j) => (j === i ? { ...x, minProficiency: Number(e.target.value) } : x)))}>{LEVEL.map((l, k) => <option key={k} value={k + 1}>{l}</option>)}</Select>
            {canWrite && <button aria-label="Remove skill" className="text-[#6B6B6B] hover:text-[#BC3F3F]" onClick={() => setReqs(reqs.filter((_, j) => j !== i))}><Trash2 className="w-4 h-4" /></button>}
          </div>
        ))}
        {canWrite && (
          <div className="flex flex-wrap items-center gap-2">
            <Select className="!w-auto" value="" onChange={(e) => e.target.value && setReqs([...reqs, { skillId: e.target.value, minProficiency: 3 }])} aria-label="Add a skill"><option value="">Add a required skill…</option>{free.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</Select>
            {dirty && <><Btn variant="primary" onClick={save}>Save</Btn><Btn onClick={() => setReqs(pool.data?.requires ?? [])}>Undo</Btn></>}
          </div>
        )}
        {(skills.data ?? []).length === 0 && <p className="text-[12px] text-[#8F6200]">No skills exist yet. Create them under Workforce › Skills, then give people a level in each.</p>}
      </div>

      <div className="flex flex-wrap items-center gap-3 text-[13px]">
        {pool.data?.skillBased ? <Pill tone="info">Pool by skill</Pill> : <Pill>Pool by group</Pill>}
        {c && <span className="text-[#525252]">{c.inPool} can work here{c.fromOtherGroups ? `, ${c.fromOtherGroups} from other groups` : ''}{c.leftOut ? `, ${c.leftOut} left out for lack of a skill` : ''}</span>}
      </div>
      {pool.data && pool.data.people.length > 0 && (
        <Table head={['Person', 'Home group', 'Can work here', 'Missing']}>
          {pool.data.people.slice(0, 40).map((p) => (
            <tr key={p.employeeId}>
              <td className="p-2.5">{p.name} <span className="text-[11px] text-[#6B6B6B]">#{p.employeeNumber}</span></td><td className="p-2.5 text-[#525252]">{p.homeGroup ?? '–'}</td>
              <td className="p-2.5">{p.inPool ? <Pill tone="good">Yes</Pill> : <Pill tone="warn">No</Pill>}</td><td className="p-2.5 text-[12px] text-[#8F6200]">{p.missing.join(', ') || '–'}</td>
            </tr>
          ))}
        </Table>
      )}
    </Card>
  );
};
