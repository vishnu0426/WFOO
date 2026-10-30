/**
 * Enterprise Workforce Management (WFM) Platform: application shell.
 * Sign-in gate -> header + sidebar (Section 7 hierarchy) + the active module, all reading from the WFM gateway.
 * Forecasting, Workforce, Scheduling, Configuration › WFM Groups and Data Management are live; Overview, Intraday, Audit and Users are still the reference prototype.
 */

import React, { useCallback, useEffect, useState } from 'react';
import { ShieldAlert } from 'lucide-react';
import { AppHeader } from './components/layout/AppHeader';
import { NavigationSidebar, NavigationModule } from './components/layout/NavigationSidebar';
import { OverviewDashboard } from './components/overview/OverviewDashboard';
import { SchedulingHub } from './components/scheduling/SchedulingHub';
import { ForecastingView } from './components/forecasting/ForecastingView';
import { WorkforceHub } from './components/workforce/WorkforceHub';
import { IntradayView } from './components/intraday/IntradayView';
import { ConfigurationView } from './components/configuration/ConfigurationView';
import { DataManagementView } from './components/data/DataManagementView';
import { AuditView } from './components/audit/AuditView';
import { UsersAndRolesView } from './components/admin/UsersAndRolesView';
import { WorkspacesView } from './components/admin/WorkspacesView';
import { LicenseSubscriptionView } from './components/admin/LicenseSubscriptionView';
import { StaffingTraceabilityModal } from './components/staffing/StaffingTraceabilityModal';
import { CommandPalette } from './components/common/CommandPalette';
import { LoginView } from './components/auth/LoginView';
import { PlatformAdminPortal } from './components/platform/PlatformAdminPortal';
import { ErrorBoundary } from './components/common/ErrorBoundary';
import { ForecastProvider, useForecast } from './services/forecastStore';
import { api, getStoredSession, Session, storeSession } from './services/api';
import { useLiveEvents } from './services/live';
import { fromPath, HOME, toPath } from './services/routes';

export default function App() {
  const [session, setSession] = useState<Session | null>(() => getStoredSession());
  const [pathname, setPathname] = useState(() => location.pathname);
  // the address bar is the source of truth: /<module>/<section>, for example /workforce/employees
  const [route, setRoute] = useState(() => fromPath(location.pathname));
  const { module, sub } = route;

  // browser back / forward
  useEffect(() => {
    const onPop = () => {
      setPathname(location.pathname);
      setRoute(fromPath(location.pathname));
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  // refresh permissions on load: a stored session may be stale, and an expired token signs the user out (see api.ts)
  useEffect(() => {
    if (!session || location.pathname.startsWith('/platform')) return;
    api<Session>('/auth/me').then((s) => { storeSession(localStorage.getItem('wfm_token'), s); setSession(s); }).catch(() => {});
  }, []);

  // a bare "/" or an unknown address becomes the real address of the screen shown
  useEffect(() => {
    if (location.pathname.startsWith('/platform')) return;
    const want = toPath(route.module, route.sub);
    if (location.pathname !== want) history.replaceState(null, '', want);
  }, [route]);

  const navigate = useCallback((m: string, s?: string) => {
    const next = fromPath(toPath(m, s));
    setRoute(next);
    const path = toPath(next.module, next.sub);
    if (location.pathname !== path) history.pushState(null, '', path);
  }, []);
  const signOut = async () => {
    await api('/auth/logout', { method: 'POST' }).catch(() => {});
    storeSession(null, null); setSession(null); setRoute(HOME); history.replaceState(null, '', toPath(HOME.module, HOME.sub));
  };

  const switchWs = (newSession: Session) => {
    setSession(newSession);
  };

  if (pathname.startsWith('/platform') || location.pathname.startsWith('/platform')) {
    if (typeof window !== 'undefined') {
      window.location.href = 'http://localhost:3001';
    }
    return (
      <div className="min-h-screen bg-[#FAFAF8] flex items-center justify-center p-4">
        <div className="w-full max-w-sm bg-white border border-[#E5E5E0] rounded-lg shadow-xs p-6 space-y-4 text-center">
          <div className="w-10 h-10 rounded bg-[#171717] mx-auto flex items-center justify-center text-white">
            <ShieldAlert className="w-5 h-5 text-white" />
          </div>
          <div>
            <h1 className="text-[16px] font-semibold text-[#171717]">Redirecting to Super Admin Portal</h1>
            <p className="text-[12px] text-[#737373] mt-1">Platform Super Admin is now hosted separately on port 3001.</p>
          </div>
          <a
            href="http://localhost:3001"
            className="w-full px-4 py-2 rounded bg-[#171717] hover:bg-[#333333] text-white text-[13px] font-semibold inline-flex items-center justify-center gap-2"
          >
            Go to http://localhost:3001 →
          </a>
        </div>
      </div>
    );
  }

  if (!session) return <LoginView onLogin={setSession} />;
  return (
    <ForecastProvider key={session.workspace?.id || session.tenant.id} session={session} onNavigate={navigate}>
      <Shell session={session} module={module} sub={sub} navigate={navigate} onSignOut={signOut} onSwitchWorkspace={switchWs} />
    </ForecastProvider>
  );
}

const Shell: React.FC<{
  session: Session;
  module: NavigationModule;
  sub: string;
  navigate: (m: string, s?: string) => void;
  onSignOut: () => void;
  onSwitchWorkspace: (s: Session) => void;
}> = ({ session, module, sub, navigate, onSignOut, onSwitchWorkspace }) => {
  const { group } = useForecast();
  const live = useLiveEvents(true);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [trace, setTrace] = useState({ isOpen: false, intervalStart: '14:00', volume: 580, ahtSeconds: 440 });

  const openTrace = (intervalStart: string, volume: number, ahtSeconds: number) => setTrace({ isOpen: true, intervalStart, volume, ahtSeconds });
  const paletteAction = (type: string, payload?: any) => {
    if (type === 'OPEN_PALETTE') setPaletteOpen(true);
    else if (type === 'NAVIGATE' && payload) navigate(payload.module, payload.subSection);
    else if (type === 'TRIGGER_AI_REPAIR') navigate('scheduling', 'schedule-timeline');
  };

  const isModuleActive = (mod: string) => {
    if (!session?.enabledModules || !Array.isArray(session.enabledModules)) return true;
    const valid = session.enabledModules.filter((m): m is string => typeof m === 'string' && m.length > 0);
    if (valid.length === 0) return true;
    return valid.includes(mod);
  };

  return (
    <div className="min-h-screen bg-[#FAFAF8] text-[#171717] flex flex-col font-sans antialiased">
      <AppHeader
        session={session} activeGroupName={group?.name} events={live.events} unread={live.unread} onMarkRead={live.markRead}
        onOpenCommandPalette={() => setPaletteOpen(true)} onNavigate={navigate} onSignOut={onSignOut}
        onSwitchWorkspace={onSwitchWorkspace}
      />
      <div className="flex-1 flex">
        <NavigationSidebar session={session} activeModule={module} activeSubSection={sub} onNavigate={navigate} />
        <main className="flex-1 flex flex-col overflow-hidden bg-[#FFFFFF]">
          <ErrorBoundary resetKey={`${session.workspace?.id}/${module}/${sub}`}>
          {module === 'overview' && <OverviewDashboard onNavigate={navigate} />}
          {module === 'scheduling' && (
            isModuleActive('SCHEDULING') ? (
              <SchedulingHub activeSubSection={sub} onNavigateSubSection={(s) => navigate('scheduling', s)} />
            ) : (
              <div className="flex-1 flex items-center justify-center p-8 bg-[#FAFAF8]">
                <div className="max-w-md w-full bg-white border border-[#E5E5E0] rounded-xl p-8 text-center shadow-xs space-y-4">
                  <div className="w-12 h-12 rounded-full bg-[#FEE2E2] text-[#B91C1C] flex items-center justify-center mx-auto">
                    <ShieldAlert className="w-6 h-6" />
                  </div>
                  <div>
                    <h3 className="text-[17px] font-bold text-[#171717]">Automated Scheduling Not Licensed</h3>
                    <p className="text-[12px] text-[#737373] mt-1.5 leading-relaxed">
                      The Automated Scheduling module is not included in your organization's subscription license. Contact your Platform Super Administrator to enable it.
                    </p>
                  </div>
                  <button
                    onClick={() => navigate('overview')}
                    className="px-4 py-2 bg-[#171717] hover:bg-[#333333] text-white text-xs font-semibold rounded transition-colors"
                  >
                    Return to Overview
                  </button>
                </div>
              </div>
            )
          )}
          {module === 'forecasting' && (
            isModuleActive('FORECASTING') ? (
              <ForecastingView activeSubSection={sub} />
            ) : (
              <div className="flex-1 flex items-center justify-center p-8 bg-[#FAFAF8]">
                <div className="max-w-md w-full bg-white border border-[#E5E5E0] rounded-xl p-8 text-center shadow-xs space-y-4">
                  <div className="w-12 h-12 rounded-full bg-[#FEE2E2] text-[#B91C1C] flex items-center justify-center mx-auto">
                    <ShieldAlert className="w-6 h-6" />
                  </div>
                  <div>
                    <h3 className="text-[17px] font-bold text-[#171717]">Forecasting Engine Not Licensed</h3>
                    <p className="text-[12px] text-[#737373] mt-1.5 leading-relaxed">
                      The Forecasting Engine module is not included in your organization's subscription license. Contact your Platform Super Administrator to enable it.
                    </p>
                  </div>
                  <button
                    onClick={() => navigate('overview')}
                    className="px-4 py-2 bg-[#171717] hover:bg-[#333333] text-white text-xs font-semibold rounded transition-colors"
                  >
                    Return to Overview
                  </button>
                </div>
              </div>
            )
          )}
          {module === 'workforce' && <WorkforceHub activeSubSection={sub} />}
          {module === 'intraday' && (
            isModuleActive('INTRADAY') ? (
              <IntradayView activeSubSection={sub} />
            ) : (
              <div className="flex-1 flex items-center justify-center p-8 bg-[#FAFAF8]">
                <div className="max-w-md w-full bg-white border border-[#E5E5E0] rounded-xl p-8 text-center shadow-xs space-y-4">
                  <div className="w-12 h-12 rounded-full bg-[#FEE2E2] text-[#B91C1C] flex items-center justify-center mx-auto">
                    <ShieldAlert className="w-6 h-6" />
                  </div>
                  <div>
                    <h3 className="text-[17px] font-bold text-[#171717]">Intraday & RTA Not Licensed</h3>
                    <p className="text-[12px] text-[#737373] mt-1.5 leading-relaxed">
                      The Intraday Management and Real-Time Adherence module is not included in your organization's subscription license. Contact your Platform Super Administrator to enable it.
                    </p>
                  </div>
                  <button
                    onClick={() => navigate('overview')}
                    className="px-4 py-2 bg-[#171717] hover:bg-[#333333] text-white text-xs font-semibold rounded transition-colors"
                  >
                    Return to Overview
                  </button>
                </div>
              </div>
            )
          )}
          {module === 'configuration' && <ConfigurationView activeSubSection={sub} />}
          {module === 'data-management' && <DataManagementView activeSubSection={sub} />}
          {module === 'audit' && <AuditView />}
          {module === 'administration' && (
            sub === 'workspaces' ? (
              <WorkspacesView session={session} onSwitchWorkspace={onSwitchWorkspace} />
            ) : sub === 'license' ? (
              <LicenseSubscriptionView />
            ) : (
              <UsersAndRolesView activeSubSection={sub} />
            )
          )}
          </ErrorBoundary>
        </main>
      </div>
      <StaffingTraceabilityModal isOpen={trace.isOpen} onClose={() => setTrace((p) => ({ ...p, isOpen: false }))} intervalStart={trace.intervalStart} volume={trace.volume} ahtSeconds={trace.ahtSeconds} />
      <CommandPalette isOpen={paletteOpen} onClose={() => setPaletteOpen(false)} onSelectAction={paletteAction} />
    </div>
  );
};
