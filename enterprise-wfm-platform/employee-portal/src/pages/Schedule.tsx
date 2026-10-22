/** A real week grid -- seven day columns side by side, shift blocks colored by activity (the same colours the admin
 * Schedule Timeline uses), matching how Calabrio and most shift-scheduling products show "my schedule". */
import React, { useEffect, useState } from 'react';
import { DaySummary, RequestPrefill } from '../types';
import { useLoad, Card, Busy, Banner, Btn, Modal, Pill, hm, dayLabel, todayIso, addDays, contrastText } from '../ui';

const mondayOf = (iso: string) => { const d = new Date(`${iso}T00:00:00Z`); const dow = (d.getUTCDay() + 6) % 7; return addDays(iso, -dow); };
const weekday = (iso: string) => new Date(`${iso}T00:00:00`).toLocaleDateString('en-US', { weekday: 'short' });
const dayNum = (iso: string) => new Date(`${iso}T00:00:00`).getDate();
const fullDate = (iso: string) => new Date(`${iso}T00:00:00`).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
const titleCase = (s: string) => s[0] + s.slice(1).toLowerCase();
const monthOf = (iso: string) => iso.slice(0, 7);
const startOfMonth = (iso: string) => `${monthOf(iso)}-01`;
const addMonths = (iso: string, n: number) => { const d = new Date(`${iso}T00:00:00Z`); d.setUTCMonth(d.getUTCMonth() + n); return d.toISOString().slice(0, 10); };
const endOfMonth = (iso: string) => addDays(addMonths(startOfMonth(iso), 1), -1);
const monthLabel = (iso: string) => new Date(`${startOfMonth(iso)}T00:00:00`).toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
const toMinutes = (s: string) => { const [h, m] = s.split(':').map(Number); return h * 60 + m; };

/** % elapsed through a shift right now, or null if it isn't currently running. Minutes are measured from the shift's
    OWN day's midnight (not the clock's calendar day), so an overnight shift that started yesterday and runs past
    midnight still reports progress on the day-card it's drawn on, without needing to look at "today" at all. */
const shiftProgress = (d: DaySummary, now: Date): number | null => {
  if (!d.shift) return null;
  const dayStart = new Date(`${d.day}T00:00:00`);
  const nowMin = (now.getTime() - dayStart.getTime()) / 60000;
  const startMin = toMinutes(d.shift.startTime);
  const endMin = toMinutes(d.shift.endTime) + (d.shift.overnight ? 1440 : 0);
  if (nowMin < startMin || nowMin > endMin) return null;
  return Math.max(0, Math.min(100, ((nowMin - startMin) / (endMin - startMin)) * 100));
};

const DayColumn: React.FC<{ d: DaySummary; isToday: boolean; progress: number | null; onClick: () => void }> = ({ d, isToday, progress, onClick }) => (
  <button onClick={onClick} className={`text-left rounded-lg border bg-white flex flex-col min-h-37.5 hover:shadow-md hover:-translate-y-0.5 transition-all cursor-pointer ${isToday ? 'border-accent ring-1 ring-accent' : 'border-[#E5E5E0]'}`}>
    <div className={`px-2.5 py-2 text-center border-b ${isToday ? 'bg-accent-bg border-accent' : 'border-[#E5E5E0]'}`}>
      <div className={`text-[10px] font-semibold uppercase tracking-wider ${isToday ? 'text-accent' : 'text-[#737373]'}`}>{weekday(d.day)}</div>
      <div className={`text-[15px] font-bold ${isToday ? 'text-accent' : 'text-[#171717]'}`}>{dayNum(d.day)}</div>
    </div>
    <div className="p-2 flex-1 flex flex-col gap-1.5">
      {d.timeOff ? (
        <div className="rounded-md px-2 py-2 text-[11px] font-semibold text-center" style={{ backgroundColor: 'var(--color-accent-bg)', color: 'var(--color-accent-dark)' }}>
          {d.timeOff.type.replace(/_/g, ' ').toLowerCase()}
          <div className="font-normal text-[10px] mt-0.5">{d.timeOff.status.toLowerCase()}</div>
        </div>
      ) : d.shift ? (
        <>
          <div className="rounded-md px-2 py-1.5" style={{ backgroundColor: d.shift.color, color: contrastText(d.shift.color) }}>
            <div className="text-[12px] font-bold leading-tight">{hm(d.shift.startTime)}</div>
            <div className="text-[11px] opacity-90 leading-tight">– {hm(d.shift.endTime)}</div>
            {progress !== null && (
              <div className="mt-1.5 h-1 rounded-full overflow-hidden" style={{ backgroundColor: `${contrastText(d.shift.color)}30` }} title={`${Math.round(progress)}% through this shift`}>
                <div className="h-full rounded-full" style={{ width: `${progress}%`, backgroundColor: contrastText(d.shift.color) }} />
              </div>
            )}
          </div>
          {progress !== null && <div className="text-[10px] font-semibold text-accent px-0.5">In progress</div>}
          {d.shift.template && <div className="text-[10px] text-[#737373] truncate px-0.5">{d.shift.template}</div>}
          {d.shift.activities.length > 0 && (
            <div className="flex flex-wrap gap-1 px-0.5">
              {d.shift.activities.map((a, i) => (
                <span key={i} title={`${a.type.toLowerCase()} ${hm(a.startTime)}–${hm(a.endTime)}`} className="w-2.5 h-2.5 rounded-sm" style={{ backgroundColor: a.color }} />
              ))}
            </div>
          )}
          {d.swap && <Pill tone="info">{d.swap.kind === 'SWAP' ? 'Swap pending' : 'Giveaway pending'}</Pill>}
        </>
      ) : (
        <div className="flex-1 flex items-center justify-center text-center text-[11px] text-[#A3A3A3] px-1">{d.published ? 'Rest day' : 'Not published'}</div>
      )}
    </div>
  </button>
);

const MonthCell: React.FC<{ d: DaySummary; isToday: boolean; inMonth: boolean; onClick: () => void }> = ({ d, isToday, inMonth, onClick }) => (
  <button
    onClick={onClick}
    className={`text-left rounded-md border p-1.5 min-h-20 flex flex-col gap-1 hover:shadow-sm transition-shadow ${isToday ? 'border-accent ring-1 ring-accent' : 'border-[#E5E5E0]'} ${inMonth ? 'bg-white' : 'bg-[#FAFAF8]'}`}
  >
    <div className={`text-[11px] font-semibold ${isToday ? 'text-accent' : inMonth ? 'text-[#171717]' : 'text-[#A3A3A3]'}`}>{dayNum(d.day)}</div>
    {d.timeOff ? (
      <span className="text-[9px] font-semibold px-1 py-0.5 rounded truncate" style={{ backgroundColor: 'var(--color-accent-bg)', color: 'var(--color-accent-dark)' }}>
        {titleCase(d.timeOff.type.replace(/_/g, ' '))}
      </span>
    ) : d.shift ? (
      <span className="text-[9px] font-semibold px-1 py-0.5 rounded truncate" style={{ backgroundColor: d.shift.color, color: contrastText(d.shift.color) }}>{hm(d.shift.startTime)}–{hm(d.shift.endTime)}</span>
    ) : inMonth && d.published ? (
      <span className="text-[9px] text-[#A3A3A3]">Rest</span>
    ) : null}
  </button>
);

const DayDetail: React.FC<{ d: DaySummary; onClose: () => void; onRequestAction: (p: RequestPrefill) => void }> = ({ d, onClose, onRequestAction }) => (
  <Modal title={fullDate(d.day)} onClose={onClose}>
    <div className="space-y-4">
      {d.timeOff ? (
        <div className="rounded-md p-3" style={{ backgroundColor: 'var(--color-accent-bg)' }}>
          <div className="text-[14px] font-semibold text-accent-dark">{titleCase(d.timeOff.type.replace(/_/g, ' '))}</div>
          <div className="text-[12px] text-[#737373] mt-0.5">{titleCase(d.timeOff.status)}</div>
        </div>
      ) : d.shift ? (
        <>
          <div className="rounded-md p-3" style={{ backgroundColor: d.shift.color, color: contrastText(d.shift.color) }}>
            <div className="text-[20px] font-bold">{hm(d.shift.startTime)} – {hm(d.shift.endTime)}</div>
            <div className="text-[12px] opacity-90 mt-0.5">{d.shift.paidHours.toFixed(1)} paid hours{d.shift.overnight ? ' · overnight' : ''}{d.shift.template ? ` · ${d.shift.template}` : ''}</div>
          </div>
          {d.shift.activities.length > 0 && (
            <div className="space-y-1.5">
              <div className="text-[11px] font-semibold text-[#737373] uppercase tracking-wider">Breakdown</div>
              {d.shift.activities.map((a, i) => (
                <div key={i} className="flex items-center gap-2 text-[13px] text-[#171717]">
                  <span className="w-2.5 h-2.5 rounded-sm shrink-0" style={{ backgroundColor: a.color }} />
                  <span className="font-medium">{titleCase(a.type)}</span>
                  <span className="text-[#737373] ml-auto">{hm(a.startTime)}–{hm(a.endTime)}</span>
                </div>
              ))}
            </div>
          )}
          {d.swap && <Banner kind="warn">{d.swap.kind === 'SWAP' ? 'Swap' : 'Giveaway'} request {d.swap.status.toLowerCase().replace(/_/g, ' ')} for this shift.</Banner>}
        </>
      ) : (
        <div className="text-[13px] text-[#737373] py-1">{d.published ? 'Rest day — nothing scheduled.' : 'Schedule not published yet for this day.'}</div>
      )}

      {(d.shift || !d.timeOff) && (
        <div className="flex flex-col gap-2 pt-3 border-t border-[#E5E5E0]">
          {d.shift && !d.swap && (
            <Btn variant="primary" onClick={() => { onRequestAction({ tab: 'swaps', shiftId: d.shift!.id }); onClose(); }}>Swap or give away this shift</Btn>
          )}
          {!d.timeOff && (
            <Btn onClick={() => { onRequestAction({ tab: 'timeoff', date: d.day }); onClose(); }}>Request time off for this day</Btn>
          )}
        </div>
      )}
    </div>
  </Modal>
);

export const Schedule: React.FC<{ onRequestAction: (p: RequestPrefill) => void }> = ({ onRequestAction }) => {
  const [view, setView] = useState<'week' | 'month'>('week');
  const [anchor, setAnchor] = useState(todayIso());
  const [selected, setSelected] = useState<DaySummary | null>(null);
  const [now, setNow] = useState(() => new Date());
  useEffect(() => { const t = setInterval(() => setNow(new Date()), 60_000); return () => clearInterval(t); }, []);

  const monday = mondayOf(anchor);
  const sunday = addDays(monday, 6);
  const gridStart = view === 'week' ? monday : mondayOf(startOfMonth(anchor));
  const gridEnd = view === 'week' ? sunday : addDays(mondayOf(endOfMonth(anchor)), 6);
  const { data, error, loading } = useLoad<{ days: DaySummary[] }>(`/me/schedule?from=${gridStart}&to=${gridEnd}`, [gridStart, gridEnd]);

  const isCurrentPeriod = view === 'week' ? monday === mondayOf(todayIso()) : monthOf(anchor) === monthOf(todayIso());
  const inMonthDays = (data?.days ?? []).filter((d) => view === 'week' || monthOf(d.day) === monthOf(anchor));
  const totalHours = inMonthDays.reduce((sum, d) => sum + (d.shift?.paidHours ?? 0), 0);

  const goPrev = () => setAnchor(view === 'week' ? addDays(monday, -7) : addMonths(anchor, -1));
  const goNext = () => setAnchor(view === 'week' ? addDays(monday, 7) : addMonths(anchor, 1));

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (selected) return; // let the day-detail modal own arrow keys while it's open
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      if (e.key === 'ArrowLeft') goPrev();
      else if (e.key === 'ArrowRight') goNext();
      else return;
      e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, anchor, selected]);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div className="flex items-center gap-2">
          <button onClick={goPrev} aria-label="Previous" className="w-8 h-8 flex items-center justify-center rounded border border-[#E5E5E0] text-[14px] bg-white hover:bg-[#FAFAF8]">‹</button>
          <button onClick={goNext} aria-label="Next" className="w-8 h-8 flex items-center justify-center rounded border border-[#E5E5E0] text-[14px] bg-white hover:bg-[#FAFAF8]">›</button>
          {!isCurrentPeriod && <button onClick={() => setAnchor(todayIso())} className="px-3 py-1.5 rounded border border-accent text-accent text-[12px] font-semibold bg-accent-bg hover:bg-accent/10">Today</button>}
        </div>
        <div className="text-[14px] font-semibold text-[#171717]">
          {view === 'week' ? <>{dayLabel(monday)} – {dayLabel(sunday)}</> : monthLabel(anchor)}
          {isCurrentPeriod && <span className="ml-2 text-[11px] font-semibold text-accent align-middle">{view === 'week' ? 'This week' : 'This month'}</span>}
        </div>
        <div className="flex items-center gap-3">
          <div className="text-[13px] font-semibold text-accent">{totalHours.toFixed(1)}h scheduled</div>
          <div className="flex gap-1 bg-[#F0F0EC] rounded-md p-1">
            <button onClick={() => setView('week')} className={`text-[12px] font-semibold px-2.5 py-1 rounded ${view === 'week' ? 'bg-white text-[#171717] shadow-xs' : 'text-[#737373]'}`}>Week</button>
            <button onClick={() => setView('month')} className={`text-[12px] font-semibold px-2.5 py-1 rounded ${view === 'month' ? 'bg-white text-[#171717] shadow-xs' : 'text-[#737373]'}`}>Month</button>
          </div>
        </div>
      </div>
      {loading && !data && <Busy />}
      {error && <Banner kind="err">{error}</Banner>}
      {data && view === 'week' && (
        <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-7 gap-2.5">
          {data.days.map((d) => <DayColumn key={d.day} d={d} isToday={d.day === todayIso()} progress={shiftProgress(d, now)} onClick={() => setSelected(d)} />)}
        </div>
      )}
      {data && view === 'month' && (
        <div className="grid grid-cols-7 gap-1.5">
          {data.days.map((d) => <MonthCell key={d.day} d={d} isToday={d.day === todayIso()} inMonth={monthOf(d.day) === monthOf(anchor)} onClick={() => setSelected(d)} />)}
        </div>
      )}
      {selected && <DayDetail d={selected} onClose={() => setSelected(null)} onRequestAction={onRequestAction} />}
      <Card title="Legend" className="w-fit">
        <div className="flex flex-wrap gap-x-4 gap-y-1.5 text-[11px] text-[#525252]">
          <span className="flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-sm" style={{ backgroundColor: 'var(--color-accent)' }} />Shift</span>
          {data?.days.flatMap((d) => d.shift?.activities ?? []).filter((a, i, arr) => arr.findIndex((x) => x.type === a.type) === i).map((a) => (
            <span key={a.type} className="flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-sm" style={{ backgroundColor: a.color }} />{a.type[0] + a.type.slice(1).toLowerCase()}</span>
          ))}
        </div>
      </Card>
    </div>
  );
};
