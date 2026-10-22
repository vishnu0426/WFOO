/**
 * Workforce: Employees, Teams, Skills, Availability, Time Off. All data comes from the gateway.
 */
import React, { useEffect, useMemo, useState } from 'react';
import { ColDef } from 'ag-grid-community';
import { Plus, Trash2 } from 'lucide-react';
import { api, AvailabilityWindow, DOW, Employee, Skill, Team, TimeOff, dayYear, when } from '../../services/api';
import { useForecast } from '../../services/forecastStore';
import { useApi } from '../forecasting/hooks';
import { Grid } from '../forecasting/Grid';
import { Banner, Btn, Card, Empty, Field, Input, PageHeader, Pill, Select, Table } from '../forecasting/ui';
import { NoticeBanner } from '../forecasting/VersionBar';
import { EmployeesPanel } from './EmployeesPanel';
import { AttendancePanel } from './AttendancePanel';

const TITLES: Record<string, { title: string; sub: string }> = {
  employees: { title: 'Employees', sub: 'People, contracts and the limits a schedule must respect.' },
  teams: { title: 'Teams', sub: 'How people are organised and who leads them.' },
  skills: { title: 'Skills', sub: 'What people can do, and how well.' },
  availability: { title: 'Availability', sub: 'When each person can and cannot be scheduled.' },
  'time-off': { title: 'Time Off', sub: 'Leave requests. Approved time off is never scheduled over.' },
  attendance: { title: 'Time & Attendance', sub: 'Punches compared against the published schedule, and the payroll export.' },
};

export const WorkforceHub: React.FC<{ activeSubSection?: string }> = ({ activeSubSection = 'employees' }) => {
  const meta = TITLES[activeSubSection] ?? TITLES.employees;
  return (
    <div className="flex-1 flex flex-col h-[calc(100vh-3.5rem)] overflow-y-auto bg-[#FFFFFF] p-6 space-y-6">
      <PageHeader title={meta.title} sub={meta.sub} />
      <NoticeBanner />
      {activeSubSection === 'teams' ? <TeamsPanel /> : activeSubSection === 'skills' ? <SkillsPanel /> : activeSubSection === 'availability' ? <AvailabilityPanel /> : activeSubSection === 'time-off' ? <TimeOffPanel /> : activeSubSection === 'attendance' ? <AttendancePanel /> : <EmployeesPanel />}
    </div>
  );
};

// ---------------------------------------------------------------- teams

const TeamsPanel: React.FC = () => {
  const { can, setNotice } = useForecast();
  const [tick, setTick] = useState(0);
  const teams = useApi<Team[]>('/workforce/teams', [tick]);
  const emps = useApi<Employee[]>('/workforce/employees');
  const [f, setF] = useState<{ id: string | null; name: string; description: string; location: string; managerId: string } | null>(null);
  const [error, setError] = useState('');
  const w = can('workforce:write');
  const save = async () => {
    if (!f) return; setError('');
    try {
      const body = { name: f.name, description: f.description, location: f.location, managerId: f.managerId || null };
      if (f.id) await api(`/workforce/teams/${f.id}`, { method: 'PUT', body }); else await api('/workforce/teams', { method: 'POST', body });
      setF(null); setTick((t) => t + 1);
    } catch (e: any) { setError(e.message); }
  };
  const del = async (t: Team) => { if (!confirm(`Delete team “${t.name}”?`)) return; try { await api(`/workforce/teams/${t.id}`, { method: 'DELETE' }); setTick((x) => x + 1); } catch (e: any) { setNotice({ kind: 'err', text: e.message }); } };
  return (
    <Card title="Teams" actions={w && <Btn variant="primary" onClick={() => { setError(''); setF({ id: null, name: '', description: '', location: '', managerId: '' }); }}><Plus className="w-3.5 h-3.5" />Add team</Btn>}>
      {f && (
        <div className="border border-[#E5E5E0] rounded-lg p-4 grid grid-cols-1 md:grid-cols-4 gap-4 items-end">
          <Field label="Name"><Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
          <Field label="Location"><Input value={f.location} onChange={(e) => setF({ ...f, location: e.target.value })} /></Field>
          <Field label="Lead"><Select value={f.managerId} onChange={(e) => setF({ ...f, managerId: e.target.value })}><option value="">None</option>{emps.data?.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}</Select></Field>
          <Field label="Description"><Input value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} /></Field>
          <div className="md:col-span-4 flex items-center gap-2"><Btn variant="primary" disabled={!f.name.trim()} onClick={save}>Save team</Btn><Btn onClick={() => setF(null)}>Cancel</Btn>{error && <span className="text-[12px] text-[#C84A4A]">{error}</span>}</div>
        </div>
      )}
      {teams.data?.length === 0 ? <Empty title="No teams yet">Teams group people under a lead. Create one, then assign people to it.</Empty> : (
        <Table head={['Team', 'Lead', 'Location', 'People', 'Status', '']} right={[3]}>
          {teams.data?.map((t) => (
            <tr key={t.id}>
              <td className="p-3"><div className="font-semibold">{t.name}</div><div className="text-[11px] text-[#737373]">{t.description}</div></td>
              <td className="p-3">{t.managerName ?? '–'}</td><td className="p-3">{t.location || '–'}</td><td className="p-3 text-right font-mono">{t.memberCount}</td>
              <td className="p-3"><Pill tone={t.status === 'ACTIVE' ? 'good' : 'neutral'}>{t.status === 'ACTIVE' ? 'Active' : 'Inactive'}</Pill></td>
              <td className="p-3 text-right whitespace-nowrap">{w && <><button className="text-[12px] underline mr-3" onClick={() => setF({ id: t.id, name: t.name, description: t.description, location: t.location, managerId: t.managerId ?? '' })}>Edit</button><button aria-label="Delete team" className="text-[#737373] hover:text-[#C84A4A]" onClick={() => del(t)}><Trash2 className="w-4 h-4 inline" /></button></>}</td>
            </tr>
          ))}
        </Table>
      )}
    </Card>
  );
};

// ---------------------------------------------------------------- skills

const SkillsPanel: React.FC = () => {
  const { can, setNotice } = useForecast();
  const [tick, setTick] = useState(0);
  const skills = useApi<Skill[]>('/workforce/skills', [tick]);
  const [f, setF] = useState<{ id: string | null; name: string; category: Skill['category']; type: Skill['type']; requiresCertification: boolean } | null>(null);
  const [error, setError] = useState('');
  const w = can('workforce:write');
  const save = async () => {
    if (!f) return; setError('');
    try {
      const body = { name: f.name, category: f.category, type: f.type, requiresCertification: f.requiresCertification };
      if (f.id) await api(`/workforce/skills/${f.id}`, { method: 'PUT', body }); else await api('/workforce/skills', { method: 'POST', body });
      setF(null); setTick((t) => t + 1);
    } catch (e: any) { setError(e.message); }
  };
  const del = async (s: Skill) => { if (!confirm(`Delete skill “${s.name}”? It is removed from ${s.holders} people.`)) return; try { await api(`/workforce/skills/${s.id}`, { method: 'DELETE' }); setTick((x) => x + 1); } catch (e: any) { setNotice({ kind: 'err', text: e.message }); } };
  return (
    <Card title="Skills" sub="Assign skills and levels on each employee." actions={w && <Btn variant="primary" onClick={() => { setError(''); setF({ id: null, name: '', category: 'PRODUCTS', type: 'CORE', requiresCertification: false }); }}><Plus className="w-3.5 h-3.5" />Add skill</Btn>}>
      {f && (
        <div className="border border-[#E5E5E0] rounded-lg p-4 grid grid-cols-1 md:grid-cols-4 gap-4 items-end">
          <Field label="Name"><Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
          <Field label="Category"><Select value={f.category} onChange={(e) => setF({ ...f, category: e.target.value as Skill['category'] })}>{['CHANNELS', 'LANGUAGES', 'PRODUCTS', 'TIERS'].map((c) => <option key={c} value={c}>{c[0] + c.slice(1).toLowerCase()}</option>)}</Select></Field>
          <Field label="Importance"><Select value={f.type} onChange={(e) => setF({ ...f, type: e.target.value as Skill['type'] })}>{['CORE', 'SECONDARY', 'SPECIALTY'].map((c) => <option key={c} value={c}>{c[0] + c.slice(1).toLowerCase()}</option>)}</Select></Field>
          <Field label="Certification"><Select value={f.requiresCertification ? 'y' : 'n'} onChange={(e) => setF({ ...f, requiresCertification: e.target.value === 'y' })}><option value="n">Not required</option><option value="y">Required</option></Select></Field>
          <div className="md:col-span-4 flex items-center gap-2"><Btn variant="primary" disabled={!f.name.trim()} onClick={save}>Save skill</Btn><Btn onClick={() => setF(null)}>Cancel</Btn>{error && <span className="text-[12px] text-[#C84A4A]">{error}</span>}</div>
        </div>
      )}
      {skills.data?.length === 0 ? <Empty title="No skills yet">Skills describe what people can handle, such as a product line, a language or a tier.</Empty> : (
        <Table head={['Skill', 'Category', 'Importance', 'Certification', 'People', '']} right={[4]}>
          {skills.data?.map((s) => (
            <tr key={s.id}><td className="p-3 font-semibold">{s.name}<div className="text-[11px] font-mono text-[#737373] font-normal">{s.code}</div></td>
              <td className="p-3">{s.category[0] + s.category.slice(1).toLowerCase()}</td><td className="p-3">{s.type[0] + s.type.slice(1).toLowerCase()}</td>
              <td className="p-3">{s.requiresCertification ? 'Required' : '–'}</td><td className="p-3 text-right font-mono">{s.holders}</td>
              <td className="p-3 text-right whitespace-nowrap">{w && <><button className="text-[12px] underline mr-3" onClick={() => setF({ id: s.id, name: s.name, category: s.category, type: s.type, requiresCertification: s.requiresCertification })}>Edit</button><button aria-label="Delete skill" className="text-[#737373] hover:text-[#C84A4A]" onClick={() => del(s)}><Trash2 className="w-4 h-4 inline" /></button></>}</td></tr>
          ))}
        </Table>
      )}
    </Card>
  );
};

// ---------------------------------------------------------------- availability

const AvailabilityPanel: React.FC = () => {
  const { can, setNotice } = useForecast();
  const emps = useApi<Employee[]>('/workforce/employees?status=ACTIVE');
  const [empId, setEmpId] = useState('');
  const [tick, setTick] = useState(0);
  const loaded = useApi<AvailabilityWindow[]>(empId ? `/workforce/employees/${empId}/availability` : null, [tick]);
  const [rows, setRows] = useState<AvailabilityWindow[]>([]);
  const [error, setError] = useState('');
  useEffect(() => { setRows(loaded.data ?? []); }, [loaded.data]);
  const w = can('workforce:write');
  const upd = (i: number, p: Partial<AvailabilityWindow>) => setRows((r) => r.map((x, j) => (j === i ? { ...x, ...p } : x)));
  const save = async () => {
    setError('');
    try { await api(`/workforce/employees/${empId}/availability`, { method: 'PUT', body: { windows: rows.map(({ id, ...r }) => r) } }); setNotice({ kind: 'ok', text: 'Availability saved. New schedules will follow it.' }); setTick((t) => t + 1); }
    catch (e: any) { setError(e.message); }
  };
  return (
    <Card title="Weekly availability" sub="With nothing entered, a person can work any time a shift template allows. “Only available” narrows a day to those hours; “Unavailable” removes hours; “Prefer” is a wish the scheduler tries to honour.">
      <div className="max-w-sm"><Field label="Employee"><Select value={empId} onChange={(e) => setEmpId(e.target.value)}><option value="">Choose a person…</option>{emps.data?.map((e) => <option key={e.id} value={e.id}>{e.name} ({e.employeeNumber})</option>)}</Select></Field></div>
      {empId && (
        <div className="space-y-3">
          {rows.length === 0 && <p className="text-[12px] text-[#737373]">No restrictions: available whenever a template allows.</p>}
          {rows.map((r, i) => (
            <div key={i} className="grid grid-cols-2 md:grid-cols-6 gap-3 items-end">
              <Field label="Day"><Select disabled={!w} value={r.dayOfWeek} onChange={(e) => upd(i, { dayOfWeek: Number(e.target.value) })}>{DOW.map((d, n) => <option key={d} value={n}>{d}</option>)}</Select></Field>
              <Field label="From"><Input disabled={!w} type="time" step={900} value={r.startTime} onChange={(e) => upd(i, { startTime: e.target.value })} /></Field>
              <Field label="To"><Input disabled={!w} type="time" step={900} value={r.endTime === '24:00' ? '23:59' : r.endTime} onChange={(e) => upd(i, { endTime: e.target.value === '23:59' ? '24:00' : e.target.value })} /></Field>
              <div className="md:col-span-2"><Field label="Meaning"><Select disabled={!w} value={r.kind} onChange={(e) => upd(i, { kind: e.target.value as AvailabilityWindow['kind'] })}><option value="AVAILABLE">Only available in this window</option><option value="UNAVAILABLE">Unavailable</option><option value="PREFERRED">Prefer to work</option></Select></Field></div>
              {w && <button aria-label="Remove window" className="pb-2 text-[#737373] hover:text-[#C84A4A]" onClick={() => setRows((x) => x.filter((_, j) => j !== i))}><Trash2 className="w-4 h-4" /></button>}
            </div>
          ))}
          {error && <Banner kind="err">{error}</Banner>}
          {w && <div className="flex gap-2"><Btn onClick={() => setRows((r) => [...r, { dayOfWeek: 0, startTime: '09:00', endTime: '17:00', kind: 'UNAVAILABLE' }])}><Plus className="w-3.5 h-3.5" />Add window</Btn><Btn variant="primary" onClick={save}>Save availability</Btn></div>}
        </div>
      )}
    </Card>
  );
};

// ---------------------------------------------------------------- time off

const STATUS_TONE = { REQUESTED: 'warn', APPROVED: 'good', REJECTED: 'bad', CANCELLED: 'neutral' } as const;

const TimeOffPanel: React.FC = () => {
  const { can, setNotice } = useForecast();
  const [tick, setTick] = useState(0);
  const [status, setStatus] = useState('');
  const list = useApi<TimeOff[]>(`/workforce/time-off${status ? `?status=${status}` : ''}`, [tick]);
  const emps = useApi<Employee[]>('/workforce/employees?status=ACTIVE');
  const [f, setF] = useState<{ employeeId: string; type: string; startDate: string; endDate: string; reason: string; approve: boolean } | null>(null);
  const [error, setError] = useState('');
  const w = can('workforce:write');

  const decide = async (t: TimeOff, s: 'APPROVED' | 'REJECTED' | 'CANCELLED') => {
    let reason = '';
    if (s === 'REJECTED') { reason = prompt(`Why is ${t.employeeName}'s request being rejected?`) ?? ''; if (reason.trim().length < 3) return; }
    try { await api(`/workforce/time-off/${t.id}/decide`, { method: 'POST', body: { status: s, reason } }); setTick((x) => x + 1); } catch (e: any) { setNotice({ kind: 'err', text: e.message }); }
  };
  const create = async () => {
    if (!f) return; setError('');
    try { await api('/workforce/time-off', { method: 'POST', body: f }); setF(null); setTick((t) => t + 1); } catch (e: any) { setError(e.message); }
  };
  const cols = useMemo<ColDef<TimeOff>[]>(() => [
    { headerName: 'Employee', field: 'employeeName', minWidth: 160 },
    { headerName: 'Type', field: 'type', valueFormatter: (p) => p.value[0] + p.value.slice(1).toLowerCase(), width: 120 },
    { headerName: 'From', field: 'startDate', valueFormatter: (p) => dayYear(p.value) },
    { headerName: 'To', field: 'endDate', valueFormatter: (p) => dayYear(p.value) },
    { headerName: 'Days', field: 'days', type: 'rightAligned', width: 90 },
    { headerName: 'Status', field: 'status', width: 130, cellRenderer: (p: any) => <Pill tone={STATUS_TONE[p.value as keyof typeof STATUS_TONE]}>{p.value[0] + p.value.slice(1).toLowerCase()}</Pill> },
    { headerName: 'Reason / note', field: 'reason', flex: 2, minWidth: 160 },
    { headerName: 'Decided', valueGetter: (p) => (p.data!.decidedBy ? `${p.data!.decidedBy} · ${when(p.data!.decidedAt)}` : ''), minWidth: 170 },
    { headerName: '', width: 190, sortable: false, filter: false, cellRenderer: (p: any) => !w ? null : (
      <span className="flex gap-2 items-center h-full text-[12px]">
        {p.data.status === 'REQUESTED' && <><button className="font-semibold text-[#2F7D5A] underline" onClick={() => decide(p.data, 'APPROVED')}>Approve</button><button className="font-semibold text-[#C84A4A] underline" onClick={() => decide(p.data, 'REJECTED')}>Reject</button></>}
        {(p.data.status === 'REQUESTED' || p.data.status === 'APPROVED') && <button className="underline text-[#737373]" onClick={() => decide(p.data, 'CANCELLED')}>Cancel</button>}
      </span>) },
  ], [w]);

  return (
    <Card title="Time off" sub="Approved time off blocks scheduling for those days. Requests wait for a decision."
      actions={<>
        <Select value={status} onChange={(e) => setStatus(e.target.value)} className="!w-auto" aria-label="Status"><option value="">All requests</option><option value="REQUESTED">Waiting</option><option value="APPROVED">Approved</option><option value="REJECTED">Rejected</option></Select>
        {w && <Btn variant="primary" onClick={() => { setError(''); setF({ employeeId: '', type: 'VACATION', startDate: '', endDate: '', reason: '', approve: false }); }}><Plus className="w-3.5 h-3.5" />New request</Btn>}
      </>}>
      {f && (
        <div className="border border-[#E5E5E0] rounded-lg p-4 grid grid-cols-1 md:grid-cols-6 gap-4 items-end">
          <div className="md:col-span-2"><Field label="Employee"><Select value={f.employeeId} onChange={(e) => setF({ ...f, employeeId: e.target.value })}><option value="">Choose…</option>{emps.data?.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}</Select></Field></div>
          <Field label="Type"><Select value={f.type} onChange={(e) => setF({ ...f, type: e.target.value })}>{['VACATION', 'SICK', 'PERSONAL', 'HOLIDAY', 'TRAINING', 'LEAVE', 'OTHER'].map((t) => <option key={t} value={t}>{t[0] + t.slice(1).toLowerCase()}</option>)}</Select></Field>
          <Field label="From"><Input type="date" value={f.startDate} onChange={(e) => setF({ ...f, startDate: e.target.value, endDate: f.endDate || e.target.value })} /></Field>
          <Field label="To"><Input type="date" min={f.startDate} value={f.endDate} onChange={(e) => setF({ ...f, endDate: e.target.value })} /></Field>
          <Field label="Decision"><Select value={f.approve ? 'y' : 'n'} onChange={(e) => setF({ ...f, approve: e.target.value === 'y' })}><option value="n">Leave for approval</option><option value="y">Approve now</option></Select></Field>
          <div className="md:col-span-6"><Field label="Reason (optional)"><Input value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} /></Field></div>
          <div className="md:col-span-6 flex items-center gap-2"><Btn variant="primary" disabled={!f.employeeId || !f.startDate || !f.endDate} onClick={create}>Save</Btn><Btn onClick={() => setF(null)}>Cancel</Btn>{error && <span className="text-[12px] text-[#C84A4A]">{error}</span>}</div>
        </div>
      )}
      {list.data?.length === 0 ? <Empty title="No time-off requests">Requests and approved leave appear here.</Empty> : <Grid<TimeOff> rowData={list.data ?? []} columnDefs={cols} defaultColDef={{ sortable: true, resizable: true }} loading={list.loading} height={420} />}
    </Card>
  );
};
