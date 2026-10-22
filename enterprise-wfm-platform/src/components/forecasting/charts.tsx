/**
 * Dependency-free SVG charts: multi-series line / step / bar / area chart with an optional shaded band, a crosshair with a marker on
 * every series, a tooltip with colour swatches, click-to-pin (for "explain this point"), and a legend that switches series on and off.
 * Plus a day x hour heatmap. One palette (CHART) is used across the forecasting, intraday and scheduling screens.
 */
import React, { useId, useMemo, useState } from 'react';

/** The design-token palette (same values as the reference): hue and line style both differ (solid, dashed, step, bars). */
export const CHART = {
  forecast: '#4F6F8F',            // chart-2 in the design tokens: expected volume
  range: '#EDF3F8',               // info-bg: the confidence band
  actual: '#171717',              // foreground: what really happened
  reforecast: '#7A62A8',          // forecast corrected with today's actuals
  agents: '#C84A4A',              // critical: agents required
  scheduled: '#171717',           // people scheduled
  baseline: '#DBDBD6',            // border-strong: reference / previous
  bars: '#E5E5E0',                // quiet bars behind the lines (last week, scheduled)
  success: '#2F7D5A',
  bad: '#C84A4A',
} as const;

export type ChartSeries = {
  name: string;
  color: string;
  values: (number | null)[];
  kind?: 'line' | 'step' | 'bar' | 'dashed';
  axis?: 'left' | 'right';
  width?: number;
  area?: boolean;                 // soft fill under the line
};

const niceMax = (v: number) => {
  if (v <= 0) return 1;
  const e = Math.pow(10, Math.floor(Math.log10(v)));
  const f = v / e;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * e;
};

export const LineChart: React.FC<{
  labels: string[];
  series: ChartSeries[];
  band?: { lo: (number | null)[]; hi: (number | null)[]; color?: string; name?: string };
  markers?: boolean[];
  height?: number;
  leftLabel?: string;
  rightLabel?: string;
  /** extra lines shown under the standard series values in the hover tooltip */
  tooltip?: (i: number) => React.ReactNode;
  xEvery?: number;
  /** clicking a point pins it and reports its index (used by "explain this point") */
  onPointClick?: (i: number) => void;
  selected?: number | null;
  /** drawing width in chart units: about 1000 for full-width charts, about 460 for a narrow side panel so the text stays readable */
  width?: number;
  /** 'none' hides the built-in legend when the page draws its own */
  legend?: 'below' | 'none';
}> = ({ labels, series: all, band, markers, height = 300, leftLabel, rightLabel, tooltip, xEvery, onPointClick, selected = null, width = 1000, legend = 'below' }) => {
  const uid = useId().replace(/:/g, '');
  const [hover, setHover] = useState<number | null>(null);
  const [off, setOff] = useState<string[]>([]);
  const series = all.filter((s) => !off.includes(s.name));
  const W = width, H = height, L = 52, R = all.some((s) => s.axis === 'right') ? 52 : 16, T = 26, B = 30;
  const n = labels.length;
  const hasBars = series.some((s) => s.kind === 'bar');

  const { maxL, maxR } = useMemo(() => {
    let l = 0, r = 0;
    for (const s of series) {
      const m = Math.max(0, ...s.values.map((v) => v ?? 0));
      if (s.axis === 'right') r = Math.max(r, m); else l = Math.max(l, m);
    }
    if (band) l = Math.max(l, ...band.hi.map((v) => v ?? 0));
    return { maxL: niceMax(l), maxR: niceMax(r) };
  }, [series, band]);

  if (n === 0) return null;
  const slot = (W - L - R) / n;
  const x = (i: number) => L + (hasBars ? slot * (i + 0.5) : n === 1 ? (W - L - R) / 2 : ((W - L - R) * i) / (n - 1));
  const y = (v: number, axis: 'left' | 'right' = 'left') => T + (H - T - B) * (1 - v / (axis === 'right' ? maxR : maxL));
  const base = H - B;
  const every = xEvery ?? Math.max(1, Math.ceil(n / 12));

  const path = (s: ChartSeries) => {
    let d = '';
    let prevY: number | null = null;
    s.values.forEach((v, i) => {
      if (v === null) { prevY = null; return; }
      const px = x(i), py = y(v, s.axis);
      if (prevY === null) d += `M${px},${py}`;
      else d += s.kind === 'step' ? `H${px}V${py}` : `L${px},${py}`;
      prevY = py;
    });
    return d;
  };
  const areaPath = (s: ChartSeries) => {
    const idx = s.values.map((_, i) => i).filter((i) => s.values[i] !== null);
    return idx.length ? `${path(s)}L${x(idx.at(-1)!)},${base}L${x(idx[0])},${base}Z` : '';
  };

  const bandPath = band ? (() => {
    const idx = band.hi.map((_, i) => i).filter((i) => band.hi[i] !== null && band.lo[i] !== null);
    if (!idx.length) return '';
    return `M${idx.map((i) => `${x(i)},${y(band.hi[i] as number)}`).join('L')}L${[...idx].reverse().map((i) => `${x(i)},${y(band.lo[i] as number)}`).join('L')}Z`;
  })() : '';

  const ticks = [0, 0.25, 0.5, 0.75, 1];
  const at = hover ?? selected;                                   // the index the crosshair and markers follow
  const flip = hover !== null && x(hover) / W > 0.6;               // keep the tooltip on screen
  const bandColor = band?.color ?? CHART.range;
  return (
    <div className="relative">
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ height, cursor: onPointClick ? 'pointer' : undefined }} onMouseLeave={() => setHover(null)}
        onClick={() => { if (onPointClick && hover !== null) onPointClick(hover); }}
        onMouseMove={(e) => {
          const r = (e.currentTarget as SVGSVGElement).getBoundingClientRect();
          const px = ((e.clientX - r.left) / r.width) * W;
          const i = hasBars ? Math.floor((px - L) / slot) : Math.round(((px - L) / (W - L - R)) * (n - 1));
          setHover(i >= 0 && i < n ? i : null);
        }}>
        <defs>
          {series.map((s, k) => s.area && (
            <linearGradient key={s.name} id={`${uid}-a${k}`} x1="0" x2="0" y1="0" y2="1"><stop offset="0%" stopColor={s.color} stopOpacity={0.28} /><stop offset="100%" stopColor={s.color} stopOpacity={0.02} /></linearGradient>
          ))}
        </defs>
        {ticks.map((t) => (
          <g key={t}>
            <line x1={L} x2={W - R} y1={T + (H - T - B) * (1 - t)} y2={T + (H - T - B) * (1 - t)} stroke="#E8E8E3" strokeDasharray={t === 0 ? undefined : '2 4'} />
            <text x={L - 8} y={T + (H - T - B) * (1 - t) + 4} textAnchor="end" fontSize="11" fill="#737373">{Math.round(maxL * t).toLocaleString()}</text>
            {series.some((s) => s.axis === 'right') && <text x={W - R + 8} y={T + (H - T - B) * (1 - t) + 4} fontSize="11" fill="#737373">{Math.round(maxR * t)}</text>}
          </g>
        ))}
        {leftLabel && <text x={L} y={10} fontSize="11" fill="#737373" textAnchor="start" transform="translate(-40,0)">{leftLabel}</text>}
        {rightLabel && <text x={W - R} y={10} fontSize="11" fill="#737373" textAnchor="end" transform="translate(40,0)">{rightLabel}</text>}
        {labels.map((lb, i) => i % every === 0 && (
          <text key={i} x={x(i)} y={H - 10} fontSize="10.5" fill="#737373" textAnchor="middle">{lb}</text>
        ))}
        {bandPath && <path d={bandPath} fill={bandColor} />}
        {series.map((s, k) => s.area && s.kind !== 'bar' && <path key={`a-${s.name}`} d={areaPath(s)} fill={`url(#${uid}-a${k})`} />)}
        {series.filter((s) => s.kind === 'bar').map((s) => s.values.map((v, i) => v !== null && (
          <rect key={`${s.name}-${i}`} x={x(i) - slot * 0.36} width={slot * 0.72} y={y(v, s.axis)} height={Math.max(0, base - y(v, s.axis))} fill={s.color} fillOpacity={at === i ? 1 : 0.85} rx={2} />
        )))}
        {series.filter((s) => s.kind !== 'bar').map((s) => (
          <path key={s.name} d={path(s)} fill="none" stroke={s.color} strokeWidth={s.width ?? 2.4} strokeDasharray={s.kind === 'dashed' ? '6 5' : undefined} strokeLinejoin="round" />
        ))}
        {markers?.map((m, i) => m && series[0]?.values[i] != null && (
          <circle key={i} cx={x(i)} cy={y(series[0].values[i] as number, series[0].axis)} r={4.5} fill="#B7791F" stroke="#fff" strokeWidth={1.5} />
        ))}
        {selected !== null && selected !== hover && <line x1={x(selected)} x2={x(selected)} y1={T} y2={base} stroke="#171717" strokeWidth={1.5} strokeDasharray="4 3" />}
        {at !== null && (
          <g>
            <line x1={x(at)} x2={x(at)} y1={T} y2={base} stroke="#171717" strokeOpacity=".3" />
            {series.filter((s) => s.kind !== 'bar' && s.values[at] != null).map((s) => (
              <circle key={s.name} cx={x(at)} cy={y(s.values[at] as number, s.axis)} r={5} fill="#fff" stroke={s.color} strokeWidth={2.5} />
            ))}
          </g>
        )}
      </svg>
      {hover !== null && (
        <div className="absolute top-2 pointer-events-none bg-white border border-[#E5E5E0] rounded-md shadow-lg px-3 py-2 text-[12px] z-10 min-w-[190px] max-w-[300px]"
          style={flip ? { right: `${Math.max(2, 100 - (x(hover) / W) * 100 + 1)}%` } : { left: `${Math.min(80, Math.max(2, (x(hover) / W) * 100 + 1))}%` }}>
          <div className="font-semibold text-[#171717] mb-1">{labels[hover]}</div>
          {series.map((s) => s.values[hover] != null && (
            <div key={s.name} className="flex items-center justify-between gap-4 text-[#525252]">
              <span className="flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ background: s.color }} />{s.name}</span>
              <b className="tabular-nums font-medium text-[#171717]">{Number(s.values[hover]).toLocaleString(undefined, { maximumFractionDigits: 1 })}</b>
            </div>
          ))}
          {band && band.lo[hover] != null && (
            <div className="flex items-center justify-between gap-4 text-[#525252]">
              <span className="flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-sm shrink-0" style={{ background: bandColor, outline: '1px solid rgba(0,0,0,.12)' }} />{band.name ?? 'Likely range'}</span>
              <b className="tabular-nums font-medium text-[#171717]">{Math.round(band.lo[hover] as number)} to {Math.round(band.hi[hover] as number)}</b>
            </div>
          )}
          {tooltip && <div className="mt-1 pt-1 border-t border-[#EEEEE9]">{tooltip(hover)}</div>}
          {onPointClick && <div className="mt-1 text-[11px] text-[#4F6F8F]">Click to see how this is worked out</div>}
        </div>
      )}
      {legend === 'below' && <div className="flex flex-wrap items-center gap-2 text-[11px] text-[#525252] mt-1 pl-1">
        {all.map((s) => {
          const hidden = off.includes(s.name);
          return (
            <button key={s.name} type="button" title={hidden ? 'Show' : 'Hide'} onClick={() => setOff(hidden ? off.filter((x) => x !== s.name) : [...off, s.name])}
              className={`flex items-center gap-1.5 px-1.5 py-0.5 rounded hover:bg-[#F3F3EF] ${hidden ? 'opacity-40 line-through' : ''}`}>
              <span className="inline-block rounded-sm" style={{ background: s.kind === 'dashed' ? 'transparent' : s.color, borderTop: s.kind === 'dashed' ? `2px dashed ${s.color}` : undefined, width: 14, height: s.kind === 'bar' ? 9 : 3 }} />{s.name}
            </button>
          );
        })}
        {band && <span className="flex items-center gap-1.5 px-1.5"><span className="w-3.5 h-2.5 rounded-sm inline-block" style={{ background: bandColor, outline: '1px solid rgba(0,0,0,.1)' }} />{band.name ?? 'Likely range'}</span>}
      </div>}
    </div>
  );
};

/** Day x hour grid coloured green / amber / red by how far off the forecast was. */
export const AccuracyGrid: React.FC<{ cells: { day: string; hour: number; actual: number; forecast: number }[]; dayLabel: (d: string) => string }> = ({ cells, dayLabel }) => {
  const days = [...new Set(cells.map((c) => c.day))].sort();
  const hours: number[] = Array.from(new Set<number>(cells.filter((c) => c.actual > 0).map((c) => c.hour))).sort((a, b) => a - b);
  const byKey = new Map<string, (typeof cells)[number]>(cells.map((c) => [`${c.day}|${c.hour}`, c] as [string, (typeof cells)[number]]));
  const tone = (miss: number) => (miss < 0.08 ? 'bg-[#EAF5EF] text-[#2F7D5A]' : miss < 0.15 ? 'bg-[#FFF5DD] text-[#B7791F]' : 'bg-[#FCEBEC] text-[#C84A4A]');
  return (
    <div className="border border-[#E5E5E0] rounded-lg overflow-x-auto">
      <table className="w-full text-center text-[11.5px] border-collapse">
        <thead>
          <tr className="bg-[#FAFAF8] border-b border-[#E5E5E0]">
            <th className="p-2 text-left text-[#737373] font-semibold sticky left-0 bg-[#FAFAF8]">Day</th>
            {hours.map((h) => <th key={h} className="p-2 font-mono text-[#525252] font-semibold">{String(h).padStart(2, '0')}</th>)}
          </tr>
        </thead>
        <tbody className="divide-y divide-[#E5E5E0]">
          {days.map((d) => (
            <tr key={d}>
              <td className="p-2 text-left font-semibold text-[#171717] whitespace-nowrap sticky left-0 bg-white">{dayLabel(d)}</td>
              {hours.map((h) => {
                const c = byKey.get(`${d}|${h}`);
                if (!c || c.actual <= 0) return <td key={h} className="p-1.5 text-[#A3A3A3]">–</td>;
                const miss = Math.abs(c.forecast - c.actual) / c.actual;
                return (
                  <td key={h} className={`p-1.5 font-semibold tabular-nums font-mono ${tone(miss)}`} title={`Forecast ${c.forecast} · actual ${c.actual}`}>
                    {Math.round(miss * 100)}%
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
      <div className="flex items-center gap-4 px-3 py-2 text-[11px] text-[#525252] border-t border-[#E5E5E0] bg-[#FAFAF8]">
        <span className="flex items-center gap-1.5"><span className="w-3 h-3 rounded-xs bg-[#EAF5EF] border border-[#2F7D5A]/30" />Under 8% off</span>
        <span className="flex items-center gap-1.5"><span className="w-3 h-3 rounded-xs bg-[#FFF5DD] border border-[#B7791F]/30" />8–15% off</span>
        <span className="flex items-center gap-1.5"><span className="w-3 h-3 rounded-xs bg-[#FCEBEC] border border-[#C84A4A]/30" />Over 15% off</span>
      </div>
    </div>
  );
};
