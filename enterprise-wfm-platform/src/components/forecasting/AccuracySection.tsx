/**
 * 6 · Accuracy Heatmap: how good was the forecast? Two views: a hold-out test (forecast the last N days from the history
 * before them and compare with what really happened) and realised accuracy of forecasts that were published.
 */
import React, { useState } from 'react';
import { dayName, dayYear, dec, pct, lean, MODEL_LABEL, Score } from '../../services/api';
import { useForecast } from '../../services/forecastStore';
import { useApi } from './hooks';
import { AccuracyGrid, CHART, LineChart } from './charts';
import { Banner, Busy, Card, Empty, Kpi, KpiRow, Seg, Table } from './ui';

type Metric = { wape: number; bias: number; actual: number; forecast: number };
type Accuracy = {
  window: { from: string; to: string };
  total: { interval: Metric; hourly: Metric; daily: Metric };
  queues: { queueId: string; name: string; model: string; interval: Metric; hourly: Metric; daily: Metric; withinBand: number }[];
  byDay: { day: string; actual: number; forecast: number }[];
  byDayHour: { day: string; hour: number; actual: number; forecast: number }[];
  byHour: { hour: number; wape: number; bias: number; actual: number }[];
  realised: { day: string; actual: number; forecast: number; wape15: number; bias: number; intervals: number }[];
  models: { queueId: string | null; model: string; scores: Score[] }[];
};

const tone = (w: number) => (w < 0.08 ? 'good' : w < 0.15 ? 'warn' : 'bad');

export const AccuracySection: React.FC = () => {
  const { group } = useForecast();
  const [span, setSpan] = useState('14');
  const acc = useApi<Accuracy>(group ? `/forecast/accuracy?groupId=${group.id}&days=${span}` : null);
  if (!group) return <Empty title="No WFM group yet" />;

  const a = acc.data;
  return (
    <div className="space-y-6">
      <Card
        title="Forecast accuracy"
        sub="A fair test: the forecast is rebuilt using only the history from before the window, then compared with what actually happened. The score shown is the average miss: how far off the forecast was, as a share of real volume."
        actions={<Seg options={[{ id: '7', label: '7 days' }, { id: '14', label: '14 days' }, { id: '28', label: '28 days' }]} value={span} onChange={setSpan} />}
      >
        {acc.loading && <Busy text="Re-forecasting the last days from earlier history…" />}
        {acc.error && <Banner kind="warn">{acc.error}</Banner>}
        {a && (
          <>
            <KpiRow>
              <Kpi label="Avg. miss · 15 min" value={pct(a.total.interval.wape, 1)} tone={tone(a.total.interval.wape)} sub={`${lean(a.total.interval.bias)} overall`} />
              <Kpi label="Avg. miss · hourly" value={pct(a.total.hourly.wape, 1)} tone={tone(a.total.hourly.wape)} sub="what most schedules are built on" />
              <Kpi label="Avg. miss · daily" value={pct(a.total.daily.wape, 1)} tone={tone(a.total.daily.wape)} sub={`${a.total.daily.forecast.toLocaleString()} forecast vs ${a.total.daily.actual.toLocaleString()} actual`} />
              <Kpi label="Window" value={<span className="text-[15px]">{dayYear(a.window.from)} → {dayYear(a.window.to)}</span>} />
            </KpiRow>

            <LineChart
              height={240} leftLabel="Contacts per day" labels={a.byDay.map((d) => d.day.slice(5))}
              series={[{ name: 'Forecast', color: CHART.forecast, area: true, values: a.byDay.map((d) => d.forecast) }, { name: 'Actual', color: CHART.actual, values: a.byDay.map((d) => d.actual) }]}
              tooltip={(i) => { const d = a.byDay[i]; const off = d.actual > 0 ? ((d.forecast - d.actual) / d.actual) * 100 : 0; return <div className="text-[#525252]">Forecast was <b className="font-mono text-[#171717]">{Math.abs(off).toFixed(1)}%</b> {off > 0 ? 'over' : off < 0 ? 'under' : 'on target'}</div>; }}
            />
          </>
        )}
      </Card>

      {a && (
        <>
          <Card title="Day × hour" sub="Each cell is how far off that hour was, as a share of the real volume. Hover for the numbers.">
            <AccuracyGrid cells={a.byDayHour} dayLabel={dayName} />
          </Card>

          <Card title="By queue">
            <Table head={['Queue', 'Model used', 'Avg. miss · 15 min', 'Avg. miss · hourly', 'Avg. miss · daily', 'Over / under', 'Actual within range']} right={[2, 3, 4, 5, 6]}>
              {a.queues.map((q) => (
                <tr key={q.queueId}>
                  <td className="p-3 font-medium">{q.name}</td><td className="p-3">{MODEL_LABEL[q.model] ?? q.model}</td>
                  <td className="p-3 text-right font-mono">{pct(q.interval.wape, 1)}</td><td className="p-3 text-right font-mono">{pct(q.hourly.wape, 1)}</td><td className="p-3 text-right font-mono">{pct(q.daily.wape, 1)}</td>
                  <td className="p-3 text-right font-mono">{lean(q.interval.bias)}</td><td className="p-3 text-right font-mono">{pct(q.withinBand)}</td>
                </tr>
              ))}
            </Table>
            <p className="text-[11px] text-[#737373]">“Actual within range” is how often real volume landed between the low and high estimate. It should be around 80%.</p>
          </Card>

          <Card title="Published forecasts vs what happened" sub="Once a published forecast's days have passed, its numbers are compared with the actuals that arrived.">
            {a.realised.length === 0 ? <p className="text-[12px] text-[#737373]">Nothing to compare yet: publish a short-term forecast and let some of its days pass.</p> : (
              <Table head={['Day', 'Forecast', 'Actual', 'Avg. miss · 15 min', 'Over / under']} right={[1, 2, 3, 4]}>
                {a.realised.map((r) => (
                  <tr key={r.day}><td className="p-3">{dayName(r.day)}</td><td className="p-3 text-right font-mono">{dec(r.forecast, 0)}</td><td className="p-3 text-right font-mono">{dec(r.actual, 0)}</td><td className="p-3 text-right font-mono">{pct(r.wape15, 1)}</td><td className="p-3 text-right font-mono">{lean(r.bias)}</td></tr>
                ))}
              </Table>
            )}
          </Card>
        </>
      )}
    </div>
  );
};
