/**
 * Scheduling › Schedule Quality. What a schedule is worth and why it falls short:
 *   the score and the estimated service level, where it is short of the requirement (with who could and could not cover it and what to do),
 *   what happened in the generation run (who was left out and why), and re-placing meals and breaks inside their slack.
 */
import React, { useState } from 'react';
import { AlertTriangle, Download, Info } from 'lucide-react';
import { api, dayName, dayYear, dec, download, Evaluation, GenerationReport, ScheduleVersion, Shortage } from '../../services/api';
import { useForecast } from '../../services/forecastStore';
import { useApi } from '../forecasting/hooks';
import { CHART, LineChart } from '../forecasting/charts';
import { Banner, Btn, Busy, Card, Empty, Input, Kpi, KpiRow, Pill, Select, Table } from '../forecasting/ui';

const GRADE: Record<Evaluation['grade'], { label: string; tone: 'good' | 'warn' | 'bad' }> = { EXCELLENT: { label: 'Excellent', tone: 'good' }, GOOD: { label: 'Good', tone: 'good' }, FAIR: { label: 'Fair', tone: 'warn' }, POOR: { label: 'Poor', tone: 'bad' } };
const pct = (v: number) => `${Math.round(v * 100)}%`;

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
        {version && version.stale && version.stale.length > 0 && (
          <Banner kind="warn"><div className="font-semibold">This schedule may be out of date.</div><ul className="list-disc ml-5 mt-1">{version.stale.map((s) => <li key={s}>{s}</li>)}</ul>
            <div className="mt-1">Generate it again from the current forecast, or publish it with a reason if you accept the difference.</div></Banner>
        )}
        {version?.acknowledged && <Banner kind="info">Published with known issues, accepted by {version.acknowledged.by} on {dayYear(version.acknowledged.at.slice(0, 10))}: “{version.acknowledged.reason}”. {version.acknowledged.issues.join(' ')}</Banner>}
      </Card>

      <Card title="Score" sub="One number for how well this schedule serves the forecast. It is an estimate: service level uses Erlang C on the interval's whole workload, with meals, breaks and shrinkage taken off the people on the phones.">
        {evalR.loading && !ev && <Busy text="Estimating service level…" />}
        {evalR.error && <p className="text-[13px] text-[#C84A4A]">{evalR.error}</p>}
        {ev && !ev.available && <Banner kind="info">{ev.reason}</Banner>}
        {ev && ev.available && (
          <>
            <KpiRow>
              <Kpi label="Schedule score" value={<span>{ev.score}<span className="text-[14px] text-[#737373]"> / 100</span></span>} tone={GRADE[ev.grade].tone} sub={GRADE[ev.grade].label} />
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
                    <div className="text-[11px] text-[#737373]">{p.detail}</div>
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
                <Table head={['Day', 'Time', 'Contacts', 'On shift', 'On phones', 'Service level', 'Busy / quiet', 'Wait']} right={[2, 3, 4, 5, 7]}>
                  {ev.worst.slice(0, 12).map((w) => (
                    <tr key={`${w.day}${w.slot}`}><td className="p-3">{dayName(w.day)}</td><td className="p-3 font-mono">{w.time}</td><td className="p-3 font-mono">{dec(w.volume, 0)}</td><td className="p-3 font-mono">{w.scheduled}</td><td className="p-3 font-mono">{dec(w.onPhones, 1)}</td>
                      <td className="p-3 font-mono text-[#C84A4A]">{pct(w.sl)}</td><td className="p-3 font-mono text-[12px] text-[#737373]">{pct(w.slHigh)} / {pct(w.slLow)}</td><td className="p-3 font-mono">{w.asa < 0 ? 'not answered' : `${dec(w.asa, 0)}s`}</td></tr>
                  ))}
                </Table>
              </div>
            )}
          </>
        )}
      </Card>

      <Card title="Where it falls short" sub="Gaps against the requirement, worst first. For each, who could and could not have covered it, and what you can do about it.">
        {short.loading && !sh && <Busy text="Looking for gaps…" />}
        {short.error && <p className="text-[13px] text-[#C84A4A]">{short.error}</p>}
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
                      <div className="font-semibold text-[13px]">{dayName(b.day)} · {b.from}–{b.to} <span className="font-normal text-[#737373]">· short by {b.peakShort} at worst, {dec(b.shortPeopleHours, 1)} people-hours</span></div>
                      <div className="flex flex-wrap gap-1.5">{b.actions.filter((a) => a.type !== 'TEMP').map((a) => <Btn key={a.type} onClick={() => goTo(a.type)} title={a.detail}>{a.label}</Btn>)}</div>
                    </div>
                    <div className="flex flex-wrap gap-1.5">{b.causes.slice(0, 5).map((c) => <Pill key={c.key} tone={c.key === 'COULD_WORK' ? 'info' : 'neutral'} title={c.text}>{c.people} {c.text.length > 44 ? c.text.slice(0, 42) + '…' : c.text}</Pill>)}</div>
                    <ul className="text-[12px] text-[#525252] list-disc ml-5">{b.actions.map((a) => <li key={a.type}><span className="font-medium">{a.label}.</span> {a.detail}</li>)}</ul>
                  </div>
                ))}
                {sh.blocks.length > 15 && <p className="text-[12px] text-[#737373]">Showing the 15 worst of {sh.blocks.length} gaps.</p>}
              </div>
            )}
            <p className="text-[12px] text-[#737373] flex items-start gap-1.5"><Info className="w-3.5 h-3.5 mt-0.5 shrink-0" />To publish with a gap you accept, publish from the timeline and give a reason; it is kept with the schedule. Your target is {sh.targetCoverage}% (Configuration › Scheduling Rules).</p>
          </>
        )}
      </Card>

      <Card title="Meals and breaks" sub="Move each meal and break within a window around where it is now, so the phones are covered best where the forecast needs people. Shifts, their order and lengths do not change."
        actions={r?.breaks ? <Pill tone="info">At generation: {r.breaks.shiftsChanged} shifts adjusted</Pill> : undefined}>
        {!draft && <p className="text-[13px] text-[#737373]">Only a draft can be changed. Open a draft, or generate a new one.</p>}
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
        {r && !r.available && <p className="text-[13px] text-[#737373]">This schedule was made before generation reports existed.</p>}
        {r?.available && r.people && r.exceptions && (
          <>
            <KpiRow>
              <Kpi label="Result" value={<span className="text-[16px]">{r.status === 'SUCCEEDED' ? 'Succeeded' : 'Succeeded with warnings'}</span>} tone={r.status === 'SUCCEEDED' ? 'good' : 'warn'} />
              <Kpi label="People scheduled" value={`${r.people.scheduled} of ${r.people.inPool}`} />
              <Kpi label="Not scheduled" value={r.people.notScheduled} sub={`${r.people.noPossibleShift} with no possible shift`} tone={r.people.noPossibleShift ? 'warn' : undefined} />
            </KpiRow>
            {r.exceptions.length === 0 && <p className="text-[13px] text-[#2F7D5A]">Nothing to report: everyone was scheduled and no check raised a concern.</p>}
            <div className="space-y-2">
              {r.exceptions.map((e, i) => (
                <div key={i} className={`border rounded-lg p-3 ${e.level === 'WARNING' ? 'border-[#B7791F]/30 bg-[#FFF5DD]/50' : 'border-[#E5E5E0] bg-[#FAFAF8]'}`}>
                  <div className="flex items-center gap-2 text-[13px] font-semibold">{e.level === 'WARNING' ? <AlertTriangle className="w-3.5 h-3.5 text-[#B7791F]" /> : <Info className="w-3.5 h-3.5 text-[#737373]" />}{e.subject}</div>
                  <p className="text-[12px] text-[#525252] mt-0.5">{e.message}</p>
                  {e.people && e.people.length > 0 && <p className="text-[12px] text-[#737373] mt-1">{e.people.slice(0, 12).map((p) => p.name).join(', ')}{e.people.length > 12 ? ` and ${e.people.length - 12} more (see the report)` : ''}</p>}
                </div>
              ))}
            </div>
          </>
        )}
      </Card>
    </div>
  );
};
