/**
 * Scheduling › Generate Schedule. Builds a draft roster that follows the published short-term forecast, using the
 * constraint solver (OR-Tools CP-SAT). Rules are never broken; the priorities decide what to trade off when they conflict.
 *
 * The page is three short sections (Basics, Who and what, Priorities) plus a collapsed Advanced block, with a summary
 * on the right that checks readiness before any solver time is spent and holds the Generate button.
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, CheckCircle2, ChevronDown, ChevronRight, Info, Sparkles, XCircle } from 'lucide-react';
import { addDays, api, ConsistentTimes, CoverageWindow, dayYear, dec, dowOfDay, Employee, nextWeekStart, ScheduleJob, RotationPattern, ScheduleVersion, SchedulingPolicy, ShiftTemplate, VersionMeta } from '../../services/api';
import { useForecast } from '../../services/forecastStore';
import { useApi, usePayWeek } from '../forecasting/hooks';
import { PersonPicker } from '../common/PersonPicker';
import { HelpTip } from '../common/HelpTip';
import { Banner, Btn, Card, Empty, Field, Input, Select } from '../forecasting/ui';
import { JobCard } from './JobCard';
import { TemplatePicker } from './TemplatePicker';
import { automaticChoice, daysText, forecastChoices, forecastTitle, hasOwnName, longDay, monthDay, periodText, shortSpan, type FvAccuracy } from '../../services/liveForecasts';
import { ForecastPicker } from './ForecastPicker';
import { zoneNote } from '../../services/timeZones';
import { crewNote, forecastFix, optionEstimate, optionsNote, overstaffPct, solveNote, solverHeadline, uncoveredFix } from '../../services/generateFixes';
import { Metric } from '../wfm/app-shell';
import { RotationBuild } from './RotationBuild';
import { LIBRARY, type SavedTemplate } from './rotationLibrary';

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

type SharedGroup = { versionId: string; name: string; groupName: string; people: number; examples: { name: string; days: number }[] };
type Readiness = { guests?: { name: string; people: number; scheduled: boolean }[]; shared?: { published: SharedGroup[]; drafts: SharedGroup[]; people: number }; requiredHours: number | null; peakPeople: number | null; uncoveredDays: string[]; projectedDays: string[]; problem: string | null; payWeek: { start: number; source: 'GROUP' | 'COMPANY' | 'DEFAULT'; companyStart: number }; horizon?: { weekStart: string; source: string; confidence: string }[]; estimate?: { people: number; windows: number; seconds: number }; confidenceNote?: string | null };
type Item = { ok: boolean | 'info'; /** shown as a caution, but does not stop the build */ warn?: boolean; text: string; /** a short headline and one line; `text` then becomes the explanation behind "Details" */ title?: string; short?: string; action?: { label: string; onClick: () => void }; /** what would put it right, one button each (the first is the main fix) */ actions?: { label: string; onClick: () => void }[] };

export const GeneratePanel: React.FC<{ versions: ScheduleVersion[]; onCreated: (v: ScheduleVersion) => void; go: (sub: string) => void }> = ({ versions, onCreated, go }) => {
  const { group, can, go: goModule, session } = useForecast();
  const sitesApi = useApi<{ id: string; name: string; timezone: string }[]>('/config/sites');
  const fcs = useApi<VersionMeta[]>(group ? `/forecast/versions?groupId=${group.id}` : null);
  const fcAcc = useApi<(FvAccuracy & { versionId: string })[]>(group ? `/forecast/versions-accuracy?groupId=${group.id}` : null);
  const accuracyOf = useMemo(() => Object.fromEntries((fcAcc.data ?? []).map((a) => [a.versionId, a])), [fcAcc.data]);
  const tpls = useApi<ShiftTemplate[]>('/scheduling/templates');
  // counts and hours only, however large the group: the people themselves are never downloaded here
  const emps = useApi<{ people: number; weeklyHours: number; teams: { id: string; name: string; people: number; weeklyHours: number }[] }>(group ? `/workforce/employees/summary?groupId=${group.id}&status=ACTIVE` : null);
  const coverageWindows = useApi<CoverageWindow[]>(group ? `/config/groups/${group.id}/coverage-windows` : null);
  const [coverageSource, setCoverageSource] = useState<'FORECAST' | 'MANUAL'>('FORECAST');
  const [fcPick, setFcPick] = useState<string>('AUTO');        // which forecast the schedule follows: 'AUTO' = the live one that covers the dates, or a chosen version
  const [showOldFc, setShowOldFc] = useState(false);
  const [showDraftFc, setShowDraftFc] = useState(false);      // forecasts that are not published yet stay hidden unless asked for
  useEffect(() => { setFcPick('AUTO'); }, [group?.id]);
  const savedWeek = usePayWeek(group?.id);                 // a new schedule starts on the first day of the group's pay week, not always a Monday
  const [fromPick, setFrom] = useState<string | null>(null);
  const from = fromPick ?? nextWeekStart(savedWeek, 0);
  const [weeks, setWeeks] = useState(1);
  const [guestsMode, setGuestsMode] = useState<'AFTER_HOME' | 'ALWAYS'>('AFTER_HOME');   // people whose home group is another one
  const [customOn, setCustomOn] = useState(false);   // "Custom…" picked in How far ahead, even if the number matches a preset
  // a range past four weeks is built in the background, window by window; the first `solveWeeks` are solved shift by shift and the rest repeat the last solved cycle
  const [solveWeeksPick, setSolveWeeksPick] = useState<number | null>(null);
  const [solverPick, setSolverPick] = useState('AUTO');
  const [jobId, setJobId] = useState<string | null>(null);
  const long = weeks > 4;

  // People who follow a rotation pattern are not silently treated like everyone else: the planner says how this build should treat them.
  const [patTick, setPatTick] = useState(0);
  const pats = useApi<RotationPattern[]>(group ? `/scheduling/rotations?groupId=${group.id}` : null, [group?.id, patTick]);
  const crewPats = (pats.data ?? []).filter((p) => p.status === 'ACTIVE' && p.memberCount > 0);
  const crewPeople = crewPats.reduce((n, p) => n + p.memberCount, 0);
  const fillable = crewPats.filter((p) => !!p.versionId);
  const [rotChoice, setRotChoice] = useState<'' | 'INCLUDE' | 'FILL' | 'ROTATION'>('');
  // the group's own pattern (set on the WFM group) is the one picked unless the planner picks another
  const activePats = (pats.data ?? []).filter((p) => p.status === 'ACTIVE');
  const library = useApi<SavedTemplate[]>(group?.defaultRotationRef ? '/scheduling/rotations/templates' : null, [group?.defaultRotationRef]);
  const defaultRef = group?.defaultRotationRef ?? null;
  const defaultPat = defaultRef ? activePats.find((p) => p.templateRef === defaultRef) ?? null : null;
  const defaultLabel = defaultRef ? LIBRARY.find((p) => p.id === defaultRef)?.label ?? library.data?.find((t) => t.id === defaultRef)?.name ?? 'the pattern chosen for this group' : '';
  const [patId, setPatId] = useState('');
  useEffect(() => { setRotChoice(''); setPatId(''); }, [group?.id]);
  const selPat = activePats.find((p) => p.id === patId) ?? defaultPat ?? crewPats[0] ?? activePats[0] ?? null;
  const fillPattern = fillable.find((p) => p.id === selPat?.id) ?? fillable[0] ?? null;
  const rotationOk = crewPeople === 0 || rotChoice === 'INCLUDE' || rotChoice === 'ROTATION' || (rotChoice === 'FILL' && !!fillPattern && !long);
  const solveWeeks = Math.min(weeks, solveWeeksPick ?? Math.min(weeks, 13));
  // The pay week (Monday 0 ... Sunday 6) comes from the saved setting for this group, else the company's. Picking another day here applies to this run only.
  const [weekPick, setWeekPick] = useState<number | null>(null);
  const [saved, setSaved] = useState(0);              // bumped after saving, to read the saved pay week again
  useEffect(() => { setWeekPick(null); }, [group?.id]);
  const [limit, setLimit] = useState(60);
  const [skip, setSkip] = useState<string[]>([]);
  const [scope, setScope] = useState<'ALL' | 'TEAM' | 'EMPLOYEE'>('ALL');
  const [skipTeam, setSkipTeam] = useState<string[]>([]);
  const [skipEmp, setSkipEmp] = useState<Employee[]>([]);   // people left out under "By employee"
  const [w, setW] = useState<Record<string, number>>(PRESETS[0].w);
  const [custom, setCustom] = useState(false);
  // Same start and end every day for the whole period: starts from the company setting (Configuration › Scheduling Rules). A person's own setting still wins.
  const [steady, setSteady] = useState<ConsistentTimes>({ mode: 'OFF', startToleranceMin: 0, endToleranceMin: 0 });
  const [breaksOn, setBreaksOn] = useState(true);
  const [confidence, setConfidence] = useState(50);   // how sure to be of having enough people: 50 = the forecast as published, 90 = its busy-day (P90) volume
  const [repeat, setRepeat] = useState(false);       // a first schedule with nothing before it: assume the week repeats
  const [advanced, setAdvanced] = useState(false);
  const [showPrio, setShowPrio] = useState(false);
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
  const chosenFc = coverageSource === 'FORECAST' && fcPick !== 'AUTO' ? fcPick : null;
  const readiness = useApi<Readiness>(group ? `/scheduling/readiness?groupId=${group.id}&from=${from}&weeks=${weeks}&coverageSource=${coverageSource}&timeLimitSec=${limit}&solveWeeks=${solveWeeks}${chosenFc ? `&forecastVersionId=${chosenFc}` : ''}` : null, [from, weeks, coverageSource, group?.id, saved, limit, solveWeeks, chosenFc]);
  const running = useApi<ScheduleJob[]>(group ? `/scheduling/jobs?groupId=${group.id}&active=true` : null, [group?.id]);
  useEffect(() => { if (!jobId && running.data?.length) setJobId(running.data[0].id); }, [running.data]);
  const weekStart = weekPick ?? readiness.data?.payWeek.start ?? 0;
  const setWeekStart = (n: number) => setWeekPick(n === readiness.data?.payWeek.start ? null : n);
  const payWeek = readiness.data?.payWeek;
  const saveAsGroupDefault = async () => {
    if (!group || weekPick === null) return;
    try { await api(`/config/groups/${group.id}`, { method: 'PUT', body: { payWeekStart: weekPick } }); setWeekPick(null); setSaved((n) => n + 1); } catch (e: any) { setError(e.message); }
  };

  // several short-term forecasts can be live, each for its own period: the schedule follows the one chosen, or (Automatic) the live one that covers its dates
  const choices = useMemo(() => forecastChoices({ from, to: addDays(from, weeks * 7 - 1), forecasts: fcs.data ?? [], withArchived: showOldFc }), [fcs.data, from, weeks, showOldFc]);
  const picked = fcPick === 'AUTO' ? null : (fcs.data ?? []).find((v) => v.id === fcPick) ?? null;
  const followed = fcPick === 'AUTO' ? automaticChoice(choices)?.fv : picked;
  const published = (followed as VersionMeta | undefined) ?? fcs.data?.find((v) => v.kind === 'SHORT' && v.status === 'PUBLISHED');
  const liveSpan = (() => { const l = (fcs.data ?? []).filter((v) => v.kind === 'SHORT' && v.status === 'PUBLISHED'); return l.length ? { from: l.map((v) => v.fromDay).sort()[0], to: l.map((v) => v.toDay).sort().at(-1)! } : null; })();
  const pickedChoice = picked ? choices.find((c) => c.fv.id === picked.id) : null;
  /** the dates the schedule may start on: those of the forecast chosen, else the whole stretch the live forecasts reach */
  const dateLimit = picked ? { from: picked.fromDay, to: picked.toDay } : liveSpan ?? (published ? { from: published.fromDay, to: published.toDay } : null);
  const active = (tpls.data ?? []).filter((t) => t.status === 'ACTIVE');
  const chosen = active.filter((t) => !skip.includes(t.id));
  const teamsInGroup: [string, string][] = (emps.data?.teams ?? []).map((t) => [t.id, t.name]);
  const keptTeams = (emps.data?.teams ?? []).filter((t) => !skipTeam.includes(t.id));
  const includedCount = scope === 'ALL' ? emps.data?.people ?? 0 : scope === 'TEAM' ? keptTeams.reduce((n, t) => n + t.people, 0) : Math.max(0, (emps.data?.people ?? 0) - skipEmp.length);

  // hours people are contracted for across these dates, against what the staffing target needs
  const contractHours = (scope === 'ALL' ? emps.data?.weeklyHours ?? 0 : scope === 'TEAM' ? keptTeams.reduce((n, t) => n + t.weeklyHours, 0) : (emps.data?.weeklyHours ?? 0) - skipEmp.reduce((n, e) => n + e.weeklyContractHours, 0)) * weeks;
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

  // when the forecast does not cover the dates, say what would fix it and offer it as a button
  const fix = coverageSource === 'FORECAST' && fcs.data ? forecastFix({ from, weeks, weekStart, forecasts: fcs.data }) : { kind: 'NONE' as const };
  const fixActions: { label: string; onClick: () => void }[] = [];
  if (fix.kind === 'START') fixActions.push({ label: fix.label, onClick: () => setFrom(fix.startDay) });
  if (fix.kind === 'DRAFT') fixActions.push({ label: fix.label, onClick: () => goModule('all-forecasts', 'forecasting') });
  if (fix.kind === 'BUILD' && can('forecast:create')) fixActions.push({ label: fix.label, onClick: () => goModule('forecast-builder', 'forecasting') });
  if (fix.kind !== 'NONE' && (coverageWindows.data?.length ?? 0) > 0) fixActions.push({ label: 'Use manual coverage windows', onClick: () => setCoverageSource('MANUAL') });
  const coverageReady = coverageSource === 'FORECAST' ? !!published : (coverageWindows.data?.length ?? 0) > 0;
  const startDow = dowOfDay(from);
  const misaligned = startDow !== weekStart;
  const hasPriorPublished = versions.some((v) => v.wfmGroupId === group?.id && v.status === 'PUBLISHED' && v.periodEnd >= addDays(from, -1) && v.periodStart < from);
  const ready = coverageReady && chosen.length > 0 && includedCount > 0 && !(readiness.data?.problem && coverageSource === 'FORECAST') && rotationOk;

  const items: Item[] = [
    coverageSource === 'FORECAST' && picked
      ? (pickedChoice?.covers === 'ALL'
        ? (picked.status === 'PUBLISHED' ? { ok: true as const, text: `Forecast: ${picked.name}` }
          : { ok: 'info' as const, warn: true, title: `Forecast v${picked.seq} is not published`, short: 'The schedule is built on a forecast still under review', text: `Forecast v${picked.seq} is ${picked.status === 'DRAFT' ? 'still a draft' : picked.status === 'SUBMITTED' ? 'waiting for approval' : picked.status === 'APPROVED' ? 'approved but not published' : 'archived'}. The schedule is built on it anyway, and is marked as built on a forecast that is not live.` })
        : { ok: false as const, text: pickedChoice ? pickedChoice.note : `Forecast v${picked.seq} does not cover these dates`, actions: [{ label: 'Follow the live forecast automatically', onClick: () => setFcPick('AUTO') }] })
      : coverageSource === 'FORECAST'
      ? (published && fix.kind === 'NONE' ? { ok: true as const, text: `Forecast: ${forecastTitle(published)}${hasOwnName(published) ? ` (v${published.seq})` : ''}` }
        : { ok: false as const, text: fix.kind === 'NONE' ? 'No published short-term forecast' : fix.text, actions: fixActions })
      : { ok: (coverageWindows.data?.length ?? 0) > 0, text: (coverageWindows.data?.length ?? 0) > 0 ? `${coverageWindows.data?.length} coverage window${coverageWindows.data?.length === 1 ? '' : 's'} set` : 'No coverage windows set for this group', action: (coverageWindows.data?.length ?? 0) === 0 ? { label: 'WFM Groups', onClick: () => goModule('wfm-groups', 'configuration') } : undefined },
    { ok: chosen.length > 0, text: chosen.length ? `${chosen.length} shift template${chosen.length === 1 ? '' : 's'} chosen` : 'No shift templates chosen', action: chosen.length === 0 ? { label: 'Shift Templates', onClick: () => go('shift-templates') } : undefined },
    { ok: includedCount > 0, text: includedCount ? `${includedCount} of ${emps.data?.people ?? 0} active people included` : 'No employees in this group', action: includedCount === 0 ? { label: 'Employees', onClick: () => goModule('employees', 'workforce') } : undefined },
  ];
  if (readiness.data?.problem && coverageSource === 'FORECAST') items.push({ ok: false, text: readiness.data.problem });
  if (needHours !== null && includedCount) {
    const diff = contractHours - needHours, pct = needHours ? Math.round((diff / needHours) * 100) : 0;
    const note = crewNote({ people: includedCount, contractHours, neededHours: needHours });
    if (note) {
      // far more contract time than the forecast needs: said before the build, not only after it
      items.push({ ok: 'info', warn: true, text: note.text, title: 'Contracts exceed demand', short: `${Math.round(contractHours).toLocaleString('en-US')} h contracted, about ${Math.round(needHours).toLocaleString('en-US')} h needed. About ${note.neededPeople} of ${includedCount} people would cover it.`, actions: (w.contractHours ?? 0) > 40 ? [{ label: 'Lower "Meet contract hours"', onClick: () => { setW({ ...w, contractHours: 40 }); setCustom(true); } }] : undefined });
    } else items.push(diff >= 0
      ? { ok: true, text: `Needs ${Math.round(needHours).toLocaleString()} h; contracts give ${Math.round(contractHours).toLocaleString()} h (${pct}% to spare)` }
      : { ok: false, text: `Needs ${Math.round(needHours).toLocaleString()} h but contracts give only ${Math.round(contractHours).toLocaleString()} h: expect a shortfall` });
  }
  // too many shift choices for the optimiser: said before the build, not only after it
  const searchNote = includedCount && chosen.length ? optionsNote(optionEstimate({ people: includedCount, days: weeks * 7, templates: chosen })) : null;
  if (searchNote) items.push({ ok: 'info', warn: true, text: searchNote, title: 'Large search', short: 'The roster may be rough. Fewer templates, start times or people will help.' });
  for (const g of readiness.data?.guests ?? []) items.push({ ok: g.scheduled || guestsMode === 'ALWAYS' ? 'info' : false, title: g.scheduled || guestsMode === 'ALWAYS' ? `${g.people} from ${g.name} can work here` : `${g.people} ${g.people === 1 ? 'person' : 'people'} held back (from ${g.name})`, short: guestsMode === 'ALWAYS' ? 'Used even if their home group is not scheduled' : g.scheduled ? 'They get the time their home group leaves free' : 'Their home group has no schedule for these dates yet', text: `${g.people} ${g.people === 1 ? 'person' : 'people'} from ${g.name} (their home group) can work here. ${guestsMode === 'ALWAYS' ? 'They are used even if their home group is not scheduled.' : g.scheduled ? 'They get the time their home group leaves free.' : 'Their home group has no schedule for these dates yet, so they are held back until it has one.'}` });
  const sharedWho = (g: SharedGroup) => `${g.examples.map((e) => e.name).join(', ')}${g.people > g.examples.length ? ` and ${g.people - g.examples.length} more` : ''}`;
  for (const g of readiness.data?.shared?.drafts ?? []) items.push({ ok: false, title: `${g.people} ${g.people === 1 ? 'person is' : 'people are'} also in the ${g.groupName} draft`, short: 'Whichever draft is published first gets them', text: `Another draft (${g.groupName}) plans ${g.people} of the same ${g.people === 1 ? 'person' : 'people'} for these dates: ${sharedWho(g)}. Whichever is published first takes them.` });
  for (const g of readiness.data?.shared?.published ?? []) items.push({ ok: 'info', title: `${g.groupName} has published shifts for ${g.people} of them`, short: 'That time counts toward their limits here', text: `${g.groupName} has published shifts for ${g.people} of this group's ${g.people === 1 ? 'person' : 'people'} in these dates (${sharedWho(g)}). That time counts toward their limits here.` });
  if (readiness.data?.uncoveredDays.length) {
    const uf = coverageSource === 'FORECAST' ? uncoveredFix(readiness.data.uncoveredDays, published, weekStart) : null;
    items.push({ ok: false, text: `No staffing target for ${readiness.data.uncoveredDays.length} day${readiness.data.uncoveredDays.length === 1 ? '' : 's'}`, actions: uf ? [uf.kind === 'START' ? { label: uf.label, onClick: () => setFrom(uf.startDay) } : { label: uf.label, onClick: () => goModule('forecast-builder', 'forecasting') }] : undefined });
  }
  if (readiness.data?.projectedDays.length) items.push({ ok: 'info', text: `${readiness.data.projectedDays.length} day${readiness.data.projectedDays.length === 1 ? ' is' : 's are'} beyond the short-term forecast: staffed from the long-term forecast` });
  if (!long && readiness.data?.estimate) items.push({ ok: 'info', text: solveNote(readiness.data.estimate, limit) });
  if (long && readiness.data?.estimate) {
    const m = Math.max(1, Math.round(readiness.data.estimate.seconds / 60));
    items.push({ ok: 'info', text: `Builds in the background in about ${m} minute${m === 1 ? '' : 's'} (${readiness.data.estimate.windows} four-week window${readiness.data.estimate.windows === 1 ? '' : 's'} for ${readiness.data.estimate.people} people). It keeps running if you leave this page.` });
    if (readiness.data.confidenceNote) items.push({ ok: 'info', text: readiness.data.confidenceNote });
  }
  items.push(misaligned
    ? { ok: false, title: 'Pay week does not match the start day', short: `The schedule starts on ${WEEKDAYS[startDow]}, the pay week on ${WEEKDAYS[weekStart]}`, text: `Starts on a ${WEEKDAYS[startDow]} but the pay week starts on ${WEEKDAYS[weekStart]}: people may not reach full contract hours`, action: { label: `Use ${WEEKDAYS[startDow]} week`, onClick: () => setWeekStart(startDow) } }
    : { ok: true, text: `Pay week starts on ${WEEKDAYS[weekStart]}, the same day the schedule starts` });
  if (weeks === 1 && !hasPriorPublished && !repeat) items.push({ ok: 'info', text: 'No published schedule before this date, so nobody carries a night shift into the first day', action: { label: 'Assume the week repeats', onClick: () => { setRepeat(true); setAdvanced(true); } } });
  const zoneCheck = group ? zoneNote({ zone: group.timezone, siteZone: sitesApi.data?.find((s) => s.id === group.siteId)?.timezone ?? null, siteName: sitesApi.data?.find((s) => s.id === group.siteId)?.name ?? null, orgZone: session?.tenant?.timezone ?? null }) : null;
  if (zoneCheck?.kind === 'check') items.push({ ok: 'info', warn: true, title: 'Check the time zone', short: `The group runs on ${group!.timezone}`, text: zoneCheck.text, action: { label: 'Open WFM Groups', onClick: () => goModule('wfm-groups', 'configuration') } });
  if (gaps.length) items.push({ ok: 'info', text: `No chosen template covers ${gaps.slice(0, 3).join(', ')}. Fine if the phones are closed then.` });

  // the checklist in three groups: things to fix, things worth a look, and what is fine
  const attention = items.filter((i) => i.ok === false);
  const worth = items.filter((i) => i.ok === 'info' && i.warn);
  const passed = items.filter((i) => i.ok === true || (i.ok === 'info' && !i.warn));
  const review = attention.length + worth.length;

  const run = async () => {
    if (!group) return;
    setBusy(true); setError(''); setResult(null);
    try {
      const body = {
        ...(rotChoice === 'FILL' && fillPattern?.versionId ? { fillFromVersionId: fillPattern.versionId } : {}),
        guests: guestsMode, groupId: group.id, from, weeks, ...(weekPick !== null ? { weekStart: weekPick } : {}), timeLimitSec: limit, weights: w, consistentTimes: steady, optimizeBreaks: breaksOn, assumeRepeat: repeat && weeks === 1, templateIds: chosen.map((t) => t.id), coverageSource, solver: solverPick, ...(coverageSource === 'FORECAST' ? { confidence } : {}), ...(chosenFc ? { forecastVersionId: chosenFc } : {}),
        ...(scope === 'EMPLOYEE' && skipEmp.length ? { excludeEmployeeIds: skipEmp.map((e) => e.id) } : {}),
        ...(scope === 'TEAM' ? { teamIds: teamsInGroup.filter(([id]) => !skipTeam.includes(id)).map(([id]) => id) } : {}),
      };
      if (long) {                                    // a background job: the answer arrives through the progress card
        const j = await api<ScheduleJob>('/scheduling/jobs', { method: 'POST', body: { ...body, windowWeeks: 4, solveWeeks } });
        setJobId(j.id); setBusy(false);
        return;
      }
      try {
        const v = await api<ScheduleVersion>('/scheduling/versions', { method: 'POST', body });
        setResult(v); onCreated(v);
      } catch (e: any) {
        // too big to answer while waiting: the same request runs as a background job and reports through the progress card
        if (!String(e?.message).includes('while you wait')) throw e;
        const j = await api<ScheduleJob>('/scheduling/jobs', { method: 'POST', body: { ...body, windowWeeks: 4, solveWeeks } });
        setJobId(j.id);
      }
    } catch (e: any) { setError(e.message); } finally { setBusy(false); }
  };
  const jobFinished = async (j: ScheduleJob) => {
    if (j.status === 'DONE' && j.versionId) { try { const v = await api<ScheduleVersion>(`/scheduling/versions/${j.versionId}`); setResult(v); onCreated(v); } catch (e: any) { setError(e.message); } }
  };
  const solver = result?.stats.solver;

  if (!group) return <Empty title="No WFM group yet">Create a WFM group first (Configuration).</Empty>;

  const preset = PRESETS.find((p) => sameWeights(w, p.w));
  const stage = elapsed < 4 ? 0 : elapsed < limit ? 1 : 2;
  const thisYear = new Date().getFullYear();      // a year is written in a date only when it is not this one
  const startOk = /^\d{4}-\d{2}-\d{2}$/.test(from);   // the date box is empty while a date is half typed

  return (
    <div className="space-y-6">
      {jobId && <JobCard jobId={jobId} canCancel={can('schedule:generate')} onFinished={jobFinished} />}
      {result && solver && (
        <div ref={resultRef}>
          <Card title={`Created ${result.name}`} sub="A draft. Review it on the timeline, fix anything flagged, then publish.">
            {(() => {
              // the same tiles as the Forecast Dashboard; "covered" alone hides overstaffing, so the paid time is set against what the forecast needs
              const st = result.stats, rosterOnly = !!result.settings?.report?.exceptions?.some((e: any) => e.code === 'STARTING_ROSTER');
              const over = overstaffPct(st.hours.paid, st.hours.required ?? 0), cov = st.coverage.percent;
              const detail = solver.status === 'OPTIMAL' ? '' : solver.windowed ? ' · built one week at a time, not proven best for the whole plan' : rosterOnly ? ' · the optimiser found nothing better than its starting roster in the time given; it may already be close to the best' : ` · within ${dec(solver.gap * 100, 1)}% of best`;
              const terms = solver.score != null ? ` · score ${Math.round(solver.score).toLocaleString()} (lower is better${solver.scoreTerms?.length ? `: ${[...solver.scoreTerms].sort((x, y) => Math.abs(y.value) - Math.abs(x.value)).slice(0, 3).map((t) => `${t.name.replace('_', ' ')} ${Math.round(t.value).toLocaleString()}`).join(', ')}` : ''})` : '';
              return (
                <div className="grid grid-cols-2 divide-x divide-y rounded-lg border md:grid-cols-3 xl:grid-cols-5 xl:divide-y-0" data-testid="result-tiles">
                  <Metric label="Forecast covered" value={`${dec(cov, 1)}%`} hint={`${st.coverage.underIntervals} intervals short`} delta={over >= 15 ? `Overstaffed: ${over}% more paid time than needed` : cov >= 95 ? 'On target' : cov >= 85 ? 'A little short' : 'Short of the forecast'} tone={over >= 15 || (cov < 95 && cov >= 85) ? 'warning' : cov >= 95 ? 'success' : 'critical'} />
                  <Metric label="Shifts" value={st.shifts} hint={`${st.people} people`} />
                  <Metric label="Paid hours" value={dec(st.hours.paid, 0)} hint={st.hours.required ? `${dec(st.hours.required, 0)} h needed on shift` : undefined} delta={st.hours.overtime > 0 ? `${dec(st.hours.overtime, 0)} h above contract` : over >= 15 ? `${over}% more than the ${dec(st.hours.required ?? 0, 0)} h needed on shift` : undefined} tone={st.hours.overtime > 0 || over >= 15 ? 'warning' : undefined} />
                  <Metric label="Rule violations" value={st.violations} hint={st.violations ? undefined : 'none'} delta={st.violations ? 'must be fixed to publish' : undefined} tone={st.violations ? 'critical' : undefined} />
                  <Metric label="Solver" value={<span className="text-[18px]">{solverHeadline(solver.status, rosterOnly)}</span>} hint={`${solver.wallSec}s · ${solver.candidates.toLocaleString()} options${detail}${solver.backend && solver.backend !== 'cpsat' ? ` · answered by ${solver.backend}` : ''}${terms}`} delta={rosterOnly ? 'Nothing better found in the time given' : undefined} tone={rosterOnly ? 'warning' : undefined} />
                </div>
              );
            })()}
            {solver.backend && solver.backend !== 'cpsat' && <Banner kind="warn">The main solver could not answer this one, so a backup ({solver.backend}) built it. {solver.attempts?.join('; ')}</Banner>}
            {result.stats.uncoveredDays && result.stats.uncoveredDays.length > 0 && <Banner kind="warn">Neither forecast covers {daysText(result.stats.uncoveredDays, thisYear)}, so those days have no staffing target.</Banner>}
            {result.stats.projectedDays && result.stats.projectedDays.length > 0 && <Banner kind="warn">{daysText(result.stats.projectedDays, thisYear)} {result.stats.projectedDays.length > 1 ? 'are' : 'is'} beyond the short-term forecast's reach — staffed from the long-term forecast projected onto intervals by historical shape, lower confidence than a normal day.</Banner>}
            {result.settings?.report && <ReportSummary report={result.settings.report} />}
            <div className="flex flex-wrap gap-2">
              <Btn variant="primary" onClick={() => go('schedule-timeline')}>Open timeline</Btn>
              {result.settings?.plan && <Btn onClick={() => go('year-plan')}>Open the year plan</Btn>}
              <Btn onClick={() => go('schedule-quality')}>See score, shortages and full report</Btn>
            </div>
          </Card>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_340px] gap-6 items-start">
        <Card title="Generate a schedule" sub={`For ${group.name}. A new numbered draft is created; nothing published changes until you publish it.`}>
          {(activePats.length > 0 || defaultRef) && (
            <Section title="Rotation pattern">
              {activePats.length > 0 && (
                <Field label="Rotation pattern" topic="rotation" hint={defaultPat ? `${defaultPat.name} is this group's own pattern, set on the WFM group.` : 'Used when you choose a rotation below.'}>
                  <Select value={selPat?.id ?? ''} onChange={(e) => setPatId(e.target.value)}>
                    {activePats.map((p) => <option key={p.id} value={p.id}>{p.name}{p.id === defaultPat?.id ? ' (group default)' : ''} ({p.memberCount} {p.memberCount === 1 ? 'person' : 'people'})</option>)}
                  </Select>
                </Field>
              )}
              {defaultRef && !defaultPat && (
                <div className="flex flex-wrap items-center gap-3 text-[12px] text-[#525252]">
                  <span>This group's pattern is {defaultLabel}. It has not been set up for the group yet, with its shifts and people.</span>
                  <Btn type="button" onClick={() => go('rotations')}>Set it up</Btn>
                </div>
              )}
            </Section>
          )}

          {crewPeople > 0 && (
            <Section title="How to build">
              <div role="radiogroup" aria-label="How to build this schedule" className="grid grid-cols-1 md:grid-cols-3 gap-3">
                {([
                  ['INCLUDE', 'From the forecast', 'Everyone is scheduled to match the forecast. People on a rotation are included like everyone else.', ''],
                  ['ROTATION', 'Follow a rotation pattern', 'Generate the roster from a fixed cycle for the people on it. It does not use the forecast.', ''],
                  ['FILL', 'Rotation plus forecast', 'The rotation covers its share. The forecast build schedules the other people for what it leaves short.',
                    !fillable.length ? 'No rotation roster has been generated yet. Choose "Follow a rotation pattern" first.' : long ? 'Available for builds of up to 4 weeks.' : ''],
                ] as const).map(([k, title, text, off]) => (
                  <button
                    key={k} type="button" role="radio" aria-checked={rotChoice === k} disabled={!!off} onClick={() => setRotChoice(k)}
                    className={`text-left rounded-lg border p-3 ${rotChoice === k ? 'border-[#171717] ring-1 ring-[#171717] bg-white' : off ? 'border-[#E5E5E0] bg-[#FAFAF8] text-[#A3A3A3] cursor-not-allowed' : 'border-[#E5E5E0] bg-white hover:border-[#A3A3A3]'}`}
                  >
                    <div className={`text-[13px] font-semibold ${off ? 'text-[#737373]' : 'text-[#171717]'}`}>{title}</div>
                    <div className="text-[12px] mt-0.5">{text}</div>
                    {off && <div className="text-[11px] text-[#8F6200] mt-1.5">{off}</div>}
                  </button>
                ))}
              </div>
              <p className="text-[12px] text-[#525252]">{crewPeople} {crewPeople === 1 ? 'person' : 'people'} in this group follow a rotation pattern: {crewPats.map((p) => `${p.name} (${p.memberCount})`).join(', ')}.</p>
              {rotChoice === 'FILL' && fillPattern && <p className="text-[12px] text-[#525252]">Fills around {fillPattern.name}{fillPattern.materializedThrough ? `, whose roster runs to ${monthDay(fillPattern.materializedThrough, thisYear)}` : ''}.{selPat && selPat.id !== fillPattern.id ? ` ${selPat.name} has no roster yet, so ${fillPattern.name} is used.` : ''}</p>}
            </Section>
          )}

          {rotChoice === 'ROTATION' ? (
            <RotationBuild patterns={activePats} selectedId={selPat?.id} canGenerate={can('schedule:generate')} go={go} onChanged={() => setPatTick((t) => t + 1)} />
          ) : (
          <>
          <Section title="Basics">
            <div>
              <div className="text-[12px] font-semibold mb-1.5">Coverage source</div>
              <div className="flex gap-1.5 text-[13px]">
                <button type="button" className={`px-3 py-1 rounded-md border ${coverageSource === 'FORECAST' ? 'bg-[#1A1A1A] text-white border-[#1A1A1A]' : 'border-[#E5E5E0]'}`} onClick={() => setCoverageSource('FORECAST')}>From forecast</button>
                <button type="button" className={`px-3 py-1 rounded-md border ${coverageSource === 'MANUAL' ? 'bg-[#1A1A1A] text-white border-[#1A1A1A]' : 'border-[#E5E5E0]'}`} onClick={() => setCoverageSource('MANUAL')}>Set manually</button>
              </div>
            </div>
            {coverageSource === 'FORECAST' && (
              <Field label="Forecast to follow" hint={fcPick === 'AUTO' ? undefined : pickedChoice?.note}>
                <div className="space-y-1.5">
                  <ForecastPicker value={fcPick} onChange={setFcPick} choices={choices} accuracy={accuracyOf} yearOf={thisYear} state={fcs.data ? null : fcs.error ? 'error' : 'loading'}
                    showUnapproved={showDraftFc} onShowUnapproved={setShowDraftFc} showOld={showOldFc} onShowOld={setShowOldFc} />
                </div>
              </Field>
            )}
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <Field label="Starts on">
                <div className="space-y-1">
                  <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} min={coverageSource === 'FORECAST' ? dateLimit?.from : undefined} max={coverageSource === 'FORECAST' ? dateLimit?.to : undefined} />
                  {from && <p className="text-[12px] text-[#525252]">{longDay(from)}</p>}
                </div>
              </Field>
              <Field label="Pay week starts on" topic="payWeek" hint={weekPick !== null ? 'For this run only' : payWeek?.source === 'GROUP' ? `Saved for ${group.name}` : payWeek?.source === 'COMPANY' ? 'Company setting' : 'Not set: Monday'}><Select value={weekStart} onChange={(e) => setWeekStart(Number(e.target.value))}>{WEEKDAYS.map((n, i) => <option key={n} value={i}>{n}</option>)}</Select></Field>
              <Field label="How far ahead">
                <div className="space-y-2">
                  <Select
                    value={customOn || ![1, 2, 4, 13, 26, 52].includes(weeks) ? 'custom' : weeks}
                    onChange={(e) => {
                      setSolveWeeksPick(null);
                      if (e.target.value === 'custom') setCustomOn(true);
                      else { setCustomOn(false); setWeeks(Number(e.target.value)); }
                    }}
                  >
                    {([[1, '1 week'], [2, '2 weeks'], [4, '4 weeks'], [13, '13 weeks · quarter'], [26, '26 weeks · 6 months'], [52, '52 weeks · 12 months']] as const).map(([n, label]) => <option key={n} value={n}>{label}</option>)}
                    <option value="custom">Custom…</option>
                  </Select>
                  {(customOn || ![1, 2, 4, 13, 26, 52].includes(weeks)) && (
                    <label className="flex items-center gap-1.5 text-[12px] text-[#6B6B6B]"><Input type="number" min={1} max={52} className="!w-20" value={weeks} onChange={(e) => { setWeeks(Math.min(52, Math.max(1, Number(e.target.value) || 1))); setSolveWeeksPick(null); }} aria-label="Weeks" /> weeks</label>
                  )}
                  {startOk && <p className="text-[12px] text-[#6B6B6B]">{periodText(from, to, thisYear)} · {weeks} {weeks === 1 ? 'week' : 'weeks'}</p>}
                  {startOk && coverageSource === 'FORECAST' && (readiness.data?.uncoveredDays.length ?? 0) > 0 && (
                    <p className="text-[12px] text-[#8F6200]">No forecast for {readiness.data!.uncoveredDays.length} {readiness.data!.uncoveredDays.length === 1 ? 'day' : 'days'} ({daysText(readiness.data!.uncoveredDays, thisYear)}), so {readiness.data!.uncoveredDays.length === 1 ? 'it has' : 'they have'} no staffing target.</p>)}
                </div>
              </Field>
            </div>
            {coverageSource === 'FORECAST' && (
              <Field label="How sure to be of having enough people" topic="confidence" keepHint hint={confidence <= 50 ? 'Staff to the forecast as published: right on a normal day, short when it runs busy' : `Staff for a busier day than the forecast: about ${confidence} days in 100 are covered, at the cost of more people on shift`}>
                <Select value={confidence} onChange={(e) => setConfidence(Number(e.target.value))}>
                  <option value={50}>Forecast as published</option>
                  <option value={75}>Some safety margin (75%)</option>
                  <option value={90}>Busy-day cover (90%)</option>
                  <option value={95}>Very safe (95%)</option>
                </Select>
              </Field>
            )}
            {long && (
              <div className="rounded-lg border border-[#E5E5E0] bg-[#FAFAF8] p-3 space-y-2">
                <div className="text-[12px] font-semibold">Long range<HelpTip topic="longSchedule" /></div>
                <label className="flex flex-wrap items-center gap-2 text-[13px]">Solve the first
                  <Select className="!w-auto" value={solveWeeks} onChange={(e) => setSolveWeeksPick(Number(e.target.value))}>{[...new Set([4, 8, 13, 26, weeks].filter((n) => n <= weeks))].sort((a, b) => a - b).map((n) => <option key={n} value={n}>{n === weeks ? `all ${n} weeks (slowest)` : `${n} weeks`}</option>)}</Select>
                  shift by shift{solveWeeks < weeks ? ', then repeat that pattern' : ''}
                </label>
              </div>
            )}
            {weekPick !== null && can('config:write') && (
              <p className="text-[12px] text-[#525252]">This run uses a {WEEKDAYS[weekPick]} pay week. <button type="button" className="underline font-semibold" onClick={saveAsGroupDefault}>Save {WEEKDAYS[weekPick]} as the pay week for {group.name}</button><HelpTip text="So everyone uses it, including overtime and compliance checks." /></p>
            )}
            {misaligned && (
              <Banner kind="warn">
                <span>The schedule starts on a {WEEKDAYS[startDow]}, but the pay week starts on {WEEKDAYS[weekStart]}. The first and last weeks would be part weeks, and people may not reach their full contract hours.</span>
                <button type="button" className="ml-2 underline font-semibold" onClick={() => setWeekStart(startDow)}>Use a {WEEKDAYS[startDow]} pay week</button>
              </Banner>
            )}
          </Section>

          <Section title="Who and what">
            <TemplatePicker templates={active} skip={skip} setSkip={setSkip} />
            <div>
              <div className="text-[12px] font-semibold mb-1.5">Who to schedule</div>
              <div className="flex gap-1.5 text-[13px] mb-2">
                {(['ALL', 'TEAM', 'EMPLOYEE'] as const).map((s) => (
                  <button key={s} type="button" className={`px-3 py-1 rounded-md border ${scope === s ? 'bg-[#1A1A1A] text-white border-[#1A1A1A]' : 'border-[#E5E5E0]'}`} onClick={() => setScope(s)}>
                    {s === 'ALL' ? 'Everyone in the group' : s === 'TEAM' ? 'By team' : 'Everyone except…'}
                  </button>
                ))}
              </div>
              {(readiness.data?.guests?.length ?? 0) > 0 && (
                <div className="mb-2 text-[12px]">
                  <span className="text-[#6B6B6B]">People from other home groups ({readiness.data!.guests!.reduce((n, g) => n + g.people, 0)}):</span>{' '}
                  {([['AFTER_HOME', 'Only the time their home group leaves free'], ['ALWAYS', 'Use them even if their home group is not scheduled']] as const).map(([k, label]) => (
                    <button key={k} type="button" className={`mr-1.5 px-2.5 py-0.5 rounded-md border ${guestsMode === k ? 'bg-[#1A1A1A] text-white border-[#1A1A1A]' : 'border-[#E5E5E0]'}`} onClick={() => setGuestsMode(k)}>{label}</button>
                  ))}
                </div>
              )}
              {scope === 'TEAM' && (
                <div className="flex flex-wrap gap-3 text-[13px]">
                  {teamsInGroup.length === 0 ? <span className="text-[12px] text-[#6B6B6B]">No one in this group belongs to a team.</span> : teamsInGroup.map(([id, name]) => (
                    <label key={id} className="flex items-center gap-1.5"><input type="checkbox" checked={!skipTeam.includes(id)} onChange={(e) => setSkipTeam(e.target.checked ? skipTeam.filter((x) => x !== id) : [...skipTeam, id])} />{name}</label>
                  ))}
                </div>
              )}
              {scope === 'EMPLOYEE' && (
                <div className="text-[13px]">
                  <div className="text-[12px] text-[#6B6B6B] mb-1.5">Everyone in the group is scheduled except the people you add here.</div>
                  <div className="max-w-xs mb-2"><PersonPicker value="" status="ACTIVE" groupId={group?.id} placeholder="Leave someone out…" ariaLabel="Leave a person out" onChange={(id, person) => { if (person && !skipEmp.some((x) => x.id === id)) setSkipEmp([...skipEmp, person]); }} /></div>
                  <div className="flex flex-wrap gap-1.5">
                    {skipEmp.map((e) => (
                      <span key={e.id} className="inline-flex items-center gap-1 rounded-full border border-[#E5E5E0] bg-[#FAFAF8] pl-2.5 pr-1.5 py-0.5 text-[12px]">{e.name}
                        <button type="button" aria-label={`Include ${e.name} again`} className="text-[#6B6B6B] hover:text-[#1A1A1A]" onClick={() => setSkipEmp(skipEmp.filter((x) => x.id !== e.id))}>×</button></span>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </Section>

          <Section title="Priorities">
            <button type="button" className="w-full flex items-center gap-2 rounded-lg border border-[#E5E5E0] px-3 py-2 text-left text-[13px] hover:bg-[#FAFAF8]" onClick={() => setShowPrio(!showPrio)} aria-expanded={showPrio}>
              {showPrio ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
              <span className="font-semibold">{preset && !custom ? preset.label : 'Custom mix'}</span>
              <span className="text-[12px] text-[#6B6B6B] truncate">{preset && !custom ? preset.hint : 'Your own balance of the priorities'}</span>
              <span className="ml-auto text-[12px] underline text-[#525252]">{showPrio ? 'Hide' : 'Change'}</span>
            </button>
            {showPrio && (
              <div className="space-y-3">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              {PRESETS.map((p) => (
                <button key={p.id} type="button" onClick={() => { setW(p.w); setCustom(false); }} className={`text-left rounded-lg border px-3 py-2 ${preset?.id === p.id && !custom ? 'border-[#1A1A1A] bg-[#FAFAF8]' : 'border-[#E5E5E0] hover:bg-[#FAFAF8]'}`}>
                  <div className="text-[13px] font-semibold">{p.label}</div>
                  <div className="text-[11px] text-[#6B6B6B]">{p.hint}</div>
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
                    <div className="flex justify-between text-[12px]"><span className="font-semibold">{x.label}<HelpTip text={x.hint} /></span><span className="font-mono text-[#6B6B6B]">{w[x.k]}</span></div>
                    <input type="range" min={0} max={100} value={w[x.k]} onChange={(e) => setW({ ...w, [x.k]: Number(e.target.value) })} className="w-full accent-[#171717]" />
                  </div>
                ))}
              </div>
            )}
              </div>
            )}
            <p className="text-[12px] text-[#6B6B6B]">Hard rules are always enforced<HelpTip topic="alwaysEnforced" /></p>
          </Section>

          <div className="border-t border-[#E5E5E0] pt-3">
            <button type="button" className="text-[13px] font-semibold flex items-center gap-1.5" onClick={() => setAdvanced(!advanced)}>
              {advanced ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}Advanced
              <span className="text-[11px] font-normal text-[#6B6B6B]">same start times, week repeat, meals and breaks, solver time</span>
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
                  <div className="text-[12px] text-[#6B6B6B] mt-1">
                    {steady.mode === 'REQUIRE' ? 'One start and end time for each person' : steady.mode === 'PREFER' ? 'One usual time when possible' : 'Times can change from day to day'}
                    <HelpTip title="Same start and end time" text={(steady.mode === 'REQUIRE' ? 'Each person starts and finishes at one usual time for the whole period. This can lower coverage, so check "Forecast covered" after generating.' : steady.mode === 'PREFER' ? 'Each person is kept to one usual time when possible, but covering the forecast always comes first.' : 'Start and end times can change from day to day.') + ' A person’s own setting, and any start time assigned to them, overrides this (Workforce, Employees).'} />
                  </div>
                </div>
                {weeks === 1 && <label className="flex items-center gap-2 text-[13px]" title="For a first schedule with no published schedule before it."><input type="checkbox" checked={repeat} onChange={(e) => setRepeat(e.target.checked)} />Assume the week repeats<HelpTip text="The last night's shifts past midnight cover the first hours of the first day." /></label>}
                <label className="flex items-center gap-2 text-[13px]"><input type="checkbox" checked={breaksOn} onChange={(e) => setBreaksOn(e.target.checked)} />Place meals and breaks where the phones need people most<HelpTip text={`Within ${pol.data?.scheduling.breakSlackMin ?? 60} minutes either side of their usual place.`} /></label>
                <Field label="Solver" topic="solver"><Select value={solverPick} onChange={(e) => setSolverPick(e.target.value)}><option value="AUTO">Automatic, with backups (recommended)</option><option value="CPSAT">CP-SAT only</option><option value="HIGHS">HiGHS only</option><option value="SCIP">SCIP only</option><option value="GREEDY">Starting roster only (fast, rough)</option><option value="TIMEFOLD">Timefold, with CP-SAT behind it (needs the Timefold service)</option></Select></Field>
                <Field label="Solver time" topic="solverTime"><Select value={limit} onChange={(e) => setLimit(Number(e.target.value))}>{[10, 30, 60, 120].map((n) => <option key={n} value={n}>Up to {n} seconds</option>)}</Select></Field>
              </div>
            )}
          </div>
          </>
          )}
        </Card>

        {rotChoice !== 'ROTATION' && <div className="lg:sticky lg:top-4 space-y-3">
          <Card title="Ready to generate?" sub={`${startOk ? `${periodText(from, to, thisYear)} · ` : ''}${includedCount} people · ${chosen.length} template${chosen.length === 1 ? '' : 's'}`}>
            <div className="flex items-center gap-2 rounded-md px-3 py-2 text-[13px] font-semibold" data-testid="verdict" style={{ backgroundColor: !ready ? '#FBEDED' : review ? '#FDF3DC' : '#E6F4EC', color: !ready ? '#9B2C2C' : review ? '#8F6200' : '#2A7553' }}>
              {!ready ? <XCircle className="w-4 h-4 shrink-0" /> : review ? <AlertTriangle className="w-4 h-4 shrink-0" /> : <CheckCircle2 className="w-4 h-4 shrink-0" />}
              {!ready ? `Not ready${attention.length ? ` · ${attention.length} to fix` : ''}` : review ? `Ready · ${review} to review` : 'Ready'}
            </div>
            <div className="max-h-[46vh] overflow-y-auto space-y-3 pr-1">
              {attention.length > 0 && <CheckGroup label="Needs attention">{attention.map((it, i) => <CheckRow key={i} it={it} tone="bad" />)}</CheckGroup>}
              {worth.length > 0 && <CheckGroup label="Worth a look">{worth.map((it, i) => <CheckRow key={i} it={it} tone="warn" />)}</CheckGroup>}
              {passed.length > 0 && (
                <details className="group">
                  <summary className="cursor-pointer list-none flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wide text-[#6B6B6B]"><ChevronRight className="w-3 h-3 group-open:rotate-90 transition-transform" />All good · {passed.length}</summary>
                  <ul className="mt-2 space-y-1.5">{passed.map((it, i) => <CheckRow key={i} it={it} tone={it.ok === true ? 'ok' : 'info'} />)}</ul>
                </details>
              )}
            </div>
            {error && <Banner kind="err">{error}</Banner>}
            {busy && (
              <div className="space-y-1.5" role="status">
                <div className="h-1.5 rounded bg-[#E5E5E0] overflow-hidden"><div className="h-full bg-[#171717] transition-all" style={{ width: `${Math.min(100, (elapsed / (limit + 5)) * 100)}%` }} /></div>
                <ol className="text-[12px] space-y-0.5">
                  {['Preparing shifts and rules', `Looking for the best roster (up to ${limit}s)`, 'Placing meals and breaks, checking the rules'].map((t, i) => (
                    <li key={t} className={i < stage ? 'text-[#2A7553]' : i === stage ? 'font-semibold' : 'text-[#6B6B6B]'}>{i < stage ? 'Done: ' : i === stage ? '… ' : '· '}{t}</li>
                  ))}
                </ol>
                <div className="text-[11px] text-[#6B6B6B]">{Math.round(elapsed)}s elapsed</div>
              </div>
            )}
            {can('schedule:generate') && !rotationOk && <p className="text-[12px] text-[#8F6200]">Choose how to build this schedule: {crewPeople} {crewPeople === 1 ? 'person follows' : 'people follow'} a rotation pattern (see How to build).</p>}
            {can('schedule:generate') && !ready && !busy && (() => { const f = items.find((i) => i.ok === false); return f ? <p className="text-[12px] text-[#8F6200]" data-testid="why-off">Generate is off: {f.text.replace(/\.$/, '')}.</p> : null; })()}
            {can('schedule:generate')
              ? <Btn variant="primary" className="w-full justify-center" disabled={!ready || busy || !!running.data?.length} onClick={run}><Sparkles className="w-3.5 h-3.5" />{busy ? 'Starting…' : long ? `Build ${weeks} weeks in the background` : 'Generate schedule'}</Btn>
              : <span className="text-[12px] text-[#6B6B6B]">You do not have permission to generate schedules.</span>}
          </Card>
        </div>}
      </div>
    </div>
  );
};

const CheckGroup: React.FC<{ label: string; children: React.ReactNode }> = ({ label, children }) => (
  <div>
    <div className="text-[11px] font-bold uppercase tracking-wide text-[#6B6B6B] mb-1.5">{label}</div>
    <ul className="space-y-2">{children}</ul>
  </div>
);

/** One check: an icon, a short headline and line, the fix button underneath, and the long explanation behind "Details". */
const CheckRow: React.FC<{ it: Item; tone: 'bad' | 'warn' | 'ok' | 'info' }> = ({ it, tone }) => {
  const Icon = tone === 'bad' ? XCircle : tone === 'warn' ? AlertTriangle : tone === 'ok' ? CheckCircle2 : Info;
  const color = tone === 'bad' ? 'text-[#BC3F3F]' : tone === 'warn' ? 'text-[#B7791F]' : tone === 'ok' ? 'text-[#2A7553]' : 'text-[#6B6B6B]';
  const acts = it.actions && it.actions.length ? it.actions : it.action ? [it.action] : [];
  return (
    <li className="flex items-start gap-2 text-[12px]">
      <Icon className={`w-4 h-4 mt-0.5 shrink-0 ${color}`} aria-hidden />
      <div className="min-w-0 flex-1 space-y-1">
        <div className="font-medium text-[#171717]">{it.title ?? it.text}</div>
        {it.title && it.short && <div className="text-[#525252]">{it.short}</div>}
        {it.title && <details className="text-[#6B6B6B]"><summary className="cursor-pointer text-[11px] underline list-none">Details</summary><p className="mt-1">{it.text}</p></details>}
        {acts.length > 0 && <div className="flex flex-wrap gap-1.5 pt-0.5">{acts.map((a, j) => <button key={a.label} type="button" data-fix={j === 0 ? 'main' : 'other'} className={j === 0 ? 'rounded border border-[#171717] bg-[#171717] px-2 py-0.5 text-[11px] font-medium text-white hover:bg-[#333]' : 'rounded border border-[#E5E5E0] bg-white px-2 py-0.5 text-[11px] font-medium text-[#171717] hover:bg-[#FAFAF8]'} onClick={a.onClick}>{a.label}</button>)}</div>}
      </div>
    </li>
  );
};

const Section: React.FC<{ title: string; children: React.ReactNode }> = ({ title, children }) => (
  <section className="space-y-3">
    <h3 className="text-[11px] font-bold uppercase tracking-wide text-[#6B6B6B]">{title}</h3>
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
