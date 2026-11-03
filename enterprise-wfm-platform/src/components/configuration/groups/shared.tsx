/**
 * Shared pieces for the WFM Groups screens: the shapes the gateway returns, plain-language labels, and a confirmation dialog that can ask for a reason.
 */
import React, { useEffect, useState } from 'react';
import { Banner, Btn, inputCls } from '../../forecasting/ui';

export type Site = { id: string; name: string; code: string; timezone: string; country: string };
export type GroupSummary = {
  queues: number; people: number; primaryPeople: number;
  forecast: { name: string; seq: number; kind: string; fromDay: string; toDay: string } | null;
  schedule: { name: string; periodStart: string; periodEnd: string; coverage: number | null } | null;
};
export type GroupImpact = { queues: number; people: number; primaryPeople: number; forecastVersions: number; publishedSchedules: number; scheduleVersions: number; rotationPatterns: number; historyIntervals: number };
export type MemberPage = {
  total: number; limit: number; offset: number;
  items: { id: string; employeeNumber: string; name: string; teamId: string | null; teamName: string | null; employmentType: string; status: string; primary: boolean }[];
  teams: { id: string; name: string; count: number }[];
};
export type HistoryRow = { id: string; at: string; actor: string; action: string; what: string; reason: string | null; summary: string | null; changes: { field: string; from: unknown; to: unknown }[] };
export type ImportResult = { committed: boolean; groups: { name: string; site: string | null; queues: number; line: number }[]; errors: { line: number; message: string }[]; errorCount: number };

export const DAYS_LONG = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

/** What a stored field is called on screen. */
export const FIELD_LABEL: Record<string, string> = {
  name: 'Name', description: 'Description', timezone: 'Time zone', status: 'Status', siteId: 'Site', managerName: 'Group manager', serviceLevelGoal: 'Service level goal (%)', serviceLevelThresholdSec: 'Answer within (s)',
  targetOccupancy: 'Occupancy cap (%)', shrinkagePercent: 'Shrinkage (%)', method: 'Staffing method', patienceSec: 'Customer patience (s)', blended: 'Blended pool', model: 'Forecast model',
  fteHoursWeek: 'Full-time hours', payWeekStart: 'Pay week starts on', code: 'Code',
};

/** The fields whose change moves staffing numbers or weekly hours: the same list the gateway asks for a reason on. */
export const IMPACT_LABEL: Record<string, string> = {
  serviceLevelGoal: 'service level goal', serviceLevelThresholdSec: 'answer-within time', targetOccupancy: 'occupancy cap', shrinkagePercent: 'shrinkage', method: 'staffing method',
  patienceSec: 'customer patience', blended: 'blended pool', fteHoursWeek: 'full-time hours', payWeekStart: 'pay week start', timezone: 'time zone',
};

export function showValue(field: string, v: unknown, sites: Site[]): string {
  if (v === null || v === undefined || v === '') return field === 'payWeekStart' ? 'Company setting' : field === 'siteId' ? 'No site' : 'none';
  if (field === 'payWeekStart') return DAYS_LONG[Number(v)] ?? String(v);
  if (field === 'siteId') return sites.find((s) => s.id === v)?.name ?? 'a site';
  if (field === 'method') return v === 'erlang_a' ? 'Erlang A' : 'Erlang C';
  if (typeof v === 'boolean') return v ? 'Yes' : 'No';
  return String(v);
}

export const when = (iso: string) => { const d = new Date(iso); return `${d.toLocaleDateString(undefined, { day: '2-digit', month: 'short', year: 'numeric' })} ${d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}`; };
export const dayRange = (a: string, b: string) => { const f = (s: string) => new Date(`${s}T00:00:00`).toLocaleDateString(undefined, { day: '2-digit', month: 'short' }); return `${f(a)} – ${f(b)}`; };

/** Debounce a fast-changing value, so typing in a search box does not ask the server on every key. */
export function useDebounced<T>(value: T, ms = 300): T {
  const [v, setV] = useState(value);
  useEffect(() => { const t = setTimeout(() => setV(value), ms); return () => clearTimeout(t); }, [value, ms]);
  return v;
}

/** A confirmation that replaces the browser's popup. With `reason`, it will not go on until the person has said why. */
export const Confirm: React.FC<{
  title: string; children?: React.ReactNode; confirmLabel: string; danger?: boolean; reason?: boolean; busy?: boolean; disabled?: boolean; error?: string;
  onConfirm: (reason: string) => void; onCancel: () => void;
}> = ({ title, children, confirmLabel, danger, reason, busy, disabled, error, onConfirm, onCancel }) => {
  const [why, setWhy] = useState('');
  useEffect(() => { const k = (e: KeyboardEvent) => e.key === 'Escape' && onCancel(); window.addEventListener('keydown', k); return () => window.removeEventListener('keydown', k); }, [onCancel]);
  const blocked = busy || disabled || (!!reason && why.trim().length < 3);
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4" role="dialog" aria-modal="true" aria-label={title} onMouseDown={(e) => e.target === e.currentTarget && onCancel()}>
      <div className="w-full max-w-md rounded-lg border border-[#E5E5E0] bg-white p-5 shadow-lg space-y-3 select-text">
        <h3 className="text-[15px] font-semibold text-[#171717]">{title}</h3>
        {children && <div className="text-[13px] text-[#525252] space-y-2">{children}</div>}
        {reason && (
          <label className="block text-[12px] font-semibold text-[#171717]">Why?
            <textarea autoFocus className={`${inputCls} mt-1 font-normal h-20`} value={why} onChange={(e) => setWhy(e.target.value)} placeholder="Recorded in the history with your name" />
          </label>
        )}
        {error && <Banner kind="err">{error}</Banner>}
        <div className="flex justify-end gap-2 pt-1">
          <Btn onClick={onCancel}>Cancel</Btn>
          <Btn variant="primary" className={danger ? '!bg-[#C84A4A] hover:!bg-[#b04040]' : ''} disabled={blocked} onClick={() => onConfirm(why.trim())}>{busy ? 'Working…' : confirmLabel}</Btn>
        </div>
      </div>
    </div>
  );
};

/** Section heading inside a card, in the page's small-caps style. */
export const Section: React.FC<{ title: string; right?: React.ReactNode; children: React.ReactNode }> = ({ title, right, children }) => (
  <div className="space-y-2">
    <div className="flex items-center justify-between gap-2">
      <div className="text-[11px] font-semibold text-[#6B6B6B] uppercase tracking-wider">{title}</div>
      {right && <div className="flex items-center gap-3 text-[12px]">{right}</div>}
    </div>
    {children}
  </div>
);

/** The plain link-style action used for "Add category" and the like. */
export const LinkBtn: React.FC<React.ButtonHTMLAttributes<HTMLButtonElement>> = ({ className = '', ...rest }) => (
  <button {...rest} className={`font-medium text-[#171717] underline underline-offset-2 disabled:opacity-50 ${className}`} />
);
