/**
 * Configuration › Activity Definitions. One company-wide list says what each kind of time is (queue work or not, paid or not,
 * counts as shrinkage or not, left out of adherence or not). Each WFM group can then switch an activity off or change its
 * shrinkage / paid treatment for itself, the way the market WFM products let a business unit tailor a shared list.
 * No activities are pre-loaded; "Add a standard set" is an opt-in shortcut.
 */
import { LoadFailed, Waiting } from '../common/loading';
import React, { useMemo, useState } from 'react';
import { ColDef, ICellRendererParams } from 'ag-grid-community';
import { Plus } from 'lucide-react';
import { Activity, ACTIVITY_CATEGORY_LABEL, api, fetchWorkspaces, getStoredSession, GroupActivity, Workspace } from '../../services/api';
import { useForecast } from '../../services/forecastStore';
import { useApi } from '../forecasting/hooks';
import { Grid } from '../forecasting/Grid';
import { Popover } from '../common/Popover';
import { downloadCsv, printPage } from './previewExport';
import { Banner, Btn, Card, Empty, Field, Input, Pill, Select } from '../forecasting/ui';

type Form = Omit<Activity, 'id' | 'version'> & { id: string | null };
const blank = (): Form => ({ id: null, name: '', code: '', shortCode: '', category: 'OTHER', countsAsWork: false, paid: true, shrinkage: true, ignoreAdherence: false, color: '#8AA4C8', textColor: null, status: 'ACTIVE' });

const STANDARD: Omit<Activity, 'id' | 'version'>[] = [
  { name: 'Queue work', code: 'WORK', shortCode: 'W', category: 'WORK', countsAsWork: true, paid: true, shrinkage: false, ignoreAdherence: false, color: '#DCEBFA', textColor: null, status: 'ACTIVE' },
  { name: 'Paid break', code: 'BREAK', shortCode: 'BK', category: 'BREAK', countsAsWork: false, paid: true, shrinkage: true, ignoreAdherence: false, color: '#F5E7C8', textColor: null, status: 'ACTIVE' },
  { name: 'Meal', code: 'MEAL', shortCode: 'ML', category: 'MEAL', countsAsWork: false, paid: false, shrinkage: false, ignoreAdherence: false, color: '#EADCF5', textColor: null, status: 'ACTIVE' },
  { name: 'Training', code: 'TRAINING', shortCode: 'TR', category: 'TRAINING', countsAsWork: false, paid: true, shrinkage: true, ignoreAdherence: false, color: '#DDF0E4', textColor: null, status: 'ACTIVE' },
  { name: 'Coaching', code: 'COACHING', shortCode: 'CO', category: 'COACHING', countsAsWork: false, paid: true, shrinkage: true, ignoreAdherence: false, color: '#F8DDDD', textColor: null, status: 'ACTIVE' },
  { name: 'Team meeting', code: 'MEETING', shortCode: 'TM', category: 'MEETING', countsAsWork: false, paid: true, shrinkage: true, ignoreAdherence: false, color: '#E4E4F5', textColor: null, status: 'ACTIVE' },
];

type Tri = 'company' | 'yes' | 'no';
type Override = { activity: GroupActivity; enabled: boolean; shrinkage: Tri; paid: Tri };
const tri = (v: boolean | null): Tri => (v === null ? 'company' : v ? 'yes' : 'no');
const untri = (t: Tri): boolean | null => (t === 'company' ? null : t === 'yes');

/** Picks readable text colour for a background when an activity leaves it on Auto. */
const textFor = (bg: string) => {
  const h = bg.replace('#', '');
  const r = parseInt(h.slice(0, 2), 16), g = parseInt(h.slice(2, 4), 16), b = parseInt(h.slice(4, 6), 16);
  return (r * 299 + g * 587 + b * 114) / 1000 >= 150 ? '#171717' : '#FFFFFF';
};
const swatch = (a: Activity) => <span style={{ backgroundColor: a.color, color: a.textColor ?? textFor(a.color) }} className="px-2 py-0.5 rounded text-[11px] font-bold font-mono border border-black/10">{a.shortCode}</span>;

type CopyItem = { code: string; name: string; state: 'NEW' | 'SAME' | 'DIFFERS' | 'NAME_TAKEN'; action: 'CREATE' | 'UPDATE' | 'SKIP'; changes: string[] };
type CopyResult = { dryRun: boolean; target: { id: string; name: string }; items: CopyItem[]; summary: string; rtaRows: number };
const STATE_TEXT: Record<CopyItem['state'], string> = { NEW: 'Not there yet', SAME: 'Already the same', DIFFERS: 'Exists, but different', NAME_TAKEN: 'Name already used by another activity' };
const ACTION_TEXT: Record<CopyItem['action'], string> = { CREATE: 'Will be created', UPDATE: 'Will be overwritten', SKIP: 'Left alone' };

const PLAN_HEAD = ['Activity', 'Code', 'In the target today', 'Settings that differ', 'What will happen'];
const planRows = (items: CopyItem[]) => items.map((i) => [i.name, i.code, STATE_TEXT[i.state], i.changes.join(', '), ACTION_TEXT[i.action]]);

/** What would happen to each activity, from a preview of a copy or an import. Can be taken out as a CSV or a printable page (save it as PDF) so someone else can review it before it is applied. */
const PlanTable: React.FC<{ items: CopyItem[]; where: string; title: string; lines: string[]; fileBase: string }> = ({ items, where, title, lines, fileBase }) => {
  const { setNotice } = useForecast();
  const day = new Date().toISOString().slice(0, 10);
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-end gap-3 text-[12px] print:hidden">
        <span className="text-[#6B6B6B]">Take this list out:</span>
        <button type="button" className="underline" onClick={() => downloadCsv(`${fileBase}-${day}.csv`, PLAN_HEAD, planRows(items))}>CSV</button>
        <button type="button" className="underline" onClick={() => { if (!printPage(title, [...lines, `Prepared ${day}. Nothing has been changed yet.`], PLAN_HEAD, planRows(items))) setNotice({ kind: 'err', text: 'The browser blocked the new tab. Allow pop-ups for this site and try again.' }); }}>PDF (print)</button>
      </div>
      <div className="border border-[#E5E5E0] rounded-lg overflow-hidden"><table className="w-full text-[13px]"><thead className="bg-[#FAFAF8] text-[11px] uppercase tracking-wider text-[#6B6B6B]"><tr><th className="text-left p-2">Activity</th><th className="text-left p-2">{where}</th><th className="text-left p-2">What will happen</th></tr></thead>
        <tbody>{items.map((i) => (
          <tr key={i.code} className="border-t border-[#F0F0EC]"><td className="p-2 font-semibold">{i.name}</td>
            <td className="p-2 text-[#525252]">{STATE_TEXT[i.state]}{i.changes.length ? ` (${i.changes.join(', ')})` : ''}</td>
            <td className="p-2"><Pill tone={i.action === 'SKIP' ? 'neutral' : 'good'}>{ACTION_TEXT[i.action]}</Pill></td></tr>
        ))}</tbody></table></div>
    </div>
  );
};

type ImportResult = CopyResult & { file: { exportedAt: string | null; workspace: string | null; activities: number; rtaRows: number } };

/** Move activity definitions between environments (test to production, one customer's setup to another) as a file: export here, import there, with the same preview as a copy. */
const ConfigFile: React.FC<{ activities: Activity[]; onClose: () => void; onDone: () => void }> = ({ activities, onClose, onDone }) => {
  const { setNotice } = useForecast();
  const [withRta, setWithRta] = useState(true);
  const [onExisting, setOnExisting] = useState<'SKIP' | 'OVERWRITE'>('SKIP');
  const [pack, setPack] = useState<unknown>(null);
  const [fileName, setFileName] = useState('');
  const [preview, setPreview] = useState<ImportResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const run = (dryRun: boolean, p: unknown = pack, existing = onExisting, rta = withRta) => api<ImportResult>('/config/activities/import', { method: 'POST', body: { pack: p, dryRun, onExisting: existing, includeRtaMapping: rta } });

  const download = async () => {
    setBusy(true); setError('');
    try {
      const out = await api<{ exportedAt: string; source?: { workspace?: string } }>('/config/activities/export', { method: 'POST', body: { includeRtaMapping: withRta } });
      const url = URL.createObjectURL(new Blob([JSON.stringify(out, null, 2)], { type: 'application/json' }));
      const a = document.createElement('a'); a.href = url; a.download = `agnowfm-activities-${(out.source?.workspace ?? 'workspace').replace(/[^A-Za-z0-9]+/g, '-').toLowerCase()}-${out.exportedAt.slice(0, 10)}.json`; a.click(); URL.revokeObjectURL(url);
      setNotice({ kind: 'ok', text: `Exported ${activities.length} activit${activities.length === 1 ? 'y' : 'ies'}${withRta ? ' with their phone-state mapping' : ''}.` });
    } catch (e: any) { setError(e.message); } finally { setBusy(false); }
  };
  const choose = async (f: File | undefined) => {
    if (!f) return;
    setBusy(true); setError(''); setPreview(null);
    try {
      let parsed: unknown;
      try { parsed = JSON.parse(await f.text()); } catch { throw new Error('That file is not a configuration file: it is not valid JSON.'); }
      setPack(parsed); setFileName(f.name); setPreview(await run(true, parsed));
    } catch (e: any) { setPack(null); setFileName(''); setError(e.message); } finally { setBusy(false); }
  };
  const recheck = async (existing: 'SKIP' | 'OVERWRITE', rta: boolean) => { if (!pack) return; setBusy(true); setError(''); try { setPreview(await run(true, pack, existing, rta)); } catch (e: any) { setError(e.message); } finally { setBusy(false); } };
  const go = async () => {
    setBusy(true); setError('');
    try { const r = await run(false); setNotice({ kind: 'ok', text: `Imported into ${r.target.name}: ${r.summary}${withRta ? `. ${r.rtaRows} phone-state mapping row${r.rtaRows === 1 ? '' : 's'} added` : ''}.` }); onDone(); onClose(); }
    catch (e: any) { setError(e.message); } finally { setBusy(false); }
  };
  const willChange = preview ? preview.items.filter((i) => i.action !== 'SKIP').length : 0;
  return (
    <div className="border border-[#E5E5E0] rounded-lg p-4 space-y-4">
      <div className="text-[13px]">Move activity definitions to another environment as a file. Export here, then import the file there. Nothing changes on import until you confirm.</div>
      <label className="flex items-center gap-2 text-[13px]"><input type="checkbox" checked={withRta} onChange={(e) => { setWithRta(e.target.checked); recheck(onExisting, e.target.checked); }} />Include the phone-state mapping (RTA) rows that point at the activities</label>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div className="border border-[#E5E5E0] rounded-lg p-3 space-y-2">
          <div className="text-[12px] font-semibold">Export</div>
          <p className="text-[12px] text-[#6B6B6B]">All {activities.length} activities in this workspace, as one file.</p>
          <Btn disabled={busy || activities.length === 0} onClick={download}>Download file</Btn>
        </div>
        <div className="border border-[#E5E5E0] rounded-lg p-3 space-y-2">
          <div className="text-[12px] font-semibold">Import</div>
          <p className="text-[12px] text-[#6B6B6B]">Into this workspace. Activities are matched by code, so importing twice never makes duplicates.</p>
          <input type="file" accept=".json,application/json" aria-label="Configuration file" disabled={busy} onChange={(e) => { choose(e.target.files?.[0]); e.target.value = ''; }} className="text-[12px]" />
          {fileName && <div className="text-[12px] text-[#6B6B6B]">{fileName}</div>}
        </div>
      </div>
      {preview && (
        <div className="space-y-2">
          <Field label="If an activity is already here but different"><Select value={onExisting} onChange={(e) => { const v = e.target.value as 'SKIP' | 'OVERWRITE'; setOnExisting(v); recheck(v, withRta); }} aria-label="If it exists">
            <option value="SKIP">Leave it as it is (safe)</option><option value="OVERWRITE">Overwrite it with the file’s settings</option></Select></Field>
          <Banner kind={willChange ? 'ok' : 'warn'}>File{preview.file.workspace ? ` from ${preview.file.workspace}` : ''}{preview.file.exportedAt ? ` (${preview.file.exportedAt.slice(0, 10)})` : ''} into <b>{preview.target.name}</b>: {preview.summary}.{withRta ? ` ${preview.rtaRows} phone-state mapping row${preview.rtaRows === 1 ? '' : 's'} in the file (rows already here are kept).` : ''}</Banner>
          <PlanTable items={preview.items} where="Here today" title={`Import preview: activity definitions into ${preview.target.name}`} lines={[`From file${preview.file.workspace ? ` of workspace ${preview.file.workspace}` : ''}${preview.file.exportedAt ? ` exported ${preview.file.exportedAt.slice(0, 10)}` : ''}`, preview.summary]} fileBase="activity-import-preview" />
        </div>
      )}
      {error && <Banner kind="err">{error}</Banner>}
      <div className="flex gap-2 sticky bottom-0 bg-white border-t border-[#F0F0EC] pt-3 -mb-1">
        {preview && <Btn variant="primary" disabled={busy || (willChange === 0 && !(withRta && preview.rtaRows > 0))} onClick={go}>Import now</Btn>}
        <Btn onClick={onClose}>Close</Btn>
      </div>
    </div>
  );
};

/** Copy chosen activities into another workspace: choose them, choose where, see exactly what would happen, then confirm. Matched by code, so doing it twice never duplicates. */
const CopyToWorkspace: React.FC<{ activities: Activity[]; onClose: () => void }> = ({ activities, onClose }) => {
  const { setNotice } = useForecast();
  const here = getStoredSession()?.user?.workspaceId;
  const spaces = useApi<Workspace[]>('/workspaces', []);
  const targets = (spaces.data ?? []).filter((x) => x.status === 'ACTIVE' && x.id !== here);
  const [picked, setPicked] = useState<Set<string>>(new Set(activities.filter((a) => a.status === 'ACTIVE').map((a) => a.id)));
  const [target, setTarget] = useState('');
  const [onExisting, setOnExisting] = useState<'SKIP' | 'OVERWRITE'>('SKIP');
  const [withRta, setWithRta] = useState(false);
  const [preview, setPreview] = useState<CopyResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const body = (dryRun: boolean) => ({ targetWorkspaceId: target, activityIds: [...picked], onExisting, includeRtaMapping: withRta, dryRun });
  const change = (fn: () => void) => { fn(); setPreview(null); };       // any change to the choices means the preview no longer applies
  const check = async () => { setBusy(true); setError(''); try { setPreview(await api<CopyResult>('/config/activities/copy-to', { method: 'POST', body: body(true) })); } catch (e: any) { setError(e.message); } finally { setBusy(false); } };
  const go = async () => {
    setBusy(true); setError('');
    try { const r = await api<CopyResult>('/config/activities/copy-to', { method: 'POST', body: body(false) }); setNotice({ kind: 'ok', text: `Copied to ${r.target.name}: ${r.summary}${withRta ? `. ${r.rtaRows} phone-state mapping row${r.rtaRows === 1 ? '' : 's'} added` : ''}.` }); onClose(); }
    catch (e: any) { setError(e.message); } finally { setBusy(false); }
  };
  const willChange = preview ? preview.items.filter((i) => i.action !== 'SKIP').length : 0;
  return (
    <div className="border border-[#E5E5E0] rounded-lg p-4 space-y-4">
      <div className="text-[13px]">Copy activity definitions into another workspace. Nothing changes until you confirm, and activities are matched by their code, so copying twice never makes duplicates.</div>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <Field label="Copy into"><Select value={target} onChange={(e) => change(() => setTarget(e.target.value))} aria-label="Target workspace">
          <option value="">Choose a workspace…</option>{targets.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
        </Select></Field>
        <Field label="If an activity is already there but different">
          <Select value={onExisting} onChange={(e) => change(() => setOnExisting(e.target.value as 'SKIP' | 'OVERWRITE'))} aria-label="If it exists">
            <option value="SKIP">Leave it as it is (safe)</option><option value="OVERWRITE">Overwrite it with this workspace’s settings</option>
          </Select></Field>
      </div>
      <div>
        <div className="flex items-center justify-between"><div className="text-[12px] font-semibold mb-1.5">Which activities ({picked.size} of {activities.length})</div>
          <span className="text-[12px]"><button type="button" className="underline mr-3" onClick={() => change(() => setPicked(new Set(activities.map((a) => a.id))))}>All</button><button type="button" className="underline" onClick={() => change(() => setPicked(new Set()))}>None</button></span></div>
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-x-4 gap-y-1.5 max-h-48 overflow-auto text-[13px]">
          {activities.map((a) => (
            <label key={a.id} className="flex items-center gap-2"><input type="checkbox" checked={picked.has(a.id)} onChange={(e) => change(() => setPicked((s) => { const n = new Set(s); if (e.target.checked) n.add(a.id); else n.delete(a.id); return n; }))} />
              {swatch(a)}<span className="truncate">{a.name}</span>{a.status !== 'ACTIVE' && <span className="text-[11px] text-[#6B6B6B]">inactive</span>}</label>
          ))}
        </div>
      </div>
      <label className="flex items-center gap-2 text-[13px]"><input type="checkbox" checked={withRta} onChange={(e) => change(() => setWithRta(e.target.checked))} />Also copy the phone-state mapping (RTA) rows that point at these activities</label>
      {preview && (
        <div className="space-y-2">
          <Banner kind={willChange ? 'ok' : 'warn'}>Into <b>{preview.target.name}</b>: {preview.summary}.{withRta ? ` ${preview.rtaRows} phone-state mapping row${preview.rtaRows === 1 ? '' : 's'} considered (rows already there are kept).` : ''}</Banner>
          <PlanTable items={preview.items} where="In the other workspace" title={`Copy preview: activity definitions into ${preview.target.name}`} lines={[preview.summary]} fileBase="activity-copy-preview" />
        </div>
      )}
      {error && <Banner kind="err">{error}</Banner>}
      <div className="flex gap-2 sticky bottom-0 bg-white border-t border-[#F0F0EC] pt-3 -mb-1">
        <Btn disabled={busy || !target || picked.size === 0} onClick={check}>{preview ? 'Check again' : 'See what would happen'}</Btn>
        <Btn variant="primary" disabled={busy || !preview || willChange === 0 && !(withRta && preview.rtaRows > 0)} onClick={go}>Copy now</Btn>
        <Btn onClick={onClose}>Cancel</Btn>
      </div>
    </div>
  );
};

export const ActivitiesPanel: React.FC = () => {
  const { can, setNotice, groups } = useForecast();
  const [scope, setScope] = useState('');            // '' = the company list, otherwise a WFM group id
  const [tick, setTick] = useState(0);
  const list = useApi<Activity[]>('/config/activities', [tick]);
  const perGroup = useApi<GroupActivity[]>(scope ? `/config/groups/${scope}/activities` : null, [tick, scope]);
  const [f, setF] = useState<Form | null>(null);
  const [copying, setCopying] = useState(false);
  const [filing, setFiling] = useState(false);
  const [o, setO] = useState<Override | null>(null);
  const [error, setError] = useState('');
  const w = can('config:write');
  const reload = () => setTick((t) => t + 1);
  const groupName = groups.find((g) => g.id === scope)?.name;

  const save = async () => {
    if (!f) return; setError('');
    // code has no input field -- there's nothing for the admin to have typed, so it's always '' here. The backend
    // derives one from the name when the field is left out of the body entirely, but an explicit '' still fails
    // its own min-length check rather than being treated as "not provided," so it has to be dropped, not sent blank.
    const { id, code, ...body } = f;
    try { if (id) await api(`/config/activities/${id}`, { method: 'PUT', body }); else await api('/config/activities', { method: 'POST', body }); setF(null); reload(); }
    catch (e: any) { setError(e.message); }
  };
  const del = async (a: Activity) => {
    if (!confirm(`Delete “${a.name}” for every group?`)) return;
    try { await api(`/config/activities/${a.id}`, { method: 'DELETE' }); reload(); } catch (e: any) { setNotice({ kind: 'err', text: e.message }); }
  };
  // AG Grid's default boolean cell is just a checkbox *icon* unless the column is made editable -- these two
  // (unlike "Adherence", below, where checked would read backwards against the column's own label) are safe to
  // make real, click-to-toggle checkboxes.
  const toggleField = async (a: Activity, field: 'countsAsWork' | 'shrinkage', value: boolean) => {
    try { await api(`/config/activities/${a.id}`, { method: 'PUT', body: { [field]: value } }); reload(); }
    catch (e: any) { setNotice({ kind: 'err', text: e.message }); }
  };
  const addStandard = async () => {
    const have = new Set((list.data ?? []).map((a) => a.name.toLowerCase()));
    try { for (const a of STANDARD) if (!have.has(a.name.toLowerCase())) await api('/config/activities', { method: 'POST', body: a }); reload(); }
    catch (e: any) { setNotice({ kind: 'err', text: e.message }); }
  };
  const edit = (a: Activity) => { setError(''); setO(null); setF({ id: a.id, name: a.name, code: a.code, shortCode: a.shortCode, category: a.category, countsAsWork: a.countsAsWork, paid: a.paid, shrinkage: a.shrinkage, ignoreAdherence: a.ignoreAdherence, color: a.color, textColor: a.textColor, status: a.status }); };
  const saveOverride = async () => {
    if (!o) return; setError('');
    try { await api(`/config/groups/${scope}/activities/${o.activity.id}`, { method: 'PUT', body: { enabled: o.enabled, shrinkage: untri(o.shrinkage), paid: untri(o.paid) } }); setO(null); reload(); }
    catch (e: any) { setError(e.message); }
  };
  const reset = async (a: GroupActivity) => {
    try { await api(`/config/groups/${scope}/activities/${a.id}`, { method: 'DELETE' }); reload(); } catch (e: any) { setNotice({ kind: 'err', text: e.message }); }
  };

  const companyCols = useMemo<ColDef<Activity>[]>(() => [
    { headerName: 'Activity', field: 'name', flex: 1.4, minWidth: 180, cellRenderer: (p: ICellRendererParams<Activity>) => p.data && <div className="leading-tight py-1"><div className="font-semibold">{p.data.name}</div><div className="text-[11px] font-mono text-[#6B6B6B]">{p.data.code}</div></div> },
    { headerName: 'Type', field: 'category', width: 130, valueFormatter: (p) => ACTIVITY_CATEGORY_LABEL[p.value as Activity['category']] },
    { headerName: 'Label', field: 'shortCode', width: 100, cellRenderer: (p: ICellRendererParams<Activity>) => p.data && swatch(p.data) },
    { headerName: 'Queue work', field: 'countsAsWork', width: 150, editable: w, cellRenderer: 'agCheckboxCellRenderer', cellEditor: 'agCheckboxCellEditor',
      onCellValueChanged: (e) => e.data && toggleField(e.data, 'countsAsWork', !!e.newValue) },
    { headerName: 'Shrinkage', field: 'shrinkage', width: 150, editable: w, cellRenderer: 'agCheckboxCellRenderer', cellEditor: 'agCheckboxCellEditor',
      onCellValueChanged: (e) => e.data && toggleField(e.data, 'shrinkage', !!e.newValue) },
    { headerName: 'Adherence', field: 'ignoreAdherence', width: 130, cellRenderer: (p: ICellRendererParams<Activity>) => p.data && <Pill tone={p.data.ignoreAdherence ? 'neutral' : 'good'}>{p.data.ignoreAdherence ? 'Ignored' : 'Tracked'}</Pill> },
    { headerName: 'Paid', field: 'paid', width: 100, cellRenderer: (p: ICellRendererParams<Activity>) => p.data && <Pill tone={p.data.paid ? 'good' : 'neutral'}>{p.data.paid ? 'Paid' : 'Unpaid'}</Pill> },
    { headerName: 'Status', field: 'status', width: 110, valueFormatter: (p) => (p.value === 'ACTIVE' ? 'Active' : 'Inactive') },
    ...(w ? [{ headerName: '', width: 120, sortable: false, filter: false, cellRenderer: (p: ICellRendererParams<Activity>) => p.data && <span className="whitespace-nowrap"><button className="text-[12px] underline mr-3" onClick={() => edit(p.data!)}>Edit</button><button className="text-[12px] text-[#6B6B6B] hover:text-[#BC3F3F]" onClick={() => del(p.data!)}>Delete</button></span> } as ColDef<Activity>] : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
  ], [w, list.data]);

  const groupCols = useMemo<ColDef<GroupActivity>[]>(() => [
    { headerName: 'Activity', field: 'name', flex: 1.4, minWidth: 180, cellRenderer: (p: ICellRendererParams<GroupActivity>) => p.data && <div className="leading-tight py-1"><div className="font-semibold">{p.data.name}</div><div className="text-[11px] font-mono text-[#6B6B6B]">{p.data.code}</div></div> },
    { headerName: 'Label', field: 'shortCode', width: 100, cellRenderer: (p: ICellRendererParams<GroupActivity>) => p.data && swatch(p.data) },
    { headerName: 'Used here', field: 'enabled', width: 130, cellRenderer: (p: ICellRendererParams<GroupActivity>) => p.data && <Pill tone={p.data.enabled ? 'good' : 'neutral'}>{p.data.enabled ? 'Yes' : 'Switched off'}</Pill> },
    { headerName: 'Shrinkage', field: 'shrinkage', width: 140, valueFormatter: (p) => (p.value ? 'Counts' : 'No') },
    { headerName: 'Paid', field: 'paid', width: 110, valueFormatter: (p) => (p.value ? 'Paid' : 'Unpaid') },
    { headerName: 'Setting', field: 'overridden', width: 140, cellRenderer: (p: ICellRendererParams<GroupActivity>) => p.data && <Pill tone={p.data.overridden ? 'warn' : 'neutral'}>{p.data.overridden ? 'This group only' : 'Company'}</Pill> },
    ...(w ? [{ headerName: '', width: 130, sortable: false, filter: false, cellRenderer: (p: ICellRendererParams<GroupActivity>) => p.data && <span className="whitespace-nowrap"><button className="text-[12px] underline mr-3" onClick={() => { setError(''); setF(null); setO({ activity: p.data!, enabled: p.data!.enabled, shrinkage: p.data!.overridden && p.data!.shrinkage !== p.data!.companyShrinkage ? (p.data!.shrinkage ? 'yes' : 'no') : 'company', paid: p.data!.overridden && p.data!.paid !== p.data!.companyPaid ? (p.data!.paid ? 'yes' : 'no') : 'company' }); }}>Change</button>{p.data.overridden && <button className="text-[12px] text-[#6B6B6B] hover:text-[#171717]" onClick={() => reset(p.data!)}>Reset</button>}</span> } as ColDef<GroupActivity>] : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
  ], [w, scope]);

  const set = <K extends keyof Form>(k: K, v: Form[K]) => setF((s) => s && { ...s, [k]: v });
  const yn = (k: 'countsAsWork' | 'paid' | 'shrinkage' | 'ignoreAdherence') => (e: React.ChangeEvent<HTMLSelectElement>) => set(k, e.target.value === 'yes');
  const empty = list.data !== null && list.data.length === 0;

  return (
    <Card title="Activity definitions" sub="One company list says what each kind of time means. Pick a WFM group to switch an activity off for it, or change how shrinkage and pay treat it in that group."
      actions={<div className="flex flex-wrap items-center justify-end gap-2">
        <Select value={scope} onChange={(e) => { setScope(e.target.value); setF(null); setO(null); }} aria-label="Show settings for" className="!w-auto min-w-[14rem]">
          <option value="">Company list (all groups)</option>
          {groups.map((g) => <option key={g.id} value={g.id}>Settings for: {g.name}</option>)}
        </Select>
        {w && !scope && <>
          {empty && <Btn onClick={addStandard}>Add a standard set</Btn>}
          <Popover label="More" align="right" width={250}>
            {(close) => (
              <div className="flex flex-col gap-1 text-[13px]">
                {!empty && <button type="button" className="text-left rounded px-2 py-1.5 hover:bg-[#FAFAF8]" onClick={() => { close(); setF(null); setO(null); setFiling(false); setCopying(true); }}>Copy to another workspace…</button>}
                <button type="button" className="text-left rounded px-2 py-1.5 hover:bg-[#FAFAF8]" onClick={() => { close(); setF(null); setO(null); setCopying(false); setFiling(true); }}>Export / import file…</button>
              </div>
            )}
          </Popover>
          <Btn variant="primary" onClick={() => { setError(''); setO(null); setCopying(false); setFiling(false); setF(blank()); }}><Plus className="w-3.5 h-3.5" />Add activity</Btn>
        </>}
      </div>}>
      {copying && !scope && !!list.data?.length && <CopyToWorkspace activities={list.data} onClose={() => setCopying(false)} />}
      {filing && !scope && <ConfigFile activities={list.data ?? []} onClose={() => setFiling(false)} onDone={reload} />}
      {f && !scope && (
        <div className="border border-[#E5E5E0] rounded-lg p-4 space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-4">
            <div className="md:col-span-2"><Field label="Name"><Input value={f.name} onChange={(e) => set('name', e.target.value)} placeholder="e.g. Team meeting" /></Field></div>
            <Field label="Type" hint="Schedules match on this: a break state only fits a scheduled break"><Select value={f.category} onChange={(e) => set('category', e.target.value as Activity['category'])}>{Object.entries(ACTIVITY_CATEGORY_LABEL).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</Select></Field>
            <Field label="Short label" hint="Up to 4 characters, shown on the schedule"><Input maxLength={4} value={f.shortCode} onChange={(e) => set('shortCode', e.target.value.toUpperCase())} /></Field>
            <Field label="Counts as queue work?"><Select value={f.countsAsWork ? 'yes' : 'no'} onChange={yn('countsAsWork')}><option value="no">No, the person is off the queue</option><option value="yes">Yes, they are available for contacts</option></Select></Field>
            <Field label="Counts as shrinkage?"><Select value={f.shrinkage ? 'yes' : 'no'} onChange={yn('shrinkage')}><option value="yes">Yes, it reduces available time</option><option value="no">No</option></Select></Field>
            <Field label="Paid?"><Select value={f.paid ? 'yes' : 'no'} onChange={yn('paid')}><option value="yes">Paid</option><option value="no">Unpaid</option></Select></Field>
            <Field label="Real-time adherence" hint="Ignored time is never counted as out of adherence"><Select value={f.ignoreAdherence ? 'yes' : 'no'} onChange={yn('ignoreAdherence')}><option value="no">Track it</option><option value="yes">Ignore it</option></Select></Field>
            <Field label="Colour"><Input type="color" value={f.color} onChange={(e) => set('color', e.target.value)} className="h-9 p-1" /></Field>
            <Field label="Text colour" hint="Auto picks black or white for contrast against the colour above">
              <div className="flex items-center gap-2">
                <label className="flex items-center gap-1.5 text-[12px] text-[#171717]"><input type="checkbox" checked={f.textColor === null} onChange={(e) => set('textColor', e.target.checked ? null : textFor(f.color))} />Auto</label>
                {f.textColor !== null && <Input type="color" value={f.textColor} onChange={(e) => set('textColor', e.target.value)} className="h-9 p-1" />}
              </div>
            </Field>
            <Field label="Status"><Select value={f.status} onChange={(e) => set('status', e.target.value as Form['status'])}><option value="ACTIVE">Active</option><option value="INACTIVE">Inactive</option></Select></Field>
          </div>
          {error && <Banner kind="err">{error}</Banner>}
          <div className="flex gap-2"><Btn variant="primary" disabled={!f.name.trim()} onClick={save}>Save activity</Btn><Btn onClick={() => setF(null)}>Cancel</Btn></div>
        </div>
      )}
      {o && scope && (
        <div className="border border-[#E5E5E0] rounded-lg p-4 space-y-4">
          <div className="text-[13px]"><b>{o.activity.name}</b> in <b>{groupName}</b>. Anything left on “Company setting” follows the company list.</div>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <Field label="Used in this group?"><Select value={o.enabled ? 'yes' : 'no'} onChange={(e) => setO({ ...o, enabled: e.target.value === 'yes' })}><option value="yes">Yes</option><option value="no">No, switch it off here</option></Select></Field>
            <Field label="Counts as shrinkage?"><Select value={o.shrinkage} onChange={(e) => setO({ ...o, shrinkage: e.target.value as Tri })}><option value="company">Company setting ({o.activity.companyShrinkage ? 'counts' : 'no'})</option><option value="yes">Counts</option><option value="no">Does not count</option></Select></Field>
            <Field label="Paid?"><Select value={o.paid} onChange={(e) => setO({ ...o, paid: e.target.value as Tri })}><option value="company">Company setting ({o.activity.companyPaid ? 'paid' : 'unpaid'})</option><option value="yes">Paid</option><option value="no">Unpaid</option></Select></Field>
          </div>
          {error && <Banner kind="err">{error}</Banner>}
          <div className="flex gap-2"><Btn variant="primary" onClick={saveOverride}>Save for {groupName}</Btn><Btn onClick={() => setO(null)}>Cancel</Btn></div>
        </div>
      )}
      {(list.error || perGroup.error) && <Banner kind="err">{list.error || perGroup.error}</Banner>}
      {list.data === null && !f
        ? (list.error ? <LoadFailed what="the activities" error={list.error} reload={list.reload} /> : <Waiting what="the activities" shape="table" reload={list.reload} />)
        : empty && !f
        ? <Empty title="No activities yet">{w ? 'Add the kinds of time you schedule (breaks, meals, training, coaching), or start from a standard set. Then choose a group above to tailor the list for it.' : 'Ask an administrator to define them.'}</Empty>
        : scope
          ? <Grid<GroupActivity> rowData={perGroup.data ?? []} columnDefs={groupCols} defaultColDef={{ sortable: true, resizable: true, filter: true }} loading={perGroup.loading} rowHeight={48} height={Math.min(460, 90 + (perGroup.data?.length ?? 1) * 48)} />
          : !!list.data?.length && <Grid<Activity> rowData={list.data} columnDefs={companyCols} defaultColDef={{ sortable: true, resizable: true, filter: true }} loading={list.loading} rowHeight={48} height={Math.min(460, 90 + list.data.length * 48)} />}
    </Card>
  );
};
