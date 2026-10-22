/**
 * Enterprise Command Palette (Cmd + K)
 * Fast keyboard-navigable search across employees, WFM groups, skills,
 * forecasts, schedules, shift templates, and operational actions.
 */

import React, { useState, useEffect, useRef } from 'react';
import {
  Search,
  Users,
  Calendar,
  TrendingUp,
  Sparkles,
  Layers,
  Database,
  ArrowRight,
  ShieldAlert,
  Activity,
  CheckCircle2,
  X,
} from 'lucide-react';
import { SEED_EMPLOYEES, SEED_WFM_GROUPS, SEED_SKILLS } from '../../services/wfmStore';

interface CommandPaletteProps {
  isOpen: boolean;
  onClose: () => void;
  onSelectAction: (actionType: string, payload?: any) => void;
}

export const CommandPalette: React.FC<CommandPaletteProps> = ({
  isOpen,
  onClose,
  onSelectAction,
}) => {
  const [query, setQuery] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (isOpen) {
      setTimeout(() => inputRef.current?.focus(), 50);
    } else {
      setQuery('');
      setSelectedIndex(0);
    }
  }, [isOpen]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        if (isOpen) onClose();
        else onSelectAction('OPEN_PALETTE');
      }
      if (e.key === 'Escape' && isOpen) {
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose, onSelectAction]);

  if (!isOpen) return null;

  const actions = [
    {
      id: 'action-schedule',
      title: 'Open Schedule Timeline (Draft v18)',
      category: 'SCHEDULING',
      icon: Calendar,
      handler: () => onSelectAction('NAVIGATE', { module: 'scheduling', subSection: 'schedule-timeline' }),
    },
    {
      id: 'action-repair',
      title: 'Execute AI Schedule Repair for 14:00 Understaffing',
      category: 'AI OPTIMIZATION',
      icon: Sparkles,
      handler: () => onSelectAction('TRIGGER_AI_REPAIR'),
    },
    {
      id: 'action-forecast-dashboard',
      title: 'View Auto-Ensemble Forecast & Accuracy Heatmap',
      category: 'FORECASTING',
      icon: TrendingUp,
      handler: () => onSelectAction('NAVIGATE', { module: 'forecasting', subSection: 'forecast-dashboard' }),
    },
    {
      id: 'action-staged-import',
      title: 'Launch Staged Employee Ingestion Wizard',
      category: 'DATA MANAGEMENT',
      icon: Database,
      handler: () => onSelectAction('NAVIGATE', { module: 'data-management', subSection: 'staged-imports' }),
    },
    {
      id: 'action-intraday',
      title: 'Open Real-Time Intraday & Adherence Monitor',
      category: 'INTRADAY',
      icon: Activity,
      handler: () => onSelectAction('NAVIGATE', { module: 'intraday', subSection: 'live-coverage' }),
    },
  ];

  const filteredEmployees = SEED_EMPLOYEES.filter(
    (e) =>
      e.firstName.toLowerCase().includes(query.toLowerCase()) ||
      e.lastName.toLowerCase().includes(query.toLowerCase()) ||
      e.employeeNumber.toLowerCase().includes(query.toLowerCase())
  ).map((e) => ({
    id: e.id,
    title: `${e.firstName} ${e.lastName}`,
    subtitle: `${e.employeeNumber} · ${e.department} · ${e.weeklyContractHours}h/week`,
    category: 'EMPLOYEES',
    icon: Users,
    handler: () => onSelectAction('VIEW_EMPLOYEE', e),
  }));

  const filteredGroups = SEED_WFM_GROUPS.filter(
    (g) =>
      g.name.toLowerCase().includes(query.toLowerCase()) ||
      g.code.toLowerCase().includes(query.toLowerCase())
  ).map((g) => ({
    id: g.id,
    title: g.name,
    subtitle: `${g.agentCount} Agents · ${g.channels.join(', ')} · SLA ${g.serviceLevelGoal}%`,
    category: 'WFM GROUPS',
    icon: Layers,
    handler: () => onSelectAction('NAVIGATE', { module: 'configuration', subSection: 'wfm-groups' }),
  }));

  const filteredSkills = SEED_SKILLS.filter(
    (s) =>
      s.name.toLowerCase().includes(query.toLowerCase()) ||
      s.code.toLowerCase().includes(query.toLowerCase())
  ).map((s) => ({
    id: s.id,
    title: s.name,
    subtitle: `${s.code} · ${s.category} · ${s.requiresCertification ? 'Requires Cert' : 'Open Skill'}`,
    category: 'SKILLS',
    icon: ShieldAlert,
    handler: () => onSelectAction('NAVIGATE', { module: 'workforce', subSection: 'skills' }),
  }));

  const combinedItems = [
    ...actions.filter((a) => a.title.toLowerCase().includes(query.toLowerCase())),
    ...filteredEmployees,
    ...filteredGroups,
    ...filteredSkills,
  ];

  return (
    <div className="fixed inset-0 z-50 bg-black/40 backdrop-blur-xs flex items-start justify-center pt-24 p-4">
      <div
        className="w-full max-w-2xl bg-[#FFFFFF] rounded-lg shadow-2xl border border-[#E5E5E0] overflow-hidden flex flex-col max-h-[75vh]"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Search Input Bar */}
        <div className="p-3 border-b border-[#E5E5E0] flex items-center gap-3 bg-[#FAFAF8]">
          <Search className="w-5 h-5 text-[#737373]" />
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setSelectedIndex(0);
            }}
            placeholder="Type a command, employee name, WFM group, or action..."
            className="flex-1 bg-transparent border-none outline-none text-[14px] text-[#171717] placeholder:text-[#A3A3A3]"
          />
          <button
            onClick={onClose}
            className="p-1 rounded text-[#737373] hover:text-[#171717] hover:bg-[#E5E5E0]"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Results List */}
        <div className="flex-1 overflow-y-auto p-2 divide-y divide-[#F5F5F2]">
          {combinedItems.length === 0 ? (
            <div className="py-12 text-center text-[#737373] text-[13px]">
              No matching records or actions found for "{query}".
            </div>
          ) : (
            combinedItems.map((item, idx) => {
              const Icon = item.icon;
              const isSelected = idx === selectedIndex;

              return (
                <div
                  key={item.id}
                  onClick={() => {
                    item.handler();
                    onClose();
                  }}
                  onMouseEnter={() => setSelectedIndex(idx)}
                  className={`p-2.5 rounded flex items-center justify-between cursor-pointer transition-colors ${
                    isSelected ? 'bg-[#FAFAF8] border border-[#E5E5E0]' : 'hover:bg-[#F5F5F2]'
                  }`}
                >
                  <div className="flex items-center gap-3">
                    <div className="w-7 h-7 rounded bg-[#F5F5F2] flex items-center justify-center text-[#171717]">
                      <Icon className="w-3.5 h-3.5 text-[#525252]" />
                    </div>
                    <div>
                      <div className="text-[13px] font-semibold text-[#171717] flex items-center gap-2">
                        <span>{item.title}</span>
                        <span className="text-[10px] font-medium px-1.5 py-0.2 rounded bg-[#F5F5F2] border border-[#E5E5E0] text-[#737373]">
                          {item.category}
                        </span>
                      </div>
                      {'subtitle' in item && (
                        <div className="text-[11px] text-[#737373]">{String((item as { subtitle?: unknown }).subtitle ?? '')}</div>
                      )}
                    </div>
                  </div>

                  <ArrowRight className="w-4 h-4 text-[#A3A3A3]" />
                </div>
              );
            })
          )}
        </div>

        {/* Footer Keyboard Hints */}
        <div className="p-2 border-t border-[#E5E5E0] bg-[#FAFAF8] flex items-center justify-between text-[11px] text-[#737373]">
          <div className="flex items-center gap-4">
            <span>
              <kbd className="px-1.5 py-0.5 rounded bg-[#FFFFFF] border border-[#E5E5E0] font-mono text-[10px]">↑</kbd>{' '}
              <kbd className="px-1.5 py-0.5 rounded bg-[#FFFFFF] border border-[#E5E5E0] font-mono text-[10px]">↓</kbd>{' '}
              to navigate
            </span>
            <span>
              <kbd className="px-1.5 py-0.5 rounded bg-[#FFFFFF] border border-[#E5E5E0] font-mono text-[10px]">Enter</kbd>{' '}
              to select
            </span>
            <span>
              <kbd className="px-1.5 py-0.5 rounded bg-[#FFFFFF] border border-[#E5E5E0] font-mono text-[10px]">Esc</kbd>{' '}
              to close
            </span>
          </div>
          <span className="font-medium text-[#171717]">Enterprise WFM QuickNav</span>
        </div>
      </div>
    </div>
  );
};
