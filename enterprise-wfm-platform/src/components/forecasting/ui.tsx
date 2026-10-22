/**
 * Small building blocks in the platform's existing visual language (borders #E5E5E0, ink #171717, success #2F7D5A).
 */
import React from 'react';
import { Loader2 } from 'lucide-react';

export const Card: React.FC<{
  title?: React.ReactNode;
  sub?: React.ReactNode;
  actions?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}> = ({ title, sub, actions, children, className = '' }) => (
  <div className={`border border-[#E5E5E0] rounded-lg p-5 bg-[#FFFFFF] space-y-4 shadow-xs ${className}`}>
    {(title || actions) && (
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          {title && <h2 className="text-[16px] font-semibold text-[#171717]">{title}</h2>}
          {sub && <p className="text-[12px] text-[#737373] mt-0.5 max-w-3xl">{sub}</p>}
        </div>
        {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
      </div>
    )}
    {children}
  </div>
);

export const Kpi: React.FC<{ label: string; value: React.ReactNode; sub?: React.ReactNode; tone?: 'good' | 'warn' | 'bad' }> = ({ label, value, sub, tone }) => (
  <div className="p-4 bg-[#FAFAF8] rounded-lg border border-[#E5E5E0]">
    <div className="text-[11px] font-semibold text-[#737373] uppercase tracking-wider">{label}</div>
    <div className={`text-[24px] font-bold tabular-nums mt-1 font-mono ${tone === 'good' ? 'text-[#2F7D5A]' : tone === 'warn' ? 'text-[#B7791F]' : tone === 'bad' ? 'text-[#C84A4A]' : 'text-[#171717]'}`}>{value}</div>
    {sub && <div className="text-[12px] text-[#737373] mt-0.5">{sub}</div>}
  </div>
);

export const KpiRow: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <div className={`grid grid-cols-2 md:grid-cols-3 gap-4 ${React.Children.toArray(children).length >= 6 ? 'xl:grid-cols-6' : 'xl:grid-cols-5'}`}>{children}</div>
);

const PILL: Record<string, string> = {
  good: 'bg-[#EAF5EF] text-[#2F7D5A] border-[#2F7D5A]/20',
  warn: 'bg-[#FFF5DD] text-[#B7791F] border-[#B7791F]/20',
  bad: 'bg-[#FCEBEC] text-[#C84A4A] border-[#C84A4A]/20',
  info: 'bg-[#EDF3F8] text-[#4F6F8F] border-[#4F6F8F]/20',
  neutral: 'bg-[#FAFAF8] text-[#525252] border-[#E5E5E0]',
};
export const Pill: React.FC<{ tone?: keyof typeof PILL; children: React.ReactNode; title?: string }> = ({ tone = 'neutral', children, title }) => (
  <span title={title} className={`text-[11px] font-semibold px-2 py-0.5 rounded border whitespace-nowrap ${PILL[tone]}`}>{children}</span>
);

export const Banner: React.FC<{ kind: 'ok' | 'err' | 'info' | 'warn'; children: React.ReactNode; onClose?: () => void }> = ({ kind, children, onClose }) => (
  <div className={`flex items-start justify-between gap-3 text-[13px] rounded px-3.5 py-2.5 border ${
    kind === 'ok' ? PILL.good : kind === 'err' ? PILL.bad : kind === 'warn' ? PILL.warn : PILL.info}`}>
    <div>{children}</div>
    {onClose && <button onClick={onClose} className="text-[12px] underline shrink-0">Dismiss</button>}
  </div>
);

export const Empty: React.FC<{ title: string; children?: React.ReactNode }> = ({ title, children }) => (
  <div className="border-2 border-dashed border-[#E5E5E0] rounded-lg p-8 text-center bg-[#FAFAF8]">
    <div className="text-[14px] font-semibold text-[#171717]">{title}</div>
    {children && <div className="text-[12px] text-[#737373] mt-1">{children}</div>}
  </div>
);

export const Busy: React.FC<{ text?: string }> = ({ text = 'Working…' }) => (
  <span className="inline-flex items-center gap-2 text-[12px] text-[#737373] font-medium">
    <Loader2 className="w-3.5 h-3.5 animate-spin" />
    {text}
  </span>
);

export const Btn: React.FC<React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'secondary' | 'success' }> = ({ variant = 'secondary', className = '', ...rest }) => (
  <button
    {...rest}
    className={`px-3 py-1.5 rounded text-[12px] font-semibold shadow-xs flex items-center gap-1.5 transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${
      variant === 'primary' ? 'bg-[#171717] hover:bg-[#333333] text-white'
        : variant === 'success' ? 'bg-[#2F7D5A] hover:bg-[#276b4d] text-white'
          : 'border border-[#E5E5E0] bg-[#FFFFFF] hover:bg-[#FAFAF8] text-[#171717]'} ${className}`}
  />
);

export const Seg: React.FC<{ options: { id: string; label: string }[]; value: string; onChange: (id: string) => void }> = ({ options, value, onChange }) => (
  <div className="flex items-center text-[12px] border border-[#E5E5E0] rounded bg-[#FAFAF8] p-0.5">
    {options.map((o) => (
      <button key={o.id} onClick={() => onChange(o.id)}
        className={`px-2.5 py-1 rounded font-medium transition-colors ${value === o.id ? 'bg-[#171717] text-white' : 'text-[#525252]'}`}>{o.label}</button>
    ))}
  </div>
);

export const Field: React.FC<{ label: string; hint?: string; children: React.ReactNode }> = ({ label, hint, children }) => (
  <label className="block text-[12px] font-semibold text-[#171717]">
    {label}
    <div className="mt-1 font-normal">{children}</div>
    {hint && <div className="text-[12px] font-normal text-[#737373] mt-0.5">{hint}</div>}
  </label>
);

export const inputCls = 'w-full p-2 border border-[#E5E5E0] rounded text-[13px] bg-white disabled:bg-[#FAFAF8] disabled:text-[#737373]';

export const Select: React.FC<React.SelectHTMLAttributes<HTMLSelectElement>> = ({ className = '', ...rest }) => (
  <select {...rest} className={`${inputCls} ${className}`} />
);

export const Input: React.FC<React.InputHTMLAttributes<HTMLInputElement>> = ({ className = '', ...rest }) => (
  <input {...rest} className={`${inputCls} ${className}`} />
);

export const Table: React.FC<{ head: React.ReactNode[]; children: React.ReactNode; right?: number[] }> = ({ head, children, right = [] }) => (
  <div className="overflow-x-auto border border-[#E5E5E0] rounded-lg">
    <table className="w-full text-left text-[13px]">
      <thead className="bg-[#FAFAF8] text-[#737373] text-[11px] uppercase tracking-wider border-b border-[#E5E5E0]">
        <tr>{head.map((h, i) => <th key={i} className={`p-3 ${right.includes(i) ? 'text-right' : ''}`}>{h}</th>)}</tr>
      </thead>
      <tbody className="divide-y divide-[#E5E5E0] text-[#171717]">{children}</tbody>
    </table>
  </div>
);

export const PageHeader: React.FC<{ title: string; badge?: React.ReactNode; sub?: string; actions?: React.ReactNode }> = ({ title, badge, sub, actions }) => (
  <div className="flex flex-wrap items-center justify-between gap-4 border-b border-[#E5E5E0] pb-4">
    <div>
      <div className="flex items-center gap-2">
        <h1 className="text-[22px] font-semibold text-[#171717]">{title}</h1>
        {badge}
      </div>
      {sub && <p className="text-[13px] text-[#737373] mt-0.5 max-w-3xl">{sub}</p>}
    </div>
    {actions && <div className="flex items-center gap-2.5 flex-wrap">{actions}</div>}
  </div>
);
