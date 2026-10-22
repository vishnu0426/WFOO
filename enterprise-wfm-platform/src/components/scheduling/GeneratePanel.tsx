/**
 * Scheduling › Generate Schedule. Builds a draft roster that follows the published short-term forecast, using the
 * constraint solver (OR-Tools CP-SAT). Rules are never broken; the sliders decide what to trade off when they conflict.
 */
import React, { useEffect, useState } from 'react';
import { Sparkles } from 'lucide-react';
import { api, CoverageWindow, dayYear, dec, Employee, nextMonday, ScheduleVersion, SchedulingPolicy, ShiftTemplate, VersionMeta } from '../../services/api';
import { useForecast } from '../../services/forecastStore';
import { useApi } from '../forecasting/hooks';
import { Banner, Btn, Busy, Card, Empty, Field, Input, Kpi, KpiRow, Select } from '../forecasting/ui';

export const WEIGHTS = [
  { k: 'understaffing', label: 'Cover the forecast', hint: 'Avoid having fewer people than needed' },
  { k: 'overstaffing', label: 'Avoid overstaffing', hint: 'Avoid having more people than needed' },
  { k: 'contractHours', label: 'Meet contract hours', hint: 'Give everyone their contracted weekly hours' },
  { k: 'preferences', label: 'Honour preferences', hint: 'Use “prefer to work” windows when possible' },
  { k: 'fairness', label: 'Share weekends fairly', hint: 'Spread weekend shifts evenly' },
] as const;

export const GeneratePanel: React.FC<{ versions: ScheduleVersion[]; onCreated: (v: ScheduleVersion) => void; go: (sub: string) => void }> = ({ onCreated, go }) => {
  const { group, can, go: goModule } = useForecast();
  const fcs = useApi<VersionMeta[]>(group ? `/forecast/versions?groupId=${group.id}` : null);
  const tpls = useApi<ShiftTemplate[]>('/scheduling/templates');
  const emps = useApi<Employee[]>(group ? `/workforce/employees?groupId=${group.id}&status=ACTIVE` : null);
  const coverageWindows = useApi<CoverageWindow[]>(group ? `/config/groups/${group.id}/coverage-windows` : null);
  const [coverageSource, setCoverageSource] = useState<'FORECAST' | 'MANUAL'>('FORECAST');
  const [from, setFrom] = useState(nextMonday());
  const [weeks, setWeeks] = useState(1);
  const [limit, setLimit] = useState(30);
  const [skip, setSkip] = useState<string[]>([]);
  const [scope, setScope] = useState<'ALL' | 'TEAM' | 'EMPLOYEE'>('ALL');
  const [skipTeam, setSkipTeam] = useState<string[]>([]);
  const [skipEmp, setSkipEmp] = useState<string[]>([]);
  const [w, setW] = useState<Record<string, number>>({ understaffing: 90, overstaffing: 30, contractHours: 50, preferences: 20, fairness: 30 });
  const pol = useApi<SchedulingPolicy>('/config/scheduling-policy');
  useEffect(() => { if (pol.data) setW(pol.data.weights); }, [pol.data]);   // start from the saved defaults (Configuration › Optimization Weights)
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState<ScheduleVersion | null>(null);

  if (!group) return <Empty title="No WFM group yet">Create a WFM group first (Configuration).</Empty>;
  const published = fcs.data?.find((v) => v.kind === 'SHORT' && v.status === 'PUBLISHED');
  const active = (tpls.data ?? []).filter((t) => t.status === 'ACTIVE');
  const teamsInGroup = [...new Map((emps.data ?? []).filter((e) => e.teamId).map((e) => [e.teamId!, e.teamName!])).entries()];
  const included = scope === 'ALL' ? (emps.data ?? [])
    : scope === 'TEAM' ? (emps.data ?? []).filter((e) => e.teamId && !skipTeam.includes(e.teamId))
    : (emps.data ?? []).filter((e) => !skipEmp.includes(e.id));
  const coverageReady = coverageSource === 'FORECAST' ? !!published : (coverageWindows.data?.length ?? 0) > 0;
  const ready = coverageReady && active.length > skip.length && included.length > 0;

  const run = async () => {
    setBusy(true); setError(''); setResult(null);
    try {
      const v = await api<ScheduleVersion>('/scheduling/versions', {
        method: 'POST', body: {
          groupId: group.id, from, weeks, timeLimitSec: limit, weights: w, templateIds: active.filter((t) => !skip.includes(t.id)).map((t) => t.id), coverageSource,
          ...(scope === 'EMPLOYEE' ? { employeeIds: included.map((e) => e.id) } : {}),
          ...(scope === 'TEAM' ? { teamIds: teamsInGroup.filter(([id]) => !skipTeam.includes(id)).map(([id]) => id) } : {}),
        },
      });
      setResult(v); onCreated(v);
    } catch (e: any) { setError(e.message); } finally { setBusy(false); }
  };
  const solver = result?.stats.solver;

  return (
    <div className="space-y-6">
      <Card title="Generate a schedule" sub={`For ${group.name}. A new numbered draft is created; nothing published changes until you publish it.`}>
        <div>
          <div className="text-[12px] font-semibold mb-1.5">Coverage source</div>
          <div className="flex gap-1.5 text-[13px]">
            <button type="button" className={`px-3 py-1 rounded-md border ${coverageSource === 'FORECAST' ? 'bg-[#1A1A1A] text-white border-[#1A1A1A]' : 'border-[#E5E5E0]'}`} onClick={() => setCoverageSource('FORECAST')}>From forecast</button>
            <button type="button" className={`px-3 py-1 rounded-md border ${coverageSource === 'MANUAL' ? 'bg-[#1A1A1A] text-white border-[#1A1A1A]' : 'border-[#E5E5E0]'}`} onClick={() => setCoverageSource('MANUAL')}>Set manually</button>
          </div>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3 text-[13px]">
          {coverageSource === 'FORECAST'
            ? <Check ok={!!published} good={`Forecast: ${published?.name}`} bad="No published short-term forecast" action={can('forecast:create') ? { label: 'Open Forecasting', onClick: () => goModule('forecast-dashboard', 'forecasting') } : undefined} />
            : <Check ok={(coverageWindows.data?.length ?? 0) > 0} good={`${coverageWindows.data?.length ?? 0} coverage window${(coverageWindows.data?.length ?? 0) === 1 ? '' : 's'} set`} bad="No coverage windows set for this group" action={{ label: 'WFM Groups', onClick: () => goModule('wfm-groups', 'configuration') }} />}
          <Check ok={active.length > 0} good={`${active.length} active shift template${active.length === 1 ? '' : 's'}`} bad="No active shift templates" action={{ label: 'Shift Templates', onClick: () => go('shift-templates') }} />
          <Check ok={included.length > 0} good={`${included.length} of ${emps.data?.length ?? 0} active people included`} bad="No employees in this group" action={{ label: 'Employees', onClick: () => goModule('employees', 'workforce') }} />
        </div>
        {coverageSource === 'FORECAST' && published && <p className="text-[12px] text-[#737373]">The schedule must fall inside the forecast’s dates: {dayYear(published.fromDay)} to {dayYear(published.toDay)}.</p>}

        <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
          <Field label="Starts on" hint="A Monday works best"><Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} min={coverageSource === 'FORECAST' ? published?.fromDay : undefined} max={coverageSource === 'FORECAST' ? published?.toDay : undefined} /></Field>
          <Field label="Length"><Select value={weeks} onChange={(e) => setWeeks(Number(e.target.value))}>{[1, 2, 3, 4].map((n) => <option key={n} value={n}>{n} week{n > 1 ? 's' : ''}</option>)}</Select></Field>
          <Field label="Solver time" hint="More time can find a better roster"><Select value={limit} onChange={(e) => setLimit(Number(e.target.value))}>{[10, 30, 60, 120].map((n) => <option key={n} value={n}>Up to {n} seconds</option>)}</Select></Field>
        </div>

        <div>
          <div className="text-[12px] font-semibold mb-1.5">Shift templates to use</div>
          <div className="flex flex-wrap gap-3 text-[13px]">
            {active.map((t) => <label key={t.id} className="flex items-center gap-1.5"><input type="checkbox" checked={!skip.includes(t.id)} onChange={(e) => setSkip(e.target.checked ? skip.filter((x) => x !== t.id) : [...skip, t.id])} />{t.name} <span className="text-[11px] text-[#737373]">{t.earliestStart}–{t.latestStart}, {t.durationHours}h</span></label>)}
          </div>
        </div>

        <div>
          <div className="text-[12px] font-semibold mb-1.5">Who to schedule</div>
          <div className="flex gap-1.5 text-[13px] mb-2">
            {(['ALL', 'TEAM', 'EMPLOYEE'] as const).map((s) => (
              <button key={s} type="button" className={`px-3 py-1 rounded-md border ${scope === s ? 'bg-[#1A1A1A] text-white border-[#1A1A1A]' : 'border-[#E5E5E0]'}`} onClick={() => setScope(s)}>
                {s === 'ALL' ? 'Everyone in the group' : s === 'TEAM' ? 'By team' : 'By employee'}
              </button>
            ))}
          </div>
          {scope === 'TEAM' && (
            <div className="flex flex-wrap gap-3 text-[13px]">
              {teamsInGroup.length === 0 ? <span className="text-[12px] text-[#737373]">No one in this group belongs to a team.</span> : teamsInGroup.map(([id, name]) => (
                <label key={id} className="flex items-center gap-1.5"><input type="checkbox" checked={!skipTeam.includes(id)} onChange={(e) => setSkipTeam(e.target.checked ? skipTeam.filter((x) => x !== id) : [...skipTeam, id])} />{name}</label>
              ))}
            </div>
          )}
          {scope === 'EMPLOYEE' && (
            <div className="flex flex-wrap gap-3 text-[13px] max-h-40 overflow-auto">
              {(emps.data ?? []).map((e) => (
                <label key={e.id} className="flex items-center gap-1.5"><input type="checkbox" checked={!skipEmp.includes(e.id)} onChange={(ev) => setSkipEmp(ev.target.checked ? skipEmp.filter((x) => x !== e.id) : [...skipEmp, e.id])} />{e.name}</label>
              ))}
            </div>
          )}
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-x-8 gap-y-3">
          {WEIGHTS.map((x) => (
            <div key={x.k}>
              <div className="flex justify-between text-[12px]"><span className="font-semibold">{x.label}</span><span className="font-mono text-[#737373]">{w[x.k]}</span></div>
              <input type="range" min={0} max={100} value={w[x.k]} onChange={(e) => setW({ ...w, [x.k]: Number(e.target.value) })} className="w-full accent-[#171717]" />
              <div className="text-[11px] text-[#737373]">{x.hint}</div>
            </div>
          ))}
        </div>
        <p className="text-[11px] text-[#737373]">Always enforced, never traded off: one shift a day, rest between shifts, weekly maximum, days in a row, days per week, availability, approved time off and template days.</p>

        {error && <Banner kind="err">{error}</Banner>}
        <div className="flex items-center gap-3">
          {can('schedule:generate') ? <Btn variant="primary" disabled={!ready || busy} onClick={run}><Sparkles className="w-3.5 h-3.5" />Generate schedule</Btn> : <span className="text-[12px] text-[#737373]">You do not have permission to generate schedules.</span>}
          {busy && <Busy text={`Solving… this can take up to ${limit} seconds`} />}
        </div>
      </Card>

      {result && solver && (
        <Card title={`Created ${result.name}`} sub="A draft. Review it on the timeline, fix anything flagged, then publish.">
          <KpiRow>
            <Kpi label="Forecast covered" value={`${dec(result.stats.coverage.percent, 1)}%`} tone={result.stats.coverage.percent >= 95 ? 'good' : result.stats.coverage.percent >= 85 ? 'warn' : 'bad'} sub={`${result.stats.coverage.underIntervals} intervals short`} />
            <Kpi label="Shifts" value={result.stats.shifts} sub={`${result.stats.people} people`} />
            <Kpi label="Paid hours" value={dec(result.stats.hours.paid, 0)} sub={`${dec(result.stats.hours.overtime, 0)}h above contract`} />
            <Kpi label="Rule violations" value={result.stats.violations} tone={result.stats.violations ? 'bad' : 'good'} sub={result.stats.violations ? 'must be fixed to publish' : 'none'} />
            <Kpi label="Solver" value={<span className="text-[15px]">{solver.status === 'OPTIMAL' ? 'Best possible' : 'Good solution'}</span>} sub={`${solver.wallSec}s · ${solver.candidates.toLocaleString()} options${solver.status === 'OPTIMAL' ? '' : ` · within ${dec(solver.gap * 100, 1)}% of best`}`} />
          </KpiRow>
          {result.stats.uncoveredDays && result.stats.uncoveredDays.length > 0 && <Banner kind="warn">Neither forecast covers {result.stats.uncoveredDays.join(', ')}, so those days have no staffing target.</Banner>}
          {result.stats.projectedDays && result.stats.projectedDays.length > 0 && <Banner kind="warn">{result.stats.projectedDays.join(', ')} {result.stats.projectedDays.length > 1 ? 'are' : 'is'} beyond the short-term forecast's reach — staffed from the long-term forecast projected onto intervals by historical shape, lower confidence than a normal day.</Banner>}
          <Btn variant="primary" onClick={() => go('schedule-timeline')}>Open timeline</Btn>
        </Card>
      )}
    </div>
  );
};

const Check: React.FC<{ ok: boolean; good: string; bad: string; action?: { label: string; onClick: () => void } }> = ({ ok, good, bad, action }) => (
  <div className={`border rounded-lg p-3 flex items-center justify-between gap-2 ${ok ? 'border-[#2F7D5A]/30 bg-[#EAF5EF]/50' : 'border-[#B7791F]/30 bg-[#FFF5DD]/60'}`}>
    <span className={ok ? 'text-[#2F7D5A] font-medium' : 'text-[#B7791F] font-medium'}>{ok ? '✓ ' : '! '}{ok ? good : bad}</span>
    {!ok && action && <button className="text-[12px] underline shrink-0" onClick={action.onClick}>{action.label}</button>}
  </div>
);
