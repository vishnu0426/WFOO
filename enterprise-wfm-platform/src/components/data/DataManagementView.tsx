/**
 * Staged Data Ingestion & Quality Hub (Rule 7: a file never changes live data directly).
 *   1 Upload · 2 Validate + quality audit · 3 Diff against live data · 4 Atomic commit (and later, exact rollback).
 * Interval history (volume, handle time, actuals) is live; people and schedule files arrive with the workforce module.
 */
import React, { useRef, useState } from 'react';
import { ArrowRight, Check, CheckCircle2, Download, FileText, RotateCcw, UploadCloud } from 'lucide-react';
import { api, ApiError, download, dayYear, int, Queue, when } from '../../services/api';
import { useForecast } from '../../services/forecastStore';
import { useApi } from '../forecasting/hooks';
import { Banner, Btn, Busy, Card, Empty, Field, Pill, Select, Table } from '../forecasting/ui';

type Job = {
  id: string; dataType: string; fileName: string; fileSizeKb: number; status: string; totalRecords: number; validRecords: number; warningRecords: number; errorRecords: number;
  createdRecords: number; updatedRecords: number; skippedRecords: number; createdAt: string; createdBy: string; completedAt: string | null; canRollback: boolean; isRolledBack: boolean;
  summary?: { columns?: string[]; diff: { new: number; updated: number; unchanged: number }; perQueue: { queue: string; firstDay: string; lastDay: string; days: number; intervals: number; contacts: number }[]; quality: { score: number; issues: { severity: string; entity: string; issue: string; impact: string; fix: string }[] } };
};
type JobDetail = Job & { errors: { line: number; message: string }[]; warnings: { line: number; message: string; queue: string; day: string; slot: number; volume: number }[]; sample: { line: number; queue: string; day: string; slot: number; volume: number; ahtSec: number; action: string; status: string; prevVolume: number | null }[] };
type Issue = { id: string; severity: 'ERROR' | 'WARNING' | 'INFO'; entityName: string; issue: string; impactDescription: string; suggestedRemediation: string; createdAt: string };

const STEPS = ['Upload CSV', 'Validate & audit', 'Diff inspection', 'Atomic commit'];
const STATUS_TONE: Record<string, 'good' | 'warn' | 'bad' | 'info' | 'neutral'> = { COMPLETED: 'good', COMPLETED_WITH_WARNINGS: 'warn', READY: 'info', FAILED: 'bad', ROLLED_BACK: 'neutral', IMPORTING: 'info' };
const slot = (s: number) => `${String(Math.floor(s / 4)).padStart(2, '0')}:${String((s % 4) * 15).padStart(2, '0')}`;

export const DataManagementView: React.FC<{ activeSubSection?: string }> = ({ activeSubSection = 'staged-imports' }) => {
  return (
    <div className="flex-1 flex flex-col h-[calc(100vh-3.5rem)] overflow-y-auto bg-[#FFFFFF] p-6 space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4 border-b border-[#E5E5E0] pb-4">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-[22px] font-semibold text-[#171717]">{activeSubSection === 'data-quality' ? 'Data Quality' : activeSubSection === 'scheduled-syncs' ? 'Scheduled Ingestion' : 'Staged Data Ingestion'}</h1>
            <Pill tone="good">Files never change live data directly</Pill>
          </div>
          <p className="text-[13px] text-[#737373] mt-0.5 max-w-3xl">Every file is checked and compared with what you already have before anything is saved, and a committed import can be rolled back exactly.</p>
        </div>
        <Btn onClick={() => download('/data/import-template', 'interval-history-template.csv').catch(() => {})}><Download className="w-3.5 h-3.5" />Download CSV template</Btn>
      </div>
      {activeSubSection === 'data-quality' ? <QualityPanel /> : activeSubSection === 'scheduled-syncs' ? <LiveFeedPanel /> : <StagedPanel />}
    </div>
  );
};

// ---------------------------------------------------------------- staged imports

const StagedPanel: React.FC = () => {
  const { can, reloadGroups, reload, setNotice } = useForecast();
  const [step, setStep] = useState(1);
  const [job, setJob] = useState<JobDetail | null>(null);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [tick, setTick] = useState(0);
  const jobs = useApi<Job[]>('/data/imports', [tick]);
  const queues = useApi<Queue[]>('/config/queues');
  const file = useRef<HTMLInputElement>(null);
  const [opts, setOpts] = useState({ dataType: 'HISTORICAL_VOLUME', queueId: '', intervalMinutes: 15, dateFormat: 'iso' });
  const canImport = can('data:import');

  const open = async (id: string, to = 2) => { setJob(await api<JobDetail>(`/data/imports/${id}`)); setStep(to); };
  const upload = async (f: File) => {
    setBusy(`Reading and checking ${f.name} (${(f.size / 1e6).toFixed(1)} MB). A large file can take a minute…`); setError('');
    try {
      const csv = await f.text();
      const j = await api<Job>('/data/imports', { method: 'POST', body: { dataType: opts.dataType, fileName: f.name, csv, queueId: opts.queueId || undefined, intervalMinutes: opts.intervalMinutes, dateFormat: opts.dateFormat }, timeoutMs: 5 * 60_000 });
      await open(j.id); setTick((t) => t + 1);
    } catch (e: any) { setError(e.message); } finally { setBusy(''); if (file.current) file.current.value = ''; }
  };
  const commit = async () => {
    if (!job) return;
    setBusy('Saving to live history…'); setError('');
    try { await api(`/data/imports/${job.id}/commit`, { method: 'POST', timeoutMs: 5 * 60_000 }); await open(job.id, 4); setTick((t) => t + 1); await reloadGroups(); await reload(); }
    catch (e: any) { setError(e.message); } finally { setBusy(''); }
  };
  const discard = async () => {
    if (!job) return;
    try { await api(`/data/imports/${job.id}`, { method: 'DELETE' }); setJob(null); setStep(1); setTick((t) => t + 1); } catch (e: any) { setError(e.message); }
  };
  const rollback = async (j: Job) => {
    const reason = prompt(`Why is “${j.fileName}” being rolled back?`);
    if (!reason || reason.trim().length < 3) return;
    try { await api(`/data/imports/${j.id}/rollback`, { method: 'POST', body: { reason: reason.trim() } }); setNotice({ kind: 'ok', text: `Rolled back ${j.fileName}. The history is exactly as it was before that import.` }); setTick((t) => t + 1); }
    catch (e: any) { setError(e instanceof ApiError ? e.message : 'Rollback failed'); }
  };

  const noQueues = queues.data?.length === 0;
  return (
    <div className="space-y-6">
      <Card>
        <div className="flex items-center justify-between border-b border-[#E5E5E0] pb-4 overflow-x-auto gap-3">
          {STEPS.map((s, i) => (
            <React.Fragment key={s}>
              <div className="flex items-center gap-3 shrink-0">
                <div className={`w-7 h-7 rounded-full flex items-center justify-center text-[12px] font-bold ${step > i + 1 || (step === 4 && i === 3) ? (i === 3 ? 'bg-[#2F7D5A] text-white' : 'bg-[#171717] text-white') : step === i + 1 ? 'bg-[#171717] text-white' : 'bg-[#F5F5F2] text-[#737373]'}`}>{i + 1}</div>
                <span className={`text-[13px] font-semibold ${step === i + 1 ? 'text-[#171717]' : 'text-[#737373]'}`}>{s}</span>
              </div>
              {i < STEPS.length - 1 && <ArrowRight className="w-4 h-4 text-[#A3A3A3] shrink-0" />}
            </React.Fragment>
          ))}
        </div>
        {error && <Banner kind="err" onClose={() => setError('')}>{error}</Banner>}
        {busy && <Busy text={busy} />}

        {step === 1 && (
          <div className="space-y-4">
            {noQueues && <Banner kind="warn">There are no queues yet. Create a WFM group and its queues in Configuration first; the file’s queue names must match them.</Banner>}
            <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
              <Field label="What is in the file?">
                <Select value={opts.dataType} onChange={(e) => setOpts({ ...opts, dataType: e.target.value })}>
                  <option value="HISTORICAL_VOLUME">Interval history (contacts + handle time)</option>
                  <option value="ACTUALS">Actuals for recent days</option>
                </Select>
              </Field>
              <Field label="Interval length"><Select value={opts.intervalMinutes} onChange={(e) => setOpts({ ...opts, intervalMinutes: Number(e.target.value) })}><option value={15}>15 minutes</option><option value={30}>30 minutes</option><option value={60}>60 minutes</option></Select></Field>
              <Field label="Date format"><Select value={opts.dateFormat} onChange={(e) => setOpts({ ...opts, dateFormat: e.target.value })}><option value="iso">2026-03-31</option><option value="mdy">03/31/2026</option><option value="dmy">31/03/2026</option></Select></Field>
              <Field label="Queue" hint="Only if the file has no queue column"><Select value={opts.queueId} onChange={(e) => setOpts({ ...opts, queueId: e.target.value })}><option value="">Use the queue column</option>{queues.data?.map((q) => <option key={q.id} value={q.id}>{q.name}</option>)}</Select></Field>
            </div>
            <div className="border-2 border-dashed border-[#D6D6D0] rounded-lg p-10 flex flex-col items-center justify-center bg-[#FAFAF8] text-center space-y-3"
              onDragOver={(e) => e.preventDefault()} onDrop={(e) => { e.preventDefault(); const f = e.dataTransfer.files[0]; if (f && canImport && !busy) upload(f); }}>
              <div className="w-12 h-12 rounded-full bg-white border border-[#E5E5E0] flex items-center justify-center"><UploadCloud className="w-6 h-6 text-[#525252]" /></div>
              <div>
                <div className="text-[14px] font-semibold text-[#171717]">Drop a CSV here</div>
                <div className="text-[12px] text-[#737373] mt-0.5">Columns: queue, date, interval (e.g. 09:15), volume, aht. Up to 10 MB. Use the template above if unsure.</div>
              </div>
              <input ref={file} type="file" accept=".csv,.tsv,.txt,text/csv" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) upload(f); }} />
              {canImport ? <Btn variant="primary" disabled={!!busy} onClick={() => file.current?.click()}>Choose file</Btn> : <Pill>You do not have permission to import data</Pill>}
            </div>
          </div>
        )}

        {job && (step === 2 || step === 3) && (
          <div className="space-y-4">
            <div className="p-3 bg-[#FAFAF8] rounded border border-[#E5E5E0] flex flex-wrap items-center justify-between gap-2 text-[12px]">
              <div><span className="text-[#737373]">File: </span><span className="font-semibold text-[#171717]">{job.fileName}</span> <span className="text-[#737373]">· {job.totalRecords.toLocaleString()} rows read</span></div>
              <div className="flex items-center gap-3">
                <span className="text-[#2F7D5A] font-semibold">✓ {int(job.validRecords)} valid</span>
                <span className="text-[#B7791F] font-semibold">⚠ {int(job.warningRecords)} to review</span>
                <span className={`font-semibold ${job.errorRecords ? 'text-[#C84A4A]' : 'text-[#737373]'}`}>{int(job.errorRecords)} rejected</span>
              </div>
            </div>

            {job.status === 'FAILED' && <Banner kind="err">Nothing in this file could be used. Check the column names and date format, then upload again.</Banner>}
            {job.errors.length > 0 && (
              <Card title={`Rejected rows (${job.errorRecords.toLocaleString()})`} sub="These rows are skipped. The rest of the file can still be imported.">
                <Table head={['Line', 'Problem']}>{job.errors.slice(0, 25).map((e, i) => <tr key={i}><td className="p-3 font-mono text-[#737373]">{e.line}</td><td className="p-3">{e.message}</td></tr>)}</Table>
              </Card>
            )}

            {step === 2 && job.summary && (
              <Card title="Quality audit" sub={`Score ${job.summary.quality.score} / 100`}>
                {job.summary.quality.issues.length === 0 ? <p className="text-[13px] text-[#2F7D5A] flex items-center gap-1.5"><CheckCircle2 className="w-4 h-4" />No problems found.</p> : (
                  <div className="space-y-2">{job.summary.quality.issues.map((q, i) => (
                    <div key={i} className="border border-[#E5E5E0] rounded p-3 text-[12px]">
                      <div className="flex items-center gap-2"><Pill tone={q.severity === 'ERROR' ? 'bad' : q.severity === 'WARNING' ? 'warn' : 'info'}>{q.severity}</Pill><span className="font-semibold">{q.entity}</span></div>
                      <div className="mt-1 text-[#171717]">{q.issue}</div><div className="text-[#737373]">{q.impact} <span className="text-[#525252]">Fix: {q.fix}</span></div>
                    </div>
                  ))}</div>
                )}
              </Card>
            )}

            {step === 3 && job.summary && (
              <>
                <div className="grid grid-cols-3 gap-4">
                  <DiffBox label="New" value={job.summary.diff.new} tone="good" sub="rows added to history" />
                  <DiffBox label="Changed" value={job.summary.diff.updated} tone="warn" sub="existing rows with different values" />
                  <DiffBox label="Unchanged" value={job.summary.diff.unchanged} sub="already in history, skipped" />
                </div>
                <Table head={['Queue', 'From', 'To', 'Days', 'Intervals', 'Contacts']} right={[3, 4, 5]}>
                  {job.summary.perQueue.map((p) => <tr key={p.queue}><td className="p-3 font-medium">{p.queue}</td><td className="p-3">{dayYear(p.firstDay)}</td><td className="p-3">{dayYear(p.lastDay)}</td><td className="p-3 text-right font-mono">{p.days}</td><td className="p-3 text-right font-mono">{int(p.intervals)}</td><td className="p-3 text-right font-mono">{int(p.contacts)}</td></tr>)}
                </Table>
                <Card title="Sample of what will change" sub="Changed rows first.">
                  <Table head={['Line', 'Queue', 'Day', 'Time', 'Contacts', 'Was', 'Handle time', 'Action']} right={[4, 5, 6]}>
                    {job.sample.map((r) => (
                      <tr key={r.line}><td className="p-3 font-mono text-[#737373]">{r.line}</td><td className="p-3">{r.queue}</td><td className="p-3">{r.day}</td><td className="p-3 font-mono">{slot(r.slot)}</td>
                        <td className="p-3 text-right font-mono">{r.volume}</td><td className="p-3 text-right font-mono text-[#737373]">{r.prevVolume ?? '–'}</td><td className="p-3 text-right font-mono">{r.ahtSec}s</td>
                        <td className="p-3"><Pill tone={r.action === 'NEW' ? 'good' : r.action === 'UPDATE' ? 'warn' : 'neutral'}>{r.action === 'UPDATE' ? 'CHANGE' : r.action}</Pill></td></tr>
                    ))}
                  </Table>
                </Card>
                {job.warnings.length > 0 && <Banner kind="warn">{job.warningRecords.toLocaleString()} rows look unusual (for example {job.warnings[0].message.toLowerCase()} on {job.warnings[0].queue}, {job.warnings[0].day}). They are still imported.</Banner>}
              </>
            )}

            <div className="flex items-center justify-between pt-3 border-t border-[#E5E5E0]">
              <div className="flex gap-2">
                <Btn onClick={() => { setJob(null); setStep(1); }}>Back to upload</Btn>
                {job.status === 'READY' && canImport && <Btn onClick={discard}>Discard this file</Btn>}
              </div>
              {job.status === 'READY' && (step === 2
                ? <Btn variant="primary" onClick={() => setStep(3)}>Continue to diff <ArrowRight className="w-3.5 h-3.5" /></Btn>
                : canImport && <Btn variant="success" disabled={!!busy} onClick={commit}>Authorize & commit to history</Btn>)}
            </div>
          </div>
        )}

        {job && step === 4 && (
          <div className="p-8 text-center space-y-3 bg-[#EAF5EF] border border-[#2F7D5A]/20 rounded-lg">
            <div className="w-12 h-12 rounded-full bg-[#2F7D5A] text-white flex items-center justify-center mx-auto"><Check className="w-6 h-6" /></div>
            <h3 className="text-[16px] font-bold text-[#2F7D5A]">Committed to live history</h3>
            <p className="text-[12px] text-[#2F7D5A]/90 max-w-md mx-auto">{int(job.createdRecords)} rows added, {int(job.updatedRecords)} changed, {int(job.skippedRecords)} skipped. It is recorded in the audit trail and can be rolled back below.</p>
            <Btn variant="primary" className="mx-auto" onClick={() => { setJob(null); setStep(1); }}>Import another file</Btn>
          </div>
        )}
      </Card>

      <Card title="Recent imports" sub="Newest first. Roll back only works while nothing later has overwritten the same intervals.">
        {jobs.data?.length === 0 ? <Empty title="No imports yet">Upload a file above to bring in your interval history.</Empty> : (
          <Table head={['File', 'Type', 'Rows', 'Result', 'When', 'By', 'Status', '']} right={[2]}>
            {jobs.data?.map((j) => (
              <tr key={j.id}>
                <td className="p-3 font-semibold"><span className="inline-flex items-center gap-2"><FileText className="w-3.5 h-3.5 text-[#737373]" />{j.fileName}</span></td>
                <td className="p-3 text-[12px]">{j.dataType === 'HISTORICAL_VOLUME' ? 'Interval history' : j.dataType.replace(/_/g, ' ').toLowerCase()}</td>
                <td className="p-3 text-right font-mono">{int(j.validRecords + j.warningRecords)}</td>
                <td className="p-3 text-[12px] text-[#525252]">{j.completedAt ? `${int(j.createdRecords)} new · ${int(j.updatedRecords)} changed` : j.errorRecords ? `${int(j.errorRecords)} rejected` : ''}</td>
                <td className="p-3 text-[12px] text-[#737373] whitespace-nowrap">{when(j.createdAt)}</td><td className="p-3 text-[12px]">{j.createdBy}</td>
                <td className="p-3"><Pill tone={STATUS_TONE[j.status] ?? 'neutral'}>{j.status.replace(/_/g, ' ').toLowerCase()}</Pill></td>
                <td className="p-3 text-right whitespace-nowrap">
                  {j.status === 'READY' && <button className="text-[12px] font-semibold underline" onClick={() => open(j.id)}>Review</button>}
                  {j.canRollback && !j.isRolledBack && can('data:rollback') && <button className="text-[12px] font-semibold text-[#C84A4A] inline-flex items-center gap-1" onClick={() => rollback(j)}><RotateCcw className="w-3 h-3" />Roll back</button>}
                </td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
    </div>
  );
};

const DiffBox: React.FC<{ label: string; value: number; sub: string; tone?: 'good' | 'warn' }> = ({ label, value, sub, tone }) => (
  <div className="p-4 bg-[#FAFAF8] rounded-lg border border-[#E5E5E0]">
    <div className="text-[11px] font-semibold text-[#737373] uppercase tracking-wider">{label}</div>
    <div className={`text-[24px] font-bold tabular-nums font-mono mt-1 ${tone === 'good' ? 'text-[#2F7D5A]' : tone === 'warn' ? 'text-[#B7791F]' : 'text-[#171717]'}`}>{int(value)}</div>
    <div className="text-[11px] text-[#737373]">{sub}</div>
  </div>
);

// ---------------------------------------------------------------- data quality

const QualityPanel: React.FC = () => {
  const q = useApi<Issue[]>('/data/quality');
  const cov = useApi<{ queueId: string; name: string; firstDay: string | null; lastDay: string | null; days: number; intervals: number; missingIntervals: number }[]>('/data/coverage');
  return (
    <div className="space-y-6">
      <Card title="History coverage" sub="What is in live interval history for each queue.">
        {cov.data?.length === 0 ? <Empty title="No queues yet" /> : (
          <Table head={['Queue', 'From', 'To', 'Days', 'Intervals', 'Missing inside range']} right={[3, 4, 5]}>
            {cov.data?.map((c) => <tr key={c.queueId}><td className="p-3 font-medium">{c.name}</td><td className="p-3">{c.firstDay ? dayYear(c.firstDay) : '–'}</td><td className="p-3">{c.lastDay ? dayYear(c.lastDay) : '–'}</td><td className="p-3 text-right font-mono">{c.days}</td><td className="p-3 text-right font-mono">{int(c.intervals)}</td><td className="p-3 text-right font-mono">{c.missingIntervals ? int(c.missingIntervals) : '–'}</td></tr>)}
          </Table>
        )}
      </Card>
      <Card title="Issues found" sub="Live checks on history, plus what was flagged when files were staged.">
        {q.error && <Banner kind="err">{q.error}</Banner>}
        {q.data?.length === 0 ? <p className="text-[13px] text-[#2F7D5A] flex items-center gap-1.5"><CheckCircle2 className="w-4 h-4" />No data-quality issues.</p> : (
          <div className="space-y-2">{q.data?.map((i) => (
            <div key={i.id} className="border border-[#E5E5E0] rounded p-3 text-[12px]">
              <div className="flex items-center gap-2"><Pill tone={i.severity === 'ERROR' ? 'bad' : i.severity === 'WARNING' ? 'warn' : 'info'}>{i.severity}</Pill><span className="font-semibold">{i.entityName}</span></div>
              <div className="mt-1">{i.issue}</div><div className="text-[#737373]">{i.impactDescription} <span className="text-[#525252]">Fix: {i.suggestedRemediation}</span></div>
            </div>
          ))}</div>
        )}
      </Card>
    </div>
  );
};

// ---------------------------------------------------------------- live feed

const LiveFeedPanel: React.FC = () => {
  const { session } = useForecast();
  const example = JSON.stringify({ rows: [{ queue: 'Support Voice', day: '2026-03-31', time: '09:15', volume: 42, ahtSec: 310 }] }, null, 2);
  return (
    <div className="space-y-6">
      <Card title="Live interval feed" sub="Your ACD or telephony platform can push finished 15-minute intervals as they close. Rows are saved straight to history (small, repeatable updates), and the accuracy checks pick them up.">
        <div className="space-y-3 text-[13px]">
          <div><div className="text-[11px] font-semibold text-[#737373] uppercase tracking-wider mb-1">HTTPS</div><code className="block bg-[#FAFAF8] border border-[#E5E5E0] rounded p-2 font-mono text-[12px]">POST /api/v1/data/ingest</code></div>
          <div><div className="text-[11px] font-semibold text-[#737373] uppercase tracking-wider mb-1">NATS subject</div><code className="block bg-[#FAFAF8] border border-[#E5E5E0] rounded p-2 font-mono text-[12px] break-all">wfm.{session.tenant.id}.ingest.interval</code></div>
          <div><div className="text-[11px] font-semibold text-[#737373] uppercase tracking-wider mb-1">Body</div><pre className="bg-[#FAFAF8] border border-[#E5E5E0] rounded p-2 font-mono text-[12px] overflow-x-auto">{example}</pre></div>
          <p className="text-[12px] text-[#737373]">Up to 5,000 rows per message. A row for an interval that already exists replaces it. Each queue may be named by its name or code.</p>
        </div>
      </Card>
    </div>
  );
};
