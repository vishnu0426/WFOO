/**
 * Scheduling › Schedule Replay. Steps through every change made to one schedule version, in order: the solver run, each manual edit
 * (who, when, why) and the publish, with the coverage, overtime and rule violations as they stood right after each step.
 */
import React, { useEffect, useState } from 'react';
import { Clock, FastForward, Pause, Play, Rewind, User } from 'lucide-react';
import { CartesianGrid, Line, LineChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { dec, ScheduleVersion } from '../../services/api';
import { useApi } from '../forecasting/hooks';
import { Btn, Card, Empty, Kpi, Pill, Select, Table } from '../forecasting/ui';

type Revision = { n: number; at: string; actorName: string; actorRole: string; kind: 'GENERATE' | 'EDIT' | 'PUBLISH'; summary: string; reason: string | null; coverage: number | null; underSlots: number | null; overtimeHours: number | null; paidHours: number | null; shifts: number | null; people: number | null; violations: number | null };
type Replay = { version: ScheduleVersion; revisions: Revision[] };

const KIND: Record<Revision['kind'], { label: string; tone: 'info' | 'warn' | 'good' }> = { GENERATE: { label: 'Generated', tone: 'info' }, EDIT: { label: 'Manual edit', tone: 'warn' }, PUBLISH: { label: 'Published', tone: 'good' } };
const when = (s: string) => new Date(s).toLocaleString();
const signed = (v: number, d = 1) => (v > 0 ? '+' : '') + dec(v, d);

export const ReplayPanel: React.FC<{ versions: ScheduleVersion[]; version: ScheduleVersion | null; select: (id: string) => void; go: (sub: string) => void }> = ({ versions, version, select, go }) => {
  const { data, error, loading } = useApi<Replay>(version ? `/scheduling/versions/${version.id}/revisions` : null, [version?.rev, version?.status]);
  const revs = data?.revisions ?? [];
  const [idx, setIdx] = useState(0);
  const [playing, setPlaying] = useState(false);
  useEffect(() => { setIdx(Math.max(0, revs.length - 1)); setPlaying(false); }, [version?.id, revs.length]);
  useEffect(() => {
    if (!playing) return;
    const t = setInterval(() => setIdx((i) => { if (i >= revs.length - 1) { setPlaying(false); return i; } return i + 1; }), 1800);
    return () => clearInterval(t);
  }, [playing, revs.length]);

  if (!versions.length) return <Empty title="No schedule to replay yet">Generate a schedule first. Every change to it is recorded from then on.<div className="mt-3"><Btn variant="primary" onClick={() => go('generate-schedule')}>Generate Schedule</Btn></div></Empty>;
  const cur = revs[idx], prev = idx > 0 ? revs[idx - 1] : null;
  const hasNumbers = revs.some((r) => r.coverage !== null);
  const delta = (a: number | null | undefined, b: number | null | undefined, d = 1) => (a == null || b == null ? null : a - b === 0 ? '±0' : signed(a - b, d));
  const chart = revs.filter((r) => r.coverage !== null).map((r) => ({ n: r.n, coverage: r.coverage }));

  return (
    <div className="space-y-6">
      <Card title="Schedule version" sub="Pick the version to replay. Only changes made since revision tracking began carry measured numbers."
        actions={<Select value={version?.id ?? ''} onChange={(e) => select(e.target.value)} className="!w-auto" aria-label="Schedule version">{versions.map((v) => <option key={v.id} value={v.id}>{v.name} · {v.status.toLowerCase()}</option>)}</Select>}>
        {error && <p className="text-[13px] text-[#C84A4A]">{error}</p>}
        {loading && !data && <p className="text-[13px] text-[#737373]">Loading history…</p>}
        {data && !revs.length && <p className="text-[13px] text-[#737373]">Nothing has been recorded for this version.</p>}
      </Card>

      {cur && (
        <>
          <div className="p-4 bg-[#FAFAF8] rounded-lg border border-[#E5E5E0] space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-2.5">
                <button onClick={() => { setPlaying(false); setIdx(0); }} className="p-2 rounded border border-[#E5E5E0] bg-white hover:bg-[#F5F5F2]" title="Back to the first step"><Rewind className="w-4 h-4" /></button>
                <button onClick={() => { if (idx >= revs.length - 1) setIdx(0); setPlaying((p) => !p); }} className="px-4 py-2 rounded bg-[#171717] hover:bg-[#333] text-white text-[12px] font-semibold flex items-center gap-2">
                  {playing ? <Pause className="w-4 h-4" /> : <Play className="w-4 h-4 fill-white" />}{playing ? 'Pause' : 'Play'}
                </button>
                <button onClick={() => { setPlaying(false); setIdx(Math.min(revs.length - 1, idx + 1)); }} className="p-2 rounded border border-[#E5E5E0] bg-white hover:bg-[#F5F5F2]" title="Next step"><FastForward className="w-4 h-4" /></button>
                <Pill>Step {cur.n} of {revs.length}</Pill>
              </div>
              <div className="text-[12px] text-[#737373] flex items-center gap-2 font-mono"><Clock className="w-3.5 h-3.5" />{when(cur.at)}</div>
            </div>
            <input type="range" min={0} max={Math.max(0, revs.length - 1)} value={idx} onChange={(e) => { setPlaying(false); setIdx(+e.target.value); }} className="w-full h-2 bg-[#E5E5E0] rounded-lg appearance-none cursor-pointer accent-[#171717]" aria-label="Replay position" />
          </div>

          <Card>
            <div className="flex flex-wrap items-start justify-between gap-4 border-b border-[#E5E5E0] pb-4">
              <div>
                <Pill tone={KIND[cur.kind].tone}>{KIND[cur.kind].label}</Pill>
                <h2 className="text-[18px] font-bold text-[#171717] mt-2">{cur.summary}</h2>
                {cur.reason && <p className="text-[13px] text-[#525252] mt-1 max-w-2xl">Reason given: {cur.reason}</p>}
              </div>
              <div className="text-right">
                <div className="text-[12px] font-semibold text-[#171717] flex items-center gap-1.5 justify-end"><User className="w-3.5 h-3.5 text-[#737373]" />{cur.actorName}</div>
                <div className="text-[11px] text-[#737373] font-mono">{cur.actorRole}</div>
              </div>
            </div>
            <div className="grid grid-cols-2 xl:grid-cols-4 gap-4">
              <Kpi label="Coverage" value={cur.coverage == null ? '–' : `${dec(cur.coverage)}%`} tone={cur.coverage == null ? undefined : cur.coverage >= 95 ? 'good' : cur.coverage >= 85 ? 'warn' : 'bad'} sub={prev ? `${delta(cur.coverage, prev.coverage) ?? '–'} points vs step ${prev.n}` : 'Share of required staff-time that is covered'} />
              <Kpi label="Overtime scheduled" value={cur.overtimeHours == null ? '–' : `${dec(cur.overtimeHours)} h`} sub={prev ? `${delta(cur.overtimeHours, prev.overtimeHours) ?? '–'} h vs step ${prev.n}` : 'Hours above contract'} />
              <Kpi label="Shifts / people" value={cur.shifts == null ? '–' : `${cur.shifts}${cur.people != null ? ` / ${cur.people}` : ''}`} sub={prev && cur.shifts != null && prev.shifts != null ? `${delta(cur.shifts, prev.shifts, 0)} shifts vs step ${prev.n}` : 'Rostered in this version'} />
              <Kpi label="Rule violations" value={cur.violations == null ? '–' : cur.violations} tone={cur.violations == null ? undefined : cur.violations === 0 ? 'good' : 'bad'} sub={cur.violations === 0 ? 'Every rule is met' : 'Must be fixed before publishing'} />
            </div>
          </Card>

          {chart.length > 1 && (
            <Card title="Coverage across the steps" sub="How each change moved coverage. The dashed line marks the step you are viewing.">
              <div style={{ height: 200 }}>
                <ResponsiveContainer>
                  <LineChart data={chart} margin={{ top: 8, right: 16, bottom: 0, left: 0 }}>
                    <CartesianGrid stroke="#E5E5E0" strokeDasharray="3 3" vertical={false} />
                    <XAxis dataKey="n" tick={{ fontSize: 11 }} tickFormatter={(v) => `Step ${v}`} />
                    <YAxis domain={['dataMin - 2', 'dataMax + 2']} tick={{ fontSize: 11 }} tickFormatter={(v) => `${Math.round(v)}%`} width={44} />
                    <Tooltip formatter={(v: any) => [`${dec(Number(v))}%`, 'Coverage']} labelFormatter={(v) => `Step ${v}`} />
                    <ReferenceLine x={cur.n} stroke="#171717" strokeDasharray="4 3" />
                    <Line type="monotone" dataKey="coverage" stroke="#2F7D5A" strokeWidth={2} dot={{ r: 3 }} isAnimationActive={false} />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            </Card>
          )}
          {!hasNumbers && <p className="text-[12px] text-[#737373]">This version was changed before results were recorded per step, so only who, when and what are shown.</p>}

          <Card title="All steps">
            <Table head={['Step', 'When', 'Who', 'What', 'Reason', 'Coverage']} right={[5]}>
              {revs.map((r, i) => (
                <tr key={r.n} onClick={() => { setPlaying(false); setIdx(i); }} className={`cursor-pointer hover:bg-[#FAFAF8] ${i === idx ? 'bg-[#FAFAF8]' : ''}`}>
                  <td className="p-3 font-mono">{r.n}</td>
                  <td className="p-3 whitespace-nowrap text-[#525252]">{when(r.at)}</td>
                  <td className="p-3">{r.actorName}<div className="text-[11px] text-[#737373]">{r.actorRole}</div></td>
                  <td className="p-3"><Pill tone={KIND[r.kind].tone}>{KIND[r.kind].label}</Pill> <span className="ml-1">{r.summary}</span></td>
                  <td className="p-3 text-[#525252]">{r.reason ?? '–'}</td>
                  <td className="p-3 text-right font-mono">{r.coverage == null ? '–' : `${dec(r.coverage)}%`}</td>
                </tr>
              ))}
            </Table>
          </Card>
        </>
      )}
    </div>
  );
};
