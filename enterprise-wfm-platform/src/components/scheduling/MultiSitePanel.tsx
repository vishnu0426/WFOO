/**
 * Scheduling › Multi-Site Coverage. One page for how several sites and groups are covered: day by day (every published schedule side by side) and, when the groups are in
 * different time zones, around the clock (the sites on one clock, where the combined cover falls short). The tabs are two addresses of the same page, so each can be bookmarked.
 */
import React from 'react';
import { useForecast } from '../../services/forecastStore';
import { Banner, Empty, Seg } from '../forecasting/ui';
import { RollupPanel } from './RollupPanel';
import { SunPanel } from './SunPanel';

export const MultiSitePanel: React.FC<{ tab: 'DAY' | 'SUN'; go: (sub: string) => void }> = ({ tab, go }) => {
  const { groups } = useForecast();
  if (groups.length < 2) return <Empty title="Two or more WFM groups are needed">This page compares sites and groups. Create the groups for each site, publish a schedule for each, and they show up here together.</Empty>;
  // the clock view only means something when the groups are not on the same one
  const aroundTheClock = new Set(groups.map((g) => g.timezone)).size >= 2;
  const showing = tab === 'SUN' && aroundTheClock ? 'SUN' : 'DAY';
  return (
    <div className="space-y-6">
      {aroundTheClock && <Seg options={[{ id: 'DAY', label: 'By group and day' }, { id: 'SUN', label: 'Around the clock' }]} value={showing} onChange={(v) => go(v === 'SUN' ? 'follow-the-sun' : 'multi-site')} />}
      {tab === 'SUN' && !aroundTheClock && <Banner kind="info">Around the clock needs groups in at least two time zones. All of yours are on the same one, so the day-by-day view is shown.</Banner>}
      {showing === 'SUN' ? <SunPanel /> : <RollupPanel />}
    </div>
  );
};
