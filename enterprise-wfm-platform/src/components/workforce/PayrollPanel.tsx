/**
 * Workforce › Payroll. A pay period's worked time becomes pay codes (regular, overtime, night, weekend, holiday, paid leave). Check it, approve it (that locks it) and
 * export it for the payroll system. The settings say what counts as night, when overtime starts and how hours are rounded.
 */
import React, { useEffect, useState } from 'react';
import { api, dec, download, weekFloor } from '../../services/api';
import { useForecast } from '../../services/forecastStore';
import { useApi, usePayWeek } from '../forecasting/hooks';
import { Banner, Btn, Busy, Card, Field, Input, Kpi, KpiRow, Pill, Select } from '../forecasting/ui';

type Settings = { payCodes: Record<string, string>; paidLeave: string[]; nightFrom: string; nightTo: string; dailyOvertimeAfter: number | null; weeklyOvertimeAfter: number | null; stacking: 'EXCLUSIVE' | 'STACKED'; rounding: 'NONE' | 'TENTH' | 'QUARTER'; hoursSource: 'ACTUAL' | 'SCHEDULED' | 'ACTUAL_ELSE_SCHEDULED'; dstPay?: 'SCHEDULED' | 'WORKED' };
type Line = { employeeId: string; employeeNumber: string; name: string; department: string; payCode: string; category: string; hours: number; supplement?: boolean };
type Run = { id: string; groupId: string | null; groupName: string | null; periodStart: string; periodEnd: string; status: 'DRAFT' | 'APPROVED' | 'EXPORTED'; totals: { people?: number; hours?: number; overtime?: number }; warningCount: number; approvedBy: string | null; exportedAt: string | null; warnings?: { kind: string; text: string }[]; lines?: Line[] };
const CODE_LABEL: Record<string, string> = { REGULAR: 'Regular', OVERTIME: 'Overtime', NIGHT: 'Night', WEEKEND: 'Weekend', HOLIDAY: 'Worked on a holiday', VACATION: 'Vacation', SICK: 'Sick leave', PERSONAL: 'Personal leave', HOLIDAY_LEAVE: 'Paid holiday', TRAINING: 'Training', LEAVE: 'Other leave', OTHER: 'Other' };
const LEAVE = ['VACATION', 'SICK', 'HOLIDAY', 'PERSONAL', 'TRAINING', 'LEAVE', 'OTHER'];
const STATUS_TONE = { DRAFT: 'warn', APPROVED: 'good', EXPORTED: 'info' } as const;
const addDays = (s: string, n: number) => { const d = new Date(`${s}T00:00:00`); d.setDate(d.getDate() + n); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

export const PayrollPanel: React.FC = () => {
  const { can, groups } = useForecast();
  const [tick, setTick] = useState(0);
  const settings = useApi<Settings>('/payroll/settings', [tick]);
  const runs = useApi<Run[]>('/payroll/runs', [tick]);
  const [d, setD] = useState<Settings | null>(null);
  const [groupId, setGroupId] = useState('');
  const weekStart = usePayWeek(groupId || null);                      // the last whole pay week of this group (or the company's), not always Monday to Sunday
  const [range, setRange] = useState<{ from?: string; to?: string }>({});
  const from = range.from ?? addDays(weekFloor(new Date(), weekStart), -7), to = range.to ?? addDays(from, 6);
  const setFrom = (v: string) => setRange((r) => ({ ...r, from: v })), setTo = (v: string) => setRange((r) => ({ ...r, to: v }));
  const [open, setOpen] = useState<Run | null>(null);
  const [note, setNote] = useState('');
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err' | 'info'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (settings.data) setD(settings.data); }, [settings.data]);
  const act = async (fn: () => Promise<unknown>, ok?: string) => { setBusy(true); setMsg(null); try { await fn(); if (ok) setMsg({ kind: 'ok', text: ok }); setTick((n) => n + 1); } catch (e: any) { setMsg({ kind: 'err', text: e.message }); } finally { setBusy(false); } };
  const show = async (id: string) => setOpen(await api<Run>(`/payroll/runs/${id}`));
  const canRun = can('workforce:write'), canApprove = can('schedule:approve'), canConfig = can('config:write');

  const byPerson = new Map<string, { name: string; number: string; dept: string; lines: Line[] }>();
  for (const l of open?.lines ?? []) { const p = byPerson.get(l.employeeId) ?? { name: l.name, number: l.employeeNumber, dept: l.department, lines: [] }; p.lines.push(l); byPerson.set(l.employeeId, p); }

  return (
    <div className="space-y-6">
      {msg && <Banner kind={msg.kind} onClose={() => setMsg(null)}>{msg.text}</Banner>}

      <Card title="Work out a pay period" sub="Choose the dates and who. Nothing is paid or locked until you approve it.">
        <div className="flex flex-wrap items-end gap-3">
          <Field label="From"><Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></Field>
          <Field label="To"><Input type="date" value={to} min={from} onChange={(e) => setTo(e.target.value)} /></Field>
          <Field label="Who"><Select value={groupId} onChange={(e) => setGroupId(e.target.value)} className="!w-auto"><option value="">Everyone</option>{groups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}</Select></Field>
          {canRun && <Btn variant="primary" disabled={busy} onClick={() => act(async () => { const r = await api<Run>('/payroll/runs', { method: 'POST', body: { groupId: groupId || null, from, to } }); setOpen(r); }, 'Worked out as a draft. Check it below.')}>Work it out</Btn>}
        </div>
      </Card>

      {open && (
        <Card title={`${open.periodStart} to ${open.periodEnd}`} sub={open.groupName ? open.groupName : 'Everyone'}
          actions={<><Pill tone={STATUS_TONE[open.status]}>{open.status === 'DRAFT' ? 'Draft' : open.status === 'APPROVED' ? 'Approved and locked' : 'Exported'}</Pill>
            {canRun && open.status === 'DRAFT' && <Btn disabled={busy} onClick={() => act(async () => setOpen(await api<Run>(`/payroll/runs/${open.id}/recalculate`, { method: 'POST', body: {} })), 'Worked out again.')}>Work out again</Btn>}
            {canRun && open.status === 'DRAFT' && <Btn disabled={busy} onClick={() => act(async () => { await api(`/payroll/runs/${open.id}`, { method: 'DELETE' }); setOpen(null); })}>Delete</Btn>}</>}>
          <KpiRow>
            <Kpi label="People" value={open.totals.people ?? 0} />
            <Kpi label="Paid hours" value={dec(open.totals.hours ?? 0, 1)} />
            <Kpi label="Overtime hours" value={dec(open.totals.overtime ?? 0, 1)} tone={(open.totals.overtime ?? 0) > 0 ? 'warn' : undefined} />
            <Kpi label="Things to check" value={open.warnings?.length ?? 0} tone={open.warnings?.length ? 'bad' : 'good'} />
          </KpiRow>
          {(open.warnings ?? []).length > 0 && <Banner kind="warn"><ul className="list-disc ml-4">{open.warnings!.slice(0, 8).map((w, i) => <li key={i}>{w.text}</li>)}{open.warnings!.length > 8 && <li>and {open.warnings!.length - 8} more</li>}</ul></Banner>}
          <div className="max-h-96 overflow-auto border border-[#E5E5E0] rounded-lg">
            <table className="w-full text-[12px]">
              <thead className="bg-[#FAFAF8] text-left text-[#6B6B6B] sticky top-0"><tr><th className="px-3 py-2">Person</th><th>Department</th><th>Pay code</th><th className="text-right pr-3">Hours</th></tr></thead>
              <tbody>{[...byPerson.values()].flatMap((p) => p.lines.map((l, i) => (
                <tr key={`${p.number}-${l.payCode}-${i}`} className="border-t border-[#E5E5E0]"><td className="px-3 py-1">{i === 0 ? <><span className="font-semibold">{p.name}</span> <span className="text-[#6B6B6B]">{p.number}</span></> : ''}</td><td>{i === 0 ? p.dept : ''}</td>
                  <td><span className="font-mono">{l.payCode}</span> <span className="text-[#6B6B6B]">{CODE_LABEL[l.category] ?? l.category.replace('LEAVE:', 'Leave: ').replace('_SUPPLEMENT', ' supplement')}</span></td><td className="text-right pr-3 tabular-nums">{l.hours}</td></tr>)))}</tbody>
            </table>
          </div>
          {open.status === 'DRAFT' && canApprove && (
            <div className="flex flex-wrap items-end gap-3 border-t border-[#E5E5E0] pt-3">
              <Field label={open.warnings?.length ? 'Why is it fine to approve with these open?' : 'Note (optional)'}><Input className="!w-96" value={note} onChange={(e) => setNote(e.target.value)} /></Field>
              <Btn variant="success" disabled={busy} onClick={() => act(async () => setOpen(await api<Run>(`/payroll/runs/${open.id}/approve`, { method: 'POST', body: { note } })), 'Approved. This period is locked.')}>Approve and lock</Btn>
            </div>
          )}
          {open.status !== 'DRAFT' && canApprove && (
            <div className="flex gap-2 border-t border-[#E5E5E0] pt-3">
              <Btn onClick={() => download(`/payroll/runs/${open.id}/export.csv`, `payroll-${open.periodStart}-to-${open.periodEnd}.csv`).then(() => setTick((n) => n + 1)).catch((e) => setMsg({ kind: 'err', text: e.message }))}>Download for payroll (totals)</Btn>
              <Btn onClick={() => download(`/payroll/runs/${open.id}/export.csv?layout=daily`, `payroll-${open.periodStart}-to-${open.periodEnd}-daily.csv`).catch((e) => setMsg({ kind: 'err', text: e.message }))}>Download day by day</Btn>
            </div>
          )}
        </Card>
      )}

      <Card title="Pay runs">
        {runs.loading && !runs.data ? <Busy text="Loading…" /> : (runs.data ?? []).length === 0 ? <p className="text-[12px] text-[#6B6B6B]">No pay runs yet.</p> : (
          <table className="w-full text-[12px]">
            <thead className="text-left text-[#6B6B6B]"><tr><th className="py-1">Period</th><th>Who</th><th>Status</th><th className="text-right">People</th><th className="text-right">Hours</th><th className="text-right">Overtime</th><th /></tr></thead>
            <tbody>{runs.data!.map((r) => (
              <tr key={r.id} className="border-t border-[#E5E5E0]"><td className="py-1.5 tabular-nums">{r.periodStart} to {r.periodEnd}</td><td>{r.groupName ?? 'Everyone'}</td><td><Pill tone={STATUS_TONE[r.status]}>{r.status.toLowerCase()}</Pill></td>
                <td className="text-right">{r.totals.people}</td><td className="text-right">{r.totals.hours}</td><td className="text-right">{r.totals.overtime}</td><td className="text-right"><button className="underline" onClick={() => show(r.id)}>Open</button></td></tr>))}</tbody>
          </table>
        )}
      </Card>

      {d && (
        <Card title="Payroll rules" sub="What counts as night, when overtime starts, how hours are rounded and the code payroll uses for each. Changes apply to runs worked out from now on; approved runs keep what they were worked out with.">
          <div className="grid grid-cols-1 md:grid-cols-4 gap-4 max-w-5xl">
            <Field label="Night starts"><Input type="time" disabled={!canConfig} value={d.nightFrom} onChange={(e) => setD({ ...d, nightFrom: e.target.value })} /></Field>
            <Field label="Night ends"><Input type="time" disabled={!canConfig} value={d.nightTo} onChange={(e) => setD({ ...d, nightTo: e.target.value })} /></Field>
            <Field label="Overtime after (hours a day)" hint="Empty: no daily overtime"><Input type="number" min={1} max={24} disabled={!canConfig} value={d.dailyOvertimeAfter ?? ''} onChange={(e) => setD({ ...d, dailyOvertimeAfter: e.target.value === '' ? null : Number(e.target.value) })} /></Field>
            <Field label="Overtime after (hours a week)" hint="Empty: the person's contract hours"><Input type="number" min={1} max={168} disabled={!canConfig} value={d.weeklyOvertimeAfter ?? ''} onChange={(e) => setD({ ...d, weeklyOvertimeAfter: e.target.value === '' ? null : Number(e.target.value) })} /></Field>
            <Field label="Night and weekend hours" hint={d.stacking === 'STACKED' ? 'Paid as regular, and also reported as extra lines for the premium' : 'Each hour gets one code: night or weekend replaces regular'}><Select disabled={!canConfig} value={d.stacking} onChange={(e) => setD({ ...d, stacking: e.target.value as Settings['stacking'] })}><option value="EXCLUSIVE">Replace regular pay</option><option value="STACKED">Add to regular pay</option></Select></Field>
            <Field label="Round hours to"><Select disabled={!canConfig} value={d.rounding} onChange={(e) => setD({ ...d, rounding: e.target.value as Settings['rounding'] })}><option value="NONE">Two decimals</option><option value="TENTH">Nearest tenth</option><option value="QUARTER">Nearest quarter hour</option></Select></Field>
            <Field label="Hours come from"><Select disabled={!canConfig} value={d.hoursSource} onChange={(e) => setD({ ...d, hoursSource: e.target.value as Settings['hoursSource'] })}><option value="ACTUAL_ELSE_SCHEDULED">Clock punches, else the schedule</option><option value="ACTUAL">Clock punches only</option><option value="SCHEDULED">The schedule only</option></Select></Field>
            <Field label="Scheduled shifts over a clock change" hint="Applies to hours taken from the schedule. Punched hours are always the time really worked."><Select disabled={!canConfig} value={d.dstPay ?? 'SCHEDULED'} onChange={(e) => setD({ ...d, dstPay: e.target.value as Settings['dstPay'] })}><option value="SCHEDULED">Pay the scheduled hours</option><option value="WORKED">Pay the hours really worked (an hour less in spring, more in autumn)</option></Select></Field>
          </div>
          <div className="grid grid-cols-2 md:grid-cols-6 gap-3 max-w-5xl">
            {Object.keys(CODE_LABEL).map((k) => <Field key={k} label={CODE_LABEL[k]}><Input disabled={!canConfig} value={d.payCodes[k] ?? ''} onChange={(e) => setD({ ...d, payCodes: { ...d.payCodes, [k]: e.target.value.toUpperCase() } })} /></Field>)}
          </div>
          <div className="text-[12px]"><span className="font-semibold">Leave that is paid:</span> {LEAVE.map((t) => <label key={t} className="inline-flex items-center gap-1 ml-3"><input type="checkbox" disabled={!canConfig} checked={d.paidLeave.includes(t)} onChange={(e) => setD({ ...d, paidLeave: e.target.checked ? [...d.paidLeave, t] : d.paidLeave.filter((x) => x !== t) })} />{CODE_LABEL[t === 'HOLIDAY' ? 'HOLIDAY_LEAVE' : t]}</label>)}</div>
          {canConfig && <div><Btn variant="primary" disabled={busy} onClick={() => act(() => api('/payroll/settings', { method: 'PUT', body: d }), 'Saved.')}>Save rules</Btn></div>}
        </Card>
      )}
    </div>
  );
};
