/**
 * Create or edit a WFM group. Fields are grouped by what they do; a change that moves staffing numbers or weekly hours asks for a reason, and says
 * what already exists that the change touches.
 */
import React, { useMemo, useState } from 'react';
import { api, Employee, GroupDto, Team } from '../../../services/api';
import { Banner, Btn, Card, Field, Input, Select } from '../../forecasting/ui';
import { PersonPicker } from '../../common/PersonPicker';
import { useApi } from '../../forecasting/hooks';
import { CATEGORIES, LIBRARY, type SavedTemplate } from '../../scheduling/rotationLibrary';
import { DAYS_LONG, GroupImpact, IMPACT_LABEL, Section, Site, useDebounced } from './shared';

export type GroupFormValues = {
  name: string; description: string; siteId: string | null; managerId: string | null; timezone: string; defaultRotationRef: string | null; serviceLevelGoal: number; serviceLevelThresholdSec: number; targetOccupancy: number;
  shrinkagePercent: number; chatEfficiency: number; method: 'erlang_c' | 'erlang_a'; patienceSec: number; blended: boolean; model: string; fteHoursWeek: number; payWeekStart: number | null; weekendDays: number[] | null;
};
export const DEFAULTS: GroupFormValues = {
  name: '', description: '', siteId: null, managerId: null, timezone: 'UTC', defaultRotationRef: null, serviceLevelGoal: 80, serviceLevelThresholdSec: 20, targetOccupancy: 85, shrinkagePercent: 30, chatEfficiency: 0.85, method: 'erlang_c', patienceSec: 120, blended: false, model: 'auto', fteHoursWeek: 40, payWeekStart: null, weekendDays: null,
};
export const valuesOf = (g: GroupDto): GroupFormValues => ({
  name: g.name, description: g.description ?? '', siteId: g.siteId ?? null, managerId: g.managerId ?? null, timezone: g.timezone, defaultRotationRef: g.defaultRotationRef ?? null, serviceLevelGoal: g.serviceLevelGoal, serviceLevelThresholdSec: g.serviceLevelThresholdSec, targetOccupancy: g.targetOccupancy,
  shrinkagePercent: g.shrinkagePercent, chatEfficiency: g.chatEfficiency ?? 0.85, method: g.method, patienceSec: g.patienceSec, blended: g.blended, model: g.model, fteHoursWeek: g.fteHoursWeek, payWeekStart: g.payWeekStart ?? null, weekendDays: g.weekendDays ?? null,
});

/** Plain-language names of the staffing and pay settings this edit moves. */
export const movedBy = (before: GroupFormValues, now: GroupFormValues): string[] =>
  Object.entries(IMPACT_LABEL).filter(([k]) => JSON.stringify((before as any)[k]) !== JSON.stringify((now as any)[k])).map(([, label]) => label);

/** What is wrong with the form, in words; empty when it can be saved. */
export function problemsOf(f: GroupFormValues): string[] {
  const out: string[] = [];
  if (!f.name.trim()) out.push('Give the group a name.');
  const range = (v: number, lo: number, hi: number, what: string) => { if (!Number.isFinite(v) || v < lo || v > hi) out.push(`${what} must be between ${lo} and ${hi}.`); };
  range(f.serviceLevelGoal, 1, 99, 'Service level goal'); range(f.serviceLevelThresholdSec, 1, 600, 'Answer within'); range(f.targetOccupancy, 31, 100, 'Occupancy cap');
  range(f.shrinkagePercent, 0, 90, 'Shrinkage'); range(f.chatEfficiency, 0.3, 1, 'Chat efficiency'); range(f.fteHoursWeek, 10, 60, 'Full-time hours');
  if (f.weekendDays && (f.weekendDays.length < 1 || f.weekendDays.length > 3)) out.push('Choose one to three weekend days, or use the company setting.');
  if (f.method === 'erlang_a') range(f.patienceSec, 10, 3600, 'Customer patience');
  return out;
}

export type PeopleChoice = { teamIds: string[]; employees: { id: string; name: string }[] };

/** Choose whole teams and named people to put in the group as soon as it exists. */
const PeoplePicker: React.FC<{ teams: Team[]; value: PeopleChoice; onChange: (v: PeopleChoice) => void }> = ({ teams, value, onChange }) => {
  const [q, setQ] = useState('');
  const search = useDebounced(q.trim());
  const [found, setFound] = useState<Employee[]>([]);
  React.useEffect(() => {
    if (search.length < 2) { setFound([]); return; }
    let live = true;
    api<Employee[]>(`/workforce/employees?q=${encodeURIComponent(search)}&status=ACTIVE`).then((r) => live && setFound(r.slice(0, 20))).catch(() => live && setFound([]));
    return () => { live = false; };
  }, [search]);
  const chosen = new Set(value.employees.map((e) => e.id));
  const teamCount = teams.filter((t) => value.teamIds.includes(t.id)).reduce((n, t) => n + t.memberCount, 0);
  return (
    <div className="space-y-3">
      {teams.length > 0 && (
        <div>
          <div className="text-[12px] font-semibold text-[#171717] mb-1">Teams <span className="font-normal text-[#6B6B6B]">every active member is added</span></div>
          <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-1.5 max-h-40 overflow-auto">
            {teams.map((t) => (
              <label key={t.id} className="flex items-center gap-2 text-[13px] border border-[#E5E5E0] rounded px-2.5 py-1.5 bg-white cursor-pointer">
                <input type="checkbox" checked={value.teamIds.includes(t.id)} onChange={(e) => onChange({ ...value, teamIds: e.target.checked ? [...value.teamIds, t.id] : value.teamIds.filter((x) => x !== t.id) })} />
                <span className="flex-1 truncate">{t.name}</span><span className="text-[11px] text-[#6B6B6B]">{t.memberCount}</span>
              </label>
            ))}
          </div>
        </div>
      )}
      <div className="max-w-md">
        <Field label="Individual people" hint="Search by name or number">
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Type at least two letters…" />
        </Field>
        {search.length >= 2 && (
          <div className="border border-[#E5E5E0] rounded-md bg-white divide-y divide-[#E5E5E0] max-h-40 overflow-auto mt-1">
            {found.filter((e) => !chosen.has(e.id)).length === 0 ? <div className="p-2 text-[12px] text-[#6B6B6B]">No one new matches.</div>
              : found.filter((e) => !chosen.has(e.id)).map((e) => <button key={e.id} type="button" className="w-full text-left p-2 text-[12px] hover:bg-[#F5F5F0]" onClick={() => { onChange({ ...value, employees: [...value.employees, { id: e.id, name: e.name }] }); setQ(''); }}>{e.name} <span className="text-[#6B6B6B]">{e.employeeNumber} · {e.teamName ?? 'no team'}</span></button>)}
          </div>
        )}
      </div>
      {value.employees.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {value.employees.map((e) => <span key={e.id} className="inline-flex items-center gap-1 text-[12px] bg-[#F5F5F0] rounded-full pl-2.5 pr-1.5 py-0.5">{e.name}<button type="button" aria-label={`Remove ${e.name}`} className="text-[#6B6B6B] hover:text-[#BC3F3F]" onClick={() => onChange({ ...value, employees: value.employees.filter((x) => x.id !== e.id) })}>×</button></span>)}
        </div>
      )}
      <p className="text-[12px] text-[#6B6B6B]">{value.teamIds.length + value.employees.length === 0 ? 'Optional: you can also add people later from the People tab.' : `${value.teamIds.length} team${value.teamIds.length === 1 ? '' : 's'} (about ${teamCount} people) and ${value.employees.length} named ${value.employees.length === 1 ? 'person' : 'people'} will be added. Anyone without a primary group gets this one.`}</p>
    </div>
  );
};

export const GroupForm: React.FC<{
  id: string | null; initial: GroupFormValues; sites: Site[]; teams?: Team[]; onSave: (v: GroupFormValues, reason: string, people: PeopleChoice) => Promise<void>; onCancel: () => void;
}> = ({ id, initial, sites, teams = [], onSave, onCancel }) => {
  const [people, setPeople] = useState<PeopleChoice>({ teamIds: [], employees: [] });
  const [f, setF] = useState<GroupFormValues>(initial);
  const [reason, setReason] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [impact, setImpact] = useState<GroupImpact | null>(null);
  const library = useApi<SavedTemplate[]>('/scheduling/rotations/templates');
  const zones = useMemo(() => { try { return (Intl as any).supportedValuesOf('timeZone') as string[]; } catch { return ['UTC', 'Asia/Kolkata', 'Europe/London', 'America/New_York']; } }, []);
  const set = <K extends keyof GroupFormValues>(k: K, v: GroupFormValues[K]) => setF((s) => ({ ...s, [k]: v }));
  const num = (k: keyof GroupFormValues) => (e: React.ChangeEvent<HTMLInputElement>) => set(k, Number(e.target.value) as never);
  const moved = id ? movedBy(initial, f) : [];
  const problems = problemsOf(f);
  const needsReason = moved.length > 0;
  const touchesSchedules = id && (f.payWeekStart !== initial.payWeekStart || JSON.stringify(f.weekendDays) !== JSON.stringify(initial.weekendDays) || f.timezone !== initial.timezone);

  React.useEffect(() => { if (id && touchesSchedules && !impact) api<GroupImpact>(`/config/groups/${id}/impact`).then(setImpact).catch(() => undefined); }, [id, touchesSchedules, impact]);

  const save = async () => {
    setBusy(true); setError('');
    try { await onSave(f, reason.trim(), people); } catch (e: any) { setError(e.message); } finally { setBusy(false); }
  };

  return (
    <Card title={id ? 'Edit WFM group' : 'New WFM group'} sub={id ? 'Staffing numbers use the new targets as soon as you save. The forecast model is chosen for each forecast run in Forecast Builder, so published forecasts never change from here.' : 'Set the targets, then choose who works in it. Queues are added on the next screen. The forecast model is chosen for each forecast run in Forecast Builder.'}>
      <div className="space-y-5">
        <Section title="General">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 items-start">
            <Field label="Name"><Input value={f.name} maxLength={80} onChange={(e) => set('name', e.target.value)} autoFocus={!id} /></Field>
            <Field label="Site" hint="Where this group's people work">
              <Select value={f.siteId ?? ''} onChange={(e) => set('siteId', e.target.value || null)}><option value="">No site</option>{sites.filter((s) => s.status !== 'CLOSED' || s.id === f.siteId).map((s) => <option key={s.id} value={s.id}>{s.name}{s.regionName ? ` (${s.regionName})` : ''}{s.status === 'CLOSED' ? ' - closed' : ''}</option>)}</Select>
            </Field>
            <Field label="Group manager" hint="Gets what is escalated above the team supervisors"><PersonPicker ariaLabel="Group manager" value={f.managerId ?? ''} statuses="ONBOARDING,ACTIVE,LEAVE" only="manager" placeholder="Choose the manager (optional)" onChange={(id) => set('managerId', id || null)} /></Field>
            <Field label="Rotation pattern" hint="Optional. The pattern this group normally follows. Rotation Patterns and Generate Schedule start from it; the group still has its own people and roster.">
              <Select value={f.defaultRotationRef ?? ''} onChange={(e) => set('defaultRotationRef', e.target.value || null)}>
                <option value="">None</option>
                {CATEGORIES.filter((c) => c.id !== 'CUSTOM').map((c) => { const inCat = LIBRARY.filter((p) => (p.category ?? 'STANDARD') === c.id); return inCat.length ? <optgroup key={c.id} label={c.label}>{inCat.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}</optgroup> : null; })}
                {(library.data ?? []).length > 0 && <optgroup label="Your library">{(library.data ?? []).map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</optgroup>}
                {f.defaultRotationRef && !LIBRARY.some((p) => p.id === f.defaultRotationRef) && !(library.data ?? []).some((t) => t.id === f.defaultRotationRef) && <option value={f.defaultRotationRef}>A pattern that is no longer in the library</option>}
              </Select>
            </Field>
            <div className="md:col-span-2"><Field label="Description"><Input value={f.description} maxLength={500} onChange={(e) => set('description', e.target.value)} /></Field></div>
          </div>
        </Section>

        <Section title="Service targets">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4 items-start">
            <Field label="Service level goal (%)" hint="Share of contacts answered in time"><Input type="number" min={1} max={99} value={f.serviceLevelGoal} onChange={num('serviceLevelGoal')} /></Field>
            <Field label="Answer within (seconds)" hint="The time that goal is measured against"><Input type="number" min={1} max={600} value={f.serviceLevelThresholdSec} onChange={num('serviceLevelThresholdSec')} /></Field>
            <Field label="Occupancy cap (%)" hint="Most time agents should be busy"><Input type="number" min={31} max={100} value={f.targetOccupancy} onChange={num('targetOccupancy')} /></Field>
            <Field label="Shrinkage (%)" hint="Breaks, training, absence"><Input type="number" min={0} max={90} value={f.shrinkagePercent} onChange={num('shrinkagePercent')} /></Field>
            <Field label="Chat efficiency" hint="How well agents handle chats at once: 1 means three chats at once take a third of the time of one each; lower means they take longer. Measure it from your own chat productivity (0.3 to 1)"><Input type="number" min={0.3} max={1} step={0.01} value={f.chatEfficiency} onChange={num('chatEfficiency')} /></Field>
          </div>
        </Section>

        <Section title="Staffing method">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4 items-start">
            <Field label="Method" hint="Erlang A allows for customers who hang up"><Select value={f.method} onChange={(e) => set('method', e.target.value as GroupFormValues['method'])}><option value="erlang_c">Erlang C</option><option value="erlang_a">Erlang A (with abandonment)</option></Select></Field>
            <Field label="Customer patience (seconds)" hint={f.method === 'erlang_a' ? 'How long callers wait before hanging up' : 'Only used by Erlang A'}><Input type="number" min={10} max={3600} disabled={f.method !== 'erlang_a'} value={f.patienceSec} onChange={num('patienceSec')} /></Field>
            <Field label="Voice and chat share agents?" hint="Blend the two into one pool"><Select value={f.blended ? 'yes' : 'no'} onChange={(e) => set('blended', e.target.value === 'yes')}><option value="no">No, separate</option><option value="yes">Yes, blended</option></Select></Field>
          </div>
        </Section>

        <Section title="Working week">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4 items-start">
            <Field label="Time zone" hint="The clock this group's days, schedules and adherence run on"><Select value={f.timezone} onChange={(e) => set('timezone', e.target.value)}>{(zones.includes(f.timezone) ? zones : [f.timezone, ...zones]).map((z) => <option key={z} value={z}>{z}</option>)}</Select></Field>
            <Field label="Pay week starts on" hint="Weekly hours and overtime are counted from this day">
              <Select value={f.payWeekStart ?? ''} onChange={(e) => set('payWeekStart', e.target.value === '' ? null : Number(e.target.value))}><option value="">Company setting</option>{DAYS_LONG.map((n, i) => <option key={n} value={i}>{n}</option>)}</Select>
            </Field>
            <Field label="Weekend days" hint="Used for weekend pay and fair sharing of weekend shifts. It does not close the group: a 24x7 group is still covered on these days">
              <div className="space-y-1.5">
                <label className="flex items-center gap-1.5 text-[13px] text-[#171717]"><input type="checkbox" checked={f.weekendDays === null} onChange={(e) => set('weekendDays', e.target.checked ? null : [5, 6])} /> Use the company setting</label>
                {f.weekendDays !== null && (
                  <div className="flex flex-wrap gap-x-3 gap-y-1" role="group" aria-label="Weekend days">
                    {DAYS_LONG.map((n, i) => { const on = f.weekendDays!.includes(i); return (
                      <label key={n} className="flex items-center gap-1 text-[13px] text-[#171717]">
                        <input type="checkbox" checked={on} disabled={(!on && f.weekendDays!.length >= 3) || (on && f.weekendDays!.length <= 1)} onChange={() => set('weekendDays', on ? f.weekendDays!.filter((x) => x !== i) : [...f.weekendDays!, i].sort((a, b) => a - b))} /> {n.slice(0, 3)}
                      </label>); })}
                  </div>
                )}
              </div>
            </Field>
            <Field label="Full-time hours per week" hint="What counts as 1 full-time person"><Input type="number" min={10} max={60} value={f.fteHoursWeek} onChange={num('fteHoursWeek')} /></Field>
          </div>
        </Section>

        {!id && (
          <Section title="People">
            <PeoplePicker teams={teams} value={people} onChange={setPeople} />
          </Section>
        )}

        {touchesSchedules && impact && impact.scheduleVersions + impact.forecastVersions > 0 && (
          <Banner kind="warn">
            This group already has {impact.scheduleVersions} schedule{impact.scheduleVersions === 1 ? '' : 's'}{impact.publishedSchedules ? ` (${impact.publishedSchedules} published and still running)` : ''} and {impact.forecastVersions} forecast{impact.forecastVersions === 1 ? '' : 's'}.
            Changing the pay week or time zone does not move their shifts, but weekly hours, overtime and adherence on them may be counted differently. Check them in Schedule Quality afterwards.
          </Banner>
        )}
        {needsReason && (
          <div className="max-w-xl">
            <Field label={`Why are you changing the ${moved.join(', ')}?`} hint="Staffing numbers and weekly hours depend on it, so the reason is kept in the history with your name.">
              <Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="For example: new client contract asks for 90% in 20 seconds" />
            </Field>
          </div>
        )}
        {problems.length > 0 && <ul className="text-[12px] text-[#BC3F3F] list-disc pl-5">{problems.map((p) => <li key={p}>{p}</li>)}</ul>}
        {error && <Banner kind="err" onClose={() => setError('')}>{error}</Banner>}
        <div className="flex gap-2">
          <Btn variant="primary" disabled={busy || problems.length > 0 || (needsReason && reason.trim().length < 3)} onClick={save}>{busy ? 'Saving…' : id ? 'Save changes' : 'Create group'}</Btn>
          <Btn onClick={onCancel}>Cancel</Btn>
        </div>
      </div>
    </Card>
  );
};
