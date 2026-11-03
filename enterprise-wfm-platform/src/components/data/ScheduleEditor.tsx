/**
 * When a pulled connector runs: every N minutes, or once a day at a set time, optionally only on some weekdays, on the organisation's clock.
 * Used on the Data Feeds page (new connector form and the connector's schedule panel).
 */
import React from 'react';
import { Input, Select } from '../forecasting/ui';

export type ScheduleDraft = { scheduleMin: number | null; scheduleAt: string | null; scheduleDays: number[] | null };
export const NO_SCHEDULE: ScheduleDraft = { scheduleMin: null, scheduleAt: null, scheduleDays: null };
const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const REPEATS = [5, 15, 30, 60, 240, 480];
const WEEKDAYS = [1, 2, 3, 4, 5];

type Mode = 'none' | 'repeat' | 'daily';
const modeOf = (s: ScheduleDraft): Mode => (s.scheduleAt ? 'daily' : s.scheduleMin ? 'repeat' : 'none');

/** "Every 15 minutes on weekdays", "Every day at 02:00": the same wording the feeds table uses. */
export function describeSchedule(s: ScheduleDraft, tz?: string): string {
  if (!s.scheduleAt && !s.scheduleMin) return 'Not scheduled';
  const sorted = s.scheduleDays && s.scheduleDays.length < 7 ? [...s.scheduleDays].sort((a, b) => a - b) : null;
  const days = sorted ? (sorted.join() === '1,2,3,4,5' ? 'on weekdays' : sorted.join() === '6,7' ? 'on weekends' : `on ${sorted.map((d) => DAYS[d - 1]).join(', ')}`) : '';
  const n = s.scheduleMin ?? 0;
  const text = s.scheduleAt ? (days ? `At ${s.scheduleAt} ${days}` : `Every day at ${s.scheduleAt}`)
    : [n < 60 ? `Every ${n} minutes` : n === 60 ? 'Every hour' : n === 1440 ? 'Once a day' : `Every ${n / 60} hours`, days].filter(Boolean).join(' ');
  return tz ? `${text} (${tz})` : text;
}

export const ScheduleEditor: React.FC<{ value: ScheduleDraft; onChange: (v: ScheduleDraft) => void; disabled?: boolean; timezone?: string }> = ({ value, onChange, disabled, timezone }) => {
  const mode = modeOf(value);
  const days = value.scheduleDays ?? [1, 2, 3, 4, 5, 6, 7];
  const setMode = (m: Mode) => {
    if (m === 'none') onChange(NO_SCHEDULE);
    else if (m === 'repeat') onChange({ scheduleMin: value.scheduleMin && !value.scheduleAt ? value.scheduleMin : 15, scheduleAt: null, scheduleDays: value.scheduleDays });
    else onChange({ scheduleMin: 1440, scheduleAt: value.scheduleAt ?? '02:00', scheduleDays: value.scheduleDays });
  };
  const toggle = (d: number) => {
    const has = days.includes(d);
    const next = has ? days.filter((x) => x !== d) : [...days, d].sort((a, b) => a - b);
    if (!next.length) return;                                    // at least one day
    onChange({ ...value, scheduleDays: next.length === 7 ? null : next });
  };
  const preset = (d: number[] | null) => onChange({ ...value, scheduleDays: d });

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2 text-[12px]">
        <Select className="!w-auto" disabled={disabled} value={mode} onChange={(e) => setMode(e.target.value as Mode)}>
          <option value="none">Not scheduled</option>
          <option value="repeat">Repeat every…</option>
          <option value="daily">Every day at a set time</option>
        </Select>
        {mode === 'repeat' && (
          <Select className="!w-auto" disabled={disabled} value={value.scheduleMin ?? 15} onChange={(e) => onChange({ ...value, scheduleMin: Number(e.target.value) })}>
            {REPEATS.map((n) => <option key={n} value={n}>{n < 60 ? `${n} minutes` : n === 60 ? '1 hour' : `${n / 60} hours`}</option>)}
          </Select>
        )}
        {mode === 'daily' && (
          <>
            <Input type="time" className="!w-auto" disabled={disabled} value={value.scheduleAt ?? '02:00'} onChange={(e) => e.target.value && onChange({ ...value, scheduleAt: e.target.value })} />
            {timezone && <span className="text-[#6B6B6B]">{timezone} time</span>}
          </>
        )}
      </div>
      {mode !== 'none' && (
        <div className="flex flex-wrap items-center gap-1.5 text-[12px]">
          <span className="text-[#6B6B6B] mr-1">On</span>
          {DAYS.map((name, i) => {
            const on = days.includes(i + 1);
            return <button key={name} type="button" disabled={disabled} onClick={() => toggle(i + 1)}
              className={`px-2 py-1 rounded border text-[12px] font-semibold ${on ? 'bg-[#171717] text-white border-[#171717]' : 'bg-white text-[#6B6B6B] border-[#E5E5E0]'} disabled:opacity-50`}>{name}</button>;
          })}
          <button type="button" disabled={disabled} className="underline text-[#525252] ml-1" onClick={() => preset(WEEKDAYS)}>Weekdays</button>
          <button type="button" disabled={disabled} className="underline text-[#525252]" onClick={() => preset(null)}>Every day</button>
        </div>
      )}
    </div>
  );
};
