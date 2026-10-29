/**
 * Scheduling: Schedule Timeline, Generate Schedule, Shift Templates, Compare Versions and Schedule Replay, all live.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Layers } from 'lucide-react';
import { api, dec, ScheduleVersion } from '../../services/api';
import { useForecast } from '../../services/forecastStore';
import { useApi } from '../forecasting/hooks';
import { CHART, LineChart } from '../forecasting/charts';
import { Busy, Card, Empty, Kpi, KpiRow, PageHeader, Select } from '../forecasting/ui';
import { NoticeBanner } from '../forecasting/VersionBar';
import { GeneratePanel } from './GeneratePanel';
import { TemplatesPanel } from './TemplatesPanel';
import { TimelinePanel } from './TimelinePanel';
import { ReplayPanel } from './ReplayPanel';
import { QualityPanel } from './QualityPanel';
import { SwapsPanel } from './SwapsPanel';
import { OffersPanel } from './OffersPanel';
import { BidsPanel } from './BidsPanel';
import { RollupPanel } from './RollupPanel';
import { RotationsPanel } from './RotationsPanel';
import { SchedulesSection } from './SchedulesSection';

const TITLES: Record<string, { title: string; sub: string }> = {
  'schedule-timeline': { title: 'Schedule Timeline', sub: 'Who works when, and how well it covers the forecast.' },
  'generate-schedule': { title: 'Generate Schedule', sub: 'Build a draft roster from the published forecast.' },
  'schedule-quality': { title: 'Schedule Quality', sub: 'How good a schedule is, where it falls short and why, and what happened when it was generated.' },
  'shift-templates': { title: 'Shift Templates', sub: 'The shift shapes the generator can use.' },
  'schedule-compare': { title: 'Compare Versions', sub: 'See what changed between two schedules.' },
  'multi-site': { title: 'Multi-Site View', sub: 'Every published schedule side by side, by site and group, on one clock.' },
  'all-schedules': { title: 'All Schedules', sub: 'Every schedule version across every WFM group, current and past.' },
  rotations: { title: 'Rotation Patterns', sub: 'Fixed repeating cycles (4-on-4-off, DuPont...) rather than schedules matched to a forecast.' },
  'shift-bidding': { title: 'Shift Bidding', sub: 'Let people rank weekly patterns, then decide the result fairly and build a draft schedule from it.' },
  'vto-overtime': { title: 'VTO & Overtime', sub: 'Offer time off when a day is overstaffed and extra hours when it is short.' },
  'shift-swaps': { title: 'Shift Swaps', sub: 'Trades between colleagues, checked against the schedule rules before anyone is asked to approve.' },
  'schedule-replay': { title: 'Schedule Replay', sub: 'Step through every change made to a schedule, with who made it, why, and what it did to coverage.' },
};

export const SchedulingHub: React.FC<{ activeSubSection?: string; onNavigateSubSection: (sub: string) => void }> = ({ activeSubSection = 'schedule-timeline', onNavigateSubSection }) => {
  const { groups, group, setGroupId, ready } = useForecast();
  const [versions, setVersions] = useState<ScheduleVersion[]>([]);
  const [id, setId] = useState<string | null>(null);
  const pendingVersionId = useRef<string | null>(null);

  const reload = useCallback(async (selectId?: string) => {
    if (!group) { setVersions([]); setId(null); return; }
    const vs = await api<ScheduleVersion[]>(`/scheduling/versions?groupId=${group.id}`);
    setVersions(vs);
    setId((cur) => selectId && vs.some((v) => v.id === selectId) ? selectId : cur && vs.some((v) => v.id === cur) ? cur : (vs.find((v) => v.status === 'PUBLISHED') ?? vs[0])?.id ?? null);
  }, [group?.id]);
  useEffect(() => { const sel = pendingVersionId.current; pendingVersionId.current = null; setId(null); reload(sel ?? undefined).catch(() => {}); }, [group?.id]);

  const openSchedule = (v: ScheduleVersion) => {
    if (group?.id === v.wfmGroupId) setId(v.id); else { pendingVersionId.current = v.id; setGroupId(v.wfmGroupId); }
    onNavigateSubSection('schedule-timeline');
  };

  const meta = TITLES[activeSubSection] ?? TITLES['schedule-timeline'];
  const version = versions.find((v) => v.id === id) ?? null;
  const usesGroup = activeSubSection !== 'shift-templates' && activeSubSection !== 'shift-swaps' && activeSubSection !== 'multi-site' && activeSubSection !== 'all-schedules';

  return (
    <div className="flex-1 flex flex-col h-[calc(100vh-3.5rem)] overflow-y-auto bg-[#FFFFFF] p-6 space-y-6">
      <PageHeader title={meta.title} sub={meta.sub}
        actions={usesGroup && groups.length > 0 && (
          <div className="flex items-center gap-2 text-[12px] text-[#525252]"><Layers className="w-3.5 h-3.5 text-[#737373]" />
            <Select value={group?.id ?? ''} onChange={(e) => setGroupId(e.target.value)} className="!w-auto" aria-label="WFM group">{groups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}</Select>
          </div>
        )} />
      <NoticeBanner />
      {!ready ? <Busy text="Loading…" /> : activeSubSection === 'shift-templates' ? <TemplatesPanel />
        : activeSubSection === 'shift-swaps' ? <SwapsPanel />
        : activeSubSection === 'vto-overtime' ? <OffersPanel />
        : activeSubSection === 'shift-bidding' ? <BidsPanel />
        : activeSubSection === 'multi-site' ? <RollupPanel />
        : activeSubSection === 'all-schedules' ? <SchedulesSection open={openSchedule} onChanged={() => reload()} />
        : groups.length === 0 ? <Empty title="No WFM group yet">Create a WFM group in Configuration, add people and shift templates, then generate a schedule.</Empty>
        : activeSubSection === 'rotations' ? <RotationsPanel go={onNavigateSubSection} />
        : activeSubSection === 'generate-schedule' ? <GeneratePanel versions={versions} go={onNavigateSubSection} onCreated={(v) => reload(v.id)} />
        : activeSubSection === 'schedule-compare' ? <ComparePanel versions={versions} />
        : activeSubSection === 'schedule-quality' ? <QualityPanel versions={versions} version={version} select={setId} reload={reload} go={onNavigateSubSection} />
        : activeSubSection === 'schedule-replay' ? <ReplayPanel versions={versions} version={version} select={setId} go={onNavigateSubSection} />
        : <TimelinePanel versions={versions} version={version} select={setId} reload={reload} go={onNavigateSubSection} />}
    </div>
  );
};

type Compare = { a: { version: ScheduleVersion; daily: { day: string; coveragePercent: number }[] }; b: { version: ScheduleVersion; daily: { day: string; coveragePercent: number }[] };
  delta: { coveragePercent: number; paidHours: number; overtimeHours: number; violations: number; shifts: number }; shiftsChanged: { onlyInA: number; onlyInB: number; same: number } };

const ComparePanel: React.FC<{ versions: ScheduleVersion[] }> = ({ versions }) => {
  const [a, setA] = useState('');
  const [b, setB] = useState('');
  useEffect(() => { if (versions.length >= 2) { setA((x) => x || versions[1].id); setB((x) => x || versions[0].id); } }, [versions]);
  const cmp = useApi<Compare>(a && b && a !== b ? `/scheduling/compare?a=${a}&b=${b}` : null);
  if (versions.length < 2) return <Empty title="Two schedules are needed">Generate at least two versions (for example with different weights) to compare them.</Empty>;
  const d = cmp.data?.delta;
  const sign = (v: number, dp = 1) => `${v > 0 ? '+' : ''}${dec(v, dp)}`;
  return (
    <div className="space-y-6">
      <Card title="Compare two schedules" sub="B is compared with A: positive numbers mean B has more.">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 max-w-3xl">
          <label className="text-[12px] font-semibold">A (baseline)<Select value={a} onChange={(e) => setA(e.target.value)} className="mt-1">{versions.map((v) => <option key={v.id} value={v.id}>{v.name} — {v.status.toLowerCase()}</option>)}</Select></label>
          <label className="text-[12px] font-semibold">B<Select value={b} onChange={(e) => setB(e.target.value)} className="mt-1">{versions.map((v) => <option key={v.id} value={v.id}>{v.name} — {v.status.toLowerCase()}</option>)}</Select></label>
        </div>
        {a === b && <p className="text-[12px] text-[#737373]">Choose two different schedules.</p>}
        {cmp.loading && <Busy text="Comparing…" />}
        {cmp.data && d && (
          <>
            <KpiRow>
              <Kpi label="Forecast covered" value={`${sign(d.coveragePercent)} pts`} tone={d.coveragePercent > 0 ? 'good' : d.coveragePercent < 0 ? 'bad' : undefined} sub={`${dec(cmp.data.a.version.stats.coverage.percent, 1)}% → ${dec(cmp.data.b.version.stats.coverage.percent, 1)}%`} />
              <Kpi label="Paid hours" value={sign(d.paidHours, 0)} sub={`${dec(cmp.data.a.version.stats.hours.paid, 0)} → ${dec(cmp.data.b.version.stats.hours.paid, 0)}`} />
              <Kpi label="Above contract" value={`${sign(d.overtimeHours, 0)}h`} tone={d.overtimeHours > 0 ? 'warn' : undefined} />
              <Kpi label="Rule violations" value={sign(d.violations, 0)} tone={d.violations > 0 ? 'bad' : d.violations < 0 ? 'good' : undefined} />
              <Kpi label="Shifts" value={sign(d.shifts, 0)} sub={`${cmp.data.shiftsChanged.same} identical, ${cmp.data.shiftsChanged.onlyInA} only in A, ${cmp.data.shiftsChanged.onlyInB} only in B`} />
            </KpiRow>
            <LineChart height={240} leftLabel="% of forecast covered" labels={cmp.data.a.daily.map((x) => x.day.slice(5))}
              series={[{ name: cmp.data.a.version.name, color: CHART.baseline, kind: 'dashed', values: cmp.data.a.daily.map((x) => x.coveragePercent) }, { name: cmp.data.b.version.name, color: CHART.forecast, values: cmp.data.b.daily.map((x) => x.coveragePercent) }]} />
          </>
        )}
      </Card>
    </div>
  );
};
