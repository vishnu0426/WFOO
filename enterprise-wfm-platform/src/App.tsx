/**
 * Enterprise Workforce Management (WFM) Platform: application shell.
 * Sign-in gate -> header + sidebar (Section 7 hierarchy) + the active module, all reading from the WFM gateway.
 * Forecasting, Workforce, Scheduling, Configuration › WFM Groups and Data Management are live; Overview, Intraday, Audit and Users are still the reference prototype.
 */

import React, { useCallback, useEffect, useState } from 'react';
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
import { StaffingTraceabilityModal } from './components/staffing/StaffingTraceabilityModal';
import { CommandPalette } from './components/common/CommandPalette';
import { LoginView } from './components/auth/LoginView';
import { ErrorBoundary } from './components/common/ErrorBoundary';
import { ForecastProvider, useForecast } from './services/forecastStore';
import { api, getStoredSession, Session, storeSession } from './services/api';
import { useLiveEvents } from './services/live';
import { fromPath, HOME, toPath } from './services/routes';

export default function App() {
  const [session, setSession] = useState<Session | null>(() => getStoredSession());
  // the address bar is the source of truth: /<module>/<section>, for example /workforce/employees
  const [route, setRoute] = useState(() => fromPath(location.pathname));
  const { module, sub } = route;

  // refresh permissions on load: a stored session may be stale, and an expired token signs the user out (see api.ts)
  useEffect(() => {
    if (!session) return;
    api<Session>('/auth/me').then((s) => { storeSession(localStorage.getItem('wfm_token'), s); setSession(s); }).catch(() => {});
  }, []);

  // browser back / forward
  useEffect(() => {
    const onPop = () => setRoute(fromPath(location.pathname));
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);
  // a bare "/" or an unknown address becomes the real address of the screen shown
  useEffect(() => {
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

  if (!session) return <LoginView onLogin={setSession} />;
  return (
    <ForecastProvider session={session} onNavigate={navigate}>
      <Shell session={session} module={module} sub={sub} navigate={navigate} onSignOut={signOut} />
    </ForecastProvider>
  );
}

const Shell: React.FC<{ session: Session; module: NavigationModule; sub: string; navigate: (m: string, s?: string) => void; onSignOut: () => void }> = ({ session, module, sub, navigate, onSignOut }) => {
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

  return (
    <div className="min-h-screen bg-[#FAFAF8] text-[#171717] flex flex-col font-sans antialiased">
      <AppHeader
        session={session} activeGroupName={group?.name} events={live.events} unread={live.unread} onMarkRead={live.markRead}
        onOpenCommandPalette={() => setPaletteOpen(true)} onNavigate={navigate} onSignOut={onSignOut}
      />
      <div className="flex-1 flex">
        <NavigationSidebar activeModule={module} activeSubSection={sub} onNavigate={navigate} />
        <main className="flex-1 flex flex-col overflow-hidden bg-[#FFFFFF]">
          <ErrorBoundary resetKey={`${module}/${sub}`}>
          {module === 'overview' && <OverviewDashboard onNavigate={navigate} />}
          {module === 'scheduling' && <SchedulingHub activeSubSection={sub} onNavigateSubSection={(s) => navigate('scheduling', s)} />}
          {module === 'forecasting' && <ForecastingView activeSubSection={sub} />}
          {module === 'workforce' && <WorkforceHub activeSubSection={sub} />}
          {module === 'intraday' && <IntradayView activeSubSection={sub} />}
          {module === 'configuration' && <ConfigurationView activeSubSection={sub} />}
          {module === 'data-management' && <DataManagementView activeSubSection={sub} />}
          {module === 'audit' && <AuditView />}
          {module === 'administration' && <UsersAndRolesView activeSubSection={sub} />}
          </ErrorBoundary>
        </main>
      </div>
      <StaffingTraceabilityModal isOpen={trace.isOpen} onClose={() => setTrace((p) => ({ ...p, isOpen: false }))} intervalStart={trace.intervalStart} volume={trace.volume} ahtSeconds={trace.ahtSeconds} />
      <CommandPalette isOpen={paletteOpen} onClose={() => setPaletteOpen(false)} onSelectAction={paletteAction} />
    </div>
  );
};
