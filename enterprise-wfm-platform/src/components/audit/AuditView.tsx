/**
 * Audit log: the append-only record of who changed what, when and why (forecast approvals, schedule edits and publishes, imports,
 * configuration, employee changes). Read straight from the gateway; filters run on the server and the filtered list can be exported.
 */
import React, { useEffect, useMemo, useState } from 'react';
import { ChevronDown, ChevronRight, Download, Search } from 'lucide-react';
import { api, download } from '../../services/api';
import { useForecast } from '../../services/forecastStore';
import { useApi } from '../forecasting/hooks';
import { Banner, Btn, Busy, Card, Empty, Input, Kpi, KpiRow, PageHeader, Pill, Select } from '../forecasting/ui';

type Rec = {
  id: string; actorName: string; actorRole: string; action: string; entityType: string; entityId: string; entityName: string | null; timestamp: string; source: string;
  reason: string | null; beforeSnapshot: any; afterSnapshot: any; diffSummary: string | null; ipAddress: string | null; requestId: string | null;
};
type Summary = { total: number; last24h: number; actors: number; entityTypes: { value: string; count: number }[]; actions: { value: string; count: number }[]; actorNames: { value: string; count: number }[] };

const PAGE = 100;
const ENTITY_LABEL: Record<string, string> = {
  FORECAST_VERSION: 'Forecast', SCHEDULE_VERSION: 'Schedule', SHIFT_TEMPLATE: 'Shift template', EMPLOYEE: 'Employee', IMPORT_JOB: 'Data import', WFM_GROUP: 'WFM group', AUDIT_LOG: 'Audit log',
};
const entityLabel = (t: string) => ENTITY_LABEL[t] ?? (t.charAt(0) + t.slice(1).toLowerCase().replace(/_/g, ' '));
const ACTION_TONE: Record<string, 'good' | 'warn' | 'bad' | 'info' | 'neutral'> = { PUBLISH: 'good', APPROVE: 'good', CREATE: 'info', GENERATE: 'info', IMPORT: 'info', UPDATE: 'neutral', ADJUST: 'warn', SUBMIT: 'neutral', REJECT: 'warn', DELETE: 'bad', ROLLBACK: 'bad', EXPORT: 'neutral', LOGIN: 'neutral' };
const show = (v: unknown) => (v === null || v === undefined ? '–' : typeof v === 'object' ? JSON.stringify(v) : String(v));

/** The fields that differ between the two snapshots; with only one snapshot, its fields. */
function changes(before: any, after: any): { field: string; before: unknown; after: unknown }[] {
  const isObj = (x: any) => x && typeof x === 'object' && !Array.isArray(x);
  const b = isObj(before) ? before : {}, a = isObj(after) ? after : {};
  return [...new Set([...Object.keys(b), ...Object.keys(a)])]
    .filter((k) => JSON.stringify(b[k]) !== JSON.stringify(a[k]))
    .map((k) => ({ field: k, before: b[k], after: a[k] }));
}

const Detail: React.FC<{ r: Rec }> = ({ r }) => {
  const diff = useMemo(() => changes(r.beforeSnapshot, r.afterSnapshot), [r]);
  return (
    <div className="p-4 bg-[#FAFAF8] space-y-3 text-[12px]">
      <div className="grid md:grid-cols-2 xl:grid-cols-4 gap-x-6 gap-y-2">
        <div><div className="text-[#737373]">Reason given</div><div className="text-[#171717]">{r.reason ?? 'None recorded'}</div></div>
        <div><div className="text-[#737373]">What changed</div><div className="text-[#171717]">{r.diffSummary ?? '–'}</div></div>
        <div><div className="text-[#737373]">Record</div><div className="font-mono text-[#171717] break-all">{r.entityId}</div></div>
        <div><div className="text-[#737373]">Source</div><div className="text-[#171717]">{r.source}{r.ipAddress ? ` · ${r.ipAddress}` : ''}{r.requestId ? ` · request ${r.requestId}` : ''}</div></div>
      </div>
      {diff.length > 0 && (
        <div className="overflow-x-auto border border-[#E5E5E0] rounded bg-white">
          <table className="w-full text-left">
            <thead className="text-[11px] uppercase tracking-wider text-[#737373] border-b border-[#E5E5E0]"><tr><th className="p-2">Field</th><th className="p-2">Before</th><th className="p-2">After</th></tr></thead>
            <tbody className="divide-y divide-[#E5E5E0]">
              {diff.map((d) => <tr key={d.field}><td className="p-2 font-mono">{d.field}</td><td className="p-2 font-mono text-[#C84A4A] break-all">{show(d.before)}</td><td className="p-2 font-mono text-[#2F7D5A] break-all">{show(d.after)}</td></tr>)}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
};

export const AuditView: React.FC = () => {
  const { can } = useForecast();
  const [q, setQ] = useState('');
  const [entityType, setEntityType] = useState('');
  const [action, setAction] = useState('');
  const [actor, setActor] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [debounced, setDebounced] = useState('');
  useEffect(() => { const t = setTimeout(() => setDebounced(q), 350); return () => clearTimeout(t); }, [q]);

  const filter = useMemo(() => new URLSearchParams({ ...(debounced ? { q: debounced } : {}), ...(entityType ? { entityType } : {}), ...(action ? { action } : {}), ...(actor ? { actor } : {}), ...(from ? { from } : {}), ...(to ? { to } : {}) }).toString(), [debounced, entityType, action, actor, from, to]);
  const [rows, setRows] = useState<Rec[]>([]);
  const [more, setMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const summary = useApi<Summary>(can('audit:read') ? `/audit/summary?${filter}` : null, [tick]);

  useEffect(() => {
    if (!can('audit:read')) return;
    let live = true;
    setLoading(true); setOpen(null);
    api<Rec[]>(`/audit?${filter}${filter ? '&' : ''}limit=${PAGE}`)
      .then((r) => { if (live) { setRows(r); setMore(r.length === PAGE); setError(''); } })
      .catch((e) => live && setError(e.message))
      .finally(() => live && setLoading(false));
    return () => { live = false; };
  }, [filter, tick]);

  const loadMore = async () => {
    setLoading(true);
    try { const r = await api<Rec[]>(`/audit?${filter}${filter ? '&' : ''}limit=${PAGE}&before=${rows[rows.length - 1].id}`); setRows((x) => [...x, ...r]); setMore(r.length === PAGE); }
    catch (e: any) { setError(e.message); } finally { setLoading(false); }
  };
  const exportCsv = () => download(`/audit/export.csv?${filter}`, 'audit-log.csv').then(() => setTick((t) => t + 1)).catch((e) => setError(e.message));
  const clear = () => { setQ(''); setEntityType(''); setAction(''); setActor(''); setFrom(''); setTo(''); };
  const filtered = !!(q || entityType || action || actor || from || to);

  if (!can('audit:read')) return <div className="flex-1 p-6"><Empty title="You do not have access to the audit log">Ask an administrator for the audit permission.</Empty></div>;

  return (
    <div className="flex-1 flex flex-col h-[calc(100vh-3.5rem)] overflow-y-auto bg-[#FFFFFF] p-6 space-y-6">
      <PageHeader title="Audit Log" badge={<Pill>Append-only</Pill>}
        sub="Every forecast approval, schedule change, publish, import and configuration edit, with who did it, when and the reason they gave. Records cannot be edited or removed."
        actions={<Btn onClick={exportCsv}><Download className="w-3.5 h-3.5" />Export {filtered ? 'filtered ' : ''}log (CSV)</Btn>} />
      {error && <Banner kind="err" onClose={() => setError('')}>{error}</Banner>}

      <KpiRow>
        <Kpi label={filtered ? 'Matching records' : 'Records'} value={summary.data ? summary.data.total.toLocaleString() : '–'} />
        <Kpi label="Last 24 hours" value={summary.data ? summary.data.last24h.toLocaleString() : '–'} sub="All activity, any filter" />
        <Kpi label="People involved" value={summary.data ? summary.data.actors : '–'} sub={filtered ? 'In the matching records' : 'Who has made changes'} />
      </KpiRow>

      <Card>
        <div className="flex flex-wrap items-end gap-3 text-[12px]">
          <div className="relative w-72">
            <Search className="w-3.5 h-3.5 absolute left-2.5 top-3 text-[#737373]" />
            <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search the log…" className="pl-8!" aria-label="Search" />
          </div>
          <label className="space-y-1"><span className="text-[#737373] block">What</span>
            <Select value={entityType} onChange={(e) => setEntityType(e.target.value)} aria-label="Entity"><option value="">Everything</option>{summary.data?.entityTypes.map((t) => <option key={t.value} value={t.value}>{entityLabel(t.value)} ({t.count})</option>)}</Select></label>
          <label className="space-y-1"><span className="text-[#737373] block">Action</span>
            <Select value={action} onChange={(e) => setAction(e.target.value)} aria-label="Action"><option value="">Any action</option>{summary.data?.actions.map((t) => <option key={t.value} value={t.value}>{t.value.charAt(0) + t.value.slice(1).toLowerCase()} ({t.count})</option>)}</Select></label>
          <label className="space-y-1"><span className="text-[#737373] block">Who</span>
            <Select value={actor} onChange={(e) => setActor(e.target.value)} aria-label="Person"><option value="">Anyone</option>{summary.data?.actorNames.map((t) => <option key={t.value} value={t.value}>{t.value} ({t.count})</option>)}</Select></label>
          <label className="space-y-1"><span className="text-[#737373] block">From</span><Input type="date" value={from} max={to || undefined} onChange={(e) => setFrom(e.target.value)} aria-label="From date" /></label>
          <label className="space-y-1"><span className="text-[#737373] block">To</span><Input type="date" value={to} min={from || undefined} onChange={(e) => setTo(e.target.value)} aria-label="To date" /></label>
          {filtered && <Btn onClick={clear}>Clear filters</Btn>}
        </div>
      </Card>

      {loading && !rows.length ? <Busy text="Loading the log…" /> : !rows.length ? (
        <Empty title={filtered ? 'Nothing matches these filters' : 'No activity recorded yet'}>{filtered ? 'Try widening the dates or clearing a filter.' : 'Changes to forecasts, schedules, imports and settings appear here as they happen.'}</Empty>
      ) : (
        <div className="border border-[#E5E5E0] rounded-lg overflow-hidden">
          <table className="w-full text-left text-[13px]">
            <thead className="bg-[#FAFAF8] text-[#737373] text-[11px] uppercase tracking-wider border-b border-[#E5E5E0]">
              <tr><th className="p-3 w-8"></th><th className="p-3">When</th><th className="p-3">Who</th><th className="p-3">Action</th><th className="p-3">What it was done to</th><th className="p-3">Why / what changed</th></tr>
            </thead>
            <tbody className="divide-y divide-[#E5E5E0] text-[#171717]">
              {rows.map((r) => (
                <React.Fragment key={r.id}>
                  <tr onClick={() => setOpen(open === r.id ? null : r.id)} className="cursor-pointer hover:bg-[#FAFAF8] align-top">
                    <td className="p-3 text-[#737373]">{open === r.id ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}</td>
                    <td className="p-3 whitespace-nowrap font-mono text-[12px] text-[#525252]">{new Date(r.timestamp).toLocaleString()}</td>
                    <td className="p-3"><div className="font-semibold">{r.actorName}</div><div className="text-[11px] text-[#737373]">{r.actorRole}</div></td>
                    <td className="p-3"><Pill tone={ACTION_TONE[r.action] ?? 'neutral'}>{r.action}</Pill></td>
                    <td className="p-3"><div>{r.entityName ?? r.entityId}</div><div className="text-[11px] text-[#737373]">{entityLabel(r.entityType)}</div></td>
                    <td className="p-3 text-[12px] text-[#525252] max-w-md">{r.reason ?? r.diffSummary ?? <span className="text-[#A3A3A3]">No reason recorded</span>}</td>
                  </tr>
                  {open === r.id && <tr><td colSpan={6} className="p-0"><Detail r={r} /></td></tr>}
                </React.Fragment>
              ))}
            </tbody>
          </table>
          <div className="p-3 border-t border-[#E5E5E0] bg-[#FAFAF8] flex items-center justify-between text-[12px] text-[#737373]">
            <span>Showing {rows.length.toLocaleString()}{summary.data ? ` of ${summary.data.total.toLocaleString()}` : ''} records, newest first</span>
            {more && <Btn onClick={loadMore} disabled={loading}>{loading ? 'Loading…' : 'Load older records'}</Btn>}
          </div>
        </div>
      )}
    </div>
  );
};
