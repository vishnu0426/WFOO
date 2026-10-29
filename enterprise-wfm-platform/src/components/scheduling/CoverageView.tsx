/**
 * Schedule Timeline › Coverage against the forecast. One schedule version, read three ways:
 *   - a summary strip (how much is covered, short and over, and the worst intervals),
 *   - the day as a chart (needed against scheduled, how far out each interval is, the service level it should give, another version beside it),
 *   - the whole period as a heatmap (days down, hours across).
 * Click any interval, in either view, to see who is working it and why the people who are not are not.
 * Short and over are told apart by pattern as well as colour.
 */
import React, { useMemo, useState } from 'react';
import { Bar, BarChart, Cell, CartesianGrid, ComposedChart, Area, Line, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { dayName, dec, ScheduleVersion, slotHHMM } from '../../services/api';
import { useApi } from '../forecasting/hooks';
import { Kpi, KpiRow, Pill, Seg, Select } from '../forecasting/ui';

type Slot = { day: string; slot: number; time: string; required: number; scheduled: number; delta: number };
type Cov = {
  day: string; grain: string; slots: Slot[]; shrinkage: number; projected?: boolean;
  heat: { day: string; hours: { need: number; have: number }[] }[];
  summary: { requiredHours: number; scheduledHours: number; shortHours: number; overHours: number; coveragePercent: number; worstShort: { day: string; time: string; short: number } | null; worstOver: { day: string; time: string; over: number } | null };
  compare: { id: string; name: string; seq: number; scheduled: number[] } | null;
  daily: { day: string; requiredHours: number; scheduledHours: number; coveragePercent: number }[];
};
type Interval = { day: string; slot: number; needed: number; scheduled: number; working: { employeeId: string; name: string; startSlot: number; endSlot: number }[]; notWorking: { key: string; text: string; people: number; names: string[] }[] };
type Eval = { available: boolean; summary?: { target: number; serviceLevel: number; answerSec: number }; intervals?: { day: string; slot: number; volume: number; sl: number }[] };

const RED = '#C84A4A', AMBER = '#D9A441', GREEN = '#2F7D5A', BLUE = '#4F6F8F';
const hhmm = (slot: number) => slotHHMM(slot);
const STEP: Record<string, number> = { '15': 1, '30': 2, '60': 4 };

export const CoverageView: React.FC<{ version: ScheduleVersion; versions: ScheduleVersion[]; day: string; days: string[]; setDay: (d: string) => void; refreshKey: string }> = ({ version, versions, day, days, setDay, refreshKey }) => {
  const [open, setOpen] = useState(() => { try { return localStorage.getItem('sched-cov-open') === '1'; } catch { return false; } });
  const [tab, setTab] = useState<'DAY' | 'WEEK'>('DAY');
  const [grain, setGrain] = useState('15');
  const [onPhones, setOnPhones] = useState(false);
  const [showSL, setShowSL] = useState(false);
  const [compareId, setCompareId] = useState('');
  const [picked, setPicked] = useState<{ day: string; slot: number } | null>(null);
  const toggle = () => setOpen((o) => { const n = !o; try { localStorage.setItem('sched-cov-open', n ? '1' : '0'); } catch { /* private mode */ } return n; });

  const cov = useApi<Cov>(open ? `/scheduling/versions/${version.id}/coverage?grain=${grain}${day ? `&day=${day}` : ''}${compareId ? `&compare=${compareId}` : ''}` : null, [refreshKey, day, grain, compareId, open]);
  const ev = useApi<Eval>(open && showSL ? `/scheduling/versions/${version.id}/evaluation?detail=1` : null, [refreshKey, showSL, open]);
  const why = useApi<Interval>(open && picked ? `/scheduling/versions/${version.id}/interval?day=${picked.day}&slot=${picked.slot}` : null, [refreshKey, picked?.day, picked?.slot, open]);

  const others = versions.filter((v) => v.id !== version.id && v.wfmGroupId === version.wfmGroupId);
  const factor = onPhones ? 1 - (cov.data?.shrinkage ?? 0) : 1;
  const r1 = (n: number) => Math.round(n * 10) / 10;

  // service level per chart interval, from the 15-minute estimates (volume-weighted when an interval spans several)
  const slAt = useMemo(() => {
    const by = new Map<string, { vol: number; sl: number }>();
    for (const i of ev.data?.intervals ?? []) by.set(`${i.day}|${i.slot}`, { vol: i.volume, sl: i.sl });
    const step = STEP[grain];
    return (d: string, slot: number) => {
      let vol = 0, w = 0;
      for (let k = 0; k < step; k++) { const x = by.get(`${d}|${slot + k}`); if (x) { vol += x.vol; w += x.vol * x.sl; } }
      return vol > 0 ? Math.round((w / vol) * 100) : null;
    };
  }, [ev.data, grain]);

  const rows = useMemo(() => (cov.data?.slots ?? []).map((s, k) => {
    const needed = r1(s.required * factor), scheduled = r1(s.scheduled * factor), delta = r1(scheduled - needed);
    return {
      slot: s.slot, time: s.time, needed, scheduled, delta,
      base: Math.min(scheduled, needed), short: Math.max(0, r1(needed - scheduled)), over: Math.max(0, r1(scheduled - needed)),
      compare: cov.data?.compare ? r1(cov.data.compare.scheduled[k] * factor) : undefined,
      sl: showSL ? slAt(s.day, s.slot) : null,
    };
  }), [cov.data, factor, showSL, slAt]);

  const sum = cov.data?.summary;
  const dayRow = cov.data?.daily.find((d) => d.day === day);
  const pick = (d: string, slot: number) => setPicked({ day: d, slot });
  const target = ev.data?.summary?.target;
  const onChartClick = (e: any) => { const p = e?.activePayload?.[0]?.payload; if (p) pick(day, p.slot); };

  return (
    <section className="rounded-lg border border-[#E5E5E0] bg-white">
      <button onClick={toggle} className="w-full flex items-center justify-between px-4 py-3 text-left">
        <div>
          <div className="text-[14px] font-semibold text-[#171717]">Coverage against the forecast</div>
          <div className="text-[12px] text-[#737373]">How many people are scheduled against how many are needed. Click any interval to see who is working it and why others are not.</div>
        </div>
        <span className="text-[12px] text-[#525252]">{open ? 'Hide' : 'Show'}</span>
      </button>
      {open && (
        <div className="px-4 pb-4 space-y-4">
          {version.settings?.fillsFrom && <p className="text-[12px] text-[#525252] bg-[#EDF3F8] border border-[#4F6F8F]/20 rounded px-3 py-2">This schedule fills the gaps in <b>{version.settings.fillsFrom.name}</b>. The people on that roster are counted as covering, so the chart shows both together.</p>}
          {/* the headline numbers, before any chart */}
          {sum && (
            <KpiRow>
              <Kpi label="Covered" value={`${dec(sum.coveragePercent, 1)}%`} tone={sum.coveragePercent >= 95 ? 'good' : sum.coveragePercent >= 85 ? 'warn' : 'bad'} sub={`${dec(sum.requiredHours, 0)} h needed, ${dec(sum.scheduledHours, 0)} h scheduled`} />
              <Kpi label="Short" value={`${dec(sum.shortHours, 0)} h`} tone={sum.shortHours === 0 ? 'good' : sum.shortHours / (sum.requiredHours || 1) > 0.05 ? 'bad' : 'warn'} sub={sum.worstShort ? `worst: ${dayName(sum.worstShort.day)} ${sum.worstShort.time}, ${sum.worstShort.short} people short` : 'nowhere short'} />
              <Kpi label="Over" value={`${dec(sum.overHours, 0)} h`} tone={sum.overHours / (sum.requiredHours || 1) > 0.25 ? 'warn' : undefined} sub={sum.worstOver ? `${dec((sum.overHours / (sum.requiredHours || 1)) * 100, 0)}% above need · most: ${dayName(sum.worstOver.day)} ${sum.worstOver.time}, +${sum.worstOver.over}` : 'none'} />
              <Kpi label={dayName(day)} value={dayRow ? `${dec(dayRow.coveragePercent, 1)}%` : '–'} tone={dayRow ? (dayRow.coveragePercent >= 95 ? 'good' : dayRow.coveragePercent >= 85 ? 'warn' : 'bad') : undefined} sub={dayRow ? `${dec(dayRow.scheduledHours, 0)} h scheduled, ${dec(dayRow.requiredHours, 0)} h needed` : ''} />
              <Kpi label="Service level" value={ev.data?.summary ? `${Math.round(ev.data.summary.serviceLevel * 100)}%` : showSL ? '…' : '–'} sub={ev.data?.summary ? `expected, target ${Math.round(ev.data.summary.target * 100)}% in ${ev.data.summary.answerSec}s` : 'switch on “Expected service level” to estimate'} />
            </KpiRow>
          )}

          <div className="flex flex-wrap items-center gap-3">
            <Seg options={[{ id: 'DAY', label: 'Day' }, { id: 'WEEK', label: 'Whole period' }]} value={tab} onChange={(v) => setTab(v as 'DAY' | 'WEEK')} />
            {tab === 'DAY' && (
              <>
                <Seg options={[{ id: '15', label: '15 min' }, { id: '30', label: '30 min' }, { id: '60', label: 'Hour' }]} value={grain} onChange={setGrain} />
                <label className="flex items-center gap-1.5 text-[12px]" title="Shrinkage is time people are scheduled but not on the phones (breaks, training, absence). Ticked, both lines show people on the phones."><input type="checkbox" checked={onPhones} onChange={(e) => setOnPhones(e.target.checked)} />People on the phones <span className="text-[#737373]">(after {Math.round((cov.data?.shrinkage ?? 0) * 100)}% shrinkage)</span></label>
                <label className="flex items-center gap-1.5 text-[12px]" title="What share of calls would be answered in time with this many people, from the forecast volume."><input type="checkbox" checked={showSL} onChange={(e) => setShowSL(e.target.checked)} />Expected service level</label>
                {others.length > 0 && (
                  <label className="flex items-center gap-1.5 text-[12px]">Compare with
                    <Select className="!w-auto" value={compareId} onChange={(e) => setCompareId(e.target.value)}>
                      <option value="">no other schedule</option>
                      {others.map((v) => <option key={v.id} value={v.id}>v{v.seq} · {v.name}</option>)}
                    </Select>
                  </label>
                )}
              </>
            )}
          </div>

          {tab === 'DAY' && (
            <div>
              <div className="flex flex-wrap items-center gap-4 pb-2 text-[11px] text-[#525252]">
                <Legend swatch={<span className="w-3 h-3 rounded-sm bg-[#DDF0E4] border border-[#2F7D5A]/30" />}>Covered</Legend>
                <Legend swatch={<Swatch kind="short" />}>Short</Legend>
                <Legend swatch={<Swatch kind="over" />}>Over</Legend>
                <Legend swatch={<span className="w-4 h-0.5 bg-[#171717]" />}>Needed</Legend>
                {cov.data?.compare && <Legend swatch={<span className="w-4 border-t-2 border-dashed" style={{ borderColor: BLUE }} />}>v{cov.data.compare.seq}</Legend>}
                {showSL && <Legend swatch={<span className="w-4 h-0.5" style={{ background: GREEN }} />}>Expected service level (right axis)</Legend>}
              </div>
              <div style={{ height: 280 }}>
                <ResponsiveContainer width="100%" height="100%">
                  <ComposedChart data={rows} margin={{ top: 8, right: showSL ? 8 : 12, bottom: 0, left: 0 }} onClick={onChartClick} style={{ cursor: 'pointer' }}>
                    {PATTERN_DEFS}
                    <CartesianGrid vertical={false} stroke="#EFEFEA" />
                    <XAxis dataKey="time" tickLine={false} axisLine={false} fontSize={11} minTickGap={24} />
                    <YAxis tickLine={false} axisLine={false} fontSize={11} width={36} />
                    {showSL && <YAxis yAxisId="sl" orientation="right" domain={[0, 100]} tickFormatter={(v) => `${v}%`} tickLine={false} axisLine={false} fontSize={11} width={40} />}
                    <Tooltip content={<Tip showSL={showSL} compareSeq={cov.data?.compare?.seq} />} />
                    <Area type="stepAfter" dataKey="base" name="Covered" stackId="cov" stroke="none" fill="#DDF0E4" isAnimationActive={false} />
                    <Area type="stepAfter" dataKey="short" name="Short" stackId="cov" stroke={RED} strokeWidth={0} fill="url(#pat-short)" isAnimationActive={false} />
                    <Area type="stepAfter" dataKey="over" name="Over" stackId="cov" stroke="none" fill="url(#pat-over)" isAnimationActive={false} />
                    <Line type="stepAfter" dataKey="needed" name="Needed" stroke="#171717" strokeWidth={2} dot={false} isAnimationActive={false} />
                    {cov.data?.compare && <Line type="stepAfter" dataKey="compare" name={`v${cov.data.compare.seq}`} stroke={BLUE} strokeWidth={2} strokeDasharray="5 4" dot={false} isAnimationActive={false} />}
                    {showSL && <Line yAxisId="sl" type="monotone" dataKey="sl" name="Expected service level" stroke={GREEN} strokeWidth={2} dot={false} connectNulls isAnimationActive={false} />}
                    {showSL && target !== undefined && <ReferenceLine yAxisId="sl" y={Math.round(target * 100)} stroke={GREEN} strokeDasharray="3 3" />}
                    {picked && picked.day === day && <ReferenceLine x={hhmm(picked.slot - (picked.slot % STEP[grain]))} stroke="#171717" strokeDasharray="2 2" />}
                  </ComposedChart>
                </ResponsiveContainer>
              </div>
              {/* how far out each interval is: easier to read than the gap between two lines */}
              <div className="mt-1 text-[11px] text-[#737373]">How far from the need, per interval: above zero is surplus, below is a shortage.</div>
              <div style={{ height: 120 }}>
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={rows} margin={{ top: 4, right: showSL ? 48 : 12, bottom: 0, left: 0 }} onClick={onChartClick} style={{ cursor: 'pointer' }}>
                    {PATTERN_DEFS}
                    <CartesianGrid vertical={false} stroke="#EFEFEA" />
                    <XAxis dataKey="time" tickLine={false} axisLine={false} fontSize={11} minTickGap={24} />
                    <YAxis tickLine={false} axisLine={false} fontSize={11} width={36} />
                    <ReferenceLine y={0} stroke="#171717" />
                    <Tooltip formatter={(v: any) => [`${v > 0 ? '+' : ''}${v}`, 'Scheduled minus needed']} labelFormatter={(l) => `${l}`} />
                    <Bar dataKey="delta" isAnimationActive={false} barSize={grain === '15' ? 5 : grain === '30' ? 9 : 18}>
                      {rows.map((r, i) => <Cell key={i} fill={r.delta < 0 ? 'url(#pat-short)' : 'url(#pat-over)'} stroke={r.delta < 0 ? RED : AMBER} strokeWidth={1} />)}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>
              {cov.data?.projected && <p className="mt-2 text-[11px] text-[#B7791F] bg-[#F5EBD9] border border-[#E9D9B4] rounded px-2.5 py-1.5">This day is beyond the short-term forecast's reach. Its requirement is projected from the long-term forecast, so treat it with less confidence.</p>}
            </div>
          )}

          {tab === 'WEEK' && cov.data && <Heatmap heat={cov.data.heat} daily={cov.data.daily} onPick={(d, h) => { setDay(d); pick(d, h * 4); setTab('DAY'); }} />}

          <IntervalPanel data={why.data} loading={why.loading} picked={picked} onClose={() => setPicked(null)} />
        </div>
      )}
    </section>
  );
};

/** Hatching for short, dots for over: the two can be told apart without colour. Inlined as an element, because the charts only render children they know. */
const PATTERN_DEFS = (
  <defs>
    <pattern id="pat-short" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
      <rect width="6" height="6" fill="#F8D4D4" /><line x1="0" y1="0" x2="0" y2="6" stroke={RED} strokeWidth="2" />
    </pattern>
    <pattern id="pat-over" width="6" height="6" patternUnits="userSpaceOnUse">
      <rect width="6" height="6" fill="#F5E7C8" /><circle cx="3" cy="3" r="1.1" fill={AMBER} />
    </pattern>
  </defs>
);

const Swatch: React.FC<{ kind: 'short' | 'over' }> = ({ kind }) => (
  <svg width="14" height="12" aria-hidden>{PATTERN_DEFS}<rect width="14" height="12" rx="2" fill={`url(#pat-${kind})`} stroke={kind === 'short' ? RED : AMBER} strokeWidth="1" /></svg>
);
const Legend: React.FC<{ swatch: React.ReactNode; children: React.ReactNode }> = ({ swatch, children }) => <span className="flex items-center gap-1.5">{swatch}{children}</span>;

const Tip: React.FC<any> = ({ active, payload, label, showSL, compareSeq }) => {
  if (!active || !payload?.length) return null;
  const p = payload[0].payload;
  return (
    <div className="rounded-md border border-[#E5E5E0] bg-white px-3 py-2 text-[12px] shadow-md">
      <div className="font-semibold">{label}</div>
      <div>Needed <b>{p.needed}</b> · Scheduled <b>{p.scheduled}</b></div>
      <div className={p.delta < 0 ? 'text-[#C84A4A] font-medium' : p.delta > 0 ? 'text-[#B7791F]' : 'text-[#2F7D5A]'}>{p.delta < 0 ? `${-p.delta} short` : p.delta > 0 ? `${p.delta} over` : 'exactly covered'}</div>
      {p.compare !== undefined && <div className="text-[#4F6F8F]">v{compareSeq}: {p.compare}</div>}
      {showSL && p.sl !== null && p.sl !== undefined && <div className="text-[#2F7D5A]">Expected service level {p.sl}%</div>}
      <div className="text-[#737373] mt-1">Click for who is working it</div>
    </div>
  );
};

/** Days down, hours across. Colour and the number show how far each hour is from the need; the busiest quarter sets the need and the weakest quarter the cover. */
export const Heatmap: React.FC<{ heat: Cov['heat']; daily: Cov['daily']; onPick: (day: string, hour: number) => void }> = ({ heat, daily, onPick }) => {
  const cell = (need: number, have: number) => {
    const d = have - need;
    if (need === 0 && have === 0) return { bg: '#F4F4F0', text: '', tip: 'nobody needed, nobody scheduled' };
    const rel = d / Math.max(need, 1);
    if (Math.abs(rel) <= 0.05) return { bg: '#DDF0E4', text: d === 0 ? '' : (d > 0 ? `+${d}` : `${d}`), tip: 'covered' };
    if (d < 0) return { bg: `rgba(200,74,74,${0.25 + 0.65 * Math.min(1, -rel * 2)})`, text: `${d}`, tip: 'short' };
    return { bg: `rgba(217,164,65,${0.15 + 0.5 * Math.min(1, rel / 1.5)})`, text: `+${d}`, tip: 'over' };
  };
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-4 text-[11px] text-[#525252]">
        <span className="flex items-center gap-1.5"><span className="w-3 h-3 rounded-sm" style={{ background: 'rgba(200,74,74,0.7)' }} />Short (−people)</span>
        <span className="flex items-center gap-1.5"><span className="w-3 h-3 rounded-sm bg-[#DDF0E4]" />Within 5% of the need</span>
        <span className="flex items-center gap-1.5"><span className="w-3 h-3 rounded-sm" style={{ background: 'rgba(217,164,65,0.5)' }} />Over (+people)</span>
        <span>The number is people scheduled minus people needed in that hour. Click an hour for the detail.</span>
      </div>
      <div className="overflow-x-auto">
        <div className="min-w-[760px]">
          <div className="grid" style={{ gridTemplateColumns: '120px repeat(24, minmax(0, 1fr)) 56px' }}>
            <div />
            {Array.from({ length: 24 }, (_, h) => <div key={h} className="text-[10px] text-[#737373] text-center pb-1">{String(h).padStart(2, '0')}</div>)}
            <div className="text-[10px] text-[#737373] text-right pb-1">Covered</div>
            {heat.map((r) => {
              const cov = daily.find((d) => d.day === r.day);
              return (
                <React.Fragment key={r.day}>
                  <div className="text-[12px] pr-2 py-0.5 self-center">{dayName(r.day)}</div>
                  {r.hours.map((h, i) => {
                    const c = cell(h.need, h.have);
                    return (
                      <button key={i} type="button" onClick={() => onPick(r.day, i)} title={`${dayName(r.day)} ${String(i).padStart(2, '0')}:00 · needed ${h.need}, scheduled ${h.have} (${c.tip})`}
                        className="h-7 border border-white text-[10px] font-medium tabular-nums text-[#171717] hover:outline hover:outline-1 hover:outline-[#171717]" style={{ background: c.bg }}>{c.text}</button>
                    );
                  })}
                  <div className="text-[11px] text-right tabular-nums self-center">{cov ? `${dec(cov.coveragePercent, 0)}%` : ''}</div>
                </React.Fragment>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
};

const IntervalPanel: React.FC<{ data: Interval | null; loading: boolean; picked: { day: string; slot: number } | null; onClose: () => void }> = ({ data, loading, picked, onClose }) => {
  if (!picked) return null;
  const gap = data ? data.scheduled - data.needed : 0;
  const could = data?.notWorking.find((g) => g.key === 'COULD_WORK');
  return (
    <div className="rounded-lg border border-[#E5E5E0] bg-[#FAFAF8] p-3 space-y-2 text-[13px]">
      <div className="flex items-center justify-between gap-2">
        <div className="font-semibold">{dayName(picked.day)} · {hhmm(picked.slot)}</div>
        <button type="button" className="text-[12px] underline" onClick={onClose}>Close</button>
      </div>
      {loading && !data && <div className="text-[12px] text-[#737373]">Looking at who is working…</div>}
      {data && (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <Pill tone={gap < 0 ? 'bad' : gap > 0 ? 'warn' : 'good'}>{gap < 0 ? `${-gap} short` : gap > 0 ? `${gap} over` : 'exactly covered'}</Pill>
            <span>needed {data.needed}, scheduled {data.scheduled}</span>
          </div>
          {gap < 0 && could && <p className="text-[12px] text-[#525252]">{could.people} {could.people === 1 ? 'person is' : 'people are'} free and allowed to work this time, so the gap can be closed by moving one in: {could.names.slice(0, 6).join(', ')}{could.people > 6 ? '…' : ''}.</p>}
          {gap < 0 && !could && <p className="text-[12px] text-[#525252]">Nobody who is off can take this time without breaking a rule: see the reasons below.</p>}
          {gap > 0 && <p className="text-[12px] text-[#525252]">{gap} more {gap === 1 ? 'person is' : 'people are'} working than needed. Shortening or moving shifts that start or end here would use them where they are short.</p>}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <div className="text-[12px] font-semibold mb-1">Working now ({data.working.length})</div>
              <ul className="max-h-44 overflow-auto space-y-0.5 text-[12px]">
                {data.working.slice(0, 40).map((w) => <li key={w.employeeId} className="flex justify-between gap-2"><span>{w.name}</span><span className="text-[#737373] tabular-nums">{hhmm(w.startSlot)}–{hhmm(w.endSlot % 96)}</span></li>)}
                {data.working.length > 40 && <li className="text-[#737373]">and {data.working.length - 40} more</li>}
              </ul>
            </div>
            <div>
              <div className="text-[12px] font-semibold mb-1">Not working, and why</div>
              <ul className="space-y-1 text-[12px]">
                {data.notWorking.map((g) => (
                  <li key={g.key}>
                    <span className="font-medium">{g.people}</span> {g.text}
                    {g.key === 'COULD_WORK' && g.names.length > 0 && <span className="text-[#737373]"> ({g.names.slice(0, 5).join(', ')}{g.people > 5 ? '…' : ''})</span>}
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </>
      )}
    </div>
  );
};
