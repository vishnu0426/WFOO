/**
 * Employee portal shell: sign-in gate, then a left sidebar (same pattern as the admin web app) around five sections,
 * the same information architecture as the mobile app (Home, Schedule, Requests, Inbox, Me) so the two stay familiar
 * to someone who uses both. Talks to the same /me/* gateway endpoints as the mobile app.
 */
import React, { useState } from 'react';
import { CalendarDays, Home as HomeIcon, Inbox as InboxIcon, ListChecks, User } from 'lucide-react';
import { api, getStoredSession, Session, storeSession } from './api';
import { RequestPrefill } from './types';
import { Login } from './pages/Login';
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

export default function App() {
  const [session, setSession] = useState<Session | null>(getStoredSession());
  const [tab, setTab] = useState<Tab>('home');
  const [prefill, setPrefill] = useState<RequestPrefill | null>(null);

  const signOut = async () => {
    try { await api('/auth/logout', { method: 'POST' }); } catch { /* best effort */ }
    storeSession(null, null);
    setSession(null);
  };

  if (!session) return <Login onLogin={setSession} />;

  return (
    <div className="min-h-screen bg-[#FAFAF8] flex">
      <aside className="w-56 shrink-0 bg-white border-r border-[#E5E5E0] flex flex-col h-screen sticky top-0">
        <div className="flex items-center gap-2 px-4 h-14 border-b border-[#E5E5E0] shrink-0">
          <div className="w-7 h-7 rounded-md bg-accent text-white flex items-center justify-center text-[11px] font-bold">W</div>
          <span className="font-semibold text-[14px] text-[#171717]">My WFM</span>
        </div>
        <nav className="flex-1 p-2.5 space-y-1">
          {TABS.map((t) => {
            const Icon = t.icon;
            const active = tab === t.id;
            return (
              <button key={t.id} onClick={() => setTab(t.id)} className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-md text-[13px] font-medium ${active ? 'bg-accent text-white' : 'text-[#525252] hover:bg-[#FAFAF8]'}`}>
                <Icon className="w-4 h-4" />
                {t.label}
              </button>
            );
          })}
        </nav>
        <div className="p-2.5 border-t border-[#E5E5E0]">
          <div className="px-3 py-2 text-[12px] text-[#737373] truncate">{session.user.userName}</div>
          <button onClick={signOut} className="w-full text-left px-3 py-2 rounded-md text-[13px] font-medium text-[#737373] hover:bg-[#FAFAF8]">Sign out</button>
        </div>
      </aside>

      <main className="flex-1 min-w-0 max-w-6xl w-full p-6 space-y-5">
        {tab === 'home' && <Home name={session.user.userName} onNavigate={setTab} />}
        {tab === 'schedule' && <Schedule onRequestAction={(p) => { setPrefill(p); setTab('requests'); }} />}
        {tab === 'requests' && <Requests prefill={prefill} onPrefillConsumed={() => setPrefill(null)} />}
        {tab === 'inbox' && <Inbox />}
        {tab === 'profile' && <Profile onSignOut={signOut} />}
      </main>
    </div>
  );
}
