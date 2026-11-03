/** A group's people as a table with search, a team filter and paging, so a group of hundreds stays usable. */
import React, { useEffect, useState } from 'react';
import { ChevronLeft, ChevronRight, Plus, Search, Trash2 } from 'lucide-react';
import { api, Employee, GroupDto, Team } from '../../../services/api';
import { Banner, Btn, Empty, Field, Input, Pill, Select, Table } from '../../forecasting/ui';
import { useApi } from '../../forecasting/hooks';
import { Confirm, MemberPage, useDebounced } from './shared';

const TYPE_LABEL: Record<string, string> = { FULL_TIME: 'Full time', PART_TIME: 'Part time', CONTRACTOR: 'Contractor', TEMPORARY: 'Temporary' };

export const PeopleTab: React.FC<{ group: GroupDto; teams: Team[]; canWrite: boolean; onChange: () => void }> = ({ group, teams, canWrite, onChange }) => {
  const [tick, setTick] = useState(0);
  const [q, setQ] = useState('');
  const [teamId, setTeamId] = useState('');
  const [limit, setLimit] = useState(50);
  const [offset, setOffset] = useState(0);
  const search = useDebounced(q.trim());
  useEffect(() => { setOffset(0); }, [search, teamId, limit]);
  const page = useApi<MemberPage>(`/config/groups/${group.id}/members?q=${encodeURIComponent(search)}&teamId=${teamId}&limit=${limit}&offset=${offset}`, [tick]);
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState('');
  const [adding, setAdding] = useState(false);
  const [linking, setLinking] = useState(false);
  const [removing, setRemoving] = useState<MemberPage['items'][number] | null>(null);
  const [query, setQuery] = useState('');
  const found = useApi<Employee[]>(adding && query.trim().length >= 2 ? `/workforce/employees?q=${encodeURIComponent(query.trim())}&status=ACTIVE` : null, [query]);
  const memberIds = new Set((page.data?.items ?? []).map((m) => m.id));
  const refresh = () => { setTick((t) => t + 1); onChange(); };
  const data = page.data;
  const total = data?.total ?? 0;
  const from = total === 0 ? 0 : offset + 1, to = Math.min(offset + limit, total);

  const run = async (label: string, fn: () => Promise<void>) => { setError(''); setBusy(label); try { await fn(); refresh(); } catch (e: any) { setError(e.message); } finally { setBusy(''); } };
  const addEmployee = (e: Employee) => run('add', async () => { await api(`/config/groups/${group.id}/members`, { method: 'POST', body: { employeeIds: [e.id] } }); setQuery(''); });
  const moveTeam = (id: string, team: string) => run('move', async () => { await api(`/workforce/employees/${id}`, { method: 'PUT', body: { teamId: team || null, reason: 'Moved to another team from the group People tab' } }); });
  const removeMember = async (reason: string) => {
    if (!removing) return;
    setBusy('remove'); setError('');
    try {
      const e = await api<Employee>(`/workforce/employees/${removing.id}`);
      await api(`/workforce/employees/${removing.id}`, { method: 'PUT', body: { eligibleGroupIds: e.eligibleGroupIds.filter((id) => id !== group.id), reason } });
      setRemoving(null); refresh();
    } catch (err: any) { setError(err.message); setRemoving(null); } finally { setBusy(''); }
  };
  const linkTeam = async (id: string) => {
    if (!id) return;
    setError(''); setBusy('link');
    try {
      const r = await api<{ added: number; alreadyIn: number }>(`/config/groups/${group.id}/members`, { method: 'POST', body: { teamIds: [id] } });
      setNote(`${r.added} ${r.added === 1 ? 'person' : 'people'} added${r.alreadyIn ? `, ${r.alreadyIn} already in this group` : ''}.`);
      setLinking(false); refresh();
    } catch (err: any) { setError(err.message); } finally { setBusy(''); }
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative flex-1 min-w-[200px] max-w-xs">
          <Search className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-[#6B6B6B]" />
          <Input aria-label="Search people" className="!pl-8" placeholder="Search by name or number" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <Select aria-label="Team" className="!w-auto" value={teamId} onChange={(e) => setTeamId(e.target.value)}>
          <option value="">All teams{data ? ` (${data.teams.reduce((n, t) => n + t.count, 0)})` : ''}</option>
          {(data?.teams ?? []).map((t) => <option key={t.id} value={t.id}>{t.name} ({t.count})</option>)}
        </Select>
        {canWrite && !adding && !linking && <div className="flex gap-2 ml-auto">
          <Btn onClick={() => setAdding(true)}><Plus className="w-3.5 h-3.5" />Add employee</Btn>
          <Btn onClick={() => setLinking(true)}><Plus className="w-3.5 h-3.5" />Link a team</Btn>
        </div>}
      </div>

      {canWrite && adding && (
        <div className="border border-[#E5E5E0] rounded-lg p-3 bg-[#FAFAF8] space-y-2">
          <Field label="Add an employee"><Input autoFocus value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search by name or number…" /></Field>
          {query.trim().length >= 2 && (
            <div className="border border-[#E5E5E0] rounded-md bg-white divide-y divide-[#E5E5E0] max-h-48 overflow-auto">
              {(found.data ?? []).filter((e) => !e.eligibleGroupIds.includes(group.id)).length === 0
                ? <div className="p-2 text-[12px] text-[#6B6B6B]">{found.loading ? 'Searching…' : (found.data ?? []).length > 0 ? 'Everyone matching that is already in this group.' : 'No match.'}</div>
                : (found.data ?? []).filter((e) => !e.eligibleGroupIds.includes(group.id)).map((e) => (
                  <button key={e.id} disabled={!!busy} className="w-full text-left p-2 text-[12px] hover:bg-[#F5F5F0] disabled:opacity-50" onClick={() => addEmployee(e)}>{e.name} <span className="text-[#6B6B6B]">{e.employeeNumber} · {e.teamName ?? 'no team'}</span></button>
                ))}
            </div>
          )}
          <Btn onClick={() => { setAdding(false); setQuery(''); }}>Done</Btn>
        </div>
      )}
      {canWrite && linking && (
        <div className="border border-[#E5E5E0] rounded-lg p-3 bg-[#FAFAF8] flex flex-wrap gap-2 items-start">
          <div className="flex-1 min-w-[220px] max-w-sm"><Field label="Link every active member of a team" hint="They keep their own primary group"><Select defaultValue="" disabled={!!busy} onChange={(e) => linkTeam(e.target.value)}><option value="" disabled>Choose a team</option>{teams.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</Select></Field></div>
          <div className="pt-[22px]"><Btn disabled={busy === 'link'} onClick={() => setLinking(false)}>Cancel</Btn></div>
        </div>
      )}
      {note && <Banner kind="ok" onClose={() => setNote('')}>{note}</Banner>}
      {error && <Banner kind="err" onClose={() => setError('')}>{error}</Banner>}

      {page.error ? <Banner kind="err">{page.error}</Banner> : data && total === 0 ? (
        <Empty title={search || teamId ? 'Nobody matches' : 'No one is linked to this group yet'}>{search || teamId ? 'Clear the search or the team filter.' : canWrite ? 'Use "Add employee" or "Link a team".' : ''}</Empty>
      ) : (
        <Table head={['Name', 'Number', 'Team', 'Type', '']} right={[4]}>
          {(data?.items ?? []).map((m) => (
            <tr key={m.id}>
              <td className="p-2.5 font-medium">{m.name}{m.primary && <span className="ml-2"><Pill tone="info" title="This is their main group">Primary</Pill></span>}</td>
              <td className="p-2.5 font-mono text-[12px] text-[#525252]">{m.employeeNumber}</td>
              <td className="p-2.5">{canWrite
                ? <Select aria-label={`Team for ${m.name}`} className="!w-auto" value={m.teamId ?? ''} disabled={!!busy} onChange={(e) => moveTeam(m.id, e.target.value)}><option value="">No team</option>{teams.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</Select>
                : <span className="text-[#525252]">{m.teamName ?? 'No team'}</span>}</td>
              <td className="p-2.5 text-[#525252]">{TYPE_LABEL[m.employmentType] ?? m.employmentType}</td>
              <td className="p-2.5 text-right">{canWrite && <button aria-label={`Remove ${m.name}`} title={m.primary ? 'Their primary group: change it on their profile' : 'Remove from this group'} disabled={m.primary} className="text-[#6B6B6B] hover:text-[#BC3F3F] disabled:opacity-30 disabled:hover:text-[#6B6B6B]" onClick={() => setRemoving(m)}><Trash2 className="w-4 h-4" /></button>}</td>
            </tr>
          ))}
        </Table>
      )}

      {total > 0 && (
        <div className="flex flex-wrap items-center justify-between gap-2 text-[12px] text-[#6B6B6B]">
          <span>Showing {from}–{to} of {total.toLocaleString()}</span>
          <div className="flex items-center gap-2">
            <Select aria-label="Rows per page" className="!w-auto" value={limit} onChange={(e) => setLimit(Number(e.target.value))}>{[25, 50, 100].map((n) => <option key={n} value={n}>{n} per page</option>)}</Select>
            <Btn aria-label="Previous page" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - limit))}><ChevronLeft className="w-3.5 h-3.5" /></Btn>
            <Btn aria-label="Next page" disabled={offset + limit >= total} onClick={() => setOffset(offset + limit)}><ChevronRight className="w-3.5 h-3.5" /></Btn>
          </div>
        </div>
      )}

      {removing && (
        <Confirm title={`Remove ${removing.name}?`} confirmLabel="Remove from group" danger reason busy={busy === 'remove'} onConfirm={removeMember} onCancel={() => setRemoving(null)}>
          <p>{removing.name} stays an employee and keeps their primary group. They will no longer be offered shifts or counted in {group.name}.</p>
        </Confirm>
      )}
    </div>
  );
};
