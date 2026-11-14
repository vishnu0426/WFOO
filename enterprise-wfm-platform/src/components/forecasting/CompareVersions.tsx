/**
 * One version of a forecast set against another, day by day: a headline in plain words, the figures side by side, and the two daily volumes on one chart.
 * `with` is the baseline (usually the live version); every difference is "this version minus the baseline".
 */
import React, { useEffect, useRef } from 'react';
import { CartesianGrid, ComposedChart, Legend, Line, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { X } from 'lucide-react';
import { dayName, int, MODEL_LABEL, STATUS_LABEL, type VersionMeta } from '../../services/api';
import { horizonLabel } from '../../services/forecastLineage';
import { useApi } from './hooks';
import { Waiting } from '../common/loading';

type Side = { a: number | null; b: number | null };
export interface CompareResp {
  base: VersionMeta & { model?: string | null; wape?: number | null }; version: VersionMeta & { model?: string | null; wape?: number | null };
  adjusted: { base: number; version: number };
  overlap: { from: string; to: string; days: number } | null; onlyA: number; onlyB: number;
  summary: { volume: Side & { deltaPct: number | null }; avgAht: Side; peakRequired: Side; agentHours: Side; busiestDay: { a: { day: string; volume: number } | null; b: { day: string; volume: number } | null } };
  biggest: { day: string; delta: number; deltaPct: number | null } | null;
  rows: { day: string; a: number | null; b: number | null; delta: number | null; deltaPct: number | null }[];
}

const signed = (n: number, d = 0) => `${n > 0 ? '+' : n < 0 ? '−' : ''}${Math.abs(n).toLocaleString('en', { maximumFractionDigits: d })}`;
const label = (v: { seq: number; status: string }) => `v${v.seq}${v.status === 'PUBLISHED' ? ' (live)' : ''}`;
const modelName = (m?: string | null) => (m ? (m === 'mixed' ? 'Mixed by queue' : MODEL_LABEL[m] ?? m) : '–');

/** The sentence at the top: what changes, by how much, and where it is biggest. */
export function headline(r: CompareResp): string {
  const me = label(r.version), base = label(r.base);
  if (!r.overlap) return `${me} and ${base} share no days, so there is nothing to compare day by day.`;
  const s = r.summary.volume, diff = (s.b ?? 0) - (s.a ?? 0);
  const days = `${r.overlap.days} day${r.overlap.days === 1 ? '' : 's'} they share`;
  const where = r.biggest ? ` They differ most on ${dayName(r.biggest.day)} (${signed(r.biggest.delta)} contacts${r.biggest.deltaPct !== null ? `, ${signed(r.biggest.deltaPct, 1)}%` : ''}).` : '';
  if (diff === 0 && !r.biggest) return `${me} and ${base} give the same volume on every one of the ${days}.`;
  if (s.deltaPct === null) return `${me} is ${signed(diff)} contacts against ${base} over the ${days}.${where}`;
  return `${me} is ${Math.abs(s.deltaPct).toLocaleString('en', { maximumFractionDigits: 1 })}% ${diff >= 0 ? 'higher' : 'lower'} than ${base} over the ${days} (${signed(diff)} contacts).${where}`;
}

export const CompareDrawer: React.FC<{ version: VersionMeta; members: VersionMeta[]; baseId: string; onBase: (id: string) => void; onClose: () => void }> = ({ version, members, baseId, onBase, onClose }) => {
  const res = useApi<CompareResp>(`/forecast/versions/${version.id}/compare?with=${baseId}`, [version.rev]);
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => { closeRef.current?.focus(); }, []);
  useEffect(() => { const k = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); }; window.addEventListener('keydown', k); return () => window.removeEventListener('keydown', k); }, [onClose]);
  const others = members.filter((m) => m.id !== version.id);
  const r = res.data;
  const row = (name: string, side: Side, fmt: (n: number) => string, unit = '') => (
    <tr key={name} className="border-t">
      <td className="px-3 py-2 text-muted-foreground">{name}</td>
      <td className="px-3 py-2 num">{side.a === null ? '–' : fmt(side.a)}</td>
      <td className="px-3 py-2 num font-medium">{side.b === null ? '–' : fmt(side.b)}</td>
      <td className="px-3 py-2 num">{side.a === null || side.b === null ? '–' : `${signed(side.b - side.a, 1)}${unit}`}</td>
    </tr>
  );
  // the overlay is the dialog: the app's Escape handler leaves role=dialog layers to themselves
  return (
    <div role="dialog" aria-modal="true" aria-label={`Compare v${version.seq}`} className="fixed inset-0 z-40 flex justify-end bg-black/20" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <aside className="h-full w-full max-w-3xl space-y-4 overflow-y-auto border-l bg-background p-5 shadow-xl select-text">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="text-[16px] font-semibold">Compare v{version.seq} with another version</h2>
            <p className="text-[12px] text-muted-foreground">{version.name} · {STATUS_LABEL[version.status]} · {horizonLabel(version.fromDay, version.toDay)}</p>
          </div>
          <button ref={closeRef} onClick={onClose} aria-label="Close" className="rounded p-1 hover:bg-surface"><X className="size-4" /></button>
        </div>

        <label className="flex items-center gap-2 text-[13px]">
          <span className="text-subtle-foreground">Compare with</span>
          <select value={baseId} onChange={(e) => onBase(e.target.value)} aria-label="Compare with" className="h-9 max-w-full rounded-md border bg-background px-2">
            {others.map((m) => <option key={m.id} value={m.id}>{`v${m.seq} · ${STATUS_LABEL[m.status]}${m.status === 'PUBLISHED' ? ' (live)' : ''} · ${m.name}`}</option>)}
          </select>
        </label>

        {res.error && !r && <p className="text-[13px] text-critical" role="alert">{res.error}</p>}
        {!r && !res.error && <Waiting what="the comparison" shape="table" reload={res.reload} />}
        {r && (
          <>
            <p className="rounded-lg border bg-surface px-4 py-3 text-[14px]" role="status" data-testid="compare-headline">{headline(r)}</p>
            {r.overlap && (r.onlyA > 0 || r.onlyB > 0) && (
              <p className="text-[12px] text-muted-foreground">Totals count only the {r.overlap.days} days both cover ({horizonLabel(r.overlap.from, r.overlap.to)}).{r.onlyA > 0 ? ` ${label(r.base)} has ${r.onlyA} more day${r.onlyA === 1 ? '' : 's'}.` : ''}{r.onlyB > 0 ? ` ${label(r.version)} has ${r.onlyB} more day${r.onlyB === 1 ? '' : 's'}.` : ''}</p>)}

            <div className="overflow-hidden rounded-lg border">
              <table className="w-full text-[13px]">
                <thead className="bg-surface text-left text-[12px] text-subtle-foreground">
                  <tr><th className="px-3 py-2 font-medium" /><th className="px-3 py-2 font-medium">{label(r.base)}</th><th className="px-3 py-2 font-medium">{label(r.version)}</th><th className="px-3 py-2 font-medium">Difference</th></tr>
                </thead>
                <tbody>
                  {row('Contacts (shared days)', r.summary.volume, int)}
                  <tr className="border-t"><td className="px-3 py-2 text-muted-foreground">Busiest day</td><td className="px-3 py-2 num">{r.summary.busiestDay.a ? `${dayName(r.summary.busiestDay.a.day)} · ${int(r.summary.busiestDay.a.volume)}` : '–'}</td><td className="px-3 py-2 num font-medium">{r.summary.busiestDay.b ? `${dayName(r.summary.busiestDay.b.day)} · ${int(r.summary.busiestDay.b.volume)}` : '–'}</td><td className="px-3 py-2 num">–</td></tr>
                  {row('Average handle time', r.summary.avgAht, (n) => `${n} s`, ' s')}
                  {row('Peak agents needed', r.summary.peakRequired, String)}
                  {row('Agent hours', r.summary.agentHours, (n) => int(n))}
                  <tr className="border-t"><td className="px-3 py-2 text-muted-foreground">Adjusted intervals</td><td className="px-3 py-2 num">{int(r.adjusted.base)}</td><td className="px-3 py-2 num font-medium">{int(r.adjusted.version)}</td><td className="px-3 py-2 num">{signed(r.adjusted.version - r.adjusted.base)}</td></tr>
                  <tr className="border-t"><td className="px-3 py-2 text-muted-foreground">Model</td><td className="px-3 py-2">{modelName(r.base.model)}</td><td className="px-3 py-2 font-medium">{modelName(r.version.model)}</td><td className="px-3 py-2">{r.base.model === r.version.model ? 'Same' : 'Different'}</td></tr>
                  <tr className="border-t"><td className="px-3 py-2 text-muted-foreground">Typical daily miss (WAPE)</td><td className="px-3 py-2 num">{r.base.wape == null ? '–' : `${(r.base.wape * 100).toFixed(1)}%`}</td><td className="px-3 py-2 num font-medium">{r.version.wape == null ? '–' : `${(r.version.wape * 100).toFixed(1)}%`}</td><td className="px-3 py-2 num">–</td></tr>
                </tbody>
              </table>
            </div>

            {r.rows.length > 1 && (
              <div className="h-60" aria-label="Daily volume of both versions">
                <ResponsiveContainer width="100%" height="100%">
                  <ComposedChart data={r.rows.map((x) => ({ ...x, label: new Date(`${x.day}T00:00:00`).toLocaleDateString('en', { month: 'short', day: 'numeric' }) }))} margin={{ top: 8, right: 16, bottom: 0, left: 0 }}>
                    <CartesianGrid vertical={false} stroke="var(--color-border)" />
                    <XAxis dataKey="label" tickLine={false} axisLine={false} fontSize={12} minTickGap={24} />
                    <YAxis tickLine={false} axisLine={false} fontSize={12} width={48} />
                    <Tooltip formatter={(v: any) => (typeof v === 'number' ? int(v) : v)} />
                    <Legend />
                    <Line name={label(r.base)} dataKey="a" stroke="var(--color-border-strong)" strokeWidth={2} dot={false} isAnimationActive={false} />
                    <Line name={label(r.version)} dataKey="b" stroke="var(--color-chart-2)" strokeWidth={2} dot={false} isAnimationActive={false} />
                  </ComposedChart>
                </ResponsiveContainer>
              </div>)}

            <details className="rounded-lg border">
              <summary className="cursor-pointer px-3 py-2 text-[13px] font-medium">Day by day ({r.rows.length} days)</summary>
              <div className="max-h-72 overflow-auto">
                <table className="w-full text-[13px]">
                  <thead className="sticky top-0 bg-surface text-left text-[12px] text-subtle-foreground"><tr><th className="px-3 py-2 font-medium">Day</th><th className="px-3 py-2 font-medium">{label(r.base)}</th><th className="px-3 py-2 font-medium">{label(r.version)}</th><th className="px-3 py-2 font-medium">Difference</th></tr></thead>
                  <tbody>
                    {r.rows.map((x) => (
                      <tr key={x.day} className="border-t"><td className="px-3 py-1.5">{dayName(x.day)}</td><td className="px-3 py-1.5 num">{x.a === null ? '–' : int(x.a)}</td><td className="px-3 py-1.5 num">{x.b === null ? '–' : int(x.b)}</td>
                        <td className={`px-3 py-1.5 num ${x.delta === null || x.delta === 0 ? 'text-subtle-foreground' : Math.abs(x.deltaPct ?? 0) >= 10 ? 'text-critical' : ''}`}>{x.delta === null ? '–' : `${signed(x.delta)}${x.deltaPct === null ? '' : ` (${signed(x.deltaPct, 1)}%)`}`}</td></tr>))}
                  </tbody>
                </table>
              </div>
            </details>
          </>)}
      </aside>
    </div>
  );
};
