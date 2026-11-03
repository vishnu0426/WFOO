/**
 * The warning on a schedule whose forecast has moved on. It says how much the demand changed and how well the shifts as they stand would
 * cover it, and offers to build a new draft from the same settings on the forecast that is published now. The old schedule is kept.
 */
import React, { useState } from 'react';
import { api, ScheduleVersion } from '../../services/api';
import { useForecast } from '../../services/forecastStore';
import { useApi } from '../forecasting/hooks';
import { Banner, Btn } from '../forecasting/ui';

type Change = { available: boolean; forecastName?: string; builtHours?: number | null; nowHours?: number; changePercent?: number | null; coverageBefore?: number | null; coverageNow?: number; material?: boolean };
type Result = { kind: 'VERSION'; version: ScheduleVersion; note: string | null } | { kind: 'JOB'; job: { id: string }; note: string | null };

export const StaleBanner: React.FC<{ version: ScheduleVersion; reload: (selectId?: string) => Promise<void> | void; go: (sub: string) => void; showQualityLink?: boolean }> = ({ version, reload, go, showQualityLink }) => {
  const { can, setNotice } = useForecast();
  const stale = !!version.stale && version.stale.length > 0;
  const change = useApi<Change>(stale ? `/scheduling/versions/${version.id}/forecast-change` : null, [version.id, version.rev]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  if (!stale) return null;
  const c = change.data;
  const regenerate = async () => {
    setBusy(true); setErr('');
    try {
      const r = await api<Result>(`/scheduling/versions/${version.id}/regenerate`, { method: 'POST', body: {} });
      if (r.kind === 'VERSION') { setNotice({ kind: 'ok', text: `Built ${r.version.name} on ${c?.forecastName ?? 'the current forecast'}. ${r.note ?? ''} The earlier schedule is kept.`.replace('  ', ' ') }); await reload(r.version.id); }
      else { setNotice({ kind: 'info', text: `${r.note ?? ''} A long schedule is being built in the background: follow it in Generate Schedule.`.trim() }); go('generate-schedule'); }
    } catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  };
  const up = (c?.changePercent ?? 0) > 0;
  return (
    <Banner kind="warn">
      <div><span className="font-semibold">This schedule may be out of date.</span> {version.stale!.join(' ')}</div>
      {c?.available && c.changePercent != null && c.builtHours != null && (
        <div className="mt-1 text-[13px]">
          {Math.abs(c.changePercent) < 0.1 ? 'The demand is about the same as when it was built' : <>Demand is <b>{Math.abs(c.changePercent)}% {up ? 'higher' : 'lower'}</b> than when it was built</>}
          {' '}({Math.round(c.builtHours).toLocaleString('en-US')} h then, {Math.round(c.nowHours ?? 0).toLocaleString('en-US')} h now{c.forecastName ? ` on ${c.forecastName}` : ''}).
          {c.coverageBefore != null && c.coverageNow != null && <> These shifts would cover <b>{c.coverageNow}%</b> of it{c.coverageNow !== c.coverageBefore ? ` (${c.coverageBefore}% when built)` : ''}.</>}
          {!c.material && ' That is a small change: you may not need to rebuild.'}
        </div>
      )}
      <div className="mt-2 flex flex-wrap items-center gap-3">
        {can('schedule:generate') && <Btn variant="primary" disabled={busy} onClick={regenerate}>{busy ? 'Building…' : 'Regenerate on the new forecast'}</Btn>}
        {showQualityLink && <button className="underline text-[13px]" onClick={() => go('schedule-quality')}>See schedule quality</button>}
        <span className="text-[12px] text-[#525252]">Builds a new draft with the same settings. This schedule is kept; manual changes in it are not carried over.</span>
      </div>
      {err && <div className="mt-1 text-[#BC3F3F] text-[13px]">{err}</div>}
    </Banner>
  );
};
