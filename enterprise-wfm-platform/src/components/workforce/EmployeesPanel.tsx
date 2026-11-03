/**
 * Workforce › Employees. The scheduler reads everything here: contract hours, limits, group eligibility and skills.
 * CSV import always starts as a dry run that shows what would be added or changed before anything is saved.
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { PersonPicker } from '../common/PersonPicker';
import { LoginHandover, type Cred } from './LoginHandover';
import { ColDef, GridApi, ICellRendererParams, IDatasource, IGetRowsParams } from 'ag-grid-community';
import { Download, Plus, Upload } from 'lucide-react';
import { downloadXlsx, xlsxToCsv } from '../../services/excel';
import { api, apiPage, Employee, EMP_STATUS_LABEL, EmploymentType, EmployeeStatus, RotationPattern, ShiftConsistency, ShiftTemplate, Skill, slotHHMM, Team, TYPE_LABEL } from '../../services/api';
import { useForecast } from '../../services/forecastStore';
import { useApi } from '../forecasting/hooks';
import { Grid } from '../forecasting/Grid';
import { Banner, Btn, Busy, Card, Empty, Field, Input, Pill, Select, Table } from '../forecasting/ui';
import { MultiSelect } from '../common/MultiSelect';
import { BulkEdit } from './BulkEdit';

type Form = {
  employeeNumber: string; firstName: string; lastName: string; email: string; extension: string; teamId: string; primaryGroupId: string; eligibleGroupIds: string[]; status: EmployeeStatus; employmentType: EmploymentType;
  weeklyContractHours: number; maxWeeklyHours: number; workDaysPerWeek: number; minRestHours: number; maxConsecutiveDays: number; allowWeekend: boolean; allowOvernight: boolean; nightShiftConsent: boolean; skills: Record<string, number>;
  preferredTemplateId: string; shiftConsistency: ShiftConsistency; fixedStart: string;
  isSupervisor: boolean; isManager: boolean;
  reportsTo: string; reason: string; lastDay: string; leaveReason: string;
};
const blank = (groupId: string): Form => ({ employeeNumber: '', firstName: '', lastName: '', email: '', extension: '', teamId: '', primaryGroupId: groupId, eligibleGroupIds: [], status: 'ACTIVE', employmentType: 'FULL_TIME', weeklyContractHours: 40, maxWeeklyHours: 40, workDaysPerWeek: 5, minRestHours: 11, maxConsecutiveDays: 6, allowWeekend: true, allowOvernight: false, nightShiftConsent: false, skills: {}, preferredTemplateId: '', shiftConsistency: 'DEFAULT', fixedStart: '', isSupervisor: false, isManager: false, reportsTo: '', reason: '', lastDay: '', leaveReason: '' });
const fromEmployee = (e: Employee): Form => ({ employeeNumber: e.employeeNumber, firstName: e.firstName, lastName: e.lastName, email: e.email ?? '', extension: e.extension ?? '', teamId: e.teamId ?? '', primaryGroupId: e.primaryGroupId ?? '', eligibleGroupIds: e.eligibleGroupIds, status: e.status, employmentType: e.employmentType,
  weeklyContractHours: e.weeklyContractHours, maxWeeklyHours: e.maxWeeklyHours, workDaysPerWeek: e.workDaysPerWeek, minRestHours: e.minRestHours, maxConsecutiveDays: e.maxConsecutiveDays, allowWeekend: e.allowWeekend, allowOvernight: e.allowOvernight, nightShiftConsent: e.nightShiftConsent,
  skills: Object.fromEntries(e.skills.map((s) => [s.skillId, s.proficiency])), preferredTemplateId: e.preferredTemplateId ?? '', shiftConsistency: e.shiftConsistency ?? 'DEFAULT', fixedStart: e.fixedStartSlot == null ? '' : slotHHMM(e.fixedStartSlot), isSupervisor: !!e.isSupervisor, isManager: !!e.isManager, reportsTo: e.reportsTo ?? '', reason: '', lastDay: e.terminationDate ?? '', leaveReason: e.terminationReason ?? '' });

/** What was changed that needs a reason: everything but contact details, the notes for a leaver and the reason itself. */
const NO_REASON = new Set(['email', 'extension', 'reason', 'lastDay', 'leaveReason', 'skills']);
const changedFields = (a: Form | undefined, b: Form) => (a ? (Object.keys(b) as (keyof Form)[]).filter((k) => !NO_REASON.has(k) && JSON.stringify(a[k]) !== JSON.stringify(b[k])) : []);

const leavingState = (e: { form: Form; orig?: Form }) => ({ marking: e.form.status === 'TERMINATED' && e.orig?.status !== 'TERMINATED', planned: !!e.orig?.lastDay && e.orig.status !== 'TERMINATED' });

/** What recording a departure would touch, shown while someone is being marked as leaving. */
const LeavingBlock: React.FC<{ id: string; form: Form; wasLeaving: boolean; set: <K extends keyof Form>(k: K, v: Form[K]) => void }> = ({ id, form, wasLeaving, set }) => {
  const impact = useApi<{ futureShifts: number; schedules: number; pendingTimeOff: number; openSwaps: number; reports: number; logins: number; leads: string[]; lastDayHasPassed: boolean }>(form.lastDay ? `/workforce/employees/${id}/departure-impact?lastDay=${form.lastDay}` : null, [form.lastDay]);
  const i = impact.data;
  return (
    <div className="md:col-span-2 xl:col-span-4 rounded-lg border border-[#B7791F]/40 bg-[#FFF5DD]/50 p-3 space-y-2">
      <div className="text-[13px] font-semibold">{wasLeaving ? 'Leaving' : 'Marking as leaving'}</div>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3 items-start">
        <Field label="Last working day" hint="Shifts after this day are removed"><Input type="date" value={form.lastDay} onChange={(e) => set('lastDay', e.target.value)} /></Field>
        <div className="md:col-span-2"><Field label="Why are they leaving?" hint="Kept in the history"><Input value={form.leaveReason} maxLength={300} onChange={(e) => set('leaveReason', e.target.value)} placeholder="For example: resigned, contract ended" /></Field></div>
      </div>
      {form.lastDay && i && (
        <ul className="text-[12px] list-disc pl-5 space-y-0.5">
          <li>{i.futureShifts} shift{i.futureShifts === 1 ? '' : 's'} after that day {i.futureShifts === 1 ? 'is' : 'are'} removed{i.schedules ? `, from ${i.schedules} schedule${i.schedules === 1 ? '' : 's'}` : ''}.</li>
          {i.lastDayHasPassed ? <>
            <li>They are marked Terminated now, and {i.logins} login{i.logins === 1 ? ' is' : 's are'} switched off.</li>
            <li>{i.pendingTimeOff + i.openSwaps} waiting request{i.pendingTimeOff + i.openSwaps === 1 ? '' : 's'} (time off and shift changes) {i.pendingTimeOff + i.openSwaps === 1 ? 'is' : 'are'} cancelled.</li>
            <li>{i.reports} {i.reports === 1 ? 'person who reports' : 'people who report'} to them {i.reports === 1 ? 'is' : 'are'} moved to their manager.</li>
          </> : <li>They stay active, with their login, until that day. Then they are marked Terminated automatically.</li>}
          {i.leads.length > 0 && <li className="text-[#BC3F3F] font-semibold">They still lead {i.leads.join(', ')}. Choose someone else first, or this cannot be saved.</li>}
        </ul>
      )}
    </div>
  );
};
/** "08:30" to the 15-minute slot of the day the scheduler uses; null when empty. */
const slotOfTime = (t: string) => { const m = /^(\d{1,2}):(\d{2})$/.exec(t.trim()); return m ? Math.min(95, Math.floor((+m[1] * 60 + +m[2]) / 15)) : null; };
const CONSISTENCY_LABEL: Record<ShiftConsistency, string> = { DEFAULT: 'Follow the company setting', REQUIRE: 'Same start and end every day (required)', PREFER: 'Same start and end every day (preferred)', OFF: 'May vary day to day' };

const EMPLOYEE_TEMPLATE = [
  ['employee_number', 'first_name', 'last_name', 'email', 'extension', 'team', 'wfm_group', 'employment_type', 'weekly_hours', 'max_weekly_hours', 'days_per_week', 'status', 'hire_date', 'skills'],
  ['E1001', 'Asha', 'Rao', 'asha.rao@example.com', '1001', 'Alpha', 'Billing Support', 'FULL_TIME', 40, 40, 5, 'ACTIVE', '2024-03-01', 'Billing:4; Chat:3'],
  ['E1002', 'Ben', 'Cole', 'ben.cole@example.com', '1002', 'Alpha', 'Billing Support', 'PART_TIME', 20, 24, 4, 'ACTIVE', '2025-01-15', 'Billing:3'],
];
const EMPLOYEE_NOTES = [
  'Required: employee_number, first_name, last_name. Everything else is optional.',
  'team, wfm_group and skills must already exist in the system (names or codes). Replace the example values above.',
  'employment_type: FULL_TIME, PART_TIME, CONTRACTOR, TEMPORARY. status: ONBOARDING, ACTIVE, LEAVE, SUSPENDED, TERMINATED.',
  'skills: name:level pairs separated by semicolons, e.g. Billing:4; Chat:3. Delete the two example rows before importing your own people.',
  'Save as .xlsx or .csv and use Import CSV. The first sheet is read.',
];

const initialsOf = (name: string) => name.split(' ').filter(Boolean).slice(0, 2).map((w) => w[0]).join('').toUpperCase();

type Preview = {
  dryRun: boolean; rows: number; diff: { new: number; updated: number; unchanged: number }; errors: { line: number; message: string }[]; errorCount: number;
  sample: { line: number; name: string; employeeNumber: string; action: string }[]; committed: boolean;
  headers: string[]; headerSample: string[]; columnMap: Record<string, number>; mapped: boolean;
};
// matches the gateway's own HEAD aliases (workforceRoutes.ts) -- every field it can place from a column, in display order
const MAP_TARGETS: { k: string; label: string; required?: boolean }[] = [
  { k: 'employeeNumber', label: 'Employee number', required: true }, { k: 'firstName', label: 'First name', required: true }, { k: 'lastName', label: 'Last name', required: true },
  { k: 'email', label: 'Email' }, { k: 'extension', label: 'Agent extension' }, { k: 'team', label: 'Team' }, { k: 'group', label: 'WFM group' }, { k: 'employmentType', label: 'Employment type' },
  { k: 'weeklyHours', label: 'Weekly hours' }, { k: 'maxWeeklyHours', label: 'Max weekly hours' }, { k: 'daysPerWeek', label: 'Days per week' },
  { k: 'status', label: 'Status' }, { k: 'hireDate', label: 'Hire date' }, { k: 'skills', label: 'Skills' },
];

export const EmployeesPanel: React.FC = () => {
  const { groups, can, setNotice } = useForecast();
  const [tick, setTick] = useState(0);
  const [q, setQ] = useState('');
  // each filter takes several values; nothing ticked means everyone
  const [groupIds, setGroupIds] = useState<string[]>([]);
  const [teamIds, setTeamIds] = useState<string[]>([]);
  const [statuses, setStatuses] = useState<string[]>([]);
  const [skillIds, setSkillIds] = useState<string[]>([]);
  const filterKey = [q, groupIds, teamIds, statuses, skillIds].map(String).join('|');
  const anyFilter = !!(q || groupIds.length || teamIds.length || statuses.length || skillIds.length);
  // The grid asks the gateway for one block of people at a time as it scrolls (sorting and the count are done there), so a company of 50,000 never loads at once.
  const [total, setTotal] = useState<number | null>(null);
  const [loadError, setLoadError] = useState('');
  const noOne = total === 0 && !anyFilter;
  const datasource = useMemo<IDatasource>(() => ({
    getRows: (p: IGetRowsParams) => {
      const s = p.sortModel[0];
      const qs = new URLSearchParams({ limit: String(p.endRow - p.startRow), offset: String(p.startRow), ...(q ? { q } : {}), ...(groupIds.length ? { groupIds: groupIds.join(',') } : {}), ...(teamIds.length ? { teamIds: teamIds.join(',') } : {}), ...(statuses.length ? { statuses: statuses.join(',') } : {}), ...(skillIds.length ? { skillIds: skillIds.join(',') } : {}), ...(s ? { sort: s.colId, dir: s.sort } : {}) });
      apiPage<Employee>(`/workforce/employees?${qs}`)
        .then((r) => { setLoadError(''); setTotal(r.total); p.successCallback(r.rows, r.total); })
        .catch((e: any) => { setLoadError(e.message); p.failCallback(); });
    },
  // `tick` makes a new datasource after a save or import, which reloads the grid
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [filterKey, tick]);
  const teams = useApi<Team[]>('/workforce/teams?fields=pick');
  const skills = useApi<Skill[]>('/workforce/skills');
  const tpls = useApi<ShiftTemplate[]>('/scheduling/templates');
  const [edit, setEdit] = useState<{ id: string | null; form: Form; orig?: Form } | null>(null);
  const [selected, setSelected] = useState<Employee | null>(null);
  // several people ticked in the grid, to edit together
  const [picked, setPicked] = useState<Employee[]>([]);
  // "Select all matching": everyone the filters match, however many, not only the rows ticked in the grid
  const [allPicked, setAllPicked] = useState<{ id: string; name: string }[] | null>(null);
  const people = allPicked ?? picked;
  const [bulk, setBulk] = useState(false);
  const gridApi = useRef<GridApi<Employee> | null>(null);
  useEffect(() => { gridApi.current?.deselectAll(); setPicked([]); setAllPicked(null); setBulk(false); }, [filterKey]);   // never bulk-edit people a filter has hidden
  const clearPicked = () => { gridApi.current?.deselectAll(); setPicked([]); setAllPicked(null); setBulk(false); };
  const selectAllMatching = async () => {
    setError('');
    try {
      const f = new URLSearchParams({ ...(q ? { q } : {}), ...(groupIds.length ? { groupIds: groupIds.join(',') } : {}), ...(teamIds.length ? { teamIds: teamIds.join(',') } : {}), ...(statuses.length ? { statuses: statuses.join(',') } : {}), ...(skillIds.length ? { skillIds: skillIds.join(',') } : {}) });
      // every id (small, whatever the size of the company) plus the first few names to show what was chosen
      const [all, first] = await Promise.all([api<{ id: string }[]>(`/workforce/employees?${new URLSearchParams({ fields: 'ids', ...Object.fromEntries(f) })}`), apiPage<Employee>(`/workforce/employees?${new URLSearchParams({ limit: '4', ...Object.fromEntries(f) })}`)]);
      const head = first.rows.map((e) => ({ id: e.id, name: e.name }));
      const seen = new Set(head.map((h) => h.id));
      setAllPicked([...head, ...all.filter((x) => !seen.has(x.id)).map((x) => ({ id: x.id, name: '' }))]);
    } catch (e: any) { setError(e.message); }
  };
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [stopOnError, setStopOnError] = useState(false);
  const canWrite = can('workforce:write');
  const logins = useApi<{ userId: string; employeeId: string; username: string; role: string; status: string }[]>(can('users:read') ? '/self-service/logins' : null, [tick]);
  const [cred, setCred] = useState<Cred | null>(null);
  const createLogin = async (employeeId: string) => {
    setError(''); setCred(null);
    try { setCred(await api<Cred>('/self-service/logins', { method: 'POST', body: { employeeId } })); setTick((t) => t + 1); } catch (e: any) { setError(e.message); }
  };
  const resetPassword = async (userId: string) => {
    if (!confirm('Replace their current password with a new temporary one? They will need the new one to sign in next time.')) return;
    setError(''); setCred(null);
    try { setCred(await api<Cred>(`/self-service/logins/${userId}/reset-password`, { method: 'PUT', body: {} })); setTick((t) => t + 1); } catch (e: any) { setError(e.message); }
  };
  /** A fast fix for an "Unassigned" pill in the preview, without leaving it to open the full edit form. */
  const assignField = async (key: 'teamId' | 'primaryGroupId', value: string) => {
    if (!selected) return;
    setError('');
    try {
      const body: any = { [key]: value, reason: 'Assigned from the employee preview' };
      if (key === 'primaryGroupId') body.eligibleGroupIds = [...new Set([...selected.eligibleGroupIds, value])];
      const saved = await api<Employee>(`/workforce/employees/${selected.id}`, { method: 'PUT', body });
      setSelected(saved); setTick((t) => t + 1);
    } catch (e: any) { setError(e.message); }
  };

  const [csv, setCsv] = useState('');
  const [preview, setPreview] = useState<Preview | null>(null);
  const [colMap, setColMap] = useState<Record<string, number>>({});
  const [showMapper, setShowMapper] = useState(false);
  const file = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!preview) return;
    setColMap(preview.columnMap);
    if (!preview.mapped) setShowMapper(true);
  }, [preview]);

  const cols = useMemo<ColDef<Employee>[]>(() => [
    {
      headerName: 'Employee', field: 'name', minWidth: 220, pinned: 'left',
      cellRenderer: (p: ICellRendererParams<Employee>) => p.data && (
        <div className="flex items-center gap-2.5 h-full">
          <div className="w-7 h-7 rounded-full bg-[#EFEFEA] text-[#525252] text-[11px] font-semibold flex items-center justify-center shrink-0">{initialsOf(p.data.name)}</div>
          <div className="min-w-0 leading-tight">
            <div className="font-semibold truncate">{p.data.name}</div>
            <div className="text-[11px] text-[#6B6B6B] truncate">{p.data.employeeNumber}{p.data.extension ? ` · Ext ${p.data.extension}` : ''}</div>
          </div>
        </div>
      ),
    },
    { headerName: 'Team', field: 'teamName', minWidth: 130, cellRenderer: (p: ICellRendererParams<Employee>) => (p.value ? p.value : <Pill tone="warn">Unassigned</Pill>) },
    { headerName: 'WFM group', field: 'primaryGroupName', minWidth: 150, cellRenderer: (p: ICellRendererParams<Employee>) => (p.value ? p.value : <Pill tone="warn">Unassigned</Pill>) },
    { headerName: 'Type', field: 'employmentType', valueFormatter: (p) => TYPE_LABEL[p.value as EmploymentType], width: 110 },
    { headerName: 'Contract', field: 'weeklyContractHours', type: 'rightAligned', width: 100, valueFormatter: (p) => `${p.value}h` },
    { headerName: 'Skills', sortable: false, valueGetter: (p) => p.data?.skills.map((s) => `${s.name} ${s.proficiency}`).join(', ') ?? '', minWidth: 160, flex: 1 },
    { headerName: 'Shift times', sortable: false, width: 150, valueGetter: (p) => { const e = p.data; if (!e) return ''; return [e.fixedStartSlot != null ? `starts ${slotHHMM(e.fixedStartSlot)}` : '', e.shiftConsistency === 'REQUIRE' ? 'steady' : e.shiftConsistency === 'PREFER' ? 'steady if possible' : e.shiftConsistency === 'OFF' ? 'varies' : ''].filter(Boolean).join(', ') || 'company setting'; }, cellStyle: { color: '#525252' } },
    { headerName: 'Status', field: 'status', valueFormatter: (p) => EMP_STATUS_LABEL[p.value as EmployeeStatus], width: 120, cellStyle: (p) => (p.value === 'ACTIVE' ? { color: '#2A7553', fontWeight: 600 } : { color: '#737373' }) },
  ], []);

  const save = async () => {
    if (!edit) return;
    setBusy(true); setError('');
    const f = edit.form;
    try {
      const body = {
        employeeNumber: f.employeeNumber.trim(), firstName: f.firstName.trim(), lastName: f.lastName.trim(), email: f.email.trim() || null, extension: f.extension.trim() || null, teamId: f.teamId || null, primaryGroupId: f.primaryGroupId || null,
        eligibleGroupIds: [...new Set([...f.eligibleGroupIds, ...(f.primaryGroupId ? [f.primaryGroupId] : [])])], status: f.status, employmentType: f.employmentType, weeklyContractHours: f.weeklyContractHours,
        maxWeeklyHours: f.maxWeeklyHours, workDaysPerWeek: f.workDaysPerWeek, minRestHours: f.minRestHours, maxConsecutiveDays: f.maxConsecutiveDays, allowWeekend: f.allowWeekend, allowOvernight: f.allowOvernight, nightShiftConsent: f.nightShiftConsent,
        preferredTemplateId: f.preferredTemplateId || null, shiftConsistency: f.shiftConsistency, fixedStartSlot: slotOfTime(f.fixedStart), isSupervisor: f.isSupervisor, isManager: f.isManager, reportsTo: f.reportsTo || null,
        ...(edit.id ? { reason: f.reason.trim() || undefined } : {}),
        ...(f.status === 'TERMINATED' && edit.orig?.status !== 'TERMINATED' ? { terminationDate: f.lastDay || null, terminationReason: f.leaveReason.trim() || null } : {}),
      };
      const saved = edit.id ? await api<Employee>(`/workforce/employees/${edit.id}`, { method: 'PUT', body }) : await api<Employee>('/workforce/employees', { method: 'POST', body });
      await api(`/workforce/employees/${saved.id}/skills`, { method: 'PUT', body: { skills: Object.entries(f.skills).map(([skillId, proficiency]) => ({ skillId, proficiency })) } });
      const d = (saved as any).departure as { futureShifts: number; schedules: number; logins: number; pendingTimeOff: number; openSwaps: number; scheduled: boolean; lastDay: string } | undefined;
      setNotice({ kind: 'ok', text: d ? (d.scheduled ? `${saved.name} is leaving after ${d.lastDay}: ${d.futureShifts} later shift${d.futureShifts === 1 ? '' : 's'} removed. They are marked Terminated automatically on that day.` : `${saved.name} has left: ${d.futureShifts} later shift${d.futureShifts === 1 ? '' : 's'} removed from ${d.schedules} schedule${d.schedules === 1 ? '' : 's'}, ${d.logins} login${d.logins === 1 ? '' : 's'} switched off, ${d.pendingTimeOff + d.openSwaps} waiting request${d.pendingTimeOff + d.openSwaps === 1 ? '' : 's'} cancelled.`) : `${saved.name} saved.` });
      setEdit(null); setTick((t) => t + 1);
    } catch (e: any) { setError(e.message); } finally { setBusy(false); }
  };
  const remove = async () => {
    if (!edit?.id || !confirm('Delete this employee? This cannot be undone.')) return;
    try { await api(`/workforce/employees/${edit.id}`, { method: 'DELETE' }); setEdit(null); setTick((t) => t + 1); } catch (e: any) { setError(e.message); }
  };

  const check = async (f: File) => {
    setBusy(true); setError(''); setPreview(null); setShowMapper(false);
    try { const text = /\.xlsx$/i.test(f.name) ? await xlsxToCsv(f) : await f.text(); setCsv(text); setPreview(await api<Preview>('/workforce/employees/import', { method: 'POST', body: { csv: text, dryRun: true } })); }
    catch (e: any) { setError(e.message); } finally { setBusy(false); if (file.current) file.current.value = ''; }
  };
  /** Re-runs the dry run against a column mapping -- a header dragged onto a target, or one cleared back to "not mapped". */
  const recheck = async (map: Record<string, number>) => {
    setBusy(true); setError('');
    try { setPreview(await api<Preview>('/workforce/employees/import', { method: 'POST', body: { csv, dryRun: true, columnMap: Object.fromEntries(Object.entries(map).filter(([, v]) => v >= 0)) } })); }
    catch (e: any) { setError(e.message); } finally { setBusy(false); }
  };
  const mapTo = (key: string, colIndex: number) => { const next = { ...colMap, [key]: colIndex }; setColMap(next); recheck(next); };
  const commit = async () => {
    setBusy(true); setError('');
    try {
      const r = await api<Preview>('/workforce/employees/import', { method: 'POST', body: { csv, dryRun: false, stopOnError, columnMap: Object.fromEntries(Object.entries(colMap).filter(([, v]) => v >= 0)) } });
      setNotice({ kind: 'ok', text: `Imported: ${r.diff.new} added, ${r.diff.updated} changed${r.errorCount ? `, ${r.errorCount} skipped because of problems` : ''}.` }); setPreview(null); setCsv(''); setTick((t) => t + 1);
    } catch (e: any) { setError(e.message); } finally { setBusy(false); }
  };

  const set = <K extends keyof Form>(k: K, v: Form[K]) => setEdit((s) => s && { ...s, form: { ...s.form, [k]: v } });
  const num = (k: keyof Form) => (e: React.ChangeEvent<HTMLInputElement>) => set(k, Number(e.target.value) as never);

  return (
    <div className="space-y-6">
      <Card
        title="Employees"
        sub="Everyone the scheduler can place. Limits here (weekly hours, rest, days in a row) are never broken by a generated schedule."
        actions={canWrite && <>
          <input ref={file} type="file" accept=".xlsx,.csv,text/csv" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) check(f); }} />
          <Btn onClick={() => downloadXlsx('employees-template.xlsx', 'Employees', EMPLOYEE_TEMPLATE, EMPLOYEE_NOTES).catch((e) => setError(e.message))}><Download className="w-3.5 h-3.5" />Excel template</Btn>
          <Btn onClick={() => file.current?.click()}><Upload className="w-3.5 h-3.5" />Import CSV</Btn>
          <Btn variant="primary" onClick={() => { setError(''); setEdit({ id: null, form: blank(groupIds[0] || groups[0]?.id || '') }); }}><Plus className="w-3.5 h-3.5" />Add employee</Btn>
        </>}
      >
        {error && <Banner kind="err" onClose={() => setError('')}>{error}</Banner>}
        {busy && <Busy />}

        {preview && (
          <div className="border border-[#E5E5E0] rounded-lg p-4 bg-[#FAFAF8] space-y-3">
            <div className="flex flex-wrap items-center gap-4 text-[13px]">
              <b>Check before importing</b>
              {preview.mapped && <>
                <span className="text-[#2A7553] font-semibold">{preview.diff.new} new</span>
                <span className="text-[#8F6200] font-semibold">{preview.diff.updated} changed</span>
                <span className="text-[#6B6B6B]">{preview.diff.unchanged} unchanged</span>
                <span className={preview.errorCount ? 'text-[#BC3F3F] font-semibold' : 'text-[#6B6B6B]'}>{preview.errorCount} problems</span>
              </>}
              <button className="ml-auto text-[12px] underline text-[#525252]" onClick={() => setShowMapper((s) => !s)}>{showMapper ? 'Hide column mapping' : 'Edit column mapping'}</button>
            </div>
            {!preview.mapped && <Banner kind="warn">This file's columns don't match the usual names. Drag each column onto what it is below -- employee number, first name and last name are required.</Banner>}

            {showMapper && (
              <div className="border border-[#E5E5E0] rounded-lg bg-white p-3 space-y-3">
                <div className="text-[11px] font-semibold uppercase tracking-wider text-[#6B6B6B]">From this file, drag a column onto what it is</div>
                <div className="flex flex-wrap gap-2">
                  {preview.headers.map((h, i) => {
                    const used = MAP_TARGETS.some((t) => colMap[t.k] === i);
                    return (
                      <div key={i} draggable onDragStart={(e) => e.dataTransfer.setData('text/plain', String(i))}
                        className={`cursor-grab active:cursor-grabbing rounded-md border px-2.5 py-1.5 text-[12px] ${used ? 'border-[#D6D6D0] bg-[#FAFAF8] text-[#6B6B6B]' : 'border-[#E5E5E0] bg-white'}`}>
                        <div className="font-semibold">{h || `(column ${i + 1})`}</div>
                        {preview.headerSample[i] && <div className="text-[11px] text-[#6B6B6B] truncate max-w-40">{preview.headerSample[i]}</div>}
                      </div>
                    );
                  })}
                </div>
                <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
                  {MAP_TARGETS.map((t) => {
                    const idx = colMap[t.k];
                    const filled = idx !== undefined && idx >= 0;
                    return (
                      <div key={t.k} onDragOver={(e) => e.preventDefault()} onDrop={(e) => { e.preventDefault(); mapTo(t.k, Number(e.dataTransfer.getData('text/plain'))); }}
                        className={`rounded-md border-2 border-dashed px-2.5 py-1.5 text-[12px] min-h-13 ${filled ? 'border-[#2F7D5A] bg-[#EAF5EF]' : t.required ? 'border-[#D6A3A3] bg-[#FDF3F3]' : 'border-[#E5E5E0] bg-[#FAFAF8]'}`}>
                        <div className="flex items-center justify-between gap-1">
                          <span className="font-semibold">{t.label}{t.required ? ' *' : ''}</span>
                          {filled && <button className="text-[#6B6B6B] hover:text-[#BC3F3F]" onClick={() => mapTo(t.k, -1)}>×</button>}
                        </div>
                        <div className="text-[#525252] truncate">{filled ? (preview.headers[idx] || `column ${idx + 1}`) : 'drop a column here'}</div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {preview.mapped && preview.errors.length > 0 && (
              <>
                <Banner kind="warn">{stopOnError ? `${preview.errorCount} rows have a problem, so nothing will be imported until they are fixed.` : `These ${preview.errorCount} rows won't be imported. Everything else will be. Fix these in the file and import again afterwards to add them too.`}</Banner>
                <Table head={['Line', 'Problem']}>{preview.errors.slice(0, 15).map((e, i) => <tr key={i}><td className="p-2.5 font-mono text-[#6B6B6B]">{e.line}</td><td className="p-2.5">{e.message}</td></tr>)}</Table>
              </>
            )}
            <p className="text-[11px] text-[#6B6B6B]">Columns: employee_number, first_name, last_name (required); team, wfm_group, employment_type, weekly_hours, max_weekly_hours, days_per_week, status, hire_date, skills (e.g. Billing:4; Chat:3). Teams, groups and skills must already exist.</p>
            <label className="flex items-center gap-2 text-[12px] text-[#525252]"><input type="checkbox" checked={stopOnError} onChange={(e) => setStopOnError(e.target.checked)} />Stop if any row has a problem (import nothing until the file is clean)</label>
            <div className="flex gap-2">
              <Btn variant="primary" disabled={busy || !preview.mapped || preview.diff.new + preview.diff.updated === 0 || (stopOnError && preview.errorCount > 0)} onClick={commit}>
                Import {preview.diff.new + preview.diff.updated} people{preview.errorCount > 0 && !stopOnError ? ` (${preview.errorCount} skipped)` : ''}
              </Btn>
              <Btn onClick={() => { setPreview(null); setCsv(''); setShowMapper(false); }}>Cancel</Btn>
            </div>
          </div>
        )}

        {edit && (
          <div className="border border-[#E5E5E0] rounded-lg p-4 space-y-4">
            <h3 className="text-[14px] font-semibold">{edit.id ? 'Edit employee' : 'New employee'}</h3>
            {edit.id && can('users:write') && (() => {
              const l = logins.data?.find((x) => x.employeeId === edit.id);
              return (
                <div className="flex flex-wrap items-center gap-3 text-[12px] p-2.5 rounded bg-[#FAFAF8] border border-[#E5E5E0]">
                  <span className="font-semibold">App login</span>
                  {l ? <span className="text-[#525252]">Signs in as <b>{l.username}</b> ({l.status.toLowerCase()}) &mdash; works for the mobile app and the employee web portal</span> : <span className="text-[#6B6B6B]">None yet. They cannot use the mobile app or the employee web portal until you create one.</span>}
                  {!l && <Btn onClick={() => createLogin(edit.id!)}>Create app login</Btn>}
                  {l && <Btn onClick={() => resetPassword(l.userId)}>Reset password</Btn>}
                  {cred && <div className="basis-full"><LoginHandover cred={cred} reset={cred.username === l?.username} /></div>}
                </div>
              );
            })()}
            {edit.id && <AssignmentsSection employeeId={edit.id} groupId={edit.form.primaryGroupId || null} />}
            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-4">
              <Field label="Employee number"><Input value={edit.form.employeeNumber} onChange={(e) => set('employeeNumber', e.target.value)} /></Field>
              <Field label="First name"><Input value={edit.form.firstName} onChange={(e) => set('firstName', e.target.value)} /></Field>
              <Field label="Last name"><Input value={edit.form.lastName} onChange={(e) => set('lastName', e.target.value)} /></Field>
              <Field label="Email"><Input type="email" value={edit.form.email} onChange={(e) => set('email', e.target.value)} /></Field>
              <Field label="Agent extension" hint="Phone/softphone extension on the ACD"><Input value={edit.form.extension} onChange={(e) => set('extension', e.target.value)} /></Field>
              <div className="md:col-span-2 xl:col-span-4 rounded-lg border border-[#E5E5E0] bg-[#FAFAF8] p-3 space-y-1.5">
                <div className="flex flex-wrap gap-x-6 gap-y-1.5">
                  <label className="flex items-center gap-2 text-[13px] font-semibold"><input type="checkbox" checked={edit.form.isSupervisor} onChange={(e) => set('isSupervisor', e.target.checked)} />Is a supervisor</label>
                  <label className="flex items-center gap-2 text-[13px] font-semibold"><input type="checkbox" checked={edit.form.isManager} onChange={(e) => set('isManager', e.target.checked)} />Is a manager</label>
                </div>
                <p className="text-[12px] text-[#6B6B6B]">This only says they can be chosen as a team's supervisor or a WFM group's manager. It gives them no access: that comes from the role on their login.</p>
                {edit.id && (() => {
                  const leads = (teams.data ?? []).filter((t) => t.managerId === edit.id), deputies = (teams.data ?? []).filter((t) => t.deputyId === edit.id);
                  const runs = groups.filter((g) => g.managerId === edit.id);
                  return leads.length + deputies.length + runs.length > 0 ? (
                    <p className="text-[12px] text-[#171717]">
                      {leads.length > 0 && <>Supervises <b>{leads.map((t) => t.name).join(', ')}</b>. </>}
                      {deputies.length > 0 && <>Deputy for <b>{deputies.map((t) => t.name).join(', ')}</b>. </>}
                      {runs.length > 0 && <>Manages <b>{runs.map((g) => g.name).join(', ')}</b>. </>}
                      <span className="text-[#6B6B6B]">Choose someone else for these before unticking.</span>
                    </p>
                  ) : null;
                })()}
                {edit.id && (edit.form.isSupervisor || edit.form.isManager) && !(logins.data ?? []).some((l) => l.employeeId === edit.id) && <p className="text-[12px] text-[#B7791F]">They have no app login yet, so they cannot sign in to act as a {edit.form.isManager ? 'manager' : 'supervisor'}. Create one below, and give it the role they need on the Users and Roles screen.</p>}
              </div>
              <Field label="Reports to" hint="Their manager or supervisor, for the org chart"><PersonPicker ariaLabel="Reports to" value={edit.form.reportsTo} statuses="ONBOARDING,ACTIVE,LEAVE" placeholder="Choose who they report to" onChange={(id) => set('reportsTo', id)} /></Field>
              <Field label="Team"><Select value={edit.form.teamId} onChange={(e) => set('teamId', e.target.value)}><option value="">No team</option>{teams.data?.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</Select></Field>
              <Field label="Main WFM group" hint="They are always eligible for it"><Select value={edit.form.primaryGroupId} onChange={(e) => set('primaryGroupId', e.target.value)}><option value="">None</option>{groups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}</Select></Field>
              <Field label="Status"><Select value={edit.form.status} onChange={(e) => set('status', e.target.value as EmployeeStatus)}>{Object.entries(EMP_STATUS_LABEL).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</Select></Field>
              <Field label="Employment type"><Select value={edit.form.employmentType} onChange={(e) => set('employmentType', e.target.value as EmploymentType)}>{Object.entries(TYPE_LABEL).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</Select></Field>
              <Field label="Contract hours / week" hint="The schedule aims for at least this"><Input type="number" min={0} max={80} value={edit.form.weeklyContractHours} onChange={num('weeklyContractHours')} /></Field>
              <Field label="Maximum hours / week" hint="Never exceeded"><Input type="number" min={1} max={84} value={edit.form.maxWeeklyHours} onChange={num('maxWeeklyHours')} /></Field>
              <Field label="Days per week (max)"><Input type="number" min={1} max={7} value={edit.form.workDaysPerWeek} onChange={num('workDaysPerWeek')} /></Field>
              <Field label="Rest between shifts (h)"><Input type="number" min={0} max={24} step={0.5} value={edit.form.minRestHours} onChange={num('minRestHours')} /></Field>
              <Field label="Days in a row (max)"><Input type="number" min={1} max={14} value={edit.form.maxConsecutiveDays} onChange={num('maxConsecutiveDays')} /></Field>
              <Field label="Weekends"><Select value={edit.form.allowWeekend ? 'y' : 'n'} onChange={(e) => set('allowWeekend', e.target.value === 'y')}><option value="y">Can work weekends</option><option value="n">Weekdays only</option></Select></Field>
              <Field label="Overnight shifts"><Select value={edit.form.allowOvernight ? 'y' : 'n'} onChange={(e) => set('allowOvernight', e.target.value === 'y')}><option value="n">No</option><option value="y">Allowed</option></Select></Field>
              <Field label="Night work consent" hint="Some labour laws allow night hours only with the person's consent"><Select value={edit.form.nightShiftConsent ? 'y' : 'n'} onChange={(e) => set('nightShiftConsent', e.target.value === 'y')}><option value="n">Not given</option><option value="y">Consented</option></Select></Field>
              <Field label="Preferred shift template" hint="Pre-fills the template when adding this person's shift by hand. Does not constrain the generator."><Select value={edit.form.preferredTemplateId} onChange={(e) => set('preferredTemplateId', e.target.value)}><option value="">None</option>{tpls.data?.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</Select></Field>
              <Field label="Same start and end time" hint="Logs in at one usual time for the whole schedule. Overrides the company setting for this person."><Select value={edit.form.shiftConsistency} onChange={(e) => set('shiftConsistency', e.target.value as ShiftConsistency)}>{(Object.keys(CONSISTENCY_LABEL) as ShiftConsistency[]).map((k) => <option key={k} value={k}>{CONSISTENCY_LABEL[k]}</option>)}</Select></Field>
              <Field label="Assigned start time" hint="Optional. Always starts at this time (within the company tolerance); leave empty to let the scheduler choose."><Input type="time" step={900} value={edit.form.fixedStart} onChange={(e) => set('fixedStart', e.target.value)} /></Field>
            </div>
            <div>
              <div className="text-[12px] font-semibold mb-1.5">Can also be scheduled for</div>
              <div className="flex flex-wrap gap-3 text-[13px]">
                {groups.filter((g) => g.id !== edit.form.primaryGroupId).map((g) => (
                  <label key={g.id} className="flex items-center gap-1.5"><input type="checkbox" checked={edit.form.eligibleGroupIds.includes(g.id)} onChange={(e) => set('eligibleGroupIds', e.target.checked ? [...edit.form.eligibleGroupIds, g.id] : edit.form.eligibleGroupIds.filter((x) => x !== g.id))} />{g.name}</label>
                ))}
                {groups.length <= 1 && <span className="text-[12px] text-[#6B6B6B]">No other groups.</span>}
              </div>
            </div>
            <div>
              <div className="text-[12px] font-semibold mb-1.5">Skills and level (1 beginner, 5 expert)</div>
              {skills.data?.length === 0 ? <span className="text-[12px] text-[#6B6B6B]">No skills defined yet. Add some under Skills.</span> : (
                <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-2">
                  {skills.data?.filter((s) => s.status === 'ACTIVE').map((s) => (
                    <div key={s.id} className="flex items-center gap-2 text-[13px]">
                      <input type="checkbox" checked={s.id in edit.form.skills} onChange={(e) => { const next = { ...edit.form.skills }; if (e.target.checked) next[s.id] = 3; else delete next[s.id]; set('skills', next); }} />
                      <span className="flex-1">{s.name}</span>
                      <select disabled={!(s.id in edit.form.skills)} value={edit.form.skills[s.id] ?? 3} onChange={(e) => set('skills', { ...edit.form.skills, [s.id]: Number(e.target.value) })} className="border border-[#E5E5E0] rounded p-1 text-[12px] disabled:opacity-40">{[1, 2, 3, 4, 5].map((n) => <option key={n}>{n}</option>)}</select>
                    </div>
                  ))}
                </div>
              )}
            </div>
            {edit.id && (leavingState(edit).marking || leavingState(edit).planned) && (
              <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-4"><LeavingBlock id={edit.id} form={edit.form} wasLeaving={leavingState(edit).planned} set={set} /></div>
            )}
            {edit.id && (() => {
              const changed = changedFields(edit.orig, edit.form).length > 0 || (leavingState(edit).planned && !edit.form.lastDay);
              return changed ? (
                <div className="max-w-xl"><Field label="Why are you changing this?" hint="Kept in the history with your name. Needed for anything except contact details."><Input value={edit.form.reason} maxLength={300} onChange={(e) => set('reason', e.target.value)} placeholder="For example: moved to part time at their request" /></Field></div>
              ) : null;
            })()}
            <div className="flex items-center gap-2">
              <Btn variant="primary" disabled={busy || !edit.form.employeeNumber.trim() || !edit.form.firstName.trim() || !edit.form.lastName.trim()
                || (!!edit.id && (changedFields(edit.orig, edit.form).length > 0) && edit.form.reason.trim().length < 3)
                || (!!edit.id && leavingState(edit).marking && (!edit.form.lastDay || edit.form.leaveReason.trim().length < 3))} onClick={save}>Save employee</Btn>
              <Btn onClick={() => setEdit(null)}>Cancel</Btn>
              {edit.id && <button className="ml-auto text-[12px] text-[#BC3F3F] underline" onClick={remove}>Delete</button>}
            </div>
          </div>
        )}

        <div className="flex flex-wrap gap-2">
          <Input placeholder="Search name or number" value={q} onChange={(e) => setQ(e.target.value)} className="!w-56" />
          <MultiSelect ariaLabel="WFM groups" allLabel="All groups" noun={['group', 'groups']} value={groupIds} onChange={setGroupIds} options={groups.map((g) => ({ value: g.id, label: g.name }))} />
          <MultiSelect ariaLabel="Teams" allLabel="All teams" noun={['team', 'teams']} value={teamIds} onChange={setTeamIds} options={(teams.data ?? []).map((t) => ({ value: t.id, label: t.name }))} />
          <MultiSelect ariaLabel="Status" allLabel="Any status" noun={['status', 'statuses']} value={statuses} onChange={setStatuses} options={Object.entries(EMP_STATUS_LABEL).map(([k, l]) => ({ value: k, label: l }))} />
          <span title="People who have every skill you tick"><MultiSelect ariaLabel="Skills (has all)" allLabel="Any skills" noun={['skill', 'skills']} value={skillIds} onChange={setSkillIds} options={(skills.data ?? []).filter((k) => k.status === 'ACTIVE').map((k) => ({ value: k.id, label: k.name }))} /></span>
          {anyFilter && <button className="text-[12px] underline text-[#525252] self-center" onClick={() => { setQ(''); setGroupIds([]); setTeamIds([]); setStatuses([]); setSkillIds([]); }}>Clear filters</button>}
          <Pill>{(total ?? 0).toLocaleString('en-US')} {total === 1 ? 'person' : 'people'}</Pill>
          {people.length > 0 && (
            <div className="flex flex-wrap items-center gap-2 ml-auto text-[13px]">
              <span className="font-semibold">{allPicked ? `All ${allPicked.length.toLocaleString('en-US')} matching selected` : `${picked.length} selected`}</span>
              {!allPicked && (total ?? 0) > picked.length && <button className="underline text-[#525252]" onClick={selectAllMatching}>Select all {(total ?? 0).toLocaleString('en-US')} matching</button>}
              {canWrite && <Btn variant="primary" onClick={() => { setError(''); setSelected(null); setBulk(true); }}>Edit selected</Btn>}
              <Btn onClick={clearPicked}>Clear selection</Btn>
            </div>
          )}
        </div>
        {bulk && people.length > 0 && (
          <BulkEdit people={people} groups={groups} teams={teams.data ?? []} skills={skills.data ?? []} templates={(tpls.data ?? []).filter((t) => t.status === 'ACTIVE')}
            onCancel={() => setBulk(false)} onDone={(text) => { setNotice({ kind: 'ok', text }); clearPicked(); setTick((t) => t + 1); }} />
        )}
        {loadError && <Banner kind="err" onClose={() => setLoadError('')}>{loadError}</Banner>}
        {noOne && <Empty title="No employees yet">{canWrite ? 'Add people one by one, or import a CSV.' : 'Ask an administrator to add people.'} Create WFM groups and teams first so each person can be assigned.</Empty>}
        <div className={noOne ? 'hidden' : ''}>{/* stays mounted when empty, so it fetches again after the first person is added */}
          <Grid<Employee> rowModelType="infinite" datasource={datasource} cacheBlockSize={100} maxBlocksInCache={20} columnDefs={cols} defaultColDef={{ sortable: true, resizable: true, suppressHeaderMenuButton: true }} height={460}
              rowSelection={canWrite ? { mode: 'multiRow', checkboxes: true, headerCheckbox: false, enableClickSelection: false } : undefined}
              getRowId={(p) => p.data.id} onGridReady={(e) => { gridApi.current = e.api; }}
              onSelectionChanged={(e) => setPicked(e.api.getSelectedRows())}
              onRowClicked={(e) => { if (e.data && !(e.event?.target as HTMLElement | null)?.closest?.('.ag-selection-checkbox, .ag-header-select-all')) setSelected(e.data); }} rowStyle={{ cursor: 'pointer' }} />
        </div>
      </Card>

      {selected && (
        <aside className="fixed inset-y-0 right-0 z-40 w-[420px] bg-white border-l border-[#E5E5E0] shadow-xl overflow-y-auto">
          <div className="flex items-center gap-3 p-4 border-b border-[#E5E5E0]">
            <div className="w-10 h-10 rounded-full bg-[#EFEFEA] text-[#525252] flex items-center justify-center text-[13px] font-semibold shrink-0">{initialsOf(selected.name)}</div>
            <div className="flex-1 min-w-0">
              <div className="font-semibold truncate">{selected.name}</div>
              <div className="text-[11px] text-[#6B6B6B] font-mono truncate">{selected.employeeNumber}{selected.extension ? ` · Ext ${selected.extension}` : ''}</div>
            </div>
            {canWrite && <Btn onClick={() => { setError(''); setEdit({ id: selected.id, form: fromEmployee(selected), orig: fromEmployee(selected) }); setSelected(null); }}>Edit</Btn>}
            <button aria-label="Close" className="text-[#6B6B6B] hover:text-[#171717] text-[18px] leading-none px-2" onClick={() => setSelected(null)}>×</button>
          </div>
          <div className="p-4 space-y-5 text-[13px]">
            <div className="flex items-center gap-2">
              <Pill tone={selected.status === 'ACTIVE' ? 'good' : selected.status === 'TERMINATED' || selected.status === 'SUSPENDED' ? 'bad' : 'neutral'}>{EMP_STATUS_LABEL[selected.status]}</Pill>
              <span className="text-[#6B6B6B]">{TYPE_LABEL[selected.employmentType]}</span>
            </div>

            <PreviewSection title="Assignment">
              <AssignRow label="Team" value={selected.teamName} canWrite={canWrite} options={teams.data ?? []}
                onAssign={(id) => assignField('teamId', id)} />
              <AssignRow label="WFM group" value={selected.primaryGroupName} canWrite={canWrite} options={groups}
                onAssign={(id) => assignField('primaryGroupId', id)} />
            </PreviewSection>

            <PreviewSection title="Contact">
              <PreviewRow label="Email" value={selected.email ?? '–'} />
              <PreviewRow label="Agent extension" value={selected.extension ?? '–'} />
            </PreviewSection>

            <PreviewSection title="Contract">
              <PreviewRow label="Hours" value={`${selected.weeklyContractHours}h / week (max ${selected.maxWeeklyHours}h)`} />
              <PreviewRow label="Days per week" value={String(selected.workDaysPerWeek)} />
              <PreviewRow label="Start and end times" value={`${CONSISTENCY_LABEL[selected.shiftConsistency ?? 'DEFAULT']}${selected.fixedStartSlot != null ? `, starts ${slotHHMM(selected.fixedStartSlot)}` : ''}`} />
            </PreviewSection>

            <PreviewSection title="Skills">
              {selected.skills.length === 0 ? <div className="text-[#6B6B6B]">None</div> : (
                <div className="flex flex-wrap gap-1.5">{selected.skills.map((s) => <span key={s.skillId} className="text-[11px] bg-[#F5F5F2] text-[#525252] rounded px-1.5 py-0.5">{s.name} · L{s.proficiency}</span>)}</div>
              )}
            </PreviewSection>

            <PreviewSection title="App login">
              {(() => {
                const l = logins.data?.find((x) => x.employeeId === selected.id);
                return l ? (
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-[#525252]">Signs in as <b>{l.username}</b> ({l.status.toLowerCase()})</span>
                    {canWrite && <button className="text-[11px] underline text-[#171717] shrink-0" onClick={() => resetPassword(l.userId)}>Reset password</button>}
                  </div>
                ) : (
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-[#6B6B6B]">None yet</span>
                    {canWrite && <button className="text-[11px] underline text-[#171717] shrink-0" onClick={() => createLogin(selected.id)}>Create app login</button>}
                  </div>
                );
              })()}
              {cred && <div className="mt-2"><LoginHandover cred={cred} /></div>}
            </PreviewSection>
          </div>
        </aside>
      )}
    </div>
  );
};

const PreviewRow: React.FC<{ label: string; value: string }> = ({ label, value }) => (
  <div className="flex items-center justify-between gap-3"><span className="text-[#6B6B6B]">{label}</span><span className="font-medium text-[#171717] text-right">{value}</span></div>
);

const PreviewSection: React.FC<{ title: string; children: React.ReactNode }> = ({ title, children }) => (
  <div className="space-y-2">
    <div className="text-[11px] font-semibold uppercase tracking-wider text-[#6B6B6B]">{title}</div>
    {children}
  </div>
);

/** A row that shows an "Unassigned" pill with an inline fix, instead of sending someone to the full edit form for a one-field change. */
const AssignRow: React.FC<{ label: string; value: string | null; options: { id: string; name: string }[]; canWrite: boolean; onAssign: (id: string) => void }> = ({ label, value, options, canWrite, onAssign }) => {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <div className="flex items-center justify-between gap-3">
        <span className="text-[#6B6B6B]">{label}</span>
        {value ? <span className="font-medium text-[#171717] text-right">{value}</span> : (
          <div className="flex items-center gap-2">
            <Pill tone="warn">Unassigned</Pill>
            {canWrite && !open && <button className="text-[11px] underline text-[#171717]" onClick={() => setOpen(true)}>Assign</button>}
          </div>
        )}
      </div>
      {open && (
        <div className="mt-1.5 flex gap-2">
          <Select autoFocus defaultValue="" onChange={(e) => { if (e.target.value) { onAssign(e.target.value); setOpen(false); } }}>
            <option value="" disabled>Choose…</option>
            {options.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
          </Select>
          <Btn onClick={() => setOpen(false)}>Cancel</Btn>
        </div>
      )}
    </div>
  );
};

type ComplianceAssignment = { scopeType: 'TENANT' | 'GROUP' | 'TEAM' | 'EMPLOYEE'; scopeId: string | null; scopeName: string; packId: string; packName: string };
type CompliancePack = { id: string; name: string; builtIn: boolean };
type Membership = { patternId: string; patternName: string; crewName: string; effectiveFrom: string | null; effectiveTo: string | null } | null;

/** One employee's rotation pattern and compliance rule-pack override -- both saved immediately (not bundled into the main "Save employee" button), the same as the app-login block above. */
const AssignmentsSection: React.FC<{ employeeId: string; groupId: string | null }> = ({ employeeId, groupId }) => {
  const { can } = useForecast();
  const canSchedule = can('workforce:write');
  const canConfig = can('config:write');
  const [tick, setTick] = useState(0);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const membership = useApi<Membership>(`/scheduling/rotations/member?employeeId=${employeeId}`, [tick]);
  const patterns = useApi<RotationPattern[]>(groupId ? `/scheduling/rotations?groupId=${groupId}` : '/scheduling/rotations');
  const assignments = useApi<ComplianceAssignment[]>('/compliance/assignments', [tick]);
  const packs = useApi<CompliancePack[]>('/compliance/packs');
  const override = assignments.data?.find((a) => a.scopeType === 'EMPLOYEE' && a.scopeId === employeeId) ?? null;

  const [patternId, setPatternId] = useState('');
  const [crewName, setCrewName] = useState('');
  const [effFrom, setEffFrom] = useState('');
  const [effTo, setEffTo] = useState('');
  const [packId, setPackId] = useState('');

  useEffect(() => {
    setPatternId(membership.data?.patternId ?? ''); setCrewName(membership.data?.crewName ?? '');
    setEffFrom(membership.data?.effectiveFrom ?? ''); setEffTo(membership.data?.effectiveTo ?? '');
  }, [membership.data]);
  useEffect(() => { setPackId(override?.packId ?? ''); }, [override?.packId]);

  const pat = patterns.data?.find((p) => p.id === patternId);
  const run = async (fn: () => Promise<void>) => { setBusy(true); setError(''); try { await fn(); setTick((t) => t + 1); } catch (e: any) { setError(e.message); } finally { setBusy(false); } };
  const saveMembership = () => run(() => api('/scheduling/rotations/member', { method: 'PUT', body: { employeeId, patternId: patternId || null, crewName: patternId ? crewName : undefined, effectiveFrom: effFrom || null, effectiveTo: effTo || null } }));
  const savePack = () => run(() => api('/compliance/assignments', { method: 'PUT', body: { scopeType: 'EMPLOYEE', scopeId: employeeId, packId: packId || null } }));

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
      <div className="p-3 rounded bg-[#FAFAF8] border border-[#E5E5E0] space-y-2">
        <div className="font-semibold text-[12px]">Rotation pattern</div>
        <div className="grid grid-cols-2 gap-2">
          <Select value={patternId} disabled={!canSchedule} onChange={(e) => { setPatternId(e.target.value); setCrewName(''); }} aria-label="Rotation pattern">
            <option value="">None</option>{patterns.data?.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </Select>
          <Select value={crewName} disabled={!canSchedule || !patternId} onChange={(e) => setCrewName(e.target.value)} aria-label="Crew">
            <option value="">Choose a crew…</option>{pat?.crews.map((c) => <option key={c.name} value={c.name}>{c.name}</option>)}
          </Select>
          <Input type="date" value={effFrom} disabled={!canSchedule || !patternId} onChange={(e) => setEffFrom(e.target.value)} aria-label="Effective from" />
          <Input type="date" value={effTo} disabled={!canSchedule || !patternId} onChange={(e) => setEffTo(e.target.value)} aria-label="Effective to" />
        </div>
        {canSchedule && <Btn onClick={saveMembership} disabled={busy || (!!patternId && !crewName)}>Save rotation</Btn>}
      </div>
      <div className="p-3 rounded bg-[#FAFAF8] border border-[#E5E5E0] space-y-2">
        <div className="font-semibold text-[12px]">Labour-law rule pack override</div>
        <p className="text-[11px] text-[#6B6B6B]">Otherwise follows their team's, then WFM group's, then the organisation's pack.</p>
        <Select value={packId} disabled={!canConfig} onChange={(e) => setPackId(e.target.value)} aria-label="Rule pack override">
          <option value="">No override (inherit)</option>{packs.data?.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </Select>
        {canConfig && <Btn onClick={savePack} disabled={busy}>Save override</Btn>}
      </div>
      {error && <div className="md:col-span-2"><Banner kind="err" onClose={() => setError('')}>{error}</Banner></div>}
    </div>
  );
};
