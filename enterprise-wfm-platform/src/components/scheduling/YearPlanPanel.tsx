/**
 * Scheduling › Year Plan. A long schedule seen from above: one row per week with how well it covers the forecast, whether its shifts were solved or
 * repeated from a cycle, which forecast it rests on and how far to trust it, and whether the week is locked. Click a week to open it in the roster.
 * Publishing goes a window at a time (the weeks up to a date are locked and live, the rest stay planned) and the planned weeks can be re-solved on today's
 * forecast as they come closer. The weeks far ahead are described by rotation lines: who works which days and times, repeating.
 */
import React, { useEffect, useMemo, useState } from 'react';
import { Lock } from 'lucide-react';
import { addDays, api, dayYear, dec, PlanView, PlanWeek, RotationLines, ScheduleJob, ScheduleVersion } from '../../services/api';
import { useForecast } from '../../services/forecastStore';
import { useApi } from '../forecasting/hooks';
import { Banner, Btn, Busy, Card, Empty, Input, Kpi, KpiRow, Pill, Select } from '../forecasting/ui';
import { JobCard } from './JobCard';

type Quality = 'SHORT' | 'BALANCED' | 'OVER' | 'NONE';
const COLORS: Record<Quality, string> = { SHORT: '#C84A4A', BALANCED: '#2F7D5A', OVER: '#4F6F8F', NONE: '#D4D4CF' };
const LABEL: Record<Quality, string> = { SHORT: 'Short', BALANCED: 'Balanced', OVER: 'Overstaffed', NONE: 'No target' };
const quality = (w: PlanWeek): Quality => (w.coveragePercent === null || w.needSlots === 0 ? 'NONE' : w.coveragePercent < 95 ? 'SHORT' : w.overSlots / Math.max(1, w.needSlots) > 0.15 ? 'OVER' : 'BALANCED');
const md = (d: string) => new Date(d + 'T00:00:00').toLocaleDateString('en', { day: 'numeric', month: 'short' });
const CONF: Record<string, { tone: 'good' | 'warn' | 'bad' | 'neutral'; text: string }> = {
  HIGH: { tone: 'good', text: 'High' }, MEDIUM: { tone: 'warn', text: 'Medium' }, LOW: { tone: 'bad', text: 'Lower' }, NONE: { tone: 'neutral', text: 'No forecast' },
};
const FORECAST: Record<string, string> = { SHORT: 'Short-term forecast', LONG: 'Long-term projection', MIXED: 'Both', NONE: 'None' };
const SOURCE: Record<string, string> = { SOLVED: 'Solved', PATTERN: 'Repeated cycle', MIXED: 'Solved + repeated', EMPTY: 'No shifts' };

export const YearPlanPanel: React.FC<{ versions: ScheduleVersion[]; version: ScheduleVersion | null; select: (id: string) => void; reload: (id?: string) => Promise<void>; go: (sub: string) => void }> = ({ versions, version, select, reload, go }) => {
  const { can, setNotice } = useForecast();
  const demand = versions.filter((v) => (v.kind ?? 'DEMAND') === 'DEMAND' && v.status !== 'ARCHIVED');
  const [through, setThrough] = useState('');
  const [reason, setReason] = useState('');
  const [needReason, setNeedReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [job, setJob] = useState<string | null>(null);
  const [resolveWeeks, setResolveWeeks] = useState(4);
  const [bump, setBump] = useState(0);

  const key = version ? `${version.id}-${version.rev}-${version.status}-${version.publishThrough ?? ''}-${bump}` : '';
  const plan = useApi<PlanView>(version ? `/scheduling/versions/${version.id}/plan` : null, [key]);
  const lines = useApi<RotationLines>(version && plan.data?.plan?.patternFrom ? `/scheduling/versions/${version.id}/lines` : null, [key, plan.data?.plan?.patternFrom]);
  useEffect(() => { setThrough(''); setNeedReason(''); setError(''); }, [version?.id]);

  // is a build for this group already running (started here, or from another screen or session)?
  const active = useApi<ScheduleJob[]>(version ? `/scheduling/jobs?groupId=${version.wfmGroupId}&active=true` : null, [version?.id, bump]);
  useEffect(() => { if (!job && active.data?.length) setJob(active.data[0].id); }, [active.data]);

  const weeks = plan.data?.weeks ?? [];
  const lockedEnd = plan.data?.publishThrough ?? (version?.status === 'PUBLISHED' ? version.periodEnd : null);
  const candidates = useMemo(() => weeks.filter((w) => !lockedEnd || w.weekEnd > lockedEnd).map((w) => w.weekEnd), [weeks, lockedEnd]);
  useEffect(() => { if (!through && candidates.length) setThrough(candidates[Math.min(3, candidates.length - 1)]); }, [candidates.join(',')]);

  if (demand.length === 0) return <Empty title="No schedule to plan yet">Generate a schedule first. Choose 13, 26 or 52 weeks on Generate Schedule to build a long plan.</Empty>;
  const planned = weeks.filter((w) => w.state === 'PLANNED' || w.state === 'PARTLY_LOCKED');

  const publishWindow = async (ack?: string) => {
    if (!version || !through) return;
    setBusy(true); setError('');
    try {
      await api(`/scheduling/versions/${version.id}/publish-window`, { method: 'POST', body: { through, ...(ack ? { acknowledgeReason: ack } : {}) } });
      setNeedReason(''); setReason(''); await reload(version.id); setBump((n) => n + 1);
      setNotice({ kind: 'ok', text: through >= version.periodEnd ? `${version.name} is published in full.` : `${version.name} is published through ${dayYear(through)}. Later weeks stay planned.` });
    } catch (e: any) {
      if (e?.code === 'CHECKS_NOT_ACKNOWLEDGED') setNeedReason(e.message); else setError(e.message);
    } finally { setBusy(false); }
  };
  const resolve = async () => {
    if (!version) return;
    setBusy(true); setError('');
    try { const j = await api<ScheduleJob>(`/scheduling/versions/${version.id}/resolve`, { method: 'POST', body: { weeks: resolveWeeks } }); setJob(j.id); } catch (e: any) { setError(e.message); } finally { setBusy(false); }
  };
  const openWeek = (w: PlanWeek) => { if (!version) return; sessionStorage.setItem('wfm.focusDay', JSON.stringify({ versionId: version.id, day: w.weekStart < version.periodStart ? version.periodStart : w.weekStart })); go('schedule-timeline'); };

  return (
    <div className="space-y-6">
      <Card title="Year plan" sub="Pick a schedule to see every week of it. Weeks near today are solved shift by shift; weeks far ahead repeat the last solved cycle until they come close enough to solve properly."
        actions={<Select value={version?.id ?? ''} onChange={(e) => select(e.target.value)} className="!w-auto" aria-label="Schedule">{demand.map((v) => <option key={v.id} value={v.id}>{v.name} · {Math.round((new Date(v.periodEnd).getTime() - new Date(v.periodStart).getTime()) / 604_800_000 + 1 / 7)} wk · {v.status.toLowerCase()}</option>)}</Select>}>
        {!version ? <Busy text="Loading…" /> : plan.loading && !plan.data ? <Busy text="Reading the plan…" /> : plan.error ? <Banner kind="err">{plan.error}</Banner> : plan.data && (
          <>
            <KpiRow>
              <Kpi label="Forecast covered" value={`${dec(plan.data.summary.coverage, 1)}%`} tone={plan.data.summary.coverage >= 95 ? 'good' : plan.data.summary.coverage >= 85 ? 'warn' : 'bad'} sub={`${weeks.length} weeks`} />
              <Kpi label="Shifts" value={plan.data.summary.shifts.toLocaleString()} sub={`${plan.data.summary.people} people`} />
              <Kpi label="Live (locked) through" value={<span className="text-[16px]">{lockedEnd ? dayYear(lockedEnd) : 'Not published'}</span>} sub={plan.data.status === 'PUBLISHED' ? (plan.data.publishThrough ? `${planned.length} weeks still planned` : 'whole schedule') : 'draft'} />
              <Kpi label="Solved weeks" value={weeks.filter((w) => w.shiftSource === 'SOLVED' || w.shiftSource === 'MIXED').length} sub={`${weeks.filter((w) => w.shiftSource === 'PATTERN').length} repeated`} />
              <Kpi label="Rule violations" value={plan.data.summary.violations} tone={plan.data.summary.violations ? 'bad' : 'good'} sub={plan.data.summary.violations ? 'fix before publishing' : 'none'} />
            </KpiRow>

            {/* the year at a glance: one square per week */}
            <div>
              <div className="flex flex-wrap gap-1" aria-label="Weeks at a glance">
                {weeks.map((w) => (
                  <button key={w.weekStart} onClick={() => openWeek(w)} title={`${md(w.weekStart)} – ${md(w.weekEnd)}: ${LABEL[quality(w)]}${w.coveragePercent !== null ? `, ${w.coveragePercent}% covered` : ''}${w.state === 'LOCKED' ? ', locked' : ''}`}
                    className="relative w-6 h-6 rounded-sm" style={{ background: COLORS[quality(w)], opacity: w.shiftSource === 'PATTERN' ? 0.55 : 1, outline: w.state === 'LOCKED' ? '2px solid #171717' : undefined, outlineOffset: -2 }} />
                ))}
              </div>
              <div className="flex flex-wrap items-center gap-4 mt-2 text-[11px] text-[#6B6B6B]">
                {(['BALANCED', 'SHORT', 'OVER', 'NONE'] as Quality[]).map((q) => <span key={q} className="flex items-center gap-1"><span className="w-3 h-3 rounded-sm" style={{ background: COLORS[q] }} />{LABEL[q]}</span>)}
                <span className="flex items-center gap-1"><span className="w-3 h-3 rounded-sm bg-[#2F7D5A] opacity-55" />Lighter = repeated cycle, not solved yet</span>
                <span className="flex items-center gap-1"><span className="w-3 h-3 rounded-sm border-2 border-[#171717]" />Locked</span>
              </div>
            </div>

            <div className="overflow-x-auto border border-[#E5E5E0] rounded-lg">
              <table className="w-full text-[12px]">
                <thead className="bg-[#FAFAF8] text-[#6B6B6B] text-left"><tr>
                  <th className="px-3 py-2 font-semibold">Week</th><th className="px-3 py-2 font-semibold">Coverage</th><th className="px-3 py-2 font-semibold">Shifts</th>
                  <th className="px-3 py-2 font-semibold">Built from</th><th className="px-3 py-2 font-semibold">Forecast</th><th className="px-3 py-2 font-semibold">Confidence</th><th className="px-3 py-2 font-semibold">State</th><th />
                </tr></thead>
                <tbody>
                  {weeks.map((w, i) => {
                    const q = quality(w), c = CONF[w.confidence] ?? CONF.NONE;
                    return (
                      <tr key={w.weekStart} className="border-t border-[#E5E5E0] hover:bg-[#FAFAF8] cursor-pointer" onClick={() => openWeek(w)}>
                        <td className="px-3 py-1.5 whitespace-nowrap"><span className="font-semibold">Week {i + 1}</span> <span className="text-[#6B6B6B]">{md(w.weekStart)} – {md(w.weekEnd)}</span></td>
                        <td className="px-3 py-1.5 w-56">
                          <div className="flex items-center gap-2">
                            <div className="h-2 w-28 rounded bg-[#E5E5E0] overflow-hidden"><div className="h-full" style={{ width: `${Math.min(100, w.coveragePercent ?? 0)}%`, background: COLORS[q] }} /></div>
                            <span className="tabular-nums w-12">{w.coveragePercent === null ? '–' : `${w.coveragePercent}%`}</span>
                            <span className="text-[11px]" style={{ color: COLORS[q] }}>{q === 'BALANCED' ? '' : LABEL[q]}</span>
                          </div>
                        </td>
                        <td className="px-3 py-1.5 tabular-nums">{w.shifts} <span className="text-[#6B6B6B]">· {w.people} people</span></td>
                        <td className="px-3 py-1.5">{SOURCE[w.shiftSource]}</td>
                        <td className="px-3 py-1.5">{FORECAST[w.forecast]}</td>
                        <td className="px-3 py-1.5"><Pill tone={c.tone}>{c.text}</Pill></td>
                        <td className="px-3 py-1.5 whitespace-nowrap">{w.state === 'LOCKED' ? <span className="inline-flex items-center gap-1 text-[#171717] font-semibold"><Lock className="w-3 h-3" />Locked</span> : w.state === 'PARTLY_LOCKED' ? 'Part locked' : w.state === 'PAST' ? <span className="text-[#6B6B6B]">Over</span> : <span className="text-[#6B6B6B]">Planned</span>}</td>
                        <td className="px-3 py-1.5 text-right text-[#6B6B6B]">Open ›</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            {weeks.some((w) => w.confidence === 'LOW' && w.state === 'PLANNED') && <p className="text-[12px] text-[#6B6B6B]">Confidence is lower for weeks far from today and for weeks that rest on the long-term projection: they are re-solved on the newer forecast as they come closer.</p>}
          </>
        )}
      </Card>

      {job && <JobCard jobId={job} canCancel={can('schedule:generate')} onFinished={() => { void reload(version?.id); setBump((n) => n + 1); }} />}

      {version && plan.data && version.status !== 'ARCHIVED' && (can('schedule:publish') || can('schedule:generate')) && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {can('schedule:publish') && (
            <Card title="Publish a window" sub="The weeks up to the date you choose become live: staff see them, adherence uses them, and they are locked from re-solving. Later weeks stay planned.">
              {error && <Banner kind="err" onClose={() => setError('')}>{error}</Banner>}
              {candidates.length === 0 ? <p className="text-[13px] text-[#525252]">Every week is already published.</p> : (
                <div className="flex flex-wrap items-center gap-2 text-[13px]">
                  <span>Publish through the end of</span>
                  <Select value={through} onChange={(e) => setThrough(e.target.value)} className="!w-auto">{weeks.filter((w) => candidates.includes(w.weekEnd)).map((w) => <option key={w.weekEnd} value={w.weekEnd}>{`week ${weeks.indexOf(w) + 1} (${md(w.weekEnd)})`}</option>)}</Select>
                  <Btn variant="primary" disabled={busy || !through} onClick={() => publishWindow()}>{through >= version.periodEnd ? 'Publish in full' : 'Publish this window'}</Btn>
                </div>
              )}
              {needReason && (
                <Banner kind="warn">
                  <div className="font-semibold">{needReason.replace(' Give a reason to publish anyway.', '')}</div>
                  <div className="mt-1 flex flex-wrap items-center gap-2">
                    <Input className="!w-72" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Why publish anyway? This is kept with the schedule." />
                    <Btn variant="success" disabled={busy || reason.trim().length < 3} onClick={() => publishWindow(reason.trim())}>Publish anyway</Btn>
                  </div>
                </Banner>
              )}
              <p className="text-[11px] text-[#6B6B6B]">An older published schedule for the same dates is archived when this one goes live.</p>
            </Card>
          )}
          {can('schedule:generate') && (
            <Card title="Re-solve the planned weeks" sub="Rebuilds the next weeks that are not locked on today's forecast, and repeats the new cycle after them. Locked weeks, weeks already over and shifts someone edited by hand are left exactly as they are.">
              {planned.length === 0 ? <p className="text-[13px] text-[#525252]">No planned weeks are left to re-solve.</p> : (
                <div className="flex flex-wrap items-center gap-2 text-[13px]">
                  <span>Re-solve the next</span>
                  <Select value={resolveWeeks} onChange={(e) => setResolveWeeks(Number(e.target.value))} className="!w-auto">{[2, 4, 8, 13].map((n) => <option key={n} value={n}>{n} weeks</option>)}</Select>
                  <Btn disabled={busy || !!job && !!active.data?.length} onClick={resolve}>Re-solve</Btn>
                </div>
              )}
              {version.status === 'PUBLISHED' && !plan.data.publishThrough && <p className="text-[12px] text-[#8F6200]">This schedule is published in full, so nothing can be re-solved. Edit it directly, or generate a new one.</p>}
            </Card>
          )}
        </div>
      )}

      {lines.data && lines.data.lines.length > 0 && (
        <Card title="Rotation lines" sub={`From ${dayYear(lines.data.from)}, the weeks far ahead are described by lines, not by named shifts. People on the same line work the same days and times. The real shifts are filled in when each window is re-solved.`}>
          <div className="space-y-3">
            {lines.data.lines.map((l) => <LineRow key={l.id} line={l} />)}
          </div>
        </Card>
      )}
    </div>
  );
};

const LineRow: React.FC<{ line: RotationLines['lines'][number] }> = ({ line }) => {
  const [open, setOpen] = useState(false);
  return (
    <div className="border border-[#E5E5E0] rounded-lg">
      <button type="button" className="w-full flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-left" onClick={() => setOpen(!open)} aria-expanded={open}>
        <span><span className="font-semibold text-[13px]">{line.name}</span> <span className="text-[12px] text-[#525252]">{line.summary}</span></span>
        <Pill>{line.size} {line.size === 1 ? 'person' : 'people'}</Pill>
      </button>
      {open && (
        <div className="border-t border-[#E5E5E0] p-3 space-y-3">
          <table className="text-[12px]"><tbody>
            {line.weeks.map((w) => <tr key={w.week}><td className="pr-3 py-0.5 text-[#6B6B6B]">Week {w.week}</td><td className="py-0.5">{w.text}</td></tr>)}
          </tbody></table>
          <div className="flex flex-wrap gap-1.5">{line.people.map((p) => <span key={p.id} className="text-[11px] px-2 py-0.5 rounded border border-[#E5E5E0] bg-[#FAFAF8]" title={p.number}>{p.name}</span>)}</div>
        </div>
      )}
    </div>
  );
};
