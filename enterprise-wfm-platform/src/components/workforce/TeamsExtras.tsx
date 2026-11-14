/**
 * Workforce > Teams: the parts that keep supervisor routing from silently breaking.
 *   - LeadSetup: a warning when teams have no lead ("3 teams have no lead. Assign"), with a people picker on each, so a lead is one pick and one click away.
 *   - SpreadNotice: when almost everyone is in one team (a team that holds everyone supervises no one in particular).
 *   - RowMenu: the less common and the dangerous actions behind a "more" button, so Delete is never one slip away from Edit.
 *   - DeleteTeamDialog: names who is in the team. A team with people cannot be deleted (the server refuses), so the dialog offers to move them to another team first.
 */
import React, { useEffect, useRef, useState } from 'react';
import { MoreHorizontal } from 'lucide-react';
import { api, apiPage, Employee, Team } from '../../services/api';
import { PersonPicker } from '../common/PersonPicker';
import { Banner, Btn, Select } from '../forecasting/ui';
import { Confirm } from '../configuration/groups/shared';

const plural = (n: number, one: string, many = one + 's') => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;

/** The teams that need a lead: active ones with none. (An inactive team is not routed to.) */
export const withoutLead = (teams: Team[]) => teams.filter((t) => t.status === 'ACTIVE' && !t.managerId);

/** Whether one team holds nearly everyone who is in a team at all: returns it and the counts, else null. */
export function spreadProblem(teams: Team[]): { team: Team; inIt: number; total: number } | null {
  const total = teams.reduce((n, t) => n + t.memberCount, 0);
  if (teams.length < 2 || total < 20) return null;
  const top = teams.reduce((m, t) => (t.memberCount > m.memberCount ? t : m));
  return top.memberCount / total >= 0.9 ? { team: top, inIt: top.memberCount, total } : null;
}

const saveLead = (t: Team, managerId: string) => api(`/workforce/teams/${t.id}`, { method: 'PUT', body: { name: t.name, description: t.description, location: t.location, managerId, deputyId: t.deputyId ?? null } });

export const LeadSetup: React.FC<{ teams: Team[]; canWrite: boolean; open: boolean; setOpen: (o: boolean) => void; onDone: () => void; autoFocusId?: string | null }> = ({ teams, canWrite, open, setOpen, onDone, autoFocusId }) => {
  const missing = withoutLead(teams);
  const [pick, setPick] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState('');
  const first = useRef<HTMLDivElement>(null);
  useEffect(() => { if (open) first.current?.scrollIntoView({ block: 'nearest' }); }, [open, autoFocusId]);
  if (missing.length === 0) return null;
  const assign = async (t: Team) => {
    setBusy(t.id); setError('');
    try { await saveLead(t, pick[t.id]); setPick((p) => { const { [t.id]: _gone, ...rest } = p; return rest; }); onDone(); } catch (e: any) { setError(e.message); } finally { setBusy(null); }
  };
  return (
    <div ref={first} className="rounded-lg border border-[#B7791F]/30 bg-[#FFF5DD] p-3.5 space-y-3" role="region" aria-label="Teams without a lead">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <div className="text-[13px] font-semibold text-[#171717]">{plural(missing.length, 'team has', 'teams have')} no lead.</div>
          <div className="text-[12px] text-[#525252]">Alerts, approvals and “my team” views go to a team’s lead. Until one is set, nobody is routed to for {missing.length === 1 ? 'this team' : 'these teams'}.</div>
        </div>
        {canWrite && <Btn variant={open ? undefined : 'primary'} onClick={() => setOpen(!open)}>{open ? 'Hide' : 'Assign leads'}</Btn>}
      </div>
      {open && canWrite && (
        <div className="space-y-2">
          {error && <Banner kind="err" onClose={() => setError('')}>{error}</Banner>}
          {missing.map((t) => (
            <div key={t.id} className={`grid grid-cols-1 md:grid-cols-[minmax(0,1fr)_minmax(0,18rem)_auto] items-center gap-2 rounded-md bg-white border p-2.5 ${autoFocusId === t.id ? 'border-[#171717]' : 'border-[#E5E5E0]'}`}>
              <div className="min-w-0"><div className="font-semibold truncate">{t.name}</div><div className="text-[11px] text-[#6B6B6B]">{plural(t.memberCount, 'person', 'people')}</div></div>
              <PersonPicker ariaLabel={`Team lead for ${t.name}`} value={pick[t.id] ?? ''} statuses="ONBOARDING,ACTIVE,LEAVE" only="supervisor" placeholder="Choose the team lead" onChange={(id) => setPick((p) => ({ ...p, [t.id]: id }))} />
              <Btn variant="primary" disabled={!pick[t.id] || busy === t.id} onClick={() => assign(t)}>{busy === t.id ? 'Saving…' : 'Assign'}</Btn>
            </div>
          ))}
          <div className="text-[11px] text-[#525252]">Only people marked as a supervisor are offered; the picker can show everyone and will offer to mark the person you choose.</div>
        </div>
      )}
    </div>
  );
};

export const SpreadNotice: React.FC<{ teams: Team[] }> = ({ teams }) => {
  const p = spreadProblem(teams);
  if (!p) return null;
  return (
    <Banner kind="info">{p.inIt.toLocaleString('en-US')} of the {p.total.toLocaleString('en-US')} people who are in a team are in “{p.team.name}”. A team that holds nearly everyone cannot be supervised as a team. To spread them, select people under Employees and use “Assign team”.</Banner>
  );
};

/** A "more actions" button with a small menu: closes on a click elsewhere or Escape. */
export const RowMenu: React.FC<{ label: string; items: { label: string; onClick: () => void; danger?: boolean }[] }> = ({ label, items }) => {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => { if (!box.current?.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', away); document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('mousedown', away); document.removeEventListener('keydown', esc); };
  }, [open]);
  if (!items.length) return null;
  return (
    <div ref={box} className="relative inline-block text-left">
      <button type="button" aria-label={label} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((o) => !o)} className="p-1.5 rounded text-[#6B6B6B] hover:bg-[#F5F5F2] hover:text-[#171717]"><MoreHorizontal className="w-4 h-4" aria-hidden="true" /></button>
      {open && (
        <div role="menu" aria-label={label} className="absolute right-0 z-30 mt-1 min-w-[12rem] rounded-lg border border-[#E5E5E0] bg-white py-1 shadow-lg">
          {items.map((i) => (
            <button key={i.label} role="menuitem" onClick={() => { setOpen(false); i.onClick(); }} className={`block w-full text-left px-3 py-2 text-[13px] hover:bg-[#FAFAF8] ${i.danger ? 'text-[#BC3F3F]' : 'text-[#171717]'}`}>{i.label}</button>
          ))}
        </div>
      )}
    </div>
  );
};

/** Deleting a team names who is in it. A team that still has people cannot be deleted, so they can be moved to another team in the same step. */
export const DeleteTeamDialog: React.FC<{ team: Team; others: Team[]; onCancel: () => void; onDeleted: (text: string) => void }> = ({ team, others, onCancel, onDeleted }) => {
  const [who, setWho] = useState<{ names: string[]; total: number } | null>(null);
  const [target, setTarget] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    let live = true;
    apiPage<Employee>(`/workforce/employees?teamId=${team.id}&limit=8`).then((r) => live && setWho({ names: r.rows.map((e) => e.name), total: r.total })).catch((e: any) => live && setError(e.message));
    return () => { live = false; };
  }, [team.id]);
  const total = who?.total ?? team.memberCount;
  const choices = others.filter((t) => t.id !== team.id && t.status === 'ACTIVE');
  const go = async (reason: string) => {
    setBusy(true); setError('');
    try {
      if (total > 0) {
        const ids = await api<{ id: string }[]>(`/workforce/employees?fields=ids&teamId=${team.id}`);
        for (let i = 0; i < ids.length; i += 500) await api('/workforce/employees/bulk', { method: 'POST', timeoutMs: 120_000, body: { ids: ids.slice(i, i + 500).map((x) => x.id), changes: { teamId: target }, reason } });
      }
      await api(`/workforce/teams/${team.id}`, { method: 'DELETE' });
      onDeleted(total > 0 ? `Team “${team.name}” deleted and ${plural(total, 'person', 'people')} moved to “${choices.find((c) => c.id === target)?.name}”.` : `Team “${team.name}” deleted.`);
    } catch (e: any) { setError(e.message); setBusy(false); }
  };
  return (
    <Confirm title={`Delete the team “${team.name}”?`} danger reason busy={busy} disabled={!who || (total > 0 && !target)} error={error} confirmLabel={total > 0 ? `Move ${plural(total, 'person', 'people')} and delete` : 'Delete team'} onCancel={onCancel} onConfirm={go}>
      {!who ? <p>Checking who is in it…</p> : total === 0 ? <p>Nobody is in this team. It will be removed; the history keeps a record.</p> : (
        <>
          <p><b>{plural(total, 'person is', 'people are')}</b> in this team: {who.names.join(', ')}{total > who.names.length ? ` and ${(total - who.names.length).toLocaleString('en-US')} more` : ''}. A team that still has people cannot be deleted, so they are moved first. Nobody is deleted.</p>
          {choices.length === 0 ? <Banner kind="warn">There is no other active team to move them to. Create one first.</Banner> : (
            <label className="block text-[12px] font-semibold text-[#171717]">Move them to
              <Select className="mt-1" value={target} onChange={(e) => setTarget(e.target.value)} aria-label="Move them to"><option value="">Choose a team…</option>{choices.map((t) => <option key={t.id} value={t.id}>{t.name}{t.managerName ? ` (lead ${t.managerName})` : ' (no lead)'}</option>)}</Select>
            </label>
          )}
          <p className="text-[12px]">Only their team changes; each person’s own reporting line is left as it is.</p>
        </>
      )}
    </Confirm>
  );
};
