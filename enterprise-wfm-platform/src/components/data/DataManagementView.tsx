/**
 * Staged Data Ingestion & Quality Hub (Rule 7: a file never changes live data directly).
 *   1 Upload · 2 Validate + quality audit · 3 Diff against live data · 4 Atomic commit (and later, exact rollback).
 * Interval history (volume, handle time, actuals) is live; people and schedule files arrive with the workforce module.
 */
import React, { useRef, useState } from 'react';
import { ArrowRight, Check, CheckCircle2, Download, FileText, Radio, RotateCcw, UploadCloud } from 'lucide-react';
import { api, ApiError, download, dayYear, int, Queue, when } from '../../services/api';
import { useForecast } from '../../services/forecastStore';
import { useApi } from '../forecasting/hooks';
import { Banner, Btn, Busy, Card, Empty, Field, Pill, Select, Table } from '../forecasting/ui';
import { ago, FEED_LABEL, FEED_TONE, SourceCard, SourcesManager, type FeedConnector, type FeedState } from './HistorySources';

type Job = {
  id: string; dataType: string; fileName: string; fileSizeKb: number; status: string; totalRecords: number; validRecords: number; warningRecords: number; errorRecords: number;
  createdRecords: number; updatedRecords: number; skippedRecords: number; createdAt: string; createdBy: string; completedAt: string | null; canRollback: boolean; isRolledBack: boolean;
  summary?: { columns?: string[]; diff: { new: number; updated: number; unchanged: number }; perQueue: { queue: string; firstDay: string; lastDay: string; days: number; intervals: number; contacts: number }[]; quality: { score: number; issues: { severity: string; entity: string; issue: string; impact: string; fix: string }[] } };
};
type JobDetail = Job & { errors: { line: number; message: string }[]; warnings: { line: number; message: string; queue: string; day: string; slot: number; volume: number }[]; sample: { line: number; queue: string; day: string; slot: number; volume: number; ahtSec: number; action: string; status: string; prevVolume: number | null }[] };
type Issue = { id: string; severity: 'ERROR' | 'WARNING' | 'INFO'; entityName: string; issue: string; impactDescription: string; suggestedRemediation: string; createdAt: string };

type Detected<T> = { value: T | null; confidence: 'high' | 'medium' | 'ask'; reason: string };
type Detection = {
  sampleRows: number; dataType: Detected<string>; intervalMinutes: Detected<number>; dateFormat: Detected<string>; queueId: Detected<string>;
  problems: string[]; preview: { queue: string; day: string; time: string; volume: number; aht: number | null }[];
};

const STEPS =['Upload CSV', 'Validate & audit', 'Diff inspection', 'Atomic commit'];
const STATUS_TONE: Record<string, 'good' | 'warn' | 'bad' | 'info' | 'neutral'> = { COMPLETED: 'good', COMPLETED_WITH_WARNINGS: 'warn', READY: 'info', FAILED: 'bad', ROLLED_BACK: 'neutral', IMPORTING: 'info' };
const slot = (s: number) => `${String(Math.floor(s / 4)).padStart(2, '0')}:${String((s % 4) * 15).padStart(2, '0')}`;

export const DataManagementView: React.FC<{ activeSubSection?: string }> = ({ activeSubSection = 'staged-imports' }) => {
  const staged = activeSubSection !== 'data-quality' && activeSubSection !== 'scheduled-syncs';
  const [title, sub] = activeSubSection === 'data-quality'
    ? ['Data Quality', 'Gaps, stale days and unusual numbers in the history your forecasts are built from, with what each one affects and how to fix it.']
    : activeSubSection === 'scheduled-syncs'
      ? ['Data Feeds', 'The sources that keep your history up to date automatically, and whether each one is still sending.']
      : ['Staged Data Ingestion', 'Every file is checked and compared with what you already have before anything is saved, and a committed import can be rolled back exactly.'];
  return (
    <div className="flex-1 flex flex-col h-[calc(100vh-3.5rem)] overflow-y-auto bg-[#FFFFFF] p-6 space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4 border-b border-[#E5E5E0] pb-4">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-[22px] font-semibold text-[#171717]">{title}</h1>
            {staged && <Pill tone="good">Files never change live data directly</Pill>}
          </div>
          <p className="text-[13px] text-[#6B6B6B] mt-0.5 max-w-3xl">{sub}</p>
        </div>
        {staged && <Btn onClick={() => download('/data/import-template', 'interval-history-template.csv').catch(() => {})}><Download className="w-3.5 h-3.5" />Download CSV template</Btn>}
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
  const [opts, setOpts] = useState<{ dataType: string; queueId: string; intervalMinutes: number | ''; dateFormat: string }>({ dataType: 'HISTORICAL_VOLUME', queueId: '', intervalMinutes: 15, dateFormat: 'iso' });
  const [picked, setPicked] = useState<{ file: File; det: Detection | null } | null>(null);
  const canImport = can('data:import');

  const open = async (id: string, to = 2) => { setJob(await api<JobDetail>(`/data/imports/${id}`)); setStep(to); };
  /** Reads the start of the file, lets the server work out its settings, and pre-fills the dropdowns. Nothing is uploaded yet. */
  const pick = async (f: File) => {
    setBusy(`Looking at ${f.name}…`); setError('');
    try {
      let sample = await f.slice(0, 256 * 1024).text();
      if (f.size > 256 * 1024) sample = sample.slice(0, sample.lastIndexOf('\n') + 1) || sample;   // drop the cut-off last line
      const det = await api<Detection>('/data/imports/detect', { method: 'POST', body: { fileName: f.name, sample } });
      setOpts({ dataType: det.dataType.value ?? 'HISTORICAL_VOLUME', intervalMinutes: det.intervalMinutes.value ?? '', dateFormat: det.dateFormat.value ?? '', queueId: det.queueId.value ?? '' });
      setPicked({ file: f, det });
    } catch (e: any) { setError(e.message); setPicked({ file: f, det: null }); }   // detection is a convenience: fall back to choosing by hand
    finally { setBusy(''); if (file.current) file.current.value = ''; }
  };
  const upload = async (f: File) => {
    setBusy(`Reading and checking ${f.name} (${(f.size / 1e6).toFixed(1)} MB). A large file can take a minute…`); setError('');
    try {
      const csv = await f.text();
      const j = await api<Job>('/data/imports', { method: 'POST', body: { dataType: opts.dataType, fileName: f.name, csv, queueId: opts.queueId || undefined, intervalMinutes: opts.intervalMinutes || 15, dateFormat: opts.dateFormat || 'iso' }, timeoutMs: 5 * 60_000 });
      setPicked(null); await open(j.id); setTick((t) => t + 1);
    } catch (e: any) { setError(e.message); } finally { setBusy(''); if (file.current) file.current.value = ''; }
  };
  const det = picked?.det ?? null;
  const needsQueue = !!det && det.queueId.value === null && !opts.queueId;
  const missing = !!picked && (opts.intervalMinutes === '' || opts.dateFormat === '' || needsQueue);
  /** Shows what we found in the file under a dropdown, and warns if the user's choice disagrees with a confident finding. */
  const note = <T,>(d: Detected<T> | undefined, current: T | '') => {
    if (!d || (d.confidence === 'ask' && current !== '')) return null;   // the user has now made the choice we asked for
    const clash = d.confidence === 'high' && d.value !== null && current !== '' && current !== d.value;
    const tone = clash ? 'text-[#8F6200]' : d.confidence === 'high' ? 'text-[#2A7553]' : d.confidence === 'medium' ? 'text-[#8F6200]' : 'text-[#B42318]';
    return <div className={`text-[12px] mt-1 ${tone}`}>{clash ? `The file looks different: ${d.reason}` : `${d.confidence === 'high' ? 'Detected' : d.confidence === 'medium' ? 'Best guess, please confirm' : 'Please choose'}: ${d.reason}`}</div>;
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
                <div className={`w-7 h-7 rounded-full flex items-center justify-center text-[12px] font-bold ${step > i + 1 || (step === 4 && i === 3) ? (i === 3 ? 'bg-[#2F7D5A] text-white' : 'bg-[#171717] text-white') : step === i + 1 ? 'bg-[#171717] text-white' : 'bg-[#F5F5F2] text-[#6B6B6B]'}`}>{i + 1}</div>
                <span className={`text-[13px] font-semibold ${step === i + 1 ? 'text-[#171717]' : 'text-[#6B6B6B]'}`}>{s}</span>
              </div>
              {i < STEPS.length - 1 && <ArrowRight className="w-4 h-4 text-[#6B6B6B] shrink-0" />}
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
              <Field label="Interval length"><Select value={opts.intervalMinutes} onChange={(e) => setOpts({ ...opts, intervalMinutes: Number(e.target.value) })}>{opts.intervalMinutes === '' && <option value="">Choose…</option>}<option value={15}>15 minutes</option><option value={30}>30 minutes</option><option value={60}>60 minutes</option></Select>{note(det?.intervalMinutes, opts.intervalMinutes)}</Field>
              <Field label="Date format"><Select value={opts.dateFormat} onChange={(e) => setOpts({ ...opts, dateFormat: e.target.value })}>{opts.dateFormat === '' && <option value="">Choose…</option>}<option value="iso">2026-03-31</option><option value="mdy">03/31/2026</option><option value="dmy">31/03/2026</option></Select>{note(det?.dateFormat, opts.dateFormat)}</Field>
              <Field label="Queue" hint={det ? undefined : 'Only if the file has no queue column'}><Select value={opts.queueId} onChange={(e) => setOpts({ ...opts, queueId: e.target.value })}><option value="">{needsQueue ? 'Choose a queue…' : 'Use the queue column'}</option>{queues.data?.map((q) => <option key={q.id} value={q.id}>{q.name}</option>)}</Select>{note(det?.queueId, opts.queueId)}</Field>
            </div>
            {picked && (
              <div className="rounded border border-[#E5E5E0] bg-[#FAFAF8] p-3 space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="text-[13px]"><span className="font-semibold text-[#171717]">{picked.file.name}</span> <span className="text-[#6B6B6B]">· {(picked.file.size / 1e6).toFixed(2)} MB</span></div>
                  <div className="flex items-center gap-2">
                    <Btn onClick={() => setPicked(null)}>Choose another file</Btn>
                    <Btn variant="primary" disabled={!!busy || missing} onClick={() => upload(picked.file)}>Check this file</Btn>
                  </div>
                </div>
                {det?.problems.map((p) => <Banner key={p} kind="warn">{p}</Banner>)}
                {det && det.preview.length > 0 && (
                  <div>
                    <div className="text-[12px] text-[#6B6B6B] mb-1">First rows as we will read them. If a date or time looks wrong, change the setting above.</div>
                    <table className="w-full text-[12px] border border-[#E5E5E0] bg-white">
                      <thead><tr className="text-left text-[#6B6B6B]"><th className="p-1.5">Queue</th><th className="p-1.5">Date</th><th className="p-1.5">Interval</th><th className="p-1.5 text-right">Volume</th><th className="p-1.5 text-right">Handle time (s)</th></tr></thead>
                      <tbody>{det.preview.map((r, i) => <tr key={i} className="border-t border-[#E5E5E0]"><td className="p-1.5">{r.queue || '–'}</td><td className="p-1.5 font-mono">{r.day}</td><td className="p-1.5 font-mono">{r.time}</td><td className="p-1.5 text-right font-mono">{r.volume}</td><td className="p-1.5 text-right font-mono">{r.aht ?? '–'}</td></tr>)}</tbody>
                    </table>
                  </div>
                )}
                {missing && <div className="text-[12px] text-[#B42318]">Choose the highlighted settings before checking the file.</div>}
              </div>
            )}
            <div className="border-2 border-dashed border-[#D6D6D0] rounded-lg p-10 flex flex-col items-center justify-center bg-[#FAFAF8] text-center space-y-3"
              onDragOver={(e) => e.preventDefault()} onDrop={(e) => { e.preventDefault(); const f = e.dataTransfer.files[0]; if (f && canImport && !busy) pick(f); }}>
              <div className="w-12 h-12 rounded-full bg-white border border-[#E5E5E0] flex items-center justify-center"><UploadCloud className="w-6 h-6 text-[#525252]" /></div>
              <div>
                <div className="text-[14px] font-semibold text-[#171717]">Drop a CSV here</div>
                <div className="text-[12px] text-[#6B6B6B] mt-0.5">Columns: queue, date, interval (e.g. 09:15), volume, aht. Up to 10 MB. Use the template above if unsure.</div>
              </div>
              <input ref={file} type="file" accept=".csv,.tsv,.txt,text/csv" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) pick(f); }} />
              {canImport ? <Btn variant="primary" disabled={!!busy} onClick={() => file.current?.click()}>Choose file</Btn> : <Pill>You do not have permission to import data</Pill>}
            </div>
          </div>
        )}

        {job && (step === 2 || step === 3) && (
          <div className="space-y-4">
            <div className="p-3 bg-[#FAFAF8] rounded border border-[#E5E5E0] flex flex-wrap items-center justify-between gap-2 text-[12px]">
              <div><span className="text-[#6B6B6B]">File: </span><span className="font-semibold text-[#171717]">{job.fileName}</span> <span className="text-[#6B6B6B]">· {job.totalRecords.toLocaleString()} rows read</span></div>
              <div className="flex items-center gap-3">
                <span className="text-[#2A7553] font-semibold">✓ {int(job.validRecords)} valid</span>
                <span className="text-[#8F6200] font-semibold">⚠ {int(job.warningRecords)} to review</span>
                <span className={`font-semibold ${job.errorRecords ? 'text-[#BC3F3F]' : 'text-[#6B6B6B]'}`}>{int(job.errorRecords)} rejected</span>
              </div>
            </div>

            {job.status === 'FAILED' && <Banner kind="err">Nothing in this file could be used. Check the column names and date format, then upload again.</Banner>}
            {job.errors.length > 0 && (
              <Card title={`Rejected rows (${job.errorRecords.toLocaleString()})`} sub="These rows are skipped. The rest of the file can still be imported.">
                <Table head={['Line', 'Problem']}>{job.errors.slice(0, 25).map((e, i) => <tr key={i}><td className="p-3 font-mono text-[#6B6B6B]">{e.line}</td><td className="p-3">{e.message}</td></tr>)}</Table>
              </Card>
            )}

            {step === 2 && job.summary && (
              <Card title="Quality audit" sub={`Score ${job.summary.quality.score} / 100`}>
                {job.summary.quality.issues.length === 0 ? <p className="text-[13px] text-[#2A7553] flex items-center gap-1.5"><CheckCircle2 className="w-4 h-4" />No problems found.</p> : (
                  <div className="space-y-2">{job.summary.quality.issues.map((q, i) => (
                    <div key={i} className="border border-[#E5E5E0] rounded p-3 text-[12px]">
                      <div className="flex items-center gap-2"><Pill tone={q.severity === 'ERROR' ? 'bad' : q.severity === 'WARNING' ? 'warn' : 'info'}>{q.severity}</Pill><span className="font-semibold">{q.entity}</span></div>
                      <div className="mt-1 text-[#171717]">{q.issue}</div><div className="text-[#6B6B6B]">{q.impact} <span className="text-[#525252]">Fix: {q.fix}</span></div>
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
                      <tr key={r.line}><td className="p-3 font-mono text-[#6B6B6B]">{r.line}</td><td className="p-3">{r.queue}</td><td className="p-3">{r.day}</td><td className="p-3 font-mono">{slot(r.slot)}</td>
                        <td className="p-3 text-right font-mono">{r.volume}</td><td className="p-3 text-right font-mono text-[#6B6B6B]">{r.prevVolume ?? '–'}</td><td className="p-3 text-right font-mono">{r.ahtSec}s</td>
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
            <h3 className="text-[16px] font-bold text-[#2A7553]">Committed to live history</h3>
            <p className="text-[12px] text-[#2A7553]/90 max-w-md mx-auto">{int(job.createdRecords)} rows added, {int(job.updatedRecords)} changed, {int(job.skippedRecords)} skipped. It is recorded in the audit trail and can be rolled back below.</p>
            <Btn variant="primary" className="mx-auto" onClick={() => { setJob(null); setStep(1); }}>Import another file</Btn>
          </div>
        )}
      </Card>

      <Card title="Recent imports" sub="Newest first. Roll back only works while nothing later has overwritten the same intervals.">
        {jobs.data?.length === 0 ? <Empty title="No imports yet">Upload a file above to bring in your interval history.</Empty> : (
          <Table head={['File', 'Type', 'Rows', 'Result', 'When', 'By', 'Status', '']} right={[2]}>
            {jobs.data?.map((j) => (
              <tr key={j.id}>
                <td className="p-3 font-semibold"><span className="inline-flex items-center gap-2"><FileText className="w-3.5 h-3.5 text-[#6B6B6B]" />{j.fileName}</span></td>
                <td className="p-3 text-[12px]">{j.dataType === 'HISTORICAL_VOLUME' ? 'Interval history' : j.dataType.replace(/_/g, ' ').toLowerCase()}</td>
                <td className="p-3 text-right font-mono">{int(j.validRecords + j.warningRecords)}</td>
                <td className="p-3 text-[12px] text-[#525252]">{j.completedAt ? `${int(j.createdRecords)} new · ${int(j.updatedRecords)} changed` : j.errorRecords ? `${int(j.errorRecords)} rejected` : ''}</td>
                <td className="p-3 text-[12px] text-[#6B6B6B] whitespace-nowrap">{when(j.createdAt)}</td><td className="p-3 text-[12px]">{j.createdBy}</td>
                <td className="p-3"><Pill tone={STATUS_TONE[j.status] ?? 'neutral'}>{j.status.replace(/_/g, ' ').toLowerCase()}</Pill></td>
                <td className="p-3 text-right whitespace-nowrap">
                  {j.status === 'READY' && <button className="text-[12px] font-semibold underline" onClick={() => open(j.id)}>Review</button>}
                  {j.canRollback && !j.isRolledBack && can('data:rollback') && <button className="text-[12px] font-semibold text-[#BC3F3F] inline-flex items-center gap-1" onClick={() => rollback(j)}><RotateCcw className="w-3 h-3" />Roll back</button>}
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
    <div className="text-[11px] font-semibold text-[#6B6B6B] uppercase tracking-wider">{label}</div>
    <div className={`text-[24px] font-bold tabular-nums font-mono mt-1 ${tone === 'good' ? 'text-[#2A7553]' : tone === 'warn' ? 'text-[#8F6200]' : 'text-[#171717]'}`}>{int(value)}</div>
    <div className="text-[11px] text-[#6B6B6B]">{sub}</div>
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
        {q.data?.length === 0 ? <p className="text-[13px] text-[#2A7553] flex items-center gap-1.5"><CheckCircle2 className="w-4 h-4" />No data-quality issues.</p> : (
          <div className="space-y-2">{q.data?.map((i) => (
            <div key={i.id} className="border border-[#E5E5E0] rounded p-3 text-[12px]">
              <div className="flex items-center gap-2"><Pill tone={i.severity === 'ERROR' ? 'bad' : i.severity === 'WARNING' ? 'warn' : 'info'}>{i.severity}</Pill><span className="font-semibold">{i.entityName}</span></div>
              <div className="mt-1">{i.issue}</div><div className="text-[#6B6B6B]">{i.impactDescription} <span className="text-[#525252]">Fix: {i.suggestedRemediation}</span></div>
            </div>
          ))}</div>
        )}
      </Card>
    </div>
  );
};

// ---------------------------------------------------------------- live feed

// ---------------------------------------------------------------- data feeds

type FeedStatus = {
  lateAfterMin: number; closedNow: boolean; timezone: string;
  direct: { state: FeedState; lastReceivedAt: string | null; lastAttemptAt: string | null; accepted24h: number; rejected24h: number };
  connectors: FeedConnector[];
  recent: { receivedAt: string; source: string; rowsReceived: number; rowsAccepted: number; rowsRejected: number }[];
  rejects: { receivedAt: string; source: string; queue: string; rowIndex: number; message: string }[];
};
const SOURCE_LABEL: Record<string, string> = { API: 'HTTPS', NATS: 'Message bus' };
const LATE_CHOICES = [15, 30, 60, 120, 240, 480];

const CopyBox: React.FC<{ label: string; text: string; block?: boolean }> = ({ label, text, block }) => {
  const [done, setDone] = useState(false);
  return (
    <div>
      <div className="flex items-center justify-between mb-1">
        <div className="text-[11px] font-semibold text-[#6B6B6B] uppercase tracking-wider">{label}</div>
        <button className="text-[12px] underline text-[#525252]" onClick={() => { navigator.clipboard?.writeText(text); setDone(true); setTimeout(() => setDone(false), 1500); }}>{done ? 'Copied' : 'Copy'}</button>
      </div>
      {block ? <pre className="bg-[#FAFAF8] border border-[#E5E5E0] rounded p-2 font-mono text-[12px] overflow-x-auto">{text}</pre>
        : <code className="block bg-[#FAFAF8] border border-[#E5E5E0] rounded p-2 font-mono text-[12px] break-all">{text}</code>}
    </div>
  );
};

const LiveFeedPanel: React.FC = () => {
  const { session, can, go, setNotice } = useForecast();
  const [tick, setTick] = useState(0);
  const status = useApi<FeedStatus>('/data/ingest/status', [tick]);
  const queues = useApi<Queue[]>('/config/queues');
  const [itOpen, setItOpen] = useState(false);
  const cov = useApi<{ queueId: string; name: string; firstDay: string | null; lastDay: string | null; days: number; missingIntervals: number }[]>('/data/coverage', [tick]);
  const showPush = () => { setItOpen(true); setTimeout(() => document.getElementById('it-details')?.scrollIntoView({ behavior: 'smooth' }), 0); };
  const [msg, setMsg] = useState('');
  const [check, setCheck] = useState<{ ok: boolean; text: string } | null>(null);
  const [checking, setChecking] = useState(false);
  const canEdit = can('data:import');

  React.useEffect(() => { const t = setInterval(() => setTick((n) => n + 1), 30_000); return () => clearInterval(t); }, []);   // keep "last data" honest while the page stays open

  const example = JSON.stringify({ rows: [{ queue: queues.data?.[0]?.name ?? 'Support Voice', day: new Date().toISOString().slice(0, 10), time: '09:15', volume: 42, ahtSec: 310 }] }, null, 2);
  const body = msg || example;
  const runCheck = async () => {
    setChecking(true); setCheck(null);
    try {
      const r = await api<{ accepted: number; errors: { index: number; message: string }[] }>('/data/ingest/check', { method: 'POST', body: JSON.parse(body) });
      setCheck(r.errors.length
        ? { ok: false, text: `${r.accepted} row${r.accepted === 1 ? '' : 's'} would be saved. ${r.errors.length} would be rejected: ${r.errors.slice(0, 5).map((e) => `row ${e.index + 1}: ${e.message}`).join('; ')}` }
        : { ok: true, text: `This message is fine: ${r.accepted} row${r.accepted === 1 ? '' : 's'} would be saved. Nothing was saved just now.` });
    } catch (e: any) { setCheck({ ok: false, text: e instanceof SyntaxError ? 'That is not valid JSON. Check the brackets and quotes.' : e.message }); }
    finally { setChecking(false); }
  };
  const saveLate = async (n: number) => {
    try { await api('/data/ingest/settings', { method: 'PUT', body: { lateAfterMin: n } }); setNotice({ kind: 'ok', text: `Feeds are now marked late after ${n} minutes without data.` }); setTick((t) => t + 1); }
    catch (e: any) { setNotice({ kind: 'err', text: e.message }); }
  };

  const s = status.data;
  const late = s ? [...(s.direct.state === 'LATE' ? ['Direct feed'] : []), ...s.connectors.filter((c) => c.state === 'LATE').map((c) => c.name)] : [];
  const choices = s && !LATE_CHOICES.includes(s.lateAfterMin) ? [...LATE_CHOICES, s.lateAfterMin].sort((a, b) => a - b) : LATE_CHOICES;
  return (
    <div className="space-y-6">
      {late.length > 0 && s && <Banner kind="warn">{late.join(', ')} {late.length === 1 ? 'has' : 'have'} sent nothing for over {s.lateAfterMin} minutes while queues were open. Live coverage and accuracy checks are using older numbers until data arrives.</Banner>}
      {status.error && <Banner kind="err">{status.error}</Banner>}

      {cov.data && (() => {
        const withData = cov.data.filter((c) => c.days > 0);
        const gaps = cov.data.filter((c) => c.missingIntervals > 0).length;
        const shortest = withData.length ? withData.reduce((m, c) => (c.days < m.days ? c : m)) : null;
        const newest = withData.map((c) => c.lastDay as string).sort().pop() ?? null;
        const weeks = (d: number) => `${Math.floor(d / 7)} week${Math.floor(d / 7) === 1 ? '' : 's'}`;
        return (
          <div className="rounded-lg border border-[#E5E5E0] bg-[#FAFAF8] px-4 py-3 flex flex-wrap items-center gap-x-6 gap-y-1 text-[13px]">
            <div className="font-semibold">Forecast history</div>
            {shortest ? <div><span className="text-[#6B6B6B]">Shortest history </span><span className={`font-semibold ${shortest.days < 28 ? 'text-[#8F6200]' : ''}`}>{weeks(shortest.days)}</span>{shortest.days < 28 && <span className="text-[#8F6200]"> · forecasts need at least 4 weeks ({shortest.name})</span>}</div> : <div className="text-[#8F6200]">No history loaded yet. Add a source below, or upload a file on Staged Ingestion.</div>}
            {newest && <div><span className="text-[#6B6B6B]">Newest day </span><span className="font-semibold">{dayYear(newest)}</span></div>}
            {gaps > 0 ? <button className="underline text-[#8F6200] font-semibold" onClick={() => go('data-quality', 'data-management')}>{gaps} queue{gaps === 1 ? ' has' : 's have'} gaps</button> : withData.length > 0 && <span className="text-[#2A7553] font-semibold">No gaps</span>}
          </div>
        );
      })()}

      {!s ? <Busy /> : (
        <SourcesManager connectors={s.connectors} timezone={s.timezone} onShowPush={showPush} onChanged={() => setTick((t) => t + 1)}
          phoneCard={
            <SourceCard icon={<Radio className="w-4 h-4" />} kindLabel="Pushed to us" name="Direct feed" state={s.direct.state} lastData={s.direct.lastReceivedAt}
              detail={s.direct.accepted24h || s.direct.rejected24h ? <div>{int(s.direct.accepted24h)} saved{s.direct.rejected24h > 0 && <span className="text-[#8F6200] font-semibold"> · {int(s.direct.rejected24h)} rejected</span>} in the last 24 hours</div> : <div className="text-[#6B6B6B]">Your phone system sends each 15-minute count as it closes.</div>}
              hint={s.direct.state === 'WAITING' ? 'Give your IT team the address and a way to test it, under “For your IT team” below.' : null}
              action={{ label: 'Address and test', onClick: showPush }} />
          } />
      )}
      {s && s.closedNow && <p className="text-[12px] text-[#6B6B6B]">All queues are closed right now, so quiet sources are expected.</p>}
      {s && (
        <div className="flex flex-wrap items-center gap-2 text-[13px]">
          <span>Mark a source late after</span>
          <Select className="!w-auto" value={s.lateAfterMin} disabled={!canEdit} onChange={(e) => saveLate(Number(e.target.value))}>{choices.map((n) => <option key={n} value={n}>{n < 60 ? `${n} minutes` : `${n / 60} hour${n === 60 ? '' : 's'}`}</option>)}</Select>
          <span className="text-[#6B6B6B]">without data. Only time when a queue is open counts (set opening hours per queue in WFM Groups). Scheduled sources are late after twice their schedule.</span>
        </div>
      )}

      <Card title="Rows turned away" sub="Rows the feed received but could not use, with the reason. They are not saved, so fix the source and send them again.">
        {!s ? <Busy /> : s.rejects.length === 0 ? <Empty title="Nothing has been rejected">Every row received so far was saved.</Empty> : (
          <Table head={['When', 'Via', 'Queue', 'Row', 'Why']}>
            {s.rejects.map((r, i) => <tr key={i}><td className="p-3 whitespace-nowrap">{when(r.receivedAt)}</td><td className="p-3">{SOURCE_LABEL[r.source] ?? r.source}</td><td className="p-3">{r.queue || '–'}</td><td className="p-3 font-mono">{r.rowIndex + 1}</td><td className="p-3">{r.message}</td></tr>)}
          </Table>
        )}
      </Card>

      {s && s.recent.length > 0 && (
        <Card title="Recent messages" sub="The last 10 messages the direct feed received.">
          <Table head={['When', 'Via', 'Rows sent', 'Saved', 'Rejected']} right={[2, 3, 4]}>
            {s.recent.map((r, i) => <tr key={i}><td className="p-3 whitespace-nowrap">{when(r.receivedAt)}</td><td className="p-3">{SOURCE_LABEL[r.source] ?? r.source}</td><td className="p-3 text-right font-mono">{int(r.rowsReceived)}</td><td className="p-3 text-right font-mono">{int(r.rowsAccepted)}</td><td className="p-3 text-right font-mono">{r.rowsRejected ? int(r.rowsRejected) : '–'}</td></tr>)}
          </Table>
        </Card>
      )}

      <div id="it-details"><Card title="For your IT team" sub="How the phone system sends counts to the direct feed. Rows are saved straight to history (small, repeatable updates), unlike uploaded files, and the accuracy checks pick them up."
        actions={<Btn onClick={() => setItOpen((o) => !o)}>{itOpen ? 'Hide details' : 'Show details'}</Btn>}>
        {itOpen && (
          <div className="space-y-4 text-[13px]">
            <CopyBox label="HTTPS (POST)" text="/api/v1/data/ingest" />
            <p className="text-[12px] text-[#6B6B6B] -mt-2">Send it with an API key that is allowed to import data. Create one in Security & Access › <button className="underline" onClick={() => go('api-access', 'administration')}>API & Single Sign-On</button>.</p>
            <CopyBox label="Message bus subject (NATS)" text={`wfm.${session.tenant.id}.ingest.interval`} />
            <div>
              <div className="text-[11px] font-semibold text-[#6B6B6B] uppercase tracking-wider mb-1">Message body, and a way to check it</div>
              <textarea className="w-full h-44 bg-[#FAFAF8] border border-[#E5E5E0] rounded p-2 font-mono text-[12px]" value={body} onChange={(e) => { setMsg(e.target.value); setCheck(null); }} spellCheck={false} />
              <div className="flex flex-wrap items-center gap-2 mt-2">
                <Btn variant="primary" disabled={checking || !canEdit} onClick={runCheck}>Check this message</Btn>
                <Btn onClick={() => { navigator.clipboard?.writeText(body); }}>Copy</Btn>
                {msg && <Btn onClick={() => { setMsg(''); setCheck(null); }}>Reset to the example</Btn>}
                {checking && <Busy text="Checking…" />}
              </div>
              {check && <div className="mt-2"><Banner kind={check.ok ? 'ok' : 'err'}>{check.text}</Banner></div>}
            </div>
            <p className="text-[12px] text-[#6B6B6B]">Up to 5,000 rows per message. A row for an interval that already exists replaces it. Each queue may be named by its name or code. Checking a message saves nothing.</p>
          </div>
        )}
      </Card></div>
    </div>
  );
};
