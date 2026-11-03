/**
 * Progress of a background schedule build or re-solve: which weeks are done, how long is left, and a way to cancel. The job runs on the server, so
 * this can be closed and opened again later and still shows where it is.
 */
import React, { useEffect, useRef, useState } from 'react';
import { api, ScheduleJob } from '../../services/api';
import { Banner, Btn, Card, Pill } from '../forecasting/ui';

const eta = (s: number | null | undefined) => (s == null ? 'working out how long it will take…' : s < 45 ? 'under a minute left' : `about ${Math.ceil(s / 60)} min left`);
const weeksIn = (from: string, to: string) => Math.round((new Date(to).getTime() - new Date(from).getTime()) / 86_400_000 / 7 + 1 / 7);

export const JobCard: React.FC<{ jobId: string; canCancel: boolean; onFinished: (job: ScheduleJob) => void }> = ({ jobId, canCancel, onFinished }) => {
  const [job, setJob] = useState<ScheduleJob | null>(null);
  const [error, setError] = useState('');
  const finished = useRef(false);
  useEffect(() => {
    finished.current = false; setJob(null);
    let live = true;
    const tick = async () => {
      try {
        const j = await api<ScheduleJob>(`/scheduling/jobs/${jobId}`);
        if (!live) return;
        setJob(j);
        if (['DONE', 'FAILED', 'CANCELLED'].includes(j.status) && !finished.current) { finished.current = true; onFinished(j); }
      } catch (e: any) { if (live) setError(e.message); }
    };
    void tick();
    const id = setInterval(() => { if (!finished.current) void tick(); }, 2000);
    return () => { live = false; clearInterval(id); };
  }, [jobId]);

  if (!job) return <Card title="Starting…"><p className="text-[12px] text-[#6B6B6B]">{error || 'Contacting the server…'}</p></Card>;
  const { progress: p } = job, total = p.total || 1, done = Math.min(total, p.done ?? 0), pct = Math.round((done / total) * 100);
  const builtWeeks = (p.windows ?? []).reduce((n, w) => n + weeksIn(w.from, w.to), 0);
  const active = job.status === 'QUEUED' || job.status === 'RUNNING';
  const title = job.kind === 'PLAN' ? `Building ${job.params.weeks} weeks from ${job.params.from}` : 'Re-solving the weeks that are not locked';
  return (
    <Card title={title} sub={active ? 'This runs on the server. You can leave this page and come back; it keeps going.' : undefined}
      actions={active && canCancel ? <Btn disabled={job.cancelRequested} onClick={() => api(`/scheduling/jobs/${job.id}/cancel`, { method: 'POST', body: {} }).catch((e) => setError(e.message))}>{job.cancelRequested ? 'Cancelling…' : 'Cancel'}</Btn> : undefined}>
      {active && (
        <div className="space-y-2" role="status">
          <div className="flex items-baseline justify-between text-[13px]">
            <span className="font-semibold">{job.status === 'QUEUED' ? 'Waiting for a free solver…' : `${builtWeeks > 0 ? `${builtWeeks} of ${job.params.weeks ?? '?'} weeks built · ` : ''}${p.note ?? 'Working'}`}</span>
            <span className="text-[#6B6B6B]">{job.status === 'RUNNING' ? eta(p.etaSec) : ''}</span>
          </div>
          <div className="h-2 rounded bg-[#E5E5E0] overflow-hidden"><div className="h-full bg-[#171717] transition-all duration-700" style={{ width: `${job.status === 'QUEUED' ? 3 : Math.max(3, pct)}%` }} /></div>
        </div>
      )}
      {job.status === 'FAILED' && <Banner kind="err">{job.error || 'The build failed.'}</Banner>}
      {job.status === 'CANCELLED' && <Banner kind="info">Cancelled. Nothing was kept.</Banner>}
      {job.status === 'DONE' && <Banner kind="ok">Done.</Banner>}
      {error && <Banner kind="err" onClose={() => setError('')}>{error}</Banner>}
      {(p.windows?.length ?? 0) > 0 && (
        <ul className="text-[12px] space-y-1">
          {p.windows!.map((w, i) => (
            <li key={i} className="flex flex-wrap items-center gap-2">
              <span className="font-mono text-[#525252]">{w.from} → {w.to}</span>
              {w.kind === 'SOLVED' ? <Pill tone={(w.coverage ?? 0) >= 95 ? 'good' : (w.coverage ?? 0) >= 85 ? 'warn' : 'bad'}>{w.coverage ?? '–'}% covered</Pill> : <Pill tone="info">repeated from the last cycle</Pill>}
              {w.backend && w.backend !== 'cpsat' && <Pill tone="warn" title="The main solver could not answer, so a backup did">backup solver: {w.backend}</Pill>}
              {w.note && w.kind === 'PATTERN' && <span className="text-[#6B6B6B]">{w.note}</span>}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
};
