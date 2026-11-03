/** The smaller tabs of a group: shrinkage categories, manual coverage windows, and the history of changes. */
import React, { useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { api, CoverageWindow, DOW, GroupDto, ShrinkageCategory } from '../../../services/api';
import { Banner, Btn, Empty, Field, Input, Select, Table } from '../../forecasting/ui';
import { useApi } from '../../forecasting/hooks';
import { Confirm, FIELD_LABEL, HistoryRow, Site, showValue, when } from './shared';

const BAR = ['#171717', '#4F6F8F', '#2F7D5A', '#B7791F', '#8A6FA8', '#C84A4A', '#737373', '#5C9EAD'];

export const ShrinkageTab: React.FC<{ group: GroupDto; canWrite: boolean }> = ({ group, canWrite }) => {
  const [tick, setTick] = useState(0);
  const cats = useApi<ShrinkageCategory[]>(`/config/groups/${group.id}/shrinkage-categories`, [tick]);
  const [f, setF] = useState<{ name: string; pct: number } | null>(null);
  const [del, setDel] = useState<ShrinkageCategory | null>(null);
  const [error, setError] = useState('');
  const list = cats.data ?? [];
  const total = Math.round(list.reduce((s, c) => s + c.pct, 0) * 100) / 100;
  const act = async (fn: () => Promise<unknown>, after: () => void) => { setError(''); try { await fn(); after(); setTick((t) => t + 1); } catch (e: any) { setError(e.message); setDel(null); } };

  return (
    <div className="space-y-3">
      <p className="text-[12px] text-[#6B6B6B]">{list.length === 0 ? <>No categories, so staffing uses the flat <b>{group.shrinkagePercent}%</b> from the group's settings.</> : <>Staffing uses the <b>{total}%</b> total of these categories instead of the flat {group.shrinkagePercent}%.</>}</p>
      {list.length > 0 && (
        <>
          <div className="flex h-3 rounded overflow-hidden bg-[#F5F5F0] border border-[#E5E5E0]" role="img" aria-label={`Shrinkage ${total}% in total`}>
            {list.map((c, i) => <div key={c.id} title={`${c.name} ${c.pct}%`} style={{ width: `${(c.pct / Math.max(total, 100)) * 100}%`, background: BAR[i % BAR.length] }} />)}
          </div>
          <Table head={['Category', 'Percent', '']} right={[1, 2]}>
            {list.map((c, i) => (
              <tr key={c.id}>
                <td className="p-2.5"><span className="inline-block w-2.5 h-2.5 rounded-sm mr-2 align-middle" style={{ background: BAR[i % BAR.length] }} />{c.name}</td>
                <td className="p-2.5 text-right font-mono">{c.pct}%</td>
                <td className="p-2.5 text-right">{canWrite && <button aria-label={`Delete ${c.name}`} className="text-[#6B6B6B] hover:text-[#BC3F3F]" onClick={() => setDel(c)}><Trash2 className="w-4 h-4" /></button>}</td>
              </tr>
            ))}
            <tr className="bg-[#FAFAF8] font-semibold"><td className="p-2.5">Total</td><td className="p-2.5 text-right font-mono">{total}%</td><td /></tr>
          </Table>
        </>
      )}
      {error && <Banner kind="err" onClose={() => setError('')}>{error}</Banner>}
      {canWrite && (f ? (
        <div className="border border-[#E5E5E0] rounded-lg p-3 bg-[#FAFAF8] space-y-2">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 items-start">
            <div className="col-span-2"><Field label="Name"><Input autoFocus value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="e.g. Training" /></Field></div>
            <Field label="Percent"><Input type="number" min={0} max={90} value={f.pct} onChange={(e) => setF({ ...f, pct: Number(e.target.value) })} /></Field>
          </div>
          <div className="flex gap-2"><Btn variant="primary" disabled={!f.name.trim()} onClick={() => act(() => api(`/config/groups/${group.id}/shrinkage-categories`, { method: 'POST', body: f }), () => setF(null))}>Add</Btn><Btn onClick={() => setF(null)}>Cancel</Btn></div>
        </div>
      ) : <div><Btn onClick={() => setF({ name: '', pct: 5 })}><Plus className="w-3.5 h-3.5" />Add category</Btn></div>)}
      {del && <Confirm title={`Delete ${del.name}?`} confirmLabel="Delete category" danger onCancel={() => setDel(null)} onConfirm={() => act(() => api(`/config/groups/${group.id}/shrinkage-categories/${del.id}`, { method: 'DELETE' }), () => setDel(null))}>
        <p>Staffing for {group.name} will count {Math.round((total - del.pct) * 100) / 100}% shrinkage{list.length === 1 ? `, and fall back to the flat ${group.shrinkagePercent}%` : ''} from now on.</p>
      </Confirm>}
    </div>
  );
};

export const CoverageTab: React.FC<{ group: GroupDto; canWrite: boolean }> = ({ group, canWrite }) => {
  const [tick, setTick] = useState(0);
  const windows = useApi<CoverageWindow[]>(`/config/groups/${group.id}/coverage-windows`, [tick]);
  const [f, setF] = useState<{ dayOfWeek: number; startTime: string; endTime: string; headcount: number } | null>(null);
  const [del, setDel] = useState<CoverageWindow | null>(null);
  const [error, setError] = useState('');
  const list = [...(windows.data ?? [])].sort((a, b) => a.dayOfWeek - b.dayOfWeek || a.startTime.localeCompare(b.startTime));
  const act = async (fn: () => Promise<unknown>, after: () => void) => { setError(''); try { await fn(); after(); setTick((t) => t + 1); } catch (e: any) { setError(e.message); setDel(null); } };

  return (
    <div className="space-y-3">
      <p className="text-[12px] text-[#6B6B6B]">Weekly windows that say how many people are needed, so Generate Schedule can build a schedule without a forecast.</p>
      {list.length === 0 ? <Empty title="No manual coverage">Add windows if you want to schedule without a forecast.</Empty> : (
        <Table head={['Day', 'Window', 'People needed', '']} right={[2, 3]}>
          {list.map((w) => (
            <tr key={w.id}>
              <td className="p-2.5">{DOW[w.dayOfWeek]}</td>
              <td className="p-2.5 font-mono text-[12px]">{w.startTime}–{w.endTime}</td>
              <td className="p-2.5 text-right">{w.headcount}</td>
              <td className="p-2.5 text-right">{canWrite && <button aria-label={`Delete ${DOW[w.dayOfWeek]} ${w.startTime}-${w.endTime}`} className="text-[#6B6B6B] hover:text-[#BC3F3F]" onClick={() => setDel(w)}><Trash2 className="w-4 h-4" /></button>}</td>
            </tr>
          ))}
        </Table>
      )}
      {error && <Banner kind="err" onClose={() => setError('')}>{error}</Banner>}
      {canWrite && (f ? (
        <div className="border border-[#E5E5E0] rounded-lg p-3 bg-[#FAFAF8] space-y-2">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 items-start">
            <Field label="Day"><Select value={f.dayOfWeek} onChange={(e) => setF({ ...f, dayOfWeek: Number(e.target.value) })}>{DOW.map((d, n) => <option key={d} value={n}>{d}</option>)}</Select></Field>
            <Field label="Start"><Input type="time" step={900} value={f.startTime} onChange={(e) => setF({ ...f, startTime: e.target.value })} /></Field>
            <Field label="End"><Input type="time" step={900} value={f.endTime} onChange={(e) => setF({ ...f, endTime: e.target.value })} /></Field>
            <Field label="People needed"><Input type="number" min={0} max={500} value={f.headcount} onChange={(e) => setF({ ...f, headcount: Number(e.target.value) })} /></Field>
          </div>
          {f.endTime <= f.startTime && <p className="text-[12px] text-[#BC3F3F]">The end must be after the start.</p>}
          <div className="flex gap-2"><Btn variant="primary" disabled={f.endTime <= f.startTime} onClick={() => act(() => api(`/config/groups/${group.id}/coverage-windows`, { method: 'POST', body: f }), () => setF(null))}>Add</Btn><Btn onClick={() => setF(null)}>Cancel</Btn></div>
        </div>
      ) : <div><Btn onClick={() => setF({ dayOfWeek: 0, startTime: '09:00', endTime: '17:00', headcount: 1 })}><Plus className="w-3.5 h-3.5" />Add window</Btn></div>)}
      {del && <Confirm title="Delete this window?" confirmLabel="Delete window" danger onCancel={() => setDel(null)} onConfirm={() => act(() => api(`/config/groups/${group.id}/coverage-windows/${del.id}`, { method: 'DELETE' }), () => setDel(null))}>
        <p>{DOW[del.dayOfWeek]} {del.startTime}–{del.endTime}, {del.headcount} {del.headcount === 1 ? 'person' : 'people'}.</p>
      </Confirm>}
    </div>
  );
};

export const HistoryTab: React.FC<{ group: GroupDto; sites: Site[]; tick: number }> = ({ group, sites, tick }) => {
  const rows = useApi<HistoryRow[]>(`/config/groups/${group.id}/history`, [tick]);
  if (rows.error) return <Banner kind="err">{rows.error}</Banner>;
  if (!rows.data) return <p className="text-[12px] text-[#6B6B6B]">Loading…</p>;
  if (!rows.data.length) return <Empty title="No changes recorded yet">Changes to this group and its queues appear here with who made them and why.</Empty>;
  return (
    <ol className="divide-y divide-[#E5E5E0] border border-[#E5E5E0] rounded-lg">
      {rows.data.map((r) => (
        <li key={r.id} className="p-3 space-y-1">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <div className="text-[13px]"><span className="font-semibold">{r.actor}</span> <span className="text-[#525252]">{r.action === 'CREATE' ? 'created' : r.action === 'DELETE' ? 'deleted' : r.action === 'IMPORT' ? 'imported' : 'changed'} {r.what.toLowerCase()}</span></div>
            <div className="text-[11px] text-[#6B6B6B]">{when(r.at)}</div>
          </div>
          {r.summary && <div className="text-[12px] text-[#525252]">{r.summary}</div>}
          {r.changes.length > 0 && <ul className="text-[12px] text-[#171717] space-y-0.5">{r.changes.map((c) => <li key={c.field}><span className="text-[#6B6B6B]">{FIELD_LABEL[c.field] ?? c.field}:</span> {showValue(c.field, c.from, sites)} → <b>{showValue(c.field, c.to, sites)}</b></li>)}</ul>}
          {r.reason && <div className="text-[12px] italic text-[#525252]">“{r.reason}”</div>}
        </li>
      ))}
    </ol>
  );
};
