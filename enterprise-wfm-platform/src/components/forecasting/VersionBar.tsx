/**
 * Picks the forecast version and moves it through the lifecycle:
 * Draft -> Submitted -> Approved -> Published (older published versions become Archived).
 * Which buttons show follows the signed-in user's permissions; the gateway enforces them again.
 */
import React, { useState } from 'react';
import { CheckCircle2, ChevronRight, Download, Plus } from 'lucide-react';
import { api, download, dayYear, isNew, STATUS_FLOW, STATUS_LABEL, when } from '../../services/api';
import { useForecast } from '../../services/forecastStore';
import { Banner, Btn, Busy, Pill, Select } from './ui';

export const VersionBar: React.FC<{ flat?: boolean }> = ({ flat = false }) => {
  const { versions, version, kind, setKind, setVersionId, reload, can, go, setNotice } = useForecast();
  const [busy, setBusy] = useState(false);
  const mine = versions.filter((v) => v.kind === kind);
  const st = version?.status;
  const idx = st ? STATUS_FLOW.indexOf(st) : -1;

  const run = async (fn: () => Promise<void>, ok?: string) => {
    setBusy(true);
    setNotice(null);
    try { await fn(); if (ok) setNotice({ kind: 'ok', text: ok }); } catch (e: any) { setNotice({ kind: 'err', text: e.message }); } finally { setBusy(false); }
  };
  const step = (path: string, ok: string, askReason?: string) => run(async () => {
    const body: any = {};
    if (askReason) {
      const r = prompt(askReason);
      if (!r || r.trim().length < 3) throw new Error('A reason is required');
      body.reason = r.trim();
    }
    await api(`/forecast/versions/${version!.id}/${path}`, { method: 'POST', body });
    await reload(version!.id);
  }, ok);

  return (
    <div className={flat ? 'border-b border-[#E5E5E0] px-6 py-3 bg-white space-y-3' : 'border border-[#E5E5E0] rounded-lg p-4 bg-[#FAFAF8] space-y-3'}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2.5">
          <div className="flex items-center text-[12px] border border-[#E5E5E0] rounded bg-white p-0.5">
            {(['SHORT', 'LONG'] as const).map((k) => (
              <button key={k} onClick={() => setKind(k)} title={k === 'SHORT' ? '15-minute intervals, used for scheduling' : 'Daily volumes, used for capacity planning'}
                className={`px-2.5 py-1 rounded font-medium ${kind === k ? 'bg-[#171717] text-white' : 'text-[#525252]'}`}>{k === 'SHORT' ? 'Short-term' : 'Long-term'}</button>
            ))}
          </div>
          <Select value={version?.id ?? ''} onChange={(e) => setVersionId(e.target.value || null)} className="!w-auto min-w-[300px]" aria-label="Forecast version">
            {mine.length === 0 && <option value="">No {kind === 'SHORT' ? 'short' : 'long'}-term forecasts</option>}
            {mine.map((v) => <option key={v.id} value={v.id}>{v.status === 'PUBLISHED' ? '● ' : ''}{v.name} — {STATUS_LABEL[v.status].toLowerCase()}{isNew(v) ? ' — NEW' : ''}</option>)}
          </Select>
          {version && isNew(version) && <Pill tone="info">NEW</Pill>}
        </div>
        <div className="flex items-center gap-2">
          {busy && <Busy />}
          {version && <Btn onClick={() => run(() => download(`/forecast/versions/${version.id}/export.csv`, `forecast-v${version.seq}.csv`))}><Download className="w-3.5 h-3.5" />Export CSV</Btn>}
          {can('forecast:delete') && version && version.status !== 'PUBLISHED' && (
            <Btn onClick={() => {
              if (!confirm(`Delete "${version.name}"?`)) return;
              run(async () => { await api(`/forecast/versions/${version.id}`, { method: 'DELETE' }); setVersionId(null); await reload(); }, 'Forecast deleted.');
            }}>Delete</Btn>
          )}
          {can('forecast:create') && version && (version.status === 'PUBLISHED' || version.status === 'ARCHIVED') && (
            <Btn onClick={() => run(async () => { const v = await api(`/forecast/versions/${version.id}/clone`, { method: 'POST' }); await reload(v.id); }, 'Draft copy created. Adjust it, then submit it for approval.')}>Clone to edit</Btn>
          )}
          {!flat && can('forecast:create') && <Btn onClick={() => go('forecast-builder')}><Plus className="w-3.5 h-3.5" />New forecast</Btn>}
        </div>
      </div>

      {version && (
        <>
          <div className="flex flex-wrap items-center gap-1.5 text-[12px]">
            {STATUS_FLOW.map((s, i) => {
              const done = i < idx || st === 'ARCHIVED';
              const now = i === idx;
              return (
                <React.Fragment key={s}>
                  <span className={`flex items-center gap-1.5 px-2.5 py-1 rounded-full font-semibold border ${
                    done ? 'bg-[#EAF5EF] text-[#2F7D5A] border-[#2F7D5A]/20' : now ? 'bg-[#171717] text-white border-[#171717]' : 'bg-white text-[#737373] border-[#E5E5E0]'}`}>
                    {done && <CheckCircle2 className="w-3.5 h-3.5" />}{i + 1} · {STATUS_LABEL[s]}
                  </span>
                  {i < STATUS_FLOW.length - 1 && <ChevronRight className="w-3.5 h-3.5 text-[#A3A3A3]" />}
                </React.Fragment>
              );
            })}
            {st === 'ARCHIVED' && <Pill>Archived: a newer forecast was published</Pill>}
            <span className="text-[11px] text-[#737373] ml-2">
              {dayYear(version.fromDay)} → {dayYear(version.toDay)} · created {when(version.createdAt)}{version.createdBy ? ` by ${version.createdBy}` : ''}
              {version.publishedAt ? ` · published ${when(version.publishedAt)}` : ''}
            </span>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {st === 'DRAFT' && (<>
              {can('forecast:submit') && <Btn variant="primary" disabled={busy} onClick={() => step('submit', 'Submitted for approval. It is now locked: approve it, or return it to draft.')}>Submit for approval</Btn>}
              <span className="text-[11px] text-[#737373]">Adjust it first under Adjustments; it locks once submitted.</span>
            </>)}
            {st === 'SUBMITTED' && (<>
              {can('forecast:approve') && <Btn variant="primary" disabled={busy} onClick={() => step('approve', 'Approved. Publish it to drive the schedule.')}>Approve</Btn>}
              {(can('forecast:approve') || can('forecast:submit')) && <Btn disabled={busy} onClick={() => step('reject', 'Returned to draft.', 'Why is it being returned to draft?')}>Return to draft</Btn>}
              {version.submittedBy && <span className="text-[11px] text-[#737373]">Submitted by {version.submittedBy}</span>}
            </>)}
            {st === 'APPROVED' && (<>
              {can('forecast:publish') && <Btn variant="success" disabled={busy} onClick={() => step('publish', 'Published. Staffing coverage and the auto-scheduler now use this forecast.')}>Publish</Btn>}
              {(can('forecast:approve') || can('forecast:submit')) && <Btn disabled={busy} onClick={() => step('reject', 'Returned to draft.', 'Why is it being returned to draft?')}>Return to draft</Btn>}
              {version.approvedBy && <span className="text-[11px] text-[#737373]">Approved by {version.approvedBy}</span>}
            </>)}
            {st === 'PUBLISHED' && <Pill tone="good">Live: this forecast drives the schedule</Pill>}
          </div>
        </>
      )}
    </div>
  );
};

export const NoticeBanner: React.FC = () => {
  const { notice, setNotice } = useForecast();
  if (!notice) return null;
  return <Banner kind={notice.kind} onClose={() => setNotice(null)}>{notice.text}</Banner>;
};
