/**
 * Global Navigation Sidebar
 * Implements Section 7 hierarchy with role awareness, active indicators,
 * collapsibility, and locked enterprise design aesthetics.
 */

import React, { useEffect, useState } from 'react';
import {
  LayoutDashboard,
  Users,
  CalendarDays,
  Activity,
  Settings2,
  FileSpreadsheet,
  ChevronDown,
  ChevronRight,
  TrendingUp,
  Clock,
  Briefcase,
  Shield,
  Layers,
  Sparkles,
  Database,
  BarChart3,
  CalendarCheck,
  History,
  CheckCircle,
} from 'lucide-react';
import { useForecast } from '../../services/forecastStore';

export type NavigationModule =
  | 'overview'
  | 'workforce'
  | 'forecasting'
  | 'scheduling'
  | 'intraday'
  | 'configuration'
  | 'data-management'
  | 'audit'
  | 'administration';

interface NavigationSidebarProps {
  activeModule: NavigationModule;
  activeSubSection?: string;
  onNavigate: (module: NavigationModule, subSection?: string) => void;
  activeRole?: unknown;
}

export const NavigationSidebar: React.FC<NavigationSidebarProps> = ({
  activeModule,
  activeSubSection,
  onNavigate,
  activeRole,
}) => {
  const [expandedSections, setExpandedSections] = useState<Record<string, boolean>>({
    workforce: true,
    forecasting: true,
    scheduling: true,
    intraday: true,
    configuration: false,
    administration: false,
  });

  // opening a screen by its address (or with back / forward) expands the section it belongs to
  useEffect(() => { setExpandedSections((prev) => (prev[activeModule] ? prev : { ...prev, [activeModule]: true })); }, [activeModule]);

  const { versions } = useForecast();
  const [engineUp, setEngineUp] = useState<boolean | null>(null);
  useEffect(() => {
    let live = true;
    const ping = () => fetch('/health').then((r) => r.json()).then((h) => live && setEngineUp(!!h.engine)).catch(() => live && setEngineUp(false));
    ping();
    const t = setInterval(ping, 30000);
    return () => { live = false; clearInterval(t); };
  }, []);
  const published = versions.find((v) => v.status === 'PUBLISHED' && v.kind === 'SHORT') ?? versions.find((v) => v.status === 'PUBLISHED');

  const toggleSection = (section: string) => {
    setExpandedSections((prev) => ({ ...prev, [section]: !prev[section] }));
  };

  const navItems = [
    {
      id: 'overview' as NavigationModule,
      label: 'Overview',
      icon: LayoutDashboard,
    },
    {
      id: 'workforce' as NavigationModule,
      label: 'Workforce',
      icon: Users,
      subItems: [
        { id: 'employees', label: 'Employees' },
        { id: 'teams', label: 'Teams' },
        { id: 'skills', label: 'Skills' },
        { id: 'availability', label: 'Availability' },
        { id: 'time-off', label: 'Time Off' },
        { id: 'attendance', label: 'Time & Attendance' },
      ],
    },
    {
      id: 'forecasting' as NavigationModule,
      label: 'Forecasting',
      icon: TrendingUp,
      subItems: [
        { id: 'forecast-dashboard', label: 'Forecast Dashboard' },
        { id: 'all-forecasts', label: 'Forecasts' },
        { id: 'forecast-builder', label: 'Forecast Builder' },
        { id: 'adjustments', label: 'Adjustments' },
        { id: 'scenarios', label: 'Scenarios' },
        { id: 'capacity-plan', label: 'Staffing' },
        { id: 'accuracy-heatmap', label: 'Accuracy' },
        { id: 'model-leaderboard', label: 'Models' },
      ],
    },
    {
      id: 'scheduling' as NavigationModule,
      label: 'Scheduling',
      icon: CalendarDays,
      subItems: [
        { id: 'schedule-timeline', label: 'Schedule Timeline' },
        { id: 'generate-schedule', label: 'Generate Schedule' },
        { id: 'schedule-quality', label: 'Schedule Quality' },
        { id: 'shift-templates', label: 'Shift Templates' },
        { id: 'all-schedules', label: 'All Schedules' },
        { id: 'multi-site', label: 'Multi-Site View' },
        { id: 'rotations', label: 'Rotation Patterns' },
        { id: 'shift-swaps', label: 'Shift Swaps' },
        { id: 'vto-overtime', label: 'VTO & Overtime' },
        { id: 'shift-bidding', label: 'Shift Bidding' },
        { id: 'schedule-compare', label: 'Compare Versions' },
        { id: 'schedule-replay', label: 'Schedule Replay' },
      ],
    },
    {
      id: 'intraday' as NavigationModule,
      label: 'Intraday & RTA',
      icon: Activity,
      badge: 'Live',
      subItems: [
        { id: 'live-coverage', label: 'Live Coverage' },
        { id: 'adherence', label: 'Real-Time Adherence' },
        { id: 'break-optimizer', label: 'Break Optimizer' },
        { id: 'ai-recommendations', label: 'Recommended Actions' },
      ],
    },
    {
      id: 'configuration' as NavigationModule,
      label: 'Configuration',
      icon: Settings2,
      subItems: [
        { id: 'wfm-groups', label: 'WFM Groups' },
        { id: 'activities', label: 'Activity Definitions' },
        { id: 'scheduling-rules', label: 'Scheduling Rules' },
        { id: 'sites-skills', label: 'Sites & Skills' },
        { id: 'integration-station', label: 'Integration Station' },
        { id: 'compliance-packs', label: 'Compliance Packs' },
        { id: 'self-service-rules', label: 'Self-Service Rules' },
        { id: 'rta-mapping', label: 'RTA State Mapping' },
        { id: 'optimization-objectives', label: 'Optimization Weights' },
      ],
    },
    {
      id: 'data-management' as NavigationModule,
      label: 'Data Management',
      icon: Database,
      subItems: [
        { id: 'staged-imports', label: 'Staged Ingestion' },
        { id: 'data-quality', label: 'Data Quality' },
        { id: 'scheduled-syncs', label: 'Scheduled Ingestion' },
      ],
    },
    {
      id: 'audit' as NavigationModule,
      label: 'Audit & Governance',
      icon: Shield,
    },
    {
      id: 'administration' as NavigationModule,
      label: 'Security & Access',
      icon: Layers,
      subItems: [
        { id: 'users', label: 'Users Directory' },
        { id: 'roles', label: 'RBAC Matrix' },
      ],
    },
  ];

  return (
    <aside className="w-60 border-r border-[#E5E5E0] bg-[#FAFAF8] flex flex-col justify-between select-none h-[calc(100vh-3.5rem)] sticky top-14">
      {/* Navigation Links */}
      <div className="flex-1 overflow-y-auto p-2.5 space-y-1">
        <div className="px-2 py-1 text-[11px] font-semibold text-[#737373] uppercase tracking-wider">
          WFM Core Modules
        </div>

        {navItems.map((item) => {
          const isActive = activeModule === item.id;
          const isExpanded = !!expandedSections[item.id];
          const hasSubItems = item.subItems && item.subItems.length > 0;
          const Icon = item.icon;

          return (
            <div key={item.id} className="space-y-0.5">
              <div
                onClick={() => {
                  onNavigate(item.id, hasSubItems ? item.subItems![0].id : undefined);
                  if (hasSubItems) toggleSection(item.id);
                }}
                className={`flex items-center justify-between px-2.5 py-1.5 rounded cursor-pointer text-[13px] font-medium transition-colors ${
                  isActive
                    ? 'bg-[#FFFFFF] text-[#171717] shadow-xs border border-[#E5E5E0]'
                    : 'text-[#525252] hover:bg-[#F5F5F2] hover:text-[#171717]'
                }`}
              >
                <div className="flex items-center gap-2.5">
                  <Icon className={`w-4 h-4 ${isActive ? 'text-[#171717]' : 'text-[#737373]'}`} />
                  <span>{item.label}</span>
                </div>

                <div className="flex items-center gap-1.5">
                  {item.badge && (
                    <span className="text-[10px] font-semibold px-1.5 py-0.2 rounded-full bg-[#EAF5EF] text-[#2F7D5A] border border-[#2F7D5A]/20">
                      {item.badge}
                    </span>
                  )}
                  {hasSubItems && (
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        toggleSection(item.id);
                      }}
                      className="p-0.5 hover:bg-[#E5E5E0] rounded"
                    >
                      {isExpanded ? (
                        <ChevronDown className="w-3.5 h-3.5 text-[#737373]" />
                      ) : (
                        <ChevronRight className="w-3.5 h-3.5 text-[#737373]" />
                      )}
                    </button>
                  )}
                </div>
              </div>

              {/* Sub items */}
              {hasSubItems && isExpanded && (
                <div className="pl-7 pr-1 py-0.5 space-y-0.5 border-l-2 border-[#E5E5E0] ml-3.5 mt-0.5">
                  {item.subItems!.map((sub) => {
                    const isSubActive = isActive && activeSubSection === sub.id;
                    return (
                      <div
                        key={sub.id}
                        onClick={() => onNavigate(item.id, sub.id)}
                        className={`px-2 py-1 rounded cursor-pointer text-[12px] transition-colors ${
                          isSubActive
                            ? 'bg-[#FFFFFF] text-[#171717] font-semibold border border-[#E5E5E0]'
                            : 'text-[#737373] hover:text-[#171717] hover:bg-[#F5F5F2]'
                        }`}
                      >
                        {sub.label}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* System Status Footer */}
      <div className="p-3 border-t border-[#E5E5E0] bg-[#FFFFFF] space-y-2 text-[11px] text-[#737373]">
        <div className="flex items-center justify-between font-medium text-[#171717]">
          <span>Forecast engine</span>
          <span className={`flex items-center gap-1 ${engineUp === false ? 'text-[#C84A4A]' : 'text-[#2F7D5A]'}`}>
            <span className={`w-1.5 h-1.5 rounded-full ${engineUp === false ? 'bg-[#C84A4A]' : engineUp ? 'bg-[#2F7D5A]' : 'bg-[#A3A3A3]'}`}></span>
            {engineUp === null ? 'Checking' : engineUp ? 'Online' : 'Offline'}
          </span>
        </div>
        <div className="flex items-center justify-between gap-2">
          <span>Published forecast</span>
          <span className="font-semibold text-[#171717] bg-[#F5F5F2] px-1.5 py-0.5 rounded border border-[#E5E5E0] truncate max-w-[110px]" title={published?.name}>{published ? `v${published.seq} ${published.kind === 'SHORT' ? 'short' : 'long'}` : 'None yet'}</span>
        </div>
      </div>
    </aside>
  );
};
