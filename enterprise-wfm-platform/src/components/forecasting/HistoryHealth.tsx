/**
 * Forecast Builder: is each queue's history fit to forecast from? Short or stale history, gaps, odd days, abandoned callers and odd handle times,
 * worst first, with how many days the forecast will repair. A queue whose volume counts only answered calls can be switched here so the
 * abandoned callers are added back into demand.
 */
import React, { useState } from 'react';
import { api } from '../../services/api';
import { useForecast } from '../../services/forecastStore';
import { useApi } from './hooks';
import { Banner, Busy, Card, Pill } from './ui';

type Finding = { code: string; severity: 'INFO' | 'WARNING' | 'CRITICAL'; message: string; days?: string[]; count?: number };
type QueueQ = { queueId: string; name: string; status: 'GOOD' | 'CHECK' | 'POOR'; firstDay: string | null; lastDay: string | null; days: number; abandonRatePct: number | null; volumeBasis: 'OFFERED' | 'ANSWERED'; repairedDays: number; findings: Finding[] };
type Queue = { id: string; name?: string; channel?: string; volumeBasis?: 'OFFERED' | 'ANSWERED'; abandonRepeatPct?: number; shapeFromQueueId?: string | null };

const STATUS = { GOOD: { label: 'Good', tone: 'good' }, CHECK: { label: 'Check', tone: 'warn' }, POOR: { label: 'Poor', tone: 'bad' } } as const;
const SEV: Record<Finding['severity'], string> = { CRITICAL: '#C84A4A', WARNING: '#B7791F', INFO: '#4F6F8F' };

export const HistoryHealth: React.FC<{ groupId: string }> = ({ groupId }) => {
  const { can } = useForecast();
  const [tick, setTick] = useState(0);
  const r = useApi<{ queues: QueueQ[]; pending?: string[] }>(`/forecast/history-quality?groupId=${groupId}`, [groupId, tick]);
  // the odd-handle-time check is worked out in the background on a big history: ask again in a few seconds until it is in (at most a minute)
  const tries = React.useRef(0);
  React.useEffect(() => { tries.current = 0; }, [groupId]);
  React.useEffect(() => {
    if (!r.data?.pending?.length || tries.current >= 20) return;
    const t = setTimeout(() => { tries.current++; setTick((x) => x + 1); }, 3000);
    return () => clearTimeout(t);
  }, [r.data]);
  const cfg = useApi<Queue[]>('/config/queues', [tick]);
  const [open, setOpen] = useState<string | null>(null);
  const [err, setErr] = useState('');
  const canWrite = can('config:write');
  const set = async (id: string, patch: Partial<Queue>) => {
    setErr('');
    try { await api(`/config/queues/${id}`, { method: 'PUT', body: patch }); setTick((n) => n + 1); } catch (e: any) { setErr(e.message); }
  };
  const queues = r.data?.queues ?? [];
  return (
    <Card title="Is the history fit to forecast from?" sub="Checked before you build: how much history there is, whether it is current, gaps and odd days. The forecast repairs odd days itself; this shows how many, so you can fix the data at its source.">
      {r.loading && !r.data ? <Busy /> : null}
      {r.error && <Banner kind="err">{r.error}</Banner>}
      {err && <Banner kind="err" onClose={() => setErr('')}>{err}</Banner>}
      {!r.loading && r.data && !queues.length && <div className="text-[13px] text-[#6B6B6B]">This group has no queues yet.</div>}
      <div className="divide-y divide-[#E5E5E0]">
        {queues.map((q) => {
          const conf = cfg.data?.find((x) => x.id === q.queueId), st = STATUS[q.status], isOpen = open === q.queueId;
          return (
            <div key={q.queueId} className="py-3">
              <div className="flex flex-wrap items-center gap-3">
                <button className="flex items-center gap-2 text-left" onClick={() => setOpen(isOpen ? null : q.queueId)} aria-expanded={isOpen}>
                  <span className="font-semibold text-[13px]">{q.name}</span>
                  <Pill tone={st.tone}>{st.label}</Pill>
                </button>
                <span className="text-[12px] text-[#525252]">
                  {q.days ? `${q.days} days of history${q.firstDay ? `, ${q.firstDay} to ${q.lastDay}` : ''}` : 'No history'}
                  {q.abandonRatePct != null ? ` · ${q.abandonRatePct}% abandoned` : ''}
                  {q.repairedDays ? ` · ${q.repairedDays} day${q.repairedDays === 1 ? '' : 's'} will be repaired` : ''}
                </span>
                <span className="ml-auto text-[12px] text-[#6B6B6B]">{q.findings.length ? `${q.findings.length} finding${q.findings.length === 1 ? '' : 's'}` : 'Nothing to fix'}</span>
              </div>
              {isOpen && (
                <div className="mt-2 space-y-2">
                  {q.findings.length === 0 && <div className="text-[13px] text-[#2A7553]">The history is long enough, current, complete and consistent.</div>}
                  {q.findings.map((f, i) => (
                    <div key={i} className="text-[13px] border-l-4 pl-3 py-0.5" style={{ borderColor: SEV[f.severity] }}>{f.message}</div>
                  ))}
                  <div className="flex flex-wrap items-center gap-3 pt-1 text-[13px]">
                    <label className="flex items-center gap-2">What “volume” in the history counts
                      <select disabled={!canWrite || !conf} value={conf?.volumeBasis ?? q.volumeBasis} onChange={(e) => set(q.queueId, { volumeBasis: e.target.value as 'OFFERED' | 'ANSWERED' })} className="border border-[#E5E5E0] rounded-md px-2 py-1 bg-white">
                        <option value="OFFERED">Every call that arrived</option>
                        <option value="ANSWERED">Answered calls only</option>
                      </select>
                    </label>
                    {(conf?.volumeBasis ?? q.volumeBasis) === 'ANSWERED' && (
                      <label className="flex items-center gap-2">Abandoned callers who ring again
                        <input type="number" min={0} max={100} disabled={!canWrite} defaultValue={conf?.abandonRepeatPct ?? 0} onBlur={(e) => { const v = Math.max(0, Math.min(100, Math.round(Number(e.target.value) || 0))); if (v !== (conf?.abandonRepeatPct ?? 0)) void set(q.queueId, { abandonRepeatPct: v }); }} className="w-16 border border-[#E5E5E0] rounded-md px-2 py-1" /> %
                      </label>
                    )}
                    <label className="flex items-center gap-2" title="For a new queue with only a few weeks of history: spread each day over the hours the way a similar queue does, until this queue has 28 days of its own. Its volume still comes from its own history.">Borrow the daily pattern of
                      <select disabled={!canWrite || !conf} value={conf?.shapeFromQueueId ?? ''} onChange={(e) => void set(q.queueId, { shapeFromQueueId: e.target.value || null })} className="border border-[#E5E5E0] rounded-md px-2 py-1 bg-white">
                        <option value="">None: use its own history</option>
                        {(cfg.data ?? []).filter((o) => o.id !== q.queueId && o.channel === conf?.channel && !o.shapeFromQueueId).map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
                      </select>
                    </label>
                    {!canWrite && <span className="text-[12px] text-[#6B6B6B]">You need permission to change queue settings.</span>}
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </Card>
  );
};
