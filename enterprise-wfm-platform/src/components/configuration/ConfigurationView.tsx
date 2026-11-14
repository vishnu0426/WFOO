/**
 * Configuration workspace: WFM groups, activity definitions, scheduling rules and optimization weights.
 * All four are live against the gateway; the sidebar sub-menu and the tab switcher select the same tab.
 */

import React, { useEffect, useState } from 'react';
import { WfmGroupsPanel } from './WfmGroupsPanel';
import { ActivitiesPanel } from './ActivitiesPanel';
import { RtaMappingPanel } from './RtaMappingPanel';
import { OptimizationPanel, SchedulingRulesPanel } from './PolicyPanels';
import { CompliancePanel } from './CompliancePanel';
import { SelfServicePanel } from './SelfServicePanel';
import { IntegrationStationPanel } from './IntegrationStationPanel';
import { WorkCalendarPanel } from './WorkCalendarPanel';
import { OrganisationPanel } from './OrganisationPanel';
import { HelpTip } from '../common/HelpTip';

interface ConfigurationViewProps {
  activeSubSection?: string;
}

const TABS = [
  { id: 'organisation', label: 'Organisation' },
  { id: 'wfm-groups', label: 'WFM Groups' },
  { id: 'activities', label: 'Activity Definitions' },
  { id: 'scheduling-rules', label: 'Scheduling Rules' },
  { id: 'work-calendar', label: 'Work Calendar' },
  { id: 'integration-station', label: 'Integration Station' },
  { id: 'compliance-packs', label: 'Compliance Packs' },
  { id: 'self-service-rules', label: 'Self-Service Rules' },
  { id: 'rta-mapping', label: 'RTA State Mapping' },
  { id: 'optimization-objectives', label: 'Optimization Weights' },
] as const;
type TabId = (typeof TABS)[number]['id'];

export const ConfigurationView: React.FC<ConfigurationViewProps> = ({ activeSubSection = 'wfm-groups' }) => {
  const [tab, setTab] = useState<TabId>('wfm-groups');
  useEffect(() => {
    if (TABS.some((t) => t.id === activeSubSection)) setTab(activeSubSection as TabId);
  }, [activeSubSection]);

  return (
    <div className="flex-1 flex flex-col h-[calc(100vh-3.5rem)] overflow-y-auto bg-[#FFFFFF] p-6 space-y-6 select-none">
      <div className="flex flex-wrap items-center justify-between gap-4 border-b border-[#E5E5E0] pb-4">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-[22px] font-semibold text-[#171717]">Configuration & Optimization Policy<HelpTip title="Configuration" text="WFM group service levels, activity definitions, scheduling rules, labour-law packs, what employees can do themselves, RTA state mapping and the weights the schedule generator balances." /></h1>
            <span className="text-[11px] font-semibold px-2 py-0.5 rounded bg-[#FAFAF8] text-[#525252] border border-[#E5E5E0]">Tenant-Scoped</span>
          </div>
        </div>

        <div className="flex rounded border border-[#E5E5E0] bg-[#FAFAF8] p-0.5 text-[12px]">
          {TABS.map((t) => (
            <button key={t.id} onClick={() => setTab(t.id)} className={`px-3 py-1.5 rounded font-semibold transition-colors ${tab === t.id ? 'bg-[#FFFFFF] text-[#171717] shadow-xs' : 'text-[#6B6B6B]'}`}>
              {t.label}
            </button>
          ))}
        </div>
      </div>

      {tab === 'organisation' && <OrganisationPanel />}
      {tab === 'wfm-groups' && <WfmGroupsPanel />}
      {tab === 'activities' && <ActivitiesPanel />}
      {tab === 'scheduling-rules' && <SchedulingRulesPanel />}
      {tab === 'work-calendar' && <WorkCalendarPanel />}
      {tab === 'integration-station' && <IntegrationStationPanel />}
      {tab === 'compliance-packs' && <CompliancePanel />}
      {tab === 'self-service-rules' && <SelfServicePanel />}
      {tab === 'rta-mapping' && <RtaMappingPanel />}
      {tab === 'optimization-objectives' && <OptimizationPanel />}
    </div>
  );
};
