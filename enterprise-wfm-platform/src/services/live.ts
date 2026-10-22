/**
 * Live events from the gateway WebSocket (fed by NATS). Used for the notification bell: forecast lifecycle, data imports.
 * Reconnects quietly; the app works without it.
 */
import { useEffect, useRef, useState } from 'react';
import { getToken } from './api';

export type LiveEvent = { id: number; title: string; description: string; at: number; module: string; subSection?: string; tone: 'info' | 'success' | 'warn' };

const describe = (subject: string, p: any): Omit<LiveEvent, 'id' | 'at'> | null => {
  const who = p?.by ? ` by ${p.by}` : '';
  switch (subject) {
    case 'forecast.created': return { title: 'Forecast created', description: `${p.name}${who}`, module: 'forecasting', subSection: 'forecast-dashboard', tone: 'info' };
    case 'forecast.submit': return { title: 'Forecast submitted for approval', description: `${p.name}${who}`, module: 'forecasting', subSection: 'forecast-dashboard', tone: 'warn' };
    case 'forecast.approve': return { title: 'Forecast approved', description: `${p.name}${who}`, module: 'forecasting', subSection: 'forecast-dashboard', tone: 'info' };
    case 'forecast.reject': return { title: 'Forecast returned to draft', description: `${p.name}${who}`, module: 'forecasting', subSection: 'forecast-dashboard', tone: 'warn' };
    case 'forecast.publish': return { title: 'Forecast published', description: `${p.name}${who}`, module: 'forecasting', subSection: 'forecast-dashboard', tone: 'success' };
    case 'data.imported': return { title: 'History import committed', description: `Interval history was updated${who}`, module: 'data-management', subSection: 'staged-imports', tone: 'success' };
    default: return null;
  }
};

export function useLiveEvents(enabled: boolean) {
  const [events, setEvents] = useState<LiveEvent[]>([]);
  const [unread, setUnread] = useState(0);
  const seq = useRef(0);

  useEffect(() => {
    if (!enabled) return;
    let ws: WebSocket | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;
    const connect = () => {
      const token = getToken();
      if (!token || stopped) return;
      ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws?token=${encodeURIComponent(token)}`);
      ws.onmessage = (m) => {
        try {
          const { subject, payload } = JSON.parse(m.data);
          const d = describe(subject, payload);
          if (d) { setEvents((e) => [{ ...d, id: ++seq.current, at: Date.now() }, ...e].slice(0, 20)); setUnread((n) => n + 1); }
        } catch { /* ignore malformed */ }
      };
      ws.onclose = (e) => { if (!stopped && e.code !== 4401) timer = setTimeout(connect, 4000); };
    };
    connect();
    return () => { stopped = true; clearTimeout(timer); ws?.close(); };
  }, [enabled]);

  return { events, unread, markRead: () => setUnread(0) };
}
