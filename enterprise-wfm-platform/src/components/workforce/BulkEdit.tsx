/**
 * Workforce › Employees › edit several people at once. Tick "Change" next to each thing to set it on everyone selected; anything not ticked is left
 * exactly as it is. Groups and skills can be added or removed without touching the rest of what each person has. A reason is required and is
 * kept in the audit trail for every person changed.
 */
import React, { useState } from 'react';
import { api, Employee, EMP_STATUS_LABEL, EmploymentType, EmployeeStatus, ShiftConsistency, ShiftTemplate, Skill, Team, TYPE_LABEL } from '../../services/api';
import { Banner, Btn, Busy, Card, Input, Select } from '../forecasting/ui';

type Result = { updated: number; skipped: { id: string; name: string; reason: string }[] };
const slotOfTime = (t: string) => { const m = /^(\d{1,2}):(\d{2})$/.exec(t.trim()); return m ? Math.min(95, Math.floor((+m[1] * 60 + +m[2]) / 15)) : null; };

/** One thing that can be changed: a checkbox to opt in, then the control. */
const Row: React.FC<{ on: boolean; toggle: () => void; label: string; hint?: string; children: React.ReactNode }> = ({ on, toggle, label, hint, children }) => (
  <div className={`rounded-md border p-2.5 ${on ? 'border-[#171717] bg-white' : 'border-[#E5E5E0] bg-[#FAFAF8]'}`}>
    <label className="flex items-center gap-2 text-[12px] font-semibold cursor-pointer"><input type="checkbox" checked={on} onChange={toggle} />Change {label.toLowerCase()}</label>
    {hint && <div className="text-[11px] text-[#737373] ml-6">{hint}</div>}
    <div className={`mt-1.5 ${on ? '' : 'opacity-40 pointer-events-none'}`}>{children}</div>
  </div>
);

export const BulkEdit: React.FC<{
  people: Employee[]; groups: { id: string; name: string }[]; teams: Team[]; skills: Skill[]; templates: ShiftTemplate[];
  onDone: (text: string) => void; onCancel: () => void;
}> = ({ people, groups, teams, skills, templates, onDone, onCancel }) => {
  const [on, setOn] = useState<Record<string, boolean>>({});
  const flip = (k: string) => setOn((s) => ({ ...s, [k]: !s[k] }));
  const [v, setV] = useState({
    teamId: '', primaryGroupId: '', status: 'ACTIVE' as EmployeeStatus, employmentType: 'FULL_TIME' as EmploymentType, weeklyContractHours: 40, maxWeeklyHours: 40, workDaysPerWeek: 5, minRestHours: 11, maxConsecutiveDays: 6,
    allowWeekend: true, allowOvernight: false, nightShiftConsent: false, preferredTemplateId: '', shiftConsistency: 'DEFAULT' as ShiftConsistency, fixedStart: '',
  });
  const set = <K extends keyof typeof v>(k: K, x: (typeof v)[K]) => setV((s) => ({ ...s, [k]: x }));
  const num = (k: 'weeklyContractHours' | 'maxWeeklyHours' | 'workDaysPerWeek' | 'minRestHours' | 'maxConsecutiveDays') => (e: React.ChangeEvent<HTMLInputElement>) => set(k, Number(e.target.value));
  const [addGroups, setAddGroups] = useState<string[]>([]);
  const [removeGroups, setRemoveGroups] = useState<string[]>([]);
  const [addSkills, setAddSkills] = useState<Record<string, number>>({});
  const [removeSkills, setRemoveSkills] = useState<string[]>([]);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState<Result | null>(null);

  const toggleIn = (list: string[], set: (x: string[]) => void, id: string) => set(list.includes(id) ? list.filter((x) => x !== id) : [...list, id]);
  const activeSkills = skills.filter((s) => s.status === 'ACTIVE');

  const changes: Record<string, unknown> = {};
  if (on.team) changes.teamId = v.teamId || null;
  if (on.primaryGroup) changes.primaryGroupId = v.primaryGroupId || null;
  if (on.status) changes.status = v.status;
  if (on.type) changes.employmentType = v.employmentType;
  if (on.contract) changes.weeklyContractHours = v.weeklyContractHours;
  if (on.maxHours) changes.maxWeeklyHours = v.maxWeeklyHours;
  if (on.days) changes.workDaysPerWeek = v.workDaysPerWeek;
  if (on.rest) changes.minRestHours = v.minRestHours;
  if (on.run) changes.maxConsecutiveDays = v.maxConsecutiveDays;
  if (on.weekend) changes.allowWeekend = v.allowWeekend;
  if (on.overnight) changes.allowOvernight = v.allowOvernight;
  if (on.consent) changes.nightShiftConsent = v.nightShiftConsent;
  if (on.template) changes.preferredTemplateId = v.preferredTemplateId || null;
  if (on.consistency) changes.shiftConsistency = v.shiftConsistency;
  if (on.fixedStart) changes.fixedStartSlot = slotOfTime(v.fixedStart);
  const eligibleGroups = on.addGroups || on.removeGroups ? { add: on.addGroups ? addGroups : [], remove: on.removeGroups ? removeGroups : [] } : undefined;
  const skillChange = on.addSkills || on.removeSkills ? { add: on.addSkills ? Object.entries(addSkills).map(([skillId, proficiency]) => ({ skillId, proficiency })) : [], remove: on.removeSkills ? removeSkills : [] } : undefined;
  const anything = Object.keys(changes).length > 0 || (eligibleGroups && (eligibleGroups.add.length || eligibleGroups.remove.length)) || (skillChange && (skillChange.add.length || skillChange.remove.length));
  const count = Object.keys(changes).length + (eligibleGroups ? 1 : 0) + (skillChange ? 1 : 0);

  const apply = async () => {
    setBusy(true); setError(''); setResult(null);
    try {
      const r = await api<Result>('/workforce/employees/bulk', { method: 'POST', body: { ids: people.map((p) => p.id), changes, ...(eligibleGroups ? { eligibleGroups } : {}), ...(skillChange ? { skills: skillChange } : {}), reason: reason.trim() } });
      setResult(r);
      if (r.updated > 0 && r.skipped.length === 0) onDone(`${r.updated} ${r.updated === 1 ? 'person' : 'people'} updated.`);
    } catch (e: any) { setError(e.message); } finally { setBusy(false); }
  };

  return (
    <Card title={`Edit ${people.length} ${people.length === 1 ? 'person' : 'people'} at once`}
      sub={`${people.slice(0, 4).map((p) => p.name).join(', ')}${people.length > 4 ? ` and ${people.length - 4} more` : ''}. Tick what to change; everything else stays as it is.`}
      actions={<Btn onClick={onCancel}>Cancel</Btn>}>
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
        <Row on={!!on.team} toggle={() => flip('team')} label="Team"><Select value={v.teamId} onChange={(e) => set('teamId', e.target.value)}><option value="">No team</option>{teams.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</Select></Row>
        <Row on={!!on.primaryGroup} toggle={() => flip('primaryGroup')} label="Main WFM group" hint="Keeps the other groups they can cover"><Select value={v.primaryGroupId} onChange={(e) => set('primaryGroupId', e.target.value)}><option value="">None</option>{groups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}</Select></Row>
        <Row on={!!on.status} toggle={() => flip('status')} label="Status"><Select value={v.status} onChange={(e) => set('status', e.target.value as EmployeeStatus)}>{Object.entries(EMP_STATUS_LABEL).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</Select></Row>
        <Row on={!!on.type} toggle={() => flip('type')} label="Employment type"><Select value={v.employmentType} onChange={(e) => set('employmentType', e.target.value as EmploymentType)}>{Object.entries(TYPE_LABEL).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</Select></Row>
        <Row on={!!on.contract} toggle={() => flip('contract')} label="Contract hours / week"><Input type="number" min={0} max={80} value={v.weeklyContractHours} onChange={num('weeklyContractHours')} /></Row>
        <Row on={!!on.maxHours} toggle={() => flip('maxHours')} label="Maximum hours / week"><Input type="number" min={1} max={84} value={v.maxWeeklyHours} onChange={num('maxWeeklyHours')} /></Row>
        <Row on={!!on.days} toggle={() => flip('days')} label="Days per week (max)"><Input type="number" min={1} max={7} value={v.workDaysPerWeek} onChange={num('workDaysPerWeek')} /></Row>
        <Row on={!!on.rest} toggle={() => flip('rest')} label="Rest between shifts (h)"><Input type="number" min={0} max={24} step={0.5} value={v.minRestHours} onChange={num('minRestHours')} /></Row>
        <Row on={!!on.run} toggle={() => flip('run')} label="Days in a row (max)"><Input type="number" min={1} max={14} value={v.maxConsecutiveDays} onChange={num('maxConsecutiveDays')} /></Row>
        <Row on={!!on.weekend} toggle={() => flip('weekend')} label="Weekends"><Select value={v.allowWeekend ? 'y' : 'n'} onChange={(e) => set('allowWeekend', e.target.value === 'y')}><option value="y">Can work weekends</option><option value="n">Weekdays only</option></Select></Row>
        <Row on={!!on.overnight} toggle={() => flip('overnight')} label="Overnight shifts"><Select value={v.allowOvernight ? 'y' : 'n'} onChange={(e) => set('allowOvernight', e.target.value === 'y')}><option value="n">No</option><option value="y">Allowed</option></Select></Row>
        <Row on={!!on.consent} toggle={() => flip('consent')} label="Night work consent"><Select value={v.nightShiftConsent ? 'y' : 'n'} onChange={(e) => set('nightShiftConsent', e.target.value === 'y')}><option value="n">Not given</option><option value="y">Consented</option></Select></Row>
        <Row on={!!on.consistency} toggle={() => flip('consistency')} label="Same start and end time" hint="Overrides the company setting for these people">
          <Select value={v.shiftConsistency} onChange={(e) => set('shiftConsistency', e.target.value as ShiftConsistency)}>
            <option value="DEFAULT">Follow the company setting</option><option value="REQUIRE">Required</option><option value="PREFER">Preferred</option><option value="OFF">May vary day to day</option>
          </Select>
        </Row>
        <Row on={!!on.fixedStart} toggle={() => flip('fixedStart')} label="Assigned start time" hint="Leave the time empty to clear it"><Input type="time" step={900} value={v.fixedStart} onChange={(e) => set('fixedStart', e.target.value)} /></Row>
        <Row on={!!on.template} toggle={() => flip('template')} label="Preferred shift template"><Select value={v.preferredTemplateId} onChange={(e) => set('preferredTemplateId', e.target.value)}><option value="">None</option>{templates.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</Select></Row>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
        <Row on={!!on.addGroups} toggle={() => flip('addGroups')} label="Add WFM groups they can also cover" hint="Their other groups stay">
          <div className="flex flex-wrap gap-3 text-[13px]">{groups.map((g) => <label key={g.id} className="flex items-center gap-1.5"><input type="checkbox" checked={addGroups.includes(g.id)} onChange={() => toggleIn(addGroups, setAddGroups, g.id)} />{g.name}</label>)}</div>
        </Row>
        <Row on={!!on.removeGroups} toggle={() => flip('removeGroups')} label="Remove WFM groups they can cover" hint="A person is always eligible for their main group">
          <div className="flex flex-wrap gap-3 text-[13px]">{groups.map((g) => <label key={g.id} className="flex items-center gap-1.5"><input type="checkbox" checked={removeGroups.includes(g.id)} onChange={() => toggleIn(removeGroups, setRemoveGroups, g.id)} />{g.name}</label>)}</div>
        </Row>
        <Row on={!!on.addSkills} toggle={() => flip('addSkills')} label="Add skills" hint="Sets the level if they already have it">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5">
            {activeSkills.map((s) => (
              <div key={s.id} className="flex items-center gap-2 text-[13px]">
                <input type="checkbox" checked={s.id in addSkills} onChange={(e) => { const next = { ...addSkills }; if (e.target.checked) next[s.id] = 3; else delete next[s.id]; setAddSkills(next); }} />
                <span className="flex-1">{s.name}</span>
                <select disabled={!(s.id in addSkills)} value={addSkills[s.id] ?? 3} onChange={(e) => setAddSkills({ ...addSkills, [s.id]: Number(e.target.value) })} className="border border-[#E5E5E0] rounded p-1 text-[12px] disabled:opacity-40">{[1, 2, 3, 4, 5].map((n) => <option key={n}>{n}</option>)}</select>
              </div>
            ))}
            {activeSkills.length === 0 && <span className="text-[12px] text-[#737373]">No skills defined yet.</span>}
          </div>
        </Row>
        <Row on={!!on.removeSkills} toggle={() => flip('removeSkills')} label="Remove skills">
          <div className="flex flex-wrap gap-3 text-[13px]">{activeSkills.map((s) => <label key={s.id} className="flex items-center gap-1.5"><input type="checkbox" checked={removeSkills.includes(s.id)} onChange={() => toggleIn(removeSkills, setRemoveSkills, s.id)} />{s.name}</label>)}</div>
        </Row>
      </div>

      <div className="flex flex-wrap items-end gap-3">
        <label className="text-[12px] font-semibold flex-1 min-w-[260px]">Why are you changing these people?<Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="For example: moved to the night team" className="mt-1" /></label>
        <Btn variant="primary" disabled={busy || !anything || reason.trim().length < 3} onClick={apply}>Apply {count || ''} {count === 1 ? 'change' : 'changes'} to {people.length} {people.length === 1 ? 'person' : 'people'}</Btn>
        {busy && <Busy text="Saving…" />}
      </div>
      {error && <Banner kind="err" onClose={() => setError('')}>{error}</Banner>}
      {result && (
        <Banner kind={result.skipped.length ? 'warn' : 'ok'}>
          {result.updated} updated{result.skipped.length ? `, ${result.skipped.length} skipped:` : '.'}
          {result.skipped.length > 0 && <ul className="list-disc ml-5 mt-1">{result.skipped.slice(0, 8).map((s) => <li key={s.id}><b>{s.name}</b>: {s.reason}</li>)}{result.skipped.length > 8 && <li>and {result.skipped.length - 8} more</li>}</ul>}
          {result.skipped.length > 0 && result.updated > 0 && <div className="mt-1"><button className="underline" onClick={() => onDone(`${result.updated} updated, ${result.skipped.length} skipped.`)}>Done</button></div>}
        </Banner>
      )}
    </Card>
  );
};
