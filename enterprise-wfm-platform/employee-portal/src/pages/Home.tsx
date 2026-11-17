/**
 * Home: what is happening today (with a countdown), the week at a glance, what needs the person's attention (each item opens the exact place that handles it),
 * and the common jobs as buttons. Counts that are zero are not shown as tiles: they say nothing.
 */
import React, { useEffect, useState } from 'react';
import { Bid, DaySummary, Home as HomeDto, Profile, RequestPrefill, Shift, TimeOffBalance } from '../types';
import { useLoad, Card, Busy, Banner, Btn, Pill, Stat, hm, dayLabel, contrastText } from '../ui';

type Tab = 'schedule' | 'inbox' | 'profile';
type Go = (p: RequestPrefill) => void;

const pad = (n: number) => String(n).padStart(2, '0');
/** Minutes since midnight now, on the clock of `timeZone` (the person's group), not the browser's. */
function minutesNow(timeZone: string): number {
  try {
    const parts = new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date());
    return Number(parts.find((p) => p.type === 'hour')?.value) * 60 + Number(parts.find((p) => p.type === 'minute')?.value);
  } catch { const d = new Date(); return d.getHours() * 60 + d.getMinutes(); }
}
const toMin = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
const span = (m: number) => (m >= 60 ? `${Math.floor(m / 60)} h${m % 60 ? ` ${pad(m % 60)} min` : ''}` : `${Math.max(1, m)} min`);

/** Where today's shift is right now, in words: starts in…, on now, ends in…, finished. */
export function shiftStatus(shift: Pick<Shift, 'startTime' | 'endTime' | 'overnight'>, now: number): { text: string; tone: 'info' | 'good' | 'neutral' } {
  const start = toMin(shift.startTime), end = toMin(shift.endTime) + (shift.overnight ? 24 * 60 : 0);
  if (now < start) return { text: `Starts in ${span(start - now)}`, tone: 'info' };
  if (now < end) return { text: `On shift now · ends in ${span(end - now)}`, tone: 'good' };
  return { text: 'Finished for today', tone: 'neutral' };
}

const TodayCard: React.FC<{ home: HomeDto; today: DaySummary | null }> = ({ home, today }) => {
  const [now, setNow] = useState(() => minutesNow(home.timezone));
  useEffect(() => { const h = setInterval(() => setNow(minutesNow(home.timezone)), 30_000); return () => clearInterval(h); }, [home.timezone]);
  const s = home.todayShift;
  if (s) {
    const st = shiftStatus(s, now);
    return (
      <Card title="Today" actions={<Pill tone={st.tone}>{st.text}</Pill>} style={{ borderTop: `3px solid ${s.color}` }}>
        <div className="text-[24px] font-semibold text-[#171717]">{hm(s.startTime)} – {hm(s.endTime)}</div>
        <div className="text-[12px] text-[#6B6B6B]">{dayLabel(s.day)}{s.template ? ` · ${s.template}` : ''}{s.overnight ? ' · ends after midnight' : ''} · {s.paidHours} h paid</div>
        {s.activities.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {s.activities.map((a, i) => <span key={i} className="text-[10px] font-semibold px-1.5 py-0.5 rounded" style={{ backgroundColor: a.color, color: contrastText(a.color) }}>{a.type[0] + a.type.slice(1).toLowerCase()} {hm(a.startTime)}</span>)}
          </div>
        )}
      </Card>
    );
  }
  // no shift today: say which kind of nothing it is
  const leave = today?.timeOff;
  const [title, text] = leave
    ? leave.status === 'APPROVED' ? ['On approved leave', 'Enjoy your time off.'] : ['Time off requested', 'You asked for today off. It is waiting for a decision.']
    : home.publishedToday ? ['Day off', 'You are not scheduled today. Enjoy your day.']
    : ['No schedule yet', 'Your schedule for today has not been published. Your manager will publish it, and you will be told.'];
  return <Card title="Today"><div className="text-[18px] font-semibold text-[#171717]">{title}</div><div className="text-[13px] text-[#6B6B6B]">{text}</div></Card>;
};

const WeekStrip: React.FC<{ days: DaySummary[]; today: string; onOpen: () => void }> = ({ days, today, onOpen }) => (
  <Card title="This week" actions={<button onClick={onOpen} className="text-[12px] text-[#6B6B6B] underline hover:text-[#171717]">Open schedule</button>}>
    <div className="grid grid-cols-7 gap-1.5">
      {days.map((d) => {
        const isToday = d.day === today, dt = new Date(`${d.day}T00:00:00`);
        const label = d.shift ? `${hm(d.shift.startTime)}–${hm(d.shift.endTime)}` : d.timeOff ? 'Leave' : d.published ? 'Off' : '–';
        return (
          <button key={d.day} onClick={onOpen} aria-label={`${dayLabel(d.day)}: ${d.shift ? label : d.timeOff ? 'time off' : d.published ? 'day off' : 'not published'}`}
            className={`rounded-md border px-1 py-2 text-center ${isToday ? 'border-accent bg-[#EEF3FB]' : 'border-[#E5E5E0] bg-white'} hover:bg-[#FAFAF8]`}
            style={d.shift ? { borderTop: `3px solid ${d.shift.color}` } : undefined}>
            <div className="text-[10px] font-semibold uppercase text-[#6B6B6B]">{dt.toLocaleDateString('en-US', { weekday: 'short' })}</div>
            <div className="text-[15px] font-semibold text-[#171717]">{dt.getDate()}</div>
            <div className={`text-[10px] leading-tight mt-0.5 ${d.shift ? 'text-[#171717] font-semibold' : 'text-[#6B6B6B]'}`}>{label}</div>
          </button>
        );
      })}
    </div>
  </Card>
);

export const Home: React.FC<{ name: string; onNavigate: (tab: Tab) => void; onGo: Go }> = ({ name, onNavigate, onGo }) => {
  const home = useLoad<HomeDto>('/me/home');
  const data = home.data;
  const week = useLoad<{ days: DaySummary[] }>(data ? `/me/schedule?from=${data.weekFrom}&to=${data.weekTo}` : null, [data?.weekFrom]);
  const bids = useLoad<Bid[]>('/me/bids');
  const leave = useLoad<{ balances: TimeOffBalance[] }>('/me/time-off');
  const profile = useLoad<Profile>('/me/profile');
  if (home.loading && !data) return <Busy />;
  if (home.error) return <Banner kind="err">{home.error}</Banner>;
  if (!data) return null;

  const bidsToRank = (bids.data ?? []).filter((b) => b.status === 'OPEN' && b.myRanking.length === 0).length;      // open rounds this person has not ranked in yet
  type Item = { n: number; one: string; many: string; tone: 'info' | 'warn' | 'neutral'; go: () => void };
  const attention = ([
    { n: data.swapsIncoming, one: 'swap waiting for your answer', many: 'swaps waiting for your answer', tone: 'warn', go: () => onGo({ tab: 'swaps' }) },
    { n: bidsToRank, one: 'shift bidding round to rank', many: 'shift bidding rounds to rank', tone: 'warn', go: () => onGo({ tab: 'opportunities' }) },
    { n: data.offersOpen, one: 'open offer', many: 'open offers', tone: 'info', go: () => onGo({ tab: 'opportunities' }) },
    { n: data.unreadNotifications, one: 'unread notification', many: 'unread notifications', tone: 'info', go: () => onNavigate('inbox') },
    { n: data.pendingTimeOff, one: 'time off request waiting for a decision', many: 'time off requests waiting for a decision', tone: 'neutral', go: () => onGo({ tab: 'timeoff' }) },
    { n: data.boardOpen, one: 'open shift on the board', many: 'open shifts on the board', tone: 'neutral', go: () => onGo({ tab: 'swaps' }) },
  ] as Item[]).filter((a) => a.n > 0);

  const today = week.data?.days.find((d) => d.day === data.today) ?? null;
  const worked = week.data?.days.filter((d) => d.shift).length ?? null;
  const contract = profile.data?.weeklyContractHours || 0;
  const vacation = leave.data?.balances.find((b) => b.type === 'VACATION');
  const upcomingNote = !data.nextShift && !data.todayShift ? 'You have no upcoming shifts yet. They appear here once your manager publishes your schedule.' : null;

  return (
    <div className="space-y-5">
      <div>
        <div className="text-[20px] font-semibold text-[#171717]">Hi, {name.split(' ')[0]}</div>
        <div className="text-[12px] text-[#6B6B6B]">{dayLabel(data.today)}</div>
      </div>

      <Card title="Needs your attention">
        {attention.length === 0 ? <div className="text-[13px] text-[#6B6B6B]">You are all caught up.</div> : (
          <div className="divide-y divide-[#F0F0EC]">
            {attention.map((a) => (
              <button key={a.one} onClick={a.go} className="w-full flex items-center justify-between py-2 text-[13px] text-[#171717] text-left">
                <span><b>{a.n}</b> {a.n === 1 ? a.one : a.many}</span>
                <Pill tone={a.tone}>Open</Pill>
              </button>
            ))}
          </div>
        )}
      </Card>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
        <div className="lg:col-span-2 space-y-3">
          <TodayCard home={data} today={today} />
          {upcomingNote && <Banner kind="warn">{upcomingNote}</Banner>}
          {data.nextShift && data.nextShift.day !== data.todayShift?.day && (
            <Card title="Next shift" style={{ borderTop: `3px solid ${data.nextShift.color}` }}>
              <div className="text-[18px] font-semibold text-[#171717]">{hm(data.nextShift.startTime)} – {hm(data.nextShift.endTime)}</div>
              <div className="text-[12px] text-[#6B6B6B]">{dayLabel(data.nextShift.day)}{data.nextShift.template ? ` · ${data.nextShift.template}` : ''}{data.nextShift.overnight ? ' · ends after midnight' : ''}</div>
            </Card>
          )}
          {week.data ? <WeekStrip days={week.data.days} today={data.today} onOpen={() => onNavigate('schedule')} /> : week.error ? <Banner kind="err">{week.error}</Banner> : null}
        </div>
        <div className="space-y-3">
          <Stat label="Hours this week" value={`${data.weekHours}${contract ? ` of ${contract}` : ''} h`} sub={contract ? `${Math.round((data.weekHours / contract) * 100)}% of your contract` : 'scheduled'} color="var(--color-accent)" />
          {worked !== null && <Stat label="Days worked this week" value={`${worked} of 7`} color="#4F6F8F" />}
          {vacation && <Stat label="Vacation left" value={`${vacation.remainingDays} day${vacation.remainingDays === 1 ? '' : 's'}`} sub={`${vacation.usedDays} of ${vacation.entitledDays} used`} color="#2F7D5A" />}
        </div>
      </div>

      <Card title="Quick actions">
        <div className="flex flex-wrap gap-2">
          <Btn variant="primary" onClick={() => onGo({ tab: 'timeoff' })}>Request time off</Btn>
          <Btn onClick={() => onGo({ tab: 'swaps' })}>Change a shift</Btn>
          <Btn onClick={() => onGo({ tab: 'opportunities' })}>Open shifts and offers</Btn>
          <Btn onClick={() => onNavigate('profile')}>My availability</Btn>
        </div>
      </Card>
    </div>
  );
};
