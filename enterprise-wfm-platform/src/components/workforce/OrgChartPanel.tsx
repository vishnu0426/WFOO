/**
 * Workforce › Org chart. Who reports to whom, read a level at a time so it stays quick for thousands of people: the tops of the branches, then each
 * person's direct reports when you open them. Pick a person to see the chain above them and their own reports. People with no line are listed so
 * they can be given one.
 */
import React, { useEffect, useState } from 'react';
import { ChevronRight, Download } from 'lucide-react';
import { api, download } from '../../services/api';
import { useForecast } from '../../services/forecastStore';
import { useApi } from '../forecasting/hooks';
import { PersonPicker } from '../common/PersonPicker';
import { Banner, Btn, Card, Empty, Pill, Select } from '../forecasting/ui';

type Node = { id: string; name: string; employeeNumber: string; teamId: string | null; teamName: string | null; status: string; isSupervisor: boolean; isManager: boolean; reportsTo: string | null; directReports: number; allReports: number };
type Roots = { roots: Node[]; unassigned: number; total: number };
type Page = { total: number; items: Node[] };
const WIDE = 25;                // more people than this under one person is flagged

const Card1: React.FC<{ n: Node; onFocus: (id: string) => void; open?: boolean; onToggle?: () => void }> = ({ n, onFocus, open, onToggle }) => (
  <div className="flex items-center gap-2 rounded-lg border border-[#E5E5E0] bg-white px-3 py-2">
    {onToggle ? (
      <button type="button" aria-label={open ? `Close ${n.name}'s reports` : `Open ${n.name}'s reports`} aria-expanded={open} disabled={n.directReports === 0} onClick={onToggle} className="w-5 h-5 flex items-center justify-center text-[#6B6B6B] disabled:opacity-20">
        <ChevronRight className={`w-4 h-4 transition-transform ${open ? 'rotate-90' : ''}`} />
      </button>
    ) : <span className="w-5" />}
    <span className={`w-2 h-2 rounded-full shrink-0 ${n.status === 'ACTIVE' ? 'bg-[#2F7D5A]' : n.status === 'LEAVE' ? 'bg-[#B7791F]' : 'bg-[#A3A3A3]'}`} title={n.status} />
    <button type="button" className="text-left min-w-0 flex-1" onClick={() => onFocus(n.id)} title="Show the chain above and the people below">
      <div className="text-[13px] font-semibold truncate">{n.name} <span className="font-normal text-[#6B6B6B]">({n.employeeNumber})</span></div>
      <div className="text-[11px] text-[#6B6B6B] truncate">{n.teamName ?? 'No team'}{n.directReports > 0 ? ` · ${n.directReports} direct${n.allReports > n.directReports ? `, ${n.allReports} in all` : ''}` : ''}</div>
    </button>
    <span className="flex gap-1 shrink-0">
      {n.isManager && <Pill tone="info">Manager</Pill>}
      {n.isSupervisor && <Pill tone="good">Supervisor</Pill>}
      {n.directReports > WIDE && <Pill tone="warn" title={`More than ${WIDE} people report to them`}>Wide span</Pill>}
    </span>
  </div>
);

/** A person's direct reports, opened on demand, a page at a time. */
const Branch: React.FC<{ id: string; depth: number; onFocus: (id: string) => void }> = ({ id, depth, onFocus }) => {
  const [items, setItems] = useState<Node[]>([]);
  const [total, setTotal] = useState(0);
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState('');
  const load = (offset: number) => {
    setBusy(true);
    api<Page>(`/workforce/org-chart/${id}/reports?limit=50&offset=${offset}`).then((r) => { setItems((cur) => (offset ? [...cur, ...r.items] : r.items)); setTotal(r.total); }).catch((e) => setError(e.message)).finally(() => setBusy(false));
  };
  useEffect(() => { load(0); }, [id]);   // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div className={depth > 0 ? 'ml-6 pl-3 border-l border-[#E5E5E0] space-y-1.5 mt-1.5' : 'space-y-1.5'}>
      {error && <Banner kind="err">{error}</Banner>}
      {items.map((n) => (
        <div key={n.id}>
          <Card1 n={n} onFocus={onFocus} open={!!open[n.id]} onToggle={() => setOpen((o) => ({ ...o, [n.id]: !o[n.id] }))} />
          {open[n.id] && <Branch id={n.id} depth={depth + 1} onFocus={onFocus} />}
        </div>
      ))}
      {busy && <div className="text-[12px] text-[#6B6B6B]">Loading…</div>}
      {!busy && items.length < total && <Btn onClick={() => load(items.length)}>Show more ({total - items.length} more)</Btn>}
    </div>
  );
};

/** People nobody leads and who lead nobody, each with a picker to give them a line. */
const Unassigned: React.FC<{ groupId: string; canWrite: boolean; onChanged: () => void }> = ({ groupId, canWrite, onChanged }) => {
  const [offset, setOffset] = useState(0);
  const [tick, setTick] = useState(0);
  const list = useApi<Node[]>(`/workforce/org-chart/unassigned?limit=25&offset=${offset}${groupId ? `&groupId=${groupId}` : ''}`, [tick]);
  const [error, setError] = useState('');
  const set = async (id: string, to: string) => {
    setError('');
    try { await api(`/workforce/employees/${id}`, { method: 'PUT', body: { reportsTo: to || null, reason: 'Reporting line set in the org chart' } }); setTick((t) => t + 1); onChanged(); }
    catch (e: any) { setError(e.message); }
  };
  return (
    <Card title="People with no reporting line" sub="Choose who each one reports to. Their team's supervisor is the usual answer; the Teams screen can do a whole team at once.">
      {error && <Banner kind="err" onClose={() => setError('')}>{error}</Banner>}
      {list.data?.length === 0 && <p className="text-[12px] text-[#6B6B6B]">Everyone has a line.</p>}
      <div className="space-y-1.5">
        {list.data?.map((n) => (
          <div key={n.id} className="grid grid-cols-1 md:grid-cols-2 gap-2 items-center rounded-lg border border-[#E5E5E0] px-3 py-2">
            <div className="text-[13px]"><b>{n.name}</b> <span className="text-[#6B6B6B]">({n.employeeNumber}) · {n.teamName ?? 'No team'}</span></div>
            {canWrite ? <PersonPicker ariaLabel={`Reports to for ${n.name}`} value="" statuses="ONBOARDING,ACTIVE,LEAVE" placeholder="Reports to…" onChange={(to) => to && set(n.id, to)} /> : <span className="text-[12px] text-[#6B6B6B]">Not set</span>}
          </div>
        ))}
      </div>
      <div className="flex gap-2"><Btn disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - 25))}>Previous</Btn><Btn disabled={(list.data?.length ?? 0) < 25} onClick={() => setOffset(offset + 25)}>Next</Btn></div>
    </Card>
  );
};

export const OrgChartPanel: React.FC = () => {
  const { can, groups } = useForecast() as any;
  const canWrite = can('workforce:write');
  const [groupId, setGroupId] = useState('');
  const [focus, setFocus] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const [showUn, setShowUn] = useState(false);
  const roots = useApi<Roots>(`/workforce/org-chart/roots${groupId ? `?groupId=${groupId}` : ''}`, [tick]);
  const chain = useApi<Node[]>(focus ? `/workforce/org-chart/${focus}/chain` : null, [focus, tick]);
  const me = chain.data?.[chain.data.length - 1];
  const r = roots.data;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-3">
        <div className="w-72"><div className="text-[12px] font-semibold mb-1">Find a person</div><PersonPicker ariaLabel="Find a person in the chart" value="" statuses="ONBOARDING,ACTIVE,LEAVE" placeholder="Search by name or number" onChange={(id) => id && setFocus(id)} /></div>
        {Array.isArray(groups) && groups.length > 0 && <div className="w-56"><div className="text-[12px] font-semibold mb-1">WFM group</div><Select value={groupId} onChange={(e) => { setGroupId(e.target.value); setFocus(null); }}><option value="">Everyone</option>{groups.map((g: any) => <option key={g.id} value={g.id}>{g.name}</option>)}</Select></div>}
        <Btn onClick={() => download('/workforce/org-chart/export.csv', 'reporting-lines.csv').catch(() => undefined)}><Download className="w-3.5 h-3.5" />Export reporting lines</Btn>
        {r && <div className="ml-auto text-[12px] text-[#6B6B6B]">{r.total.toLocaleString()} people · {r.unassigned.toLocaleString()} with no line {r.unassigned > 0 && <button className="underline text-[#171717]" onClick={() => setShowUn((v) => !v)}>{showUn ? 'Hide' : 'Show them'}</button>}</div>}
      </div>

      {showUn && <Unassigned groupId={groupId} canWrite={canWrite} onChanged={() => setTick((t) => t + 1)} />}

      {focus && chain.data ? (
        <Card title={me?.name ?? 'Person'} sub="The chain above them, then the people who report to them." actions={<Btn onClick={() => setFocus(null)}>Close ×</Btn>}>
          <nav aria-label="Chain of command" className="flex flex-wrap items-center gap-1 text-[12px]">
            {chain.data.map((c, i) => (
              <React.Fragment key={c.id}>
                {i > 0 && <ChevronRight className="w-3 h-3 text-[#A3A3A3]" />}
                {i < chain.data!.length - 1 ? <button className="underline" onClick={() => setFocus(c.id)}>{c.name}</button> : <b>{c.name}</b>}
              </React.Fragment>
            ))}
          </nav>
          {chain.data.length === 1 && <p className="text-[12px] text-[#B7791F]">Nobody is above them yet.{canWrite ? ' Set "Reports to" on their employee record.' : ''}</p>}
          {me && me.directReports === 0 ? <Empty title="Nobody reports to them">Set "Reports to" on other people to build this branch.</Empty> : me && <Branch id={me.id} depth={0} onFocus={setFocus} />}
        </Card>
      ) : roots.error ? <Banner kind="err">{roots.error}</Banner> : !r ? <p className="text-[12px] text-[#6B6B6B]">Loading…</p> : r.roots.length === 0 ? (
        <Empty title="No reporting lines yet">Set "Reports to" on employees, or use "Put the team under its supervisor" on the Teams screen. People appear here once somebody reports to them.</Empty>
      ) : (
        <div className="space-y-3">
          {r.roots.map((n) => <RootBranch key={n.id} n={n} onFocus={setFocus} />)}
          {r.roots.length >= 200 && <p className="text-[12px] text-[#6B6B6B]">Showing the first 200 branches. Use the search or a WFM group to narrow it.</p>}
        </div>
      )}
    </div>
  );
};

const RootBranch: React.FC<{ n: Node; onFocus: (id: string) => void }> = ({ n, onFocus }) => {
  const [open, setOpen] = useState(false);
  return <div><Card1 n={n} onFocus={onFocus} open={open} onToggle={() => setOpen((v) => !v)} />{open && <Branch id={n.id} depth={1} onFocus={onFocus} />}</div>;
};
