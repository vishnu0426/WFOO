/**
 * Enterprise Workforce Management (WFM) Platform: application shell.
 * Sign-in gate -> header + sidebar (Section 7 hierarchy) + the active module, all reading from the WFM gateway.
 * Forecasting, Workforce, Scheduling, Configuration › WFM Groups and Data Management are live; Overview, Intraday, Audit and Users are still the reference prototype.
 */

import React, { Suspense, lazy, useCallback, useEffect, useState } from 'react';
import { AppHeader } from './components/layout/AppHeader';
import { NavigationSidebar, NavigationModule } from './components/layout/NavigationSidebar';
import { CommandPalette } from './components/common/CommandPalette';
import { LoginView } from './components/auth/LoginView';
import { ChangePasswordView } from './components/auth/ChangePasswordView';
import { ErrorBoundary } from './components/common/ErrorBoundary';
import { ForecastProvider, useForecast } from './services/forecastStore';
import { api, getStoredSession, Session, storeSession } from './services/api';
import { useLiveEvents } from './services/live';
import { fromPath, HOME, toPath } from './services/routes';

// each module loads when first opened, so the first screen does not wait for all of them
const OverviewDashboard = lazy(() => import('./components/overview/OverviewDashboard').then((m) => ({ default: m.OverviewDashboard })));
const SchedulingHub = lazy(() => import('./components/scheduling/SchedulingHub').then((m) => ({ default: m.SchedulingHub })));
const ForecastingView = lazy(() => import('./components/forecasting/ForecastingView').then((m) => ({ default: m.ForecastingView })));
const WorkforceHub = lazy(() => import('./components/workforce/WorkforceHub').then((m) => ({ default: m.WorkforceHub })));
const IntradayView = lazy(() => import('./components/intraday/IntradayView').then((m) => ({ default: m.IntradayView })));
const ConfigurationView = lazy(() => import('./components/configuration/ConfigurationView').then((m) => ({ default: m.ConfigurationView })));
const DataManagementView = lazy(() => import('./components/data/DataManagementView').then((m) => ({ default: m.DataManagementView })));
const AuditView = lazy(() => import('./components/audit/AuditView').then((m) => ({ default: m.AuditView })));
const UsersAndRolesView = lazy(() => import('./components/admin/UsersAndRolesView').then((m) => ({ default: m.UsersAndRolesView })));
const ApiAccessView = lazy(() => import('./components/admin/ApiAccessView').then((m) => ({ default: m.ApiAccessView })));
const AlertsReportsView = lazy(() => import('./components/admin/AlertsReportsView').then((m) => ({ default: m.AlertsReportsView })));
const StaffingTraceabilityModal = lazy(() => import('./components/staffing/StaffingTraceabilityModal').then((m) => ({ default: m.StaffingTraceabilityModal })));

export default function App() {
  const [session, setSession] = useState<Session | null>(() => getStoredSession());
  // the address bar is the source of truth: /<module>/<section>, for example /workforce/employees
  const [route, setRoute] = useState(() => fromPath(location.pathname));
  const { module, sub } = route;

  // signing in always starts at the Overview, whatever address the sign-in screen was opened on
  const signedIn = useCallback((s: Session) => { setSession(s); setRoute(HOME); history.replaceState(null, '', toPath(HOME.module, HOME.sub)); }, []);

  // coming back from the company's sign-in page: the gateway sends the person here with a token (or the reason it could not sign them in) after the #
  useEffect(() => {
    const h = new URLSearchParams(location.hash.slice(1));
    const token = h.get('sso_token'), err = h.get('sso_error');
    if (!token && !err) return;
    history.replaceState(null, '', toPath(HOME.module, HOME.sub));
    if (err) { sessionStorage.setItem('wfm_sso_error', err); location.reload(); return; }
    localStorage.setItem('wfm_token', token!);
    api<Session>('/auth/me').then((s) => { storeSession(token, s); signedIn(s); }).catch(() => { localStorage.removeItem('wfm_token'); sessionStorage.setItem('wfm_sso_error', 'Signed in, but the session could not be started. Try again.'); location.reload(); });
  }, []);

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
    // the query stays (a sign-in link names its organisation as ?org=CODE: dropping it made a refresh forget which organisation the link was for)
    if (location.pathname !== want) history.replaceState(null, '', want + location.search);
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

  if (!session) return <LoginView onLogin={signedIn} />;
  if (session.mustChangePassword) return <ChangePasswordView session={session} onChanged={setSession} onSignOut={signOut} />;
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
          <Suspense fallback={<div className="p-6 text-[13px] text-[#6B6B6B]" role="status">Loading…</div>}>
          {module === 'overview' && <OverviewDashboard onNavigate={navigate} />}
          {module === 'scheduling' && <SchedulingHub activeSubSection={sub} onNavigateSubSection={(s) => navigate('scheduling', s)} />}
          {module === 'forecasting' && <ForecastingView activeSubSection={sub} />}
          {module === 'workforce' && <WorkforceHub activeSubSection={sub} />}
          {module === 'intraday' && <IntradayView activeSubSection={sub} />}
          {module === 'configuration' && <ConfigurationView activeSubSection={sub} />}
          {module === 'data-management' && <DataManagementView activeSubSection={sub} />}
          {module === 'audit' && <AuditView />}
          {module === 'administration' && (sub === 'api-access' ? <ApiAccessView /> : sub === 'alerts-reports' ? <AlertsReportsView /> : <UsersAndRolesView activeSubSection={sub} />)}
          </Suspense>
          </ErrorBoundary>
        </main>
      </div>
      <Suspense fallback={null}><StaffingTraceabilityModal isOpen={trace.isOpen} onClose={() => setTrace((p) => ({ ...p, isOpen: false }))} intervalStart={trace.intervalStart} volume={trace.volume} ahtSeconds={trace.ahtSeconds} /></Suspense>
      <CommandPalette isOpen={paletteOpen} onClose={() => setPaletteOpen(false)} onSelectAction={paletteAction} />
    </div>
  );
};
