/**
 * Application Global Header: organisation and user from the signed-in session, active WFM group,
 * command palette trigger, live notifications and sign-out.
 */

import React, { useState } from 'react';
import { Search, Command, Bell, ChevronDown, Layers, LogOut, ShieldCheck, Building2, Check, Plus, Globe } from 'lucide-react';
import { Session, switchWorkspace } from '../../services/api';
import { LiveEvent } from '../../services/live';

interface AppHeaderProps {
  session: Session;
  activeGroupName?: string | null;
  events: LiveEvent[];
  unread: number;
  onMarkRead: () => void;
  onOpenCommandPalette: () => void;
  onNavigate: (module: string, subSection?: string) => void;
  onSignOut: () => void;
  onSwitchWorkspace?: (newSession: Session) => void;
}

const ROLE_LABEL: Record<string, string> = {
  WFM_ADMIN: 'WFM Administrator', SCHEDULER: 'Workforce Scheduler', FORECAST_PLANNER: 'Forecast Planner', SUPERVISOR_RTA: 'Supervisor / RTA', ANALYST: 'Analyst', AGENT: 'Agent',
};
const ago = (t: number) => { const m = Math.round((Date.now() - t) / 60000); return m < 1 ? 'just now' : m < 60 ? `${m}m ago` : `${Math.round(m / 60)}h ago`; };
const initials = (n: string) => n.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join('') || '?';

export const AppHeader: React.FC<AppHeaderProps> = ({ session, activeGroupName, events, unread, onMarkRead, onOpenCommandPalette, onNavigate, onSignOut, onSwitchWorkspace }) => {
  const [showMenu, setShowMenu] = useState(false);
  const [showBell, setShowBell] = useState(false);
  const [showWorkspaceMenu, setShowWorkspaceMenu] = useState(false);
  const { user, tenant } = session;

  return (
    <header className="h-14 border-b border-[#E5E5E0] bg-[#FFFFFF] px-4 flex items-center justify-between sticky top-0 z-30 select-none">
      <div className="flex items-center gap-3">
        <div className="flex items-center gap-2 pr-3 border-r border-[#E5E5E0]">
          <div className="w-8 h-8 rounded bg-[#171717] flex items-center justify-center text-white font-bold text-sm tracking-wider">WFM</div>
          <div>
            <div className="flex items-center gap-1.5 font-semibold text-[14px] text-[#171717] leading-tight">
              <span>{tenant.name}</span>
              <span className="text-[11px] font-normal px-1.5 py-0.5 rounded bg-[#F5F5F2] border border-[#E5E5E0] text-[#737373]">{tenant.code}</span>
            </div>
            <div className="text-[11px] text-[#737373] flex items-center gap-1.5">
              <span className="w-1.5 h-1.5 rounded-full bg-[#2F7D5A] inline-block"></span>
              <span>Connected</span><span>·</span><span>{tenant.timezone}</span>
            </div>
          </div>
        </div>

        {/* Workspace Switcher */}
        <div className="relative">
          <button
            onClick={() => { setShowWorkspaceMenu(!showWorkspaceMenu); setShowMenu(false); setShowBell(false); }}
            className="flex items-center gap-2 px-2.5 py-1.5 rounded border border-[#E5E5E0] bg-[#FAFAF8] hover:bg-[#F5F5F2] hover:border-[#D6D6D0] transition-colors cursor-pointer text-left"
            title="Switch Workspace"
          >
            <Building2 className="w-3.5 h-3.5 text-[#525252]" />
            <div className="flex flex-col">
              <span className="text-[10px] uppercase font-bold tracking-wider text-[#737373] leading-none">Workspace</span>
              <span className="text-[12px] font-semibold text-[#171717] leading-tight flex items-center gap-1">
                {session.workspace?.name || 'Default Workspace'}
                {session.workspace?.isDefault && (
                  <span className="text-[9px] font-normal px-1 py-0.2 rounded bg-[#E5E5E0] text-[#525252]">default</span>
                )}
              </span>
            </div>
            <ChevronDown className="w-3 h-3 text-[#737373] ml-1" />
          </button>

          {showWorkspaceMenu && (
            <div className="absolute left-0 mt-2 w-72 bg-[#FFFFFF] border border-[#E5E5E0] rounded shadow-xl p-2 z-50">
              <div className="px-2 py-1.5 border-b border-[#E5E5E0] flex items-center justify-between">
                <span className="text-[11px] font-semibold text-[#737373] uppercase tracking-wider">Workspaces</span>
                <span className="text-[11px] text-[#737373]">{(session.workspaces || []).length} available</span>
              </div>
              <div className="py-1 max-h-56 overflow-y-auto space-y-0.5">
                {(session.workspaces || []).map((ws) => {
                  const isCurrent = ws.id === session.workspace?.id;
                  return (
                    <button
                      key={ws.id}
                      onClick={async () => {
                        setShowWorkspaceMenu(false);
                        if (isCurrent) return;
                        try {
                          const s = await switchWorkspace(ws.id);
                          if (onSwitchWorkspace) onSwitchWorkspace(s);
                          else location.reload();
                        } catch (e: any) {
                          alert(e.message || 'Failed to switch workspace');
                        }
                      }}
                      className={`w-full flex items-center justify-between px-2.5 py-2 rounded text-left text-[12px] transition-colors ${
                        isCurrent ? 'bg-[#171717] text-white' : 'text-[#171717] hover:bg-[#FAFAF8]'
                      }`}
                    >
                      <div className="flex flex-col">
                        <span className="font-semibold">{ws.name}</span>
                        <span className={`text-[10px] ${isCurrent ? 'text-gray-300' : 'text-[#737373]'}`}>
                          {ws.code} · {ws.timezone}
                        </span>
                      </div>
                      {isCurrent && <Check className="w-3.5 h-3.5 text-white" />}
                    </button>
                  );
                })}
              </div>
              <div className="pt-1.5 mt-1 border-t border-[#E5E5E0]">
                <button
                  onClick={() => {
                    setShowWorkspaceMenu(false);
                    onNavigate('administration', 'workspaces');
                  }}
                  className="w-full flex items-center justify-center gap-1.5 px-2 py-1.5 rounded text-[12px] font-medium text-[#2F7D5A] hover:bg-[#F2F7F4] transition-colors"
                >
                  <Plus className="w-3.5 h-3.5" /> Manage / Create Workspaces
                </button>
              </div>
            </div>
          )}
        </div>

        {activeGroupName && (
          <div className="hidden lg:flex items-center gap-2 text-[12px] text-[#525252] bg-[#FAFAF8] px-2.5 py-1 rounded border border-[#E5E5E0]">
            <Layers className="w-3.5 h-3.5 text-[#737373]" />
            <span>Active WFM Group:</span>
            <span className="font-semibold text-[#171717]">{activeGroupName}</span>
          </div>
        )}
      </div>

      <div className="flex-1 max-w-lg mx-6">
        <div onClick={onOpenCommandPalette} className="w-full flex items-center justify-between px-3 py-1.5 bg-[#FAFAF8] hover:bg-[#F5F5F2] border border-[#E5E5E0] hover:border-[#D6D6D0] rounded cursor-pointer transition-colors">
          <div className="flex items-center gap-2 text-[#737373] text-[13px]">
            <Search className="w-4 h-4 text-[#737373]" />
            <span>Search WFM groups, forecasts, imports...</span>
          </div>
          <div className="flex items-center gap-1 text-[11px] text-[#737373] bg-[#FFFFFF] border border-[#E5E5E0] px-1.5 py-0.5 rounded shadow-xs font-mono"><Command className="w-3 h-3" /><span>K</span></div>
        </div>
      </div>

      <div className="flex items-center gap-2.5">
        <div className="relative">
          <button onClick={() => { setShowBell(!showBell); setShowMenu(false); if (!showBell) onMarkRead(); }} className="p-2 text-[#525252] hover:text-[#171717] hover:bg-[#F5F5F2] rounded relative transition-colors" title="Notifications" aria-label="Notifications">
            <Bell className="w-4 h-4" />
            {unread > 0 && <span className="absolute top-1 right-1 min-w-4 h-4 px-1 rounded-full bg-[#C84A4A] text-white text-[10px] font-semibold flex items-center justify-center ring-2 ring-white">{unread > 9 ? '9+' : unread}</span>}
          </button>
          {showBell && (
            <div className="absolute right-0 mt-2 w-80 bg-[#FFFFFF] border border-[#E5E5E0] rounded shadow-lg p-3 z-50">
              <div className="pb-2 mb-2 border-b border-[#E5E5E0] font-semibold text-[13px] text-[#171717]">Notifications</div>
              {events.length === 0 ? <p className="text-[12px] text-[#737373] py-2">Nothing yet. Forecast approvals and data imports show up here as they happen.</p> : (
                <div className="space-y-1 max-h-80 overflow-y-auto">
                  {events.map((n) => (
                    <div key={n.id} onClick={() => { onNavigate(n.module, n.subSection); setShowBell(false); }} className="p-2 rounded hover:bg-[#FAFAF8] border border-transparent hover:border-[#E5E5E0] cursor-pointer">
                      <div className="flex items-center justify-between text-[12px] font-semibold text-[#171717]">
                        <span className="flex items-center gap-1.5"><span className={`w-2 h-2 rounded-full ${n.tone === 'success' ? 'bg-[#2F7D5A]' : n.tone === 'warn' ? 'bg-[#B7791F]' : 'bg-[#4F6F8F]'}`}></span>{n.title}</span>
                        <span className="text-[11px] text-[#737373] font-normal">{ago(n.at)}</span>
                      </div>
                      <p className="text-[11px] text-[#525252] mt-0.5 leading-snug">{n.description}</p>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>

        <div className="relative">
          <button onClick={() => { setShowMenu(!showMenu); setShowBell(false); }} className="flex items-center gap-2 pl-2 border-l border-[#E5E5E0] hover:opacity-80" aria-label="Account menu">
            <div className="w-7 h-7 rounded-full bg-[#FAFAF8] border border-[#D6D6D0] flex items-center justify-center text-[12px] font-semibold text-[#171717]">{initials(user.userName)}</div>
            <div className="hidden xl:block text-left">
              <div className="text-[12px] font-semibold text-[#171717] leading-none">{user.userName}</div>
              <div className="text-[11px] text-[#737373] leading-tight">{ROLE_LABEL[user.role] ?? user.role}</div>
            </div>
            <ChevronDown className="w-3 h-3 text-[#737373]" />
          </button>
          {showMenu && (
            <div className="absolute right-0 mt-2 w-64 bg-[#FFFFFF] border border-[#E5E5E0] rounded shadow-lg p-2 z-50">
              <div className="px-2.5 py-2 border-b border-[#E5E5E0] mb-1">
                <div className="text-[12px] font-semibold text-[#171717]">{user.userName}</div>
                <div className="text-[11px] text-[#737373]">{user.email ?? user.username}</div>
                <div className="mt-1 inline-flex items-center gap-1 text-[11px] text-[#2F7D5A]"><ShieldCheck className="w-3 h-3" />{ROLE_LABEL[user.role] ?? user.role} · {session.permissions.length} permissions</div>
              </div>
              <button onClick={onSignOut} className="w-full flex items-center gap-2 px-2.5 py-2 rounded text-[12px] text-[#171717] hover:bg-[#FAFAF8]"><LogOut className="w-3.5 h-3.5" />Sign out</button>
            </div>
          )}
        </div>
      </div>
    </header>
  );
};
