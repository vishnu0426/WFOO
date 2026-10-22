/**
 * Scheduling › Shift Bidding. Offer weekly patterns (a shift template starting at a set time on set days, with a capacity), let people rank
 * them in the app, close the round, then decide the result by seniority, lottery or the best overall outcome. Awarding builds a draft schedule
 * from the winning patterns; a pattern that would break a rule for someone is never given to them. Review the draft in Schedule Timeline and publish.
 */
import React, { useState } from 'react';
import { ChevronDown, ChevronRight, Plus, Trash2 } from 'lucide-react';
import { api, ShiftTemplate, when } from '../../services/api';
import { useForecast } from '../../services/forecastStore';
import { useApi } from '../forecasting/hooks';
import { Banner, Btn, Busy, Card, Empty, Field, Input, Pill, Select, Table } from '../forecasting/ui';

type Pattern = { id: string; name: string; days: string[]; startTime: string; endTime: string; paidHours: number; capacity: number; templateName: string; firstChoices: number; canHold: number; awarded: number };
type Round = {
  id: string; groupName: string; name: string; status: string; method: string; periodStart: string; weeks: number; fillUnranked: boolean; closesAt: string | null; awardedVersionId: string | null;
  eligible?: number; submitted: number; patternCount?: number; patterns?: Pattern[]; awards?: { employeeId: string; name: string; employeeNumber: string; patternName: string | null; rank: number | null }[];
};
type Preview = { method: string; summary: { people: number; assigned: number; unassigned: number; byRank: Record<string, number>; firstChoicePercent: number }; awards: { name: string; patternName: string | null; rank: number | null }[] };
const STATUS: Record<string, { label: string; tone: 'good' | 'warn' | 'bad' | 'info' | 'neutral' }> = {
  DRAFT: { label: 'Draft', tone: 'neutral' }, OPEN: { label: 'Open for bids', tone: 'info' }, CLOSED: { label: 'Closed', tone: 'warn' }, AWARDED: { label: 'Awarded', tone: 'good' }, CANCELLED: { label: 'Cancelled', tone: 'neutral' },
};
const METHOD: Record<string, string> = { SENIORITY: 'Seniority', LOTTERY: 'Lottery', BALANCED: 'Best overall outcome' };
const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const nextMonday = (plusDays: number) => { const d = new Date(); d.setDate(d.getDate() + plusDays); d.setDate(d.getDate() + ((8 - d.getDay()) % 7)); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

type Draft = { name: string; method: string; periodStart: string; weeks: number; closesAt: string; fillUnranked: boolean; patterns: { name: string; templateId: string; startTime: string; workDays: number[]; capacity: number }[] };

export const BidsPanel: React.FC = () => {
  const { group, can } = useForecast();
  const canEdit = can('schedule:generate');
  const [tick, setTick] = useState(0);
  const rounds = useApi<Round[]>('/scheduling/bids', [tick]);
  const templates = useApi<ShiftTemplate[]>('/scheduling/templates');
  const [draft, setDraft] = useState<Draft | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const detail = useApi<Round>(open ? `/scheduling/bids/${open}` : null, [tick]);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [previewMethod, setPreviewMethod] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);

  const act = async (fn: () => Promise<void>) => { setBusy(true); setError(''); setNotice(''); try { await fn(); setTick((t) => t + 1); } catch (e: any) { setError(e.message); } finally { setBusy(false); } };
  const blank = (): Draft => ({ name: '', method: 'SENIORITY', periodStart: nextMonday(14), weeks: 4, closesAt: '', fillUnranked: true, patterns: [{ name: '', templateId: templates.data?.[0]?.id ?? '', startTime: '08:00', workDays: [0, 1, 2, 3, 4], capacity: 5 }] });
  const create = () => draft && group && act(async () => {
    const r = await api<Round>('/scheduling/bids', { method: 'POST', body: { groupId: group.id, name: draft.name, method: draft.method, periodStart: draft.periodStart, weeks: draft.weeks, fillUnranked: draft.fillUnranked, closesAt: draft.closesAt ? new Date(draft.closesAt).toISOString() : null, patterns: draft.patterns } });
    setDraft(null); setOpen(r.id); setNotice('Round created as a draft. Check the patterns, then open it for bids.');
  });
  const post = (id: string, what: string, msg: string) => act(async () => { await api(`/scheduling/bids/${id}/${what}`, { method: 'POST', body: {} }); setNotice(msg); setPreview(null); });
  const showPreview = (id: string, method: string) => act(async () => { setPreview(await api<Preview>(`/scheduling/bids/${id}/preview${method ? `?method=${method}` : ''}`)); });
  const award = (id: string) => act(async () => {
    const r = await api<{ versionId: string; summary: Preview['summary'] }>(`/scheduling/bids/${id}/award`, { method: 'POST', body: previewMethod ? { method: previewMethod } : {} });
    setNotice(`Awarded. ${r.summary.assigned} people have a pattern (${r.summary.firstChoicePercent}% got their first choice). A draft schedule was built: open Schedule Timeline to review and publish it.`);
  });
  const setP = (i: number, patch: Partial<Draft['patterns'][number]>) => setDraft((d) => d && { ...d, patterns: d.patterns.map((p, j) => (j === i ? { ...p, ...patch } : p)) });
  const toggleDay = (i: number, day: number) => setDraft((d) => d && { ...d, patterns: d.patterns.map((p, j) => (j === i ? { ...p, workDays: p.workDays.includes(day) ? p.workDays.filter((x) => x !== day) : [...p.workDays, day].sort() } : p)) });
  const valid = !!draft && draft.name.trim().length >= 2 && draft.patterns.length > 0 && draft.patterns.every((p) => p.name.trim() && p.templateId && p.workDays.length > 0 && p.capacity >= 1);
  const mine = (rounds.data ?? []).filter((r) => !group || r.groupName === group.name);

  return (
    <div className="space-y-6">
      {error && <Banner kind="err" onClose={() => setError('')}>{error}</Banner>}
      {notice && <Banner kind="ok" onClose={() => setNotice('')}>{notice}</Banner>}

      <Card title="Shift bidding" sub="People rank the weekly patterns they want; the round decides who gets what. A pattern that would break a rule, an approved time off or someone's availability is never given to them."
        actions={canEdit && !draft && <Btn variant="primary" onClick={() => setDraft(blank())} disabled={!group || !(templates.data?.length)}><Plus className="w-3.5 h-3.5" />New round</Btn>}>
        {!(templates.data?.length) && templates.data && <Banner kind="info">Create shift templates first (Shift Templates). A pattern is a template starting at a set time on set days.</Banner>}
        {draft && (
          <div className="border border-[#E5E5E0] rounded-lg p-4 space-y-4 bg-[#FAFAF8]">
            <div className="grid grid-cols-1 md:grid-cols-3 xl:grid-cols-6 gap-4">
              <div className="xl:col-span-2"><Field label="Name"><Input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder="Winter shift bid" /></Field></div>
              <Field label="Decided by"><Select value={draft.method} onChange={(e) => setDraft({ ...draft, method: e.target.value })}>{Object.entries(METHOD).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</Select></Field>
              <Field label="First Monday" hint="The schedule starts here"><Input type="date" value={draft.periodStart} onChange={(e) => setDraft({ ...draft, periodStart: e.target.value })} /></Field>
              <Field label="Weeks"><Input type="number" min={1} max={26} value={draft.weeks} onChange={(e) => setDraft({ ...draft, weeks: Math.max(1, Number(e.target.value)) })} /></Field>
              <Field label="Bidding closes" hint="Empty: you close it yourself"><Input type="datetime-local" value={draft.closesAt} onChange={(e) => setDraft({ ...draft, closesAt: e.target.value })} /></Field>
            </div>
            <div className="space-y-2">
              <div className="text-[12px] font-semibold">Patterns on offer</div>
              {draft.patterns.map((p, i) => (
                <div key={i} className="grid grid-cols-2 md:grid-cols-12 gap-3 items-end p-3 bg-white border border-[#E5E5E0] rounded-lg">
                  <div className="col-span-2 md:col-span-3"><Field label="Name"><Input value={p.name} onChange={(e) => setP(i, { name: e.target.value })} placeholder="Early, Monday to Friday" /></Field></div>
                  <div className="col-span-2 md:col-span-3"><Field label="Shift"><Select value={p.templateId} onChange={(e) => setP(i, { templateId: e.target.value })}>{(templates.data ?? []).map((t) => <option key={t.id} value={t.id}>{t.name} ({t.durationHours}h)</option>)}</Select></Field></div>
                  <div className="md:col-span-2"><Field label="Starts"><Input type="time" step={900} value={p.startTime} onChange={(e) => setP(i, { startTime: e.target.value })} /></Field></div>
                  <div className="md:col-span-1"><Field label="Places"><Input type="number" min={1} value={p.capacity} onChange={(e) => setP(i, { capacity: Math.max(1, Number(e.target.value)) })} /></Field></div>
                  <div className="col-span-2 md:col-span-3 flex items-center gap-2">
                    <div className="flex gap-1">{DAYS.map((d, k) => <button key={d} type="button" onClick={() => toggleDay(i, k)} className={`w-8 h-8 rounded text-[11px] font-semibold border ${p.workDays.includes(k) ? 'bg-[#171717] text-white border-[#171717]' : 'bg-white text-[#737373] border-[#E5E5E0]'}`}>{d[0]}</button>)}</div>
                    <button aria-label="Remove pattern" className="text-[#737373] hover:text-[#C84A4A]" onClick={() => setDraft({ ...draft, patterns: draft.patterns.filter((_, j) => j !== i) })}><Trash2 className="w-4 h-4" /></button>
                  </div>
                </div>
              ))}
              <Btn onClick={() => setDraft({ ...draft, patterns: [...draft.patterns, { name: '', templateId: templates.data?.[0]?.id ?? '', startTime: '08:00', workDays: [0, 1, 2, 3, 4], capacity: 5 }] })}><Plus className="w-3.5 h-3.5" />Add pattern</Btn>
            </div>
            <label className="flex items-center gap-2 text-[12px] text-[#525252]"><input type="checkbox" checked={draft.fillUnranked} onChange={(e) => setDraft({ ...draft, fillUnranked: e.target.checked })} />People who rank too few patterns get what is left over</label>
            <div className="flex gap-2"><Btn variant="primary" onClick={create} disabled={busy || !valid}>Create round</Btn><Btn onClick={() => setDraft(null)}>Cancel</Btn></div>
          </div>
        )}
        {rounds.loading && !rounds.data && <Busy text="Loading…" />}
        {rounds.data && mine.length === 0 && !draft && <Empty title="No bid rounds yet">Create a round to let people choose their weekly pattern.</Empty>}
        <div className="space-y-2">
          {mine.map((r) => {
            const st = STATUS[r.status] ?? { label: r.status, tone: 'neutral' as const };
            const d = open === r.id && detail.data?.id === r.id ? detail.data : null;
            return (
              <div key={r.id} className="border border-[#E5E5E0] rounded-lg">
                <button className="w-full p-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-left" onClick={() => { setOpen(open === r.id ? null : r.id); setPreview(null); }}>
                  {open === r.id ? <ChevronDown className="w-4 h-4 text-[#737373]" /> : <ChevronRight className="w-4 h-4 text-[#737373]" />}
                  <Pill tone={st.tone}>{st.label}</Pill>
                  <span className="font-semibold text-[13px]">{r.name}</span>
                  <span className="text-[12px] text-[#525252]">{r.weeks} wk from {r.periodStart} · {METHOD[r.method]}</span>
                  <span className="text-[12px] text-[#737373]">{r.submitted} ranked{r.closesAt ? ` · closes ${when(r.closesAt)}` : ''}</span>
                </button>
                {open === r.id && (
                  <div className="p-3 border-t border-[#E5E5E0] space-y-4">
                    {!d ? <Busy text="Loading…" /> : (
                      <>
                        <div className="text-[12px] text-[#525252]">{d.submitted} of {d.eligible} eligible people have ranked their choices.</div>
                        <Table head={['Pattern', 'Days', 'Time', 'Paid', 'Places', 'First choice of', 'Can hold it', 'Awarded']} right={[3, 4, 5, 6, 7]}>
                          {(d.patterns ?? []).map((p) => <tr key={p.id}><td className="p-2.5 font-medium">{p.name}<div className="text-[11px] text-[#737373]">{p.templateName}</div></td><td className="p-2.5">{p.days.join(' ')}</td><td className="p-2.5 font-mono">{p.startTime}–{p.endTime}</td><td className="p-2.5 text-right font-mono">{p.paidHours}h</td><td className="p-2.5 text-right font-mono">{p.capacity}</td><td className="p-2.5 text-right font-mono">{p.firstChoices}</td><td className="p-2.5 text-right font-mono">{p.canHold}</td><td className="p-2.5 text-right font-mono">{d.status === 'AWARDED' ? p.awarded : '–'}</td></tr>)}
                        </Table>
                        {canEdit && (
                          <div className="flex flex-wrap items-center gap-2">
                            {d.status === 'DRAFT' && <Btn variant="primary" onClick={() => post(d.id, 'open', 'Bidding is open. Everyone eligible has been notified.')} disabled={busy}>Open for bids</Btn>}
                            {d.status === 'OPEN' && <Btn variant="primary" onClick={() => confirm('Close the round? Nobody can change their ranking afterwards.') && post(d.id, 'close', 'Closed. Preview the result, then award it.')} disabled={busy}>Close bidding</Btn>}
                            {d.status === 'CLOSED' && (
                              <>
                                <Select className="!w-auto" value={previewMethod} onChange={(e) => { setPreviewMethod(e.target.value); setPreview(null); }} aria-label="Method"><option value="">Use the round’s method ({METHOD[d.method]})</option>{Object.entries(METHOD).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</Select>
                                <Btn onClick={() => showPreview(d.id, previewMethod)} disabled={busy}>Preview the result</Btn>
                                <Btn variant="primary" onClick={() => confirm('Award the round? This builds a draft schedule from the winning patterns.') && award(d.id)} disabled={busy}>Award and build a draft schedule</Btn>
                              </>
                            )}
                            {['DRAFT', 'OPEN', 'CLOSED'].includes(d.status) && <Btn onClick={() => confirm('Cancel this round?') && post(d.id, 'cancel', 'Round cancelled.')} disabled={busy}>Cancel round</Btn>}
                          </div>
                        )}
                        {preview && (
                          <div className="border border-[#E5E5E0] rounded-lg p-3 bg-[#FAFAF8] space-y-2">
                            <div className="text-[13px] font-semibold">If awarded now ({METHOD[preview.method]})</div>
                            <div className="text-[12px] text-[#525252]">{preview.summary.assigned} of {preview.summary.people} people get a pattern · {preview.summary.firstChoicePercent}% get their first choice · {preview.summary.unassigned} without one · {Object.entries(preview.summary.byRank).map(([k, v]) => `${k === 'unranked' ? 'left over' : `choice ${k}`}: ${v}`).join(', ')}</div>
                          </div>
                        )}
                        {d.status === 'AWARDED' && (d.awards?.length ?? 0) > 0 && (
                          <>
                            <Banner kind="ok">Awarded. The draft schedule is in Schedule Timeline; review it and publish when it is right.</Banner>
                            <Table head={['Person', 'Pattern', 'Choice']} right={[2]}>
                              {d.awards!.map((a) => <tr key={a.employeeId}><td className="p-2.5">{a.name} <span className="text-[11px] text-[#737373]">#{a.employeeNumber}</span></td><td className="p-2.5">{a.patternName ?? <span className="text-[#C84A4A]">None could be given</span>}</td><td className="p-2.5 text-right font-mono">{a.rank ?? (a.patternName ? 'left over' : '–')}</td></tr>)}
                            </Table>
                          </>
                        )}
                      </>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </Card>
    </div>
  );
};
