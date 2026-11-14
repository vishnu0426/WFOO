/**
 * Forecast Builder: is the history fit to forecast from? Leads with one plain verdict (red only when a forecast cannot be built), then for each queue its history length and freshness
 * and the issues as small cards: what is wrong, what it means for the forecast, and a button for the fix. Optional tips are kept apart from cautions so they never inflate the count.
 * Technical settings (what counts as demand, abandoned callers who ring again, borrowing another queue's daily pattern, how old is out of date) sit behind "Advanced settings".
 */
import { Waiting } from '../common/loading';
import React, { useState } from 'react';
import { api } from '../../services/api';
import { kindOf, statusLine, verdictFor, type FindingSummary, summarizeFindings, findingsText, type Kind } from '../../services/forecastForm';
import { useForecast } from '../../services/forecastStore';
import { useApi } from './hooks';
import { Banner } from './ui';

type Fix = { action: 'IMPORT' | 'USE_OWN_HISTORY' | 'SET_ANSWERED' | 'SET_OFFERED' | 'ADD_EVENT'; label: string };
type Finding = { code: string; severity: 'INFO' | 'WARNING' | 'CRITICAL'; kind: Kind; title: string; effect: string; fix: Fix | null; message: string; days?: string[]; count?: number };
type QueueQ = {
  queueId: string; name: string; firstDay: string | null; lastDay: string | null; days: number; abandonRatePct: number | null; volumeBasis: 'OFFERED' | 'ANSWERED'; repairedDays: number; findings: Finding[];
  length: { level: 'GOOD' | 'OK' | 'LOW' | 'NONE'; days: number }; freshness: { level: 'CURRENT' | 'BEHIND' | 'OLD' | 'NONE'; daysBehind: number | null; lastDay: string | null };
};
type Queue = { id: string; name?: string; channel?: string; volumeBasis?: 'OFFERED' | 'ANSWERED'; abandonRepeatPct?: number; shapeFromQueueId?: string | null };

const LEVEL = {
  READY: { box: 'border-[#2F7D5A] bg-[#F1F8F4] text-[#1F5C41]', dot: '#2F7D5A' },
  CAUTION: { box: 'border-[#B7791F] bg-[#FFF8EB] text-[#7A5210]', dot: '#B7791F' },
  BLOCKED: { box: 'border-[#C84A4A] bg-[#FDF2F2] text-[#9B2C2C]', dot: '#C84A4A' },
} as const;
const EDGE: Record<Kind, string> = { BLOCK: '#C84A4A', CAUTION: '#B7791F', TIP: '#4F6F8F' };
const KIND_WORD: Record<Kind, string> = { BLOCK: 'Blocking', CAUTION: 'Caution', TIP: 'Tip' };

export const HistoryHealth: React.FC<{ groupId: string; onSummary?: (s: FindingSummary) => void; onGoSection?: (id: string) => void }> = ({ groupId, onSummary, onGoSection }) => {
  const { can, go } = useForecast();
  const [tick, setTick] = useState(0);
  const r = useApi<{ queues: QueueQ[]; pending?: string[]; staleAfterDays?: number }>(`/forecast/history-quality?groupId=${groupId}`, [groupId, tick]);
  // the odd-handle-time check is worked out in the background on a big history: ask again in a few seconds until it is in (at most a minute)
  const tries = React.useRef(0);
  React.useEffect(() => { tries.current = 0; }, [groupId]);
  React.useEffect(() => {
    if (!r.data?.pending?.length || tries.current >= 20) return;
    const t = setTimeout(() => { tries.current++; setTick((x) => x + 1); }, 3000);
    return () => clearTimeout(t);
  }, [r.data]);
  const cfg = useApi<Queue[]>('/config/queues', [tick]);
  // a queue with something to look at opens by itself, so a problem in the history is read, not found: the planner can still close it
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [adv, setAdv] = useState<Set<string>>(new Set());
  const [advGroup, setAdvGroup] = useState(false);
  const seeded = React.useRef('');
  const [err, setErr] = useState('');
  const [busyFix, setBusyFix] = useState('');
  const canWrite = can('config:write');
  const set = async (id: string, patch: Partial<Queue>) => {
    setErr('');
    try { await api(`/config/queues/${id}`, { method: 'PUT', body: patch }); setTick((n) => n + 1); } catch (e: any) { setErr(e.message); }
  };
  const setStale = async (days: number) => {
    setErr('');
    try { await api(`/config/groups/${groupId}`, { method: 'PUT', body: { historyStaleDays: days } }); setTick((n) => n + 1); } catch (e: any) { setErr(e.message); }
  };
  const fix = async (q: QueueQ, f: Finding) => {
    const a = f.fix!.action;
    if (a === 'IMPORT') { go('staged-imports', 'data-management'); return; }
    if (a === 'ADD_EVENT') { onGoSection?.('events'); return; }
    setBusyFix(`${q.queueId}|${f.code}`);
    try {
      if (a === 'USE_OWN_HISTORY') await set(q.queueId, { shapeFromQueueId: null });
      else if (a === 'SET_ANSWERED') await set(q.queueId, { volumeBasis: 'ANSWERED' });
      else if (a === 'SET_OFFERED') await set(q.queueId, { volumeBasis: 'OFFERED' });
    } finally { setBusyFix(''); }
  };
  const queues = r.data?.queues ?? [];
  const summary = summarizeFindings(queues);
  const verdict = verdictFor(queues);
  React.useEffect(() => {
    if (!r.data) return;
    if (seeded.current !== groupId) { seeded.current = groupId; setOpen(new Set(queues.filter((q) => q.findings.some((f) => kindOf(f) !== 'TIP')).map((q) => q.queueId))); }
    onSummary?.(summary);
  }, [r.data, groupId]);          // eslint-disable-line react-hooks/exhaustive-deps
  const toggle = (setter: React.Dispatch<React.SetStateAction<Set<string>>>, id: string) => setter((cur) => { const n = new Set(cur); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const field = 'border border-[#E5E5E0] rounded-md px-2 py-1 bg-white';

  return (
    <section aria-label="Is the history fit to forecast from?" className="space-y-3">
      <div>
        <h3 className="text-[15px] font-semibold">Is the history fit to forecast from?</h3>
        <p className="text-[12px] text-[#6B6B6B]">Checked before you build. The forecast repairs odd days itself; this shows what will be repaired and what you can fix at the source.</p>
      </div>
      {r.loading && !r.data ? <Waiting what="the history check" shape="table" reload={r.reload} /> : null}
      {r.data && queues.length > 0 && (
        <div role="status" data-testid="history-verdict" data-level={verdict.level} className={`rounded-md border px-3 py-2.5 text-[13px] ${LEVEL[verdict.level].box}`}>
          <div className="flex flex-wrap items-center gap-x-3">
            <span className="font-semibold">{verdict.label}</span>
            {(summary.cautions > 0 || summary.tips > 0 || summary.blocks > 0) && <span className="text-[12px] opacity-80">{findingsText(summary)}</span>}
          </div>
          <div>{verdict.text}</div>
        </div>)}
      {r.error && <Banner kind="err">{r.error}</Banner>}
      {err && <Banner kind="err" onClose={() => setErr('')}>{err}</Banner>}
      {!r.loading && r.data && !queues.length && <div className="text-[13px] text-[#6B6B6B]">This group has no queues yet.</div>}
      <div className="divide-y divide-[#E5E5E0] rounded-md border border-[#E5E5E0] bg-white px-4">
        {queues.map((q) => {
          const conf = cfg.data?.find((x) => x.id === q.queueId), isOpen = open.has(q.queueId), isAdv = adv.has(q.queueId);
          const v = verdictFor([q]);
          const attention = q.findings.filter((f) => kindOf(f) !== 'TIP'), tips = q.findings.filter((f) => kindOf(f) === 'TIP');
          const card = (f: Finding, i: number) => {
            const k = kindOf(f), busy = busyFix === `${q.queueId}|${f.code}`;
            const needsWrite = f.fix && f.fix.action !== 'IMPORT' && f.fix.action !== 'ADD_EVENT';
            return (
              <div key={`${f.code}${i}`} data-testid="issue-card" data-kind={k} className="rounded-md border border-[#E5E5E0] border-l-4 bg-white px-3 py-2 text-[13px]" style={{ borderLeftColor: EDGE[k] }}>
                <div className="flex flex-wrap items-center gap-2"><span className="font-semibold">{f.title}</span><span className="text-[11px] font-semibold uppercase tracking-wide" style={{ color: EDGE[k] }}>{KIND_WORD[k]}</span></div>
                <div className="text-[12px] text-[#525252]">{f.message}</div>
                {f.effect && <div className="mt-1"><span className="font-medium">What it means: </span>{f.effect}</div>}
                {f.fix && (
                  <div className="mt-2">
                    <button type="button" disabled={busy || (!!needsWrite && !canWrite)} onClick={() => void fix(q, f)} title={needsWrite && !canWrite ? 'You need permission to change queue settings.' : undefined}
                      className="h-8 rounded-md border border-[#D0D0C8] bg-white px-3 text-[13px] font-medium hover:bg-[#F5F5F0] disabled:opacity-50">{busy ? 'Working…' : f.fix.label}</button>
                  </div>)}
              </div>
            );
          };
          return (
            <div key={q.queueId} className="py-3" data-queue={q.name}>
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <button className="flex items-center gap-2 text-left" onClick={() => toggle(setOpen, q.queueId)} aria-expanded={isOpen}>
                  <span className="font-semibold text-[13px]">{q.name}</span>
                  <span className="inline-flex items-center gap-1 text-[12px] font-medium" style={{ color: LEVEL[v.level].dot }}><span aria-hidden className="inline-block size-2 rounded-full" style={{ background: LEVEL[v.level].dot }} />{v.label}</span>
                </button>
                <span className="text-[12px] text-[#525252]" data-testid="status-line">{statusLine(q)}</span>
                <span className="ml-auto text-[12px] text-[#6B6B6B]">
                  {attention.length ? `${attention.length} ${attention.length === 1 ? 'caution' : 'cautions'}` : 'Nothing to fix'}{tips.length ? ` · ${tips.length} ${tips.length === 1 ? 'tip' : 'tips'}` : ''}
                </span>
              </div>
              {isOpen && (
                <div className="mt-2 space-y-2">
                  {q.repairedDays > 0 && <div className="text-[12px] text-[#2A7553]">{q.repairedDays} odd {q.repairedDays === 1 ? 'day' : 'days'} will be repaired automatically.</div>}
                  {q.findings.length === 0 && <div className="text-[13px] text-[#2A7553]">The history is long enough, current, complete and consistent.</div>}
                  {attention.map(card)}
                  {tips.length > 0 && <div className="pt-1 text-[12px] font-semibold uppercase tracking-wide text-[#6B6B6B]">Optional tips</div>}
                  {tips.map(card)}
                  <div>
                    <button type="button" className="text-[12px] text-[#525252] underline" aria-expanded={isAdv} onClick={() => toggle(setAdv, q.queueId)}>{isAdv ? 'Hide advanced settings' : 'Advanced settings for this queue'}</button>
                    {isAdv && (
                      <div className="mt-2 flex flex-wrap items-center gap-x-5 gap-y-2 rounded-md bg-[#FAFAF7] p-3 text-[13px]" data-testid="advanced">
                        <label className="flex items-center gap-2">What counts as demand in the history
                          <select disabled={!canWrite || !conf} value={conf?.volumeBasis ?? q.volumeBasis} onChange={(e) => set(q.queueId, { volumeBasis: e.target.value as 'OFFERED' | 'ANSWERED' })} className={field}>
                            <option value="OFFERED">Every call that arrived</option>
                            <option value="ANSWERED">Answered calls only</option>
                          </select>
                        </label>
                        {(conf?.volumeBasis ?? q.volumeBasis) === 'ANSWERED' && (
                          <label className="flex items-center gap-2">Abandoned callers who ring again
                            <input type="number" min={0} max={100} disabled={!canWrite} defaultValue={conf?.abandonRepeatPct ?? 0} onBlur={(e) => { const x = Math.max(0, Math.min(100, Math.round(Number(e.target.value) || 0))); if (x !== (conf?.abandonRepeatPct ?? 0)) void set(q.queueId, { abandonRepeatPct: x }); }} className={`w-16 ${field}`} /> %
                          </label>
                        )}
                        <label className="flex items-center gap-2" title="For a new queue with only a few weeks of history: spread each day over the hours the way a similar queue does, until this queue has 28 days of its own. Its volume still comes from its own history.">Copy the hourly shape from
                          <select disabled={!canWrite || !conf} value={conf?.shapeFromQueueId ?? ''} onChange={(e) => void set(q.queueId, { shapeFromQueueId: e.target.value || null })} className={field}>
                            <option value="">None: use its own history</option>
                            {(cfg.data ?? []).filter((o) => o.id !== q.queueId && o.channel === conf?.channel && !o.shapeFromQueueId).map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
                          </select>
                        </label>
                        {!canWrite && <span className="text-[12px] text-[#6B6B6B]">You need permission to change queue settings.</span>}
                      </div>)}
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
      {queues.length > 0 && (
        <div>
          <button type="button" className="text-[12px] text-[#525252] underline" aria-expanded={advGroup} onClick={() => setAdvGroup((x) => !x)}>{advGroup ? 'Hide advanced settings' : 'Advanced settings for this group'}</button>
          {advGroup && (
            <div className="mt-2 flex flex-wrap items-center gap-2 rounded-md bg-[#FAFAF7] p-3 text-[13px]" data-testid="advanced-group">
              <label className="flex flex-wrap items-center gap-2">Call the newest data out of date when it is more than
                <input type="number" min={1} max={60} disabled={!canWrite} key={r.data?.staleAfterDays} defaultValue={r.data?.staleAfterDays ?? 3} aria-label="Days before the newest data is out of date"
                  onBlur={(e) => { const x = Math.max(1, Math.min(60, Math.round(Number(e.target.value) || 3))); if (x !== (r.data?.staleAfterDays ?? 3)) void setStale(x); }} className={`w-16 ${field}`} />
                days old
              </label>
              <span className="text-[12px] text-[#6B6B6B]">If you import once a week, set this to 8 so a normal gap is not flagged. It becomes a serious caution at twice this (at least 7 days).</span>
              {!canWrite && <span className="text-[12px] text-[#6B6B6B]">You need permission to change group settings.</span>}
            </div>)}
        </div>)}
    </section>
  );
};
