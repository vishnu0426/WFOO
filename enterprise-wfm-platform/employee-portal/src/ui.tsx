/** Small shared UI kit for the employee portal, styled to match the admin web app's palette (ink #171717, muted #737373, borders #E5E5E0). */
import React, { useEffect, useState } from 'react';
import { api, ApiError } from './api';

/** Loads `path` on mount and whenever `deps` change; `reload()` re-runs the same fetch on demand (e.g. after an action). */
export function useLoad<T>(path: string | null, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!path) { setData(null); return; }
    let live = true;
    setLoading(true);
    api<T>(path).then((d) => { if (live) { setData(d); setError(''); } }).catch((e) => { if (live) setError(e instanceof ApiError ? e.message : 'Something went wrong'); }).finally(() => live && setLoading(false));
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, tick, ...deps]);
  return { data, error, loading, reload: () => setTick((t) => t + 1) };
}

export const Btn: React.FC<React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'danger' }> = ({ variant, className = '', ...rest }) => (
  <button
    {...rest}
    className={`inline-flex items-center justify-center gap-1.5 rounded-md px-3.5 py-2 text-[13px] font-semibold transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${
      variant === 'primary' ? 'bg-accent text-white hover:bg-accent-dark' : variant === 'danger' ? 'bg-[#C84A4A] text-white hover:bg-[#b53f3f]' : 'bg-white border border-[#E5E5E0] text-[#171717] hover:bg-[#FAFAF8]'
    } ${className}`}
  />
);

export const Card: React.FC<{ title?: React.ReactNode; sub?: React.ReactNode; actions?: React.ReactNode; className?: string; style?: React.CSSProperties; children: React.ReactNode }> = ({ title, sub, actions, className = '', style, children }) => (
  <div className={`bg-white border border-[#E5E5E0] rounded-lg p-4 space-y-3 ${className}`} style={style}>
    {(title || actions) && (
      <div className="flex items-start justify-between gap-3">
        <div>
          {title && <h2 className="text-[15px] font-semibold text-[#171717]">{title}</h2>}
          {sub && <p className="text-[12px] text-[#737373] mt-0.5">{sub}</p>}
        </div>
        {actions}
      </div>
    )}
    {children}
  </div>
);

const PILL: Record<string, string> = {
  good: 'bg-[#EAF5EF] text-[#2F7D5A] border-[#2F7D5A]/20', bad: 'bg-[#FCEBEC] text-[#C84A4A] border-[#C84A4A]/20',
  warn: 'bg-[#FFF5DD] text-[#B7791F] border-[#B7791F]/20', neutral: 'bg-[#F5F5F2] text-[#525252] border-[#E5E5E0]', info: 'bg-[#EDF3F8] text-[#4F6F8F] border-[#4F6F8F]/20',
};
export const Pill: React.FC<{ tone?: keyof typeof PILL; children: React.ReactNode }> = ({ tone = 'neutral', children }) => (
  <span className={`inline-block text-[11px] font-semibold px-2 py-0.5 rounded border whitespace-nowrap ${PILL[tone]}`}>{children}</span>
);

export const Field: React.FC<{ label: string; hint?: string; children: React.ReactNode }> = ({ label, hint, children }) => (
  <label className="block text-[12px] font-semibold text-[#171717]">
    {label}
    <div className="mt-1 font-normal">{children}</div>
    {hint && <div className="text-[11px] font-normal text-[#737373] mt-0.5">{hint}</div>}
  </label>
);

const fieldCls = 'w-full p-2 border border-[#E5E5E0] rounded text-[13px] bg-white disabled:bg-[#FAFAF8] disabled:text-[#737373]';
export const Input: React.FC<React.InputHTMLAttributes<HTMLInputElement>> = ({ className = '', ...rest }) => <input {...rest} className={`${fieldCls} ${className}`} />;
export const Select: React.FC<React.SelectHTMLAttributes<HTMLSelectElement>> = ({ className = '', ...rest }) => <select {...rest} className={`${fieldCls} ${className}`} />;
export const Textarea: React.FC<React.TextareaHTMLAttributes<HTMLTextAreaElement>> = ({ className = '', ...rest }) => <textarea {...rest} className={`${fieldCls} ${className}`} />;

export const Banner: React.FC<{ kind: 'err' | 'warn' | 'ok'; children: React.ReactNode; onClose?: () => void }> = ({ kind, children, onClose }) => (
  <div className={`flex items-start justify-between gap-3 text-[13px] rounded px-3.5 py-2.5 border ${kind === 'err' ? PILL.bad : kind === 'warn' ? PILL.warn : PILL.good}`}>
    <div>{children}</div>
    {onClose && <button onClick={onClose} className="text-[11px] underline shrink-0">Dismiss</button>}
  </div>
);

export const Modal: React.FC<{ title?: React.ReactNode; onClose: () => void; children: React.ReactNode }> = ({ title, onClose, children }) => {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
  <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4" onClick={onClose}>
    <div className="bg-white rounded-lg shadow-xl max-w-md w-full max-h-[85vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
      {title && (
        <div className="flex items-center justify-between gap-3 px-5 py-3.5 border-b border-[#E5E5E0]">
          <h2 className="text-[15px] font-semibold text-[#171717]">{title}</h2>
          <button onClick={onClose} aria-label="Close" className="text-[#A3A3A3] hover:text-[#171717] text-[20px] leading-none">&times;</button>
        </div>
      )}
      <div className="p-5">{children}</div>
    </div>
  </div>
  );
};

export const Busy: React.FC<{ text?: string }> = ({ text = 'Loading…' }) => <div className="text-[13px] text-[#737373] py-6 text-center">{text}</div>;
export const Empty: React.FC<{ title: string; children?: React.ReactNode }> = ({ title, children }) => (
  <div className="text-center py-8 space-y-1">
    <div className="text-[13px] font-semibold text-[#171717]">{title}</div>
    {children && <div className="text-[12px] text-[#737373] max-w-sm mx-auto">{children}</div>}
  </div>
);

/** A colored dashboard number, the enterprise-dashboard pattern for "the thing you'd check first" (hours this week, balances, counts). */
export const Stat: React.FC<{ label: string; value: React.ReactNode; sub?: string; color?: string }> = ({ label, value, sub, color = 'var(--color-accent)' }) => (
  <div className="bg-white border border-[#E5E5E0] rounded-lg p-4" style={{ borderTop: `3px solid ${color}` }}>
    <div className="text-[11px] font-semibold text-[#737373] uppercase tracking-wider">{label}</div>
    <div className="text-[22px] font-bold mt-1" style={{ color }}>{value}</div>
    {sub && <div className="text-[11px] text-[#737373] mt-0.5">{sub}</div>}
  </div>
);

/** Activity colors are admin-configured and often light pastels (e.g. WORK defaults to #DCEBFA) -- white text on those
    is nearly invisible. Picks black or white by WCAG relative luminance instead of assuming white always works. */
export const contrastText = (bgHex: string): string => {
  const hex = bgHex.replace('#', '');
  if (hex.length !== 6) return '#171717';
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const lin = (c: number) => (c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
  const luminance = 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
  return luminance > 0.55 ? '#171717' : '#FFFFFF';
};

export const hm = (s: string) => s.slice(0, 5);
export const dayLabel = (iso: string) => new Date(`${iso}T00:00:00`).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });

const pad2 = (n: number) => String(n).padStart(2, '0');
/** Today as YYYY-MM-DD in the browser's own calendar -- NOT `new Date().toISOString()`, which reports the UTC date and
    is a day behind every morning in any timezone ahead of UTC (e.g. IST before ~5:30am). */
export const todayIso = () => { const d = new Date(); return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`; };
/** Adds `n` days to an ISO date, doing the arithmetic entirely in UTC so it can't drift across a timezone's local
    midnight -- `new Date(iso + 'T00:00:00')` is LOCAL midnight, and feeding that through `.toISOString()` (UTC) shifts
    the result back a day in any positive-UTC-offset timezone. Parsing with a trailing `Z` keeps the whole round-trip in UTC. */
export const addDays = (iso: string, n: number) => { const d = new Date(`${iso}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
