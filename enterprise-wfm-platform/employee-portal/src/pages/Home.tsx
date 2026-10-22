/** Dashboard: colored stat tiles, today's and next shift, and what needs attention, each routing straight to the tab that handles it. */
import React from 'react';
import { Home as HomeDto } from '../types';
import { useLoad, Card, Busy, Banner, Pill, Stat, hm, dayLabel, contrastText } from '../ui';

const ShiftCard: React.FC<{ title: string; shift: HomeDto['todayShift']; emptyText?: string }> = ({ title, shift, emptyText = 'Nothing scheduled.' }) => (
  <Card title={title} style={shift ? { borderTop: `3px solid ${shift.color}` } : undefined}>
    {shift ? (
      <div>
        <div className="text-[18px] font-semibold text-[#171717]">{hm(shift.startTime)} – {hm(shift.endTime)}</div>
        <div className="text-[12px] text-[#737373]">{dayLabel(shift.day)}{shift.template ? ` · ${shift.template}` : ''}{shift.overnight ? ' · overnight' : ''}</div>
        {shift.activities.length > 0 && (
          <div className="flex flex-wrap gap-1.5 mt-2">
            {shift.activities.map((a, i) => (
              <span key={i} className="text-[10px] font-semibold px-1.5 py-0.5 rounded" style={{ backgroundColor: a.color, color: contrastText(a.color) }}>{a.type[0] + a.type.slice(1).toLowerCase()} {hm(a.startTime)}</span>
            ))}
          </div>
        )}
      </div>
    ) : <div className="text-[13px] text-[#737373]">{emptyText}</div>}
  </Card>
);

export const Home: React.FC<{ name: string; onNavigate: (tab: 'requests' | 'schedule' | 'inbox') => void }> = ({ name, onNavigate }) => {
  const { data, error, loading } = useLoad<HomeDto>('/me/home');
  if (loading && !data) return <Busy />;
  if (error) return <Banner kind="err">{error}</Banner>;
  if (!data) return null;

  const attention = [
    { n: data.offersOpen, label: 'open offer', labelPlural: 'open offers', tone: 'info' as const },
    { n: data.swapsIncoming, label: 'swap waiting on you', labelPlural: 'swaps waiting on you', tone: 'warn' as const },
    { n: data.pendingTimeOff, label: 'time off request pending', labelPlural: 'time off requests pending', tone: 'neutral' as const },
    { n: data.boardOpen, label: 'open shift on the board', labelPlural: 'open shifts on the board', tone: 'neutral' as const },
  ].filter((a) => a.n > 0);

  return (
    <div className="space-y-5">
      <div>
        <div className="text-[20px] font-semibold text-[#171717]">Hi, {name.split(' ')[0]}</div>
        <div className="text-[12px] text-[#737373]">{dayLabel(data.today)}</div>
      </div>
      {data.unreadNotifications > 0 && (
        <button onClick={() => onNavigate('inbox')} className="w-full text-left">
          <Banner kind="warn">{data.unreadNotifications} unread notification{data.unreadNotifications === 1 ? '' : 's'}</Banner>
        </button>
      )}

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <Stat label="Hours this week" value={data.weekHours} sub="scheduled" color="var(--color-accent)" />
        <Stat label="Time off pending" value={data.pendingTimeOff} color="#B7791F" />
        <Stat label="Swaps on you" value={data.swapsIncoming} color="#4F6F8F" />
        <Stat label="Open offers" value={data.offersOpen} color="#2F7D5A" />
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <ShiftCard title="Today" shift={data.todayShift} emptyText={data.publishedToday ? 'Rest day today.' : 'No schedule published yet for today.'} />
        {data.nextShift && data.nextShift.day !== data.todayShift?.day && <ShiftCard title="Next shift" shift={data.nextShift} />}
      </div>

      {attention.length > 0 && (
        <Card title="Needs your attention">
          <div className="space-y-2">
            {attention.map((a) => (
              <button key={a.label} onClick={() => onNavigate('requests')} className="w-full flex items-center justify-between text-[13px] text-[#171717] hover:text-[#171717]">
                <span>{a.n} {a.n === 1 ? a.label : a.labelPlural}</span>
                <Pill tone={a.tone}>Open</Pill>
              </button>
            ))}
          </div>
        </Card>
      )}
    </div>
  );
};
