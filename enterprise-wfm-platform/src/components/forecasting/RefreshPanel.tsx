/**
 * Auto-refresh for one forecast (a group's short-term or long-term forecast): the schedule, a Run now button, and what the runs found. On the schedule the platform checks the data is
 * fresh, measures how the live forecast did, builds a new DRAFT, compares it with the live one and tells the people who approve forecasts. It only ever makes a draft.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { api, STATUS_LABEL, when } from '../../services/api';
import { useApi } from './hooks';
import { Waiting } from '../common/loading';

const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
type Verdict = 'GOOD' | 'CHECK' | 'POOR' | 'NO_DATA';
interface RunReport {
  freshness?: { ok: boolean; text: string }; live?: { seq: number } | null; draft?: { id: string; seq: number; name: string } | null; archivedDrafts?: number; notified?: number;
  accuracy?: { status: Verdict; latestWeek: { weekStart: string; days: number; wapeDaily: number; bias: number } | null; queues: { name: string; wapeDaily: number; bias: number; status: Verdict }[] } | null;
  compare?: { baseVersion: string; days: number; deltaPct: number | null } | null;
  text?: { freshness: string; accuracy: string; compare: string };
}
export interface Run { id: string; trigger: 'SCHEDULE' | 'MANUAL'; status: 'RUNNING' | 'CREATED' | 'SKIPPED' | 'FAILED'; reason: string; startedBy: string; startedAt: string; finishedAt: string | null; versionId: string | null; report: RunReport }
interface Settings {
  kind: 'SHORT' | 'LONG'; saved: boolean; enabled: boolean; frequency: 'DAILY' | 'WEEKLY'; dayOfWeek: number; hour: number; horizonWeeks: number | null; horizonDays: number | null; staleAfterDays: number; archiveOldDrafts: boolean;
  timezone: string; description: string; nextRun: { text: string } | null; live: { id: string; seq: number; name: string; fromDay: string; toDay: string } | null; lastRun: Run | null;
}

type Form = Pick<Settings, 'enabled' | 'frequency' | 'dayOfWeek' | 'hour' | 'horizonWeeks' | 'horizonDays' | 'staleAfterDays' | 'archiveOldDrafts'>;
const same = (a: Form, b: Form) => a.enabled === b.enabled && a.frequency === b.frequency && a.dayOfWeek === b.dayOfWeek && a.hour === b.hour && a.horizonWeeks === b.horizonWeeks && a.horizonDays === b.horizonDays && a.staleAfterDays === b.staleAfterDays && a.archiveOldDrafts === b.archiveOldDrafts;
const TONE = { GOOD: 'bg-success-bg text-success', CHECK: 'bg-warning-bg text-warning', POOR: 'bg-critical-bg text-critical', NO_DATA: 'bg-surface text-muted-foreground' } as const;
const WORD = { GOOD: 'Good', CHECK: 'Worth watching', POOR: 'Poor', NO_DATA: 'Not enough data' } as const;
const RUN_TONE = { CREATED: 'bg-success-bg text-success', SKIPPED: 'bg-warning-bg text-warning', FAILED: 'bg-critical-bg text-critical', RUNNING: 'bg-info-bg text-info' } as const;
const RUN_WORD = { CREATED: 'Draft made', SKIPPED: 'Skipped', FAILED: 'Failed', RUNNING: 'Running…' } as const;
const pct = (v: number) => `${(v * 100).toFixed(1)}%`;
const lean = (b: number) => (Math.abs(b) < 0.02 ? 'level' : b > 0 ? `${pct(b)} high` : `${pct(Math.abs(b))} low`);

function RunCard({ run, onOpenDraft, onCompare }: { run: Run; onOpenDraft: (versionId: string) => void; onCompare: (versionId: string) => void }) {
  const r = run.report, a = r.accuracy;
  return (
    <div className="space-y-3 rounded-lg border p-4" data-testid="run-card">
      <div className="flex flex-wrap items-center gap-2 text-[13px]">
        <span className={`rounded px-2 py-0.5 text-[11px] font-semibold ${RUN_TONE[run.status]}`}>{RUN_WORD[run.status]}</span>
        <span className="text-muted-foreground">{when(run.startedAt)} · {run.trigger === 'SCHEDULE' ? 'on schedule' : `run by ${run.startedBy}`}</span>
      </div>
      {run.status === 'RUNNING' && <p className="text-[13px] text-muted-foreground" role="status">Working: this takes a few seconds to a minute while the models are tested on the history.</p>}
      {(run.status === 'SKIPPED' || run.status === 'FAILED') && <p className="text-[13px]">{run.reason} <span className="text-muted-foreground">No new draft was made; the live forecast is unchanged.</span></p>}
      {run.status === 'CREATED' && (
        <>
          <div className="space-y-1 text-[13px]">
            <div className="flex flex-wrap items-center gap-2"><span className="font-semibold">How the live forecast did</span>{a && a.latestWeek && <span className={`rounded px-2 py-0.5 text-[11px] font-semibold ${TONE[a.status]}`}>{WORD[a.status]}</span>}</div>
            <p>{r.text?.accuracy}</p>
          </div>
          {a && a.queues.length > 0 && (
            <table className="w-full text-[12px]" aria-label="Queues by how far the live forecast missed">
              <thead><tr className="text-left text-subtle-foreground"><th className="py-1 font-medium">Queue</th><th className="py-1 text-right font-medium">Missed by (a day)</th><th className="py-1 text-right font-medium">Ran</th></tr></thead>
              <tbody>{a.queues.map((q) => <tr key={q.name} className="border-t"><td className="py-1">{q.name}</td><td className="py-1 text-right num">{pct(q.wapeDaily)}</td><td className="py-1 text-right text-muted-foreground">{lean(q.bias)}</td></tr>)}</tbody>
            </table>)}
          <div className="space-y-1 text-[13px]"><div className="font-semibold">The new draft</div><p>{r.draft ? r.draft.name : ''}</p><p>{r.text?.compare}</p></div>
          {(r.archivedDrafts ?? 0) > 0 && <p className="text-[12px] text-muted-foreground">An earlier automatic draft nobody had worked on was archived.</p>}
          <p className="text-[12px] text-muted-foreground">{r.notified ? `${r.notified} ${r.notified === 1 ? 'person who approves' : 'people who approve'} forecasts told.` : 'Nobody could be told: no one has permission to approve forecasts.'}</p>
          {run.versionId && (
            <div className="flex flex-wrap gap-2">
              <button type="button" className="h-8 rounded-md bg-primary px-3 text-[13px] font-medium text-primary-foreground" onClick={() => onOpenDraft(run.versionId!)}>Open the draft</button>
              {r.live && <button type="button" className="h-8 rounded-md border bg-background px-3 text-[13px] font-medium" onClick={() => onCompare(run.versionId!)}>Compare with live…</button>}
            </div>)}
        </>)}
    </div>
  );
}

export const RefreshPanel: React.FC<{ groupId: string; groupName: string; kind: 'SHORT' | 'LONG'; canEdit: boolean; onClose: () => void; onOpenDraft: (versionId: string) => void; onCompare: (versionId: string) => void; onChanged: () => void }> = ({ groupId, groupName, kind, canEdit, onClose, onOpenDraft, onCompare, onChanged }) => {
  const res = useApi<{ items: Settings[] }>(`/forecast/refresh?groupId=${groupId}`, []);
  const server = res.data?.items.find((i) => i.kind === kind) ?? null;
  const [base, setBase] = useState<Form | null>(null);          // what is saved: Save is on only when the form differs from it
  const [f, setF] = useState<Form | null>(null);
  const [runs, setRuns] = useState<Run[]>([]);
  const [pick, setPick] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState('');
  const closeRef = useRef<HTMLButtonElement>(null);
  const live = !!server;
  useEffect(() => { closeRef.current?.focus(); }, []);
  useEffect(() => { const k = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); }; window.addEventListener('keydown', k); return () => window.removeEventListener('keydown', k); }, [onClose]);
  useEffect(() => { if (server && !f) { const v: Form = { enabled: server.enabled, frequency: server.frequency, dayOfWeek: server.dayOfWeek, hour: server.hour, horizonWeeks: server.horizonWeeks, horizonDays: server.horizonDays, staleAfterDays: server.staleAfterDays, archiveOldDrafts: server.archiveOldDrafts }; setF(v); setBase(v); } }, [server, f]);

  const loadRuns = useCallback(async () => { const r = await api<Run[]>(`/forecast/refresh/${groupId}/${kind}/runs?limit=10`); setRuns(r); return r; }, [groupId, kind]);
  useEffect(() => { void loadRuns().catch(() => undefined); }, [loadRuns]);
  // while a run is going, look again every two seconds (at most three minutes)
  const running = runs[0]?.status === 'RUNNING';
  useEffect(() => {
    if (!running) return undefined;
    let n = 0;
    const t = setInterval(async () => { n++; const r = await loadRuns().catch(() => null); if ((r && r[0]?.status !== 'RUNNING') || n > 90) { clearInterval(t); res.reload(); onChanged(); } }, 2000);
    return () => clearInterval(t);
  }, [running]);                                         // eslint-disable-line react-hooks/exhaustive-deps

  if (!res.data && !res.error) return <div role="dialog" aria-modal="true" aria-label="Auto-refresh" className="fixed inset-0 z-40 flex justify-end bg-black/20"><aside className="h-full w-full max-w-xl bg-background p-5"><Waiting what="the schedule" shape="panel" reload={res.reload} /></aside></div>;
  const set = (patch: Partial<NonNullable<typeof f>>) => { setF((c) => (c ? { ...c, ...patch } : c)); setSaved(''); };
  const dirty = !!f && !!base && !same(f, base);
  const save = async () => {
    if (!f) return; setBusy(true); setError('');
    try { await api(`/forecast/refresh/${groupId}/${kind}`, { method: 'PUT', body: f }); setBase(f); res.reload(); setSaved('Saved.'); onChanged(); } catch (e: any) { setError(e.message); } finally { setBusy(false); }
  };
  const runNow = async () => {
    setBusy(true); setError('');
    try { await api(`/forecast/refresh/${groupId}/${kind}/run`, { method: 'POST' }); setPick(null); await loadRuns(); } catch (e: any) { setError(e.message); } finally { setBusy(false); }
  };
  const shown = runs.find((r) => r.id === pick) ?? runs[0] ?? null;
  const typeWord = kind === 'SHORT' ? 'Short-term' : 'Long-term';
  const input = 'h-9 rounded-md border bg-background px-2 text-[13px] disabled:opacity-60';
  return (
    <div role="dialog" aria-modal="true" aria-label={`Auto-refresh for ${groupName}, ${typeWord.toLowerCase()}`} className="fixed inset-0 z-40 flex justify-end bg-black/20" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <aside className="h-full w-full max-w-xl space-y-4 overflow-y-auto border-l bg-background p-5 shadow-xl select-text">
        <div className="flex items-start justify-between gap-3">
          <div><h2 className="text-[16px] font-semibold">Auto-refresh</h2><p className="text-[12px] text-muted-foreground">{groupName} · {typeWord} forecast{server?.live ? ` · live is v${server.live.seq}` : ' · nothing live yet'}</p></div>
          <button ref={closeRef} onClick={onClose} aria-label="Close" className="rounded p-1 hover:bg-surface"><X className="size-4" /></button>
        </div>
        <p className="text-[13px] text-muted-foreground">On a schedule the platform checks the data is fresh, measures how the live forecast did, builds a new <b>draft</b> from the latest history, compares it with the live one, and tells the people who approve forecasts. It only makes a draft: nothing changes in the schedule until someone reviews and publishes it.</p>
        {res.error && !res.data && <p className="text-[13px] text-critical" role="alert">{res.error}</p>}

        {live && f && (
          <fieldset disabled={!canEdit} className="space-y-3 rounded-lg border p-4">
            <legend className="px-1 text-[12px] font-semibold uppercase tracking-wide text-subtle-foreground">Schedule</legend>
            <label className="flex items-center gap-2 text-[13px] font-medium"><input type="checkbox" checked={f.enabled} onChange={(e) => set({ enabled: e.target.checked })} />Create a new draft automatically</label>
            <div className="flex flex-wrap items-end gap-3 text-[13px]">
              <label className="space-y-1"><span className="block text-[12px] text-subtle-foreground">How often</span><select className={input} aria-label="How often" value={f.frequency} onChange={(e) => set({ frequency: e.target.value as 'DAILY' | 'WEEKLY' })}><option value="WEEKLY">Every week</option><option value="DAILY">Every day</option></select></label>
              {f.frequency === 'WEEKLY' && <label className="space-y-1"><span className="block text-[12px] text-subtle-foreground">On</span><select className={input} aria-label="Day of the week" value={f.dayOfWeek} onChange={(e) => set({ dayOfWeek: Number(e.target.value) })}>{DAYS.map((d, i) => <option key={d} value={i}>{d}</option>)}</select></label>}
              <label className="space-y-1"><span className="block text-[12px] text-subtle-foreground">From</span><select className={input} aria-label="Time of day" value={f.hour} onChange={(e) => set({ hour: Number(e.target.value) })}>{Array.from({ length: 24 }, (_, h) => <option key={h} value={h}>{String(h).padStart(2, '0')}:00</option>)}</select></label>
              <span className="pb-2 text-[12px] text-muted-foreground">group time ({server!.timezone})</span>
            </div>
            <label className="flex flex-wrap items-center gap-2 text-[13px]">
              <span>Make it</span>
              {kind === 'SHORT'
                ? <input type="number" min={1} max={18} className={`${input} w-20`} aria-label="Weeks to forecast" placeholder={server!.live ? String(Math.ceil((Date.parse(server!.live.toDay) - Date.parse(server!.live.fromDay)) / 864e5 / 7 + 0.14)) : '6'} value={f.horizonWeeks ?? ''} onChange={(e) => set({ horizonWeeks: e.target.value === '' ? null : Math.max(1, Math.min(18, Math.round(+e.target.value))) })} />
                : <input type="number" min={30} max={730} className={`${input} w-24`} aria-label="Days to forecast" placeholder="365" value={f.horizonDays ?? ''} onChange={(e) => set({ horizonDays: e.target.value === '' ? null : Math.max(30, Math.min(730, Math.round(+e.target.value))) })} />}
              <span>{kind === 'SHORT' ? 'weeks long (blank: as long as the live forecast)' : 'days long (blank: as long as the live forecast)'}</span>
            </label>
            <label className="flex flex-wrap items-center gap-2 text-[13px]"><span>If the newest data is more than</span><input type="number" min={1} max={60} className={`${input} w-20`} aria-label="Days before data counts as stale" value={f.staleAfterDays} onChange={(e) => set({ staleAfterDays: Math.max(1, Math.min(60, Math.round(+e.target.value) || 1)) })} /><span>days old, skip it and tell me</span></label>
            <label className="flex items-center gap-2 text-[13px]"><input type="checkbox" checked={f.archiveOldDrafts} onChange={(e) => set({ archiveOldDrafts: e.target.checked })} />Archive an earlier automatic draft nobody has worked on</label>
            <div className="flex flex-wrap items-center gap-3 pt-1">
              {canEdit && <button type="button" disabled={busy || !dirty} onClick={() => void save()} className="h-9 rounded-md bg-primary px-4 text-[13px] font-medium text-primary-foreground disabled:opacity-50">Save schedule</button>}
              {saved && <span className="text-[13px] text-success" role="status">{saved}</span>}
              <span className="text-[12px] text-muted-foreground">{server!.enabled ? `${server!.description[0].toUpperCase()}${server!.description.slice(1)}. Next: ${server!.nextRun?.text ?? '–'}.` : 'Off: nothing runs by itself.'}</span>
            </div>
          </fieldset>)}
        {!canEdit && <p className="text-[12px] text-muted-foreground">You can see the schedule and what the runs found. Someone who can create forecasts changes it.</p>}
        {error && <p className="text-[13px] text-critical" role="alert">{error}</p>}

        <div className="flex flex-wrap items-center gap-3">
          {canEdit && <button type="button" disabled={busy || running} onClick={() => void runNow()} className="h-9 rounded-md border bg-background px-4 text-[13px] font-medium hover:bg-surface disabled:opacity-50">{running ? 'Running…' : 'Run now'}</button>}
          <span className="text-[12px] text-muted-foreground">Runs the same steps once, now, and adds the result below.</span>
        </div>

        <section aria-label="What the runs found" className="space-y-3">
          <h3 className="text-[13px] font-semibold">{shown && shown === runs[0] ? 'Latest run' : 'Run'}</h3>
          {!shown ? <p className="text-[13px] text-muted-foreground">Nothing has run yet. Switch the schedule on, or press Run now to see what a run finds.</p> : <RunCard run={shown} onOpenDraft={onOpenDraft} onCompare={onCompare} />}
          {runs.length > 1 && (
            <div className="space-y-1">
              <h4 className="text-[12px] font-semibold text-subtle-foreground">Earlier runs</h4>
              <ul className="divide-y rounded-lg border text-[13px]">
                {runs.map((r) => (
                  <li key={r.id}><button type="button" onClick={() => setPick(r.id)} aria-current={shown?.id === r.id ? 'true' : undefined} className={`flex w-full items-center gap-3 px-3 py-2 text-left hover:bg-surface ${shown?.id === r.id ? 'bg-surface' : ''}`}>
                    <span className={`rounded px-2 py-0.5 text-[11px] font-semibold ${RUN_TONE[r.status]}`}>{RUN_WORD[r.status]}</span>
                    <span className="flex-1 truncate">{r.status === 'CREATED' ? (r.report.accuracy?.latestWeek ? `Live missed by ${pct(r.report.accuracy.latestWeek.wapeDaily)} a day` : 'Draft made') : r.reason || 'Running'}</span>
                    <span className="text-[12px] text-muted-foreground">{when(r.startedAt)}</span>
                  </button></li>))}
              </ul>
            </div>)}
        </section>
        <p className="text-[11px] text-subtle-foreground">Status shown is {STATUS_LABEL.DRAFT.toLowerCase()} until a person publishes the new forecast.</p>
      </aside>
    </div>
  );
};
