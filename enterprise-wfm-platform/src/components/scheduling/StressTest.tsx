/**
 * Stress test: plays random call arrivals against a schedule and shows what customers would experience, as a range rather than one number.
 * The Score above estimates service level with a formula on average intervals; this plays the day many times, with the forecast wrong by a random
 * amount, and says how often each day would meet its target and how bad a poor day gets.
 */
import React, { useEffect, useState } from 'react';
import { api, dayName, dec, ScheduleVersion } from '../../services/api';
import { CHART, LineChart } from '../forecasting/charts';
import { Banner, Btn, Busy, Card, Field, Kpi, KpiRow, Pill, Select } from '../forecasting/ui';

type Sim = {
  from: string; to: string; target: number; answerSec: number; replications: number; wallSec: number; notes: string[];
  overall: { serviceLevel: number; abandon: number; occupancy: number; offered: number; chanceOfMeetingTarget: number };
  days: { day: string; serviceLevel: number; badDayServiceLevel: number; abandon: number; occupancy: number; offered: number; coverageOfRequirement: number; meetsTarget: boolean }[];
  intervals: { day: string; slot: number; serviceLevel: number; badServiceLevel: number; asaSec: number; abandon: number; occupancy: number; offered: number; agents: number; belowTarget: boolean }[];
};
const pct = (v: number, dp = 0) => `${dec(v * 100, dp)}%`;
const hhmm = (slot: number) => `${String(Math.floor(slot / 4)).padStart(2, '0')}:${String((slot % 4) * 15).padStart(2, '0')}`;

type WhatIf = { from: string; to: string; target: number; scheduledPeople: number; notes: string[]; scenarios: { name: string; volumePct: number; ahtPct: number; absencePercent: number; staffPct: number; serviceLevel: number; abandon: number; occupancy: number; chanceOfMeetingTarget: number; meetsTarget: boolean; peopleNeededChangePercent: number | null; peopleNeededChangeFte: number | null; verdict: string }[] };
type Sc = { name: string; volumePct: number; ahtPct: number; absencePercent: number };
const PRESETS: Sc[] = [
  { name: '10% more calls', volumePct: 10, ahtPct: 0, absencePercent: 0 }, { name: '30% more calls', volumePct: 30, ahtPct: 0, absencePercent: 0 },
  { name: 'Calls take 15% longer', volumePct: 0, ahtPct: 15, absencePercent: 0 }, { name: 'A flu week: 15% off', volumePct: 0, ahtPct: 0, absencePercent: 15 },
  { name: 'A busy day with sickness', volumePct: 20, ahtPct: 0, absencePercent: 10 },
];

/** Compare "what if" versions of the same days side by side, and how many more (or fewer) people on the phones would meet the service target in each. */
const WhatIfCard: React.FC<{ version: ScheduleVersion }> = ({ version }) => {
  const [picked, setPicked] = useState<Sc[]>([PRESETS[1], PRESETS[3]]);
  const [custom, setCustom] = useState<Sc>({ name: '', volumePct: 0, ahtPct: 0, absencePercent: 0 });
  const [days, setDays] = useState(3);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [out, setOut] = useState<WhatIf | null>(null);
  useEffect(() => { setOut(null); setErr(''); }, [version.id]);
  const run = async () => {
    setBusy(true); setErr('');
    try { setOut(await api<WhatIf>(`/scheduling/versions/${version.id}/what-if`, { method: 'POST', body: { from: version.periodStart, days, scenarios: picked }, timeoutMs: 10 * 60_000 })); } catch (e: any) { setErr(e.message); setOut(null); } finally { setBusy(false); }
  };
  const toggle = (s: Sc) => setPicked(picked.some((p) => p.name === s.name) ? picked.filter((p) => p.name !== s.name) : [...picked, s].slice(0, 6));
  return (
    <Card title="What if…" sub="Try different situations on the same days and see what each does to service, and about how many more or fewer people on the phones it would take to meet your target.">
      <div className="flex flex-wrap gap-x-5 gap-y-1.5 text-[13px]">{[...PRESETS, ...picked.filter((p) => !PRESETS.some((x) => x.name === p.name))].map((s) => <label key={s.name} className="flex items-center gap-1.5"><input type="checkbox" checked={picked.some((p) => p.name === s.name)} onChange={() => toggle(s)} />{s.name}</label>)}</div>
      <div className="flex flex-wrap items-end gap-3">
        <Field label="Your own"><input className="w-52 p-2 border border-[#E5E5E0] rounded text-[13px]" value={custom.name} onChange={(e) => setCustom({ ...custom, name: e.target.value })} placeholder="Name it" /></Field>
        <Field label="Calls"><Select value={custom.volumePct} onChange={(e) => setCustom({ ...custom, volumePct: Number(e.target.value) })} className="!w-auto">{[-20, -10, 0, 10, 20, 30, 50].map((n) => <option key={n} value={n}>{n > 0 ? `+${n}%` : n === 0 ? 'as planned' : `${n}%`}</option>)}</Select></Field>
        <Field label="Call length"><Select value={custom.ahtPct} onChange={(e) => setCustom({ ...custom, ahtPct: Number(e.target.value) })} className="!w-auto">{[-10, 0, 10, 20, 30].map((n) => <option key={n} value={n}>{n > 0 ? `+${n}%` : n === 0 ? 'as planned' : `${n}%`}</option>)}</Select></Field>
        <Field label="People off"><Select value={custom.absencePercent} onChange={(e) => setCustom({ ...custom, absencePercent: Number(e.target.value) })} className="!w-auto">{[0, 5, 10, 20, 30].map((n) => <option key={n} value={n}>{n ? `${n}%` : 'as planned'}</option>)}</Select></Field>
        <Btn disabled={custom.name.trim().length < 2 || picked.length >= 6} onClick={() => { setPicked([...picked, { ...custom, name: custom.name.trim() }]); setCustom({ name: '', volumePct: 0, ahtPct: 0, absencePercent: 0 }); }}>Add</Btn>
        <Field label="Over"><Select value={days} onChange={(e) => setDays(Number(e.target.value))} className="!w-auto">{[1, 3, 7].map((n) => <option key={n} value={n}>{n} day{n > 1 ? 's' : ''}</option>)}</Select></Field>
        <Btn variant="primary" disabled={busy || picked.length === 0} onClick={run}>{busy ? 'Trying them…' : 'Compare'}</Btn>
      </div>
      {busy && <Busy text="Playing each situation several times. This takes a minute or two." />}
      {err && <Banner kind="warn">{err}</Banner>}
      {out && !busy && (
        <div className="overflow-x-auto"><table className="w-full text-[12px]">
          <thead className="text-left text-[#6B6B6B]"><tr><th className="py-1">Situation</th><th>Answered in time</th><th>Chance of meeting {pct(out.target)}</th><th>Hang up</th><th>Busy</th><th>What it takes</th></tr></thead>
          <tbody>{out.scenarios.map((s) => (
            <tr key={s.name} className="border-t border-[#E5E5E0] align-top">
              <td className="py-1.5 font-semibold">{s.name}<div className="text-[11px] font-normal text-[#6B6B6B]">{[s.volumePct && `${s.volumePct > 0 ? '+' : ''}${s.volumePct}% calls`, s.ahtPct && `${s.ahtPct > 0 ? '+' : ''}${s.ahtPct}% call length`, s.absencePercent && `${s.absencePercent}% off`].filter(Boolean).join(' · ') || 'the plan as it is'}</div></td>
              <td className="tabular-nums"><Pill tone={s.meetsTarget ? 'good' : 'bad'}>{pct(s.serviceLevel)}</Pill></td><td className="tabular-nums">{pct(s.chanceOfMeetingTarget)}</td><td className="tabular-nums">{pct(s.abandon, 1)}</td><td className="tabular-nums">{pct(s.occupancy)}</td>
              <td className="max-w-xs">{s.verdict}{s.peopleNeededChangeFte !== null && s.peopleNeededChangePercent !== 0 && <div className="text-[11px] text-[#6B6B6B]">about {s.peopleNeededChangeFte > 0 ? '+' : ''}{dec(s.peopleNeededChangeFte, 1)} people of the {out.scheduledPeople} scheduled</div>}</td>
            </tr>))}</tbody>
        </table><ul className="text-[11px] text-[#6B6B6B] list-disc ml-4 mt-2">{out.notes.map((n) => <li key={n}>{n}</li>)}</ul></div>
      )}
    </Card>
  );
};

export const StressTest: React.FC<{ version: ScheduleVersion }> = ({ version }) => {
  const [from, setFrom] = useState(version.periodStart);
  const [days, setDays] = useState(3);
  const [error, setErr] = useState(20);          // how wrong the forecast might be, in percent
  const [absence, setAbsence] = useState(0);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState('');
  const [sim, setSim] = useState<Sim | null>(null);
  const [view, setView] = useState('');
  useEffect(() => { setFrom(version.periodStart); setSim(null); setProblem(''); }, [version.id]);

  const run = async () => {
    setBusy(true); setProblem('');
    try {
      const r = await api<Sim>(`/scheduling/versions/${version.id}/simulate`, { method: 'POST', body: { from, days, replications: 40, volumeCv: error / 200, absencePercent: absence }, timeoutMs: 6 * 60_000 });
      setSim(r); setView(r.days[0]?.day ?? '');
    } catch (e: any) { setProblem(e.message); setSim(null); } finally { setBusy(false); }
  };
  const day = sim?.intervals.filter((i) => i.day === view) ?? [];
  const open = day.filter((i) => i.offered > 0.5);
  const first = open.length ? Math.max(0, day.indexOf(open[0]) - 1) : 0, last = open.length ? Math.min(95, day.indexOf(open[open.length - 1]) + 1) : 95;
  const slice = day.slice(first, last + 1);
  const bad = sim ? sim.days.filter((d) => !d.meetsTarget).length : 0;

  return (
    <>
    <Card title="Stress test" sub="Plays the days many times over with calls arriving at random, the forecast wrong by some amount and people giving up if they wait too long. Shows how often each day would meet its service target, and how a poor day looks, instead of one average.">
      <div className="flex flex-wrap items-start gap-3">
        <Field label="Starting"><Select value={from} onChange={(e) => setFrom(e.target.value)} className="!w-auto">{dayList(version).map((d) => <option key={d} value={d}>{dayName(d)}</option>)}</Select></Field>
        <Field label="For"><Select value={days} onChange={(e) => setDays(Number(e.target.value))} className="!w-auto">{[1, 3, 7, 14].map((n) => <option key={n} value={n}>{n} day{n > 1 ? 's' : ''}</option>)}</Select></Field>
        <Field label="Forecast could be off by" hint="Typical error on a day"><Select value={error} onChange={(e) => setErr(Number(e.target.value))} className="!w-auto">{[0, 10, 20, 30].map((n) => <option key={n} value={n}>{n === 0 ? 'Exactly right' : `About ${n}%`}</option>)}</Select></Field>
        <Field label="People who don't turn up" hint="On top of planned breaks"><Select value={absence} onChange={(e) => setAbsence(Number(e.target.value))} className="!w-auto">{[0, 5, 10, 15, 25].map((n) => <option key={n} value={n}>{n === 0 ? 'Everyone comes in' : `${n}%`}</option>)}</Select></Field>
        <Btn variant="primary" className="mt-[22px]" disabled={busy} onClick={run}>{busy ? 'Running…' : sim ? 'Run again' : 'Run the stress test'}</Btn>
      </div>
      {busy && <Busy text="Playing the days…" />}
      {problem && <Banner kind="warn">{problem}</Banner>}
      {sim && !busy && (
        <>
          <KpiRow>
            <Kpi label="Calls answered in time" value={pct(sim.overall.serviceLevel)} tone={sim.overall.serviceLevel >= sim.target ? 'good' : sim.overall.serviceLevel >= sim.target - 0.1 ? 'warn' : 'bad'} sub={`target ${pct(sim.target)} within ${sim.answerSec}s`} />
            <Kpi label="Chance of meeting the target" value={pct(sim.overall.chanceOfMeetingTarget)} tone={sim.overall.chanceOfMeetingTarget >= 0.8 ? 'good' : sim.overall.chanceOfMeetingTarget >= 0.5 ? 'warn' : 'bad'} sub={`over ${sim.replications} random runs`} />
            <Kpi label="Callers who hang up" value={pct(sim.overall.abandon, 1)} tone={sim.overall.abandon <= 0.05 ? 'good' : sim.overall.abandon <= 0.1 ? 'warn' : 'bad'} />
            <Kpi label="Busy on calls" value={pct(sim.overall.occupancy)} tone={sim.overall.occupancy > 0.9 ? 'bad' : sim.overall.occupancy > 0.85 ? 'warn' : undefined} sub="of the time people are on the phones" />
            <Kpi label="Days short of target" value={`${bad} of ${sim.days.length}`} tone={bad ? 'bad' : 'good'} />
          </KpiRow>
          <table className="w-full text-[12px]">
            <thead className="text-left text-[#6B6B6B]"><tr><th className="py-1">Day</th><th>Answered in time</th><th>A poor day</th><th>Hang up</th><th>Busy</th><th>Calls</th><th /></tr></thead>
            <tbody>
              {sim.days.map((d) => (
                <tr key={d.day} className={`border-t border-[#E5E5E0] cursor-pointer ${view === d.day ? 'bg-[#FAFAF8]' : ''}`} onClick={() => setView(d.day)}>
                  <td className="py-1.5 font-medium">{dayName(d.day)}</td><td className="tabular-nums">{pct(d.serviceLevel)}</td><td className="tabular-nums text-[#6B6B6B]">{pct(d.badDayServiceLevel)}</td>
                  <td className="tabular-nums">{pct(d.abandon, 1)}</td><td className="tabular-nums">{pct(d.occupancy)}</td><td className="tabular-nums">{d.offered.toLocaleString()}</td>
                  <td><Pill tone={d.meetsTarget ? 'good' : 'bad'}>{d.meetsTarget ? 'Meets target' : 'Short'}</Pill></td>
                </tr>
              ))}
            </tbody>
          </table>
          {slice.length > 0 && (
            <div>
              <div className="text-[12px] font-semibold mb-1">{dayName(view)}: service level through the day</div>
              <LineChart height={240} leftLabel="% answered in time" labels={slice.map((i) => hhmm(i.slot))} xEvery={4}
                series={[
                  { name: 'Typical', color: CHART.forecast, values: slice.map((i) => Math.round(i.serviceLevel * 100)) },
                  { name: 'A poor day', color: CHART.agents, kind: 'dashed', values: slice.map((i) => Math.round(i.badServiceLevel * 100)) },
                  { name: 'Target', color: CHART.baseline, kind: 'dashed', values: slice.map(() => Math.round(sim.target * 100)) },
                ]}
                tooltip={(k) => <span>{slice[k].agents} on the phones · {slice[k].offered} calls · wait {slice[k].asaSec}s · {pct(slice[k].abandon)} hang up</span>} />
              <p className="text-[11px] text-[#6B6B6B] mt-1">{open.filter((i) => i.belowTarget).length} of {open.length} busy quarter-hours would miss the target on a typical day.</p>
            </div>
          )}
          <ul className="text-[11px] text-[#6B6B6B] list-disc ml-4">{sim.notes.map((n) => <li key={n}>{n}</li>)}<li>{sim.replications} random runs in {sim.wallSec}s.</li></ul>
        </>
      )}
    </Card>
    <WhatIfCard version={version} />
    </>
  );
};

const dayList = (v: ScheduleVersion) => {
  const out: string[] = [];
  for (let d = new Date(v.periodStart + 'T00:00:00'); out.length < 120 && d <= new Date(v.periodEnd + 'T00:00:00'); d.setDate(d.getDate() + 1)) out.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`);
  return out;
};
