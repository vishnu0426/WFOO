/**
 * Workforce › Teams › one team's people: who is in it, add people (search, tick, say why), take people out. Membership is each person's team, so adding someone who is in another team moves
 * them, and the list says so before it happens. Changes go through the bulk edit (up to 500 people at a time), which records who did it and why.
 */
import React, { useEffect, useMemo, useState } from 'react';
import { Search, UserMinus, UserPlus } from 'lucide-react';
import { api, Employee, Team } from '../../services/api';
import { useApi } from '../forecasting/hooks';
import { Banner, Btn, Input, Pill } from '../forecasting/ui';
import { Confirm } from '../configuration/groups/shared';

const STATUS_WORD: Record<string, string> = { ONBOARDING: 'Onboarding', LEAVE: 'On leave', SUSPENDED: 'Suspended', TERMINATED: 'Left' };
const plural = (n: number, one: string, many = one + 's') => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;

type BulkResult = { updated: number; skipped: { id: string; name: string; reason: string }[] };
/** Put these people in a team (teamId) or in none (null), with the reason on record. */
export const setTeam = (ids: string[], teamId: string | null, reason: string) =>
  api<BulkResult>('/workforce/employees/bulk', { method: 'POST', body: { ids, changes: { teamId }, reason } });

/** Search people to put in a team: two letters or more, nobody who is already in it, each row saying where they are now. */
export const PeopleFinder: React.FC<{ team: Team | null; chosen: Employee[]; onChange: (list: Employee[]) => void; inTeam?: Set<string> }> = ({ team, chosen, onChange, inTeam }) => {
  const [text, setText] = useState('');
  const [term, setTerm] = useState('');
  const [found, setFound] = useState<Employee[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => { const t = setTimeout(() => setTerm(text.trim()), 300); return () => clearTimeout(t); }, [text]);
  useEffect(() => {
    if (term.length < 2) { setFound([]); setError(''); return; }
    let live = true; setBusy(true);
    api<Employee[]>(`/workforce/employees?q=${encodeURIComponent(term)}&statuses=ONBOARDING,ACTIVE,LEAVE&limit=30`)
      .then((r) => { if (live) { setFound(r); setError(''); } }).catch((e: any) => { if (live) setError(e.message); }).finally(() => live && setBusy(false));
    return () => { live = false; };
  }, [term]);
  const picked = new Set(chosen.map((e) => e.id));
  const rows = found.filter((e) => !(inTeam?.has(e.id) ?? e.teamId === team?.id));
  const toggle = (e: Employee) => onChange(picked.has(e.id) ? chosen.filter((x) => x.id !== e.id) : [...chosen, e]);
  const moving = chosen.filter((e) => e.teamId && e.teamId !== team?.id);
  return (
    <div className="space-y-2">
      <div className="relative max-w-sm">
        <Search className="pointer-events-none absolute left-2.5 top-2.5 h-3.5 w-3.5 text-[#6B6B6B]" />
        <Input aria-label="Search people to add" className="!pl-8" placeholder="Search by name or number (two letters or more)" value={text} onChange={(e) => setText(e.target.value)} />
      </div>
      {error && <Banner kind="err">{error}</Banner>}
      {term.length >= 2 && (
        <div className="max-h-60 divide-y divide-[#E5E5E0] overflow-auto rounded-md border border-[#E5E5E0] bg-white">
          {busy && rows.length === 0 && <div className="p-2 text-[12px] text-[#6B6B6B]">Searching…</div>}
          {!busy && rows.length === 0 && <div className="p-2 text-[12px] text-[#6B6B6B]">No one new matches.</div>}
          {rows.map((e) => (
            <label key={e.id} className="flex cursor-pointer items-center gap-3 px-3 py-1.5 text-[13px] hover:bg-[#FAFAF8]">
              <input type="checkbox" checked={picked.has(e.id)} onChange={() => toggle(e)} aria-label={`Add ${e.name}`} />
              <span className="flex-1 truncate">{e.name} <span className="font-mono text-[11px] text-[#6B6B6B]">{e.employeeNumber}</span></span>
              <span className="text-[12px] text-[#6B6B6B]">{e.primaryGroupName ?? 'No group'}</span>
              <span className={`w-28 truncate text-right text-[12px] ${e.teamName ? 'text-[#8F6200]' : 'text-[#6B6B6B]'}`}>{e.teamName ? `in ${e.teamName}` : 'No team'}</span>
            </label>
          ))}
        </div>
      )}
      {chosen.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {chosen.map((e) => <span key={e.id} className="inline-flex items-center gap-1 rounded-full bg-[#F5F5F0] py-0.5 pl-2.5 pr-1.5 text-[12px]">{e.name}<button type="button" aria-label={`Remove ${e.name} from the list`} className="text-[#6B6B6B] hover:text-[#BC3F3F]" onClick={() => toggle(e)}>×</button></span>)}
        </div>
      )}
      {moving.length > 0 && <p className="text-[12px] text-[#8F6200]">{plural(moving.length, 'person is', 'people are')} in another team and will be moved out of their current team into this one.</p>}
    </div>
  );
};

export const TeamMembers: React.FC<{ team: Team; canWrite: boolean; onChanged: () => void; notify: (text: string) => void }> = ({ team, canWrite, onChanged, notify }) => {
  const [tick, setTick] = useState(0);
  const members = useApi<Employee[]>(`/workforce/employees?teamId=${team.id}&statuses=ONBOARDING,ACTIVE,LEAVE,SUSPENDED`, [team.id, tick]);
  const [filter, setFilter] = useState('');
  const [adding, setAdding] = useState(false);
  const [chosen, setChosen] = useState<Employee[]>([]);
  const [taking, setTaking] = useState<Employee[] | null>(null);          // people about to be taken out of the team
  const [ticked, setTicked] = useState<Set<string>>(new Set());
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const all = members.data ?? [];
  const shown = useMemo(() => { const q = filter.trim().toLowerCase(); return q ? all.filter((e) => `${e.name} ${e.employeeNumber}`.toLowerCase().includes(q)) : all; }, [all, filter]);
  const inTeam = useMemo(() => new Set(all.map((e) => e.id)), [all]);
  const done = (r: BulkResult, text: string) => {
    notify(r.skipped.length ? `${text} ${plural(r.skipped.length, 'person was', 'people were')} left as they were: ${r.skipped.slice(0, 3).map((s) => `${s.name} (${s.reason})`).join('; ')}.` : text);
    setTick((t) => t + 1); onChanged();
  };
  const add = async () => {
    setBusy(true); setError('');
    try { const r = await setTeam(chosen.map((e) => e.id), team.id, reason.trim()); setChosen([]); setReason(''); setAdding(false); done(r, `${plural(r.updated, 'person is', 'people are')} now in ${team.name}.`); }
    catch (e: any) { setError(e.message); } finally { setBusy(false); }
  };
  const take = async (why: string) => {
    if (!taking) return; setBusy(true); setError('');
    try { const r = await setTeam(taking.map((e) => e.id), null, why); setTaking(null); setTicked(new Set()); done(r, `${plural(r.updated, 'person is', 'people are')} no longer in ${team.name}.`); }
    catch (e: any) { setError(e.message); } finally { setBusy(false); }
  };
  const tickedPeople = all.filter((e) => ticked.has(e.id));
  return (
    <div className="space-y-3 rounded-lg border border-[#E5E5E0] bg-[#FAFAF8] p-4" data-testid="team-members">
      <div className="flex flex-wrap items-center gap-2">
        <div className="text-[13px] font-semibold">People in {team.name} <span className="font-normal text-[#6B6B6B]">· {all.length.toLocaleString('en-US')}</span></div>
        <div className="flex-1" />
        {all.length > 8 && <div className="w-56"><Input aria-label="Find in this team" placeholder="Find in this team" value={filter} onChange={(e) => setFilter(e.target.value)} /></div>}
        {canWrite && tickedPeople.length > 0 && <Btn onClick={() => { setError(''); setTaking(tickedPeople); }}><UserMinus className="h-3.5 w-3.5" />Take out {tickedPeople.length}</Btn>}
        {canWrite && !adding && <Btn variant="primary" onClick={() => { setAdding(true); setError(''); }}><UserPlus className="h-3.5 w-3.5" />Add people</Btn>}
      </div>

      {adding && (
        <div className="space-y-3 rounded-md border border-[#E5E5E0] bg-white p-3">
          <PeopleFinder team={team} chosen={chosen} onChange={setChosen} inTeam={inTeam} />
          <div className="flex flex-wrap items-center gap-2">
            <div className="w-72"><Input aria-label="Why" placeholder="Why (required), e.g. new hires" value={reason} onChange={(e) => setReason(e.target.value)} /></div>
            <Btn variant="primary" disabled={busy || chosen.length === 0 || reason.trim().length < 3} onClick={add}>{busy ? 'Adding…' : `Add ${chosen.length || ''} ${chosen.length === 1 ? 'person' : 'people'}`.replace('  ', ' ')}</Btn>
            <Btn onClick={() => { setAdding(false); setChosen([]); setReason(''); setError(''); }}>Cancel</Btn>
            {error && <span className="text-[12px] text-[#BC3F3F]">{error}</span>}
          </div>
        </div>
      )}

      {members.error && !members.data && <Banner kind="err">{members.error}</Banner>}
      {members.data && all.length === 0 && !adding && <p className="text-[13px] text-[#6B6B6B]">No one is in this team yet.{canWrite ? ' Use “Add people” to put people in it.' : ''}</p>}
      {all.length > 0 && (
        <div className="max-h-72 overflow-auto rounded-md border border-[#E5E5E0] bg-white">
          <table className="w-full text-[13px]">
            <thead className="sticky top-0 bg-[#FAFAF8] text-left text-[11px] uppercase tracking-wide text-[#6B6B6B]">
              <tr>{canWrite && <th className="w-8 p-2"><input type="checkbox" aria-label="Select everyone shown" checked={shown.length > 0 && shown.every((e) => ticked.has(e.id))} onChange={(e) => setTicked(e.target.checked ? new Set([...ticked, ...shown.map((x) => x.id)]) : new Set([...ticked].filter((id) => !shown.some((x) => x.id === id))))} /></th>}<th className="p-2">Name</th><th className="p-2">Number</th><th className="p-2">WFM group</th><th className="p-2">Type</th><th className="p-2">Status</th></tr>
            </thead>
            <tbody className="divide-y divide-[#E5E5E0]">
              {shown.map((e) => (
                <tr key={e.id}>
                  {canWrite && <td className="p-2"><input type="checkbox" aria-label={`Select ${e.name}`} checked={ticked.has(e.id)} onChange={() => setTicked((s) => { const n = new Set(s); if (n.has(e.id)) n.delete(e.id); else n.add(e.id); return n; })} /></td>}
                  <td className="p-2 font-medium">{e.name}{team.managerId === e.id && <span className="ml-2 text-[11px] font-normal text-[#6B6B6B]">lead</span>}{team.deputyId === e.id && <span className="ml-2 text-[11px] font-normal text-[#6B6B6B]">deputy</span>}</td>
                  <td className="p-2 font-mono text-[12px] text-[#6B6B6B]">{e.employeeNumber}</td>
                  <td className="p-2">{e.primaryGroupName ?? '–'}</td>
                  <td className="p-2 text-[#6B6B6B]">{e.employmentType === 'FULL_TIME' ? 'Full time' : 'Part time'}</td>
                  <td className="p-2">{e.status === 'ACTIVE' ? <span className="text-[#6B6B6B]">Active</span> : <Pill tone="warn">{STATUS_WORD[e.status] ?? e.status}</Pill>}</td>
                </tr>
              ))}
              {shown.length === 0 && <tr><td colSpan={6} className="p-3 text-[12px] text-[#6B6B6B]">No one matches “{filter}”.</td></tr>}
            </tbody>
          </table>
        </div>
      )}

      {taking && (
        <Confirm title={`Take ${plural(taking.length, 'person', 'people')} out of ${team.name}?`} confirmLabel="Take out" reason busy={busy} error={error} onCancel={() => setTaking(null)} onConfirm={(why) => void take(why)}>
          <p>{taking.slice(0, 4).map((e) => e.name).join(', ')}{taking.length > 4 ? ` and ${taking.length - 4} more` : ''} will have no team. Their shifts, group and other settings stay as they are.</p>
        </Confirm>
      )}
    </div>
  );
};
