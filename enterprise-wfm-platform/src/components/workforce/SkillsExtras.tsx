/**
 * Workforce > Skills: what a planner needs to see about coverage. Who holds each skill and how well (a level bar), a link to exactly those people, and a flag for skills too few
 * people can work (thin) or nobody can (none). Delete names who loses the skill and which groups lose a requirement.
 */
import React, { useEffect, useState } from 'react';
import { api, apiPage, Employee } from '../../services/api';
import { Banner, Pill } from '../forecasting/ui';
import { Confirm } from '../configuration/groups/shared';

export type SkillRow = {
  id: string; name: string; code: string; category: string; type: string; requiresCertification: boolean; holders: number;
  activeHolders?: number; levels?: number[]; requiredBy?: { groupId: string; groupName: string; minProficiency: number; qualified: number }[];
  risk?: { level: 'NONE' | 'THIN' | 'OK'; reason: string | null; requiredByGroups: number; fixGroupId?: string | null };
};

const LEVEL_FILL = ['#D9D6C8', '#B8C2A8', '#8FAE8B', '#4F8A6B', '#1F5E45'];

/** How the people who hold the skill are spread over levels 1 to 5, as one small bar (darker is more skilled). */
export const LevelBar: React.FC<{ levels: number[] | undefined; name: string }> = ({ levels, name }) => {
  const ls = levels ?? [0, 0, 0, 0, 0], total = ls.reduce((a, b) => a + b, 0);
  if (total === 0) return <span className="text-[#6B6B6B]">–</span>;
  const text = ls.map((n, i) => `Level ${i + 1}: ${n}`).join(' · ');
  return (
    <span className="inline-flex items-center gap-2" title={text}>
      <span role="img" aria-label={`${name} proficiency. ${text}`} className="flex h-2.5 w-28 overflow-hidden rounded-full bg-[#F0F0EC]">
        {ls.map((n, i) => n > 0 && <span key={i} style={{ width: `${(100 * n) / total}%`, background: LEVEL_FILL[i] }} />)}
      </span>
    </span>
  );
};

/** The number of people, as a link to exactly those people in Employees (active ones, who hold the skill). */
export const PeopleLink: React.FC<{ s: SkillRow }> = ({ s }) => {
  const n = s.activeHolders ?? s.holders;
  const href = `/workforce/employees?skill=${s.id}&status=ACTIVE`;
  if (n === 0) return <span className="font-mono">0</span>;
  return (
    <a href={href} className="font-mono underline underline-offset-2 hover:text-[#171717]" aria-label={`${n} ${n === 1 ? 'person' : 'people'} with ${s.name}: open them in Employees`} title="Open these people in Employees"
      onClick={(e) => { if (e.metaKey || e.ctrlKey || e.shiftKey) return; e.preventDefault(); history.pushState(null, '', href); window.dispatchEvent(new PopStateEvent('popstate')); }}>{n}</a>
  );
};

export const RiskFlag: React.FC<{ s: SkillRow }> = ({ s }) => {
  const r = s.risk;
  if (!r || r.level === 'OK') return null;
  const required = r.requiredByGroups > 0;
  return <span className="ml-2 align-middle"><Pill tone={r.level === 'NONE' ? (required ? 'bad' : 'warn') : 'warn'} title={r.reason ?? undefined}>{r.level === 'NONE' ? 'Nobody' : 'Thin'}</Pill><span className="sr-only"> {r.reason}</span></span>;
};

/** One line above the table: how many skills are at risk. */
export const CoverageSummary: React.FC<{ skills: SkillRow[]; thin: number }> = ({ skills, thin }) => {
  const none = skills.filter((s) => s.risk?.level === 'NONE'), few = skills.filter((s) => s.risk?.level === 'THIN');
  if (!none.length && !few.length) return null;
  const requiredNone = none.filter((s) => (s.risk?.requiredByGroups ?? 0) > 0);
  const parts = [
    requiredNone.length ? `${requiredNone.length} ${requiredNone.length === 1 ? 'skill that a group requires has' : 'skills that groups require have'} nobody qualified` : '',
    none.length - requiredNone.length ? `${none.length - requiredNone.length} ${none.length - requiredNone.length === 1 ? 'skill has' : 'skills have'} nobody (no group needs ${none.length - requiredNone.length === 1 ? 'it' : 'them'} yet)` : '',
    few.length ? `${few.length} ${few.length === 1 ? 'is' : 'are'} thin: fewer than ${thin} people` : '',
  ].filter(Boolean);
  return <Banner kind={requiredNone.length ? 'err' : 'warn'}>Coverage risk: {parts.join('; ')}. Anyone absent can leave a queue without the skill it needs.</Banner>;
};

/** Delete names who loses the skill and which groups lose a requirement. */
export const DeleteSkillDialog: React.FC<{ skill: SkillRow; onCancel: () => void; onDeleted: (text: string) => void }> = ({ skill, onCancel, onDeleted }) => {
  const [who, setWho] = useState<{ names: string[]; total: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    let live = true;
    apiPage<Employee>(`/workforce/employees?skillIds=${skill.id}&limit=8`).then((r) => live && setWho({ names: r.rows.map((e) => e.name), total: r.total })).catch((e: any) => live && setError(e.message));
    return () => { live = false; };
  }, [skill.id]);
  const total = who?.total ?? skill.holders;
  const go = async () => {
    setBusy(true); setError('');
    try { await api(`/workforce/skills/${skill.id}`, { method: 'DELETE' }); onDeleted(`Skill “${skill.name}” deleted${total ? ` and removed from ${total.toLocaleString('en-US')} ${total === 1 ? 'person' : 'people'}` : ''}.`); }
    catch (e: any) { setError(e.message); setBusy(false); }
  };
  return (
    <Confirm title={`Delete the skill “${skill.name}”?`} danger busy={busy} disabled={!who} error={error} confirmLabel="Delete skill" onCancel={onCancel} onConfirm={go}>
      {!who ? <p>Checking who has it…</p> : total === 0 ? <p>Nobody has this skill.</p> : <p>It will be removed from <b>{total.toLocaleString('en-US')} {total === 1 ? 'person' : 'people'}</b>: {who.names.join(', ')}{total > who.names.length ? ` and ${(total - who.names.length).toLocaleString('en-US')} more` : ''}.</p>}
      {(skill.requiredBy?.length ?? 0) > 0 && <Banner kind="warn">{skill.requiredBy!.length === 1 ? 'A WFM group requires' : `${skill.requiredBy!.length} WFM groups require`} this skill ({skill.requiredBy!.map((g) => g.groupName).join(', ')}). That requirement is removed too, so those queues will no longer be matched to it.</Banner>}
      <p className="text-[12px]">This cannot be undone; the history keeps a record.</p>
    </Confirm>
  );
};

type Fix = {
  skill: { id: string; name: string }; group: { id: string; name: string; minProficiency: number };
  addToGroup: { total: number; people: { id: string; name: string; level: number; homeGroup: string | null }[] };
  giveSkill: { total: number; people: { id: string; name: string; level: number | null }[] };
};

const PickList: React.FC<{ rows: { id: string; label: string; note: string }[]; set: Set<string>; put: (s: Set<string>) => void; label: string }> = ({ rows, set, put, label }) => (
  <ul aria-label={label} className="max-h-40 overflow-y-auto divide-y divide-[#F0F0EC] rounded-md border border-[#E5E5E0]">
    {rows.map((r) => (
      <li key={r.id}>
        <label className="flex items-center gap-2 px-2.5 py-1.5 text-[13px] cursor-pointer hover:bg-[#FAFAF8]">
          <input type="checkbox" checked={set.has(r.id)} onChange={() => { const n = new Set(set); if (n.has(r.id)) n.delete(r.id); else n.add(r.id); put(n); }} />
          <span className="flex-1 truncate">{r.label}</span><span className="text-[11px] text-[#6B6B6B] shrink-0">{r.note}</span>
        </label>
      </li>
    ))}
  </ul>
);

/**
 * Fix a shortfall of a skill a WFM group requires, in the two ways there are: people who already have it at the level asked for but are not eligible for the group can be added to it;
 * people in the group who lack it (or have it below the level) can be given it. Each is a list to tick, a reason, and one button.
 */
export const FixSkillDialog: React.FC<{ skill: SkillRow; onClose: () => void; onChanged: () => void }> = ({ skill, onClose, onChanged }) => {
  const groupId = skill.risk?.fixGroupId ?? '';
  const [fix, setFix] = useState<Fix | null>(null);
  const [add, setAdd] = useState<Set<string>>(new Set());
  const [give, setGive] = useState<Set<string>>(new Set());
  const [level, setLevel] = useState(3);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [done, setDone] = useState<string[]>([]);
  const load = () => api<Fix>(`/workforce/skills/${skill.id}/fix?groupId=${groupId}`).then((f) => { setFix(f); setAdd(new Set(f.addToGroup.people.map((p) => p.id))); setGive(new Set()); setLevel(f.group.minProficiency); }).catch((e: any) => setError(e.message));
  useEffect(() => { void load(); }, [skill.id, groupId]);   // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { const k = (e: KeyboardEvent) => e.key === 'Escape' && onClose(); window.addEventListener('keydown', k); return () => window.removeEventListener('keydown', k); }, [onClose]);
  const ok = reason.trim().length >= 3;
  const run = async (kind: 'add' | 'give') => {
    if (!fix) return;
    setBusy(kind); setError('');
    try {
      if (kind === 'add') {
        const r = await api<{ updated: number }>(`/workforce/skills/${skill.id}/add-to-group`, { method: 'POST', body: { groupId, employeeIds: [...add], reason: reason.trim() } });
        setDone((d) => [...d, `${r.updated} ${r.updated === 1 ? 'person' : 'people'} can now be scheduled in ${fix.group.name}.`]);
      } else {
        await api('/workforce/employees/bulk', { method: 'POST', timeoutMs: 120_000, body: { ids: [...give], changes: {}, skills: { add: [{ skillId: skill.id, proficiency: level }], remove: [] }, reason: reason.trim() } });
        setDone((d) => [...d, `${give.size} ${give.size === 1 ? 'person was' : 'people were'} given ${skill.name} at level ${level}.`]);
      }
      onChanged();
      await load();
    } catch (e: any) { setError(e.message); } finally { setBusy(''); }
  };
  const btn = 'px-3 py-1.5 rounded bg-[#171717] text-white text-[12px] font-semibold disabled:opacity-50';
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4" role="dialog" aria-modal="true" aria-label={`Fix coverage of ${skill.name}`} onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="w-full max-w-xl max-h-[90vh] overflow-y-auto rounded-lg border border-[#E5E5E0] bg-white p-5 shadow-lg space-y-4 text-[13px] text-[#525252]">
        <div>
          <h3 className="text-[15px] font-semibold text-[#171717]">Fix coverage of {skill.name}{fix ? ` in ${fix.group.name}` : ''}</h3>
          {skill.risk?.reason && <p className="mt-1">{skill.risk.reason}.</p>}
        </div>
        {!fix && !error && <p>Looking for people…</p>}
        {error && <Banner kind="err" onClose={() => setError('')}>{error}</Banner>}
        {done.map((d, i) => <Banner key={i} kind="ok">{d}</Banner>)}
        {fix && (
          <>
            <section className="space-y-2">
              <h4 className="text-[13px] font-semibold text-[#171717]">1. People who already have it, but cannot be scheduled in {fix.group.name}</h4>
              {fix.addToGroup.total === 0 ? <p>Nobody outside {fix.group.name} has it at level {fix.group.minProficiency} or higher.</p> : (
                <>
                  <p>They have {skill.name} at level {fix.group.minProficiency} or higher but are not on the list of {fix.group.name}. Adding them lets the scheduler use them there; their own group stays as it is.</p>
                  <PickList label="People who can be added" rows={fix.addToGroup.people.map((p) => ({ id: p.id, label: p.name, note: `level ${p.level}${p.homeGroup ? ` · ${p.homeGroup}` : ''}` }))} set={add} put={setAdd} />
                  {fix.addToGroup.total > fix.addToGroup.people.length && <p className="text-[12px]">Showing {fix.addToGroup.people.length} of {fix.addToGroup.total.toLocaleString('en-US')}.</p>}
                  <button className={btn} disabled={!ok || add.size === 0 || !!busy} onClick={() => run('add')}>{busy === 'add' ? 'Adding…' : `Add ${add.size} ${add.size === 1 ? 'person' : 'people'} to ${fix.group.name}`}</button>
                </>
              )}
            </section>
            <section className="space-y-2">
              <h4 className="text-[13px] font-semibold text-[#171717]">2. People in {fix.group.name} who do not have it at level {fix.group.minProficiency}</h4>
              {fix.giveSkill.total === 0 ? <p>Everyone in {fix.group.name} already has it at level {fix.group.minProficiency} or higher.</p> : (
                <>
                  <p>Tick the people who can do it. They are given {skill.name} at the level below (a level they already have is raised to it).</p>
                  <PickList label="People who could be given the skill" rows={fix.giveSkill.people.map((p) => ({ id: p.id, label: p.name, note: p.level ? `has level ${p.level}` : 'does not have it' }))} set={give} put={setGive} />
                  {fix.giveSkill.total > fix.giveSkill.people.length && <p className="text-[12px]">Showing {fix.giveSkill.people.length} of {fix.giveSkill.total.toLocaleString('en-US')}.</p>}
                  <div className="flex flex-wrap items-center gap-3">
                    <label className="flex items-center gap-2">Level<select aria-label="Level to give" value={level} onChange={(e) => setLevel(Number(e.target.value))} className="rounded border border-[#E5E5E0] px-1.5 py-1">{[1, 2, 3, 4, 5].filter((l) => l >= fix.group.minProficiency).map((l) => <option key={l} value={l}>{l}</option>)}</select></label>
                    <button className={btn} disabled={!ok || give.size === 0 || !!busy} onClick={() => run('give')}>{busy === 'give' ? 'Saving…' : `Give ${skill.name} to ${give.size} ${give.size === 1 ? 'person' : 'people'}`}</button>
                  </div>
                </>
              )}
            </section>
            <label className="block text-[12px] font-semibold text-[#171717]">Why?
              <textarea className="mt-1 w-full h-16 rounded-md border border-[#E5E5E0] p-2 text-[13px] font-normal" aria-label="Reason" placeholder="Recorded in the history with your name" value={reason} onChange={(e) => setReason(e.target.value)} />
            </label>
          </>
        )}
        <div className="flex justify-end"><button className="px-3 py-1.5 rounded border border-[#E5E5E0] text-[12px] font-semibold hover:bg-[#FAFAF8]" onClick={onClose}>Done</button></div>
      </div>
    </div>
  );
};
