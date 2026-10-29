/**
 * Scheduling › Schedule Timeline. One schedule version: how well it covers the forecast, the day as a timeline (meals and
 * breaks visible), the whole period as a roster grid, rule violations, manual edits (reason required) and publishing.
 */
import React, { useEffect, useMemo, useState } from 'react';
import { ColDef } from 'ag-grid-community';
import { Download, Plus } from 'lucide-react';
import { addDays, api, dayName, dayYear, DOW, dowOfDay, dec, Employee, isNew, ScheduleShift, ScheduleVersion, SCHED_STATUS_LABEL, ShiftTemplate, slotHHMM, when, Violation } from '../../services/api';
import { useForecast } from '../../services/forecastStore';
import { useApi } from '../forecasting/hooks';
import { Grid } from '../forecasting/Grid';
import { downloadXlsx } from '../../services/excel';
import { DayTimeline, type Act } from './DayTimeline';
import { EmployeeDrawer } from './EmployeeDrawer';
import { CoverageView } from './CoverageView';
import { Banner, Btn, Busy, Card, Empty, Field, Input, Kpi, KpiRow, Pill, Seg, Select } from '../forecasting/ui';

type Coverage = { daily: { day: string; requiredHours: number; scheduledHours: number; coveragePercent: number; shifts: number; projected: boolean }[]; slots: { time: string; required: number; scheduled: number; delta: number }[]; uncoveredDays?: string[]; projectedDays?: string[]; projected?: boolean };
const tone = (p: number) => (p >= 95 ? 'good' : p >= 85 ? 'warn' : 'bad') as 'good' | 'warn' | 'bad';

export const TimelinePanel: React.FC<{ versions: ScheduleVersion[]; version: ScheduleVersion | null; select: (id: string) => void; reload: (id?: string) => Promise<void>; go: (sub: string) => void }> = ({ versions, version, select, reload, go }) => {
  const { group, can, setNotice } = useForecast();
  const [day, setDay] = useState('');
  const [grain, setGrain] = useState('60');
  const [sel, setSel] = useState<ScheduleShift | null>(null);
  const [busy, setBusy] = useState(false);
  const [add, setAdd] = useState<{ employeeId: string; templateId: string; startTime: string; reason: string } | null>(null);
  const [error, setError] = useState('');
  // publishing with open checks (coverage under target, a forecast that has changed) needs a reason, collected inline
  const [ack, setAck] = useState<{ path: 'publish' | 'republish'; message: string; reason: string } | null>(null);
  const [nameQuery, setNameQuery] = useState('');
  const [skillFilter, setSkillFilter] = useState<string[]>([]);
  const [pending, setPending] = useState<
    | { kind: 'move'; shift: ScheduleShift; newStartTime: string }
    | { kind: 'swap'; a: ScheduleShift; b: ScheduleShift }
    | { kind: 'remove'; shift: ScheduleShift }
    | null
  >(null);
  const [pendingReason, setPendingReason] = useState('');
  const [zoom, setZoom] = useState('30');
  const [focus, setFocus] = useState(false);
  const [problem, setProblem] = useState<'ALL' | 'UNDERSTAFFED' | 'VIOLATIONS'>('ALL');
  const [openEmp, setOpenEmp] = useState<string | null>(null);

  const key = version ? `${version.id}-${version.rev}-${version.status}` : '';
  const full = useApi<ScheduleVersion>(version ? `/scheduling/versions/${version.id}` : null, [key]);
  const shifts = useApi<ScheduleShift[]>(version ? `/scheduling/versions/${version.id}/shifts` : null, [key]);
  const cov = useApi<Coverage>(version ? `/scheduling/versions/${version.id}/coverage?grain=${grain}${day ? `&day=${day}` : ''}` : null, [key, day, grain]);
  const cov15 = useApi<Coverage>(version && day ? `/scheduling/versions/${version.id}/coverage?grain=15&day=${day}` : null, [key, day]);
  const emps = useApi<Employee[]>(group ? `/workforce/employees?groupId=${group.id}&status=ACTIVE` : null);
  const tpls = useApi<ShiftTemplate[]>('/scheduling/templates');

  useEffect(() => { if (version) setDay(version.periodStart); setSel(null); }, [version?.id]);

  const days = useMemo(() => { if (!version) return []; const o: string[] = []; for (let d = version.periodStart; d <= version.periodEnd && o.length < 31; d = addDays(d, 1)) o.push(d); return o; }, [version?.id]);
  // grouped into weeks starting from the schedule's own first day, so "Week 2" etc. always means the same thing
  // this version -- lets a multi-week schedule be jumped to directly instead of paged through one day at a time.
  const weeks = useMemo(() => { const o: string[][] = []; for (let i = 0; i < days.length; i += 7) o.push(days.slice(i, i + 7)); return o; }, [days]);

  const all: Violation[] = full.data?.violations ?? [];
  const violations = all.filter((v) => v.severity !== 'WARN');            // these block publishing
  const warnings = all.filter((v) => v.severity === 'WARN');              // labour-law rules set to warn only
  const badKeys = new Set(violations.map((v) => `${v.employeeId}|${v.day}`));

  const cols = useMemo<ColDef<any>[]>(() => [
    { headerName: 'Employee', field: 'name', pinned: 'left', minWidth: 170 },
    ...days.map((d) => ({
      headerName: `${DOW[dowOfDay(d)]} ${d.slice(8)}`, field: d, width: 118, sortable: false,
      cellStyle: (p: any) => (badKeys.has(`${p.data.id}|${d}`) ? { background: '#FCEBEC', color: '#C84A4A', fontWeight: 600 } : p.value ? { fontFamily: 'ui-monospace, monospace', fontSize: '12px' } : { color: '#A3A3A3' }),
      valueFormatter: (p: any) => p.value || '·',
    } as ColDef<any>)),
    { headerName: 'Paid hours', field: 'hours', type: 'rightAligned', width: 90, pinned: 'right' },
  ], [days, violations]);
  const roster = useMemo(() => {
    const m = new Map<string, any>();
    for (const s of shifts.data ?? []) {
      const r = m.get(s.employeeId) ?? { id: s.employeeId, name: s.employeeName, hours: 0 };
      const meal = s.activities.filter((x) => x.type === 'MEAL').reduce((n, x) => n + x.slots, 0);   // the unpaid meal is not paid time
      r[s.day] = `${s.startTime}–${s.endTime}`; r.hours += (s.lengthSlots - meal) / 4; m.set(s.employeeId, r);
    }
    return [...m.values()].map((r) => ({ ...r, hours: Math.round(r.hours * 10) / 10 }));
  }, [shifts.data]);
  const empById = useMemo(() => new Map((emps.data ?? []).map((e) => [e.id, e])), [emps.data]);
  const allSkills = useMemo(() => { const m = new Map<string, string>(); for (const e of emps.data ?? []) for (const s of e.skills) m.set(s.skillId, s.name); return [...m.entries()]; }, [emps.data]);

  // all hooks are above this line: the returns below must not change how many hooks run
  const dayIdx = days.indexOf(day);
  const dayRow = cov.data?.daily.find((d) => d.day === day);
  const goDay = (n: number) => { const d = days[dayIdx + n]; if (d) { setDay(d); setSel(null); setOpenEmp(null); } };
  const jumpTo = (d: string) => { if (days.includes(d)) { setDay(d); setSel(null); setOpenEmp(null); } };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
      if (e.key === 'ArrowLeft') goDay(-1);
      if (e.key === 'ArrowRight') goDay(1);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });
  if (!group) return <Empty title="No WFM group yet" />;
  if (!version) return <Empty title={`No schedule for ${group.name} yet`}>{can('schedule:generate') ? <>Open <button className="underline" onClick={() => go('generate-schedule')}>Generate Schedule</button> to build one from the published forecast.</> : 'Someone with scheduling permission needs to generate one.'}</Empty>;

  const stats = (full.data ?? version).stats;
  const draft = version.status === 'DRAFT';
  const canEdit = (draft || version.status === 'PUBLISHED') && can('schedule:edit');
  const passesFilter = (employeeId: string, employeeName?: string) => {
    if (!nameQuery.trim() && skillFilter.length === 0) return true;
    const e = empById.get(employeeId);
    const nameOk = !nameQuery.trim() || (employeeName ?? e?.name ?? '').toLowerCase().includes(nameQuery.trim().toLowerCase());
    const skillOk = skillFilter.length === 0 || (!!e && skillFilter.every((sid) => e.skills.some((s) => s.skillId === sid)));
    return nameOk && skillOk;
  };
  const dayShifts = (shifts.data ?? []).filter((s) => s.day === day && passesFilter(s.employeeId, s.employeeName));
  const filteredRoster = roster.filter((r) => passesFilter(r.id, r.name));
  const filtering = !!nameQuery.trim() || skillFilter.length > 0;

  // the roster grid's own data, reshaped for export -- same header/body a human reads on screen, just as plain rows
  const exportHeader = ['Employee', ...days.map((d) => `${DOW[dowOfDay(d)]} ${d.slice(8)}`), 'Paid hours'];
  const exportBody = filteredRoster.map((r) => [r.name, ...days.map((d) => r[d] ?? ''), r.hours]);
  const exportFileBase = `${version.name}`.replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '').toLowerCase() || 'schedule';
  const exportCsv = () => {
    const esc = (v: string | number) => { const s = String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
    const text = [exportHeader, ...exportBody].map((row) => row.map(esc).join(',')).join('\n');
    const url = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8' }));
    const a = document.createElement('a'); a.href = url; a.download = `${exportFileBase}.csv`; a.click(); URL.revokeObjectURL(url);
  };
  const exportXlsx = () => downloadXlsx(`${exportFileBase}.xlsx`, 'Schedule', [exportHeader, ...exportBody]).catch((e) => setError(e.message));
  const exportPdf = () => {
    const w = window.open('', '_blank'); if (!w) return;
    const rowsHtml = exportBody.map((row) => `<tr>${row.map((v, i) => `<td${i === 0 ? '' : ' style="text-align:center"'}>${v === '' ? '&middot;' : v}</td>`).join('')}</tr>`).join('');
    w.document.write(`<!doctype html><html><head><title>${version.name}</title><style>
      body{font-family:ui-sans-serif,system-ui,sans-serif;padding:24px;color:#171717}
      h1{font-size:16px;margin:0 0 4px}p{font-size:12px;color:#737373;margin:0 0 16px}
      table{border-collapse:collapse;width:100%;font-size:11px}
      th,td{border:1px solid #E5E5E0;padding:4px 6px}th{background:#FAFAF8;text-align:left}
      @media print{@page{size:landscape}}
    </style></head><body>
      <h1>${version.name}</h1><p>${dayYear(version.periodStart)} – ${dayYear(version.periodEnd)} · ${group?.name ?? ''}</p>
      <table><thead><tr>${exportHeader.map((h) => `<th>${h}</th>`).join('')}</tr></thead><tbody>${rowsHtml}</tbody></table>
    </body></html>`);
    w.document.close(); w.focus(); w.print();
  };

  const act = async (fn: () => Promise<void>, ok?: string) => {
    setBusy(true); setError('');
    try { await fn(); if (ok) setNotice({ kind: 'ok', text: ok }); } catch (e: any) { setError(e.message); } finally { setBusy(false); }
  };
  const send = (path: 'publish' | 'republish', reason?: string) => act(async () => {
    try { await api(`/scheduling/versions/${version.id}/${path}`, { method: 'POST', body: reason ? { acknowledgeReason: reason } : {} }); }
    catch (e: any) { if (e?.code === 'CHECKS_NOT_ACKNOWLEDGED') { setAck({ path, message: e.message, reason: reason ?? '' }); return; } throw e; }
    setAck(null); await reload(version.id);
    setNotice({ kind: 'ok', text: path === 'publish' ? `${version.name} is published. Any older published schedule for these dates is archived.` : `${version.name} is republished with your edits.` });
  });
  const publish = () => send('publish');
  const republish = () => send('republish');
  const del = () => { if (!confirm(`Delete “${version.name}”?`)) return; act(async () => { await api(`/scheduling/versions/${version.id}`, { method: 'DELETE' }); await reload(); }, 'Schedule deleted.'); };
  // reasons for a move/swap/remove are collected inline below (pending/pendingReason), not with window.prompt(): a
  // native dialog is easy to trigger Chrome's "prevent this page from creating additional dialogs" with, after
  // which every further prompt() silently returns null -- indistinguishable from the action just not working.
  const removeShift = (s: ScheduleShift) => { setPendingReason(''); setPending({ kind: 'remove', shift: s }); };
  const addShift = () => add && act(async () => {
    const r = await api<{ violations: Violation[] }>(`/scheduling/versions/${version.id}/shifts`, { method: 'POST', body: { ...add, day } });
    setAdd(null); await reload(version.id);
    if (r.violations.length) setNotice({ kind: 'err', text: `Shift added, but it breaks a rule: ${r.violations[0].message}` });
  });
  const pendingPrompt = !pending ? '' : pending.kind === 'remove' ? `Why is ${pending.shift.employeeName}'s shift on ${pending.shift.day} being removed?`
    : pending.kind === 'move' ? `Why is ${pending.shift.employeeName}'s shift on ${pending.shift.day} moving to ${pending.newStartTime}?`
    : `Why are ${pending.a.employeeName} and ${pending.b.employeeName} swapping shifts on ${pending.a.day}?`;
  const confirmPending = () => {
    if (!pending || pendingReason.trim().length < 3) return;
    const reason = pendingReason.trim(), p = pending;
    setPending(null);
    if (p.kind === 'remove') {
      act(async () => { await api(`/scheduling/versions/${version.id}/shifts/${p.shift.id}?reason=${encodeURIComponent(reason)}`, { method: 'DELETE' }); setSel(null); await reload(version.id); });
    } else if (p.kind === 'move') {
      act(async () => {
        const r = await api<{ violations: Violation[] }>(`/scheduling/versions/${version.id}/shifts`, { method: 'POST', body: { employeeId: p.shift.employeeId, day: p.shift.day, templateId: p.shift.templateId, startTime: p.newStartTime, reason } });
        setSel(null); await reload(version.id);
        if (r.violations.length) setNotice({ kind: 'err', text: `Moved, but it breaks a rule: ${r.violations[0].message}` });
      });
    } else {
      act(async () => {
        const [r1, r2] = await Promise.all([
          api<{ violations: Violation[] }>(`/scheduling/versions/${version.id}/shifts`, { method: 'POST', body: { employeeId: p.a.employeeId, day: p.a.day, templateId: p.b.templateId, startTime: p.b.startTime, reason } }),
          api<{ violations: Violation[] }>(`/scheduling/versions/${version.id}/shifts`, { method: 'POST', body: { employeeId: p.b.employeeId, day: p.b.day, templateId: p.a.templateId, startTime: p.a.startTime, reason } }),
        ]);
        setSel(null); await reload(version.id);
        const probs = [...r1.violations, ...r2.violations];
        if (probs.length) setNotice({ kind: 'err', text: `Swapped, but it breaks a rule: ${probs[0].message}` });
      });
    }
  };



  return (
    <div className="space-y-4">
      <div className="sticky top-0 z-30 -mx-1 px-1 py-2.5 bg-white/95 backdrop-blur border-b border-[#E5E5E0]">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2.5 min-w-0">
            <h2 className="text-[16px] font-semibold text-[#171717] truncate">{version.name}</h2>
            <Pill tone={version.status === 'PUBLISHED' ? 'good' : version.status === 'DRAFT' ? 'warn' : 'neutral'}>{SCHED_STATUS_LABEL[version.status]}</Pill>
            {isNew(version) && <Pill tone="info">NEW</Pill>}
            <span className="text-[12px] text-[#737373] truncate">{dayYear(version.periodStart)} → {dayYear(version.periodEnd)} · built on {version.coverageSource === 'MANUAL' ? 'manual coverage' : (version.forecastName ?? 'a forecast')}</span>
          </div>
          <div className="flex items-center gap-2">
            {busy && <Busy />}
            <Select value={version.id} onChange={(e) => select(e.target.value)} className="!w-auto max-w-[260px]" aria-label="Schedule version">
              {versions.map((v) => <option key={v.id} value={v.id}>{v.status === 'PUBLISHED' ? '● ' : ''}{v.name} — {SCHED_STATUS_LABEL[v.status].toLowerCase()}{isNew(v) ? ' — NEW' : ''}</option>)}
            </Select>
            {canEdit && <Btn onClick={() => { setError(''); setAdd({ employeeId: '', templateId: tpls.data?.find((t) => t.status === 'ACTIVE')?.id ?? '', startTime: '09:00', reason: '' }); }}><Plus className="w-3.5 h-3.5" />Add shift</Btn>}
            {draft && can('schedule:publish') && <Btn variant="success" disabled={busy || violations.length > 0} onClick={publish} title={violations.length ? 'Fix the rule violations first' : ''}>Publish</Btn>}
            {version.status === 'PUBLISHED' && version.hasChanges && can('schedule:publish') && <Btn variant="success" disabled={busy || violations.length > 0} onClick={republish} title={violations.length ? 'Fix the rule violations first' : 'Re-check the rules and re-stamp this schedule'}>Republish</Btn>}
            {version.status !== 'PUBLISHED' && can('schedule:generate') && <Btn onClick={del}>Delete</Btn>}
            {can('schedule:generate') && <Btn onClick={() => go('generate-schedule')}>New schedule</Btn>}
          </div>
        </div>
        {!draft && <p className="mt-1 text-[11px] text-[#737373]">{version.status === 'PUBLISHED' ? (version.hasChanges ? 'Unpublished edits are live for adherence. Republish to re-check the rules and re-stamp it.' : 'Published. No changes since it was last published.') : 'Archived: a newer schedule was published.'}</p>}
      </div>
      {version.stale && version.stale.length > 0 && <Banner kind="warn"><span className="font-semibold">This schedule may be out of date.</span> {version.stale.join(' ')} <button className="underline" onClick={() => go('schedule-quality')}>See schedule quality</button></Banner>}
      {ack && (
        <Banner kind="warn">
          <div className="font-semibold">{ack.message.replace(' Give a reason to publish anyway.', '')}</div>
          <div className="mt-1 flex flex-wrap items-center gap-2">
            <Input className="!w-80" value={ack.reason} onChange={(e) => setAck({ ...ack, reason: e.target.value })} placeholder="Why are you publishing it anyway? This is kept with the schedule." />
            <Btn variant="success" disabled={busy || ack.reason.trim().length < 3} onClick={() => send(ack.path, ack.reason.trim())}>{ack.path === 'publish' ? 'Publish anyway' : 'Republish anyway'}</Btn>
            <Btn onClick={() => setAck(null)}>Cancel</Btn>
          </div>
        </Banner>
      )}
      {error && <Banner kind="err" onClose={() => setError('')}>{error}</Banner>}


      <div className="flex flex-wrap items-center gap-3">
        <div className="w-64"><Input value={nameQuery} onChange={(e) => setNameQuery(e.target.value)} placeholder="Search agent name or ID" aria-label="Search agent" /></div>
        {allSkills.length > 0 && (
          <details className="relative">
            <summary className="list-none cursor-pointer px-3 py-1.5 rounded-md border border-[#E5E5E0] text-[12px] hover:bg-[#FAFAF8]">Skills{skillFilter.length ? ` (${skillFilter.length})` : ''}</summary>
            <div className="absolute z-30 mt-1 w-56 rounded-md border border-[#E5E5E0] bg-white p-2 shadow-lg space-y-1.5">
              {allSkills.map(([id, name]) => (
                <label key={id} className="flex items-center gap-2 text-[12px]"><input type="checkbox" checked={skillFilter.includes(id)} onChange={(e) => setSkillFilter(e.target.checked ? [...skillFilter, id] : skillFilter.filter((x) => x !== id))} />{name}</label>
              ))}
            </div>
          </details>
        )}
        <Select value={problem} onChange={(e) => setProblem(e.target.value as 'ALL' | 'UNDERSTAFFED' | 'VIOLATIONS')} className="!w-auto" aria-label="Problem filter">
          <option value="ALL">All agents ({dayShifts.length})</option>
          <option value="UNDERSTAFFED">Understaffed window</option>
          <option value="VIOLATIONS">With rule violations</option>
        </Select>
        <Seg options={[{ id: '15', label: '15m' }, { id: '30', label: '30m' }, { id: '60', label: '1h' }, { id: '120', label: '2h' }]} value={zoom} onChange={setZoom} />
        <button className={`px-3 py-1.5 rounded-md border text-[12px] font-medium ${focus ? 'bg-[#171717] text-white border-[#171717]' : 'border-[#E5E5E0] hover:bg-[#FAFAF8]'}`} onClick={() => setFocus((f) => !f)}>Focus mode</button>
        {filtering && <button className="text-[12px] underline text-[#737373]" onClick={() => { setNameQuery(''); setSkillFilter([]); }}>Clear</button>}
      </div>

      <div className="flex flex-wrap items-center gap-x-6 gap-y-1 py-2 text-[13px] text-[#525252] border-y border-[#E5E5E0]">
        <span>Coverage <b className={tone(stats.coverage.percent) === 'good' ? 'text-[#2F7D5A]' : tone(stats.coverage.percent) === 'warn' ? 'text-[#B7791F]' : 'text-[#C84A4A]'}>{dec(stats.coverage.percent, 1)}%</b></span>
        <span><b className="text-[#171717]">{stats.shifts}</b> shifts · {stats.people} people</span>
        <span><b className="text-[#171717]">{dec(stats.hours.paid, 0)}h</b> paid of {dec(stats.hours.required, 0)}h needed</span>
        <span>Overtime <b className="text-[#171717]">{dec(stats.hours.overtime, 0)}h</b></span>
        <span>Short <b className="text-[#171717]">{stats.coverage.underIntervals}</b> quarter-hours across this schedule, <b className="text-[#171717]">{stats.coverage.criticalIntervals}</b> critical</span>
        <span className={stats.violations ? 'text-[#C84A4A]' : ''}>Rule violations <b>{stats.violations}</b></span>
      </div>

      <Card title={dayName(day)} actions={
        <div className="flex items-center gap-2.5">
          {weeks.length > 1 && (
            <div className="flex items-center gap-1 rounded-md border border-[#E5E5E0] p-0.5">
              {weeks.map((w, i) => (
                <button key={w[0]} title={`${dayYear(w[0])} – ${dayYear(w[w.length - 1])}`}
                  onClick={() => jumpTo(w[0])}
                  className={`px-2 py-1 rounded text-[11px] font-medium ${w.includes(day) ? 'bg-[#171717] text-white' : 'text-[#525252] hover:bg-[#FAFAF8]'}`}>
                  Week {i + 1}
                </button>
              ))}
            </div>
          )}
          <input type="date" value={day} min={days[0]} max={days[days.length - 1]} onChange={(e) => jumpTo(e.target.value)}
            className="px-2 py-1 rounded-md border border-[#E5E5E0] text-[12px]" aria-label="Jump to date" />
          <div className="flex items-center gap-1.5">
            <button aria-label="Previous day" title="Previous day (←)" disabled={dayIdx <= 0} onClick={() => goDay(-1)} className="w-8 h-8 rounded-md border border-[#E5E5E0] text-[16px] leading-none hover:bg-[#FAFAF8] disabled:opacity-35 disabled:cursor-not-allowed">‹</button>
            <span className="text-[11px] text-[#737373] px-1 tabular-nums">{dayIdx + 1} / {days.length}</span>
            <button aria-label="Next day" title="Next day (→)" disabled={dayIdx < 0 || dayIdx >= days.length - 1} onClick={() => goDay(1)} className="w-8 h-8 rounded-md border border-[#E5E5E0] text-[16px] leading-none hover:bg-[#FAFAF8] disabled:opacity-35 disabled:cursor-not-allowed">›</button>
          </div>
        </div>
      } sub={canEdit ? 'Hover for details. Click a name for their week. Drag an activity to move it, its right edge to resize it.' : 'Hover for details. Click a name for their week.'}>
        {add && (
          <div className="mb-4 border border-[#E5E5E0] rounded-lg p-4 grid grid-cols-1 md:grid-cols-5 gap-4 items-end">
            <Field label="Person" hint={emps.loading ? 'Loading…' : emps.data && emps.data.length === 0 ? 'No active employees in this group' : undefined}>
              <Select disabled={emps.loading} value={add.employeeId} onChange={(e) => {
                const emp = emps.data?.find((x) => x.id === e.target.value);
                const preferred = emp?.preferredTemplateId && tpls.data?.find((t) => t.id === emp.preferredTemplateId && t.status === 'ACTIVE') ? emp.preferredTemplateId : add.templateId;
                setAdd({ ...add, employeeId: e.target.value, templateId: preferred });
              }}><option value="">{emps.loading ? 'Loading…' : 'Choose…'}</option>{emps.data?.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}</Select>
            </Field>
            <Field label="Template"><Select value={add.templateId} onChange={(e) => setAdd({ ...add, templateId: e.target.value })}>{tpls.data?.filter((t) => t.status === 'ACTIVE').map((t) => <option key={t.id} value={t.id}>{t.name} ({t.durationHours}h)</option>)}</Select></Field>
            <Field label="Starts"><Input type="time" step={900} value={add.startTime} onChange={(e) => setAdd({ ...add, startTime: e.target.value })} /></Field>
            <Field label="Reason (required)"><Input value={add.reason} onChange={(e) => setAdd({ ...add, reason: e.target.value })} /></Field>
            <div className="flex gap-2"><Btn variant="primary" disabled={!add.employeeId || !add.templateId || add.reason.trim().length < 3 || busy} onClick={addShift}>Add</Btn><Btn onClick={() => setAdd(null)}>Cancel</Btn></div>
          </div>
        )}
        {pending && (
          <div className="mb-4 border border-[#E9D9B4] rounded-lg p-4 bg-[#FFF5DD] space-y-2.5">
            <div className="text-[13px] font-medium text-[#171717]">{pendingPrompt}</div>
            <div className="flex flex-wrap items-center gap-2">
              <Input autoFocus value={pendingReason} onChange={(e) => setPendingReason(e.target.value)} placeholder="Reason (required)" className="max-w-sm" />
              <Btn variant="primary" disabled={pendingReason.trim().length < 3 || busy} onClick={confirmPending}>Confirm</Btn>
              <Btn onClick={() => setPending(null)}>Cancel</Btn>
            </div>
          </div>
        )}
        {dayShifts.length === 0 && problem === 'ALL' && !focus
          ? <p className="text-[12px] text-[#737373]">{filtering ? 'No one matches the current filters on this day.' : 'Nobody is scheduled on this day.'}</p>
          : <DayTimeline shifts={dayShifts} bad={badKeys} coverage={cov15.data?.slots ?? []} people={empById} zoom={zoom} focus={focus} problem={problem}
              canEdit={canEdit} selected={sel?.id ?? null} onSelect={(s) => setSel(s.id === sel?.id ? null : s)} onOpen={(id) => setOpenEmp(id)}
              onMoveShift={async (shift, newStartSlot, why) => {
                // the server re-places each meal and break around the new start, as it does for any shift it writes
                await api(`/scheduling/versions/${version!.id}/shifts`, { method: 'POST', body: { employeeId: shift.employeeId, day: shift.day, templateId: shift.templateId, startTime: slotHHMM(newStartSlot), reason: why } });
                await reload(version!.id);
              }}
              onSaveActivities={async (shift, acts: Act[], why) => {
                await api(`/scheduling/versions/${version!.id}/shifts/${shift.id}/activities`, { method: 'PUT', body: { activities: acts, reason: why } });
                await reload(version!.id);
              }} />}
        {sel && (
          <div className="mt-3 border border-[#E5E5E0] rounded-lg p-3 bg-[#FAFAF8] flex flex-wrap items-center gap-4 text-[13px]">
            <b>{sel.employeeName}</b><span>{sel.startTime}–{sel.endTime}{sel.overnight ? ' (overnight)' : ''}</span><span className="text-[#737373]">{sel.templateName ?? 'shift'} · {sel.source === 'MANUAL' ? 'added by hand' : 'from the solver'}</span>
            {canEdit && <button className="ml-auto text-[12px] text-[#C84A4A] underline" onClick={() => removeShift(sel)}>Remove shift</button>}
          </div>
        )}
      </Card>

      {violations.length > 0 && (
        <Card title={`Rule violations (${violations.length})`} sub="These must be fixed before this schedule can be published.">
          <ul className="space-y-1 text-[13px]">{violations.slice(0, 12).map((v, i) => <li key={i} className="flex gap-2"><Pill tone="bad">{v.type.replace(/^LAW_/, 'law: ').replace(/_/g, ' ').toLowerCase()}</Pill><span>{v.message}</span></li>)}</ul>
          {violations.length > 12 && <p className="text-[11px] text-[#737373]">and {violations.length - 12} more</p>}
        </Card>
      )}

      {warnings.length > 0 && (
        <Card title={`Labour-law warnings (${warnings.length})`} sub="These do not stop publishing, but the labour-law pack for this group asks you to look at them.">
          <ul className="space-y-1 text-[13px]">{warnings.slice(0, 12).map((v, i) => <li key={i} className="flex gap-2"><Pill tone="warn">{v.type.replace(/^LAW_/, '').replace(/_/g, ' ').toLowerCase()}</Pill><span>{v.message}</span></li>)}</ul>
          {warnings.length > 12 && <p className="text-[11px] text-[#737373]">and {warnings.length - 12} more</p>}
        </Card>
      )}

      <Card title="Roster" sub={filtering ? `Every shift in the period, filtered to ${filteredRoster.length} of ${roster.length} people. Red cells break a rule.` : 'Every shift in the period. Red cells break a rule.'}
        actions={
          <details className="relative">
            <summary className="list-none cursor-pointer flex items-center gap-1.5 px-3 py-1.5 rounded-md border border-[#E5E5E0] text-[12px] font-medium hover:bg-[#FAFAF8]"><Download className="w-3.5 h-3.5" />Export</summary>
            <div className="absolute right-0 z-30 mt-1 w-44 rounded-md border border-[#E5E5E0] bg-white p-1 shadow-lg text-[12px]">
              <button onClick={exportCsv} className="w-full text-left px-2.5 py-1.5 rounded hover:bg-[#FAFAF8]">CSV</button>
              <button onClick={exportXlsx} className="w-full text-left px-2.5 py-1.5 rounded hover:bg-[#FAFAF8]">Excel (.xlsx)</button>
              <button onClick={exportPdf} className="w-full text-left px-2.5 py-1.5 rounded hover:bg-[#FAFAF8]">PDF (print)</button>
            </div>
          </details>
        }>
        <Grid<any> rowData={filteredRoster} columnDefs={cols} defaultColDef={{ resizable: true }} loading={shifts.loading} height={Math.min(560, 90 + filteredRoster.length * 42)} />
      </Card>

      {version && <CoverageView version={version} versions={versions} day={day} days={days} setDay={jumpTo} refreshKey={key} />}
      {openEmp && <EmployeeDrawer employee={emps.data?.find((e) => e.id === openEmp) ?? null} currentVersionId={version.id} periodStart={version.periodStart} periodEnd={version.periodEnd} day={day} onClose={() => setOpenEmp(null)} />}
    </div>
  );
};
