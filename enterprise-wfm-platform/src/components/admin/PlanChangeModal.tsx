/**
 * Licence & Subscription › Change plan. The customer only chooses a plan: its limits and modules are shown as they are (nothing to type), a plan they
 * do not fit today is greyed out with the reason, and a Super Admin decides. They may add a note.
 */
import { Waiting, LoadFailed } from '../common/loading';
import React, { useState } from 'react';
import { api } from '../../services/api';
import { useApi } from '../forecasting/hooks';
import { Banner, Btn, Busy } from '../forecasting/ui';

export type PlanInfo = {
  code: string; name: string; description: string; isCustom: boolean; current: boolean; seatsMin: number; seatsMax: number;
  maxUsers: number; maxSites: number; maxWorkspaces: number; modules: string[]; problems: string[];
};
type PlansReply = { current: string; usage: { seats: number; employees: number; users: number; sites: number; workspaces: number }; pending: { id: string; planCode: string; createdAt: string } | null; plans: PlanInfo[] };

const MODULE_NAMES: Record<string, string> = {
  FORECASTING: 'Forecasting', SCHEDULING: 'Scheduling', INTRADAY: 'Intraday', ADHERENCE: 'Adherence', TIME_OFF: 'Time off',
  SHIFT_BIDDING: 'Shift bidding', EMPLOYEE_SELF_SERVICE: 'Employee self-service', REPORTING: 'Reporting', AI_COPILOT: 'AI assistant',
};

export const PlanChangeModal: React.FC<{ onClose: () => void; onSubmitted: (message: string) => void }> = ({ onClose, onSubmitted }) => {
  const data = useApi<PlansReply>('/license/plans');
  const [picked, setPicked] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const reply = data.data;
  const chosen = reply?.plans.find((p) => p.code === picked) ?? null;
  const current = reply?.plans.find((p) => p.current) ?? null;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!chosen) return;
    setBusy(true); setError('');
    try {
      await api('/license/plan-change', { method: 'POST', body: { planCode: chosen.code, note } });
      onSubmitted(`Your request to move to ${chosen.name} was sent. You will see the decision here.`);
    } catch (err: any) { setError(err.message); } finally { setBusy(false); }
  };

  const Row: React.FC<{ label: string; was?: string | number; now: string | number }> = ({ label, was, now }) => (
    <div className="flex items-baseline justify-between gap-3 py-1.5 border-b border-[#F0F0EC] last:border-0 text-[13px]">
      <span className="text-[#737373]">{label}</span>
      <span className="text-[#171717] tabular-nums">{was !== undefined && was !== now ? <><strong>{now}</strong> <span className="text-[#A3A3A3] text-[12px]">(was {was})</span></> : now}</span>
    </div>
  );

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center p-4 z-50" role="dialog" aria-modal="true" aria-label="Change plan">
      <div className="bg-white border border-[#E5E5E0] rounded-lg shadow-2xl w-full max-w-3xl max-h-[90vh] overflow-y-auto">
        <div className="px-5 py-3.5 border-b border-[#E5E5E0] flex items-center justify-between sticky top-0 bg-white">
          <h3 className="font-semibold text-[15px] text-[#171717]">Change plan</h3>
          <button onClick={onClose} className="text-[13px] text-[#525252] hover:underline">Close</button>
        </div>

        {data.loading && !reply ? <div className="p-6"><Waiting what="plans" shape="cards" reload={data.reload} /></div> : !reply ? (
          <div className="p-6"><LoadFailed what="the plans" error={data.error || 'Try again in a moment.'} reload={data.reload} /></div>
        ) : reply.pending ? (
          <div className="p-6 space-y-3">
            <Banner kind="info">A request to move to {reply.plans.find((p) => p.code === reply.pending!.planCode)?.name ?? reply.pending.planCode} was sent on {new Date(reply.pending.createdAt).toLocaleDateString()} and is waiting for approval. You can send another once it has been decided.</Banner>
            <Btn onClick={onClose}>Close</Btn>
          </div>
        ) : (
          <form onSubmit={submit} className="p-5 space-y-4">
            <p className="text-[13px] text-[#525252]">Choose the plan you want. Its limits and modules are fixed, so there is nothing to fill in. Your licence dates stay as they are.</p>
            {error && <Banner kind="err">{error}</Banner>}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3" role="radiogroup" aria-label="Plans">
              {reply.plans.map((p) => {
                const disabled = p.current || p.problems.length > 0;
                const on = picked === p.code;
                return (
                  <button
                    key={p.code} type="button" role="radio" aria-checked={on} disabled={disabled} onClick={() => setPicked(p.code)}
                    className={`text-left border rounded-lg p-3 transition-colors ${on ? 'border-[#171717] ring-1 ring-[#171717] bg-white' : disabled ? 'border-[#E5E5E0] bg-[#FAFAF8] text-[#A3A3A3] cursor-not-allowed' : 'border-[#E5E5E0] hover:border-[#A3A3A3] bg-white'}`}
                  >
                    <div className="flex items-center justify-between">
                      <span className={`font-semibold text-[14px] ${disabled ? 'text-[#737373]' : 'text-[#171717]'}`}>{p.name}</span>
                      {p.current && <span className="text-[11px] font-semibold px-2 py-0.5 rounded border bg-[#EAF5EF] text-[#2A7553] border-[#2F7D5A]/20">Your plan</span>}
                    </div>
                    <p className="text-[12px] mt-0.5">{p.description}</p>
                    {!p.current && p.problems.length > 0 && <p className="text-[11px] text-[#8F6200] mt-1.5">{p.problems[0]}</p>}
                  </button>
                );
              })}
            </div>

            {chosen && (
              <div className="border border-[#E5E5E0] rounded-lg bg-[#FAFAF8] p-4">
                <div className="text-[13px] font-semibold text-[#171717] mb-1">{chosen.name}{current ? ` compared with ${current.name}` : ''}</div>
                <Row label="Employee limit" was={current ? reply.usage.seats.toLocaleString() : undefined} now={chosen.seatsMax.toLocaleString()} />
                <Row label="User accounts" was={current?.maxUsers} now={chosen.maxUsers} />
                <Row label="Sites" was={current?.maxSites} now={chosen.maxSites} />
                <Row label="Workspaces" was={current?.maxWorkspaces} now={chosen.maxWorkspaces} />
                <div className="pt-2 text-[12px] text-[#525252]">
                  <span className="text-[#737373]">Modules: </span>
                  {chosen.modules.map((m) => {
                    const had = current?.modules.includes(m);
                    return <span key={m} className={`mr-2 ${current && !had ? 'font-semibold text-[#2A7553]' : ''}`}>{MODULE_NAMES[m] ?? m}{current && !had ? ' (new)' : ''}</span>;
                  })}
                  {current && current.modules.filter((m) => !chosen.modules.includes(m)).length > 0 && (
                    <div className="mt-1 text-[#8F6200]">You would lose: {current.modules.filter((m) => !chosen.modules.includes(m)).map((m) => MODULE_NAMES[m] ?? m).join(', ')}.</div>
                  )}
                </div>
              </div>
            )}

            <div>
              <label htmlFor="pc-note" className="block text-[12px] font-semibold text-[#171717] mb-1">Note for your account manager (optional)</label>
              <textarea id="pc-note" rows={2} maxLength={1000} value={note} onChange={(e) => setNote(e.target.value)} className="w-full p-2 border border-[#E5E5E0] rounded text-[13px] bg-white focus:outline-none focus:border-[#171717]" placeholder="For example, when you need the change" />
            </div>
            <div className="flex items-center gap-2">
              <Btn variant="primary" type="submit" disabled={!chosen || busy}>{busy ? 'Sending...' : chosen ? `Request ${chosen.name}` : 'Choose a plan'}</Btn>
              <Btn type="button" onClick={onClose}>Cancel</Btn>
            </div>
          </form>
        )}
      </div>
    </div>
  );
};
