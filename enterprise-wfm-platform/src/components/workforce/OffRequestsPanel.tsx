/**
 * Workforce > Time Off > Days-off requests. What people ask for about their days off: "the weekends in these dates off, together" and "from now on, at least N days off together /
 * N full weekends off in a month". A supervisor decides their own team's, a manager anyone's. Approving a weekends request makes those weekend days time off for the scheduler;
 * approving a standing request raises the person's own limits (it never lowers them). Nothing shows here until somebody has asked.
 */
import React, { useMemo, useState } from 'react';
import { ColDef } from 'ag-grid-community';
import { api, OffRequest, offRequestText, when } from '../../services/api';
import { useForecast } from '../../services/forecastStore';
import { useApi } from '../forecasting/hooks';
import { Grid } from '../forecasting/Grid';
import { Banner, Card, Pill } from '../forecasting/ui';
import { Confirm } from '../configuration/groups/shared';

const TONE = { REQUESTED: 'warn', APPROVED: 'good', REJECTED: 'bad', CANCELLED: 'neutral' } as const;
const LABEL = { REQUESTED: 'Waiting', APPROVED: 'Approved', REJECTED: 'Declined', CANCELLED: 'Cancelled' } as const;

/** What the approver should weigh, in plain words. */
export function offContextText(r: OffRequest): string {
  const c = r.context;
  if (!c) return '';
  if ('weekends' in c) {
    const bits: string[] = [];
    if (c.teamSize) bits.push(`${c.teamOff} of ${c.teamSize} teammates already off on those days`);
    if (c.scheduledShifts) bits.push(`${c.scheduledShifts} shift${c.scheduledShifts === 1 ? '' : 's'} already scheduled on them`);
    return bits.join(' · ') || 'Nobody else on the team is off';
  }
  const bits: string[] = [];
  if (r.minDaysTogether) bits.push(`days together ${c.now.daysTogether || 'none'} → ${c.after.daysTogether}`);
  if (r.minWeekendsMonth) bits.push(`weekends a month ${c.now.weekendsMonth || 'none'} → ${c.after.weekendsMonth}`);
  return `Their own limits: ${bits.join(', ')}`;
}

export const OffRequestsPanel: React.FC = () => {
  const { can, setNotice } = useForecast();
  const [tick, setTick] = useState(0);
  const list = useApi<{ items: OffRequest[]; truncated: boolean }>('/workforce/off-requests', [tick]);
  const [ask, setAsk] = useState<null | { r: OffRequest; how: 'APPROVED' | 'REJECTED' }>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const w = can('workforce:write') || can('requests:approve');

  const decide = async (r: OffRequest, status: 'APPROVED' | 'REJECTED', reason: string) => {
    setBusy(true); setError('');
    try {
      const out = await api<{ warnings?: string[] }>(`/workforce/off-requests/${r.id}/decide`, { method: 'POST', body: { status, reason } });
      setAsk(null); setTick((x) => x + 1);
      setNotice({ kind: out.warnings?.length ? 'info' : 'ok', text: `${status === 'APPROVED' ? 'Approved' : 'Declined'} ${r.employeeName}'s request.${out.warnings?.length ? ` ${out.warnings.join(' ')}` : ''}` });
    } catch (e: any) { setError(e.message); } finally { setBusy(false); }
  };

  const cols = useMemo<ColDef<OffRequest>[]>(() => [
    { headerName: 'Employee', field: 'employeeName', minWidth: 160, cellRenderer: (p: any) => <span className="font-medium">{p.value}{p.data.team ? <span className="block text-[11px] font-normal text-[#6B6B6B]">{p.data.team}</span> : null}</span> },
    { headerName: 'Asks for', valueGetter: (p) => offRequestText(p.data!), flex: 2, minWidth: 260, wrapText: true, autoHeight: true },
    { headerName: 'What to weigh', valueGetter: (p) => offContextText(p.data!), flex: 2, minWidth: 220, wrapText: true, autoHeight: true },
    { headerName: 'Status', field: 'status', width: 130, cellRenderer: (p: any) => <span className="flex items-center gap-1 h-full"><Pill tone={TONE[p.value as keyof typeof TONE]}>{LABEL[p.value as keyof typeof LABEL]}</Pill>{p.data?.escalated && p.value === 'REQUESTED' && <Pill tone="warn" title="Waited longer than the escalation time: the managers have been told">Overdue</Pill>}</span> },
    { headerName: 'Their note', field: 'reason', flex: 1, minWidth: 120 },
    { headerName: 'Decided', valueGetter: (p) => (p.data!.decidedBy ? `${p.data!.decidedBy} · ${when(p.data!.decidedAt)}${p.data!.decisionNote ? `: ${p.data!.decisionNote}` : ''}` : ''), minWidth: 180, wrapText: true, autoHeight: true },
    { headerName: '', width: 150, sortable: false, filter: false, cellRenderer: (p: any) => (
      <span className="flex gap-3 items-center h-full text-[12px]">
        {w && p.data.status === 'REQUESTED' && <><button className="font-semibold text-[#2A7553] underline" aria-label={`Approve ${p.data.employeeName}'s request`} onClick={() => { setError(''); setAsk({ r: p.data, how: 'APPROVED' }); }}>Approve</button><button className="font-semibold text-[#BC3F3F] underline" aria-label={`Decline ${p.data.employeeName}'s request`} onClick={() => { setError(''); setAsk({ r: p.data, how: 'REJECTED' }); }}>Decline</button></>}
      </span>) },
  ], [w]);

  const rows = list.data?.items ?? [];
  if (!rows.length) return null;                 // nothing has been asked for: the screen stays as it was
  const waiting = rows.filter((r) => r.status === 'REQUESTED').length;
  return (
    <Card title="Days-off requests" sub={waiting ? `${waiting} waiting for a decision. People ask for weekends off together, or for a standing rule on days off.` : 'What people have asked for about their days off, and how it was decided.'}>
      <Grid<OffRequest> rowData={rows} columnDefs={cols} defaultColDef={{ sortable: true, resizable: true }} loading={list.loading} height={Math.min(480, 90 + rows.length * 56)} getRowId={(p) => p.data.id} />
      {ask && (
        <Confirm title={ask.how === 'APPROVED' ? `Approve ${ask.r.employeeName}'s request?` : `Decline ${ask.r.employeeName}'s request?`} confirmLabel={ask.how === 'APPROVED' ? 'Approve' : 'Decline'} danger={ask.how === 'REJECTED'} reason={ask.how === 'REJECTED'} busy={busy} error={error}
          onCancel={() => setAsk(null)} onConfirm={(why) => void decide(ask.r, ask.how, why)}>
          <p><span className="font-semibold">{offRequestText(ask.r)}</span></p>
          {offContextText(ask.r) && <p>{offContextText(ask.r)}</p>}
          {ask.how === 'APPROVED'
            ? <p>{ask.r.kind === 'WEEKEND_OFF' ? 'Those weekend days become time off: the next schedule you generate leaves them free, and a shift put on them is reported. A schedule already published is not changed.' : 'Their own limits go up as shown. The company and labour-law rules still apply; the strictest one wins.'}</p>
            : <p>They are told it was declined, with your reason.</p>}
          {ask.how === 'APPROVED' && error && <Banner kind="err">{error}</Banner>}
        </Confirm>)}
    </Card>
  );
};
