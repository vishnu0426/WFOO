/**
 * Team: who is working. A team lead sees their people with their day (working, off, on leave and what kind); a colleague sees only what the organisation allows
 * (names on shift now, or the team roster for the week), for their own team. The gateway decides what is sent; this page only shows it.
 */
import React, { useState } from 'react';
import { useLoad, Busy, Banner, Card, Empty, Pill, Stat, hm, dayLabel, addDays } from '../ui';

type Status = 'ON_NOW' | 'LATER' | 'DONE' | 'WORKING' | 'LEAVE' | 'OFF' | 'UNPUBLISHED';
type Person = { employeeId: string; name: string; team: string | null; status: Status; startTime: string | null; endTime: string | null; leaveType: string | null };
type TeamDto = { access: 'FULL' | 'PEERS_NOW' | 'PEERS_ROSTER' | 'NONE'; date: string; today: string; scope: string | null; people: Person[]; counts: { working: number; onNow: number; off: number; leave: number; unpublished: number }; truncated: boolean };

const LABEL: Record<Status, string> = { ON_NOW: 'On shift now', LATER: 'Later today', DONE: 'Finished', WORKING: 'Working', LEAVE: 'On leave', OFF: 'Off', UNPUBLISHED: 'Not published' };
const TONE: Record<Status, 'good' | 'info' | 'neutral' | 'warn'> = { ON_NOW: 'good', LATER: 'info', DONE: 'neutral', WORKING: 'info', LEAVE: 'warn', OFF: 'neutral', UNPUBLISHED: 'warn' };
const ORDER: Status[] = ['ON_NOW', 'LATER', 'WORKING', 'DONE', 'LEAVE', 'OFF', 'UNPUBLISHED'];
const leaveName = (t: string | null) => (t ? t[0] + t.slice(1).toLowerCase() : 'Leave');

export const Team: React.FC = () => {
  const [date, setDate] = useState<string | null>(null);
  const { data, error, loading } = useLoad<TeamDto>(`/me/team${date ? `?date=${date}` : ''}`, [date]);
  if (loading && !data) return <Busy />;
  if (error) return <Banner kind="err">{error}</Banner>;
  if (!data) return null;
  if (data.access === 'NONE') return <Empty title="The team view is not available to you" />;

  const isToday = data.date === data.today;
  const canBrowse = data.access !== 'PEERS_NOW';
  const rows = [...data.people].sort((a, b) => ORDER.indexOf(a.status) - ORDER.indexOf(b.status) || a.name.localeCompare(b.name));
  const lead = data.access === 'FULL';
  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <div className="text-[20px] font-semibold text-[#171717]">{data.scope ?? 'Team'}</div>
          <div className="text-[12px] text-[#6B6B6B]">{isToday ? 'Today · ' : ''}{dayLabel(data.date)}{data.access === 'PEERS_NOW' ? ' · colleagues on shift right now' : ''}</div>
        </div>
        {canBrowse && (
          <div className="flex items-center gap-1.5">
            <button className="px-2.5 py-1.5 text-[13px] rounded-md border border-[#E5E5E0] bg-white disabled:opacity-40" aria-label="Previous day" disabled={data.access === 'PEERS_ROSTER' && data.date <= data.today} onClick={() => setDate(addDays(data.date, -1))}>←</button>
            <button className="px-3 py-1.5 text-[13px] rounded-md border border-[#E5E5E0] bg-white disabled:opacity-40" disabled={isToday} onClick={() => setDate(null)}>Today</button>
            <button className="px-2.5 py-1.5 text-[13px] rounded-md border border-[#E5E5E0] bg-white disabled:opacity-40" aria-label="Next day" disabled={data.access === 'PEERS_ROSTER' && data.date >= addDays(data.today, 7)} onClick={() => setDate(addDays(data.date, 1))}>→</button>
          </div>
        )}
      </div>

      {data.access !== 'PEERS_NOW' && (
        <div className={`grid gap-3 ${lead ? 'grid-cols-2 sm:grid-cols-4' : 'grid-cols-2 sm:grid-cols-3'}`}>
          <Stat label="Working" value={data.counts.working} color="#2F7D5A" />
          {isToday && <Stat label="On shift now" value={data.counts.onNow} color="var(--color-accent)" />}
          <Stat label="Off" value={data.counts.off} color="#6B6B6B" />
          {lead && <Stat label="On leave" value={data.counts.leave} color="#B7791F" />}
        </div>
      )}
      {data.counts.unpublished > 0 && (
        <Banner kind="warn">
          {data.counts.unpublished === data.people.length ? "No schedule has been published for this day yet, so nobody's shifts are shown." : `${data.counts.unpublished} ${data.counts.unpublished === 1 ? 'person has' : 'people have'} no published schedule for this day, so their shifts are not shown.`} They are not necessarily off.
        </Banner>
      )}
      {data.truncated && <Banner kind="warn">This list is cut short. Only the first people are shown.</Banner>}

      <Card title={data.access === 'PEERS_NOW' ? 'On shift now' : 'People'}>
        {rows.length === 0 ? <div className="text-[13px] text-[#6B6B6B]">{data.access === 'PEERS_NOW' ? 'Nobody else in your team is on shift right now.' : 'Nobody to show for this day.'}</div> : (
          <ul className="divide-y divide-[#F0F0EC]">
            {rows.map((r) => (
              <li key={r.employeeId} className="flex items-center justify-between gap-3 py-2">
                <div className="min-w-0">
                  <div className="text-[13px] font-semibold text-[#171717] truncate">{r.name}</div>
                  {lead && r.team && <div className="text-[11px] text-[#6B6B6B] truncate">{r.team}</div>}
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  {r.startTime && r.endTime && <span className="text-[12px] text-[#525252]">{hm(r.startTime)}–{hm(r.endTime)}</span>}
                  <Pill tone={TONE[r.status]}>{r.status === 'LEAVE' && lead ? leaveName(r.leaveType) : LABEL[r.status]}</Pill>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>
      {!lead && <div className="text-[11px] text-[#6B6B6B]">You see your own team only, as your organisation allows.</div>}
    </div>
  );
};
