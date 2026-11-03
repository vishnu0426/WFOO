/**
 * Accuracy over time: how the published forecasts really did, week by week, per queue. Shows drift (getting worse), a forecast that keeps running
 * high or low, and which queue needs attention, before the schedule built on it suffers.
 */
import React, { useState } from 'react';
import { dayYear, lean, pct } from '../../services/api';
import { useForecast } from '../../services/forecastStore';
import { useApi } from './hooks';
import { CHART, LineChart } from './charts';
import { Banner, Busy, Card, Pill, Seg, Table } from './ui';

type Week = { weekStart: string; days: number; actual: number; forecast: number; wapeDaily: number; wape15: number; bias: number };
type Trend = { queueId: string; name: string; weeks: Week[]; latest: Week | null; direction: 'IMPROVING' | 'STEADY' | 'WORSENING'; status: 'GOOD' | 'CHECK' | 'POOR' | 'NO_DATA'; consistentBias: 'HIGH' | 'LOW' | null; message: string };
type Resp = { weekStart: number; weeks: number; limits: { good: number; poor: number; bias: number }; total: Trend; queues: Trend[] };

const STATUS = { GOOD: { label: 'Good', tone: 'good' }, CHECK: { label: 'Check', tone: 'warn' }, POOR: { label: 'Poor', tone: 'bad' }, NO_DATA: { label: 'No data', tone: 'neutral' } } as const;
const DIR = { IMPROVING: { label: 'Improving', tone: 'good' }, STEADY: { label: 'Steady', tone: 'neutral' }, WORSENING: { label: 'Getting worse', tone: 'bad' } } as const;

export const AccuracyTrend: React.FC = () => {
  const { group } = useForecast();
  const [weeks, setWeeks] = useState('12');
  const r = useApi<Resp>(group ? `/forecast/accuracy-trend?groupId=${group.id}&weeks=${weeks}` : null, [group?.id, weeks]);
  const t = r.data;
  const flagged = (t?.queues ?? []).filter((q) => q.direction === 'WORSENING' || q.status === 'POOR' || q.consistentBias);
  return (
    <Card title="Accuracy over time" sub="How each published forecast really did, week after week, once its days had passed. The score is the average daily miss; weeks with fewer than four days of data are left out."
      actions={<Seg options={[{ id: '8', label: '8 weeks' }, { id: '12', label: '12 weeks' }, { id: '26', label: '26 weeks' }]} value={weeks} onChange={setWeeks} />}>
      {r.loading && !t && <Busy text="Comparing published forecasts with what happened…" />}
      {r.error && <Banner kind="warn">{r.error}</Banner>}
      {t && t.total.weeks.length === 0 && <p className="text-[13px] text-[#6B6B6B]">Nothing to show yet: publish a short-term forecast and let at least four of its days pass.</p>}
      {t && t.total.weeks.length > 0 && (
        <>
          {flagged.length > 0 && <Banner kind="warn"><span className="font-semibold">Needs a look: </span>{flagged.map((q) => q.name).join(', ')}. {flagged[0].message}</Banner>}
          <LineChart
            height={220} leftLabel="Average daily miss (%)" labels={t.total.weeks.map((w) => w.weekStart.slice(5))}
            series={[
              { name: 'Average miss', color: CHART.forecast, values: t.total.weeks.map((w) => Math.round(w.wapeDaily * 1000) / 10) },
              { name: `Good below ${Math.round(t.limits.good * 100)}%`, color: CHART.success, kind: 'dashed', values: t.total.weeks.map(() => t.limits.good * 100) },
              { name: `Poor from ${Math.round(t.limits.poor * 100)}%`, color: CHART.bad, kind: 'dashed', values: t.total.weeks.map(() => t.limits.poor * 100) },
            ]}
            tooltip={(i) => { const w = t.total.weeks[i]; return <div className="text-[#525252]">Week of {dayYear(w.weekStart)}: forecast <b className="font-mono text-[#171717]">{w.forecast.toLocaleString()}</b>, actual <b className="font-mono text-[#171717]">{w.actual.toLocaleString()}</b> ({lean(w.bias)})</div>; }}
          />
          <Table head={['Queue', 'Latest week', 'Daily miss', '15-min miss', 'Over / under', 'Trend', 'State']} right={[2, 3, 4]}>
            {[t.total, ...t.queues].map((q) => (
              <React.Fragment key={q.queueId}>
                <tr>
                  <td className="p-3 font-medium">{q.name}</td>
                  <td className="p-3">{q.latest ? dayYear(q.latest.weekStart) : '–'}</td>
                  <td className="p-3 text-right font-mono">{q.latest ? pct(q.latest.wapeDaily, 1) : '–'}</td>
                  <td className="p-3 text-right font-mono">{q.latest ? pct(q.latest.wape15, 1) : '–'}</td>
                  <td className="p-3 text-right font-mono">{q.latest ? lean(q.latest.bias) : '–'}</td>
                  <td className="p-3"><Pill tone={DIR[q.direction].tone}>{DIR[q.direction].label}</Pill></td>
                  <td className="p-3"><Pill tone={STATUS[q.status].tone}>{STATUS[q.status].label}</Pill></td>
                </tr>
                {q.status !== 'NO_DATA' && <tr><td colSpan={7} className="px-3 pb-3 text-[12px] text-[#525252]">{q.message}</td></tr>}
              </React.Fragment>
            ))}
          </Table>
        </>
      )}
    </Card>
  );
};
