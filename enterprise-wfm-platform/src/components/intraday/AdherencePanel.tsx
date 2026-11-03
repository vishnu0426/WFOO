/**
 * Intraday › Real-Time Adherence, built for groups of any size. It never downloads everyone:
 *   a summary (totals, teams, the staffing chart) -> team tiles, worst first -> a server-filtered, server-sorted, paged list of people
 *   -> one person's timeline in a drawer when opened, plus history over days, supervisor alerts and saved views.
 * Everything is cut from one shared, seconds-old judgement of the group on the server, so ten supervisors cost the same as one.
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ColDef, ICellRendererParams, IDatasource, IGetRowsParams, GridApi } from 'ag-grid-community';
import { Download, RefreshCw, X } from 'lucide-react';
import { api, apiPage, download, AdherenceDetail, AdherenceHistory, AdherenceLite, AdherenceStatus, AdherenceSummary, AdherenceTeam, Activity, ACTIVITY_CATEGORY_LABEL, SavedView } from '../../services/api';
import { useForecast } from '../../services/forecastStore';
import { useApi } from '../forecasting/hooks';
import { Grid } from '../forecasting/Grid';
import { CHART, LineChart } from '../forecasting/charts';
import { Banner, Btn, Busy, Card, Empty, Input, Kpi, KpiRow, Pill, Select, Table } from '../forecasting/ui';
import { MultiSelect } from '../common/MultiSelect';
import { coveredBy, ExplainBox, hm, isOut, REFRESH_OPTIONS, refreshLabel, RUN_COLOR, STATUS, useActivityLooks, useRefreshSetting, useTick } from './adherenceShared';

const NO_TEAM = '~none';
const SCOPE_KEY = 'rta-scope';
const LAYOUT_KEY = 'rta-layout';
const schedLabel = (s: string) => (s === 'SHIFT_ENDED' ? 'Shift ended' : s === 'NOT_STARTED' ? 'Not started' : s === 'NONE' ? 'Not scheduled' : ACTIVITY_CATEGORY_LABEL[s as keyof typeof ACTIVITY_CATEGORY_LABEL] ?? s);
const ATTENTION: AdherenceStatus[] = ['OUT', 'UNSCHEDULED'];
const pctTone = (p: number | null): 'good' | 'warn' | 'bad' | undefined => (p === null ? undefined : p >= 90 ? 'good' : p >= 80 ? 'warn' : 'bad');
const SORT_KEY: Record<string, string> = { name: 'name', shift: 'shift', actual: 'actual', status: 'status', outSeconds: 'outMinutes', dayPercent: 'dayPercent' };

/** A query string, with repeated keys for lists (team names may contain commas). */
const qs = (o: Record<string, string | string[] | number | undefined | null>) => Object.entries(o)
  .filter(([, v]) => v !== undefined && v !== null && v !== '' && !(Array.isArray(v) && !v.length))
  .flatMap(([k, v]) => (Array.isArray(v) ? v.map((x) => `${k}=${encodeURIComponent(x)}`) : [`${k}=${encodeURIComponent(String(v))}`])).join('&');

const useDebounced = <T,>(v: T, ms = 300) => { const [d, setD] = useState(v); useEffect(() => { const t = setTimeout(() => setD(v), ms); return () => clearTimeout(t); }, [v, ms]); return d; };

export const AdherenceScreen: React.FC<{ groupId: string; day: string }> = ({ groupId, day }) => {
  const { go, can } = useForecast();
  const [refresh, setRefresh] = useRefreshSetting();
  const tick = useTick(refresh * 1000, !day && refresh > 0);
  const [saved, setSaved] = useState(0);
  const [scopeChoice, setScopeChoice] = useState<'mine' | 'all' | null>(() => { try { const v = localStorage.getItem(SCOPE_KEY); return v === 'mine' || v === 'all' ? v : null; } catch { return null; } });
  const [autoMine, setAutoMine] = useState(false);
  const scope = scopeChoice ?? (autoMine ? 'mine' : 'all');
  const [view, setView] = useState<'attention' | 'everyone'>('attention');
  const [layout, setLayoutState] = useState<'list' | 'timeline'>(() => { try { return localStorage.getItem(LAYOUT_KEY) === 'timeline' ? 'timeline' : 'list'; } catch { return 'list'; } });
  const setLayout = (l: 'list' | 'timeline') => { setLayoutState(l); try { localStorage.setItem(LAYOUT_KEY, l); } catch { /* this visit only */ } };
  const [order, setOrder] = useState<'default' | 'name' | 'out' | 'adherence'>('default');
  const [status, setStatus] = useState<string[]>([]);
  const [teamSel, setTeamSel] = useState<string[]>([]);
  const [search, setSearch] = useState('');
  const q = useDebounced(search.trim());
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState('');

  const sum = useApi<AdherenceSummary>(`/intraday/adherence/summary?${qs({ groupId, day, scope })}`, [tick, groupId, day, scope, saved]);
  const d = sum.data;
  useEffect(() => { if (d && scopeChoice === null && d.myTeams.length > 0 && !autoMine) setAutoMine(true); }, [d, scopeChoice, autoMine]);   // a supervisor who manages teams starts on their own
  const chooseScope = (s: 'mine' | 'all') => { setScopeChoice(s); setTeamSel([]); try { localStorage.setItem(SCOPE_KEY, s); } catch { /* keep for this visit only */ } };

  // the filter every list, count and export below uses
  const statusFilter = view === 'attention' ? ATTENTION : (status as AdherenceStatus[]);
  const filterKey = [groupId, day, scope, view, statusFilter.join(), teamSel.join('\u0001'), q].join('|');
  const filterQs = () => qs({ groupId, day, scope, status: statusFilter.join(','), team: teamSel, q });

  const gridApi = useRef<GridApi | null>(null);
  const datasource = useMemo<IDatasource>(() => ({
    getRows: (p: IGetRowsParams) => {
      const s = p.sortModel[0];
      const sortKey = s ? SORT_KEY[s.colId] : undefined;
      apiPage<AdherenceLite>(`/intraday/adherence/agents?${filterQs()}&limit=${p.endRow - p.startRow}&offset=${p.startRow}${sortKey ? `&sort=${sortKey}&dir=${s.sort}` : ''}`)
        .then((r) => { setError(''); p.successCallback(r.rows, r.total); })
        .catch((e: any) => { setError(e.message); p.failCallback(); });
    },
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [filterKey]);
  useEffect(() => { if (tick > 0 || saved > 0) gridApi.current?.refreshInfiniteCache(); }, [tick, saved]);   // new numbers without sending the list back to the top

  const cols = useMemo<ColDef<AdherenceLite>[]>(() => [
    { headerName: 'Agent', field: 'name', flex: 1.2, minWidth: 180, cellRenderer: (p: ICellRendererParams<AdherenceLite>) => p.data && <div className="leading-tight py-1"><div className="font-semibold">{p.data.name}</div><div className="text-[12px] text-[#6B6B6B]">{p.data.team ?? 'No team'} · {p.data.employeeNumber}</div></div> },
    { headerName: 'Shift', field: 'shift', width: 140, cellRenderer: (p: ICellRendererParams<AdherenceLite>) => p.data && <div className="leading-tight"><div>{p.data.shift ?? '–'}</div>{p.data.timezone !== d?.timezone && <div className="text-[12px] text-[#6B6B6B]">{p.data.timezone}</div>}</div> },
    { headerName: 'Should be', field: 'scheduled', width: 130, sortable: false, cellRenderer: (p: ICellRendererParams<AdherenceLite>) => p.data && (p.data.status === 'NOT_STARTED' ? <span className="text-[#6B6B6B]">–</span> : <span>{schedLabel(p.data.scheduled)}</span>) },
    { headerName: 'Actually', field: 'actual', flex: 1, minWidth: 190, cellRenderer: (p: ICellRendererParams<AdherenceLite>) => p.data && (p.data.status === 'NOT_STARTED' ? <span className="text-[#6B6B6B]">–</span> : <div className="leading-tight"><div>{p.data.actual}</div>{p.data.state && <div className="text-[12px] text-[#6B6B6B]">{p.data.state}{p.data.reason ? ` / ${p.data.reason}` : ''}{p.data.stateSince ? ` since ${p.data.stateSince}` : ''}</div>}</div>) },
    { headerName: 'Status', field: 'status', width: 170, cellRenderer: (p: ICellRendererParams<AdherenceLite>) => p.data && <Pill tone={STATUS[p.data.status].tone}>{STATUS[p.data.status].label}</Pill> },
    { headerName: 'Out for', field: 'outSeconds', width: 96, type: 'rightAligned', valueFormatter: (p) => (!p.value ? '–' : p.value < 60 ? `${p.value}s` : `${Math.round(p.value / 60)} min`) },
    { headerName: 'Adherence', field: 'dayPercent', width: 110, type: 'rightAligned', valueFormatter: (p) => (p.value === null || p.value === undefined ? '–' : `${p.value}%`) },
  ], [d?.timezone]);

  // saved views: a person's own filter sets
  const [viewsTick, setViewsTick] = useState(0);
  const views = useApi<SavedView[]>('/views?screen=adherence', [viewsTick]);
  const currentFilters = () => ({ view, status, team: teamSel, q: search, scope: scopeChoice ?? undefined });
  const applyView = (v: SavedView) => {
    const f = v.filters;
    setView(f.view === 'everyone' ? 'everyone' : 'attention'); setStatus(Array.isArray(f.status) ? f.status : []); setTeamSel(Array.isArray(f.team) ? f.team : []); setSearch(typeof f.q === 'string' ? f.q : '');
    if (f.scope === 'mine' || f.scope === 'all') chooseScope(f.scope);
  };
  const saveView = async () => {
    const name = prompt('Name this view (for example: Night team, out of adherence)');
    if (!name?.trim()) return;
    try { await api('/views', { method: 'POST', body: { screen: 'adherence', name: name.trim(), filters: currentFilters() } }); setViewsTick((t) => t + 1); } catch (e: any) { setError(e.message); }
  };
  const deleteView = async (v: SavedView) => {
    if (!confirm(`Delete the saved view “${v.name}”?`)) return;
    try { await api(`/views/${v.id}`, { method: 'DELETE' }); setViewsTick((t) => t + 1); } catch (e: any) { setError(e.message); }
  };
  const [pickedView, setPickedView] = useState('');

  if (sum.loading && !d) return <Busy text="Loading adherence…" />;
  if (sum.error && !d) return <Banner kind="err">{sum.error}</Banner>;
  if (!d) return null;
  const s = d.summary;
  const attention = s.outOfAdherence + s.unscheduled;
  const teamOptions = d.teams.map((t) => ({ value: t.team ?? NO_TEAM, label: t.team ?? 'No team', hint: String(t.total) }));
  const nobody = s.total === 0;

  return (
    <div className="space-y-6">
      {d.unmappedStates.length > 0 && (
        <Banner kind="warn">
          The phone system reported states that are not mapped to an activity: {d.unmappedStates.map((u) => `${u.state}${u.reason ? ` / ${u.reason}` : ''} (${u.agents})`).join(', ')}. Those people show as Unknown.{' '}
          <button className="underline font-semibold" onClick={() => go('rta-mapping', 'configuration')}>Map them</button>
        </Banner>
      )}
      {!d.publishedSchedule && <Banner kind="warn">There is no published schedule for {d.day}, so nobody can be checked against one. Publish a schedule under Scheduling.</Banner>}
      {d.myTeams.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 text-[13px]">
          <span className="text-[#6B6B6B]">Showing</span>
          <div className="flex rounded border border-[#E5E5E0] bg-[#FAFAF8] p-0.5 text-[12px]">
            {(['mine', 'all'] as const).map((k) => <button key={k} onClick={() => chooseScope(k)} className={`px-3 py-1 rounded font-semibold ${scope === k ? 'bg-white text-[#171717] shadow-xs' : 'text-[#737373]'}`}>{k === 'mine' ? `My teams (${d.myTeams.length})` : 'Everyone'}</button>)}
          </div>
          {scope === 'mine' && <span className="text-[#6B6B6B]">{d.myTeams.join(', ')}</span>}
        </div>
      )}
      <KpiRow>
        <Kpi label="Adherence today" value={s.dayPercent === null ? '–' : `${s.dayPercent}%`} sub={`Average across ${s.total.toLocaleString('en-US')} people${d.asOf ? `, as of ${d.asOf}` : ''}`} tone={pctTone(s.dayPercent)} />
        <Kpi label="In adherence" value={s.inAdherence.toLocaleString('en-US')} sub={`Grace period ${d.graceSeconds >= 60 ? `${Math.round(d.graceSeconds / 60)} min` : `${d.graceSeconds}s`}`} tone="good" />
        <Kpi label="Out of adherence" value={s.outOfAdherence.toLocaleString('en-US')} sub={s.unscheduled ? `${s.unscheduled.toLocaleString('en-US')} working unscheduled` : 'Longer than the grace period'} tone={s.outOfAdherence ? 'bad' : 'good'} />
        <Kpi label="Not counted" value={(s.unknown + s.ignored).toLocaleString('en-US')} sub={`${s.unknown.toLocaleString('en-US')} unknown state, ${s.ignored.toLocaleString('en-US')} ignored`} tone={s.unknown ? 'warn' : undefined} />
      </KpiRow>

      <div className="grid grid-cols-1 xl:grid-cols-3 gap-5 items-start">
        {d.publishedSchedule && (
          <div className="xl:col-span-2">
            <Card title="Published vs actual" sub="People the schedule has on shift each 15 minutes, against people actually in adherence (the whole group).">
              <LineChart height={210} xEvery={8} leftLabel="People" labels={d.staffing.map((x) => x.time)}
                series={[
                  { name: 'Published', color: CHART.baseline, kind: 'dashed', values: d.staffing.map((x) => x.published) },
                  { name: 'Actual (in adherence)', color: CHART.success, kind: 'bar', values: d.staffing.map((x) => x.actual) },
                ]} />
            </Card>
          </div>
        )}
        <div className={d.publishedSchedule ? '' : 'xl:col-span-3'}>
          <TeamTiles teams={d.teams} selected={teamSel} onToggle={(t) => { setTeamSel((cur) => (cur.length === 1 && cur[0] === t ? [] : [t])); setView('everyone'); }} />
        </div>
      </div>

      <Card title="People" sub={day ? 'A past day shows how it ended.' : refresh ? `Refreshes every ${refreshLabel(refresh)}${d.ageSeconds > 0 ? ` · figures are ${d.ageSeconds} s old` : ''}.` : 'Refresh is off. Reload the page to update.'}
        actions={<>
          <div className="flex rounded border border-[#E5E5E0] bg-[#FAFAF8] p-0.5 text-[12px]" role="group" aria-label="Layout">
            {(['list', 'timeline'] as const).map((l) => <button key={l} onClick={() => setLayout(l)} aria-pressed={layout === l} className={`px-3 py-1.5 rounded font-semibold ${layout === l ? 'bg-white text-[#171717] shadow-xs' : 'text-[#737373]'}`}>{l === 'list' ? 'List' : 'Timeline'}</button>)}
          </div>
          <div className="w-36"><Select value={refresh} onChange={(e) => setRefresh(Number(e.target.value))} aria-label="Refresh" disabled={!!day}>
            {REFRESH_OPTIONS.map((x) => <option key={x} value={x}>{x === 0 ? 'Refresh off' : `Every ${refreshLabel(x)}`}</option>)}
          </Select></div>
          {!day && refresh > 0 && <span className="text-[11px] text-[#6B6B6B] flex items-center gap-1"><RefreshCw className="w-3 h-3" />live</span>}
        </>}>
        {error && <Banner kind="err" onClose={() => setError('')}>{error}</Banner>}
        {nobody ? (
          <Empty title={d.hasEvents ? (scope === 'mine' ? 'Nobody in your teams is scheduled or active for this day' : 'Nobody is scheduled or active in this group for this day') : 'No agent states received yet'}>
            {d.hasEvents
              ? scope === 'mine' ? 'Switch to Everyone to see the whole group.' : 'Publish a schedule or pick another day.'
              : <>Connect your phone or ACD system so each agent’s state appears here. <button className="underline font-semibold" onClick={() => go('integration-station', 'configuration')}>Open Integration Station</button></>}
          </Empty>
        ) : (
          <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-2">
              <div className="flex rounded border border-[#E5E5E0] bg-[#FAFAF8] p-0.5 text-[12px]">
                <button onClick={() => setView('attention')} className={`px-3 py-1.5 rounded font-semibold ${view === 'attention' ? 'bg-white text-[#171717] shadow-xs' : 'text-[#737373]'}`}>Needs attention ({attention.toLocaleString('en-US')})</button>
                <button onClick={() => setView('everyone')} className={`px-3 py-1.5 rounded font-semibold ${view === 'everyone' ? 'bg-white text-[#171717] shadow-xs' : 'text-[#737373]'}`}>Everyone ({s.total.toLocaleString('en-US')})</button>
              </div>
              <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search name or number" aria-label="Search people" className="!w-52" />
              {view === 'everyone' && <MultiSelect ariaLabel="Status" allLabel="All statuses" noun={['status', 'statuses']} value={status} onChange={setStatus} options={(Object.keys(STATUS) as AdherenceStatus[]).map((k) => ({ value: k, label: STATUS[k].label }))} />}
              <MultiSelect ariaLabel="Teams" allLabel="All teams" noun={['team', 'teams']} value={teamSel} onChange={setTeamSel} options={teamOptions} />
              {(teamSel.length > 0 || search || (view === 'everyone' && status.length > 0)) && <button className="text-[12px] underline text-[#525252]" onClick={() => { setTeamSel([]); setSearch(''); setStatus([]); }}>Clear filters</button>}
              <div className="flex items-center gap-2 ml-auto">
                <Select className="!w-44" aria-label="Saved views" value={pickedView} onChange={(e) => { const v = views.data?.find((x) => x.id === e.target.value); setPickedView(e.target.value); if (v) applyView(v); }}>
                  <option value="">Saved views…</option>{views.data?.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
                </Select>
                {pickedView && <button className="text-[12px] underline text-[#BC3F3F]" onClick={() => { const v = views.data?.find((x) => x.id === pickedView); if (v) { void deleteView(v); setPickedView(''); } }}>Delete view</button>}
                <Btn onClick={saveView}>Save this view</Btn>
                <Btn onClick={() => download(`/intraday/adherence/export.csv?${filterQs()}`, `adherence-${d.day}.csv`).catch((e) => setError(e.message))}><Download className="w-3.5 h-3.5" />Export</Btn>
              </div>
            </div>
            {layout === 'list' ? (
              <Grid<AdherenceLite> rowModelType="infinite" datasource={datasource} cacheBlockSize={100} maxBlocksInCache={30} columnDefs={cols} rowHeight={48} height={520}
                defaultColDef={{ sortable: true, resizable: true, suppressHeaderMenuButton: true }} getRowId={(p) => p.data.employeeId}
                onGridReady={(e) => { gridApi.current = e.api; }} onRowClicked={(e) => e.data && setSelected(e.data.employeeId)} rowStyle={{ cursor: 'pointer' }} />
            ) : (
              <TimelineView qsBase={filterQs()} resetKey={filterKey + order} order={order} onOrder={setOrder} tick={tick} saved={saved} onOpen={setSelected} />
            )}
            <p className="text-[12px] text-[#6B6B6B]">{view === 'attention' ? 'People out of adherence past the grace period, longest first. ' : ''}Click a person to see their day and explain a stretch.{layout === 'timeline' ? ' Bars show scheduled time (behind) and what the person actually did (in front).' : ''}</p>
          </div>
        )}
      </Card>

      {selected && <AgentDrawer groupId={groupId} day={d.day} employeeId={selected} canAct={can('intraday:act')} tick={tick} onClose={() => setSelected(null)} onSaved={() => setSaved((x) => x + 1)} />}
      <HistoryCard groupId={groupId} scope={scope} teams={teamSel} q={q} />
      <AlertSettings canEdit={can('intraday:act')} />
    </div>
  );
};

// ---------------------------------------------------------------- teams, worst first

const TEAM_TILES = 24;
const TeamTiles: React.FC<{ teams: AdherenceTeam[]; selected: string[]; onToggle: (team: string) => void }> = ({ teams, selected, onToggle }) => {
  const [all, setAll] = useState(false);
  const shown = all ? teams : teams.slice(0, TEAM_TILES);
  if (teams.length === 0) return null;
  return (
    <Card title="Teams" sub="Worst first. Click one to list its people.">
      <div className="grid grid-cols-2 gap-2 max-h-[17rem] overflow-y-auto pr-1">
        {shown.map((t) => {
          const key = t.team ?? NO_TEAM, on = selected.length === 1 && selected[0] === key, tone = pctTone(t.dayPercent);
          const color = tone === 'good' ? '#2F7D5A' : tone === 'warn' ? '#B7791F' : tone === 'bad' ? '#C84A4A' : '#A3A3A3';
          return (
            <button key={key} onClick={() => onToggle(key)} aria-pressed={on} title={`${t.total} people · ${t.outOfAdherence} out · ${t.unknown} no state`}
              className={`text-left rounded-lg border p-2.5 ${on ? 'border-[#171717] bg-[#FAFAF8]' : 'border-[#E5E5E0] bg-white hover:bg-[#FAFAF8]'}`}>
              <div className="text-[12px] font-semibold truncate">{t.team ?? 'No team'}</div>
              <div className="flex items-baseline justify-between mt-0.5">
                <span className="text-[18px] font-bold font-mono tabular-nums" style={{ color }}>{t.dayPercent === null ? '–' : `${t.dayPercent}%`}</span>
                <span className="text-[11px] text-[#6B6B6B]">{t.total.toLocaleString('en-US')}{t.outOfAdherence > 0 && <b className="text-[#BC3F3F]"> · {t.outOfAdherence} out</b>}</span>
              </div>
              <div className="h-1 rounded bg-[#EFEFEA] mt-1.5"><div className="h-1 rounded" style={{ width: `${Math.max(0, Math.min(100, t.dayPercent ?? 0))}%`, backgroundColor: color }} /></div>
            </button>
          );
        })}
      </div>
      {teams.length > TEAM_TILES && <button className="text-[12px] underline text-[#525252]" onClick={() => setAll((a) => !a)}>{all ? 'Show fewer teams' : `Show all ${teams.length.toLocaleString('en-US')} teams`}</button>}
    </Card>
  );
};

// ---------------------------------------------------------------- timeline chart: one bar per person

const TL_PAGE = 40;
const ORDERS: Record<string, string> = { default: '', name: '&sort=name&dir=asc', out: '&sort=outMinutes&dir=desc', adherence: '&sort=dayPercent&dir=asc' };
type TimelinePage = { day: string; asOf: string | null; total: number; people: AdherenceDetail[] };

/**
 * Each person as one bar on a shared time axis: the scheduled day behind (work as a pale band, meals and breaks in their own colour) and what they actually did in front
 * (green in adherence, red out, amber unscheduled, blue no state, grey explained). A line marks now. Only the people on this page are drawn and judged in full, so it stays
 * quick for a group of any size; the filters, search and teams above apply, and clicking a bar opens the person.
 */
const TimelineView: React.FC<{ qsBase: string; resetKey: string; order: string; onOrder: (o: 'default' | 'name' | 'out' | 'adherence') => void; tick: number; saved: number; onOpen: (id: string) => void }> = ({ qsBase, resetKey, order, onOrder, tick, saved, onOpen }) => {
  const [page, setPage] = useState(0);
  useEffect(() => setPage(0), [resetKey]);
  const acts = useApi<Activity[]>('/config/activities', []);
  const looks = useActivityLooks(acts.data);
  const res = useApi<TimelinePage>(`/intraday/adherence/timelines?${qsBase}${ORDERS[order] ?? ''}&limit=${TL_PAGE}&offset=${page * TL_PAGE}`, [tick, saved, page, resetKey]);
  const d = res.data;
  const people = d?.people ?? [];
  const withShift = people.filter((a) => (a.timeline?.schedule.length ?? 0) > 0);
  const lo = withShift.length ? Math.max(0, Math.floor((Math.min(...withShift.map((a) => a.timeline!.schedule[0].from)) - 30) / 60) * 60) : 0;
  const hi = withShift.length ? Math.min(1440, Math.ceil((Math.max(...withShift.map((a) => a.timeline!.schedule[a.timeline!.schedule.length - 1].to)) + 30) / 60) * 60) : 1440;
  const span = Math.max(60, hi - lo), step = span <= 360 ? 60 : span <= 960 ? 120 : 180;
  const pos = (m: number) => `${((Math.max(lo, Math.min(hi, m)) - lo) / span) * 100}%`;
  const width = (f: number, t: number) => `${(Math.max(0, Math.min(hi, t) - Math.max(lo, f)) / span) * 100}%`;
  const ticks: number[] = []; for (let t = Math.ceil(lo / step) * step; t <= hi; t += step) ticks.push(t);
  const nowMin = d?.asOf ? Number(d.asOf.slice(0, 2)) * 60 + Number(d.asOf.slice(3, 5)) : null;
  const total = d?.total ?? 0;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-[12px] text-[#525252]">
          {[{ c: looks.color.WORK, l: `Scheduled ${looks.name.WORK.toLowerCase()}` }, { c: looks.color.BREAK, l: `Scheduled ${looks.name.BREAK.toLowerCase()}` }, { c: looks.color.MEAL, l: `Scheduled ${looks.name.MEAL.toLowerCase()}` }].map((k) => <span key={k.l} className="flex items-center gap-1.5"><span className="w-3 h-3 rounded-sm border border-[#D6D6D0]" style={{ backgroundColor: k.c }} />{k.l}</span>)}
          {[{ c: RUN_COLOR.IN, l: 'In adherence' }, { c: RUN_COLOR.OUT, l: 'Out' }, { c: RUN_COLOR.UNSCHEDULED, l: 'Unscheduled' }, { c: RUN_COLOR.UNKNOWN, l: 'No state' }, { c: '#B8B8B0', l: 'Explained' }].map((k) => <span key={k.l} className="flex items-center gap-1.5"><span className="w-3 h-1.5 rounded-full" style={{ backgroundColor: k.c }} />{k.l}</span>)}
          {nowMin !== null && <span className="flex items-center gap-1.5"><span className="w-px h-3 bg-[#171717]" />Now</span>}
        </div>
        <label className="flex items-center gap-2 text-[12px] text-[#525252]">Order
          <Select className="!w-48" value={order} onChange={(e) => onOrder(e.target.value as 'default' | 'name' | 'out' | 'adherence')} aria-label="Order">
            <option value="default">Needs attention first</option><option value="out">Out the longest</option><option value="adherence">Lowest adherence</option><option value="name">Name</option>
          </Select>
        </label>
      </div>
      {res.error && <Banner kind="err">{res.error}</Banner>}
      {res.loading && !d ? <Busy text="Loading timelines…" /> : people.length === 0 ? <Empty title="Nobody matches these filters" /> : (
        <div className="overflow-x-auto">
          <div className="min-w-[640px]">
            <div className="flex items-end gap-3 mb-1">
              <div className="w-52 shrink-0" />
              <div className="relative h-4 flex-1">{ticks.map((t) => <span key={t} className={`absolute top-0 text-[12px] font-mono text-[#525252] ${t >= hi ? '-translate-x-full' : '-translate-x-1/2'}`} style={{ left: pos(t) }}>{hm(t >= 1440 ? 1439 : t).replace(/^23:59$/, '24:00')}</span>)}</div>
            </div>
            <div className="space-y-1.5">
              {people.map((a) => (
                <div key={a.employeeId} role="button" tabIndex={0} onClick={() => onOpen(a.employeeId)} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen(a.employeeId); } }}
                  className="flex items-center gap-3 rounded cursor-pointer hover:bg-[#FAFAF8] focus:outline-none focus-visible:ring-2 focus-visible:ring-[#171717]">
                  <div className="w-52 shrink-0 leading-tight py-0.5">
                    <div className="text-[12px] font-semibold truncate" title={a.name}>{a.name}</div>
                    <div className="flex items-center gap-1.5 text-[11px] text-[#6B6B6B]"><span className="truncate">{a.team ?? 'No team'}</span><Pill tone={STATUS[a.status].tone}>{a.status === 'OUT' && a.outMinutes ? `Out ${a.outMinutes} min` : STATUS[a.status].label}</Pill></div>
                  </div>
                  <div className="relative h-8 flex-1 rounded-md border border-[#E5E5E0] bg-[#FAFAF8] overflow-hidden" aria-label={`${a.name}: ${a.shift ?? 'no shift'}`}>
                    {(a.timeline?.schedule ?? []).map((x, i) => <div key={`s${i}`} title={`Scheduled ${(looks.name[x.type] ?? x.type).toLowerCase()} ${hm(x.from)}–${hm(x.to)}`} className="absolute top-0 h-full" style={{ left: pos(x.from), width: width(x.from, x.to), backgroundColor: looks.color[x.type] ?? '#E9E9E4' }} />)}
                    {(a.timeline?.actual ?? []).map((r, i) => {
                      const explained = isOut(r.status) && !!coveredBy(r, a.exceptions ?? []);
                      return <div key={`a${i}`} title={`${hm(r.from)}–${hm(r.to)} ${r.label}${explained ? ' (explained)' : ''}`} className="absolute top-2.5 h-3 rounded-full" style={{ left: pos(r.from), width: width(r.from, r.to), backgroundColor: explained ? '#B8B8B0' : RUN_COLOR[r.status] }} />;
                    })}
                    {nowMin !== null && nowMin >= lo && nowMin <= hi && <div className="absolute top-0 h-full w-px bg-[#171717]/60" style={{ left: pos(nowMin) }} />}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
      {total > TL_PAGE && (
        <div className="flex items-center gap-3 text-[12px]">
          <Btn disabled={page === 0} onClick={() => setPage(page - 1)}>Previous</Btn>
          <Btn disabled={(page + 1) * TL_PAGE >= total} onClick={() => setPage(page + 1)}>Next</Btn>
          <span className="text-[#6B6B6B]">Showing {(page * TL_PAGE + 1).toLocaleString('en-US')}–{Math.min(total, (page + 1) * TL_PAGE).toLocaleString('en-US')} of {total.toLocaleString('en-US')}</span>
        </div>
      )}
    </div>
  );
};

// ---------------------------------------------------------------- one person, opened from the list

const AgentDrawer: React.FC<{ groupId: string; day: string; employeeId: string; canAct: boolean; tick: number; onClose: () => void; onSaved: () => void }> = ({ groupId, day, employeeId, canAct, tick, onClose, onSaved }) => {
  const [local, setLocal] = useState(0);
  const res = useApi<AdherenceDetail>(`/intraday/adherence/agents/${employeeId}?${qs({ groupId, day })}`, [employeeId, tick, local]);
  const acts = useApi<Activity[]>('/config/activities', []);
  const looks = useActivityLooks(acts.data);
  const schedColor = looks.color, schedName = looks.name;
  const [open, setOpen] = useState<string | null>(null);
  const [error, setError] = useState('');
  const a = res.data;
  useEffect(() => { const f = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); }; document.addEventListener('keydown', f); return () => document.removeEventListener('keydown', f); }, [onClose]);

  const done = () => { setOpen(null); setLocal((x) => x + 1); onSaved(); };
  const remove = async (id: string) => { if (!confirm('Remove this explanation?')) return; try { await api(`/intraday/exceptions/${id}`, { method: 'DELETE' }); done(); } catch (e: any) { setError(e.message); } };

  const sched = a?.timeline.schedule ?? [];
  const lo = sched.length ? Math.max(0, sched[0].from - 30) : 0, hi = sched.length ? Math.min(1440, sched[sched.length - 1].to + 30) : 1440, span = Math.max(60, hi - lo);
  const pos = (m: number) => `${((Math.max(lo, Math.min(hi, m)) - lo) / span) * 100}%`, width = (f: number, t: number) => `${(Math.max(0, Math.min(hi, t) - Math.max(lo, f)) / span) * 100}%`;
  const tickStep = span <= 480 ? 60 : span <= 900 ? 120 : 180;      // a whole-day shift must not print 24 labels on top of each other
  const ticks: number[] = []; for (let t = Math.ceil(lo / tickStep) * tickStep; t <= hi; t += tickStep) ticks.push(t);
  const stretches = (a?.timeline.actual ?? []).filter((r) => isOut(r.status));

  return (
    <aside className="fixed inset-y-0 right-0 z-40 w-[480px] max-w-full bg-white border-l border-[#E5E5E0] shadow-xl overflow-y-auto" aria-label="Person details">
      <div className="flex items-start gap-3 p-4 border-b border-[#E5E5E0]">
        <div className="flex-1 min-w-0">
          <div className="text-[16px] font-semibold truncate">{a?.name ?? '…'}</div>
          <div className="text-[12px] text-[#6B6B6B]">{a ? `${a.team ?? 'No team'} · ${a.employeeNumber} · ${a.timezone}` : ''}</div>
        </div>
        {a && <Pill tone={STATUS[a.status].tone}>{STATUS[a.status].label}</Pill>}
        <button className="text-[#737373] hover:text-[#171717]" onClick={onClose} aria-label="Close"><X className="w-4 h-4" /></button>
      </div>
      <div className="p-4 space-y-5">
        {res.loading && !a && <Busy text="Loading…" />}
        {res.error && <Banner kind="err">{res.error}</Banner>}
        {error && <Banner kind="err" onClose={() => setError('')}>{error}</Banner>}
        {a && (
          <>
            <div className="grid grid-cols-2 gap-3 text-[13px]">
              <div><div className="text-[11px] font-semibold uppercase tracking-wider text-[#6B6B6B]">Should be</div>{a.status === 'NOT_STARTED' ? '–' : schedLabel(a.scheduled)}{a.scheduledUntil && <span className="text-[#6B6B6B]"> until {a.scheduledUntil}</span>}</div>
              <div><div className="text-[11px] font-semibold uppercase tracking-wider text-[#6B6B6B]">Actually</div>{a.status === 'NOT_STARTED' ? '–' : a.actual}{a.state && <div className="text-[12px] text-[#6B6B6B]">{a.state}{a.reason ? ` / ${a.reason}` : ''}{a.stateSince ? ` since ${a.stateSince}` : ''}</div>}</div>
              <div><div className="text-[11px] font-semibold uppercase tracking-wider text-[#6B6B6B]">Shift</div>{a.shift ?? '–'}</div>
              <div><div className="text-[11px] font-semibold uppercase tracking-wider text-[#6B6B6B]">Day so far</div>{a.dayPercent === null ? '–' : `${a.dayPercent}%`}<span className="text-[12px] text-[#6B6B6B]"> ({a.adherentMin} of {a.scheduledMin} min)</span></div>
            </div>
            <div>
              <div className="text-[11px] font-semibold uppercase tracking-wider text-[#6B6B6B] mb-2">Timeline</div>
              <div className="relative h-4 mb-0.5">{ticks.map((t) => <span key={t} className="absolute top-0 -translate-x-1/2 text-[10px] font-mono text-[#6B6B6B]" style={{ left: pos(t) }}>{hm(t)}</span>)}</div>
              <div className="relative h-6 rounded bg-[#FAFAF8] border border-[#E5E5E0]">
                {sched.map((x, i) => <div key={`s${i}`} title={`Scheduled ${(schedName[x.type] ?? x.type).toLowerCase()} ${hm(x.from)}–${hm(x.to)}`} className="absolute top-0 h-full opacity-70" style={{ left: pos(x.from), width: width(x.from, x.to), backgroundColor: schedColor[x.type] ?? '#E9E9E4' }} />)}
                {a.timeline.actual.map((r, i) => <div key={`a${i}`} title={`${hm(r.from)}–${hm(r.to)} ${r.label}${isOut(r.status) && coveredBy(r, a.exceptions) ? ' (explained)' : ''}`} className="absolute top-1.5 h-3 rounded-sm" style={{ left: pos(r.from), width: width(r.from, r.to), backgroundColor: isOut(r.status) && coveredBy(r, a.exceptions) ? '#B8B8B0' : RUN_COLOR[r.status] }} />)}
              </div>
              <div className="flex flex-wrap gap-x-3 gap-y-1 mt-2 text-[11px] text-[#525252]">
                {[{ c: RUN_COLOR.IN, l: 'In adherence' }, { c: RUN_COLOR.OUT, l: 'Out' }, { c: RUN_COLOR.UNSCHEDULED, l: 'Unscheduled' }, { c: RUN_COLOR.UNKNOWN, l: 'No state' }, { c: '#B8B8B0', l: 'Explained' }].map((k) => <span key={k.l} className="flex items-center gap-1"><span className="w-2 h-2 rounded-sm" style={{ backgroundColor: k.c }} />{k.l}</span>)}
              </div>
            </div>
            <div>
              <div className="text-[11px] font-semibold uppercase tracking-wider text-[#6B6B6B] mb-2">Stretches out of adherence ({stretches.length})</div>
              {stretches.length === 0 ? <p className="text-[13px] text-[#2A7553]">None today.</p> : (
                <div className="space-y-2">
                  {stretches.map((r) => {
                    const cover = coveredBy(r, a.exceptions), key = `${r.from}|${r.to}`;
                    return (
                      <div key={key} className="border border-[#E5E5E0] rounded-lg p-3 text-[13px]">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <div>{hm(r.from)}–{hm(r.to)} ({r.to - r.from} min) · {r.status === 'OUT' ? 'doing' : 'working unscheduled:'} <b>{r.label}</b></div>
                          {!cover && canAct && open !== key && <Btn onClick={() => setOpen(key)}>Explain</Btn>}
                        </div>
                        {cover && <div className="mt-1 text-[12px] text-[#525252] flex flex-wrap items-center gap-2"><Pill tone={cover.excused ? 'good' : 'neutral'}>{cover.excused ? 'Excused' : 'Explained, counted'}</Pill>{cover.category.replace(/_/g, ' ').toLowerCase()}: {cover.note}{canAct && <button className="underline text-[#6B6B6B]" onClick={() => remove(cover.id)}>Remove</button>}</div>}
                        {!cover && canAct && open === key && <ExplainBox agent={a} day={day} range={r} onCancel={() => setOpen(null)} onSaved={done} />}
                        {!cover && !canAct && <div className="text-[12px] text-[#6B6B6B] mt-1">Not explained yet.</div>}
                      </div>
                    );
                  })}
                </div>
              )}
              {a.exceptions.filter((x) => !stretches.some((r) => x.from <= r.from && x.to >= r.to)).length > 0 && (
                <div className="mt-3 text-[12px] text-[#525252] space-y-1">
                  <div className="font-semibold">Other explanations</div>
                  {a.exceptions.filter((x) => !stretches.some((r) => x.from <= r.from && x.to >= r.to)).map((x) => <div key={x.id} className="flex flex-wrap items-center gap-2">{hm(x.from)}–{hm(x.to)} <Pill tone={x.excused ? 'good' : 'neutral'}>{x.excused ? 'Excused' : 'Counted'}</Pill>{x.note}{canAct && <button className="underline text-[#6B6B6B]" onClick={() => remove(x.id)}>Remove</button>}</div>)}
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </aside>
  );
};

// ---------------------------------------------------------------- adherence over days

const isoDay = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const daysAgo = (n: number) => { const d = new Date(); d.setDate(d.getDate() - n); return isoDay(d); };
const HIST_PAGE = 50;

const HistoryCard: React.FC<{ groupId: string; scope: 'mine' | 'all'; teams: string[]; q: string }> = ({ groupId, scope, teams, q }) => {
  const [open, setOpen] = useState(false);
  const [from, setFrom] = useState(daysAgo(7)), [to, setTo] = useState(daysAgo(1));
  const [by, setBy] = useState<'agent' | 'team'>('team');
  const [offset, setOffset] = useState(0);
  const [retry, setRetry] = useState(0);
  const key = [groupId, from, to, by, scope, teams.join(), q].join('|');
  useEffect(() => setOffset(0), [key]);
  const path = open ? `/intraday/adherence/history?${qs({ groupId, from, to, by, scope, team: teams, q, limit: HIST_PAGE, offset })}` : null;
  const res = useApi<AdherenceHistory>(path, [key, offset, retry]);
  const h = res.data;
  // days that were not judged yet are built a few at a time: ask again until none are left
  useEffect(() => { if (h && h.building > 0) { const t = setTimeout(() => setRetry((x) => x + 1), 400); return () => clearTimeout(t); } }, [h]);
  const label = (x: number | null) => (x === null ? '–' : `${x}%`);

  return (
    <Card title="Adherence over time" sub="How much of the scheduled time each person or team spent in adherence, over finished days. Uses the team, search and “my teams” choices above."
      actions={<Btn onClick={() => setOpen((o) => !o)}>{open ? 'Hide' : 'Show'}</Btn>}>
      {open && (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-3 text-[13px]">
            <label className="flex items-center gap-2">From<Input type="date" value={from} max={to} onChange={(e) => e.target.value && setFrom(e.target.value)} className="!w-40" /></label>
            <label className="flex items-center gap-2">To<Input type="date" value={to} min={from} max={daysAgo(1)} onChange={(e) => e.target.value && setTo(e.target.value)} className="!w-40" /></label>
            <div className="flex rounded border border-[#E5E5E0] bg-[#FAFAF8] p-0.5 text-[12px]">
              {(['team', 'agent'] as const).map((k) => <button key={k} onClick={() => setBy(k)} className={`px-3 py-1 rounded font-semibold ${by === k ? 'bg-white text-[#171717] shadow-xs' : 'text-[#737373]'}`}>By {k === 'team' ? 'team' : 'person'}</button>)}
            </div>
            {[7, 14, 30].map((n) => <button key={n} className="underline text-[#525252] text-[12px]" onClick={() => { setFrom(daysAgo(n)); setTo(daysAgo(1)); }}>Last {n} days</button>)}
          </div>
          {res.error && <Banner kind="err">{res.error}</Banner>}
          {(res.loading && !h) || (h && h.building > 0) ? <Busy text={h && h.building > 0 ? `Working out earlier days… ${h.building} left` : 'Loading…'} /> : null}
          {h && h.building === 0 && (
            h.series.length === 0 ? <Empty title="No scored time in these days">Nobody had a published shift and mapped states on these days, or the days are older than the events kept.</Empty> : (
              <>
                <KpiRow>
                  <Kpi label="Adherence" value={label(h.overall.percent)} sub={`${h.overall.people.toLocaleString('en-US')} people over ${h.series.length} day${h.series.length === 1 ? '' : 's'}`} tone={pctTone(h.overall.percent)} />
                  <Kpi label="Scheduled time" value={`${Math.round(h.overall.scheduledMin / 60).toLocaleString('en-US')} h`} sub="counted in adherence" />
                </KpiRow>
                {h.series.length > 1 && <LineChart height={190} xEvery={Math.max(1, Math.ceil(h.series.length / 10))} leftLabel="%" labels={h.series.map((x) => x.day.slice(5))} series={[{ name: 'Adherence %', color: CHART.success, kind: 'line', values: h.series.map((x) => x.percent) }]} />}
                <Table head={[by === 'team' ? 'Team' : 'Person', by === 'agent' ? 'Team' : 'People', 'Scheduled (h)', 'Adherent (h)', 'Adherence']} right={[2, 3, 4]}>
                  {h.rows.map((r, i) => (
                    <tr key={`${r.employeeId ?? r.name}-${i}`}>
                      <td className="p-3 font-medium">{r.name || 'No team'}{by === 'agent' && r.employeeNumber && <div className="text-[12px] font-normal text-[#6B6B6B]">{r.employeeNumber}</div>}</td>
                      <td className="p-3">{by === 'agent' ? r.team ?? 'No team' : r.people.toLocaleString('en-US')}</td>
                      <td className="p-3 text-right font-mono">{(r.scheduledMin / 60).toFixed(1)}</td>
                      <td className="p-3 text-right font-mono">{(r.adherentMin / 60).toFixed(1)}</td>
                      <td className={`p-3 text-right font-mono font-semibold ${r.percent !== null && r.percent < 80 ? 'text-[#BC3F3F]' : ''}`}>{label(r.percent)}</td>
                    </tr>
                  ))}
                </Table>
                <div className="flex items-center gap-3 text-[12px]">
                  <Btn disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - HIST_PAGE))}>Previous</Btn>
                  <Btn disabled={h.rows.length < HIST_PAGE} onClick={() => setOffset(offset + HIST_PAGE)}>Next</Btn>
                  <span className="text-[#6B6B6B]">Worst first. Showing {offset + 1}–{offset + h.rows.length}.</span>
                </div>
              </>
            )
          )}
        </div>
      )}
    </Card>
  );
};

// ---------------------------------------------------------------- telling supervisors

const AlertSettings: React.FC<{ canEdit: boolean }> = ({ canEdit }) => {
  const { setNotice } = useForecast();
  const cur = useApi<{ alertAfterMin: number; enabled: boolean }>('/intraday/adherence/alert-settings', []);
  const [base, setBase] = useState<{ alertAfterMin: number; enabled: boolean } | null>(null);
  const [minutes, setMinutes] = useState(10), [enabled, setEnabled] = useState(true), [busy, setBusy] = useState(false);
  useEffect(() => { if (cur.data) { setBase(cur.data); setMinutes(cur.data.alertAfterMin); setEnabled(cur.data.enabled); } }, [cur.data]);
  const dirty = !!base && (base.alertAfterMin !== minutes || base.enabled !== enabled);
  const save = async () => {
    setBusy(true);
    try {
      await api('/intraday/adherence/alert-settings', { method: 'PUT', body: { alertAfterMin: minutes, enabled } });
      setBase({ alertAfterMin: minutes, enabled });
      setNotice({ kind: 'ok', text: enabled ? `Team managers are told when someone is out of adherence for ${minutes} minutes.` : 'Adherence alerts are off.' });
    } catch (e: any) { setNotice({ kind: 'err', text: e.message }); } finally { setBusy(false); }
  };
  if (!base) return null;
  return (
    <Card title="Alerts" sub="Team managers get one message in their inbox listing who has been out of adherence for too long. The same event can also go to webhooks and to the roles you choose under Administration › Alerts & Reports.">
      <div className="flex flex-wrap items-center gap-3 text-[13px]">
        <label className="flex items-center gap-2"><input type="checkbox" checked={enabled} disabled={!canEdit} onChange={(e) => setEnabled(e.target.checked)} className="w-4 h-4 accent-[#2F7D5A]" />Tell team managers when someone is out of adherence for</label>
        <Input type="number" min={1} max={240} value={minutes} disabled={!canEdit || !enabled} onChange={(e) => setMinutes(Math.max(1, Math.min(240, Number(e.target.value) || 1)))} className="!w-20" aria-label="Minutes" />
        <span>minutes</span>
        {canEdit && <Btn variant="primary" disabled={busy || !dirty} onClick={save}>Save</Btn>}
      </div>
    </Card>
  );
};
