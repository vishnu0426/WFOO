/** Notifications: schedule updates, request decisions, swap and offer messages, bid results. Unread first-class, grouped by day, and a message opens the page it is about. */
import React, { useCallback, useEffect, useState } from 'react';
import { CalendarDays, Clock, Info, ListOrdered, Plane, Repeat, ChevronRight } from 'lucide-react';
import { api, ApiError } from '../api';
import { Notification, RequestPrefill } from '../types';
import { Banner, Btn, Busy } from '../ui';

export type InboxTarget = { tab: 'schedule' } | { tab: 'approvals' } | { tab: 'requests'; prefill: RequestPrefill };

const PAGE = 40;
const ICON: Record<string, { Icon: React.FC<{ className?: string }>; bg: string; fg: string }> = {
  SCHEDULE: { Icon: CalendarDays, bg: 'bg-[#E8F0FB]', fg: 'text-[#2457A7]' },
  SWAP: { Icon: Repeat, bg: 'bg-[#EEE9FA]', fg: 'text-[#6B4FBB]' },
  TIME_OFF: { Icon: Plane, bg: 'bg-[#E6F4EC]', fg: 'text-[#2F7D5A]' },
  OFFER: { Icon: Clock, bg: 'bg-[#FDF3DC]', fg: 'text-[#B7791F]' },
  BID: { Icon: ListOrdered, bg: 'bg-[#FDF3DC]', fg: 'text-[#B7791F]' },
  INFO: { Icon: Info, bg: 'bg-[#F0F0EC]', fg: 'text-[#525252]' },
};

/** Where a message leads in this portal, or null when it is only for reading (those about admin screens). Messages to a lead about a request waiting open the Approvals section. */
export function targetOf(n: Notification): InboxTarget | null {
  switch (n.data?.screen) {
    case 'schedule': return { tab: 'schedule' };
    case 'swap': return /needs approval$|waited for its supervisor$/i.test(n.title) ? { tab: 'approvals' } : { tab: 'requests', prefill: { tab: 'swaps' } };
    case 'bid': case 'offer': return { tab: 'requests', prefill: { tab: 'opportunities' } };
    case 'time-off': if (/^Your request was (approved|declined)$/i.test(n.title)) return { tab: 'requests', prefill: { tab: 'daysoff' } };
      return /request$|waited for its supervisor$/i.test(n.title) ? { tab: 'approvals' } : { tab: 'requests', prefill: { tab: 'timeoff' } };
    default: return null;
  }
}

const dayText = (iso: string) => {
  const d = new Date(`${iso}T00:00:00`);
  return d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', ...(d.getFullYear() === new Date().getFullYear() ? {} : { year: 'numeric' as const }) });
};
/** Dates inside a message read "Tue 17 Nov", not 2026-11-17. */
export const friendly = (s: string) => s.replace(/\b(\d{4}-\d{2}-\d{2})\b/g, (m) => dayText(m));

const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
export function when(iso: string, now = new Date()): string {
  const t = new Date(iso), mins = Math.floor((now.getTime() - t.getTime()) / 60000);
  if (mins < 1) return 'Just now';
  if (mins < 60) return `${mins} min ago`;
  const days = Math.round((startOfDay(now) - startOfDay(t)) / 86400000);
  const clock = t.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  if (days === 0) return `${Math.floor(mins / 60)} h ago`;
  if (days === 1) return `Yesterday, ${clock}`;
  return `${t.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', ...(t.getFullYear() === now.getFullYear() ? {} : { year: 'numeric' as const }) })}, ${clock}`;
}
export function group(iso: string, now = new Date()): 'Today' | 'Yesterday' | 'Earlier' {
  const days = Math.round((startOfDay(now) - startOfDay(new Date(iso))) / 86400000);
  return days <= 0 ? 'Today' : days === 1 ? 'Yesterday' : 'Earlier';
}

export const Inbox: React.FC<{ onUnread?: (n: number) => void; onOpen?: (t: InboxTarget) => void }> = ({ onUnread, onOpen }) => {
  const [items, setItems] = useState<Notification[]>([]);
  const [unread, setUnread] = useState(0);
  const [more, setMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState('');
  const [only, setOnly] = useState<'ALL' | 'UNREAD'>('ALL');

  const setCount = useCallback((n: number) => { setUnread(n); onUnread?.(n); }, [onUnread]);
  const load = useCallback(async () => {
    try {
      const r = await api<{ unread: number; items: Notification[] }>(`/me/notifications?limit=${PAGE}`);
      setItems(r.items); setMore(r.items.length === PAGE); setCount(r.unread); setError('');
    } catch (e: any) { setError(e instanceof ApiError ? e.message : 'Could not load your messages'); } finally { setLoading(false); }
  }, [setCount]);
  useEffect(() => { load(); }, [load]);

  const older = async () => {
    setLoadingMore(true);
    try {
      const r = await api<{ unread: number; items: Notification[] }>(`/me/notifications?limit=${PAGE}&before=${items[items.length - 1].id}`);
      setItems((cur) => [...cur, ...r.items]); setMore(r.items.length === PAGE);
    } catch (e: any) { setError(e instanceof ApiError ? e.message : 'Could not load older messages'); } finally { setLoadingMore(false); }
  };
  const markAll = async () => {
    try { await api('/me/notifications/read', { method: 'POST', body: {} }); setItems((cur) => cur.map((n) => ({ ...n, read: true }))); setCount(0); }
    catch (e: any) { setError(e instanceof ApiError ? e.message : 'Could not mark them read'); }
  };
  const open = async (n: Notification) => {
    if (!n.read) {
      setItems((cur) => cur.map((x) => (x.id === n.id ? { ...x, read: true } : x))); setCount(Math.max(0, unread - 1));
      api('/me/notifications/read', { method: 'POST', body: { ids: [n.id] } }).catch(() => load());
    }
    const t = targetOf(n);
    if (t) onOpen?.(t);
  };

  if (loading) return <Busy />;
  const shown = only === 'UNREAD' ? items.filter((n) => !n.read) : items;
  const now = new Date();
  const sections = (['Today', 'Yesterday', 'Earlier'] as const).map((g) => ({ g, rows: shown.filter((n) => group(n.createdAt, now) === g) })).filter((s) => s.rows.length);

  return (
    <div className="max-w-3xl space-y-4">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <div className="text-[20px] font-semibold text-[#171717]">Inbox</div>
          <div className="text-[12px] text-[#6B6B6B]">{unread > 0 ? `${unread} unread` : 'You are all caught up'}</div>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex gap-1 bg-[#F0F0EC] rounded-md p-1" role="tablist">
            {([['ALL', 'All'], ['UNREAD', 'Unread']] as const).map(([k, label]) => (
              <button key={k} role="tab" aria-selected={only === k} onClick={() => setOnly(k)} className={`text-[12px] font-semibold px-3 py-1 rounded ${only === k ? 'bg-white text-[#171717] shadow-xs' : 'text-[#6B6B6B]'}`}>{label}</button>
            ))}
          </div>
          {unread > 0 && <Btn onClick={markAll}>Mark all read</Btn>}
        </div>
      </div>
      {error && <Banner kind="err" onClose={() => setError('')}>{error}</Banner>}

      {items.length === 0 ? (
        <div className="bg-white border border-[#E5E5E0] rounded-lg py-12 px-6 text-center">
          <div className="text-[15px] font-semibold text-[#171717]">You are all caught up</div>
          <div className="text-[13px] text-[#6B6B6B] mt-1">Schedule updates, request decisions and swap or overtime offers will show up here.</div>
        </div>
      ) : shown.length === 0 ? (
        <div className="bg-white border border-[#E5E5E0] rounded-lg py-10 px-6 text-center text-[13px] text-[#6B6B6B]">No unread messages. <button className="font-semibold text-accent hover:underline" onClick={() => setOnly('ALL')}>Show all</button></div>
      ) : sections.map(({ g, rows }) => (
        <section key={g}>
          <div className="text-[11px] font-semibold uppercase tracking-wider text-[#6B6B6B] mb-2">{g}</div>
          <ul className="bg-white border border-[#E5E5E0] rounded-lg divide-y divide-[#F0F0EC] overflow-hidden">
            {rows.map((n) => {
              const k = ICON[n.kind] ?? ICON.INFO, Icon = k.Icon, t = targetOf(n);
              return (
                <li key={n.id}>
                  <button onClick={() => open(n)} className={`w-full text-left flex items-start gap-3 px-4 py-3 hover:bg-[#FAFAF8] ${n.read ? '' : 'bg-accent-bg'}`}>
                    <span className={`w-9 h-9 shrink-0 rounded-full flex items-center justify-center ${k.bg}`}><Icon className={`w-[18px] h-[18px] ${k.fg}`} /></span>
                    <span className="flex-1 min-w-0">
                      <span className="flex items-start justify-between gap-3">
                        <span className={`text-[13px] ${n.read ? 'font-medium text-[#525252]' : 'font-semibold text-[#171717]'}`}>{friendly(n.title)}</span>
                        <span className="text-[11px] text-[#6B6B6B] shrink-0 whitespace-nowrap" title={new Date(n.createdAt).toLocaleString('en-GB')}>{when(n.createdAt, now)}</span>
                      </span>
                      {n.body && <span className="block text-[12px] text-[#6B6B6B] mt-0.5">{friendly(n.body)}</span>}
                    </span>
                    {!n.read && <span className="w-2 h-2 mt-1.5 rounded-full bg-accent shrink-0" aria-label="Unread" />}
                    {t && <ChevronRight className="w-4 h-4 mt-1 text-[#A3A3A3] shrink-0" aria-hidden />}
                  </button>
                </li>
              );
            })}
          </ul>
        </section>
      ))}
      {more && only === 'ALL' && <div className="text-center"><Btn onClick={older} disabled={loadingMore}>{loadingMore ? 'Loading…' : 'Show older messages'}</Btn></div>}
    </div>
  );
};
