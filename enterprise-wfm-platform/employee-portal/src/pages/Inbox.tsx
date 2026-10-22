/** Notifications: time-off decisions, swap updates, schedule changes, offers, bid results. */
import React from 'react';
import { api } from '../api';
import { Notification } from '../types';
import { useLoad, Banner, Btn, Busy, Card, Empty } from '../ui';

export const Inbox: React.FC = () => {
  const { data, error, loading, reload } = useLoad<{ unread: number; items: Notification[] }>('/me/notifications');

  const markAll = async () => { await api('/me/notifications/read', { method: 'POST', body: {} }); reload(); };
  const markOne = async (id: number) => { await api('/me/notifications/read', { method: 'POST', body: { ids: [id] } }); reload(); };

  if (loading && !data) return <Busy />;
  if (error) return <Banner kind="err">{error}</Banner>;
  if (!data) return null;

  return (
    <Card title="Notifications" actions={data.unread > 0 && <Btn onClick={markAll}>Mark all read</Btn>}>
      {data.items.length === 0 ? <Empty title="Nothing here yet" /> : (
        <div className="space-y-2">
          {data.items.map((n) => (
            <button key={n.id} onClick={() => !n.read && markOne(n.id)} className={`w-full text-left border rounded-md p-2.5 ${n.read ? 'border-[#E5E5E0] bg-white' : 'border-[#171717]/20 bg-[#FAFAF8]'}`}>
              <div className="flex items-center justify-between">
                <div className={`text-[13px] ${n.read ? 'font-medium text-[#525252]' : 'font-semibold text-[#171717]'}`}>{n.title}</div>
                {!n.read && <span className="w-2 h-2 rounded-full bg-[#171717]" />}
              </div>
              <div className="text-[12px] text-[#737373]">{n.body}</div>
              <div className="text-[11px] text-[#A3A3A3] mt-0.5">{new Date(n.createdAt).toLocaleString()}</div>
            </button>
          ))}
        </div>
      )}
    </Card>
  );
};
