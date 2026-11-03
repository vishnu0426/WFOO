/** The groups at a glance: one row each with its site, queues, people, service goal, published forecast and running schedule. */
import React, { useMemo, useState } from 'react';
import { Search } from 'lucide-react';
import { GroupDto } from '../../../services/api';
import { Empty, Input, Pill, Select, Table } from '../../forecasting/ui';
import { dayRange, GroupSummary, Site } from './shared';

export const GroupList: React.FC<{
  groups: GroupDto[]; summary: Record<string, GroupSummary>; summaryFailed?: boolean; sites: Site[]; canWrite: boolean; onOpen: (id: string) => void; onCreate: () => void;
}> = ({ groups, summary, summaryFailed, sites, canWrite, onOpen, onCreate }) => {
  const wait = summaryFailed ? '—' : '…';
  const [q, setQ] = useState('');
  const [status, setStatus] = useState<'ALL' | 'ACTIVE' | 'INACTIVE'>('ALL');
  const [site, setSite] = useState('');
  const siteName = (id: string | null | undefined) => sites.find((s) => s.id === id)?.name ?? '';
  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return groups.filter((g) => (status === 'ALL' || g.status === status) && (!site || (site === 'none' ? !g.siteId : g.siteId === site))
      && (!needle || `${g.name} ${g.code} ${g.description} ${siteName(g.siteId)} ${g.queueNames.join(' ')}`.toLowerCase().includes(needle)));
  }, [groups, q, status, site, sites]);
  const active = groups.filter((g) => g.status === 'ACTIVE').length;

  if (!groups.length) return <Empty title="No WFM groups yet">A group is a set of queues that share one pool of agents. {canWrite ? <>Create the first one, or <button className="underline" onClick={onCreate}>start from a file</button>.</> : 'Ask an administrator to create one.'}</Empty>;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative flex-1 min-w-[220px] max-w-sm">
          <Search className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-[#6B6B6B]" />
          <Input aria-label="Search groups" className="!pl-8" placeholder="Search by group, queue or site" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <Select aria-label="Status" className="!w-auto" value={status} onChange={(e) => setStatus(e.target.value as typeof status)}><option value="ALL">All groups</option><option value="ACTIVE">Active</option><option value="INACTIVE">Switched off</option></Select>
        {sites.length > 0 && <Select aria-label="Site" className="!w-auto" value={site} onChange={(e) => setSite(e.target.value)}><option value="">All sites</option><option value="none">No site</option>{sites.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</Select>}
        <span className="text-[12px] text-[#6B6B6B] ml-auto">{shown.length === groups.length ? `${groups.length} group${groups.length === 1 ? '' : 's'}, ${active} active` : `${shown.length} of ${groups.length} groups`}</span>
      </div>

      {shown.length === 0 ? <Empty title="No group matches">Clear the search or the filters to see every group.</Empty> : (
        <Table head={['Group', 'Site', 'Queues', 'People', 'Service goal', 'Published forecast', 'Running schedule', 'Status']} right={[2, 3]}>
          {shown.map((g) => {
            const s = summary[g.id];
            return (
              <tr key={g.id} className="hover:bg-[#FAFAF8] cursor-pointer" onClick={() => onOpen(g.id)}>
                <td className="p-3">
                  <button className="text-left font-semibold text-[#171717] hover:underline focus:outline-none focus-visible:underline" onClick={(e) => { e.stopPropagation(); onOpen(g.id); }}>{g.name}</button>
                  <div className="text-[11px] font-mono text-[#6B6B6B]">{g.code} · {g.timezone}</div>
                </td>
                <td className="p-3 text-[#525252]">{siteName(g.siteId) || <span className="text-[#6B6B6B]">None</span>}</td>
                <td className="p-3 text-right tabular-nums" title={g.channels.join(', ')}>{s ? s.queues : g.queueIds.length}</td>
                <td className="p-3 text-right tabular-nums">{s ? s.people : wait}</td>
                <td className="p-3 whitespace-nowrap">{g.serviceLevelGoal}% in {g.serviceLevelThresholdSec}s</td>
                <td className="p-3">{!s ? wait : s.forecast ? <span title={`${s.forecast.name}, ${dayRange(s.forecast.fromDay, s.forecast.toDay)}`}><Pill tone="good">{s.forecast.kind === 'SHORT' ? 'Short' : 'Long'} v{s.forecast.seq}</Pill> <span className="text-[11px] text-[#6B6B6B]">{dayRange(s.forecast.fromDay, s.forecast.toDay)}</span></span> : <span className="text-[#6B6B6B]">None published</span>}</td>
                <td className="p-3">{!s ? wait : s.schedule ? <span title={s.schedule.name}><span className="text-[12px]">{dayRange(s.schedule.periodStart, s.schedule.periodEnd)}</span>{s.schedule.coverage != null && <span className="text-[11px] text-[#6B6B6B]"> · {s.schedule.coverage}% covered</span>}</span> : <span className="text-[#6B6B6B]">None published</span>}</td>
                <td className="p-3">{g.status === 'ACTIVE' ? <Pill tone="good">Active</Pill> : <Pill>Switched off</Pill>}</td>
              </tr>
            );
          })}
        </Table>
      )}
    </div>
  );
};
