/**
 * The tabs of the employee side panel that answer "where is this person this week, and are they OK?": their week, today's status, adherence and leave balances (Overview),
 * their skills (edited in place), and when they can and cannot work (Availability). All from live data: GET /workforce/employees/:id/glance and /availability.
 */
import React, { useEffect, useState } from 'react';
import { api, Employee, Skill } from '../../services/api';
import { useApi } from '../forecasting/hooks';
import { Banner, Btn, Pill } from '../forecasting/ui';
import { SkillsPicker } from './EmployeePickers';

type Glance = {
  employeeId: string; today: string;
  week: { from: string; to: string; paidHours: number; contractHours: number; maxHours: number; overMax: boolean; belowContract: boolean;
    days: { day: string; name: string; shift: { start: string; end: string; overnight: boolean; paidHours: number; scheduleName: string; groupName: string | null } | null; timeOff: { type: string; status: string } | null }[] };
  now: { status: string; scheduled: string; actual: string; state: string | null; outMinutes: number; shift: string | null; dayPercent: number | null } | null;
  adherenceLast7: { percent: number | null; scheduledMin: number; adherentMin: number; days: number } | null;
  balances: { type: string; entitledDays: number; accruedDays: number; carriedOverDays: number; usedDays: number; remainingDays: number }[];
  upcomingTimeOff: { type: string; startDay: string; endDay: string; status: string }[];
};

const label = (t: string) => t.charAt(0) + t.slice(1).toLowerCase().replace(/_/g, ' ');
const NOW_TONE: Record<string, 'good' | 'bad' | 'warn' | 'neutral'> = { IN: 'good', OUT: 'bad', UNKNOWN: 'warn', UNSCHEDULED: 'neutral', IGNORED: 'neutral' };
const NOW_TEXT: Record<string, string> = { IN: 'Doing what is scheduled', OUT: 'Out of adherence', UNKNOWN: 'State cannot be read', UNSCHEDULED: 'Not scheduled now', IGNORED: 'Not judged' };
const shortDay = (iso: string) => new Date(iso + 'T00:00:00').toLocaleDateString('en', { day: 'numeric', month: 'short' });
const Section: React.FC<{ title: string; children: React.ReactNode }> = ({ title, children }) => (
  <div className="space-y-2"><div className="text-[11px] font-semibold uppercase tracking-wider text-[#6B6B6B]">{title}</div>{children}</div>
);

export const OverviewTab: React.FC<{ employeeId: string }> = ({ employeeId }) => {
  const g = useApi<Glance>(`/workforce/employees/${employeeId}/glance`);
  if (g.loading && !g.data) return <div role="status" aria-busy="true" className="text-[13px] text-[#6B6B6B]">Loading this person's week…</div>;
  if (!g.data) return <Banner kind="err">{g.error || "Could not load this person's week."} <button className="underline font-semibold" onClick={g.reload}>Try again</button></Banner>;
  const d = g.data, w = d.week;
  return (
    <div className="space-y-5">
      <Section title="Right now">
        {d.now ? (
          <div className="space-y-1">
            <div className="flex items-center gap-2"><Pill tone={NOW_TONE[d.now.status] ?? 'neutral'}>{NOW_TEXT[d.now.status] ?? label(d.now.status)}</Pill>{d.now.status === 'OUT' && d.now.outMinutes > 0 && <span className="text-[#6B6B6B]">for {d.now.outMinutes} min</span>}</div>
            <div className="text-[#525252]">Scheduled: <b>{d.now.scheduled || '–'}</b> · Actual: <b>{d.now.actual || '–'}</b>{d.now.state ? ` (${d.now.state})` : ''}</div>
            {d.now.dayPercent !== null && <div className="text-[#6B6B6B]">{d.now.dayPercent}% adherent so far today</div>}
          </div>
        ) : <div className="text-[#6B6B6B]">No published schedule or agent activity to judge today against.</div>}
      </Section>

      <Section title={`This week · ${shortDay(w.from)} to ${shortDay(w.to)}`}>
        <ul className="divide-y divide-[#F0F0EC] border border-[#E5E5E0] rounded-lg">
          {w.days.map((x) => (
            <li key={x.day} className={`flex items-center justify-between gap-3 px-3 py-2 ${x.day === d.today ? 'bg-[#FAFAF8]' : ''}`}>
              <span className="w-24 text-[#525252]"><b className="text-[#171717]">{x.name}</b> {shortDay(x.day)}{x.day === d.today ? ' · today' : ''}</span>
              <span className="flex-1 text-right">
                {x.shift ? <span title={`${x.shift.scheduleName}${x.shift.groupName ? ` · ${x.shift.groupName}` : ''}`}><b>{x.shift.start}–{x.shift.end}</b>{x.shift.overnight ? ' (overnight)' : ''} <span className="text-[#6B6B6B]">{x.shift.paidHours} h paid</span></span>
                  : x.timeOff ? <Pill tone={x.timeOff.status === 'APPROVED' ? 'info' : 'warn'}>{label(x.timeOff.type)}{x.timeOff.status === 'REQUESTED' ? ' (requested)' : ''}</Pill> : <span className="text-[#6B6B6B]">Off</span>}
              </span>
            </li>
          ))}
        </ul>
        <div className="flex flex-wrap items-center gap-2">
          <span><b>{w.paidHours} h</b> paid this week of a {w.contractHours} h contract</span>
          {w.overMax && <Pill tone="bad">Over their {w.maxHours} h maximum</Pill>}
          {!w.overMax && w.belowContract && <Pill tone="warn">Below contract</Pill>}
        </div>
        {w.days.every((x) => !x.shift) && <div className="text-[#6B6B6B]">Nothing is scheduled for them this week in a published schedule.</div>}
      </Section>

      <Section title="Adherence, last 7 days">
        {d.adherenceLast7?.percent != null
          ? <div><b className="text-[18px]">{d.adherenceLast7.percent}%</b> <span className="text-[#6B6B6B]">{d.adherenceLast7.adherentMin} of {d.adherenceLast7.scheduledMin} scheduled minutes over {d.adherenceLast7.days} day{d.adherenceLast7.days === 1 ? '' : 's'}</span></div>
          : <div className="text-[#6B6B6B]">No finished days with a schedule and agent activity yet.</div>}
      </Section>

      <Section title="Leave balances this year">
        {d.balances.length === 0 ? <div className="text-[#6B6B6B]">No leave entitlements are set up.</div> : (
          <div className="grid grid-cols-2 gap-2">
            {d.balances.map((b) => (
              <div key={b.type} className="rounded-lg border border-[#E5E5E0] bg-[#FAFAF8] p-2.5">
                <div className="text-[11px] text-[#6B6B6B]">{label(b.type)}</div>
                <div className="font-semibold tabular-nums">{b.remainingDays} <span className="font-normal text-[#6B6B6B]">of {Math.round((b.accruedDays + b.carriedOverDays) * 100) / 100} days left ({b.usedDays} used)</span></div>
              </div>
            ))}
          </div>
        )}
        {d.upcomingTimeOff.length > 0 && <div className="text-[#525252]">Coming up: {d.upcomingTimeOff.slice(0, 3).map((t) => `${label(t.type)} ${shortDay(t.startDay)}${t.endDay !== t.startDay ? `–${shortDay(t.endDay)}` : ''}${t.status === 'REQUESTED' ? ' (requested)' : ''}`).join(', ')}</div>}
      </Section>
    </div>
  );
};

export const SkillsTab: React.FC<{ employee: Employee; skills: Skill[]; canWrite: boolean; onSaved: (e: Employee) => void }> = ({ employee, skills, canWrite, onSaved }) => {
  const initial = () => Object.fromEntries(employee.skills.map((s) => [s.skillId, s.proficiency]));
  const [value, setValue] = useState<Record<string, number>>(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => { setValue(initial()); setError(''); }, [employee.id]);   // eslint-disable-line react-hooks/exhaustive-deps
  const changed = JSON.stringify(Object.entries(value).sort()) !== JSON.stringify(Object.entries(initial()).sort());
  const save = async () => {
    setBusy(true); setError('');
    try { onSaved(await api<Employee>(`/workforce/employees/${employee.id}/skills`, { method: 'PUT', body: { skills: Object.entries(value).map(([skillId, proficiency]) => ({ skillId, proficiency })) } })); }
    catch (e: any) { setError(e.message); } finally { setBusy(false); }
  };
  if (!canWrite) return employee.skills.length === 0 ? <div className="text-[#6B6B6B]">None</div> : <div className="flex flex-wrap gap-1.5">{employee.skills.map((s) => <span key={s.skillId} className="text-[11px] bg-[#F5F5F2] text-[#525252] rounded px-1.5 py-0.5">{s.name} · L{s.proficiency}</span>)}</div>;
  return (
    <div className="space-y-3">
      {error && <Banner kind="err" onClose={() => setError('')}>{error}</Banner>}
      <SkillsPicker skills={skills as any} value={value} onChange={setValue} />
      {changed && <div className="flex items-center gap-2"><Btn variant="primary" disabled={busy} onClick={save}>{busy ? 'Saving…' : 'Save skills'}</Btn><Btn onClick={() => setValue(initial())}>Undo</Btn></div>}
    </div>
  );
};

type Avail = { id: string; dayOfWeek: number; startTime: string; endTime: string; kind: 'AVAILABLE' | 'UNAVAILABLE' | 'PREFERRED'; effectiveFrom: string | null; effectiveTo: string | null };
const DOW = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const KIND: Record<Avail['kind'], { text: string; tone: 'good' | 'bad' | 'info' }> = { AVAILABLE: { text: 'Available', tone: 'good' }, UNAVAILABLE: { text: 'Not available', tone: 'bad' }, PREFERRED: { text: 'Prefers', tone: 'info' } };

export const AvailabilityTab: React.FC<{ employeeId: string; onOpenScreen: () => void; canWrite: boolean }> = ({ employeeId, onOpenScreen, canWrite }) => {
  const a = useApi<Avail[]>(`/workforce/employees/${employeeId}/availability`);
  if (a.loading && !a.data) return <div role="status" aria-busy="true" className="text-[13px] text-[#6B6B6B]">Loading availability…</div>;
  if (!a.data) return <Banner kind="err">{a.error || 'Could not load availability.'} <button className="underline font-semibold" onClick={a.reload}>Try again</button></Banner>;
  return (
    <div className="space-y-3">
      {a.data.length === 0 ? <div className="text-[#6B6B6B]">No limits on when this person can work: they can be scheduled at any time, within their contract.</div> : (
        <ul className="divide-y divide-[#F0F0EC] border border-[#E5E5E0] rounded-lg">
          {a.data.map((r) => (
            <li key={r.id} className="flex items-center justify-between gap-3 px-3 py-2">
              <span><b>{DOW[r.dayOfWeek]}</b> {r.startTime}–{r.endTime}{r.effectiveFrom || r.effectiveTo ? <span className="text-[#6B6B6B]"> · {r.effectiveFrom ?? 'always'} to {r.effectiveTo ?? 'open'}</span> : null}</span>
              <Pill tone={KIND[r.kind].tone}>{KIND[r.kind].text}</Pill>
            </li>
          ))}
        </ul>
      )}
      <button className="text-[12px] underline font-semibold text-[#171717]" onClick={onOpenScreen}>{canWrite ? 'Edit availability' : 'Open availability'}</button>
    </div>
  );
};
