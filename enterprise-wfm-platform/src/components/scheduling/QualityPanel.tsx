/**
 * Scheduling › Schedule Quality. What a schedule is worth and why it falls short:
 *   the score and the estimated service level, where it is short of the requirement (with who could and could not cover it and what to do),
 *   what happened in the generation run (who was left out and why), and re-placing meals and breaks inside their slack.
 */
import React, { useState } from 'react';
import { AlertTriangle, Download, Info } from 'lucide-react';
import { api, dayName, dayYear, dec, download, Evaluation, GenerationReport, ScheduleVersion, Shortage, TemplateProposal } from '../../services/api';
import { useForecast } from '../../services/forecastStore';
import { useApi } from '../forecasting/hooks';
import { StaleBanner } from './StaleBanner';
import { CHART, LineChart } from '../forecasting/charts';
import { Banner, Btn, Busy, Card, Empty, Input, Kpi, KpiRow, Pill, Select, Table } from '../forecasting/ui';
import { StressTest } from './StressTest';

const GRADE: Record<Evaluation['grade'], { label: string; tone: 'good' | 'warn' | 'bad' }> = { EXCELLENT: { label: 'Excellent', tone: 'good' }, GOOD: { label: 'Good', tone: 'good' }, FAIR: { label: 'Fair', tone: 'warn' }, POOR: { label: 'Poor', tone: 'bad' } };
const pct = (v: number) => `${Math.round(v * 100)}%`;

/** One colour per kind of fix, so the choices are told apart at a glance. */
const FIX: Record<string, { color: string; bg: string; cta: string }> = {
  ASSIGN: { color: '#2A7553', bg: '#EAF5EF', cta: 'Open the day' },
  OVERTIME: { color: '#2B6CB0', bg: '#EBF2FB', cta: 'Offer overtime…' },
  ADD_TEMPLATE: { color: '#6B4FA3', bg: '#F2EEFA', cta: 'Review the template…' },
  RELAX: { color: '#8F6200', bg: '#FFF5DD', cta: 'Open shift templates' },
  TEMP: { color: '#737373', bg: '#F3F3F0', cta: '' },
};
const DOW = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

/** Add the shift template a gap needs, after showing what it would do. It joins the group's templates; the next schedule generated can use it. */
const AddTemplateHere: React.FC<{ groupId: string; proposal: TemplateProposal; canEdit: boolean; onClose: () => void; onTemplates: () => void; onGenerate: () => void }> = ({ groupId, proposal: p, canEdit, onClose, onTemplates, onGenerate }) => {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [done, setDone] = useState(false);
  const eligible = Math.max(0, ...p.days.map((d) => d.eligible));
  const create = async () => {
    setBusy(true); setErr('');
    try {
      await api('/scheduling/templates', { method: 'POST', body: { name: p.name, description: `Added from Schedule Quality: ${reason.trim()}`, workDays: p.workDays, earliestStart: p.earliestStart, latestStart: p.latestStart, durationHours: p.durationHours, mealMinutes: p.mealMinutes, breakCount: p.breakCount, breakMinutes: p.breakMinutes, groupIds: [groupId] } });
      setDone(true);
    } catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  };
  return (
    <div className="rounded-lg border p-3 space-y-2 text-[13px]" style={{ background: FIX.ADD_TEMPLATE.bg, borderColor: FIX.ADD_TEMPLATE.color + '55' }}>
      {done ? (
        <>
          <Banner kind="ok">Shift template “{p.name}” added for this group. Nothing in the current schedule has changed: generate it again and the new schedule can use it.</Banner>
          <div className="flex gap-2"><Btn variant="primary" onClick={onGenerate}>Generate again</Btn><Btn onClick={onTemplates}>See shift templates</Btn><Btn onClick={onClose}>Close</Btn></div>
        </>
      ) : (
        <>
          <div className="font-semibold" style={{ color: FIX.ADD_TEMPLATE.color }}>New shift template: {p.name}</div>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3 text-[12px]">
            <div><div className="font-semibold">The shape</div>Starts {p.earliestStart}, {p.durationHours} hours{p.mealMinutes ? `, ${p.mealMinutes}-minute meal` : ''}{p.breakCount ? `, ${p.breakCount} × ${p.breakMinutes}-minute ${p.breakCount === 1 ? 'break' : 'breaks'}` : ''}. Runs on {p.workDays.map((d) => DOW[d]).join(', ')}, for this group only.</div>
            <div><div className="font-semibold">What it would do</div>Up to {eligible} {eligible === 1 ? 'person' : 'people'} who cannot cover this today could. About {p.gainPeopleHours} people-hours covered. Coverage {p.coverageBefore}% → about {p.coverageAfter}%.</div>
            <div><div className="font-semibold">What it does not do</div>It changes no schedule by itself. It is an estimate, because the next schedule you generate decides who actually works it.</div>
          </div>
          <label className="text-[12px] font-semibold block">Why add it (required)<Input className="mt-1" maxLength={200} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="For example: nobody could cover the overnight demand" /></label>
          <div className="flex flex-wrap gap-2"><Btn variant="primary" disabled={busy || !canEdit || reason.trim().length < 3} onClick={create}>{busy ? 'Adding…' : 'Add the template'}</Btn><Btn onClick={onClose}>Cancel</Btn></div>
          {!canEdit && <p className="text-[12px] text-[#6B6B6B]">You need permission to edit shift templates.</p>}
          {err && <Banner kind="err">{err}</Banner>}
        </>
      )}
    </div>
  );
};

/** Offer overtime for one gap without leaving the page: the window is the gap's, the people asked are whoever the offer rules allow. */
const OvertimeHere: React.FC<{ groupId: string; day: string; from: string; to: string; short: number; draft: boolean; canEdit: boolean; onClose: () => void; onOffers: () => void }> = ({ groupId, day, from, to, short, draft, canEdit, onClose, onOffers }) => {
  const [spots, setSpots] = useState(Math.max(1, Math.min(500, Math.round(short))));
  const [noteText, setNoteText] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [sent, setSent] = useState<{ spots: number; total: number; invited: number } | null>(null);
  const send = async () => {
    setBusy(true); setErr('');
    try { setSent(await api<{ spots: number; total: number; invited: number }>('/scheduling/offers', { method: 'POST', body: { groupId, kind: 'OVERTIME', day, startTime: from, endTime: to, spots, note: noteText } })); }
    catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  };
  return (
    <div className="rounded-lg border p-3 space-y-2 text-[13px]" style={{ background: FIX.OVERTIME.bg, borderColor: FIX.OVERTIME.color + "55" }}>
      {sent ? (
        <>
          <Banner kind="ok">Overtime offered for {dayName(day)} {from}–{to}: {sent.spots} {sent.spots === 1 ? 'spot' : 'spots'}, {sent.total} eligible {sent.total === 1 ? 'person' : 'people'}, {sent.invited} asked so far.</Banner>
          <div className="flex gap-2"><Btn onClick={onOffers}>Track it in VTO & Overtime</Btn><Btn onClick={onClose}>Close</Btn></div>
        </>
      ) : (
        <>
          <div className="text-[#525252]">Ask people to take extra hours on {dayName(day)}, {from}–{to}. Only people who can take it without breaking a rule or a shift boundary are asked, in the order set in your offer rules.{draft && ' Offers change the published schedule, not this draft.'}</div>
          <div className="flex flex-wrap items-end gap-3">
            <label className="text-[12px] font-semibold">How many people<Input type="number" min={1} max={500} className="mt-1 !w-24" value={spots} onChange={(e) => setSpots(Math.min(500, Math.max(1, Number(e.target.value) || 1)))} /></label>
            <label className="text-[12px] font-semibold flex-1 min-w-[200px]">Note to them (optional)<Input className="mt-1" maxLength={200} value={noteText} onChange={(e) => setNoteText(e.target.value)} /></label>
            <Btn variant="primary" disabled={busy || !canEdit} onClick={send}>{busy ? 'Sending…' : 'Send the offer'}</Btn>
            <Btn onClick={onClose}>Cancel</Btn>
          </div>
          {err && <Banner kind="err">{err}</Banner>}
        </>
      )}
    </div>
  );
};

type ClockChanges = { timezone: string; changes: { day: string; kind: 'FORWARD' | 'BACK'; minutes: number; at: string; people: { employeeId: string; name: string; day: string; start: string; end: string; scheduledHours: number; workedHours: number }[] }[] };

/** Shifts that run over a daylight-saving change are scheduled for one length and worked for another. Shown only when this schedule has any. */
const ClockChangesCard: React.FC<{ versionId: string; rev: number | undefined }> = ({ versionId, rev }) => {
  const r = useApi<ClockChanges>(`/scheduling/versions/${versionId}/clock-changes`, [versionId, rev]);
  const list = (r.data?.changes ?? []).filter((c) => c.people.length);
  if (!list.length) return null;
  return (
    <Card title="Daylight saving" sub={`The clocks change in ${r.data!.timezone} during this schedule. A shift that runs over the change is worked for a different time than it is scheduled for. Whether payroll pays the scheduled hours or the hours actually worked is set under Payroll › Settings (Scheduled shifts over a clock change). Hours limits in the schedule itself still count scheduled hours.`}>
      <div className="space-y-4">
        {list.map((c) => (
          <div key={c.day}>
            <div className="text-[13px] font-semibold">{dayYear(c.day)}: clocks go {c.kind === 'FORWARD' ? 'forward' : 'back'} {c.minutes} minutes at {c.at}</div>
            <p className="text-[12px] text-[#525252] mt-0.5">{c.people.length} {c.people.length === 1 ? 'person works' : 'people work'} {c.minutes} minutes {c.kind === 'FORWARD' ? 'less' : 'more'} than scheduled.</p>
            <div className="mt-2 overflow-x-auto"><table className="w-full text-[13px]"><thead><tr className="text-left text-[11px] uppercase tracking-wide text-[#6B6B6B]"><th className="py-1 pr-3">Person</th><th className="py-1 pr-3">Shift</th><th className="py-1 pr-3 text-right">Scheduled</th><th className="py-1 text-right">Worked</th></tr></thead>
              <tbody>{c.people.slice(0, 12).map((p) => <tr key={p.employeeId + p.day} className="border-t border-[#E5E5E0]"><td className="py-1 pr-3">{p.name}</td><td className="py-1 pr-3">{dayYear(p.day)} {p.start} to {p.end}</td><td className="py-1 pr-3 text-right">{p.scheduledHours}h</td><td className="py-1 text-right font-semibold">{p.workedHours}h</td></tr>)}</tbody></table>
              {c.people.length > 12 && <p className="text-[12px] text-[#6B6B6B] mt-1">and {c.people.length - 12} more</p>}</div>
          </div>
        ))}
      </div>
    </Card>
  );
};

export const QualityPanel: React.FC<{ versions: ScheduleVersion[]; version: ScheduleVersion | null; select: (id: string) => void; reload: (selectId?: string) => Promise<void> | void; go: (sub: string) => void }> = ({ versions, version, select, reload, go }) => {
  const { can } = useForecast();
  const dep = [version?.rev, version?.status];
  const evalR = useApi<Evaluation>(version ? `/scheduling/versions/${version.id}/evaluation` : null, dep);
  const short = useApi<Shortage>(version ? `/scheduling/versions/${version.id}/shortage` : null, dep);
  const rep = useApi<GenerationReport>(version ? `/scheduling/versions/${version.id}/report` : null, [version?.id]);
  const [slack, setSlack] = useState(60);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const [openFix, setOpenFix] = useState<string | null>(null);   // the fix whose form is open, as `gap|type`

  if (!versions.length) return <Empty title="No schedule to assess yet">Generate a schedule first, then come back to see how good it is and where it falls short.<div className="mt-3"><Btn variant="primary" onClick={() => go('generate-schedule')}>Generate Schedule</Btn></div></Empty>;

  const ev = evalR.data, sh = short.data, r = rep.data;
  const draft = version?.status === 'DRAFT';
  const optimise = async () => {
    if (!version) return;
    setBusy(true); setNote(null);
    try {
      const out = await api<{ shiftsChanged: number; phoneShortfallBefore: number; phoneShortfallAfter: number }>(`/scheduling/versions/${version.id}/optimize-breaks`, { method: 'POST', body: { slackMinutes: slack, reason } });
      setNote({ kind: 'ok', text: out.shiftsChanged ? `Meals and breaks moved on ${out.shiftsChanged} shifts. People-time short on the phones went from ${dec(out.phoneShortfallBefore / 4, 1)}h to ${dec(out.phoneShortfallAfter / 4, 1)}h.` : 'Nothing to improve: the meals and breaks are already where the phones need them.' });
      setReason(''); await reload(version.id);
    } catch (e: any) { setNote({ kind: 'err', text: e.message }); } finally { setBusy(false); }
  };
  const goTo = (type: string) => go(type === 'OVERTIME' ? 'vto-overtime' : type === 'RELAX' ? 'shift-templates' : 'schedule-timeline');

  return (
    <div className="space-y-6">
      <Card title="Schedule" sub="Pick the schedule to assess. Everything below is measured on what is stored now, so manual edits count."
        actions={<Select value={version?.id ?? ''} onChange={(e) => select(e.target.value)} className="!w-auto" aria-label="Schedule version">{versions.map((v) => <option key={v.id} value={v.id}>{v.name} · {v.status.toLowerCase()}</option>)}</Select>}>
        {version && <StaleBanner version={version} reload={reload} go={go} />}
        {version?.acknowledged && <Banner kind="info">Published with known issues, accepted by {version.acknowledged.by} on {dayYear(version.acknowledged.at.slice(0, 10))}: “{version.acknowledged.reason}”. {version.acknowledged.issues.join(' ')}</Banner>}
      </Card>

      <Card title="Score" sub="One number for how well this schedule serves the forecast. It is an estimate: service level uses Erlang C on the interval's whole workload, with meals, breaks and shrinkage taken off the people on the phones.">
        {evalR.loading && !ev && <Busy text="Estimating service level…" />}
        {evalR.error && <p className="text-[13px] text-[#BC3F3F]">{evalR.error}</p>}
        {ev && !ev.available && <Banner kind="info">{ev.reason}</Banner>}
        {ev && ev.available && (
          <>
            <KpiRow>
              <Kpi label="Schedule score" value={<span>{ev.score}<span className="text-[14px] text-[#6B6B6B]"> / 100</span></span>} tone={GRADE[ev.grade].tone} sub={GRADE[ev.grade].label} />
              <Kpi label="Estimated service level" value={pct(ev.summary.serviceLevel)} tone={ev.summary.serviceLevel >= ev.summary.target ? 'good' : ev.summary.serviceLevel >= ev.summary.target - 0.1 ? 'warn' : 'bad'} sub={`target ${pct(ev.summary.target)} in ${ev.summary.answerSec}s`} />
              <Kpi label="On a busy day" value={pct(ev.summary.serviceLevelBusyDay)} sub={`quiet day ${pct(ev.summary.serviceLevelQuietDay)}`} />
              <Kpi label="Contacts meeting target" value={pct(ev.summary.volumeMeetingTarget)} sub={`${ev.summary.intervalsBelowTarget} of ${ev.summary.intervals} intervals fall short`} />
              <Kpi label="Occupancy" value={pct(ev.summary.averageOccupancy)} sub="average, on the phones" />
            </KpiRow>
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
              <div className="space-y-2">
                <h3 className="text-[13px] font-semibold">What the score is made of</h3>
                {ev.parts.map((p) => (
                  <div key={p.key}>
                    <div className="flex justify-between text-[12px]"><span className="font-medium">{p.label}</span><span className="font-mono text-[#525252]">{dec(p.points, 1)} / {p.max}</span></div>
                    <div className="h-1.5 rounded bg-[#EFEFEA] overflow-hidden"><div className={`h-full ${p.points >= p.max * 0.85 ? 'bg-[#2F7D5A]' : p.points >= p.max * 0.6 ? 'bg-[#B7791F]' : 'bg-[#C84A4A]'}`} style={{ width: `${(p.points / p.max) * 100}%` }} /></div>
                    <div className="text-[11px] text-[#6B6B6B]">{p.detail}</div>
                  </div>
                ))}
              </div>
              <div>
                <h3 className="text-[13px] font-semibold mb-1">Estimated service level by day</h3>
                <LineChart height={210} leftLabel="% answered in time" labels={ev.byDay.map((d) => d.day.slice(5))}
                  series={[{ name: 'Estimated', color: CHART.forecast, values: ev.byDay.map((d) => Math.round(d.serviceLevel * 100)) }, { name: 'Target', color: CHART.baseline, kind: 'dashed', values: ev.byDay.map(() => Math.round(ev.summary.target * 100)) }]} />
              </div>
            </div>
            {ev.worst.length > 0 && (
              <div>
                <h3 className="text-[13px] font-semibold mb-1">Intervals furthest below target</h3>
                <Table head={['Day', 'Time', 'Contacts', 'On shift', 'On phones', 'Service level', 'Busy / quiet', 'Wait']} right={[2, 3, 4, 5, 6, 7]}>
                  {ev.worst.slice(0, 12).map((w) => (
                    <tr key={`${w.day}${w.slot}`}><td className="p-3 whitespace-nowrap">{dayName(w.day)}</td><td className="p-3 font-mono">{w.time}</td><td className="p-3 font-mono text-right">{dec(w.volume, 0)}</td><td className="p-3 font-mono text-right">{w.scheduled}</td><td className="p-3 font-mono text-right">{dec(w.onPhones, 1)}</td>
                      <td className="p-3 font-mono text-right text-[#BC3F3F]">{pct(w.sl)}</td><td className="p-3 font-mono text-right text-[12px] text-[#6B6B6B] whitespace-nowrap">{pct(w.slHigh)} / {pct(w.slLow)}</td><td className="p-3 font-mono text-right whitespace-nowrap">{w.asa < 0 ? 'not answered' : `${dec(w.asa, 0)}s`}</td></tr>
                  ))}
                </Table>
              </div>
            )}
          </>
        )}
      </Card>

      {version && version.coverageSource !== 'MANUAL' && version.forecastVersionId && <StressTest version={version} />}

      <Card title="Where it falls short" sub="Gaps against the requirement, worst first. For each, who could and could not have covered it, and what you can do about it.">
        {short.loading && !sh && <Busy text="Looking for gaps…" />}
        {short.error && <p className="text-[13px] text-[#BC3F3F]">{short.error}</p>}
        {sh && (
          <>
            <Banner kind={sh.meetsTarget ? 'ok' : 'warn'}>{sh.headline}{!sh.meetsTarget && ` ${sh.gaps} gap${sh.gaps === 1 ? '' : 's'}, ${dec(sh.shortPeopleHours, 0)} people-hours short in total.`}</Banner>
            {sh.topCauses.length > 0 && !sh.meetsTarget && (
              <div className="text-[13px]">
                <div className="font-semibold mb-1">Main reasons nobody could cover</div>
                <ul className="list-disc ml-5 text-[#525252]">{sh.topCauses.filter((c) => c.key !== 'COULD_WORK').slice(0, 4).map((c) => <li key={c.key}>People {c.text}</li>)}
                  {sh.topCauses.some((c) => c.key === 'COULD_WORK') && <li>Some people could work it but the schedule chose otherwise (other rules, same-start rules, or surplus elsewhere)</li>}</ul>
              </div>
            )}
            {sh.blocks.length > 0 && (
              <div className="space-y-3">
                {sh.blocks.slice(0, 15).map((b) => (
                  <div key={`${b.day}${b.from}`} className="border border-[#E5E5E0] rounded-lg p-3 space-y-2">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="font-semibold text-[13px]">{dayName(b.day)} · {b.from}–{b.to} <span className="font-normal text-[#6B6B6B]">· short by {b.peakShort} at worst, {dec(b.shortPeopleHours, 1)} people-hours</span></div>
                      <div className="flex flex-wrap gap-1.5">{b.actions.filter((a) => a.type !== 'TEMP').map((a) => {
                        const k = `${b.day}${b.from}|${a.type}`;
                        return <Btn key={a.type} onClick={() => (['OVERTIME', 'ADD_TEMPLATE', 'RELAX'].includes(a.type) ? setOpenFix(openFix === k ? null : k) : goTo(a.type))} title={a.detail}>{a.label}</Btn>;
                      })}</div>
                    </div>
                    {openFix === `${b.day}${b.from}|OVERTIME` && version && <OvertimeHere groupId={version.wfmGroupId} day={b.day} from={b.from} to={b.to} short={b.peakShort} draft={version.status !== 'PUBLISHED'} canEdit={can('schedule:edit')} onClose={() => setOpenFix(null)} onOffers={() => go('vto-overtime')} />}
                    {openFix === `${b.day}${b.from}|ADD_TEMPLATE` && version && b.actions.find((x) => x.type === 'ADD_TEMPLATE')?.proposal && <AddTemplateHere groupId={version.wfmGroupId} proposal={b.actions.find((x) => x.type === 'ADD_TEMPLATE')!.proposal!} canEdit={can('workforce:write')} onClose={() => setOpenFix(null)} onTemplates={() => go('shift-templates')} onGenerate={() => go('generate-schedule')} />}
                    {openFix === `${b.day}${b.from}|RELAX` && (
                      <div className="rounded-lg border p-3 space-y-2 text-[13px]" style={{ background: FIX.RELAX.bg, borderColor: FIX.RELAX.color + '55' }}>
                        <div className="font-semibold" style={{ color: FIX.RELAX.color }}>Relax a rule</div>
                        <div className="text-[12px] text-[#404040]">{b.actions.find((x) => x.type === 'RELAX')?.detail} Rules are changed under Shift Templates and Scheduling Rules; nothing changes until you save there, and the next schedule you generate uses it.</div>
                        <div className="flex gap-2"><Btn variant="primary" onClick={() => go('shift-templates')}>Open shift templates</Btn><Btn onClick={() => setOpenFix(null)}>Close</Btn></div>
                      </div>
                    )}
                    <div className="flex flex-wrap gap-1.5">{b.causes.slice(0, 5).map((c) => <Pill key={c.key} tone={c.key === 'COULD_WORK' ? 'info' : 'neutral'} title={c.text}>{c.people} {c.text.length > 44 ? c.text.slice(0, 42) + '…' : c.text}</Pill>)}</div>
                    <ul className="text-[12px] text-[#525252] list-disc ml-5">{b.actions.map((a) => <li key={a.type}><span className="font-medium">{a.label}.</span> {a.detail}</li>)}</ul>
                  </div>
                ))}
                {sh.blocks.length > 15 && <p className="text-[12px] text-[#6B6B6B]">Showing the 15 worst of {sh.blocks.length} gaps.</p>}
              </div>
            )}
            <p className="text-[12px] text-[#6B6B6B] flex items-start gap-1.5"><Info className="w-3.5 h-3.5 mt-0.5 shrink-0" />To publish with a gap you accept, publish from the timeline and give a reason; it is kept with the schedule. Your target is {sh.targetCoverage}% (Configuration › Scheduling Rules).</p>
          </>
        )}
      </Card>

      {version && <ClockChangesCard versionId={version.id} rev={version.rev} />}

      <Card title="Meals and breaks" sub="Move each meal and break within a window around where it is now, so the phones are covered best where the forecast needs people. Shifts, their order and lengths do not change."
        actions={r?.breaks ? <Pill tone="info">At generation: {r.breaks.shiftsChanged} shifts adjusted</Pill> : undefined}>
        {!draft && <p className="text-[13px] text-[#6B6B6B]">Only a draft can be changed. Open a draft, or generate a new one.</p>}
        {draft && can('schedule:edit') && (
          <div className="flex flex-wrap items-end gap-3">
            <label className="text-[12px] font-semibold">Window<Select value={slack} onChange={(e) => setSlack(Number(e.target.value))} className="mt-1 !w-44">{[0, 30, 60, 90, 120].map((m) => <option key={m} value={m}>{m === 0 ? 'Template flex only' : `Up to ±${m} min`}</option>)}</Select></label>
            <label className="text-[12px] font-semibold flex-1 min-w-[220px]">Why<Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Say why the breaks are being moved" className="mt-1" /></label>
            <Btn variant="primary" disabled={busy || reason.trim().length < 3} onClick={optimise}>Re-place meals and breaks</Btn>
            {busy && <Busy text="Working…" />}
          </div>
        )}
        {note && <Banner kind={note.kind} onClose={() => setNote(null)}>{note.text}</Banner>}
      </Card>

      <Card title="What happened when it was generated" sub="Who was scheduled, who was not and why, and anything the planner should know before publishing."
        actions={r?.available ? <Btn onClick={() => download(`/scheduling/versions/${version!.id}/report.csv`, `schedule-report-v${version!.seq}.csv`).catch(() => {})}><Download className="w-3.5 h-3.5" />Download report</Btn> : undefined}>
        {rep.loading && !r && <Busy text="Loading…" />}
        {r && !r.available && <p className="text-[13px] text-[#6B6B6B]">This schedule was made before generation reports existed.</p>}
        {r?.available && r.people && r.exceptions && (
          <>
            <KpiRow>
              <Kpi label="Result" value={<span className="text-[16px]">{r.status === 'SUCCEEDED' ? 'Succeeded' : 'Succeeded with warnings'}</span>} tone={r.status === 'SUCCEEDED' ? 'good' : 'warn'} />
              <Kpi label="People scheduled" value={`${r.people.scheduled} of ${r.people.inPool}`} />
              <Kpi label="Not scheduled" value={r.people.notScheduled} sub={`${r.people.noPossibleShift} with no possible shift`} tone={r.people.noPossibleShift ? 'warn' : undefined} />
            </KpiRow>
            {r.exceptions.length === 0 && <p className="text-[13px] text-[#2A7553]">Nothing to report: everyone was scheduled and no check raised a concern.</p>}
            <div className="space-y-2">
              {r.exceptions.map((e, i) => (
                <div key={i} className={`border rounded-lg p-3 ${e.level === 'WARNING' ? 'border-[#B7791F]/30 bg-[#FFF5DD]/50' : 'border-[#E5E5E0] bg-[#FAFAF8]'}`}>
                  <div className="flex items-center gap-2 text-[13px] font-semibold">{e.level === 'WARNING' ? <AlertTriangle className="w-3.5 h-3.5 text-[#8F6200]" /> : <Info className="w-3.5 h-3.5 text-[#6B6B6B]" />}{e.subject}</div>
                  <p className="text-[12px] text-[#525252] mt-0.5">{e.message}</p>
                  {e.people && e.people.length > 0 && <p className="text-[12px] text-[#6B6B6B] mt-1">{e.people.slice(0, 12).map((p) => p.name).join(', ')}{e.people.length > 12 ? ` and ${e.people.length - 12} more (see the report)` : ''}</p>}
                </div>
              ))}
            </div>
          </>
        )}
      </Card>
    </div>
  );
};
