/**
 * Configuration › Activity Definitions. One company-wide list says what each kind of time is (queue work or not, paid or not,
 * counts as shrinkage or not, left out of adherence or not). Each WFM group can then switch an activity off or change its
 * shrinkage / paid treatment for itself, the way the market WFM products let a business unit tailor a shared list.
 * No activities are pre-loaded; "Add a standard set" is an opt-in shortcut.
 */
import React, { useMemo, useState } from 'react';
import { ColDef, ICellRendererParams } from 'ag-grid-community';
import { Plus } from 'lucide-react';
import { Activity, ACTIVITY_CATEGORY_LABEL, api, GroupActivity } from '../../services/api';
import { useForecast } from '../../services/forecastStore';
import { useApi } from '../forecasting/hooks';
import { Grid } from '../forecasting/Grid';
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

export const ActivitiesPanel: React.FC = () => {
  const { can, setNotice, groups } = useForecast();
  const [scope, setScope] = useState('');            // '' = the company list, otherwise a WFM group id
  const [tick, setTick] = useState(0);
  const list = useApi<Activity[]>('/config/activities', [tick]);
  const perGroup = useApi<GroupActivity[]>(scope ? `/config/groups/${scope}/activities` : null, [tick, scope]);
  const [f, setF] = useState<Form | null>(null);
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
    { headerName: 'Activity', field: 'name', flex: 1.4, minWidth: 180, cellRenderer: (p: ICellRendererParams<Activity>) => p.data && <div className="leading-tight py-1"><div className="font-semibold">{p.data.name}</div><div className="text-[11px] font-mono text-[#737373]">{p.data.code}</div></div> },
    { headerName: 'Type', field: 'category', width: 130, valueFormatter: (p) => ACTIVITY_CATEGORY_LABEL[p.value as Activity['category']] },
    { headerName: 'Label', field: 'shortCode', width: 100, cellRenderer: (p: ICellRendererParams<Activity>) => p.data && swatch(p.data) },
    { headerName: 'Queue work', field: 'countsAsWork', width: 150, editable: w, cellRenderer: 'agCheckboxCellRenderer', cellEditor: 'agCheckboxCellEditor',
      onCellValueChanged: (e) => e.data && toggleField(e.data, 'countsAsWork', !!e.newValue) },
    { headerName: 'Shrinkage', field: 'shrinkage', width: 150, editable: w, cellRenderer: 'agCheckboxCellRenderer', cellEditor: 'agCheckboxCellEditor',
      onCellValueChanged: (e) => e.data && toggleField(e.data, 'shrinkage', !!e.newValue) },
    { headerName: 'Adherence', field: 'ignoreAdherence', width: 130, cellRenderer: (p: ICellRendererParams<Activity>) => p.data && <Pill tone={p.data.ignoreAdherence ? 'neutral' : 'good'}>{p.data.ignoreAdherence ? 'Ignored' : 'Tracked'}</Pill> },
    { headerName: 'Paid', field: 'paid', width: 100, cellRenderer: (p: ICellRendererParams<Activity>) => p.data && <Pill tone={p.data.paid ? 'good' : 'neutral'}>{p.data.paid ? 'Paid' : 'Unpaid'}</Pill> },
    { headerName: 'Status', field: 'status', width: 110, valueFormatter: (p) => (p.value === 'ACTIVE' ? 'Active' : 'Inactive') },
    ...(w ? [{ headerName: '', width: 120, sortable: false, filter: false, cellRenderer: (p: ICellRendererParams<Activity>) => p.data && <span className="whitespace-nowrap"><button className="text-[12px] underline mr-3" onClick={() => edit(p.data!)}>Edit</button><button className="text-[12px] text-[#737373] hover:text-[#C84A4A]" onClick={() => del(p.data!)}>Delete</button></span> } as ColDef<Activity>] : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
  ], [w, list.data]);

  const groupCols = useMemo<ColDef<GroupActivity>[]>(() => [
    { headerName: 'Activity', field: 'name', flex: 1.4, minWidth: 180, cellRenderer: (p: ICellRendererParams<GroupActivity>) => p.data && <div className="leading-tight py-1"><div className="font-semibold">{p.data.name}</div><div className="text-[11px] font-mono text-[#737373]">{p.data.code}</div></div> },
    { headerName: 'Label', field: 'shortCode', width: 100, cellRenderer: (p: ICellRendererParams<GroupActivity>) => p.data && swatch(p.data) },
    { headerName: 'Used here', field: 'enabled', width: 130, cellRenderer: (p: ICellRendererParams<GroupActivity>) => p.data && <Pill tone={p.data.enabled ? 'good' : 'neutral'}>{p.data.enabled ? 'Yes' : 'Switched off'}</Pill> },
    { headerName: 'Shrinkage', field: 'shrinkage', width: 140, valueFormatter: (p) => (p.value ? 'Counts' : 'No') },
    { headerName: 'Paid', field: 'paid', width: 110, valueFormatter: (p) => (p.value ? 'Paid' : 'Unpaid') },
    { headerName: 'Setting', field: 'overridden', width: 140, cellRenderer: (p: ICellRendererParams<GroupActivity>) => p.data && <Pill tone={p.data.overridden ? 'warn' : 'neutral'}>{p.data.overridden ? 'This group only' : 'Company'}</Pill> },
    ...(w ? [{ headerName: '', width: 130, sortable: false, filter: false, cellRenderer: (p: ICellRendererParams<GroupActivity>) => p.data && <span className="whitespace-nowrap"><button className="text-[12px] underline mr-3" onClick={() => { setError(''); setF(null); setO({ activity: p.data!, enabled: p.data!.enabled, shrinkage: p.data!.overridden && p.data!.shrinkage !== p.data!.companyShrinkage ? (p.data!.shrinkage ? 'yes' : 'no') : 'company', paid: p.data!.overridden && p.data!.paid !== p.data!.companyPaid ? (p.data!.paid ? 'yes' : 'no') : 'company' }); }}>Change</button>{p.data.overridden && <button className="text-[12px] text-[#737373] hover:text-[#171717]" onClick={() => reset(p.data!)}>Reset</button>}</span> } as ColDef<GroupActivity>] : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
  ], [w, scope]);

  const set = <K extends keyof Form>(k: K, v: Form[K]) => setF((s) => s && { ...s, [k]: v });
  const yn = (k: 'countsAsWork' | 'paid' | 'shrinkage' | 'ignoreAdherence') => (e: React.ChangeEvent<HTMLSelectElement>) => set(k, e.target.value === 'yes');
  const empty = (list.data?.length ?? 0) === 0;

  return (
    <Card title="Activity definitions" sub="One company list says what each kind of time means. Pick a WFM group to switch an activity off for it, or change how shrinkage and pay treat it in that group."
      actions={<>
        <Select value={scope} onChange={(e) => { setScope(e.target.value); setF(null); setO(null); }} aria-label="Show settings for">
          <option value="">Company list (all groups)</option>
          {groups.map((g) => <option key={g.id} value={g.id}>Settings for: {g.name}</option>)}
        </Select>
        {w && !scope && <>{empty && <Btn onClick={addStandard}>Add a standard set</Btn>}<Btn variant="primary" onClick={() => { setError(''); setO(null); setF(blank()); }}><Plus className="w-3.5 h-3.5" />Add activity</Btn></>}
      </>}>
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
      {empty && !f
        ? <Empty title="No activities yet">{w ? 'Add the kinds of time you schedule (breaks, meals, training, coaching), or start from a standard set. Then choose a group above to tailor the list for it.' : 'Ask an administrator to define them.'}</Empty>
        : scope
          ? <Grid<GroupActivity> rowData={perGroup.data ?? []} columnDefs={groupCols} defaultColDef={{ sortable: true, resizable: true, filter: true }} loading={perGroup.loading} rowHeight={48} height={Math.min(460, 90 + (perGroup.data?.length ?? 1) * 48)} />
          : !!list.data?.length && <Grid<Activity> rowData={list.data} columnDefs={companyCols} defaultColDef={{ sortable: true, resizable: true, filter: true }} loading={list.loading} rowHeight={48} height={Math.min(460, 90 + list.data.length * 48)} />}
    </Card>
  );
};
