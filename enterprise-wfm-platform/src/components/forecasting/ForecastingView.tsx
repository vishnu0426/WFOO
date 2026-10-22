/**
 * Demand Forecasting & Capacity Planning. Dashboard, Forecasts and Builder use the reference design; the other sections keep their own layout.
 *   1 Forecast Dashboard · 2 Model Leaderboard · 3 Forecast Builder · 4 Adjustments · 5 Scenarios · 6 Accuracy Heatmap · 7 Capacity Plan
 * Everything shown is read from the gateway; nothing is seeded.
 */
import React from 'react';
import { Layers } from 'lucide-react';
import { useForecast } from '../../services/forecastStore';
import { Busy, Empty, Pill, PageHeader, Select } from './ui';
import { NoticeBanner, VersionBar } from './VersionBar';
import { DashboardSection } from './DashboardSection';
import { LeaderboardSection } from './LeaderboardSection';
import { BuilderSection } from './BuilderSection';
import { AdjustmentsSection } from './AdjustmentsSection';
import { ScenariosSection } from './ScenariosSection';
import { AccuracySection } from './AccuracySection';
import { CapacitySection } from './CapacitySection';
import { ForecastsSection } from './ForecastsSection';

const TITLES: Record<string, { n: number; title: string; sub: string }> = {
  'forecast-dashboard': { n: 0, title: 'Forecast Dashboard', sub: 'Expected contacts, handle time and the agents each interval needs.' },
  'all-forecasts': { n: 0, title: 'Forecasts', sub: 'Every forecast version with its status, model and accuracy.' },
  'forecast-builder': { n: 0, title: 'Forecast Builder', sub: 'Create a new forecast version from interval history.' },
  adjustments: { n: 0, title: 'Adjustments', sub: 'Change a draft forecast with a recorded reason.' },
  scenarios: { n: 0, title: 'Scenarios', sub: 'Compare “what if” cases against the forecast.' },
  'capacity-plan': { n: 0, title: 'Staffing', sub: 'People needed over weeks and months.' },
  'accuracy-heatmap': { n: 0, title: 'Accuracy', sub: 'How close the forecast was to what really happened.' },
  'model-leaderboard': { n: 0, title: 'Models', sub: 'Which forecasting method was most accurate on your own history.' },
};

export const ForecastingView: React.FC<{ activeSubSection?: string; onOpenTraceability?: unknown }> = ({ activeSubSection: requested = 'forecast-dashboard' }) => {
  // an address that matches no section (for example a stale bookmark) opens the dashboard the way its own URL does
  const activeSubSection = requested === 'forecasts' ? 'all-forecasts' : TITLES[requested] ? requested : 'forecast-dashboard';
  const { groups, group, setGroupId, version, ready, go } = useForecast();
  const meta = TITLES[activeSubSection] ?? TITLES['forecast-dashboard'];
  const usesVersion = !['forecast-builder', 'accuracy-heatmap', 'all-forecasts'].includes(activeSubSection);

  const body = () => {
    switch (activeSubSection) {
      case 'all-forecasts': return <ForecastsSection />;
      case 'model-leaderboard': return <LeaderboardSection />;
      case 'forecast-builder': return <BuilderSection />;
      case 'adjustments': return <AdjustmentsSection />;
      case 'scenarios': return <ScenariosSection />;
      case 'accuracy-heatmap': return <AccuracySection />;
      case 'capacity-plan': return <CapacitySection />;
      default: return <DashboardSection />;
    }
  };

  // these screens draw their own header and run edge to edge, like the reference design
  if (['forecast-dashboard', 'forecast-builder', 'all-forecasts', 'adjustments', 'scenarios', 'model-leaderboard', 'capacity-plan'].includes(activeSubSection)) {
    return (
      <div className="ref-ui flex-1 flex flex-col h-[calc(100vh-3.5rem)] overflow-y-auto bg-background">
        <div className="px-6 pt-3 empty:hidden"><NoticeBanner /></div>
        {!ready ? <div className="p-6"><Busy text="Loading…" /></div> : groups.length === 0 ? (
          <div className="p-6"><Empty title="No WFM group yet">
            A WFM group is a set of queues that share one pool of agents. <button className="underline" onClick={() => go('wfm-groups', 'configuration')}>Create one in Configuration</button>, then import interval history.
          </Empty></div>
        ) : body()}
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col h-[calc(100vh-3.5rem)] overflow-y-auto bg-[#FFFFFF] p-6 space-y-6">
      <PageHeader
        title={meta.n ? `${meta.n} · ${meta.title}` : meta.title}
        sub={meta.sub}
        badge={version && usesVersion ? <Pill tone={version.status === 'PUBLISHED' ? 'good' : 'neutral'}>{version.name}</Pill> : undefined}
        actions={groups.length > 0 && (
          <div className="flex items-center gap-2 text-[12px] text-[#525252]">
            <Layers className="w-3.5 h-3.5 text-[#737373]" />
            <Select value={group?.id ?? ''} onChange={(e) => setGroupId(e.target.value)} className="!w-auto" aria-label="WFM group">
              {groups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
            </Select>
          </div>
        )}
      />
      <NoticeBanner />
      {!ready ? <Busy text="Loading…" /> : groups.length === 0 ? (
        <Empty title="No WFM group yet">
          A WFM group is a set of queues that share one pool of agents. <button className="underline" onClick={() => go('wfm-groups', 'configuration')}>Create one in Configuration</button>, then import interval history.
        </Empty>
      ) : (
        <>
          {usesVersion && <VersionBar />}
          {body()}
        </>
      )}
    </div>
  );
};
