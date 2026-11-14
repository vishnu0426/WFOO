/**
 * Org chart setup: when people have no reporting line the chart is empty, so that is treated as a task, not a footnote.
 *   - SetupBanner: "Assign managers to 382 people", with the three ways to do it: from the teams (every team lead becomes the manager of their team), from a file, or one by one.
 *   - FromTeamsDialog: shows what would happen first (people set, people left alone, teams that have no lead yet), then does it for every team at once.
 *   - ImportDialog: a CSV of employee number and who they report to (the exported file works as it is), checked before anything is saved; rows with a problem are listed and skipped.
 */
import React, { useRef, useState } from 'react';
import { AlertTriangle, Upload } from 'lucide-react';
import { api } from '../../services/api';
import { useApi } from '../forecasting/hooks';
import { Banner, Btn } from '../forecasting/ui';
import { Confirm } from '../configuration/groups/shared';

const n = (v: number) => v.toLocaleString('en-US');
const people = (v: number) => `${n(v)} ${v === 1 ? 'person' : 'people'}`;

type Setup = {
  teams: { id: string; name: string; leadName: string | null; people: number; wouldSet: number; wouldChange: number }[];
  withLead: { teams: number; wouldSet: number; wouldChange: number }; withoutLead: { teams: number; people: number }; noTeam: number;
};

export const SetupBanner: React.FC<{ unassigned: number; total: number; canWrite: boolean; listOpen: boolean; onToggleList: () => void; onFromTeams: () => void; onImport: () => void }> = ({ unassigned, total, canWrite, listOpen, onToggleList, onFromTeams, onImport }) => {
  if (unassigned <= 0) return null;
  const heavy = total > 0 && unassigned / total >= 0.2;
  return (
    <div role="region" aria-label="Reporting lines to set up" className={`rounded-lg border p-4 flex flex-wrap items-center justify-between gap-3 ${heavy ? 'border-[#B7791F]/30 bg-[#FFF5DD]' : 'border-[#4F6F8F]/20 bg-[#EDF3F8]'}`}>
      <div className="flex items-start gap-3 min-w-0">
        <AlertTriangle className={`w-5 h-5 mt-0.5 shrink-0 ${heavy ? 'text-[#8F6200]' : 'text-[#4F6F8F]'}`} aria-hidden="true" />
        <div>
          <div className="text-[14px] font-bold text-[#171717]">{canWrite ? `Assign managers to ${n(unassigned)} ${unassigned === 1 ? 'person' : 'people'}` : `${n(unassigned)} of ${n(total)} people have no manager`}</div>
          <div className="text-[12px] text-[#525252] mt-0.5">{n(unassigned)} of {n(total)} people report to nobody, so the chart cannot show who is under whom, and approvals and alerts that follow reporting lines have nowhere to go.</div>
        </div>
      </div>
      {canWrite && (
        <div className="flex flex-wrap items-center gap-2">
          <Btn variant="primary" onClick={onFromTeams}>Set from teams</Btn>
          <Btn onClick={onImport}><Upload className="w-3.5 h-3.5" aria-hidden="true" />Import from a file</Btn>
          <Btn onClick={onToggleList}>{listOpen ? 'Hide the list' : 'Choose one by one'}</Btn>
        </div>
      )}
    </div>
  );
};

export const FromTeamsDialog: React.FC<{ groupId: string; onCancel: () => void; onDone: (text: string) => void }> = ({ groupId, onCancel, onDone }) => {
  const s = useApi<Setup>(`/workforce/org-chart/setup${groupId ? `?groupId=${groupId}` : ''}`);
  const [overwrite, setOverwrite] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const d = s.data;
  const count = d ? d.withLead.wouldSet + (overwrite ? d.withLead.wouldChange : 0) : 0;
  const go = async (reason: string) => {
    setBusy(true); setError('');
    try {
      const r = await api<{ updated: number; skipped: number }>('/workforce/org-chart/apply-teams', { method: 'POST', timeoutMs: 120_000, body: { overwrite, reason, ...(groupId ? { groupId } : {}) } });
      onDone(`${people(r.updated)} now ${r.updated === 1 ? 'reports' : 'report'} to their team lead.${r.skipped ? ` ${n(r.skipped)} skipped because a line would have looped back on itself.` : ''}`);
    } catch (e: any) { setError(e.message); setBusy(false); }
  };
  return (
    <Confirm title="Make each team lead the manager of their team" confirmLabel={`Set ${n(count)} reporting ${count === 1 ? 'line' : 'lines'}`} reason busy={busy} disabled={!d || count === 0} error={error || (s.error ? s.error : '')} onCancel={onCancel} onConfirm={go}>
      {!d ? <p>Checking the teams…</p> : (
        <>
          <p><b>{people(d.withLead.wouldSet)}</b> in {d.withLead.teams} {d.withLead.teams === 1 ? 'team' : 'teams'} with a lead have no manager and will now report to their team lead. A team lead is never put under themselves.</p>
          {d.withLead.wouldChange > 0 && <label className="flex items-center gap-2 text-[13px]"><input type="checkbox" checked={overwrite} onChange={(e) => setOverwrite(e.target.checked)} />Also change the {people(d.withLead.wouldChange)} who already report to someone else</label>}
          {d.withoutLead.teams > 0 && <Banner kind="warn">{n(d.withoutLead.teams)} {d.withoutLead.teams === 1 ? 'team has' : 'teams have'} no lead yet, so {people(d.withoutLead.people)} cannot be set this way. Choose leads on the Teams screen first.</Banner>}
          {d.noTeam > 0 && <p className="text-[12px]">{people(d.noTeam)} are in no team and have no manager: put them in a team, or use a file or “Choose one by one”.</p>}
          <ul className="max-h-36 overflow-y-auto text-[12px] divide-y divide-[#F0F0EC] border border-[#E5E5E0] rounded-md">
            {d.teams.slice(0, 30).map((t) => <li key={t.id} className="flex justify-between gap-3 px-2.5 py-1.5"><span className="truncate">{t.name} <span className="text-[#6B6B6B]">· {t.leadName ? `lead ${t.leadName}` : 'no lead'}</span></span><span className="shrink-0 tabular-nums">{t.leadName ? `${n(t.wouldSet + (overwrite ? t.wouldChange : 0))} to set` : 'skipped'}</span></li>)}
          </ul>
          {d.withLead.wouldSet === 0 && d.withLead.wouldChange === 0 && <p>Everyone in a team with a lead already reports to them.</p>}
        </>
      )}
    </Confirm>
  );
};

type Check = { dryRun: boolean; rows: number; blank: number; willChange: number; unchanged: number; problemCount: number; problems: { line: number; message: string }[]; applied: number };

export const ImportDialog: React.FC<{ onCancel: () => void; onDone: (text: string) => void; onTemplate: () => void }> = ({ onCancel, onDone, onTemplate }) => {
  const [csv, setCsv] = useState('');
  const [check, setCheck] = useState<Check | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const file = useRef<HTMLInputElement>(null);
  const run = async (dryRun: boolean, reason?: string) => {
    setBusy(true); setError('');
    try {
      const r = await api<Check>('/workforce/org-chart/import', { method: 'POST', timeoutMs: 120_000, body: { csv, dryRun, ...(reason ? { reason } : {}) } });
      if (dryRun) setCheck(r); else onDone(`${people(r.applied)} now ${r.applied === 1 ? 'has' : 'have'} a reporting line from the file.${r.problemCount ? ` ${n(r.problemCount)} rows were skipped.` : ''}`);
    } catch (e: any) { setError(e.message); } finally { setBusy(false); }
  };
  return (
    <Confirm title="Import reporting lines from a file" confirmLabel={check ? `Set ${n(check.willChange)} reporting ${check.willChange === 1 ? 'line' : 'lines'}` : 'Check the file first'} reason busy={busy} disabled={!check || check.willChange === 0} error={error} onCancel={onCancel} onConfirm={(r) => run(false, r)}>
      <p>A file with two columns: <b>employee_number</b> and <b>reports_to_number</b> (the employee number of their manager). The file the chart exports works as it is: fill in <b>reports_to_number</b> and load it back. A row with no manager is left alone.</p>
      <div className="flex flex-wrap items-center gap-2">
        <Btn onClick={() => file.current?.click()}><Upload className="w-3.5 h-3.5" aria-hidden="true" />Choose a file</Btn>
        <input ref={file} type="file" accept=".csv,text/csv" className="hidden" aria-label="Reporting lines file" onChange={async (e) => { const f = e.target.files?.[0]; if (f) { setCsv(await f.text()); setCheck(null); setError(''); } e.target.value = ''; }} />
        <button className="text-[12px] underline" onClick={onTemplate}>Download the current lines to fill in</button>
      </div>
      <textarea aria-label="Or paste the file here" className="w-full h-24 rounded-md border border-[#E5E5E0] p-2 text-[12px] font-mono" placeholder={'employee_number,reports_to_number\nE1001,S100'} value={csv} onChange={(e) => { setCsv(e.target.value); setCheck(null); }} />
      <Btn disabled={busy || csv.trim().length < 3} onClick={() => run(true)}>{busy && !check ? 'Checking…' : 'Check the file'}</Btn>
      {check && (
        <div className="space-y-1.5" role="status">
          <p><b>{n(check.willChange)}</b> {check.willChange === 1 ? 'line' : 'lines'} will be set{check.unchanged ? `, ${n(check.unchanged)} already as in the file` : ''}{check.blank ? `, ${n(check.blank)} rows with no manager left alone` : ''}.</p>
          {check.problemCount > 0 && (
            <Banner kind="warn">{n(check.problemCount)} {check.problemCount === 1 ? 'row has a problem and is' : 'rows have a problem and are'} skipped:
              <ul className="list-disc ml-5 mt-1 max-h-28 overflow-y-auto">{check.problems.slice(0, 8).map((p) => <li key={p.line}>line {p.line}: {p.message}</li>)}{check.problemCount > 8 && <li>and {n(check.problemCount - 8)} more</li>}</ul>
            </Banner>
          )}
        </div>
      )}
    </Confirm>
  );
};
