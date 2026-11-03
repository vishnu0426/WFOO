/**
 * Employee portal shell: sign-in gate, then a left sidebar (same pattern as the admin web app) around five sections,
 * the same information architecture as the mobile app (Home, Schedule, Requests, Inbox, Me) so the two stay familiar
 * to someone who uses both. Talks to the same /me/* gateway endpoints as the mobile app.
 */
import React, { useEffect, useState } from 'react';
import { CalendarDays, Home as HomeIcon, Inbox as InboxIcon, ListChecks, User } from 'lucide-react';
import { api, getStoredSession, Session, setToken, storeSession } from './api';
import { readSsoReturn, returningFromSso } from './sso';
import { RequestPrefill } from './types';
import { Login } from './pages/Login';
import { ChangePassword } from './pages/ChangePassword';
import { Home } from './pages/Home';
import { Schedule } from './pages/Schedule';
import { Requests } from './pages/Requests';
import { Inbox } from './pages/Inbox';
import { Profile } from './pages/Profile';

type Tab = 'home' | 'schedule' | 'requests' | 'inbox' | 'profile';
const TABS: { id: Tab; label: string; icon: React.FC<{ className?: string }> }[] = [
  { id: 'home', label: 'Home', icon: HomeIcon }, { id: 'schedule', label: 'Schedule', icon: CalendarDays },
  { id: 'requests', label: 'Requests', icon: ListChecks }, { id: 'inbox', label: 'Inbox', icon: InboxIcon }, { id: 'profile', label: 'Me', icon: User },
];

const tabFromPath = (p: string): Tab => { const s = p.split('/').filter(Boolean)[0]; return (TABS.find((t) => t.id === s)?.id) ?? 'home'; };

export default function App() {
  const [session, setSession] = useState<Session | null>(getStoredSession());
  // each section has its own address (/schedule, /inbox ...), so a reload stays where you were, a link can be shared and Back works
  const [tab, setTabState] = useState<Tab>(() => tabFromPath(location.pathname));
  const setTab = (t: Tab) => { setTabState(t); const p = t === 'home' ? '/' : `/${t}`; if (location.pathname !== p) history.pushState(null, '', p); };
  useEffect(() => {
    const onPop = () => setTabState(tabFromPath(location.pathname));
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);
  const [prefill, setPrefill] = useState<RequestPrefill | null>(null);
  // coming back from the company's sign-in page: the gateway sends the person here with a token (or the reason it did not work) after the #
  const [ssoBusy, setSsoBusy] = useState(() => returningFromSso(location.hash));
  const [ssoError, setSsoError] = useState('');
  useEffect(() => {
    const r = readSsoReturn(location.hash);
    if (!r.token && !r.error) return;
    history.replaceState(null, '', location.pathname + location.search);               // the token never stays in the address bar or the history
    if (r.error) { setSsoError(r.error); return; }
    setToken(r.token!);
    api<Session>('/auth/me').then((s) => {
      if (!s.permissions.includes('self:use')) { storeSession(null, null); setSsoError('Your account signed in, but it cannot use the employee portal. Ask your administrator to set one up for you.'); return; }
      storeSession(r.token!, s); setSession(s);
    }).catch(() => { storeSession(null, null); setSsoError('Signed in, but the session could not be started. Try again.'); }).finally(() => setSsoBusy(false));
  }, []);

  const signOut = async () => {
    try { await api('/auth/logout', { method: 'POST' }); } catch { /* best effort */ }
    storeSession(null, null);
    setSession(null);
  };

  if (ssoBusy) return <div className="min-h-screen bg-[#FAFAF8] flex items-center justify-center text-[13px] text-[#6B6B6B]">Signing you in…</div>;
  if (!session) return <Login onLogin={setSession} initialError={ssoError} />;
  if (session.mustChangePassword) return <ChangePassword session={session} onChanged={setSession} onSignOut={signOut} />;

  return (
    <div className="min-h-screen bg-[#FAFAF8] flex">
      <aside className="hidden md:flex w-56 shrink-0 bg-white border-r border-[#E5E5E0] flex-col h-screen sticky top-0">
        <div className="flex items-center gap-2 px-4 h-14 border-b border-[#E5E5E0] shrink-0">
          <div className="w-7 h-7 rounded-md bg-accent text-white flex items-center justify-center text-[11px] font-bold">W</div>
          <span className="font-semibold text-[14px] text-[#171717]">AgnoWFM</span>
        </div>
        <nav aria-label="Sections" className="flex-1 p-2.5 space-y-1">
          {TABS.map((t) => {
            const Icon = t.icon;
            const active = tab === t.id;
            return (
              <button key={t.id} onClick={() => setTab(t.id)} aria-current={active ? 'page' : undefined} className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-md text-[13px] font-medium ${active ? 'bg-accent text-white' : 'text-[#525252] hover:bg-[#FAFAF8]'}`}>
                <Icon className="w-4 h-4" aria-hidden="true" />
                {t.label}
              </button>
            );
          })}
        </nav>
        <div className="p-2.5 border-t border-[#E5E5E0]">
          <div className="px-3 py-2 text-[12px] text-[#6B6B6B] truncate">{session.user.userName}</div>
          <button onClick={signOut} className="w-full text-left px-3 py-2 rounded-md text-[13px] font-medium text-[#6B6B6B] hover:bg-[#FAFAF8]">Sign out</button>
        </div>
      </aside>

      <main className="flex-1 min-w-0 max-w-6xl w-full p-4 md:p-6 pb-24 md:pb-6 space-y-5">
        {tab === 'home' && <Home name={session.user.userName} onNavigate={setTab} />}
        {tab === 'schedule' && <Schedule onRequestAction={(p) => { setPrefill(p); setTab('requests'); }} />}
        {tab === 'requests' && <Requests prefill={prefill} onPrefillConsumed={() => setPrefill(null)} />}
        {tab === 'inbox' && <Inbox />}
        {tab === 'profile' && <Profile onSignOut={signOut} />}
      </main>

      {/* on a phone the sections sit along the bottom, as in the mobile app */}
      <nav aria-label="Sections" className="md:hidden fixed bottom-0 inset-x-0 z-30 bg-white border-t border-[#E5E5E0] grid grid-cols-5">
        {TABS.map((t) => {
          const Icon = t.icon, active = tab === t.id;
          return (
            <button key={t.id} onClick={() => setTab(t.id)} aria-current={active ? 'page' : undefined} className={`flex flex-col items-center gap-0.5 py-2 text-[11px] font-medium ${active ? 'text-accent' : 'text-[#525252]'}`}>
              <Icon className="w-5 h-5" aria-hidden="true" />
              {t.label}
            </button>
          );
        })}
      </nav>
    </div>
  );
}
