/**
 * Scheduling › Generate Schedule. Builds a draft roster that follows the published short-term forecast, using the
 * constraint solver (OR-Tools CP-SAT). Rules are never broken; the priorities decide what to trade off when they conflict.
 *
 * The page is three short sections (Basics, Who and what, Priorities) plus a collapsed Advanced block, with a summary
 * on the right that checks readiness before any solver time is spent and holds the Generate button.
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, ChevronRight, Sparkles } from 'lucide-react';
import { addDays, api, ConsistentTimes, CoverageWindow, dayYear, dec, dowOfDay, Employee, nextMonday, ScheduleVersion, SchedulingPolicy, ShiftTemplate, VersionMeta } from '../../services/api';
import { useForecast } from '../../services/forecastStore';
import { useApi } from '../forecasting/hooks';
import { Banner, Btn, Card, Empty, Field, Input, Kpi, KpiRow, Select } from '../forecasting/ui';

export const WEIGHTS = [
  { k: 'understaffing', label: 'Cover the forecast', hint: 'Avoid having fewer people than needed' },
  { k: 'overstaffing', label: 'Avoid overstaffing', hint: 'Avoid having more people than needed' },
  { k: 'contractHours', label: 'Meet contract hours', hint: 'Give everyone their contracted weekly hours' },
  { k: 'preferences', label: 'Honour preferences', hint: 'Use “prefer to work” windows when possible' },
  { k: 'fairness', label: 'Share weekends fairly', hint: 'Spread weekend shifts evenly' },
] as const;

const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

/** Ready-made trade-offs. The sliders stay available for anyone who wants exact numbers. */
const PRESETS: { id: string; label: string; hint: string; w: Record<string, number> }[] = [
  { id: 'balanced', label: 'Balanced', hint: 'Cover the forecast first, then contract hours, with a little weight on the rest', w: { understaffing: 90, overstaffing: 30, contractHours: 50, preferences: 20, fairness: 30 } },
  { id: 'coverage', label: 'Coverage first', hint: 'Never short of the forecast, even if hours or preferences suffer', w: { understaffing: 100, overstaffing: 20, contractHours: 30, preferences: 10, fairness: 20 } },
  { id: 'hours', label: 'Contract hours first', hint: 'Make sure everyone gets their full contracted hours', w: { understaffing: 90, overstaffing: 20, contractHours: 80, preferences: 10, fairness: 30 } },
  { id: 'fair', label: 'Fairness first', hint: 'Spread weekends evenly and honour preferences', w: { understaffing: 90, overstaffing: 30, contractHours: 50, preferences: 60, fairness: 90 } },
];
const sameWeights = (a: Record<string, number>, b: Record<string, number>) => Object.keys(b).every((k) => a[k] === b[k]);
const hhmm = (t: string) => { const [h, m] = t.split(':').map(Number); return h * 60 + (m || 0); };

type Readiness = { requiredHours: number | null; peakPeople: number | null; uncoveredDays: string[]; projectedDays: string[]; problem: string | null; payWeek: { start: number; source: 'GROUP' | 'COMPANY' | 'DEFAULT'; companyStart: number } };
type Item = { ok: boolean | 'info'; text: string; action?: { label: string; onClick: () => void } };

export const GeneratePanel: React.FC<{ versions: ScheduleVersion[]; onCreated: (v: ScheduleVersion) => void; go: (sub: string) => void }> = ({ versions, onCreated, go }) => {
  const { group, can, go: goModule } = useForecast();
  const fcs = useApi<VersionMeta[]>(group ? `/forecast/versions?groupId=${group.id}` : null);
  const tpls = useApi<ShiftTemplate[]>('/scheduling/templates');
  const emps = useApi<Employee[]>(group ? `/workforce/employees?groupId=${group.id}&status=ACTIVE` : null);
  const coverageWindows = useApi<CoverageWindow[]>(group ? `/config/groups/${group.id}/coverage-windows` : null);
  const [coverageSource, setCoverageSource] = useState<'FORECAST' | 'MANUAL'>('FORECAST');
  const [from, setFrom] = useState(nextMonday());
  const [weeks, setWeeks] = useState(1);
  // The pay week (Monday 0 ... Sunday 6) comes from the saved setting for this group, else the company's. Picking another day here applies to this run only.
  const [weekPick, setWeekPick] = useState<number | null>(null);
  const [saved, setSaved] = useState(0);              // bumped after saving, to read the saved pay week again
  useEffect(() => { setWeekPick(null); }, [group?.id]);
  const [limit, setLimit] = useState(60);
  const [skip, setSkip] = useState<string[]>([]);
  const [scope, setScope] = useState<'ALL' | 'TEAM' | 'EMPLOYEE'>('ALL');
  const [skipTeam, setSkipTeam] = useState<string[]>([]);
  const [skipEmp, setSkipEmp] = useState<string[]>([]);
  const [w, setW] = useState<Record<string, number>>(PRESETS[0].w);
  const [custom, setCustom] = useState(false);
  // Same start and end every day for the whole period: starts from the company setting (Configuration › Scheduling Rules). A person's own setting still wins.
  const [steady, setSteady] = useState<ConsistentTimes>({ mode: 'OFF', startToleranceMin: 0, endToleranceMin: 0 });
  const [breaksOn, setBreaksOn] = useState(true);
  const [confidence, setConfidence] = useState(50);   // how sure to be of having enough people: 50 = the forecast as published, 90 = its busy-day (P90) volume
  const [repeat, setRepeat] = useState(false);       // a first schedule with nothing before it: assume the week repeats
  const [advanced, setAdvanced] = useState(false);
  const pol = useApi<SchedulingPolicy>('/config/scheduling-policy');
  useEffect(() => { if (pol.data) { setW(pol.data.weights); setSteady(pol.data.scheduling.consistentTimes); } }, [pol.data]);   // start from the saved defaults (Configuration › Optimization Weights)
  const [busy, setBusy] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [error, setError] = useState('');
  const [result, setResult] = useState<ScheduleVersion | null>(null);
  const resultRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!busy) { setElapsed(0); return; }
    const t0 = Date.now(), id = setInterval(() => setElapsed((Date.now() - t0) / 1000), 500);
    return () => clearInterval(id);
  }, [busy]);
  useEffect(() => { if (result) resultRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }); }, [result]);

  const to = addDays(from, weeks * 7 - 1);
  const readiness = useApi<Readiness>(group ? `/scheduling/readiness?groupId=${group.id}&from=${from}&weeks=${weeks}&coverageSource=${coverageSource}` : null, [from, weeks, coverageSource, group?.id, saved]);
  const weekStart = weekPick ?? readiness.data?.payWeek.start ?? 0;
  const setWeekStart = (n: number) => setWeekPick(n === readiness.data?.payWeek.start ? null : n);
  const payWeek = readiness.data?.payWeek;
  const saveAsGroupDefault = async () => {
    if (!group || weekPick === null) return;
    try { await api(`/config/groups/${group.id}`, { method: 'PUT', body: { payWeekStart: weekPick } }); setWeekPick(null); setSaved((n) => n + 1); } catch (e: any) { setError(e.message); }
  };

  const published = fcs.data?.find((v) => v.kind === 'SHORT' && v.status === 'PUBLISHED');
  const active = (tpls.data ?? []).filter((t) => t.status === 'ACTIVE');
  const chosen = active.filter((t) => !skip.includes(t.id));
  const teamsInGroup = [...new Map((emps.data ?? []).filter((e) => e.teamId).map((e) => [e.teamId!, e.teamName!])).entries()];
  const included = scope === 'ALL' ? (emps.data ?? [])
    : scope === 'TEAM' ? (emps.data ?? []).filter((e) => e.teamId && !skipTeam.includes(e.teamId))
    : (emps.data ?? []).filter((e) => !skipEmp.includes(e.id));

  // hours people are contracted for across these dates, against what the staffing target needs
  const contractHours = included.reduce((n, e) => n + e.weeklyContractHours * weeks, 0);
  const needHours = readiness.data?.requiredHours ?? null;

  // hours of the day that no chosen template can have someone working (informational: fine if the phones are closed then)
  const gaps = useMemo(() => {
    if (!chosen.length) return [] as string[];
    const covered = new Array(24).fill(false);
    for (const t of chosen) {
      const a = hhmm(t.earliestStart), b = hhmm(t.latestStart), len = Math.round(t.durationHours * 60), step = Math.max(15, t.startStepMinutes || 60);
      for (let st = a; st <= b; st += step) for (let m = st; m < st + len; m += 30) covered[Math.floor(m / 60) % 24] = true;
    }
    const out: string[] = [];
    for (let h = 0; h < 24; h++) {
      if (covered[h]) continue;
      let e = h; while (e < 24 && !covered[e]) e++;
      out.push(`${String(h).padStart(2, '0')}:00–${String(e % 24).padStart(2, '0')}:00`);
      h = e;
    }
    return out;
  }, [chosen]);

  const coverageReady = coverageSource === 'FORECAST' ? !!published : (coverageWindows.data?.length ?? 0) > 0;
  const startDow = dowOfDay(from);
  const misaligned = startDow !== weekStart;
  const hasPriorPublished = versions.some((v) => v.wfmGroupId === group?.id && v.status === 'PUBLISHED' && v.periodEnd >= addDays(from, -1) && v.periodStart < from);
  const ready = coverageReady && chosen.length > 0 && included.length > 0 && !(readiness.data?.problem && coverageSource === 'FORECAST');

  const items: Item[] = [
    coverageSource === 'FORECAST'
      ? { ok: !!published, text: published ? `Forecast: ${published.name}` : 'No published short-term forecast', action: !published && can('forecast:create') ? { label: 'Open Forecasting', onClick: () => goModule('forecast-dashboard', 'forecasting') } : undefined }
      : { ok: (coverageWindows.data?.length ?? 0) > 0, text: (coverageWindows.data?.length ?? 0) > 0 ? `${coverageWindows.data?.length} coverage window${coverageWindows.data?.length === 1 ? '' : 's'} set` : 'No coverage windows set for this group', action: (coverageWindows.data?.length ?? 0) === 0 ? { label: 'WFM Groups', onClick: () => goModule('wfm-groups', 'configuration') } : undefined },
    { ok: chosen.length > 0, text: chosen.length ? `${chosen.length} shift template${chosen.length === 1 ? '' : 's'} chosen` : 'No shift templates chosen', action: chosen.length === 0 ? { label: 'Shift Templates', onClick: () => go('shift-templates') } : undefined },
    { ok: included.length > 0, text: included.length ? `${included.length} of ${emps.data?.length ?? 0} active people included` : 'No employees in this group', action: included.length === 0 ? { label: 'Employees', onClick: () => goModule('employees', 'workforce') } : undefined },
  ];
  if (readiness.data?.problem && coverageSource === 'FORECAST') items.push({ ok: false, text: readiness.data.problem });
  if (needHours !== null && included.length) {
    const diff = contractHours - needHours, pct = needHours ? Math.round((diff / needHours) * 100) : 0;
    items.push(diff >= 0
      ? { ok: true, text: `Needs ${Math.round(needHours).toLocaleString()} h; contracts give ${Math.round(contractHours).toLocaleString()} h (${pct}% to spare)` }
      : { ok: false, text: `Needs ${Math.round(needHours).toLocaleString()} h but contracts give only ${Math.round(contractHours).toLocaleString()} h: expect a shortfall` });
  }
  if (readiness.data?.uncoveredDays.length) items.push({ ok: false, text: `No staffing target for ${readiness.data.uncoveredDays.length} day${readiness.data.uncoveredDays.length === 1 ? '' : 's'}` });
  if (readiness.data?.projectedDays.length) items.push({ ok: 'info', text: `${readiness.data.projectedDays.length} day${readiness.data.projectedDays.length === 1 ? ' is' : 's are'} beyond the short-term forecast: staffed from the long-term forecast` });
  items.push(misaligned
    ? { ok: false, text: `Starts on a ${WEEKDAYS[startDow]} but the pay week starts on ${WEEKDAYS[weekStart]}: people may not reach full contract hours`, action: { label: `Use ${WEEKDAYS[startDow]} week`, onClick: () => setWeekStart(startDow) } }
    : { ok: true, text: `Pay week starts on ${WEEKDAYS[weekStart]}, the same day the schedule starts` });
  if (weeks === 1 && !hasPriorPublished && !repeat) items.push({ ok: 'info', text: 'No published schedule before this date, so nobody carries a night shift into the first day', action: { label: 'Assume the week repeats', onClick: () => { setRepeat(true); setAdvanced(true); } } });
  if (gaps.length) items.push({ ok: 'info', text: `No chosen template covers ${gaps.slice(0, 3).join(', ')}. Fine if the phones are closed then.` });

  const run = async () => {
    if (!group) return;
    setBusy(true); setError(''); setResult(null);
    try {
      const v = await api<ScheduleVersion>('/scheduling/versions', {
        method: 'POST', body: {
          groupId: group.id, from, weeks, ...(weekPick !== null ? { weekStart: weekPick } : {}), timeLimitSec: limit, weights: w, consistentTimes: steady, optimizeBreaks: breaksOn, assumeRepeat: repeat && weeks === 1, templateIds: chosen.map((t) => t.id), coverageSource, ...(coverageSource === 'FORECAST' ? { confidence } : {}),
          ...(scope === 'EMPLOYEE' ? { employeeIds: included.map((e) => e.id) } : {}),
          ...(scope === 'TEAM' ? { teamIds: teamsInGroup.filter(([id]) => !skipTeam.includes(id)).map(([id]) => id) } : {}),
        },
      });
      setResult(v); onCreated(v);
    } catch (e: any) { setError(e.message); } finally { setBusy(false); }
  };
  const solver = result?.stats.solver;

  if (!group) return <Empty title="No WFM group yet">Create a WFM group first (Configuration).</Empty>;

  const preset = PRESETS.find((p) => sameWeights(w, p.w));
  const stage = elapsed < 4 ? 0 : elapsed < limit ? 1 : 2;
  const fmtShort = (d: string) => new Date(d + 'T00:00:00').toLocaleDateString('en', { weekday: 'short', day: 'numeric', month: 'short' });

  return (
    <div className="space-y-6">
      {result && solver && (
        <div ref={resultRef}>
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
            {result.settings?.report && <ReportSummary report={result.settings.report} />}
            <div className="flex flex-wrap gap-2">
              <Btn variant="primary" onClick={() => go('schedule-timeline')}>Open timeline</Btn>
              <Btn onClick={() => go('schedule-quality')}>See score, shortages and full report</Btn>
            </div>
          </Card>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_340px] gap-6 items-start">
        <Card title="Generate a schedule" sub={`For ${group.name}. A new numbered draft is created; nothing published changes until you publish it.`}>
          <Section title="Basics">
            <div>
              <div className="text-[12px] font-semibold mb-1.5">Coverage source</div>
              <div className="flex gap-1.5 text-[13px]">
                <button type="button" className={`px-3 py-1 rounded-md border ${coverageSource === 'FORECAST' ? 'bg-[#1A1A1A] text-white border-[#1A1A1A]' : 'border-[#E5E5E0]'}`} onClick={() => setCoverageSource('FORECAST')}>From forecast</button>
                <button type="button" className={`px-3 py-1 rounded-md border ${coverageSource === 'MANUAL' ? 'bg-[#1A1A1A] text-white border-[#1A1A1A]' : 'border-[#E5E5E0]'}`} onClick={() => setCoverageSource('MANUAL')}>Set manually</button>
              </div>
              {coverageSource === 'FORECAST' && published && <p className="text-[12px] text-[#737373] mt-1.5">The schedule must fall inside the forecast’s dates: {dayYear(published.fromDay)} to {dayYear(published.toDay)}.</p>}
            </div>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <Field label="Starts on" hint={`${fmtShort(from)} to ${fmtShort(to)}`}><Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} min={coverageSource === 'FORECAST' ? published?.fromDay : undefined} max={coverageSource === 'FORECAST' ? published?.toDay : undefined} /></Field>
              <Field label="Pay week starts on" hint={weekPick !== null ? 'For this run only' : payWeek?.source === 'GROUP' ? `Saved for ${group.name}` : payWeek?.source === 'COMPANY' ? 'Company setting' : 'Not set: Monday'}><Select value={weekStart} onChange={(e) => setWeekStart(Number(e.target.value))}>{WEEKDAYS.map((n, i) => <option key={n} value={i}>{n}</option>)}</Select></Field>
              <Field label="Length"><Select value={weeks} onChange={(e) => setWeeks(Number(e.target.value))}>{[1, 2, 3, 4].map((n) => <option key={n} value={n}>{n} week{n > 1 ? 's' : ''}</option>)}</Select></Field>
            </div>
            {coverageSource === 'FORECAST' && (
              <Field label="How sure to be of having enough people" hint={confidence <= 50 ? 'Staff to the forecast as published: right on a normal day, short when it runs busy' : `Staff for a busier day than the forecast: about ${confidence} days in 100 are covered, at the cost of more people on shift`}>
                <Select value={confidence} onChange={(e) => setConfidence(Number(e.target.value))}>
                  <option value={50}>Forecast as published</option>
                  <option value={75}>Some safety margin (75%)</option>
                  <option value={90}>Busy-day cover (90%)</option>
                  <option value={95}>Very safe (95%)</option>
                </Select>
              </Field>
            )}
            {weekPick !== null && can('config:write') && (
              <p className="text-[12px] text-[#525252]">This run uses a {WEEKDAYS[weekPick]} pay week. <button type="button" className="underline font-semibold" onClick={saveAsGroupDefault}>Save {WEEKDAYS[weekPick]} as the pay week for {group.name}</button> so everyone uses it, including overtime and compliance checks.</p>
            )}
            {misaligned && (
              <Banner kind="warn">
                <span>The schedule starts on a {WEEKDAYS[startDow]}, but the pay week starts on {WEEKDAYS[weekStart]}. The first and last weeks would be part weeks, and people may not reach their full contract hours.</span>
                <button type="button" className="ml-2 underline font-semibold" onClick={() => setWeekStart(startDow)}>Use a {WEEKDAYS[startDow]} pay week</button>
              </Banner>
            )}
          </Section>

          <Section title="Who and what">
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
          </Section>

          <Section title="Priorities">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              {PRESETS.map((p) => (
                <button key={p.id} type="button" onClick={() => { setW(p.w); setCustom(false); }} className={`text-left rounded-lg border px-3 py-2 ${preset?.id === p.id && !custom ? 'border-[#1A1A1A] bg-[#FAFAF8]' : 'border-[#E5E5E0] hover:bg-[#FAFAF8]'}`}>
                  <div className="text-[13px] font-semibold">{p.label}</div>
                  <div className="text-[11px] text-[#737373]">{p.hint}</div>
                </button>
              ))}
            </div>
            <button type="button" className="text-[12px] underline flex items-center gap-1" onClick={() => setCustom(!custom)}>
              {custom ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}{custom ? 'Hide the sliders' : preset ? 'Fine-tune with sliders' : 'Custom mix: show the sliders'}
            </button>
            {(custom || !preset) && (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-x-8 gap-y-3">
                {WEIGHTS.map((x) => (
                  <div key={x.k}>
                    <div className="flex justify-between text-[12px]"><span className="font-semibold">{x.label}</span><span className="font-mono text-[#737373]">{w[x.k]}</span></div>
                    <input type="range" min={0} max={100} value={w[x.k]} onChange={(e) => setW({ ...w, [x.k]: Number(e.target.value) })} className="w-full accent-[#171717]" />
                    <div className="text-[11px] text-[#737373]">{x.hint}</div>
                  </div>
                ))}
              </div>
            )}
            <p className="text-[11px] text-[#737373]">Always enforced, never traded off: one shift a day, rest between shifts, weekly maximum, days in a row, days per week, availability, approved time off and template days.</p>
          </Section>

          <div className="border-t border-[#E5E5E0] pt-3">
            <button type="button" className="text-[13px] font-semibold flex items-center gap-1.5" onClick={() => setAdvanced(!advanced)}>
              {advanced ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}Advanced
              <span className="text-[11px] font-normal text-[#737373]">same start times, week repeat, meals and breaks, solver time</span>
            </button>
            {advanced && (
              <div className="mt-3 space-y-4">
                <div>
                  <div className="text-[12px] font-semibold mb-1.5">Same start and end time every day</div>
                  <div className="flex flex-wrap items-center gap-3 text-[13px]">
                    <div className="flex gap-1.5">
                      {([['REQUIRE', 'Required'], ['PREFER', 'Preferred'], ['OFF', 'Off']] as const).map(([k, label]) => (
                        <button key={k} type="button" className={`px-3 py-1 rounded-md border ${steady.mode === k ? 'bg-[#1A1A1A] text-white border-[#1A1A1A]' : 'border-[#E5E5E0]'}`} onClick={() => setSteady({ ...steady, mode: k })}>{label}</button>
                      ))}
                    </div>
                    {steady.mode !== 'OFF' && (
                      <>
                        <label className="flex items-center gap-1.5">Start may vary by <Select className="!w-auto" value={steady.startToleranceMin} onChange={(e) => setSteady({ ...steady, startToleranceMin: Number(e.target.value) })}>{[0, 15, 30, 60, 120].map((m) => <option key={m} value={m}>{m === 0 ? 'no time' : `${m} min`}</option>)}</Select></label>
                        <label className="flex items-center gap-1.5">End may vary by <Select className="!w-auto" value={steady.endToleranceMin} onChange={(e) => setSteady({ ...steady, endToleranceMin: Number(e.target.value) })}>{[0, 15, 30, 60, 120].map((m) => <option key={m} value={m}>{m === 0 ? 'no time' : `${m} min`}</option>)}</Select></label>
                      </>
                    )}
                  </div>
                  <div className="text-[11px] text-[#737373] mt-1">
                    {steady.mode === 'REQUIRE' ? 'Each person logs in at one usual time for the whole period and finishes at one usual time. This can lower coverage: check “Forecast covered” after generating.'
                      : steady.mode === 'PREFER' ? 'The solver keeps each person to one usual time when it can, but covering the forecast always comes first.' : 'Start and end times can change from day to day.'}
                    {' '}A person’s own setting, and any start time assigned to them, overrides this (Workforce › Employees).
                  </div>
                </div>
                {weeks === 1 && <label className="flex items-center gap-2 text-[13px]" title="For a first schedule with no published schedule before it."><input type="checkbox" checked={repeat} onChange={(e) => setRepeat(e.target.checked)} />Assume the week repeats <span className="text-[11px] text-[#737373]">(the last night’s shifts past midnight cover the first hours of the first day)</span></label>}
                <label className="flex items-center gap-2 text-[13px]"><input type="checkbox" checked={breaksOn} onChange={(e) => setBreaksOn(e.target.checked)} />Place meals and breaks where the phones need people most <span className="text-[11px] text-[#737373]">(within ±{pol.data?.scheduling.breakSlackMin ?? 60} min of their usual place)</span></label>
                <Field label="Solver time" hint="More time can find a better roster. Large groups need 60 seconds or more."><Select value={limit} onChange={(e) => setLimit(Number(e.target.value))}>{[10, 30, 60, 120].map((n) => <option key={n} value={n}>Up to {n} seconds</option>)}</Select></Field>
              </div>
            )}
          </div>
        </Card>

        <div className="lg:sticky lg:top-4 space-y-3">
          <Card title="Ready to generate?" sub={`${fmtShort(from)} to ${fmtShort(to)} · ${included.length} people · ${chosen.length} template${chosen.length === 1 ? '' : 's'}`}>
            <ul className="space-y-1.5 text-[12px]">
              {items.map((it, i) => (
                <li key={i} className="flex items-start justify-between gap-2">
                  <span className={it.ok === true ? 'text-[#2F7D5A]' : it.ok === 'info' ? 'text-[#525252]' : 'text-[#B7791F] font-medium'}>{it.ok === true ? '✓ ' : it.ok === 'info' ? 'i ' : '! '}{it.text}</span>
                  {it.action && <button type="button" className="underline shrink-0" onClick={it.action.onClick}>{it.action.label}</button>}
                </li>
              ))}
            </ul>
            {error && <Banner kind="err">{error}</Banner>}
            {busy && (
              <div className="space-y-1.5" role="status">
                <div className="h-1.5 rounded bg-[#E5E5E0] overflow-hidden"><div className="h-full bg-[#171717] transition-all" style={{ width: `${Math.min(100, (elapsed / (limit + 5)) * 100)}%` }} /></div>
                <ol className="text-[12px] space-y-0.5">
                  {['Preparing shifts and rules', `Looking for the best roster (up to ${limit}s)`, 'Placing meals and breaks, checking the rules'].map((t, i) => (
                    <li key={t} className={i < stage ? 'text-[#2F7D5A]' : i === stage ? 'font-semibold' : 'text-[#A3A3A3]'}>{i < stage ? '✓ ' : i === stage ? '… ' : '· '}{t}</li>
                  ))}
                </ol>
                <div className="text-[11px] text-[#737373]">{Math.round(elapsed)}s elapsed</div>
              </div>
            )}
            {can('schedule:generate')
              ? <Btn variant="primary" className="w-full justify-center" disabled={!ready || busy} onClick={run}><Sparkles className="w-3.5 h-3.5" />{busy ? 'Generating…' : 'Generate schedule'}</Btn>
              : <span className="text-[12px] text-[#737373]">You do not have permission to generate schedules.</span>}
          </Card>
        </div>
      </div>
    </div>
  );
};

const Section: React.FC<{ title: string; children: React.ReactNode }> = ({ title, children }) => (
  <section className="space-y-3">
    <h3 className="text-[11px] font-bold uppercase tracking-wide text-[#737373]">{title}</h3>
    {children}
  </section>
);

/** The headline of the generation report: how it ended and what to look at. The full report is on Schedule Quality. */
const ReportSummary: React.FC<{ report: { status: 'SUCCEEDED' | 'SUCCEEDED_WITH_WARNINGS'; people: { inPool: number; scheduled: number; notScheduled: number }; exceptions: { level: 'WARNING' | 'INFO'; subject: string; message: string }[] } }> = ({ report }) => {
  const warnings = report.exceptions.filter((e) => e.level === 'WARNING');
  return (
    <div className="space-y-2">
      <Banner kind={report.status === 'SUCCEEDED' ? 'ok' : 'warn'}>
        {report.status === 'SUCCEEDED' ? 'Succeeded.' : `Succeeded with ${warnings.length} warning${warnings.length === 1 ? '' : 's'}.`} {report.people.scheduled} of {report.people.inPool} people were given shifts{report.people.notScheduled ? `; ${report.people.notScheduled} were not.` : '.'}
      </Banner>
      {warnings.slice(0, 4).map((e, i) => <p key={i} className="text-[12px] text-[#525252]"><span className="font-semibold">{e.subject}.</span> {e.message}</p>)}
    </div>
  );
};
