/**
 * Workforce › Time Off › Leave balances. Two jobs:
 *   1. A person's balance for a year, and adjusting their days by hand (a grant, a deduction, a payout or a correction), each with a reason that is kept.
 *   2. Closing a leave year: what each person carries into the next year is written down once, so the next year starts from a record and not an estimate.
 */
import React, { useState } from 'react';
import { api } from '../../services/api';
import { useForecast } from '../../services/forecastStore';
import { useApi } from '../forecasting/hooks';
import { PersonPicker } from '../common/PersonPicker';
import { Banner, Btn, Card, Field, Input, Select } from '../forecasting/ui';

const TYPES: Record<string, string> = { VACATION: 'Vacation', SICK: 'Sick leave', PERSONAL: 'Personal', HOLIDAY: 'Holiday', TRAINING: 'Training', LEAVE: 'Other leave', OTHER: 'Other' };
const KINDS = [['GRANT', 'Add days (a grant)'], ['DEDUCT', 'Take days off'], ['PAYOUT', 'Paid out in cash'], ['CORRECTION', 'Correction (plus or minus)']] as const;
type Balance = { type: string; entitledDays: number; accruedDays: number; carriedOverDays: number; expiredDays: number; adjustedDays: number; usedDays: number; remainingDays: number; carryExpiresOn: string | null; estimated: boolean };
type Adjustment = { id: string; type: string; year: number; days: number; kind: string; reason: string; createdBy: string; createdAt: string };
type CloseState = { year: number; canClose: boolean; closed: { people: number; closedAt: string; closedBy: string } | null; preview: { people: number; byType: { type: string; people: number; carriedOut: number; lapsed: number; expired: number; used: number }[] } };
const thisYear = new Date().getFullYear();
const num = (n: number) => (Math.round(n * 100) / 100).toLocaleString('en-US');

const PersonBalances: React.FC = () => {
  const { can } = useForecast();
  const [person, setPerson] = useState('');
  const [year, setYear] = useState(thisYear);
  const [tick, setTick] = useState(0);
  const data = useApi<{ year: number; balances: Balance[]; adjustments: Adjustment[] }>(person ? `/self-service/leave/balances?employeeId=${person}&year=${year}` : null, [person, year, tick]);
  const [f, setF] = useState({ type: 'VACATION', kind: 'GRANT', days: '', reason: '' });
  const [err, setErr] = useState(''); const [ok, setOk] = useState(''); const [busy, setBusy] = useState(false);
  const canWrite = can('workforce:write');

  const save = async () => {
    setErr(''); setOk(''); setBusy(true);
    try {
      await api('/self-service/leave/adjustments', { method: 'POST', body: { employeeId: person, type: f.type, year, kind: f.kind, days: Number(f.days), reason: f.reason.trim() } });
      setOk('Saved. The balance is updated.'); setF({ ...f, days: '', reason: '' }); setTick((n) => n + 1);
    } catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  };
  const bad = !f.days || Number(f.days) === 0 || Number.isNaN(Number(f.days)) || f.reason.trim().length < 3 || (f.kind !== 'CORRECTION' && Number(f.days) < 0);

  return (
    <Card title="A person's leave balance" sub="What they have, what carried in from last year, and any days added or taken off by hand. Every adjustment keeps who made it and why.">
      <div className="grid grid-cols-1 md:grid-cols-[minmax(0,320px)_120px] gap-3 items-end">
        <Field label="Person"><PersonPicker value={person} onChange={(id) => { setPerson(id); setErr(''); setOk(''); }} /></Field>
        <Field label="Year"><Select value={year} onChange={(e) => setYear(Number(e.target.value))}>{[thisYear + 1, thisYear, thisYear - 1, thisYear - 2].map((y) => <option key={y} value={y}>{y}</option>)}</Select></Field>
      </div>
      {!person ? <p className="text-[12px] text-[#6B6B6B]">Choose a person to see their balance.</p> : data.error ? <Banner kind="err">{data.error}</Banner> : !data.data ? <p className="text-[12px] text-[#6B6B6B]">Loading…</p> : (
        <>
          {data.data.balances.length === 0 ? <p className="text-[12px] text-[#6B6B6B]">No leave allowance is set up (Configuration › Self-Service Rules).</p> : (
            <table className="w-full text-[12px]">
              <thead className="text-left text-[#6B6B6B]"><tr><th className="py-1">Leave</th><th className="text-right">Entitled</th><th className="text-right">Carried in</th><th className="text-right">Adjusted</th><th className="text-right">Used</th><th className="text-right">Lapsed</th><th className="text-right">Left</th></tr></thead>
              <tbody>{data.data.balances.map((b) => (
                <tr key={b.type} className="border-t border-[#E5E5E0]">
                  <td className="py-1.5 font-semibold">{TYPES[b.type] ?? b.type}</td>
                  <td className="text-right tabular-nums">{num(b.entitledDays)}</td>
                  <td className="text-right tabular-nums">{num(b.carriedOverDays)}{b.estimated && <span title="Last year is not closed yet, so this is an estimate" className="ml-1 text-[#B7791F]">≈</span>}</td>
                  <td className="text-right tabular-nums">{b.adjustedDays > 0 ? '+' : ''}{num(b.adjustedDays)}</td>
                  <td className="text-right tabular-nums">{num(b.usedDays)}</td>
                  <td className="text-right tabular-nums" title={b.carryExpiresOn ? `Carried days not used by ${b.carryExpiresOn} lapse` : undefined}>{num(b.expiredDays)}</td>
                  <td className="text-right tabular-nums font-semibold">{num(b.remainingDays)}</td>
                </tr>
              ))}</tbody>
            </table>
          )}
          {data.data.balances.some((b) => b.estimated) && <p className="text-[11px] text-[#B7791F]">≈ means last year has not been closed, so the carried days are an estimate. Close the year below to make them exact.</p>}

          {canWrite && data.data.balances.length > 0 && (
            <div className="border-t border-[#E5E5E0] pt-3 space-y-3">
              <div className="text-[12px] font-semibold">Adjust days for {year}</div>
              {err && <Banner kind="err" onClose={() => setErr('')}>{err}</Banner>}
              {ok && <Banner kind="ok" onClose={() => setOk('')}>{ok}</Banner>}
              <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
                <Field label="Leave"><Select value={f.type} onChange={(e) => setF({ ...f, type: e.target.value })}>{data.data.balances.map((b) => <option key={b.type} value={b.type}>{TYPES[b.type] ?? b.type}</option>)}</Select></Field>
                <Field label="What happened"><Select value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })}>{KINDS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</Select></Field>
                <Field label="Days" hint={f.kind === 'CORRECTION' ? 'Minus takes days off' : undefined}><Input type="number" step={0.5} value={f.days} onChange={(e) => setF({ ...f, days: e.target.value })} /></Field>
                <Field label="Why"><Input value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} placeholder="For example: long service award" /></Field>
              </div>
              <Btn variant="primary" disabled={busy || bad} onClick={save}>{busy ? 'Saving…' : 'Save adjustment'}</Btn>
            </div>
          )}

          {data.data.adjustments.length > 0 && (
            <div className="border-t border-[#E5E5E0] pt-3">
              <div className="text-[12px] font-semibold mb-1.5">Adjustments in {year}</div>
              <ul className="space-y-1 text-[12px]">{data.data.adjustments.map((a) => (
                <li key={a.id} className="flex flex-wrap gap-x-3">
                  <span className="font-semibold tabular-nums w-14">{a.days > 0 ? '+' : ''}{num(a.days)} d</span>
                  <span>{TYPES[a.type] ?? a.type} · {KINDS.find(([k]) => k === a.kind)?.[1] ?? a.kind}</span>
                  <span className="text-[#525252]">“{a.reason}”</span>
                  <span className="text-[#6B6B6B]">{a.createdBy}, {new Date(a.createdAt).toLocaleDateString('en-GB')}</span>
                </li>
              ))}</ul>
            </div>
          )}
        </>
      )}
    </Card>
  );
};

const YearEnd: React.FC = () => {
  const { can } = useForecast();
  const [year, setYear] = useState(thisYear - 1);
  const [tick, setTick] = useState(0);
  const s = useApi<CloseState>(`/self-service/leave/year-close?year=${year}`, [year, tick]);
  const [reason, setReason] = useState(''); const [err, setErr] = useState(''); const [ok, setOk] = useState(''); const [busy, setBusy] = useState(false); const [confirm, setConfirm] = useState(false);
  const canWrite = can('workforce:write');

  const close = async () => {
    setErr(''); setOk(''); setBusy(true);
    try { await api('/self-service/leave/year-close', { method: 'POST', body: { year, reason: reason.trim() } }); setOk(`${year} is closed. ${year + 1} now starts from what each person carries.`); setReason(''); setConfirm(false); setTick((n) => n + 1); }
    catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  };

  return (
    <Card title="Close a leave year" sub="At the end of the year, write down what each person carries forward (up to the limit for each leave type), what lapses, and what was used. The next year then starts from that record.">
      <div className="max-w-[160px]"><Field label="Year"><Select value={year} onChange={(e) => { setYear(Number(e.target.value)); setOk(''); setErr(''); setConfirm(false); }}>{[thisYear - 1, thisYear - 2, thisYear - 3].map((y) => <option key={y} value={y}>{y}</option>)}</Select></Field></div>
      {err && <Banner kind="err" onClose={() => setErr('')}>{err}</Banner>}
      {ok && <Banner kind="ok" onClose={() => setOk('')}>{ok}</Banner>}
      {!s.data ? <p className="text-[12px] text-[#6B6B6B]">{s.error ?? 'Loading…'}</p> : (
        <>
          {s.data.closed
            ? <Banner kind="ok">{year} was closed on {new Date(s.data.closed.closedAt).toLocaleDateString('en-GB')} by {s.data.closed.closedBy} for {s.data.closed.people.toLocaleString('en-US')} people. Closing again recalculates it.</Banner>
            : <p className="text-[12px] text-[#6B6B6B]">{year} has not been closed. Until it is, carried days are estimated from this year's allowance.</p>}
          {s.data.preview.byType.length === 0 ? <p className="text-[12px] text-[#6B6B6B]">No leave allowance is set up, so there is nothing to carry.</p> : (
            <table className="w-full text-[12px]">
              <thead className="text-left text-[#6B6B6B]"><tr><th className="py-1">Leave</th><th className="text-right">People</th><th className="text-right">Days used</th><th className="text-right">Carried forward</th><th className="text-right">Lapse at year end</th><th className="text-right">Carried days not used in time</th></tr></thead>
              <tbody>{s.data.preview.byType.map((t) => (
                <tr key={t.type} className="border-t border-[#E5E5E0]">
                  <td className="py-1.5 font-semibold">{TYPES[t.type] ?? t.type}</td><td className="text-right tabular-nums">{t.people.toLocaleString('en-US')}</td><td className="text-right tabular-nums">{num(t.used)}</td>
                  <td className="text-right tabular-nums">{num(t.carriedOut)}</td><td className="text-right tabular-nums">{num(t.lapsed)}</td><td className="text-right tabular-nums">{num(t.expired)}</td>
                </tr>
              ))}</tbody>
            </table>
          )}
          {canWrite && s.data.canClose && (
            <div className="border-t border-[#E5E5E0] pt-3 space-y-3">
              <Field label="Why are you closing it?" hint="Kept in the audit trail"><Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="For example: year end" /></Field>
              {!confirm ? <Btn variant="primary" disabled={reason.trim().length < 3} onClick={() => setConfirm(true)}>{s.data.closed ? `Recalculate ${year}` : `Close ${year}`}</Btn> : (
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-[12px]">This writes the balances above for {s.data.preview.people.toLocaleString('en-US')} people. Continue?</span>
                  <Btn variant="primary" disabled={busy} onClick={close}>{busy ? 'Closing…' : `Yes, close ${year}`}</Btn><Btn disabled={busy} onClick={() => setConfirm(false)}>Not yet</Btn>
                </div>
              )}
            </div>
          )}
          {!s.data.canClose && <p className="text-[12px] text-[#6B6B6B]">A year can be closed once it has ended.</p>}
        </>
      )}
    </Card>
  );
};

export const LeaveBalances: React.FC = () => (
  <div className="space-y-4">
    <PersonBalances />
    <YearEnd />
  </div>
);
