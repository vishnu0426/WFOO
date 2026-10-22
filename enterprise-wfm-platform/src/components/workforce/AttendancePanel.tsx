/**
 * Workforce > Time & Attendance. Punches (clock in/out) from a time-clock export, independent of RTA agent-state
 * (which tracks live ACD activity, not physical presence). Compared against the published schedule and rolled into
 * a payroll export -- regular, overtime hours per person per day.
 */
import React, { useRef, useState } from 'react';
import { ColDef } from 'ag-grid-community';
import { Download, Trash2, Upload } from 'lucide-react';
import { AttendanceDay, AttendanceSummary, Employee, api, download, dayYear, dec, ImportResult, Punch } from '../../services/api';
import { useForecast } from '../../services/forecastStore';
import { useApi } from '../forecasting/hooks';
import { Grid } from '../forecasting/Grid';
import { Banner, Btn, Busy, Card, Empty, Field, Input, Pill, Select } from '../forecasting/ui';

const STATUS_TONE = { MATCHED: 'good', MISSED: 'bad', UNSCHEDULED: 'warn', OPEN: 'neutral' } as const;
const STATUS_LABEL: Record<string, string> = { MATCHED: 'Matched', MISSED: 'Missed punch', UNSCHEDULED: 'Not scheduled', OPEN: 'Still clocked in' };
const monday = (d: Date) => { const x = new Date(d); x.setDate(x.getDate() - ((x.getDay() + 6) % 7)); return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`; };
const plus = (s: string, n: number) => { const d = new Date(s + 'T00:00:00'); d.setDate(d.getDate() + n); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

const TEMPLATE_CSV = 'employee_number,day,clock_in,clock_out\nE100,2026-01-05,08:58,17:03\nE100,2026-01-06,09:02,17:00\n';

export const AttendancePanel: React.FC = () => {
  const { can, setNotice } = useForecast();
  const canWrite = can('workforce:write');
  const [from, setFrom] = useState(monday(new Date()));
  const to = plus(from, 6);
  const [tick, setTick] = useState(0);
  const sum = useApi<AttendanceSummary>(`/attendance/summary?from=${from}&to=${to}`, [tick]);
  const emps = useApi<Employee[]>('/workforce/employees?status=ACTIVE');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [csv, setCsv] = useState('');
  const [preview, setPreview] = useState<ImportResult | null>(null);
  const file = useRef<HTMLInputElement>(null);
  const [manual, setManual] = useState<{ employeeId: string; day: string; clockIn: string; clockOut: string; note: string } | null>(null);

  const check = async (f: File) => {
    setBusy(true); setError(''); setPreview(null);
    try { const text = await f.text(); setCsv(text); setPreview(await api<ImportResult>('/attendance/import', { method: 'POST', body: { csv: text, dryRun: true } })); }
    catch (e: any) { setError(e.message); } finally { setBusy(false); if (file.current) file.current.value = ''; }
  };
  const commit = async () => {
    setBusy(true); setError('');
    try {
      const r = await api<ImportResult>('/attendance/import', { method: 'POST', body: { csv, dryRun: false } });
      setNotice({ kind: 'ok', text: `Imported ${r.newPunches} new punch${r.newPunches === 1 ? '' : 'es'}${r.alreadyImported ? `, ${r.alreadyImported} already there` : ''}.` });
      setPreview(null); setCsv(''); setTick((t) => t + 1);
    } catch (e: any) { setError(e.message); } finally { setBusy(false); }
  };
  const addManual = async () => {
    if (!manual) return; setBusy(true); setError('');
    try {
      await api('/attendance/punches', { method: 'POST', body: { employeeId: manual.employeeId, day: manual.day, clockIn: `${manual.day}T${manual.clockIn}:00Z`, clockOut: manual.clockOut ? `${manual.day}T${manual.clockOut}:00Z` : null, note: manual.note } });
      setManual(null); setTick((t) => t + 1);
    } catch (e: any) { setError(e.message); } finally { setBusy(false); }
  };
  const removePunch = async (p: { clockIn: string }, employeeId: string, day: string) => {
    if (!confirm('Remove this punch?')) return;
    const punches = await api<Punch[]>(`/attendance/punches?employeeId=${employeeId}&from=${day}&to=${day}`);
    const row = punches.find((x) => x.clockIn === p.clockIn);
    if (!row) return;
    await api(`/attendance/punches/${row.id}`, { method: 'DELETE' }); setTick((t) => t + 1);
  };

  const cols: ColDef<AttendanceDay>[] = [
    { headerName: 'Person', field: 'name', minWidth: 160 },
    { headerName: 'Day', field: 'day', valueFormatter: (p) => dayYear(p.value), width: 130 },
    { headerName: 'Scheduled', field: 'scheduledHours', type: 'rightAligned', width: 110, valueFormatter: (p) => dec(p.value, 1) },
    { headerName: 'Actual', field: 'actualHours', type: 'rightAligned', width: 100, valueFormatter: (p) => dec(p.value, 1) },
    { headerName: 'Variance', field: 'varianceHours', type: 'rightAligned', width: 100, valueFormatter: (p) => `${p.value > 0 ? '+' : ''}${dec(p.value, 1)}`, cellStyle: (p) => (Math.abs(p.value) > 0.5 ? { color: p.value < 0 ? '#C84A4A' : '#B7791F', fontWeight: 600 } : null) },
    { headerName: 'Status', field: 'status', width: 140, cellRenderer: (p: any) => <Pill tone={STATUS_TONE[p.value as keyof typeof STATUS_TONE]}>{STATUS_LABEL[p.value]}</Pill> },
    { headerName: 'Punches', flex: 1, minWidth: 220, cellRenderer: (p: any) => (
      <span className="flex flex-wrap gap-2 items-center h-full text-[12px]">
        {p.data.punches.map((x: any, i: number) => (
          <span key={i} className="font-mono bg-[#FAFAF8] border border-[#E5E5E0] rounded px-1.5 py-0.5 flex items-center gap-1">
            {x.clockIn.slice(11, 16)}–{x.clockOut ? x.clockOut.slice(11, 16) : 'open'}
            {canWrite && <button aria-label="Remove punch" onClick={() => removePunch(x, p.data.employeeId, p.data.day)} className="text-[#737373] hover:text-[#C84A4A]"><Trash2 className="w-3 h-3" /></button>}
          </span>
        ))}
      </span>) },
  ];

  return (
    <div className="space-y-6">
      <Card title="Time & attendance" sub="Punches compared against the published schedule. Independent of RTA state, which tracks live ACD activity, not physical presence."
        actions={<div className="flex flex-wrap items-center gap-2">
          <Field label="Week"><Input type="date" value={from} onChange={(e) => e.target.value && setFrom(monday(new Date(e.target.value + 'T00:00:00')))} /></Field>
          {canWrite && <>
            <input ref={file} type="file" accept=".csv,text/csv" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) check(f); }} />
            <Btn onClick={() => download('/attendance/template.csv', 'attendance-template.csv').catch((e) => setError(e.message))}><Download className="w-3.5 h-3.5" />CSV template</Btn>
            <Btn onClick={() => file.current?.click()}><Upload className="w-3.5 h-3.5" />Import punches</Btn>
          </>}
          <Btn onClick={() => download(`/attendance/payroll-export.csv?from=${from}&to=${to}`, `payroll-${from}-to-${to}.csv`).catch((e) => setError(e.message))}><Download className="w-3.5 h-3.5" />Payroll export</Btn>
        </div>}>
        {error && <Banner kind="err" onClose={() => setError('')}>{error}</Banner>}
        {busy && <Busy />}

        {preview && (
          <div className="border border-[#E5E5E0] rounded-lg p-4 bg-[#FAFAF8] space-y-3">
            <div className="flex flex-wrap items-center gap-4 text-[13px]">
              <b>Check before importing</b>
              <span className="text-[#2F7D5A] font-semibold">{preview.newPunches} new</span>
              <span className="text-[#737373]">{preview.alreadyImported} already imported</span>
              <span className={preview.errorCount ? 'text-[#C84A4A] font-semibold' : 'text-[#737373]'}>{preview.errorCount} problems</span>
            </div>
            {preview.errors.length > 0 && (
              <div className="text-[12px] space-y-1">{preview.errors.slice(0, 15).map((e, i) => <div key={i}><span className="font-mono text-[#737373]">line {e.line}:</span> {e.message}</div>)}</div>
            )}
            <p className="text-[11px] text-[#737373]">Columns: employee_number, day, clock_in (required); clock_out. A clock-out earlier than clock-in is read as the next day (an overnight shift).</p>
            <div className="flex gap-2"><Btn variant="primary" disabled={busy || !preview.newPunches} onClick={commit}>Import {preview.newPunches} punch{preview.newPunches === 1 ? '' : 'es'}</Btn><Btn onClick={() => setPreview(null)}>Cancel</Btn></div>
          </div>
        )}

        {sum.loading && !sum.data ? <Busy text="Loading…" /> : !sum.data?.days.length ? (
          <Empty title="No punches this week">Import a time-clock export, or add one by hand below.</Empty>
        ) : (
          <Grid<AttendanceDay> rowData={sum.data.days} columnDefs={cols} defaultColDef={{ sortable: true, resizable: true }} loading={sum.loading} height={Math.min(500, 90 + sum.data.days.length * 42)} />
        )}
      </Card>

      {sum.data && sum.data.weeks.length > 0 && (
        <Card title="Weekly hours" sub="Overtime is actual hours worked beyond the person's weekly contract hours.">
          <div className="overflow-x-auto border border-[#E5E5E0] rounded-lg">
            <table className="w-full text-[13px]">
              <thead className="bg-[#FAFAF8] text-[#737373] text-[11px] uppercase tracking-wider border-b border-[#E5E5E0]">
                <tr><th className="p-3 text-left">Person</th><th className="p-3 text-right">Scheduled</th><th className="p-3 text-right">Actual</th><th className="p-3 text-right">Overtime</th></tr>
              </thead>
              <tbody className="divide-y divide-[#E5E5E0]">
                {sum.data.weeks.map((w) => (
                  <tr key={w.employeeId}>
                    <td className="p-3 font-semibold">{w.name}</td>
                    <td className="p-3 text-right font-mono">{dec(w.scheduledHours, 1)}</td>
                    <td className="p-3 text-right font-mono">{dec(w.actualHours, 1)}</td>
                    <td className="p-3 text-right font-mono">{w.overtimeHours > 0 ? <span className="text-[#B7791F] font-semibold">{dec(w.overtimeHours, 1)}</span> : '–'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      {canWrite && (
        <Card title="Add a punch by hand" sub="For when someone forgot to badge in or out.">
          {manual ? (
            <div className="grid grid-cols-1 md:grid-cols-5 gap-3 items-end">
              <Field label="Person"><Select value={manual.employeeId} onChange={(e) => setManual({ ...manual, employeeId: e.target.value })}><option value="">Choose…</option>{emps.data?.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}</Select></Field>
              <Field label="Day"><Input type="date" value={manual.day} onChange={(e) => setManual({ ...manual, day: e.target.value })} /></Field>
              <Field label="Clock in"><Input type="time" step={60} value={manual.clockIn} onChange={(e) => setManual({ ...manual, clockIn: e.target.value })} /></Field>
              <Field label="Clock out"><Input type="time" step={60} value={manual.clockOut} onChange={(e) => setManual({ ...manual, clockOut: e.target.value })} /></Field>
              <Field label="Note"><Input value={manual.note} onChange={(e) => setManual({ ...manual, note: e.target.value })} /></Field>
              <div className="md:col-span-5 flex gap-2"><Btn variant="primary" disabled={busy || !manual.employeeId || !manual.day || !manual.clockIn} onClick={addManual}>Save</Btn><Btn onClick={() => setManual(null)}>Cancel</Btn></div>
            </div>
          ) : <Btn onClick={() => setManual({ employeeId: '', day: from, clockIn: '09:00', clockOut: '17:00', note: '' })}>Add a punch</Btn>}
        </Card>
      )}
    </div>
  );
};
