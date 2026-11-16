/**
 * Configuration › Work Calendar. When the working week starts and which days are the weekend (used by payroll, leave, weekend fairness and rotation analysis),
 * and the holidays the organisation does not work or pays at the holiday rate. The week and weekend are defaults for this workspace; a WFM group can use its own pay week and weekend.
 * Holidays are the "holiday" special events forecasting learns from; a country's public holidays are a starting point to add, not something applied behind anyone's back.
 */
import { Waiting } from '../common/loading';
import React, { useEffect, useMemo, useState } from 'react';
import type { ColDef, ICellRendererParams } from 'ag-grid-community';
import { api } from '../../services/api';
import { useForecast } from '../../services/forecastStore';
import { useApi } from '../forecasting/hooks';
import { Grid } from '../forecasting/Grid';
import { Banner, Btn, Busy, Card, Empty, Field, Input, Pill, Select } from '../forecasting/ui';

type EventRow = { id: string; groupName: string | null; siteId: string | null; siteName: string | null; name: string; kind: string; startDay: string; endDay: string };
type Country = { code: string; name: string };
type SiteLite = { id: string; name: string; country: string; status: string };
type Preview = { name: string; startDay: string; endDay: string; exists: boolean };
const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

const fmt = (d: string) => new Date(`${d}T00:00:00`).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });

export const WorkCalendarPanel: React.FC = () => {
  const { can, session } = useForecast();
  const canWrite = can('config:write');
  const thisYear = new Date().getFullYear();
  const [tick, setTick] = useState(0);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState('');

  // ---------------------------------------------------------------- week and weekend
  const policy = useApi<any>('/config/scheduling-policy', [tick]);
  const [payWeek, setPayWeek] = useState(0);
  const [weekend, setWeekend] = useState<number[]>([5, 6]);
  useEffect(() => {
    if (!policy.data) return;
    setPayWeek(policy.data.scheduling?.payWeekStart ?? 0);
    setWeekend(policy.data.scheduling?.weekendDays ?? [5, 6]);
  }, [policy.data]);
  const weekDirty = !!policy.data && (payWeek !== (policy.data.scheduling?.payWeekStart ?? 0) || weekend.join() !== (policy.data.scheduling?.weekendDays ?? [5, 6]).join());

  const saveWeek = async () => {
    if (!policy.data) return;
    setError(''); setNotice(''); setBusy('week');
    try {
      await api('/config/scheduling-policy', { method: 'PUT', body: { ...policy.data, scheduling: { ...policy.data.scheduling, payWeekStart: payWeek, weekendDays: weekend } } });
      setNotice('Week and weekend saved. Schedules already built keep the week they were built with.');
      setTick((t) => t + 1);
    } catch (e: any) { setError(e.message); } finally { setBusy(''); }
  };

  // ---------------------------------------------------------------- holidays
  const [year, setYear] = useState(thisYear);
  const events = useApi<EventRow[]>('/forecast/events', [tick]);
  const sites = useApi<SiteLite[]>('/config/sites');
  // whose calendar this is: the whole organisation's, or one site's own holidays on top of it
  const [scope, setScope] = useState('');
  const site = sites.data?.find((s) => s.id === scope) ?? null;
  const countries = useApi<Country[]>('/holidays/countries');
  const [country, setCountry] = useState('');
  const [years, setYears] = useState<number[]>([thisYear]);
  const [preview, setPreview] = useState<Preview[] | null>(null);
  const [form, setForm] = useState({ name: '', startDay: '', endDay: '' });
  const [clearing, setClearing] = useState(false);
  const [typed, setTyped] = useState('');

  const rows = useMemo(() => (events.data ?? []).filter((e) => e.kind === 'holiday' && e.startDay.slice(0, 4) === String(year) && (scope ? e.siteId === scope : !e.siteId)).sort((a, b) => a.startDay.localeCompare(b.startDay)), [events.data, year, scope]);
  const alsoApply = scope ? (events.data ?? []).filter((e) => e.kind === 'holiday' && e.startDay.slice(0, 4) === String(year) && !e.siteId && !e.groupName).length : 0;
  // the site's country, when it names one the holiday data knows, is the starting choice for "add a country's public holidays"
  useEffect(() => {
    setPreview(null);
    const c = site?.country.trim().toLowerCase();
    const m = c ? (countries.data ?? []).find((x) => x.name.toLowerCase() === c || x.code.toLowerCase() === c) : undefined;
    setCountry(m?.code ?? '');
  }, [scope, countries.data]);

  const loadPreview = async () => {
    setError(''); setNotice(''); setBusy('preview');
    try {
      const all = await Promise.all(years.map((y) => api<Preview[]>(`/holidays/catalog?country=${country}&year=${y}${scope ? `&siteId=${scope}` : ''}`)));
      setPreview(all.flat());
    } catch (e: any) { setError(e.message); setPreview(null); } finally { setBusy(''); }
  };
  const addAll = async () => {
    setError(''); setNotice(''); setBusy('import');
    try {
      const r = await api<{ added: number; skipped: number }>('/holidays/import', { method: 'POST', body: { country, years, ...(scope ? { siteId: scope } : {}) } });
      setNotice(`${r.added} holiday${r.added !== 1 ? 's' : ''} added${r.skipped ? `, ${r.skipped} already in the calendar` : ''}.`);
      setPreview(null); setTick((t) => t + 1);
    } catch (e: any) { setError(e.message); } finally { setBusy(''); }
  };
  const addOne = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(''); setNotice(''); setBusy('one');
    try {
      await api('/forecast/events', { method: 'POST', body: { name: form.name.trim(), kind: 'holiday', startDay: form.startDay, endDay: form.endDay || form.startDay, ...(scope ? { siteId: scope } : {}) } });
      setForm({ name: '', startDay: '', endDay: '' }); setTick((t) => t + 1); setNotice('Holiday added.');
    } catch (err: any) { setError(err.message); } finally { setBusy(''); }
  };
  const remove = async (id: string, name: string) => {
    if (!window.confirm(`Remove "${name}" from the holiday calendar?`)) return;
    setError(''); setNotice('');
    try { await api(`/forecast/events/${id}`, { method: 'DELETE' }); setTick((t) => t + 1); } catch (e: any) { setError(e.message); }
  };
  const clearYear = async () => {
    setError(''); setNotice(''); setBusy('clear');
    try {
      const r = await api<{ removed: number }>(`/holidays/year/${year}${scope ? `?siteId=${scope}` : ''}`, { method: 'DELETE' });
      setClearing(false); setTyped('');
      setNotice(`${r.removed} holiday${r.removed !== 1 ? 's' : ''} of ${year} removed.`); setTick((t) => t + 1);
    } catch (e: any) { setError(e.message); } finally { setBusy(''); }
  };

  const cols: ColDef<EventRow>[] = [
    { headerName: 'Date', field: 'startDay', width: 250, valueFormatter: (p) => (p.data!.endDay > p.data!.startDay ? `${fmt(p.data!.startDay)} to ${fmt(p.data!.endDay)}` : fmt(p.data!.startDay)) },
    { headerName: 'Holiday', field: 'name', flex: 1, minWidth: 220 },
    { headerName: 'Applies to', field: 'groupName', width: 170, valueFormatter: (p) => p.value || (p.data?.siteName ? `${p.data.siteName} only` : 'Every group') },
    ...(canWrite ? [{ headerName: 'Action', colId: 'del', width: 120, sortable: false, cellRenderer: (p: ICellRendererParams<EventRow>) => <Btn onClick={() => remove(p.data!.id, p.data!.name)}>Remove</Btn> } as ColDef<EventRow>] : []),
  ];
  const toggleYear = (y: number) => setYears((c) => (c.includes(y) ? c.filter((x) => x !== y) : [...c, y].sort()));
  const fresh = preview?.filter((p) => !p.exists).length ?? 0;
  const workspaceName = session?.workspace?.name ?? 'this workspace';

  return (
    <div className="space-y-6 max-w-5xl">
      {notice && <Banner kind="ok" onClose={() => setNotice('')}>{notice}</Banner>}
      {error && <Banner kind="err" onClose={() => setError('')}>{error}</Banner>}

      <Card title="Week and weekend" sub={`Defaults for ${workspaceName}. Payroll, leave, weekend fairness and rotation analysis all follow them.`}>
        {policy.loading && !policy.data ? <Waiting what="the week and holiday rules" shape="lines" reload={policy.reload} /> : (
          <div className="space-y-4">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <Field label="Pay week starts on" hint="Weekly hours, days per week and overtime are counted from this day. A WFM group can use its own day (Configuration › WFM Groups).">
                <Select disabled={!canWrite} value={payWeek} onChange={(e) => setPayWeek(Number(e.target.value))}>{DAYS.map((d, i) => <option key={d} value={i}>{d}</option>)}</Select>
              </Field>
              <div role="group" aria-labelledby="wc-weekend">
                <div id="wc-weekend" className="text-[12px] font-semibold text-[#171717]">Weekend days</div>
                <div className="flex flex-wrap gap-x-4 gap-y-1.5 pt-2">
                  {DAYS.map((d, i) => {
                    const on = weekend.includes(i);
                    return (
                      <label key={d} className="flex items-center gap-1.5 text-[13px] text-[#171717]">
                        <input type="checkbox" disabled={!canWrite || (!on && weekend.length >= 3) || (on && weekend.length <= 1)} checked={on} onChange={() => setWeekend(on ? weekend.filter((x) => x !== i) : [...weekend, i].sort((a, b) => a - b))} /> {d.slice(0, 3)}
                      </label>
                    );
                  })}
                </div>
                <div className="text-[12px] text-[#6B6B6B] mt-1.5">One to three days. Used for weekend pay, fair sharing of weekend shifts, and paid leave that skips them.</div>
              </div>
            </div>
            {canWrite && <div className="flex items-center gap-3"><Btn variant="primary" onClick={saveWeek} disabled={!weekDirty || busy === 'week'}>{busy === 'week' ? 'Saving...' : 'Save week and weekend'}</Btn>{weekDirty && <span className="text-[12px] text-[#8F6200]">Not saved yet</span>}</div>}
          </div>
        )}
      </Card>

      <Card title="Holidays" sub={site ? `${site.name}'s own holidays. They apply to the groups at this site, on top of the organisation's holidays.` : 'Days that payroll pays at the holiday rate and that forecasting treats as holidays. Shift patterns that observe holidays skip them.'}
        actions={<div className="flex items-center gap-2">
          {(sites.data?.length ?? 0) > 0 && <><span className="text-[12px] text-[#6B6B6B]">Calendar for</span><Select aria-label="Calendar for" value={scope} onChange={(e) => setScope(e.target.value)}><option value="">Whole organisation</option>{(sites.data ?? []).filter((s) => s.status !== 'CLOSED').map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</Select></>}
          <span className="text-[12px] text-[#6B6B6B]">Year</span><Select value={year} onChange={(e) => setYear(Number(e.target.value))}>{[thisYear - 1, thisYear, thisYear + 1, thisYear + 2].map((y) => <option key={y} value={y}>{y}</option>)}</Select></div>}>
        {site && <p className="text-[12px] text-[#525252]">{alsoApply} organisation-wide holiday{alsoApply === 1 ? '' : 's'} in {year} also apply here. Switch to "Whole organisation" to see or change them.</p>}
        {events.loading && !events.data ? <Waiting what="holidays" shape="table" reload={events.reload} /> : rows.length === 0 ? (
          <Empty title={`No ${site ? `${site.name} ` : ''}holidays in ${year}`}>{canWrite ? 'Add a country\'s public holidays below, or add days one by one.' : 'Ask an administrator to add them.'}</Empty>
        ) : (
          <>
            <Grid<EventRow> height={Math.min(rows.length, 12) * 42 + 48} rowData={rows} columnDefs={cols} rowHeight={42} getRowId={(p) => p.data.id} defaultColDef={{ sortable: true, resizable: true, cellStyle: { display: 'flex', alignItems: 'center' } }} />
            <div className="flex items-center justify-between mt-2.5 text-[12px]">
              <span className="text-[#6B6B6B]">{rows.length} holiday{rows.length !== 1 ? 's' : ''} in {year}</span>
              {canWrite && <button onClick={() => { setClearing(true); setTyped(''); }} className="text-[#BC3F3F] hover:underline whitespace-nowrap">Clear all {year} holidays</button>}
            </div>
          </>
        )}
      </Card>

      {canWrite && (
        <Card title={site ? `Add public holidays for ${site.name}` : "Add a country's public holidays"} sub="A starting point: choose a country and the years, look at the list, then add it. Nothing is added until you press the button. National public holidays only; add regional and company holidays below.">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4 items-end">
            <Field label="Country">
              <Select value={country} onChange={(e) => { setCountry(e.target.value); setPreview(null); }}>
                <option value="">Choose a country</option>
                {(countries.data ?? []).map((c) => <option key={c.code} value={c.code}>{c.name}</option>)}
              </Select>
            </Field>
            <div role="group" aria-labelledby="wc-years">
              <div id="wc-years" className="text-[12px] font-semibold text-[#171717]">Years</div>
              <div className="flex gap-4 text-[13px] h-9 items-center mt-1">
                {[thisYear, thisYear + 1, thisYear + 2].map((y) => <label key={y} className="flex items-center gap-1.5"><input type="checkbox" checked={years.includes(y)} onChange={() => { toggleYear(y); setPreview(null); }} /> {y}</label>)}
              </div>
            </div>
            <div className="flex gap-2">
              <Btn onClick={loadPreview} disabled={!country || years.length === 0 || busy === 'preview'}>{busy === 'preview' ? 'Loading...' : 'Show holidays'}</Btn>
              {(country || preview) && <Btn onClick={() => { setCountry(''); setPreview(null); setYears([thisYear]); }}>Clear</Btn>}
            </div>
          </div>
          {preview && (
            <div className="mt-4 space-y-3">
              {preview.length === 0 ? <p className="text-[13px] text-[#6B6B6B]">No public holidays are listed for that country and year.</p> : (
                <>
                  <div className="border border-[#E5E5E0] rounded-lg divide-y divide-[#E5E5E0] max-h-72 overflow-y-auto text-[13px]">
                    {preview.map((p) => (
                      <div key={`${p.startDay}|${p.name}`} className="px-3 py-2 flex items-center justify-between gap-3">
                        <span className="text-[#171717]">{fmt(p.startDay)}{p.endDay > p.startDay ? ` to ${fmt(p.endDay)}` : ''}</span>
                        <span className="flex-1 text-[#171717]">{p.name}</span>
                        {p.exists ? <Pill tone="neutral">Already added</Pill> : <Pill tone="good">New</Pill>}
                      </div>
                    ))}
                  </div>
                  <div className="flex items-center gap-3">
                    <Btn variant="primary" onClick={addAll} disabled={fresh === 0 || busy === 'import'}>{busy === 'import' ? 'Adding...' : `Add ${fresh} holiday${fresh !== 1 ? 's' : ''}`}</Btn>
                    <span className="text-[12px] text-[#6B6B6B]">The list may not include regional or company holidays. Check it against the customer's own calendar.</span>
                  </div>
                </>
              )}
            </div>
          )}
          <p className="text-[11px] text-[#6B6B6B] mt-4">Holiday data: the open-source date-holidays project (code under the ISC licence, data under CC BY 3.0).</p>
        </Card>
      )}

      {canWrite && (
        <Card title="Add a holiday" sub="A regional or company holiday. Leave the last day empty for a single day.">
          <form onSubmit={addOne} className="grid grid-cols-1 md:grid-cols-4 gap-4 items-end">
            <div className="md:col-span-2"><Field label="Name"><Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="e.g. Pongal" required /></Field></div>
            <Field label="Date"><Input type="date" value={form.startDay} onChange={(e) => setForm({ ...form, startDay: e.target.value })} required /></Field>
            <Field label="Last day (optional)"><Input type="date" value={form.endDay} min={form.startDay} onChange={(e) => setForm({ ...form, endDay: e.target.value })} /></Field>
            <div><Btn variant="primary" type="submit" disabled={!form.name.trim() || !form.startDay || busy === 'one'}>Add holiday</Btn></div>
          </form>
        </Card>
      )}

      {clearing && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center p-4 z-50" role="dialog" aria-modal="true" aria-label={`Clear all ${year} holidays`}>
          <div className="bg-white border border-[#E5E5E0] rounded-lg shadow-2xl w-full max-w-md">
            <div className="px-5 py-3.5 border-b border-[#E5E5E0]"><h3 className="text-[15px] font-semibold text-[#171717]">Clear all {year} holidays?</h3></div>
            <div className="p-5 space-y-3 text-[13px] text-[#171717]">
              <p>This removes <strong>{rows.length} holiday{rows.length !== 1 ? 's' : ''}</strong> from the {year} calendar, {site ? `for the groups at ${site.name}` : 'for every WFM group'}.</p>
              <ul className="list-disc pl-5 text-[#525252] space-y-1">
                <li>Payroll stops paying those days at the holiday rate.</li>
                <li>Forecasting stops treating them as holidays.</li>
                <li>Shift patterns that skip holidays will schedule work on them.</li>
              </ul>
              <p className="text-[#525252]">It cannot be undone. The removal is recorded in the audit log.</p>
              <label className="block text-[12px] font-semibold text-[#171717]">Type {year} to confirm
                <Input autoFocus value={typed} onChange={(e) => setTyped(e.target.value)} placeholder={String(year)} />
              </label>
            </div>
            <div className="px-5 py-3.5 border-t border-[#E5E5E0] flex justify-end gap-2">
              <Btn onClick={() => setClearing(false)}>Cancel</Btn>
              <Btn variant="primary" onClick={clearYear} disabled={typed.trim() !== String(year) || busy === 'clear'} className="bg-[#BC3F3F] hover:bg-[#A33636] border-[#BC3F3F]">{busy === 'clear' ? 'Clearing...' : `Clear ${rows.length} holiday${rows.length !== 1 ? 's' : ''}`}</Btn>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
