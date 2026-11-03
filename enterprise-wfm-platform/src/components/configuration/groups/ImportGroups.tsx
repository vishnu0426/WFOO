/** Create many groups and their queues from one file: check it first, see every problem with its line, and create nothing until the whole file is good. */
import React, { useRef, useState } from 'react';
import { Download, Upload } from 'lucide-react';
import { api, download } from '../../../services/api';
import { Banner, Btn, Card, Pill, Table } from '../../forecasting/ui';
import { ImportResult } from './shared';

export const ImportGroups: React.FC<{ onDone: (created: number) => Promise<void>; onCancel: () => void }> = ({ onDone, onCancel }) => {
  const file = useRef<HTMLInputElement>(null);
  const [name, setName] = useState('');
  const [csv, setCsv] = useState('');
  const [result, setResult] = useState<ImportResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const check = async (text: string, dryRun: boolean) => {
    setBusy(true); setError('');
    try {
      const r = await api<ImportResult>('/config/groups/import', { method: 'POST', body: { csv: text, dryRun } });
      setResult(r);
      if (r.committed) await onDone(r.groups.length);
    } catch (e: any) { setError(e.message); } finally { setBusy(false); }
  };
  const pick = async (f: File) => { const text = await f.text(); setName(f.name); setCsv(text); setResult(null); await check(text, true); };
  const ready = result && !result.committed && result.errorCount === 0 && result.groups.length > 0;

  return (
    <Card title="Create groups from a file" sub="One row per queue. The group columns are filled on the first row of each group and can be left blank after that. Nothing is created until the whole file passes the check.">
      <div className="space-y-3">
        <div className="flex flex-wrap gap-2 items-center">
          <input ref={file} type="file" accept=".csv,.txt,text/csv" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) void pick(f); e.target.value = ''; }} />
          <Btn onClick={() => file.current?.click()} disabled={busy}><Upload className="w-3.5 h-3.5" />Choose a file</Btn>
          <Btn onClick={() => download('/config/groups/import-template', 'wfm-groups-template.csv').catch((e) => setError(e.message))}><Download className="w-3.5 h-3.5" />Download the template</Btn>
          {name && <span className="text-[12px] text-[#6B6B6B]">{name}</span>}
        </div>
        <p className="text-[12px] text-[#6B6B6B]">Columns: group, description, site, timezone, service_level_goal, answer_seconds, shrinkage_percent, occupancy_cap, queue, channel (VOICE, CHAT, EMAIL or BACKOFFICE), handle_time_sec, queue_aliases (separated by |). Only <b>group</b> is required.</p>
        {busy && <p className="text-[12px] text-[#6B6B6B]">Checking…</p>}
        {error && <Banner kind="err" onClose={() => setError('')}>{error}</Banner>}
        {result && result.errorCount > 0 && (
          <div className="space-y-2">
            <Banner kind="err">{result.errorCount} problem{result.errorCount === 1 ? '' : 's'} found, so nothing was created. Fix the file and choose it again.</Banner>
            <Table head={['Line', 'Problem']}>{result.errors.map((e, i) => <tr key={i}><td className="p-2.5 font-mono text-[12px] w-16">{e.line}</td><td className="p-2.5">{e.message}</td></tr>)}</Table>
            {result.errorCount > result.errors.length && <p className="text-[12px] text-[#6B6B6B]">Showing the first {result.errors.length}.</p>}
          </div>
        )}
        {ready && (
          <div className="space-y-2">
            <Banner kind="ok">The file is good: {result.groups.length} group{result.groups.length === 1 ? '' : 's'} will be created.</Banner>
            <Table head={['Group', 'Site', 'Queues']} right={[2]}>{result.groups.map((g) => <tr key={g.name}><td className="p-2.5 font-medium">{g.name}</td><td className="p-2.5">{g.site ?? <Pill>No site</Pill>}</td><td className="p-2.5 text-right">{g.queues}</td></tr>)}</Table>
          </div>
        )}
        <div className="flex gap-2">
          {ready && <Btn variant="primary" disabled={busy} onClick={() => check(csv, false)}>Create {result!.groups.length} group{result!.groups.length === 1 ? '' : 's'}</Btn>}
          <Btn onClick={onCancel}>{result?.committed ? 'Close' : 'Cancel'}</Btn>
        </div>
      </div>
    </Card>
  );
};
