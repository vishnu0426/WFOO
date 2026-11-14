/**
 * Scheduling › Schedule Timeline. One schedule version: how well it covers the forecast, the day as a timeline (meals and
 * breaks visible), the whole period as a roster grid, rule violations, manual edits (reason required) and publishing.
 */
import { LoadState, TableSkeleton } from '../common/loading';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ColDef } from 'ag-grid-community';
import { Download, MoreHorizontal, Plus, Redo2, Undo2 } from 'lucide-react';
import { addDays, api, PublishImpact, SavedView, Verdict, dayName, dayYear, DOW, dowOfDay, dec, Employee, isNew, ScheduleShift, ScheduleVersion, SCHED_STATUS_LABEL, ShiftTemplate, Skill, slotHHMM, when, Violation } from '../../services/api';
import { useForecast } from '../../services/forecastStore';
import { useApi } from '../forecasting/hooks';
import { Grid } from '../forecasting/Grid';
import { PersonPicker } from '../common/PersonPicker';
import { downloadXlsx } from '../../services/excel';
import { DayTimeline, type Act } from './DayTimeline';
import { WeekLanes } from './WeekLanes';
import { Popover } from '../common/Popover';
import { useEditHistory } from './editHistory';
import { EmployeeDrawer } from './EmployeeDrawer';
import { CoverageView } from './CoverageView';
import { StaleBanner } from './StaleBanner';
import { IssuesPanel } from './IssuesPanel';
import { templateLabel } from '../../services/generateFixes';
import { RosterView } from './RosterView';
import { buildRoster, matchRoster, sortRoster, type RosterSort, type RosterShow } from '../../services/rosterView';
import { gapWindows, naturalCompare, nowIn, pickOpenDay, tzLabel } from '../../services/scheduleIssues';
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
  // who is affected by publishing, shown before it happens; and the note for sending a schedule back
  const [impact, setImpact] = useState<PublishImpact | null>(null);
  const [verdict, setVerdict] = useState<Verdict | null>(null);
  const [review, setReview] = useState<{ kind: 'submit' | 'reject'; note: string } | null>(null);
  const policy = useApi<{ scheduling: { requireApproval?: boolean } }>('/config/scheduling-policy', []);
  const [nameQuery, setNameQuery] = useState('');
  const [skillFilter, setSkillFilter] = useState<string[]>([]);
  const [pending, setPending] = useState<
    | { kind: 'move'; shift: ScheduleShift; newStartTime: string }
    | { kind: 'swap'; a: ScheduleShift; b: ScheduleShift }
    | { kind: 'remove'; shift: ScheduleShift }
    | null
  >(null);
  const [pendingReason, setPendingReason] = useState('');
  const [zoom, setZoom] = useState('fit');                     // fit: the whole day across the screen, no sideways scrolling
  const [focus, setFocus] = useState(false);
  const [mode, setMode] = useState<'day' | 'week'>('day');
  const [view, setView] = useState<'timeline' | 'roster'>('timeline');
  const [rosterSort, setRosterSort] = useState<RosterSort>('name');
  const [rosterShow, setRosterShow] = useState<RosterShow>('times');
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [bulk, setBulk] = useState({ delta: '', templateId: '', reason: '' });
  const [viewsTick, setViewsTick] = useState(0);
  const views = useApi<SavedView[]>('/views?screen=schedule-timeline', [viewsTick]);
  const [viewName, setViewName] = useState<string | null>(null);
  const [pickedView, setPickedView] = useState('');
  const [density, setDensity] = useState<'comfortable' | 'compact'>(() => { try { return localStorage.getItem('wfm.timeline.density.v2') === 'comfortable' ? 'comfortable' : 'compact'; } catch { return 'compact'; } });
  const [groupTeams, setGroupTeams] = useState(() => { try { return localStorage.getItem('wfm.timeline.group') === '1'; } catch { return false; } });
  const pickDensity = (v: string) => { const d = v === 'compact' ? 'compact' : 'comfortable'; setDensity(d); try { localStorage.setItem('wfm.timeline.density.v2', d); } catch { /* private mode */ } };
  const pickGroup = (on: boolean) => { setGroupTeams(on); try { localStorage.setItem('wfm.timeline.group', on ? '1' : '0'); } catch { /* private mode */ } };
  const [problem, setProblem] = useState<'ALL' | 'UNDERSTAFFED' | 'VIOLATIONS'>('ALL');
  const [openEmp, setOpenEmp] = useState<string | null>(null);
  const [panelOpen, setPanelOpen] = useState(() => { try { return localStorage.getItem('wfm.timeline.panel') !== '0'; } catch { return true; } });
  const togglePanel = () => setPanelOpen((o) => { try { localStorage.setItem('wfm.timeline.panel', o ? '0' : '1'); } catch { /* private mode */ } return !o; });

  // a long schedule (a 13- to 52-week plan) shows four weeks at a time; a short one shows all of it
  const PAGE = 28;
  const [page, setPage] = useState(0);
  const allDays = useMemo(() => { if (!version) return []; const o: string[] = []; for (let d = version.periodStart; d <= version.periodEnd && o.length < 400; d = addDays(d, 1)) o.push(d); return o; }, [version?.id, version?.periodEnd]);
  const paged = allDays.length > 31;
  const days = useMemo(() => (paged ? allDays.slice(page * PAGE, page * PAGE + PAGE) : allDays), [allDays, page, paged]);
  const key = version ? `${version.id}-${version.rev}-${version.status}` : '';
  const full = useApi<ScheduleVersion>(version ? `/scheduling/versions/${version.id}` : null, [key]);
  const shifts = useApi<ScheduleShift[]>(version ? `/scheduling/versions/${version.id}/shifts${paged && days.length ? `?from=${days[0]}&to=${days[days.length - 1]}` : ''}` : null, [key, days[0], days.length]);
  const cov = useApi<Coverage>(version ? `/scheduling/versions/${version.id}/coverage?grain=${grain}${day ? `&day=${day}` : ''}` : null, [key, day, grain]);
  const cov15 = useApi<Coverage>(version && day ? `/scheduling/versions/${version.id}/coverage?grain=15&day=${day}` : null, [key, day]);
  // Nobody downloads the whole group here: skills come from the (short) skills list, the skill filter is answered by the server with just the ids, and the person to add or open is fetched or searched on demand.
  const skills = useApi<Skill[]>(group ? '/workforce/skills' : null);
  const tpls = useApi<ShiftTemplate[]>('/scheduling/templates');

  // the year plan can send you to a particular week
  useEffect(() => {
    if (!version) return;
    let asked: string | null = null;
    try { const f = JSON.parse(sessionStorage.getItem('wfm.focusDay') ?? 'null'); if (f?.versionId === version.id && f.day >= version.periodStart && f.day <= version.periodEnd) { asked = f.day; sessionStorage.removeItem('wfm.focusDay'); } } catch { /* ignore */ }
    // a link asks for a day; otherwise it opens on today (on the group's own clock) when today is in the schedule, else on its first day
    const target = pickOpenDay({ start: version.periodStart, end: version.periodEnd }, nowIn(group?.timezone).day, asked);
    setPage(Math.max(0, Math.floor(Math.max(0, allDays.indexOf(target)) / PAGE)));
    setDay(target); setSel(null);
  }, [version?.id]);

  // grouped into weeks starting from the schedule's own first day, so "Week 2" etc. always means the same thing
  // this version -- lets a multi-week schedule be jumped to directly instead of paged through one day at a time.
  const weeks = useMemo(() => { const o: string[][] = []; for (let i = 0; i < days.length; i += 7) o.push(days.slice(i, i + 7)); return o; }, [days]);

  const all: Violation[] = full.data?.violations ?? [];
  const violations = all.filter((v) => v.severity !== 'WARN');            // these block publishing
  const warnings = all.filter((v) => v.severity === 'WARN');              // labour-law rules set to warn only
  const badKeys = new Set(violations.map((v) => `${v.employeeId}|${v.day}`));

  const cols = useMemo<ColDef<any>[]>(() => [
    { headerName: 'Employee', field: 'name', pinned: 'left', minWidth: 170, comparator: (a: string, b: string) => naturalCompare(a ?? '', b ?? '') },
    ...days.map((d) => ({
      headerName: `${DOW[dowOfDay(d)]} ${d.slice(8)}`, field: d, width: 118, sortable: false,
      cellStyle: (p: any) => (badKeys.has(`${p.data.id}|${d}`) ? { background: '#FCEBEC', color: '#BC3F3F', fontWeight: 600 } : p.value ? { fontFamily: 'ui-monospace, monospace', fontSize: '12px' } : { color: '#A3A3A3' }),
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
    return [...m.values()].map((r) => ({ ...r, hours: Math.round(r.hours * 10) / 10 })).sort((a, b) => naturalCompare(a.name, b.name));
  }, [shifts.data]);
  const allSkills = useMemo(() => (skills.data ?? []).map((s) => [s.id, s.name] as [string, string]), [skills.data]);
  const skilled = useApi<{ id: string }[]>(group && skillFilter.length ? `/workforce/employees?groupId=${group.id}&status=ACTIVE&skillIds=${skillFilter.join(',')}&fields=ids` : null, [skillFilter.join(',')]);
  const skilledIds = useMemo(() => (skilled.data ? new Set(skilled.data.map((x) => x.id)) : null), [skilled.data]);
  const noPeople = useMemo(() => new Map<string, Employee>(), []);
  const [added, setAdded] = useState<Employee | null>(null);
  const opened = useApi<Employee>(openEmp ? `/workforce/employees/${openEmp}` : null, [openEmp]);
  const history = useEditHistory(version?.id, reload);
  const tracked = (label: string, touched: { employeeId: string; day: string }[], edit: () => Promise<void>) => history.record(label, touched, shifts.data ?? [], edit);
  useEffect(() => { setChecked(new Set()); }, [version?.id, day, mode]);

  // the workspace fills what is left of the screen below the header: the schedule and its issues panel are one view, not a box inside a page
  const wsRef = useRef<HTMLDivElement>(null);
  const tbRef = useRef<HTMLDivElement>(null);
  const [wsH, setWsH] = useState(560);
  /** The part of the page that scrolls. */
  const scrollParent = (el: HTMLElement): HTMLElement | null => {
    let p: HTMLElement | null = el.parentElement;
    while (p && !/(auto|scroll)/.test(getComputedStyle(p).overflowY)) p = p.parentElement;
    return p;
  };
  const measureWs = () => {
    const el = wsRef.current; if (!el) return;
    const p = scrollParent(el), tb = tbRef.current;
    const room = p ? p.clientHeight : window.innerHeight;
    // where the schedule sits once the page is scrolled right up under the toolbar: it never needs to be taller than that
    const rest = (p ? parseFloat(getComputedStyle(p).paddingTop) || 0 : 0) + (tb ? tb.getBoundingClientRect().height : 0) + 12;
    const top = p ? el.getBoundingClientRect().top - p.getBoundingClientRect().top : el.getBoundingClientRect().top;
    // its bottom edge stays at the bottom of the screen as the page is scrolled, so no gap opens beneath it
    const h = Math.max(360, Math.round(room - Math.max(top, rest) - 12));
    setWsH((cur) => (Math.abs(cur - h) > 1 ? h : cur));
  };
  // measured again when something above the schedule can have appeared or gone (a banner, a message), not on every draw
  useEffect(() => { measureWs(); }, [version?.id, version?.status, mode, view, day, full.data, verdict, impact, ack, review, error, add, pending]);       // eslint-disable-line react-hooks/exhaustive-deps
  // and when the screen, the toolbar or the banners above change size
  useEffect(() => {
    window.addEventListener('resize', measureWs);
    const sp = wsRef.current ? scrollParent(wsRef.current) : null;
    let raf = 0;
    const onScroll = () => { cancelAnimationFrame(raf); raf = requestAnimationFrame(measureWs); };
    sp?.addEventListener('scroll', onScroll, { passive: true });
    const ro = new ResizeObserver(measureWs);
    if (tbRef.current) ro.observe(tbRef.current);
    if (wsRef.current?.parentElement) ro.observe(wsRef.current.parentElement);
    return () => { window.removeEventListener('resize', measureWs); sp?.removeEventListener('scroll', onScroll); cancelAnimationFrame(raf); ro.disconnect(); };
  }, [!!version]);      // eslint-disable-line react-hooks/exhaustive-deps
  // the group's own clock, redrawn each minute so the "now" line moves
  const [, setMinute] = useState(0);
  useEffect(() => { const t = setInterval(() => setMinute((m) => m + 1), 60000); return () => clearInterval(t); }, []);
  const now = nowIn(group?.timezone);
  // opening a schedule on today: bring the current time into view, once, and never again after that
  const nowFocused = useRef('');
  useEffect(() => {
    if (!version || !day || shifts.data === null || nowFocused.current === version.id || view !== 'timeline' || mode !== 'day') return;
    nowFocused.current = version.id;
    if (day === nowIn(group?.timezone).day) setFocusReq({ now: true, n: ++nonce.current });
  }, [version?.id, day, shifts.data, view, mode]);          // eslint-disable-line react-hooks/exhaustive-deps
  // an issue in the panel: open its day, then scroll to the person's row and flash it
  const [focusReq, setFocusReq] = useState<{ shiftId?: string; slot?: number; now?: boolean; n: number } | null>(null);
  const [pendingFocus, setPendingFocus] = useState<{ employeeId: string; day: string } | null>(null);
  const nonce = useRef(0);
  useEffect(() => {
    if (!pendingFocus || day !== pendingFocus.day || !shifts.data || shifts.loading) return;
    const found = shifts.data.find((x) => x.employeeId === pendingFocus.employeeId && x.day === pendingFocus.day);
    setPendingFocus(null);
    if (!found) { setNotice({ kind: 'info', text: 'That person has no shift on that day, so there is nothing to show on the timeline.' }); return; }
    setSel(found); setFocusReq({ shiftId: found.id, n: ++nonce.current });
  }, [pendingFocus, day, shifts.data, shifts.loading]);          // eslint-disable-line react-hooks/exhaustive-deps

  // all hooks are above this line: the returns below must not change how many hooks run
  const dayIdx = allDays.indexOf(day);
  const dayRow = cov.data?.daily.find((d) => d.day === day);
  const goDay = (n: number) => { const i = allDays.indexOf(day) + n, d = allDays[i]; if (d) { if (paged) setPage(Math.floor(i / PAGE)); setDay(d); setSel(null); setOpenEmp(null); } };
  const jumpTo = (d: string) => { const i = allDays.indexOf(d); if (i >= 0) { if (paged) setPage(Math.floor(i / PAGE)); setDay(d); setSel(null); setOpenEmp(null); } };
  const doUndo = () => { if (!group || !version) return; if (canEdit && history.canUndo && !busy) void act(history.undo, `Undone: ${history.undoLabel}`); };
  const doRedo = () => { if (!group || !version) return; if (canEdit && history.canRedo && !busy) void act(history.redo, `Redone: ${history.redoLabel}`); };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); if (e.shiftKey) doRedo(); else doUndo(); return; }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') { e.preventDefault(); doRedo(); return; }
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
    const nameOk = !nameQuery.trim() || (employeeName ?? '').toLowerCase().includes(nameQuery.trim().toLowerCase());
    const skillOk = skillFilter.length === 0 || !skilledIds || skilledIds.has(employeeId);
    return nameOk && skillOk;
  };
  const dayShifts = (shifts.data ?? []).filter((s) => s.day === day && passesFilter(s.employeeId, s.employeeName));
  const filteredRoster = roster.filter((r) => passesFilter(r.id, r.name));
  const rosterRows = sortRoster(matchRoster(buildRoster((shifts.data ?? []).filter((x) => passesFilter(x.employeeId, x.employeeName)), badKeys), ''), rosterSort, groupTeams);
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
  const send = (path: 'publish' | 'republish', reason?: string) => act(() => sendNow(path, reason));
  const sendNow = async (path: 'publish' | 'republish', reason?: string) => {
    try { await api(`/scheduling/versions/${version.id}/${path}`, { method: 'POST', body: reason ? { acknowledgeReason: reason } : {} }); }
    catch (e: any) { if (e?.code === 'CHECKS_NOT_ACKNOWLEDGED') { setAck({ path, message: e.message, reason: reason ?? '' }); return; } throw e; }
    setAck(null); await reload(version.id);
    setImpact(null);
    setNotice({ kind: 'ok', text: path === 'publish' ? `${version.name} is published. Any older published schedule for these dates is archived.` : `${version.name} is republished with your edits.` });
  };
  const approval = version.approval ?? { state: 'NONE' as const, changedSince: false, submittedBy: null, submittedAt: null, approvedBy: null, approvedAt: null, note: null };
  const needsApproval = !!policy.data?.scheduling?.requireApproval;
  const check = () => act(async () => { setVerdict(await api<Verdict>(`/scheduling/versions/${version.id}/validate`, { method: 'POST', body: {} })); });
  const publish = () => act(async () => {
    const im = await api<PublishImpact>(`/scheduling/versions/${version.id}/impact`);
    if (im.previous.length && im.totals.people) { setImpact(im); return; }       // something is live and this changes it: say who is affected first
    await sendNow('publish');
  });
  const review1 = (step: 'submit' | 'approve' | 'reject', note?: string) => act(async () => {
    await api(`/scheduling/versions/${version.id}/${step}`, { method: 'POST', body: step === 'reject' ? { reason: note } : { note } });
    setReview(null); await reload(version.id);
  }, step === 'submit' ? 'Submitted for approval.' : step === 'approve' ? 'Approved. It can be published now.' : 'Sent back to the planner.');
  const republish = () => send('republish');
  const del = () => { if (!confirm(`Delete “${version.name}”?`)) return; act(async () => { await api(`/scheduling/versions/${version.id}`, { method: 'DELETE' }); await reload(); }, 'Schedule deleted.'); };
  const currentView = () => ({ q: nameQuery, skills: skillFilter, problem, zoom, focus, density, group: groupTeams, mode });
  const applyView = (id: string) => {
    setPickedView(id);
    const f = views.data?.find((x) => x.id === id)?.filters; if (!f) return;
    setNameQuery(typeof f.q === 'string' ? f.q : '');
    setSkillFilter(Array.isArray(f.skills) ? f.skills.filter((x: unknown): x is string => typeof x === 'string') : []);
    setProblem(f.problem === 'UNDERSTAFFED' || f.problem === 'VIOLATIONS' ? f.problem : 'ALL');
    if (typeof f.zoom === 'string' && ['fit', '15', '30', '60', '120'].includes(f.zoom)) setZoom(f.zoom);
    setFocus(!!f.focus); pickDensity(f.density === 'compact' ? 'compact' : 'comfortable'); pickGroup(!!f.group); setMode(f.mode === 'week' ? 'week' : 'day');
  };
  const saveView = () => act(async () => {
    const n = (viewName ?? '').trim(); if (!n) return;
    const r = await api<SavedView>('/views', { method: 'POST', body: { screen: 'schedule-timeline', name: n, filters: currentView() } });
    setViewsTick((t) => t + 1); setViewName(''); setPickedView(r.id);
  }, 'View saved.');
  const deleteView = (id: string = pickedView) => {
    const v = views.data?.find((x) => x.id === id);
    if (!v || !confirm(`Delete the saved view “${v.name}”?`)) return;
    void act(async () => { await api(`/views/${v.id}`, { method: 'DELETE' }); setPickedView(''); setViewsTick((t) => t + 1); }, 'View deleted.');
  };
  /** One change to every ticked shift on this day, one reason, one undo. */
  const bulkRun = (kind: 'shift' | 'template' | 'remove') => {
    const chosen = dayShifts.filter((x) => checked.has(x.id)), reason = bulk.reason.trim();
    if (!chosen.length || reason.length < 3) return;
    const mins = Number(bulk.delta);
    const label = kind === 'remove' ? `Removed ${chosen.length} shifts on ${day}` : kind === 'shift' ? `Moved ${chosen.length} shifts on ${day} by ${mins} minutes` : `Changed the shift type on ${chosen.length} shifts on ${day}`;
    void act(async () => {
      let skipped = 0, broke = '';
      await tracked(label, chosen.map((x) => ({ employeeId: x.employeeId, day: x.day })), async () => {
        for (const x of chosen) {
          if (kind === 'remove') { await api(`/scheduling/versions/${version.id}/shifts/${x.id}?reason=${encodeURIComponent(reason)}`, { method: 'DELETE' }); continue; }
          if (!x.templateId) { skipped++; continue; }
          const start = kind === 'shift' ? Math.min(Math.max(x.startSlot + Math.round(mins / 15), 0), 96 - x.lengthSlots) : x.startSlot;
          const r = await api<{ violations: Violation[] }>(`/scheduling/versions/${version.id}/shifts`, { method: 'POST', body: { employeeId: x.employeeId, day: x.day, templateId: kind === 'template' ? bulk.templateId : x.templateId, startTime: slotHHMM(start), ...(kind === 'shift' ? { lengthHours: x.lengthSlots / 4 } : {}), reason } });
          if (r.violations.length && !broke) broke = r.violations[0].message;
        }
        await reload(version.id);
      });
      setChecked(new Set()); setBulk({ delta: '', templateId: '', reason: '' });
      setNotice({ kind: broke || skipped ? 'err' : 'ok', text: `${chosen.length - skipped} shift${chosen.length - skipped === 1 ? '' : 's'} updated.${skipped ? ` ${skipped} skipped (not tied to a shift type).` : ''}${broke ? ` One now breaks a rule: ${broke}` : ''}` });
    });
  };
  const fillGap = (from: number) => {
    setError(''); setAdd({ employeeId: '', templateId: tpls.data?.find((t) => t.status === 'ACTIVE')?.id ?? '', startTime: slotHHMM(from), reason: '' });
  };
  const showPerson = (employeeId: string, onDay: string) => {
    setNameQuery(''); setSkillFilter([]); setProblem('ALL'); setFocus(false);          // a filter must not hide the person being shown
    setView('timeline'); setMode('day'); setPendingFocus({ employeeId, day: onDay });
    if (onDay !== day) jumpTo(onDay);
  };
  const focusIssue = (v: Violation) => showPerson(v.employeeId, v.day);
  const focusGap = (g: { from: number }) => { setView('timeline'); setMode('day'); setFocusReq({ slot: g.from, n: ++nonce.current }); };
  const gaps = gapWindows(cov15.data?.slots ?? []);
  const onDayCount = (shifts.data ?? []).filter((x) => x.day === day).length;
  const weekDays = weeks.find((w) => w.includes(day)) ?? [];
  const weekIdx = allDays.indexOf(weekDays[0] ?? day);
  const dayPercent = new Map((cov.data?.daily ?? []).map((d) => [d.day, d.coveragePercent] as [string, number]));

  // reasons for a move/swap/remove are collected inline below (pending/pendingReason), not with window.prompt(): a
  // native dialog is easy to trigger Chrome's "prevent this page from creating additional dialogs" with, after
  // which every further prompt() silently returns null -- indistinguishable from the action just not working.
  const removeShift = (s: ScheduleShift) => { setPendingReason(''); setPending({ kind: 'remove', shift: s }); };
  const addShift = () => add && act(async () => {
    let r: { violations: Violation[] } = { violations: [] };
    await tracked(`Added a shift on ${day}`, [{ employeeId: add.employeeId, day }], async () => {
      r = await api<{ violations: Violation[] }>(`/scheduling/versions/${version.id}/shifts`, { method: 'POST', body: { ...add, day } });
      setAdd(null); await reload(version.id);
    });
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
      act(async () => { await tracked(`Removed ${p.shift.employeeName}'s shift on ${p.shift.day}`, [{ employeeId: p.shift.employeeId, day: p.shift.day }], async () => { await api(`/scheduling/versions/${version.id}/shifts/${p.shift.id}?reason=${encodeURIComponent(reason)}`, { method: 'DELETE' }); setSel(null); await reload(version.id); }); });
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
      <div ref={tbRef} className="sticky top-0 z-30 -mx-1 px-1 py-2.5 bg-white/95 backdrop-blur border-b border-[#E5E5E0] space-y-2.5">
        {/* row 1: which schedule, and what can be done with it */}
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
          <div className="flex items-center gap-2.5 min-w-0">
            <Select value={version.id} onChange={(e) => select(e.target.value)} className="!w-auto max-w-[300px] !text-[15px] !font-semibold" aria-label="Schedule version">
              {versions.map((v) => <option key={v.id} value={v.id}>{v.status === 'PUBLISHED' ? '● ' : ''}{v.name} — {SCHED_STATUS_LABEL[v.status].toLowerCase()}{isNew(v) ? ' — NEW' : ''}</option>)}
            </Select>
            <Pill tone={version.status === 'PUBLISHED' ? 'good' : version.status === 'DRAFT' ? 'warn' : 'neutral'} title={version.status === 'ARCHIVED' ? 'Archived: a newer schedule was published.' : version.status === 'PUBLISHED' && !version.hasChanges ? 'Published. No changes since it was last published.' : undefined}>{SCHED_STATUS_LABEL[version.status]}</Pill>
            {version.status === 'PUBLISHED' && version.hasChanges && <Pill tone="warn" title="Unpublished edits are live for adherence. Republish to re-check the rules and re-stamp it.">Edited since published</Pill>}
            {draft && approval.state === 'SUBMITTED' && <Pill tone="info" title={`Submitted by ${approval.submittedBy ?? 'a planner'}`}>Waiting for approval</Pill>}
            {draft && approval.state === 'APPROVED' && <Pill tone="good" title={`Approved by ${approval.approvedBy ?? 'an approver'}`}>Approved</Pill>}
            {draft && approval.changedSince && <Pill tone="warn" title="The schedule was edited after it was submitted or approved, so that review no longer counts.">Changed since reviewed</Pill>}
            {isNew(version) && <Pill tone="info">NEW</Pill>}
            <span className="hidden 2xl:inline text-[12px] text-[#6B6B6B] truncate">{dayYear(version.periodStart)} → {dayYear(version.periodEnd)} · built on {version.coverageSource === 'MANUAL' ? 'manual coverage' : (version.forecastName ?? 'a forecast')}</span>
          </div>
          <div className="flex items-center gap-2">
            {busy && <Busy />}
            <Popover label="Saved views" badge={views.data?.length ?? 0} align="right" width={280}>
              {(close) => (
                <div className="space-y-2 text-[13px]">
                  {(views.data ?? []).length === 0 && <p className="text-[12px] text-[#6B6B6B]">No saved views yet.</p>}
                  {(views.data ?? []).map((v) => (
                    <div key={v.id} className="flex items-center gap-1">
                      <button type="button" className={`flex-1 text-left px-2 py-1 rounded hover:bg-[#FAFAF8] truncate ${pickedView === v.id ? 'font-semibold' : ''}`} onClick={() => { applyView(v.id); close(); }}>{v.name}</button>
                      <button type="button" aria-label={`Delete the view ${v.name}`} className="px-1.5 text-[#BC3F3F]" onClick={() => deleteView(v.id)}>×</button>
                    </div>
                  ))}
                  <div className="border-t border-[#E5E5E0] pt-2 flex items-center gap-1.5">
                    <Input value={viewName ?? ''} onChange={(e) => setViewName(e.target.value)} placeholder="Name the current view" aria-label="View name" />
                    <Btn variant="primary" disabled={!(viewName ?? '').trim() || busy} onClick={() => { void saveView(); close(); }}>Save</Btn>
                  </div>
                </div>
              )}
            </Popover>
            {canEdit && <Btn onClick={() => { setError(''); setAdd({ employeeId: '', templateId: tpls.data?.find((t) => t.status === 'ACTIVE')?.id ?? '', startTime: '09:00', reason: '' }); }}><Plus className="w-3.5 h-3.5" />Add shift</Btn>}
            {draft && can('schedule:read') && <Btn disabled={busy} onClick={check} title="An independent check of every rule, made separately from the scheduler">Check rules</Btn>}
            {draft && (needsApproval || approval.state !== 'NONE') && approval.state === 'NONE' && can('schedule:edit') && <Btn disabled={busy || violations.length > 0} onClick={() => setReview({ kind: 'submit', note: '' })} title={violations.length ? 'Fix the rule violations first' : 'Ask an approver to review this schedule'}>Submit for approval</Btn>}
            {draft && approval.state === 'SUBMITTED' && can('schedule:approve') && <Btn variant="success" disabled={busy} onClick={() => review1('approve')}>Approve</Btn>}
            {draft && approval.state === 'SUBMITTED' && (can('schedule:approve') || can('schedule:edit')) && <Btn disabled={busy} onClick={() => setReview({ kind: 'reject', note: '' })}>Send back</Btn>}
            {draft && can('schedule:publish') && <Btn variant="success" disabled={busy || violations.length > 0 || (needsApproval && approval.state !== 'APPROVED')} onClick={publish} title={violations.length ? 'Fix the rule violations first' : needsApproval && approval.state !== 'APPROVED' ? 'This schedule has to be approved first' : ''}>Publish</Btn>}
            {version.status === 'PUBLISHED' && version.hasChanges && can('schedule:publish') && <Btn variant="success" disabled={busy || violations.length > 0} onClick={republish} title={violations.length ? 'Fix the rule violations first' : 'Re-check the rules and re-stamp this schedule'}>Republish</Btn>}
            {(can('schedule:generate')) && (
              <Popover iconOnly ariaLabel="More actions" label={<MoreHorizontal className="w-4 h-4" />} align="right" width={190}>
                {(close) => (
                  <div className="-m-1.5 text-[13px]">
                    <button type="button" className="w-full text-left px-2.5 py-1.5 rounded hover:bg-[#FAFAF8]" onClick={() => { close(); go('generate-schedule'); }}>New schedule…</button>
                    {version.status !== 'PUBLISHED' && <button type="button" className="w-full text-left px-2.5 py-1.5 rounded hover:bg-[#FAFAF8] text-[#BC3F3F]" onClick={() => { close(); del(); }}>Delete this schedule</button>}
                  </div>
                )}
              </Popover>
            )}
          </div>
        </div>

        {/* row 2: where you are, and how you are looking at it */}
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <div role="tablist" aria-label="Schedule view" className="inline-flex h-9 rounded-md border border-[#E5E5E0] bg-white p-0.5">
            {([['timeline', 'Timeline'], ['roster', 'Roster']] as const).map(([id, label]) => (
              <button key={id} type="button" role="tab" aria-selected={view === id} data-view={id} onClick={() => setView(id)} className={`rounded px-3 text-[13px] font-medium ${view === id ? 'bg-[#171717] text-white' : 'text-[#525252] hover:bg-[#FAFAF8]'}`}>{label}</button>
            ))}
          </div>
          {view === 'timeline' && <Seg options={[{ id: 'day', label: 'Day' }, { id: 'week', label: 'Week' }]} value={mode} onChange={(v) => setMode(v === 'week' ? 'week' : 'day')} />}
          {view === 'timeline' && <div className="flex items-center gap-1.5">
            <button type="button" aria-label="Previous week" title="Previous week" disabled={weekIdx <= 0} onClick={() => jumpTo(allDays[Math.max(0, weekIdx - 7) + (dayIdx - weekIdx >= 0 ? Math.min(dayIdx - weekIdx, 6) : 0)] ?? allDays[Math.max(0, weekIdx - 7)])} className="w-8 h-8 rounded-md border border-[#E5E5E0] text-[16px] leading-none hover:bg-[#FAFAF8] disabled:opacity-35 disabled:cursor-not-allowed">‹</button>
            {mode === 'day' ? (
              <div role="group" aria-label="Days of this week" className="flex items-stretch gap-1">
                {weekDays.map((d) => {
                  const pct = dayPercent.get(d), on = d === day;
                  const tint = on ? 'bg-[#171717] text-white border-[#171717]' : pct === undefined ? 'bg-white border-[#E5E5E0] hover:bg-[#FAFAF8]' : pct >= 95 ? 'bg-[#EAF5EE] border-[#CFE6D8] hover:bg-[#DDEFE3]' : pct >= 85 ? 'bg-[#FBF3DF] border-[#EBDDB6] hover:bg-[#F7EACB]' : 'bg-[#FCEBEC] border-[#F1C9CB] hover:bg-[#F8DADB]';
                  return (
                    <button key={d} type="button" aria-pressed={on} onClick={() => jumpTo(d)} title={`${dayName(d)}${pct !== undefined ? ` · ${dec(pct, 0)}% covered` : ''}`} className={`h-9 min-w-[52px] rounded-md border px-2 text-center leading-tight ${tint}`}>
                      <div className="text-[11px] font-semibold">{DOW[dowOfDay(d)]} {d.slice(8)}</div>
                      <div className={`text-[10px] tabular-nums ${on ? 'text-white/80' : 'text-[#525252]'}`}>{pct === undefined ? '·' : `${Math.round(pct)}%`}</div>
                    </button>
                  );
                })}
              </div>
            ) : <span className="min-w-[128px] text-center text-[12px] font-semibold text-[#171717]">Week {Math.floor(Math.max(0, weekIdx) / 7) + 1} of {Math.ceil(allDays.length / 7)}</span>}
            <button type="button" aria-label="Next week" title="Next week" disabled={weekIdx < 0 || weekIdx + 7 >= allDays.length} onClick={() => jumpTo(allDays[Math.min(allDays.length - 1, weekIdx + 7 + Math.min(Math.max(dayIdx - weekIdx, 0), 6))] ?? allDays[allDays.length - 1])} className="w-8 h-8 rounded-md border border-[#E5E5E0] text-[16px] leading-none hover:bg-[#FAFAF8] disabled:opacity-35 disabled:cursor-not-allowed">›</button>
          </div>}
          {view === 'timeline' && <input type="date" value={day} min={allDays[0]} max={allDays[allDays.length - 1]} onChange={(e) => jumpTo(e.target.value)} className="px-2 py-1.5 rounded-md border border-[#E5E5E0] text-[12px]" aria-label="Jump to date" />}


          <div className="ml-auto flex items-center gap-2">
            <Popover label="View" align="right" width={250}>
              {() => (
                <div className="space-y-3 text-[12px]">
                  <div><div className="font-semibold mb-1">Row height</div><Seg options={[{ id: 'comfortable', label: 'Roomy' }, { id: 'compact', label: 'Compact' }]} value={density} onChange={pickDensity} /></div>
                  <label className="flex items-center gap-2"><input type="checkbox" checked={groupTeams} onChange={(e) => pickGroup(e.target.checked)} />Group by team</label>
                  {mode === 'day' && <label className="flex items-center gap-2" title="Only people who are on shift while the schedule is short"><input type="checkbox" checked={focus} onChange={(e) => setFocus(e.target.checked)} />Focus on understaffed times</label>}
                </div>
              )}
            </Popover>
          </div>
        </div>
      </div>
      <StaleBanner version={version} reload={reload} go={go} showQualityLink compact />
      {draft && approval.note && approval.state === 'NONE' && !approval.changedSince && <Banner kind="warn"><span className="font-semibold">Sent back:</span> {approval.note}</Banner>}
      {verdict && (
        <Banner kind={verdict.valid ? (verdict.softWarnings || verdict.coverageStatus === 'UNDERSTAFFED' ? 'warn' : 'ok') : 'err'}>
          <div className="font-semibold">{verdict.valid ? 'Every rule is met.' : `${verdict.hardViolations} rule${verdict.hardViolations === 1 ? ' is' : 's are'} broken: this schedule cannot be published.`}{' '}{verdict.coverageStatus === 'UNDERSTAFFED' ? `It is understaffed: ${verdict.underHours} person-hours short (${dec(verdict.coveragePercent, 1)}% covered).` : 'Cover meets the requirement.'}</div>
          <ul className="mt-1 text-[12px] list-disc pl-5">{verdict.findings.filter((f) => f.severity === 'HARD').slice(0, 6).map((f, i) => <li key={`h${i}`}>{f.message}</li>)}{verdict.findings.filter((f) => f.severity === 'SOFT').slice(0, 4).map((f, i) => <li key={`s${i}`} className="text-[#6B6B6B]">{f.message}</li>)}</ul>
          <div className="mt-1.5"><Btn onClick={() => setVerdict(null)}>Close</Btn></div>
        </Banner>
      )}
      {review && (
        <Banner kind="info">
          <div className="font-semibold">{review.kind === 'submit' ? 'Submit this schedule for approval' : 'Send this schedule back'}</div>
          <div className="mt-1 flex flex-wrap items-center gap-2">
            <Input className="!w-96" value={review.note} onChange={(e) => setReview({ ...review, note: e.target.value })} placeholder={review.kind === 'submit' ? 'A note for the approver (optional)' : 'Why is it sent back? The planner sees this.'} />
            <Btn variant="success" disabled={busy || (review.kind === 'reject' && review.note.trim().length < 3)} onClick={() => review1(review.kind, review.note.trim())}>{review.kind === 'submit' ? 'Submit' : 'Send back'}</Btn>
            <Btn onClick={() => setReview(null)}>Cancel</Btn>
          </div>
        </Banner>
      )}
      {impact && (
        <Banner kind={impact.totals.shortNotice ? 'warn' : 'info'}>
          <div className="font-semibold">Publishing replaces {impact.previous.map((x) => x.name).join(', ')}: {impact.totals.people} {impact.totals.people === 1 ? 'person' : 'people'} {impact.totals.people === 1 ? 'has' : 'have'} changed shifts ({impact.totals.added} added, {impact.totals.removed} removed, {impact.totals.changed} moved; {impact.totals.hoursDelta >= 0 ? '+' : ''}{impact.totals.hoursDelta} h in all).</div>
          {impact.totals.shortNotice > 0 && <div className="mt-0.5">{impact.totals.shortNotice} of the changes come with less than {impact.noticeHours} hours’ notice.</div>}
          <ul className="mt-1 text-[12px] list-disc pl-5">{impact.people.slice(0, 5).map((p) => <li key={p.employeeId}>{p.name}: {p.changes.slice(0, 2).map((c) => `${dayName(c.day)} ${c.kind === 'ADDED' ? `new ${c.to!.start}-${c.to!.end}` : c.kind === 'REMOVED' ? `${c.from!.start}-${c.from!.end} removed` : `${c.from!.start}-${c.from!.end} → ${c.to!.start}-${c.to!.end}`}${c.shortNotice ? ' (short notice)' : ''}`).join('; ')}{p.changes.length > 2 ? ` and ${p.changes.length - 2} more` : ''}</li>)}{impact.people.length > 5 && <li>and {impact.people.length - 5} more</li>}</ul>
          <div className="mt-1.5 flex flex-wrap items-center gap-2">
            <Btn variant="success" disabled={busy} onClick={() => send('publish')}>Publish and tell {impact.totals.people} {impact.totals.people === 1 ? 'person' : 'people'}</Btn>
            <Btn onClick={() => setImpact(null)}>Cancel</Btn>
          </div>
        </Banner>
      )}
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


      <div ref={wsRef} data-testid="workspace" className="flex gap-3" style={{ height: wsH }}>
        <div className="flex min-w-0 flex-1 flex-col gap-2">
          <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1.5">
            <h2 className="text-[15px] font-semibold" title={view === 'roster' ? 'Every person and every day of the period. Click a cell to open that day on the timeline.' : mode === 'week' ? 'Click a cell to open that day.' : canEdit ? 'Drag a bar to move it, or drop it on another person to swap. Click a name for their week.' : 'Click a name for their week.'}>{view === 'roster' ? `Roster (${rosterRows.length}${filtering ? ` of ${roster.length}` : ''})` : mode === 'week' ? `Week of ${dayName(weekDays[0] ?? day)}` : dayName(day)}</h2>
            {now.day >= version.periodStart && now.day <= version.periodEnd && (
              <button type="button" data-testid="now-button" onClick={() => { setView('timeline'); setMode('day'); if (day !== now.day) jumpTo(now.day); setFocusReq({ now: true, n: ++nonce.current }); }} className="h-7 rounded-md border border-[#E5E5E0] bg-white px-2.5 text-[12px] font-medium hover:bg-[#FAFAF8]" title="Go to today and the current time on the group's clock">Now</button>
            )}
            {view === 'timeline' && mode === 'day' && canEdit && dayShifts.length > 0 && (
              <button type="button" className="text-[12px] text-[#525252] underline" onClick={() => setChecked(checked.size === dayShifts.length ? new Set() : new Set(dayShifts.map((x) => x.id)))}>{checked.size === dayShifts.length ? 'Clear selection' : `Select all (${dayShifts.length})`}</button>
            )}
            <div className="ml-auto flex flex-wrap items-center gap-2">
              {view === 'roster' && (
                <>
                  <label className="flex items-center gap-1.5 text-[12px] text-[#525252]"><span className="sr-only">Sort</span>
                    <select value={rosterSort} onChange={(e) => setRosterSort(e.target.value as RosterSort)} aria-label="Sort the roster" className="h-8 rounded-md border border-[#E5E5E0] bg-white px-1.5 text-[12px]">
                      <option value="name">Name</option><option value="hours">Paid hours</option><option value="violations">Most issues first</option>
                    </select>
                  </label>
                  <Seg options={[{ id: 'times', label: 'Times' }, { id: 'hours', label: 'Hours' }]} value={rosterShow} onChange={(v) => setRosterShow(v === 'hours' ? 'hours' : 'times')} />
                  <details className="relative">
                    <summary className="list-none cursor-pointer flex h-8 items-center gap-1.5 rounded-md border border-[#E5E5E0] px-2.5 text-[12px] font-medium hover:bg-[#FAFAF8]"><Download className="w-3.5 h-3.5" />Export</summary>
                    <div className="absolute right-0 z-30 mt-1 w-44 rounded-md border border-[#E5E5E0] bg-white p-1 shadow-lg text-[12px]">
                      <button onClick={exportCsv} className="w-full text-left px-2.5 py-1.5 rounded hover:bg-[#FAFAF8]">CSV</button>
                      <button onClick={exportXlsx} className="w-full text-left px-2.5 py-1.5 rounded hover:bg-[#FAFAF8]">Excel (.xlsx)</button>
                      <button onClick={exportPdf} className="w-full text-left px-2.5 py-1.5 rounded hover:bg-[#FAFAF8]">PDF (print)</button>
                    </div>
                  </details>
                </>
              )}
              {view === 'timeline' && mode === 'day' && <Seg options={[{ id: 'fit', label: 'Fit' }, { id: '15', label: '15m' }, { id: '30', label: '30m' }, { id: '60', label: '1h' }, { id: '120', label: '2h' }]} value={zoom} onChange={setZoom} />}
              {!panelOpen && <button type="button" onClick={togglePanel} className="h-8 rounded-md border border-[#E5E5E0] px-2.5 text-[12px] font-medium hover:bg-[#FAFAF8]" title="Show the issues and details panel">Show issues</button>}
          <div className="w-44"><Input value={nameQuery} onChange={(e) => setNameQuery(e.target.value)} placeholder="Search agent name or ID" aria-label="Search agent" /></div>
          <Popover align="right" label="Filters" badge={(skillFilter.length ? 1 : 0) + (problem !== 'ALL' ? 1 : 0)} width={270}>
            {() => (
              <div className="space-y-3 text-[12px]">
                <div><div className="font-semibold mb-1">Show</div>
                  <Select value={problem} onChange={(e) => setProblem(e.target.value as 'ALL' | 'UNDERSTAFFED' | 'VIOLATIONS')} aria-label="Problem filter">
                    <option value="ALL">Everyone on shift this day ({dayShifts.length})</option>
                    <option value="UNDERSTAFFED">Understaffed window</option>
                    <option value="VIOLATIONS">With rule violations</option>
                  </Select>
                </div>
                {allSkills.length > 0 && (
                  <div><div className="font-semibold mb-1">Skills{skillFilter.length ? ` (${skillFilter.length})` : ''}</div>
                    <div className="max-h-44 overflow-auto space-y-1.5">
                      {allSkills.map(([id, name]) => <label key={id} className="flex items-center gap-2"><input type="checkbox" checked={skillFilter.includes(id)} onChange={(e) => setSkillFilter(e.target.checked ? [...skillFilter, id] : skillFilter.filter((x) => x !== id))} />{name}</label>)}
                    </div>
                  </div>
                )}
                {(filtering || problem !== 'ALL') && <button type="button" className="underline text-[#6B6B6B]" onClick={() => { setNameQuery(''); setSkillFilter([]); setProblem('ALL'); }}>Clear all filters</button>}
              </div>
            )}
          </Popover>
            </div>
          </div>
          <div className="shrink-0 space-y-2">
        {add && (
          <div id="timeline-add" className="mb-4 border border-[#E5E5E0] rounded-lg p-4 grid grid-cols-1 md:grid-cols-5 gap-4 items-end">
            <Field label="Person">
              <PersonPicker ariaLabel="Person" value={add.employeeId} groupId={group.id} status="ACTIVE" placeholder="Choose: type a name or number" onChange={(id, emp) => {
                setAdded(emp);
                const preferred = emp?.preferredTemplateId && tpls.data?.find((t) => t.id === emp.preferredTemplateId && t.status === 'ACTIVE') ? emp.preferredTemplateId : add.templateId;
                setAdd({ ...add, employeeId: id, templateId: preferred });
              }} />
            </Field>
            <Field label="Template"><Select value={add.templateId} onChange={(e) => setAdd({ ...add, templateId: e.target.value })}>{tpls.data?.filter((t) => t.status === 'ACTIVE').map((t) => <option key={t.id} value={t.id}>{templateLabel(t)}</option>)}</Select></Field>
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
        {view === 'timeline' && mode === 'day' && canEdit && checked.size > 0 && (
          <div className="mb-3 space-y-2">
            {checked.size > 0 && (
              <div className="border border-[#E5E5E0] rounded-lg bg-[#FAFAF8] p-3 flex flex-wrap items-center gap-2 text-[12px]">
                <b className="mr-1">{checked.size} selected</b>
                <Select value={bulk.delta} onChange={(e) => setBulk({ ...bulk, delta: e.target.value })} className="!w-auto" aria-label="Move starts by">
                  <option value="">Move start by…</option>
                  {[-60, -30, -15, 15, 30, 60].map((m) => <option key={m} value={m}>{m < 0 ? `${-m} min earlier` : `${m} min later`}</option>)}
                </Select>
                <Btn disabled={busy || !bulk.delta || bulk.reason.trim().length < 3} onClick={() => bulkRun('shift')}>Move</Btn>
                <Select value={bulk.templateId} onChange={(e) => setBulk({ ...bulk, templateId: e.target.value })} className="!w-auto" aria-label="Change shift to">
                  <option value="">Change shift to…</option>
                  {tpls.data?.filter((t) => t.status === 'ACTIVE').map((t) => <option key={t.id} value={t.id}>{templateLabel(t)}</option>)}
                </Select>
                <Btn disabled={busy || !bulk.templateId || bulk.reason.trim().length < 3} onClick={() => bulkRun('template')}>Change</Btn>
                <Btn disabled={busy || bulk.reason.trim().length < 3} onClick={() => { if (confirm(`Remove ${checked.size} shift${checked.size === 1 ? '' : 's'} on ${day}?`)) bulkRun('remove'); }}>Remove</Btn>
                <Input className="!w-56" value={bulk.reason} onChange={(e) => setBulk({ ...bulk, reason: e.target.value })} placeholder="Reason (required)" aria-label="Reason for the change" />
              </div>
            )}
          </div>
        )}
          </div>
          <div className={mode === 'day' || view === 'roster' ? 'min-h-0 flex-1' : 'min-h-0 flex-1 overflow-auto'}>
        {view === 'roster'
          ? (shifts.data === null ? <LoadState state={shifts} what="the roster" skeleton={<TableSkeleton rows={8} cols={4} />}>{() => null}</LoadState>
            : <RosterView rows={rosterRows} days={days} groupByTeam={groupTeams} show={rosterShow} dayPercent={dayPercent} today={day} onPick={showPerson} onOpenPerson={(id) => setOpenEmp(id)} />)
          : shifts.data === null
          ? <LoadState state={shifts} what="the day's shifts" skeleton={<TableSkeleton rows={8} cols={4} />}>{() => null}</LoadState>
          : mode === 'week'
          ? <WeekLanes shifts={(shifts.data ?? []).filter((x) => passesFilter(x.employeeId, x.employeeName))} days={weekDays} bad={badKeys} groupBy={groupTeams} compact={density === 'compact'} dayPercent={dayPercent}
              onPickDay={(d) => { jumpTo(d); setMode('day'); }} onOpen={(id) => setOpenEmp(id)} />
          : dayShifts.length === 0 && problem === 'ALL' && !focus
          ? <p className="text-[12px] text-[#6B6B6B]">{filtering ? 'No one matches the current filters on this day.' : 'Nobody is scheduled on this day.'}</p>
          : <DayTimeline fill focusReq={focusReq} now={now} clockLabel={tzLabel(group.timezone)} shifts={dayShifts} bad={badKeys} coverage={cov15.data?.slots ?? []} people={noPeople} zoom={zoom} focus={focus} problem={problem}
              canEdit={canEdit} density={density} groupBy={groupTeams} day={day} checked={checked} onFillGap={fillGap} onCheck={(id, on) => setChecked((c) => { const n = new Set(c); if (on) n.add(id); else n.delete(id); return n; })} selected={sel?.id ?? null} onSelect={(s) => setSel(s.id === sel?.id ? null : s)} onOpen={(id) => setOpenEmp(id)}
              onMoveShift={async (shift, newStartSlot, why) => {
                // the server re-places each meal and break around the new start, as it does for any shift it writes
                await tracked(`Moved ${shift.employeeName}'s shift on ${shift.day} to ${slotHHMM(newStartSlot)}`, [{ employeeId: shift.employeeId, day: shift.day }], async () => {
                  await api(`/scheduling/versions/${version!.id}/shifts`, { method: 'POST', body: { employeeId: shift.employeeId, day: shift.day, templateId: shift.templateId, startTime: slotHHMM(newStartSlot), lengthHours: shift.lengthSlots / 4, reason: why } });
                  await reload(version!.id);
                });
              }}
              onSwap={async (a, b, why) => {
                // each person takes the other's template and start; the server re-places meals and breaks and reports any rule it breaks
                let probs: Violation[] = [];
                await tracked(`Swapped ${a.employeeName} and ${b.employeeName} on ${a.day}`, [{ employeeId: a.employeeId, day: a.day }, { employeeId: b.employeeId, day: b.day }], async () => {
                  const r1 = await api<{ violations: Violation[] }>(`/scheduling/versions/${version!.id}/shifts`, { method: 'POST', body: { employeeId: a.employeeId, day: a.day, templateId: b.templateId, startTime: b.startTime, lengthHours: b.lengthSlots / 4, reason: why } });
                  const r2 = await api<{ violations: Violation[] }>(`/scheduling/versions/${version!.id}/shifts`, { method: 'POST', body: { employeeId: b.employeeId, day: b.day, templateId: a.templateId, startTime: a.startTime, lengthHours: a.lengthSlots / 4, reason: why } });
                  probs = [...r1.violations, ...r2.violations];
                  await reload(version!.id);
                });
                if (probs.length) setNotice({ kind: 'err', text: `Swapped, but it breaks a rule: ${probs[0].message}` });
                else setNotice({ kind: 'ok', text: `${a.employeeName} and ${b.employeeName} swapped shifts.` });
              }}
              onSaveActivities={async (shift, acts: Act[], why) => {
                await tracked(`Changed the activities for ${shift.employeeName} on ${shift.day}`, [{ employeeId: shift.employeeId, day: shift.day }], async () => {
                  await api(`/scheduling/versions/${version!.id}/shifts/${shift.id}/activities`, { method: 'PUT', body: { activities: acts, reason: why } });
                  await reload(version!.id);
                });
              }} />}
          </div>
        </div>
        {panelOpen && <IssuesPanel version={version} stats={stats} onDay={onDayCount} day={day} violations={violations} warnings={warnings} gaps={gaps} selected={sel} selectedIssues={sel ? all.filter((v) => v.employeeId === sel.employeeId && v.day === sel.day) : []}
          canEdit={canEdit} busy={busy} history={history} onUndo={doUndo} onRedo={doRedo} onFocusIssue={focusIssue} onFocusGap={focusGap} onFillGap={(g) => fillGap(g.from)}
          onRemove={removeShift} onOpenWeek={(id) => setOpenEmp(id)} onClearSelection={() => setSel(null)} onHide={togglePanel} />}
      </div>

      {version && <CoverageView version={version} versions={versions} day={day} days={days} setDay={jumpTo} refreshKey={key} />}
      {openEmp && <EmployeeDrawer employee={opened.data ?? null} currentVersionId={version.id} periodStart={version.periodStart} periodEnd={version.periodEnd} day={day} onClose={() => setOpenEmp(null)} />}
    </div>
  );
};
