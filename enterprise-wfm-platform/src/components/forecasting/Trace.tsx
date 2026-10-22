/**
 * Staffing traceability (live): how one interval's volume becomes an agent number, step by step,
 * using the WFM group's own targets and the Python engine's Erlang solver.
 */
import React, { useEffect, useState } from 'react';
import { X, Calculator } from 'lucide-react';
import { api, dec, pct } from '../../services/api';
import { Banner, Busy, Kpi, KpiRow, Table } from './ui';

export type TraceResult = {
  channel: string; method: string; volume: number; ahtSec: number; trafficErlangs: number; slaTarget: number; answerSec: number; occupancyCap: number; shrinkage: number;
  rawAgents: number; agents: number; onSchedule: number; serviceLevel: number; occupancy: number; asaSec: number; abandon: number; warn: boolean;
  steps: string[]; sensitivity: { changePct: number; volume: number; agents: number; onSchedule: number }[];
};

export function useTrace(groupId: string | undefined, input: { volume: number; ahtSec: number; channel: 'voice' | 'chat' } | null) {
  const [data, setData] = useState<TraceResult | null>(null);
  const [error, setError] = useState('');
  const key = JSON.stringify([groupId, input]);
  useEffect(() => {
    if (!groupId || !input) { setData(null); return; }
    let live = true;
    const t = setTimeout(() => {
      api<TraceResult>('/forecast/trace-staffing', { method: 'POST', body: { groupId, ...input } })
        .then((r) => { if (live) { setData(r); setError(''); } })
        .catch((e) => { if (live) { setData(null); setError(e.message); } });
    }, 250); // debounce typing in the builder preview
    return () => { live = false; clearTimeout(t); };
  }, [key]);
  return { data, error };
}

export const TracePanel: React.FC<{ data: TraceResult | null; error?: string }> = ({ data, error }) => {
  if (error) return <Banner kind="err">{error}</Banner>;
  if (!data) return <Busy text="Calculating…" />;
  return (
    <div className="space-y-4">
      <KpiRow>
        <Kpi label="Workload" value={dec(data.trafficErlangs, 1)} sub="Erlangs: agents busy all the time" />
        <Kpi label="Agents on the phones" value={data.agents} sub={data.rawAgents !== data.agents ? `${data.rawAgents} for service level, raised by the occupancy cap` : 'meets the service level'} />
        <Kpi label="Agents on the schedule" value={data.onSchedule} sub={`incl. ${pct(data.shrinkage)} shrinkage`} />
        <Kpi label="Service level reached" value={pct(data.serviceLevel, 1)} tone={data.serviceLevel >= data.slaTarget ? 'good' : 'bad'} sub={`target ${pct(data.slaTarget)} in ${data.answerSec}s · avg wait ${dec(data.asaSec, 0)}s`} />
        <Kpi label="Occupancy" value={pct(data.occupancy)} sub={`cap ${pct(data.occupancyCap)}`} />
      </KpiRow>
      <ol className="list-decimal pl-5 space-y-1.5 text-[13px] text-[#171717] leading-relaxed">{data.steps.map((s, i) => <li key={i}>{s}</li>)}</ol>
      {data.warn && <Banner kind="warn">Small team under real load: Erlang assumes many agents, so treat this number as a guide and sanity-check it.</Banner>}
      <div>
        <div className="text-[11px] font-semibold text-[#737373] uppercase tracking-wider mb-1.5">If volume is different</div>
        <Table head={['Volume change', 'Contacts / 15 min', 'Agents on phones', 'On schedule']} right={[1, 2, 3]}>
          {data.sensitivity.map((s) => (
            <tr key={s.changePct} className={s.changePct === 0 ? 'bg-[#EAF5EF]/40 font-medium' : ''}>
              <td className="p-3">{s.changePct > 0 ? '+' : ''}{s.changePct}%</td>
              <td className="p-3 text-right font-mono tabular-nums">{dec(s.volume, 1)}</td>
              <td className="p-3 text-right font-mono tabular-nums">{s.agents}</td>
              <td className="p-3 text-right font-mono tabular-nums">{s.onSchedule}</td>
            </tr>
          ))}
        </Table>
      </div>
    </div>
  );
};

export const TraceModal: React.FC<{ groupId: string; title: string; input: { volume: number; ahtSec: number; channel: 'voice' | 'chat' }; onClose: () => void }> = ({ groupId, title, input, onClose }) => {
  const { data, error } = useTrace(groupId, input);
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4" onClick={onClose} role="dialog" aria-modal="true">
      <div className="w-full max-w-3xl max-h-[90vh] overflow-y-auto bg-white rounded-lg shadow-2xl border border-[#E5E5E0]" onClick={(e) => e.stopPropagation()}>
        <div className="p-4 border-b border-[#E5E5E0] flex items-center justify-between bg-[#FAFAF8] sticky top-0">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded bg-[#2F7D5A]/10 text-[#2F7D5A] flex items-center justify-center"><Calculator className="w-4 h-4" /></div>
            <div>
              <h2 className="text-[16px] font-semibold text-[#171717]">Where does this number come from?</h2>
              <p className="text-[12px] text-[#737373]">{title}</p>
            </div>
          </div>
          <button onClick={onClose} className="p-1 rounded text-[#737373] hover:text-[#171717] hover:bg-[#E5E5E0]"><X className="w-5 h-5" /></button>
        </div>
        <div className="p-5 space-y-3">
          <TracePanel data={data} error={error} />
          <p className="text-[11px] text-[#737373]">Shown as a single {input.channel} queue with this interval’s volume and handle time. Groups with several channels pool their traffic, so their totals can differ slightly.</p>
        </div>
      </div>
    </div>
  );
};
