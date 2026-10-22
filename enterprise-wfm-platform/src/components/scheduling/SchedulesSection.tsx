/**
 * Scheduling › All Schedules. Every schedule version across every WFM group, not just the one selected at the top of
 * the page — the scheduling equivalent of Forecasting › Forecasts. Click one to open it on the Schedule Timeline.
 */
import React, { useMemo, useState } from 'react';
import { dayYear, ScheduleVersion, when } from '../../services/api';
import { useForecast } from '../../services/forecastStore';
import { useApi } from '../forecasting/hooks';
import { Card, Empty, Field, Input, Pill, Select, Table } from '../forecasting/ui';

const STATUS_LABEL: Record<string, string> = { DRAFT: 'Draft', PUBLISHED: 'Published', ARCHIVED: 'Archived' };
const STATUS_TONE: Record<string, 'good' | 'neutral'> = { PUBLISHED: 'good', DRAFT: 'neutral', ARCHIVED: 'neutral' };
const updated = (v: ScheduleVersion) => v.publishedAt ?? v.createdAt;

export const SchedulesSection: React.FC<{ open: (v: ScheduleVersion) => void }> = ({ open }) => {
  const { groups } = useForecast();
  const all = useApi<ScheduleVersion[]>('/scheduling/versions');
  const [status, setStatus] = useState('All statuses');
  const [groupFilter, setGroupFilter] = useState('');
  const [query, setQuery] = useState('');
  const gname = (v: ScheduleVersion) => v.groupName ?? groups.find((g) => g.id === v.wfmGroupId)?.name ?? '–';

  const rows = useMemo(() => (all.data ?? []).filter((v) =>
    (status === 'All statuses' || v.status === status.toUpperCase()) &&
    (!groupFilter || v.wfmGroupId === groupFilter) &&
    (v.name.toLowerCase().includes(query.toLowerCase()) || `v${v.seq}`.includes(query.toLowerCase()) || gname(v).toLowerCase().includes(query.toLowerCase()))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  ).sort((a, b) => updated(b).localeCompare(updated(a))), [all.data, status, groupFilter, query, groups]);

  return (
    <Card title="All schedules" sub="Every schedule version across every WFM group. Click one to open it on the timeline.">
      <div className="flex flex-wrap items-end gap-3">
        <div className="w-56"><Field label="Search"><Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search schedules" /></Field></div>
        <div className="w-40"><Field label="Status"><Select value={status} onChange={(e) => setStatus(e.target.value)}>{['All statuses', 'Draft', 'Published', 'Archived'].map((s) => <option key={s} value={s}>{s}</option>)}</Select></Field></div>
        <div className="w-56"><Field label="Group"><Select value={groupFilter} onChange={(e) => setGroupFilter(e.target.value)}><option value="">All groups</option>{groups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}</Select></Field></div>
        <span className="text-[12px] text-[#737373] ml-auto">{rows.length} schedule{rows.length === 1 ? '' : 's'}</span>
      </div>
      {all.error && <p className="text-[12px] text-[#C84A4A]">{all.error}</p>}
      {rows.length === 0 && !all.loading ? (
        <Empty title="No schedules yet">Generate the first one under Scheduling › Generate Schedule.</Empty>
      ) : (
        <Table head={['Schedule', 'Group', 'Dates', 'Status', 'Ver.', 'Coverage', 'People', 'Updated']}>
          {rows.map((v) => (
            <tr key={v.id} className="cursor-pointer hover:bg-[#FAFAF8]" onClick={() => open(v)}>
              <td className="p-3 font-semibold"><button className="hover:underline" onClick={(e) => { e.stopPropagation(); open(v); }}>{v.name}</button></td>
              <td className="p-3 text-[#737373]">{gname(v)}</td>
              <td className="p-3 text-[12px] text-[#737373]">{dayYear(v.periodStart)} → {dayYear(v.periodEnd)}</td>
              <td className="p-3"><Pill tone={STATUS_TONE[v.status]}>{STATUS_LABEL[v.status]}</Pill></td>
              <td className="p-3 text-[12px]">v{v.seq}</td>
              <td className="p-3 text-[12px]">{v.stats?.coverage ? `${Math.round(v.stats.coverage.percent)}%` : '–'}</td>
              <td className="p-3 text-[12px]">{v.stats?.people ?? '–'}</td>
              <td className="p-3 text-[12px] text-[#737373]">{when(updated(v))}</td>
            </tr>
          ))}
        </Table>
      )}
    </Card>
  );
};
