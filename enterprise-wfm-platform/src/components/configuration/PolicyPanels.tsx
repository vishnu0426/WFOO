/**
 * Configuration › Scheduling Rules and Optimization Weights. Both are stored in one company-wide scheduling policy.
 * Rules apply to every schedule alongside each person's own contract (the stricter one wins); weights are the starting
 * point on the Generate Schedule screen.
 */
import React, { useEffect, useState } from 'react';
import { api, SchedulingPolicy } from '../../services/api';
import { useForecast } from '../../services/forecastStore';
import { useApi } from '../forecasting/hooks';
import { WEIGHTS } from '../scheduling/GeneratePanel';
import { Banner, Btn, Busy, Card, Field, Input, Select } from '../forecasting/ui';

const TOLERANCES = [0, 15, 30, 60, 120];

function usePolicy() {
  const { can } = useForecast();
  const [tick, setTick] = useState(0);
  const res = useApi<SchedulingPolicy>('/config/scheduling-policy', [tick]);
  const [draft, setDraft] = useState<SchedulingPolicy | null>(null);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  useEffect(() => { if (res.data) setDraft(res.data); }, [res.data]);
  const save = async () => {
    if (!draft) return; setError(''); setSaved(false);
    const { updatedAt, updatedBy, ...body } = draft;
    try { await api('/config/scheduling-policy', { method: 'PUT', body }); setSaved(true); setTick((t) => t + 1); } catch (e: any) { setError(e.message); }
  };
  return { draft, setDraft, save, error, saved, loading: res.loading && !draft, loadError: res.error, canWrite: can('config:write'), current: res.data };
}

const LIMITS: { k: 'minRestHours' | 'maxWeeklyHours' | 'maxConsecutiveDays' | 'maxDaysPerWeek'; label: string; hint: string; unit: string; min: number; max: number; step: number }[] = [
  { k: 'minRestHours', label: 'Rest between shifts', hint: 'At least this long from the end of one shift to the start of the next', unit: 'hours', min: 0, max: 24, step: 0.5 },
  { k: 'maxWeeklyHours', label: 'Most hours in a week', hint: 'Paid hours, Monday to Sunday', unit: 'hours', min: 1, max: 100, step: 0.5 },
  { k: 'maxConsecutiveDays', label: 'Most days in a row', hint: 'Longest run of working days without a day off', unit: 'days', min: 1, max: 14, step: 1 },
  { k: 'maxDaysPerWeek', label: 'Most days in a week', hint: 'Working days from Monday to Sunday', unit: 'days', min: 1, max: 7, step: 1 },
];

export const SchedulingRulesPanel: React.FC = () => {
  const p = usePolicy();
  if (p.loading) return <Busy text="Loading rules…" />;
  if (!p.draft) return <Banner kind="err">{p.loadError || 'Could not load the scheduling rules.'}</Banner>;
  const d = p.draft;
  const setLimit = (k: (typeof LIMITS)[number]['k'], raw: string) => p.setDraft({ ...d, [k]: raw === '' ? null : Number(raw) });
  const setSched = (change: Partial<SchedulingPolicy['scheduling']>) => p.setDraft({ ...d, scheduling: { ...d.scheduling, ...change } });
  return (
    <Card title="Scheduling rules" sub="Company-wide limits every generated or edited schedule must respect. Each person's own contract still applies, and the stricter of the two wins. Leave a box empty for no company-wide limit.">
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 max-w-3xl">
        {LIMITS.map((l) => (
          <Field key={l.k} label={l.label} hint={l.hint}>
            <div className="flex items-center gap-2">
              <Input type="number" min={l.min} max={l.max} step={l.step} disabled={!p.canWrite} placeholder="No limit" value={d[l.k] ?? ''} onChange={(e) => setLimit(l.k, e.target.value)} />
              <span className="text-[12px] text-[#737373]">{l.unit}</span>
            </div>
          </Field>
        ))}
      </div>
      <div className="max-w-3xl border-t border-[#E5E5E0] pt-4">
        <Field label="Adherence grace period" hint="Real-time adherence only flags someone once they have been out of step with the schedule for longer than this. Judged to the second.">
          <div className="flex items-center gap-2">
            <Input type="number" min={0} max={3600} step={5} disabled={!p.canWrite} value={d.adherenceGraceSeconds} onChange={(e) => p.setDraft({ ...d, adherenceGraceSeconds: Math.max(0, Math.min(3600, Math.round(Number(e.target.value) || 0))) })} />
            <span className="text-[12px] text-[#737373]">seconds{d.adherenceGraceSeconds >= 60 ? ` (${(d.adherenceGraceSeconds / 60).toFixed(d.adherenceGraceSeconds % 60 ? 1 : 0)} min)` : ''}</span>
          </div>
        </Field>
      </div>
      <div className="max-w-3xl border-t border-[#E5E5E0] pt-4 space-y-3">
        <div>
          <div className="text-[13px] font-semibold text-[#171717]">Same start and end time every day</div>
          <p className="text-[12px] text-[#737373] mt-0.5">The starting choice on Generate Schedule. A person can have their own setting, or an assigned start time, under Workforce › Employees; that always wins over this.</p>
        </div>
        <div className="flex flex-wrap items-end gap-4">
          <Field label="Company default" hint="Required keeps everyone to one usual start and end; Preferred only when coverage allows">
            <Select disabled={!p.canWrite} value={d.scheduling.consistentTimes.mode} onChange={(e) => setSched({ consistentTimes: { ...d.scheduling.consistentTimes, mode: e.target.value as 'OFF' | 'PREFER' | 'REQUIRE' } })}>
              <option value="OFF">Off: times can change day to day</option><option value="PREFER">Preferred</option><option value="REQUIRE">Required</option>
            </Select>
          </Field>
          {d.scheduling.consistentTimes.mode !== 'OFF' && (
            <>
              <Field label="Start may vary by"><Select disabled={!p.canWrite} value={d.scheduling.consistentTimes.startToleranceMin} onChange={(e) => setSched({ consistentTimes: { ...d.scheduling.consistentTimes, startToleranceMin: Number(e.target.value) } })}>{TOLERANCES.map((m) => <option key={m} value={m}>{m === 0 ? 'No time' : `${m} minutes`}</option>)}</Select></Field>
              <Field label="End may vary by"><Select disabled={!p.canWrite} value={d.scheduling.consistentTimes.endToleranceMin} onChange={(e) => setSched({ consistentTimes: { ...d.scheduling.consistentTimes, endToleranceMin: Number(e.target.value) } })}>{TOLERANCES.map((m) => <option key={m} value={m}>{m === 0 ? 'No time' : `${m} minutes`}</option>)}</Select></Field>
            </>
          )}
        </div>
      </div>
      <div className="max-w-3xl border-t border-[#E5E5E0] pt-4 space-y-3">
        <div className="text-[13px] font-semibold text-[#171717]">Quality checks</div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <Field label="Coverage target" hint="How much of the required people-time a schedule should cover. Below it, the shortage analysis flags the schedule.">
            <div className="flex items-center gap-2"><Input type="number" min={50} max={100} disabled={!p.canWrite} value={d.scheduling.targetCoverage} onChange={(e) => setSched({ targetCoverage: Math.max(50, Math.min(100, Math.round(Number(e.target.value) || 90))) })} /><span className="text-[12px] text-[#737373]">%</span></div>
          </Field>
          <Field label="Pay week starts on" hint="Weekly hours, days per week and overtime are counted from this day. A WFM group can use its own day (Configuration › WFM Groups). A schedule keeps the pay week it was built with.">
            <Select disabled={!p.canWrite} value={d.scheduling.payWeekStart ?? 0} onChange={(e) => setSched({ payWeekStart: Number(e.target.value) })}>{['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'].map((n, i) => <option key={n} value={i}>{n}</option>)}</Select>
          </Field>
          <Field label="Part-time and contract staff: hours past contract" hint="Part-time, contract and temporary people are scheduled for their contract hours plus at most this much. More than that has to be an extra shift you approve. Full-time people keep their own weekly maximum. Give part-timers shifts of 4 to 6 hours so their contract can be met exactly.">
            <Select disabled={!p.canWrite} value={d.scheduling.partTimeToleranceHours === null ? 'off' : String(d.scheduling.partTimeToleranceHours ?? 1)} onChange={(e) => setSched({ partTimeToleranceHours: e.target.value === 'off' ? null : Number(e.target.value) })}>
              {[0, 0.5, 1, 2, 4].map((h) => <option key={h} value={String(h)}>{h === 0 ? 'Contract hours only' : `Up to ${h} h past contract`}</option>)}
              <option value="off">No limit except their weekly maximum</option>
            </Select>
          </Field>
          <Field label="Meal and break window" hint="How far a meal or break may move from where the template puts it, to cover the phones better.">
            <div className="flex items-center gap-2"><Select disabled={!p.canWrite} value={d.scheduling.breakSlackMin} onChange={(e) => setSched({ breakSlackMin: Number(e.target.value) })}>{[0, 30, 60, 90, 120].map((m) => <option key={m} value={m}>{m === 0 ? 'Template flex only' : `±${m} minutes`}</option>)}</Select></div>
          </Field>
        </div>
        <label className="flex items-start gap-2 text-[13px]"><input type="checkbox" className="mt-0.5" disabled={!p.canWrite} checked={d.scheduling.enforcePublishChecks} onChange={(e) => setSched({ enforcePublishChecks: e.target.checked })} />
          <span><span className="font-medium">Ask for a reason before publishing with open checks.</span> <span className="text-[#737373]">When coverage is under the target, or the forecast has changed since the schedule was built, publishing needs a written reason, which is kept with the schedule. Off: the checks are shown as warnings only.</span></span></label>
      </div>
      <div className="max-w-3xl border-t border-[#E5E5E0] pt-4">
        <div className="text-[13px] font-semibold text-[#171717] mb-2">Schedule Timeline colours</div>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {([['shift', 'Shift', 'A normal, generated shift'], ['manual', 'By hand', 'A shift added or changed manually'], ['violation', 'Breaks a rule', 'A shift with a rule violation']] as const).map(([k, label, hint]) => (
            <Field key={k} label={label} hint={hint}>
              <Input type="color" disabled={!p.canWrite} value={d.timelineColors[k]} onChange={(e) => p.setDraft({ ...d, timelineColors: { ...d.timelineColors, [k]: e.target.value } })} className="h-9 p-1" />
            </Field>
          ))}
        </div>
      </div>
      <p className="text-[12px] text-[#737373]">Availability, approved time off, one shift a day and shift template days are always enforced as well.</p>
      {p.error && <Banner kind="err">{p.error}</Banner>}
      {p.saved && <Banner kind="ok">Rules saved. They apply the next time a schedule is generated or checked.</Banner>}
      {p.canWrite && <div><Btn variant="primary" onClick={p.save}>Save rules</Btn></div>}
    </Card>
  );
};

export const OptimizationPanel: React.FC = () => {
  const p = usePolicy();
  if (p.loading) return <Busy text="Loading weights…" />;
  if (!p.draft) return <Banner kind="err">{p.loadError || 'Could not load the optimization weights.'}</Banner>;
  const d = p.draft;
  return (
    <Card title="Optimization weights" sub="What the schedule generator trades off when demand and rules pull in different directions. These are the starting positions on Generate Schedule; you can still change them for any single run, and each schedule records what it was built with.">
      <div className="grid grid-cols-1 md:grid-cols-2 gap-x-8 gap-y-4 max-w-3xl">
        {WEIGHTS.map((x) => (
          <div key={x.k}>
            <div className="flex justify-between text-[12px]"><span className="font-semibold">{x.label}</span><span className="font-mono text-[#737373]">{d.weights[x.k]}</span></div>
            <input type="range" min={0} max={100} disabled={!p.canWrite} value={d.weights[x.k]} onChange={(e) => p.setDraft({ ...d, weights: { ...d.weights, [x.k]: Number(e.target.value) } })} className="w-full accent-[#171717]" aria-label={x.label} />
            <div className="text-[11px] text-[#737373]">{x.hint}</div>
          </div>
        ))}
      </div>
      <p className="text-[12px] text-[#737373]">Hard rules (rest, weekly maximum, days in a row, availability, approved time off) are never traded off.</p>
      {p.error && <Banner kind="err">{p.error}</Banner>}
      {p.saved && <Banner kind="ok">Weights saved.</Banner>}
      {p.canWrite && <div><Btn variant="primary" onClick={p.save}>Save weights</Btn></div>}
    </Card>
  );
};
