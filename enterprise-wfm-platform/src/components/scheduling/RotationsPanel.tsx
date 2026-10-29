/**
 * Scheduling > Rotation Patterns. A fixed repeating pattern (4-on-4-off, DuPont, a week of days then a week of lates...) assigned once and
 * projected forward indefinitely, independent of any forecast -- for shift work scheduled by pattern rather than matched to demand each
 * period. Two kinds: a cycle of days, or weekly templates each worked for some weeks. Materializing writes ordinary shifts into a normal
 * schedule version: open it in Schedule Timeline to drag, edit, validate and publish exactly like any other schedule.
 */
import React, { useEffect, useMemo, useState } from 'react';
import { ArrowDown, ArrowUp, Plus, Trash2 } from 'lucide-react';
import { Employee, RotationAnalysis, RotationCrew, RotationMember, RotationPattern, RotationPreview, RotationStep, ScheduleVersion, ShiftTemplate, api, dayYear } from '../../services/api';
import { useForecast } from '../../services/forecastStore';
import { useApi } from '../forecasting/hooks';
import { Banner, Btn, Busy, Card, Empty, Field, Input, Kpi, KpiRow, Pill, Seg, Select } from '../forecasting/ui';
import { Heatmap } from './CoverageView';
import { PRESETS, dayPresetPlan, weeklyCrews, weeklySteps, type DayPreset, type Preset, type WeeklyPreset } from './rotationPresets';

const DOW = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const DOW_LONG = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const addDays = (s: string, n: number) => { const d = new Date(s + 'T00:00:00'); d.setDate(d.getDate() + n); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const todayIso = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const dowOf = (s: string) => (new Date(s + 'T00:00:00').getDay() + 6) % 7;
/** The first date on or after `from` that falls on weekday `dow` (Monday 0 ... Sunday 6). */
const onOrAfter = (from: string, dow: number) => addDays(from, (dow - dowOf(from) + 7) % 7);
const compile = (steps: RotationStep[]) => steps.flatMap((s) => Array.from({ length: Math.max(1, s.weeks) }, () => s.days)).flat();
const blankStep = (n: number): RotationStep => ({ name: `Week type ${n}`, weeks: 1, days: new Array(7).fill(null) });

export const RotationsPanel: React.FC<{ go: (sub: string) => void }> = ({ go }) => {
  const { group, can } = useForecast();
  const canWrite = can('workforce:write');
  const [tick, setTick] = useState(0);
  const patterns = useApi<RotationPattern[]>(group ? `/scheduling/rotations?groupId=${group.id}` : null, [group?.id, tick]);
  const tpls = useApi<ShiftTemplate[]>('/scheduling/templates');
  const [sel, setSel] = useState('');
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => { if (patterns.data && !patterns.data.some((p) => p.id === sel)) setSel(patterns.data[0]?.id ?? ''); }, [patterns.data]);
  const current = patterns.data?.find((p) => p.id === sel) ?? null;

  const run = async (fn: () => Promise<void>) => { setBusy(true); setError(''); try { await fn(); setTick((t) => t + 1); } catch (e: any) { setError(e.message); } finally { setBusy(false); } };
  const remove = (p: RotationPattern) => confirm(`Delete "${p.name}"?`) && run(async () => { await api(`/scheduling/rotations/${p.id}`, { method: 'DELETE' }); setSel(''); });

  if (!group) return <Empty title="No WFM group yet" />;
  if (patterns.loading && !patterns.data) return <Busy text="Loading patterns…" />;

  return (
    <div className="space-y-6">
      {error && <Banner kind="err" onClose={() => setError('')}>{error}</Banner>}

      <Card title="Rotation patterns" sub={`For ${group.name}. Fixed repeating cycles (4-on-4-off, DuPont, Pitman...) rather than schedules matched to a forecast.`}
        actions={canWrite && <Btn variant="primary" onClick={() => { setCreating(true); setSel(''); }}><Plus className="w-3.5 h-3.5" />New pattern</Btn>}>
        {!patterns.data?.length && !creating ? <Empty title="No rotation patterns yet">Create one for crews that work a fixed cycle instead of a forecast-driven schedule.</Empty> : (
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            {(patterns.data ?? []).map((p) => (
              <button key={p.id} onClick={() => { setCreating(false); setSel(p.id); }} className={`text-left p-3 rounded-lg border ${sel === p.id && !creating ? 'border-[#171717] bg-[#FAFAF8]' : 'border-[#E5E5E0] hover:bg-[#FAFAF8]'}`}>
                <div className="flex items-center gap-2 flex-wrap"><span className="font-semibold text-[13px]">{p.name}</span>{p.kind === 'WEEKLY' && <Pill tone="info">Weekly</Pill>}{p.status === 'INACTIVE' && <Pill tone="neutral">Inactive</Pill>}</div>
                <div className="text-[11px] text-[#737373] mt-1">{p.kind === 'WEEKLY' ? `${p.cycleDays / 7}-week rotation` : `${p.cycleDays}-day cycle`} · {p.crews.length} crew{p.crews.length === 1 ? '' : 's'} · {p.memberCount} people</div>
                <div className="text-[11px] text-[#737373]">{p.materializedThrough ? `Generated through ${dayYear(p.materializedThrough)}` : 'Not generated yet'}</div>
              </button>
            ))}
          </div>
        )}
      </Card>

      {creating && <NewPatternForm groupId={group.id} templates={tpls.data ?? []} onCancel={() => setCreating(false)} onCreated={(id) => { setCreating(false); setSel(id); setTick((t) => t + 1); }} />}
      {!creating && current && (
        <PatternDetail pattern={current} templates={tpls.data ?? []} canWrite={canWrite} busy={busy} run={run} onDelete={() => remove(current)} go={go} />
      )}
    </div>
  );
};

const NewPatternForm: React.FC<{ groupId: string; templates: ShiftTemplate[]; onCancel: () => void; onCreated: (id: string) => void }> = ({ groupId, templates, onCancel, onCreated }) => {
  const active = templates.filter((t) => t.status === 'ACTIVE');
  const pay = useApi<{ start: number }>(`/scheduling/rotations/pay-week?groupId=${groupId}`);
  const payStart = pay.data?.start ?? 0;
  const [kind, setKind] = useState<'DAY_CYCLE' | 'WEEKLY'>('DAY_CYCLE');
  const [presetId, setPresetId] = useState('');
  const [pick, setPick] = useState<Record<string, string>>({});
  const [name, setName] = useState('');
  const [cycleDays, setCycleDays] = useState(8);
  const [anchorDate, setAnchorDate] = useState(todayIso());
  const [observesHolidays, setObservesHolidays] = useState(true);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const presets = PRESETS.filter((p) => p.kind === kind);
  const preset: Preset | undefined = presets.find((p) => p.id === presetId);
  useEffect(() => { setPresetId(''); setPick({}); }, [kind]);
  // a weekly rotation has to begin on the first day of a pay week
  useEffect(() => { if (kind === 'WEEKLY' && dowOf(anchorDate) !== payStart) setAnchorDate(onOrAfter(anchorDate, payStart)); }, [kind, payStart]);
  // default template for each letter of a preset: the first active ones, in order
  useEffect(() => { if (preset) setPick(Object.fromEntries(preset.letters.map((l, i) => [l.letter, active[Math.min(i, active.length - 1)]?.id ?? '']))); }, [presetId, templates.length]);
  useEffect(() => { if (preset?.kind === 'DAY_CYCLE') setCycleDays(preset.shape.length); }, [presetId]);
  useEffect(() => { if (preset && !name) setName(preset.label); }, [presetId]);

  const create = async () => {
    setBusy(true); setError('');
    try {
      let body: any;
      if (kind === 'WEEKLY') {
        const wp = preset as WeeklyPreset | undefined;
        const steps: RotationStep[] = wp ? weeklySteps(wp, pick, payStart) : [blankStep(1)];
        const sequence = compile(steps);
        body = { wfmGroupId: groupId, name, kind: 'WEEKLY', steps, cycleDays: sequence.length, sequence, crews: wp ? weeklyCrews(wp) : [{ name: 'Crew A', offsetDays: 0 }], anchorDate, observesHolidays };
      } else {
        const dp = preset as DayPreset | undefined;
        const plan = dp ? dayPresetPlan(dp, pick) : { cycleDays, sequence: new Array(cycleDays).fill(null), crews: [{ name: 'Crew A', offsetDays: 0 }] };
        body = { wfmGroupId: groupId, name, kind: 'DAY_CYCLE', ...plan, anchorDate, observesHolidays };
      }
      const c = await api<RotationPattern>('/scheduling/rotations', { method: 'POST', body });
      onCreated(c.id);
    } catch (e: any) { setError(e.message); } finally { setBusy(false); }
  };
  return (
    <Card title="New pattern">
      <div className="space-y-4">
        <div>
          <div className="text-[12px] font-semibold mb-1.5">How does it repeat?</div>
          <Seg options={[{ id: 'DAY_CYCLE', label: 'Repeat a day cycle' }, { id: 'WEEKLY', label: 'Rotate weekly templates' }]} value={kind} onChange={(v) => setKind(v as 'DAY_CYCLE' | 'WEEKLY')} />
          <p className="text-[12px] text-[#737373] mt-1.5">
            {kind === 'DAY_CYCLE' ? 'A sequence of days, each a shift or a day off, that repeats: 4-on-4-off, 2-2-3, DuPont. Crews run the same cycle a few days apart.'
              : 'Weekly templates, each worked for one or more weeks before the next: a week of days, then a week of lates. Crews run it a whole number of weeks apart.'}
          </p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 items-end">
          <Field label="Start from a ready-made pattern" hint={preset?.summary ?? 'Or leave blank and build it day by day on the next screen.'}>
            <Select value={presetId} onChange={(e) => setPresetId(e.target.value)}><option value="">Build my own</option>{presets.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}</Select>
          </Field>
          {preset && preset.letters.map((l) => (
            <Field key={l.letter} label={`${l.label} uses`} hint="One of your shift templates">
              <Select value={pick[l.letter] ?? ''} onChange={(e) => setPick((s) => ({ ...s, [l.letter]: e.target.value }))}>{active.map((t) => <option key={t.id} value={t.id}>{t.name} ({t.earliestStart}, {t.durationHours}h)</option>)}</Select>
            </Field>
          ))}
        </div>

        <div className="grid grid-cols-1 md:grid-cols-4 gap-4 items-end">
          <Field label="Name"><Input value={name} onChange={(e) => setName(e.target.value)} placeholder={kind === 'WEEKLY' ? 'Days, lates, nights' : '4-on-4-off nights'} /></Field>
          {kind === 'DAY_CYCLE' && <Field label="Cycle length (days)" hint={preset ? 'Set by the pattern' : 'e.g. 8 for a 4-on-4-off pattern'}><Input type="number" min={2} max={84} disabled={!!preset} value={cycleDays} onChange={(e) => setCycleDays(Math.max(2, Math.min(84, Number(e.target.value) || 2)))} /></Field>}
          <Field label="Anchor date" hint={kind === 'WEEKLY' ? `Must be a ${DOW_LONG[payStart]}: the first day of this group's pay week` : 'day 0 of the cycle'}>
            <Input type="date" value={anchorDate} onChange={(e) => setAnchorDate(kind === 'WEEKLY' ? onOrAfter(e.target.value, payStart) : e.target.value)} />
          </Field>
          <div className="flex gap-2"><Btn variant="primary" disabled={busy || !name.trim() || !active.length} onClick={create}>Create</Btn><Btn onClick={onCancel}>Cancel</Btn></div>
        </div>
      </div>
      <label className="flex items-center gap-2 text-[12px] mt-3"><input type="checkbox" checked={observesHolidays} onChange={(e) => setObservesHolidays(e.target.checked)} />Skip generating a work shift on days marked as a holiday (Forecasting › special events). Turn off for crews that work through holidays.</label>
      {!active.length && <p className="text-[12px] text-[#C84A4A] mt-2">Create a shift template first (Scheduling › Shift Templates).</p>}
      {error && <Banner kind="err" onClose={() => setError('')}>{error}</Banner>}
      <p className="text-[11px] text-[#737373] mt-2">You can change the days, crews and who is in them next, and see what the pattern means for hours and rest before anyone is put on it.</p>
    </Card>
  );
};

const PatternDetail: React.FC<{
  pattern: RotationPattern; templates: ShiftTemplate[]; canWrite: boolean; busy: boolean;
  run: (fn: () => Promise<void>) => Promise<void>; onDelete: () => void; go: (sub: string) => void;
}> = ({ pattern, templates, canWrite, busy, run, onDelete, go }) => {
  const weekly = pattern.kind === 'WEEKLY';
  const pay = useApi<{ start: number }>(`/scheduling/rotations/pay-week?groupId=${pattern.wfmGroupId}`);
  const payStart = pay.data?.start ?? 0;
  const [seq, setSeq] = useState<(string | null)[]>(pattern.sequence);
  const [steps, setSteps] = useState<RotationStep[]>(pattern.steps ?? []);
  const [crews, setCrews] = useState<RotationCrew[]>(pattern.crews);
  const [observesHolidays, setObservesHolidays] = useState(pattern.observesHolidays);
  useEffect(() => { setSeq(pattern.sequence); setSteps(pattern.steps ?? []); setCrews(pattern.crews); setObservesHolidays(pattern.observesHolidays); }, [pattern.id, pattern.version]);
  const sequence = weekly ? compile(steps) : seq;
  const dirty = JSON.stringify(sequence) !== JSON.stringify(pattern.sequence) || JSON.stringify(crews) !== JSON.stringify(pattern.crews) || observesHolidays !== pattern.observesHolidays || (weekly && JSON.stringify(steps) !== JSON.stringify(pattern.steps));

  const body = (over: any = {}) => ({ name: pattern.name, kind: pattern.kind, cycleDays: sequence.length, sequence, steps: weekly ? steps : null, crews, anchorDate: pattern.anchorDate, status: pattern.status, observesHolidays, ...over });
  const save = () => run(async () => { await api(`/scheduling/rotations/${pattern.id}`, { method: 'PUT', body: body() }); });
  const toggleActive = () => run(async () => { await api(`/scheduling/rotations/${pattern.id}`, { method: 'PUT', body: body({ cycleDays: pattern.cycleDays, sequence: pattern.sequence, steps: pattern.steps, crews: pattern.crews, status: pattern.status === 'ACTIVE' ? 'INACTIVE' : 'ACTIVE', observesHolidays: pattern.observesHolidays }) }); });

  const [through, setThrough] = useState(addDays(pattern.materializedThrough ?? pattern.anchorDate, 90));
  const [result, setResult] = useState('');
  const materialize = () => run(async () => {
    const r = await api<{ shiftsPlaced: number; days: number; holidaysSkipped: number; versionId: string }>(`/scheduling/rotations/${pattern.id}/materialize`, { method: 'POST', body: { through } });
    setResult(`Generated ${r.shiftsPlaced} shift${r.shiftsPlaced === 1 ? '' : 's'} across ${r.days} days.${r.holidaysSkipped ? ` Skipped ${r.holidaysSkipped} holiday day${r.holidaysSkipped === 1 ? '' : 's'}.` : ''}`);
  });
  const [ver, setVer] = useState<{ status: string; id: string } | null>(null);
  useEffect(() => { setVer(null); if (pattern.versionId) api(`/scheduling/versions/${pattern.versionId}`).then((v: any) => setVer({ status: v.status, id: v.id })).catch(() => {}); }, [pattern.versionId, pattern.materializedThrough]);
  const publish = () => run(async () => { await api(`/scheduling/versions/${pattern.versionId}/publish`, { method: 'POST' }); });

  const opts = (
    <>{<option value="">Off</option>}{templates.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</>
  );
  const setStep = (i: number, change: Partial<RotationStep>) => setSteps((ss) => ss.map((s, j) => (j === i ? { ...s, ...change } : s)));
  const totalWeeks = steps.reduce((n, s) => n + s.weeks, 0);

  return (
    <div className="space-y-6">
      <Card title={pattern.name} sub={weekly ? `Week 1 starts ${dayYear(pattern.anchorDate)}, a ${DOW_LONG[dowOf(pattern.anchorDate)]}. Each crew works the same ${totalWeeks}-week rotation, starting a whole number of weeks apart.` : `Cycle day 0 is ${dayYear(pattern.anchorDate)}. Each crew works the same sequence, offset by its own number of days.`}
        actions={canWrite && <>
          <Btn onClick={toggleActive} disabled={busy}>{pattern.status === 'ACTIVE' ? 'Set inactive' : 'Set active'}</Btn>
          <Btn onClick={onDelete} disabled={busy}><Trash2 className="w-3.5 h-3.5" />Delete</Btn>
        </>}>
        {!weekly && (
          <div className="overflow-x-auto border border-[#E5E5E0] rounded-lg">
            <table className="text-[12px]">
              <thead className="bg-[#FAFAF8] text-[#737373] border-b border-[#E5E5E0]"><tr><th className="p-2 text-left w-24">Cycle day</th>{seq.map((_, i) => <th key={i} className="p-2 text-center min-w-[100px]">{i + 1}</th>)}</tr></thead>
              <tbody><tr>
                <td className="p-2 font-semibold">Shift</td>
                {seq.map((tplId, i) => (
                  <td key={i} className="p-1.5">
                    <Select disabled={!canWrite} value={tplId ?? ''} onChange={(e) => setSeq((s) => s.map((x, j) => (j === i ? (e.target.value || null) : x)))}>{opts}</Select>
                  </td>
                ))}
              </tr></tbody>
            </table>
          </div>
        )}

        {weekly && (
          <div className="space-y-3">
            {steps.map((s, i) => (
              <div key={i} className="border border-[#E5E5E0] rounded-lg p-3 space-y-2">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-[11px] font-semibold text-[#737373] w-14">Step {i + 1}</span>
                  <Input disabled={!canWrite} value={s.name} onChange={(e) => setStep(i, { name: e.target.value })} className="max-w-[200px]" />
                  <span className="text-[12px] text-[#737373]">worked for</span>
                  <Input disabled={!canWrite} type="number" min={1} max={12} value={s.weeks} onChange={(e) => setStep(i, { weeks: Math.max(1, Math.min(12, Number(e.target.value) || 1)) })} className="max-w-[80px]" />
                  <span className="text-[12px] text-[#737373]">week{s.weeks === 1 ? '' : 's'}</span>
                  {canWrite && (
                    <span className="ml-auto flex items-center gap-1">
                      <button type="button" aria-label="Move up" disabled={i === 0} className="p-1 text-[#737373] hover:text-[#171717] disabled:opacity-30" onClick={() => setSteps((ss) => { const c = [...ss]; [c[i - 1], c[i]] = [c[i], c[i - 1]]; return c; })}><ArrowUp className="w-4 h-4" /></button>
                      <button type="button" aria-label="Move down" disabled={i === steps.length - 1} className="p-1 text-[#737373] hover:text-[#171717] disabled:opacity-30" onClick={() => setSteps((ss) => { const c = [...ss]; [c[i + 1], c[i]] = [c[i], c[i + 1]]; return c; })}><ArrowDown className="w-4 h-4" /></button>
                      {steps.length > 1 && <button type="button" aria-label="Remove step" className="p-1 text-[#737373] hover:text-[#C84A4A]" onClick={() => setSteps((ss) => ss.filter((_, j) => j !== i))}><Trash2 className="w-4 h-4" /></button>}
                    </span>
                  )}
                </div>
                <div className="grid grid-cols-7 gap-1.5">
                  {s.days.map((tplId, d) => (
                    <div key={d}>
                      <div className="text-[11px] text-[#737373] text-center mb-0.5">{DOW[(payStart + d) % 7]}</div>
                      <Select disabled={!canWrite} value={tplId ?? ''} onChange={(e) => setStep(i, { days: s.days.map((x, j) => (j === d ? (e.target.value || null) : x)) })}>{opts}</Select>
                    </div>
                  ))}
                </div>
              </div>
            ))}
            {canWrite && steps.length < 12 && <Btn onClick={() => setSteps((ss) => [...ss, blankStep(ss.length + 1)])}><Plus className="w-3.5 h-3.5" />Add a weekly template</Btn>}
            {totalWeeks > 12 && <p className="text-[12px] text-[#C84A4A]">The rotation is {totalWeeks} weeks; the longest is 12.</p>}
          </div>
        )}

        <div className="space-y-2">
          <div className="text-[13px] font-semibold">Crews</div>
          {crews.map((c, i) => (
            <div key={i} className="flex items-center gap-2">
              <Input disabled={!canWrite} value={c.name} onChange={(e) => setCrews((cs) => cs.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))} className="max-w-[180px]" />
              <span className="text-[12px] text-[#737373]">starts</span>
              {weekly ? (
                <>
                  <Input disabled={!canWrite} type="number" min={0} max={Math.max(0, totalWeeks - 1)} value={c.offsetDays / 7} onChange={(e) => setCrews((cs) => cs.map((x, j) => (j === i ? { ...x, offsetDays: Math.max(0, Math.min(totalWeeks - 1, Math.round(Number(e.target.value) || 0))) * 7 } : x)))} className="max-w-[90px]" />
                  <span className="text-[11px] text-[#737373]">weeks into the rotation</span>
                </>
              ) : (
                <>
                  <Input disabled={!canWrite} type="number" min={0} max={pattern.cycleDays - 1} value={c.offsetDays} onChange={(e) => setCrews((cs) => cs.map((x, j) => (j === i ? { ...x, offsetDays: Math.max(0, Math.min(pattern.cycleDays - 1, Number(e.target.value) || 0)) } : x)))} className="max-w-[90px]" />
                  <span className="text-[11px] text-[#737373]">days into the cycle</span>
                </>
              )}
              {canWrite && crews.length > 1 && <button className="text-[#737373] hover:text-[#C84A4A]" onClick={() => setCrews((cs) => cs.filter((_, j) => j !== i))}><Trash2 className="w-4 h-4" /></button>}
            </div>
          ))}
          {canWrite && <Btn onClick={() => setCrews((cs) => [...cs, { name: `Crew ${String.fromCharCode(65 + cs.length)}`, offsetDays: 0 }])}><Plus className="w-3.5 h-3.5" />Add crew</Btn>}
        </div>

        <label className="flex items-center gap-2 text-[12px]"><input type="checkbox" disabled={!canWrite} checked={observesHolidays} onChange={(e) => setObservesHolidays(e.target.checked)} />Skip generating a work shift on days marked as a holiday</label>

        {canWrite && <div className="flex items-center gap-2"><Btn variant="primary" disabled={busy || !dirty} onClick={save}>Save changes</Btn>{dirty && <span className="text-[12px] text-[#B7791F]">Unsaved changes</span>}</div>}
      </Card>

      <AnalysisCard pattern={pattern} sequence={sequence} steps={weekly ? steps : null} crews={crews} />

      <MembersPanel pattern={pattern} canWrite={canWrite} templates={templates} />

      <PreviewCard pattern={pattern} dirty={dirty} />

      {pattern.versionId && <FillCard pattern={pattern} canGenerate={canWrite} go={go} />}

      <Card title="Generate the roster" sub="Turns the pattern into real shifts, as far ahead as you like. Safe to run again later to extend it further.">
        <div className="flex flex-wrap items-end gap-3">
          <Field label="Generate through"><Input type="date" value={through} onChange={(e) => setThrough(e.target.value)} /></Field>
          <Btn variant="primary" disabled={busy || !pattern.memberCount || dirty} onClick={materialize}>Generate</Btn>
          {ver && ver.status === 'DRAFT' && canWrite && <Btn variant="success" disabled={busy} onClick={publish}>Publish roster</Btn>}
          {ver && <Pill tone={ver.status === 'PUBLISHED' ? 'good' : 'warn'}>{ver.status === 'PUBLISHED' ? 'Published' : 'Draft'}</Pill>}
        </div>
        {!pattern.memberCount && <p className="text-[12px] text-[#C84A4A] mt-2">Add people to a crew above first.</p>}
        {dirty && <p className="text-[12px] text-[#B7791F] mt-2">Save the changes to the pattern first.</p>}
        {result && <p className="text-[12px] text-[#2F7D5A] mt-2">{result}</p>}
        {pattern.versionId && <p className="text-[12px] mt-2">Open <button className="underline" onClick={() => go('schedule-timeline')}>Schedule Timeline</button> and pick "{pattern.name}" from the version list to see, edit or drag the shifts.</p>}
      </Card>
    </div>
  );
};

/** What the pattern means for the people on it, worked out as it is edited: before anyone is put on it. */
const AnalysisCard: React.FC<{ pattern: RotationPattern; sequence: (string | null)[]; steps: RotationStep[] | null; crews: RotationCrew[] }> = ({ pattern, sequence, steps, crews }) => {
  const [data, setData] = useState<RotationAnalysis | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const key = useMemo(() => JSON.stringify([pattern.kind, pattern.anchorDate, steps ?? sequence, crews]), [pattern.kind, pattern.anchorDate, steps, sequence, crews]);
  useEffect(() => {
    let live = true; setLoading(true);
    const t = setTimeout(() => {
      api<RotationAnalysis>('/scheduling/rotations/analyse', { method: 'POST', body: { wfmGroupId: pattern.wfmGroupId, kind: pattern.kind, steps, cycleDays: sequence.length, sequence, crews, anchorDate: pattern.anchorDate } })
        .then((d) => { if (live) { setData(d); setError(''); } })
        .catch((e) => { if (live) { setData(null); setError(e.message); } })
        .finally(() => live && setLoading(false));
    }, 400);
    return () => { live = false; clearTimeout(t); };
  }, [key]);
  const mark = (l: string) => (l === 'OK' ? '✓' : l === 'INFO' ? 'i' : '!');
  const tone = (l: string) => (l === 'OK' ? 'text-[#2F7D5A]' : l === 'INFO' ? 'text-[#525252]' : 'text-[#B7791F] font-medium');
  return (
    <Card title="What this pattern means" sub="Worked out from the days above as you change them, against your company limits. It does not look at who is in the crews.">
      {error && <Banner kind="err">{error}</Banner>}
      {loading && !data && <Busy text="Working it out…" />}
      {data && (
        <>
          <ul className="space-y-1 text-[13px]">
            {data.findings.map((f, i) => <li key={i} className={tone(f.level)}>{mark(f.level)} {f.text}</li>)}
          </ul>
          <div className="overflow-x-auto border border-[#E5E5E0] rounded-lg">
            <table className="w-full text-[12px]">
              <thead className="bg-[#FAFAF8] text-[#737373] border-b border-[#E5E5E0]">
                <tr><th className="p-2 text-left">Crew</th><th className="p-2 text-right">Hours a week (average)</th><th className="p-2 text-right">Most in any 7 days</th><th className="p-2 text-right">Longest run</th><th className="p-2 text-right">Shortest rest</th><th className="p-2 text-right">Weekend days a week</th><th className="p-2 text-right">Weekends fully off</th></tr>
              </thead>
              <tbody>
                {data.crews.map((c) => (
                  <tr key={c.name} className="border-b border-[#F0F0EC] last:border-0">
                    <td className="p-2 font-medium">{c.name}</td>
                    <td className="p-2 text-right tabular-nums">{c.averageWeeklyHours} h</td>
                    <td className="p-2 text-right tabular-nums">{c.maxHoursInAnyWeek} h · {c.maxDaysInAnyWeek} days</td>
                    <td className="p-2 text-right tabular-nums">{c.neverOff ? 'no day off' : `${c.longestRun} day${c.longestRun === 1 ? '' : 's'}`}</td>
                    <td className="p-2 text-right tabular-nums">{c.shortestRestHours === null ? 'n/a' : `${c.shortestRestHours} h`}</td>
                    <td className="p-2 text-right tabular-nums">{c.weekendDaysPerWeek}</td>
                    <td className="p-2 text-right tabular-nums">{Math.round(c.weekendsFullyOff * 100)}%</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {data.contractHours && <p className="text-[11px] text-[#737373]">Compared with a {data.contractHours}-hour week (this WFM group's full-time hours), and with the limits in Configuration › Scheduling Rules.</p>}
        </>
      )}
    </Card>
  );
};

/** The saved pattern, with the people in it now, against the staffing target: before generating a roster. */
const PreviewCard: React.FC<{ pattern: RotationPattern; dirty: boolean }> = ({ pattern, dirty }) => {
  const [days, setDays] = useState('14');
  const [source, setSource] = useState('FORECAST');
  const [data, setData] = useState<RotationPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => { setData(null); }, [pattern.id, pattern.version, pattern.memberCount]);
  const check = async () => {
    setBusy(true); setError('');
    try { setData(await api<RotationPreview>(`/scheduling/rotations/${pattern.id}/preview?days=${days}&coverageSource=${source}`)); } catch (e: any) { setError(e.message); } finally { setBusy(false); }
  };
  return (
    <Card title="Does it cover the demand?" sub="Counts the people in the crews now against the staffing target, for the next stretch of days. Nothing is generated.">
      <div className="flex flex-wrap items-end gap-3">
        <Field label="Look at"><Select value={days} onChange={(e) => setDays(e.target.value)}>{[7, 14, 21, 28].map((n) => <option key={n} value={n}>The next {n} days</option>)}</Select></Field>
        <Field label="Staffing target from"><Select value={source} onChange={(e) => setSource(e.target.value)}><option value="FORECAST">The published forecast</option><option value="MANUAL">Coverage windows (set manually)</option></Select></Field>
        <Btn variant="primary" disabled={busy || dirty || !pattern.memberCount} onClick={check}>{busy ? 'Checking…' : 'Check coverage'}</Btn>
      </div>
      {dirty && <p className="text-[12px] text-[#B7791F]">Save the changes to the pattern first: the check uses the saved pattern.</p>}
      {!pattern.memberCount && <p className="text-[12px] text-[#737373]">Add people to a crew first.</p>}
      {error && <Banner kind="err">{error}</Banner>}
      {data && data.available === false && <Banner kind="warn">{data.reason}</Banner>}
      {data && data.available === true && (
        <div className="space-y-3">
          <KpiRow>
            <Kpi label="Covered" value={`${data.summary.coveragePercent}%`} tone={data.summary.coveragePercent >= 95 ? 'good' : data.summary.coveragePercent >= 85 ? 'warn' : 'bad'} sub={`${data.summary.requiredHours} h needed, ${data.summary.scheduledHours} h scheduled`} />
            <Kpi label="Short" value={`${data.summary.shortHours} h`} tone={data.summary.shortHours === 0 ? 'good' : 'bad'} sub={data.summary.worstShort ? `worst: ${dayYear(data.summary.worstShort.day)} ${data.summary.worstShort.time}, ${data.summary.worstShort.short} people short` : 'nowhere short'} />
            <Kpi label="Over" value={`${data.summary.overHours} h`} sub={data.summary.requiredHours ? `${Math.round((data.summary.overHours / data.summary.requiredHours) * 100)}% above the need` : ''} />
            <Kpi label="People" value={data.people} sub={`on shift in these ${data.days} days`} />
          </KpiRow>
          {data.uncoveredDays.length > 0 && <Banner kind="warn">No staffing target for {data.uncoveredDays.length} of these days, so they are left out of the figures.</Banner>}
          <Heatmap heat={data.heat} daily={data.daily} onPick={() => {}} />
        </div>
      )}
    </Card>
  );
};

type Assign = { crewName: string; effectiveFrom: string; effectiveTo: string; startCycleDay: string };
const blankAssign: Assign = { crewName: '', effectiveFrom: '', effectiveTo: '', startCycleDay: '' };

const MembersPanel: React.FC<{ pattern: RotationPattern; canWrite: boolean; templates: ShiftTemplate[] }> = ({ pattern, canWrite, templates }) => {
  const [tick, setTick] = useState(0);
  const emps = useApi<Employee[]>(`/workforce/employees?groupId=${pattern.wfmGroupId}&status=ACTIVE`);
  const current = useApi<RotationMember[]>(`/scheduling/rotations/${pattern.id}/members`, [pattern.id, tick]);
  const [assign, setAssign] = useState<Record<string, Assign>>({});
  useEffect(() => { setAssign(Object.fromEntries((current.data ?? []).map((m) => [m.employeeId, { crewName: m.crewName, effectiveFrom: m.effectiveFrom ?? '', effectiveTo: m.effectiveTo ?? '', startCycleDay: m.startCycleDay == null ? '' : String(m.startCycleDay) }]))); }, [current.data]);
  const [busy, setBusy] = useState(false); const [error, setError] = useState(''); const [notice, setNotice] = useState('');
  const weekly = pattern.kind === 'WEEKLY';
  const tplName = (id: string | null) => (id ? templates.find((t) => t.id === id)?.name ?? '?' : 'off');

  // where in the pattern a person can start: any day of a cycle, or the first day of any week of a weekly rotation
  const starts = useMemo(() => {
    if (weekly) {
      let w = 0;
      return (pattern.steps ?? []).flatMap((s) => Array.from({ length: s.weeks }, (_, k) => { w++; return { value: (w - 1) * 7, label: `Week ${w}: ${s.name}${s.weeks > 1 ? ` (${k + 1} of ${s.weeks})` : ''}` }; }));
    }
    return pattern.sequence.map((id, i) => ({ value: i, label: `Day ${i + 1}: ${tplName(id)}` }));
  }, [pattern.id, pattern.version, templates.length]);

  const save = async () => {
    setBusy(true); setError(''); setNotice('');
    try {
      const members = Object.entries(assign).filter(([, a]) => a.crewName).map(([employeeId, a]) => ({ employeeId, crewName: a.crewName, effectiveFrom: a.effectiveFrom || null, effectiveTo: a.effectiveTo || null, startCycleDay: a.startCycleDay === '' ? null : Number(a.startCycleDay) }));
      const r = await api<{ resync: { added: number; removed: number } | null }>(`/scheduling/rotations/${pattern.id}/members`, { method: 'PUT', body: { members } });
      if (r.resync && (r.resync.added || r.resync.removed)) setNotice(`Already-generated shifts updated to match: ${r.resync.added} set, ${r.resync.removed} removed.`);
      setTick((t) => t + 1);
    } catch (e: any) { setError(e.message); } finally { setBusy(false); }
  };

  return (
    <Card title="Crew members" sub={`Who is in each crew, and optionally when. Leave the dates blank for someone who is simply always in the crew; set them for a mid-cycle join or leave. "Starts at" puts a person at a point in the ${weekly ? 'rotation' : 'cycle'} on the day they join, instead of following the crew.`}>
      {error && <Banner kind="err" onClose={() => setError('')}>{error}</Banner>}
      {notice && <Banner kind="ok" onClose={() => setNotice('')}>{notice}</Banner>}
      {!emps.data?.length ? <Empty title="No people in this WFM group yet" /> : (
        <div className="max-h-[420px] overflow-y-auto divide-y divide-[#F0F0EC] border border-[#E5E5E0] rounded-lg">
          {emps.data.map((e) => {
            const a = assign[e.id] ?? blankAssign;
            return (
              <div key={e.id} className="flex flex-wrap items-center justify-between gap-3 px-3 py-1.5">
                <span className="text-[13px] min-w-[160px]">{e.name} <span className="text-[11px] text-[#737373] font-mono">{e.employeeNumber}</span></span>
                <div className="flex flex-wrap items-center gap-2">
                  <Select disabled={!canWrite} value={a.crewName} onChange={(ev) => setAssign((s) => ({ ...s, [e.id]: { ...a, crewName: ev.target.value } }))} className="!w-auto min-w-[160px]">
                    <option value="">Not in this pattern</option>{pattern.crews.map((c) => <option key={c.name} value={c.name}>{c.name}</option>)}
                  </Select>
                  {a.crewName && canWrite && <>
                    <Select title="Starts at (optional): the point in the pattern they are on when they join" value={a.startCycleDay} onChange={(ev) => setAssign((s) => ({ ...s, [e.id]: { ...a, startCycleDay: ev.target.value } }))} className="!w-auto min-w-[180px]">
                      <option value="">Starts with the crew</option>{starts.map((s) => <option key={s.value} value={s.value}>Starts at {s.label}</option>)}
                    </Select>
                    <Input type="date" title="Joins on (optional)" disabled={!canWrite} value={a.effectiveFrom} onChange={(ev) => setAssign((s) => ({ ...s, [e.id]: { ...a, effectiveFrom: ev.target.value } }))} className="!w-auto" />
                    <span className="text-[11px] text-[#737373]">to</span>
                    <Input type="date" title="Leaves after (optional)" disabled={!canWrite} value={a.effectiveTo} onChange={(ev) => setAssign((s) => ({ ...s, [e.id]: { ...a, effectiveTo: ev.target.value } }))} className="!w-auto" />
                  </>}
                </div>
              </div>
            );
          })}
        </div>
      )}
      {canWrite && <Btn variant="primary" disabled={busy} onClick={save}>Save crew members</Btn>}
    </Card>
  );
};

/** Cover what the rotation leaves short from the forecast, using the people who are not in its crews. Makes a separate draft: the rotation roster itself is not changed. */
const FillCard: React.FC<{ pattern: RotationPattern; canGenerate: boolean; go: (sub: string) => void }> = ({ pattern, canGenerate, go }) => {
  const { can } = useForecast();
  const pay = useApi<{ start: number }>(`/scheduling/rotations/pay-week?groupId=${pattern.wfmGroupId}`);
  const emps = useApi<Employee[]>(`/workforce/employees?groupId=${pattern.wfmGroupId}&status=ACTIVE`);
  const crew = useApi<RotationMember[]>(`/scheduling/rotations/${pattern.id}/members`, [pattern.id, pattern.memberCount]);
  const payStart = pay.data?.start ?? 0;
  const [from, setFrom] = useState(() => onOrAfter(pattern.anchorDate > todayIso() ? pattern.anchorDate : todayIso(), 0));
  useEffect(() => { if (pay.data) setFrom((f) => onOrAfter(f, payStart)); }, [pay.data?.start]);
  const [weeks, setWeeks] = useState(2);
  const [source, setSource] = useState('FORECAST');
  const [limit, setLimit] = useState(30);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [made, setMade] = useState<ScheduleVersion | null>(null);
  const inCrew = new Set((crew.data ?? []).map((m) => m.employeeId));
  const free = (emps.data ?? []).filter((e) => !inCrew.has(e.id));
  const go2 = async () => {
    setBusy(true); setError(''); setMade(null);
    try {
      setMade(await api<ScheduleVersion>('/scheduling/versions', { method: 'POST', body: { groupId: pattern.wfmGroupId, from, weeks, timeLimitSec: limit, coverageSource: source, fillFromVersionId: pattern.versionId, name: `Fill the gaps in ${pattern.name}` } }));
    } catch (e: any) { setError(e.message); } finally { setBusy(false); }
  };
  return (
    <Card title="Fill the gaps from the forecast" sub="The rotation covers the base. This builds a separate draft that schedules the people who are not in its crews, to cover only what the rotation leaves short. The rotation roster is not changed.">
      <p className="text-[12px] text-[#525252]">{emps.data ? `${free.length} of ${emps.data.length} active people are not in this pattern's crews and can be scheduled.` : ''}{emps.data && free.length === 0 ? ' Add people to the WFM group, or take some out of the crews, first.' : ''}</p>
      <div className="flex flex-wrap items-end gap-3">
        <Field label="From" hint={`Starts on a ${DOW_LONG[payStart]}, the pay week`}><Input type="date" value={from} onChange={(e) => setFrom(onOrAfter(e.target.value, payStart))} /></Field>
        <Field label="For"><Select value={weeks} onChange={(e) => setWeeks(Number(e.target.value))}>{[1, 2, 3, 4].map((n) => <option key={n} value={n}>{n} week{n > 1 ? 's' : ''}</option>)}</Select></Field>
        <Field label="Staffing target from"><Select value={source} onChange={(e) => setSource(e.target.value)}><option value="FORECAST">The published forecast</option><option value="MANUAL">Coverage windows (set manually)</option></Select></Field>
        <Field label="Solver time"><Select value={limit} onChange={(e) => setLimit(Number(e.target.value))}>{[10, 30, 60, 120].map((n) => <option key={n} value={n}>Up to {n} seconds</option>)}</Select></Field>
        {(canGenerate && can('schedule:generate')) && <Btn variant="primary" disabled={busy || !free.length} onClick={go2}>{busy ? 'Solving…' : 'Generate the fill'}</Btn>}
      </div>
      {error && <Banner kind="err" onClose={() => setError('')}>{error}</Banner>}
      {made && (
        <Banner kind="ok">
          Created {made.name}: {made.stats.shifts} shift{made.stats.shifts === 1 ? '' : 's'} for {made.stats.people} {made.stats.people === 1 ? 'person' : 'people'}, and together with the rotation the need is {made.stats.coverage.percent >= 99.95 ? 'fully' : `${made.stats.coverage.percent.toFixed(1)}%`} covered.
          {' '}<button className="underline" onClick={() => go('schedule-timeline')}>Open it in Schedule Timeline</button> to see the combined coverage.
        </Banner>
      )}
    </Card>
  );
};
