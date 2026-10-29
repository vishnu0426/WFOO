/**
 * Scheduling › All Schedules. Every schedule version across every WFM group, not just the one selected at the top of
 * the page — the scheduling equivalent of Forecasting › Forecasts. Click one to open it on the Schedule Timeline.
 * Drafts and archived schedules can be deleted, one at a time or several at once. A published schedule cannot: publish a newer one and it is archived.
 */
import React, { useMemo, useState } from 'react';
import { Trash2 } from 'lucide-react';
import { api, dayYear, ScheduleVersion, when } from '../../services/api';
import { useForecast } from '../../services/forecastStore';
import { useApi } from '../forecasting/hooks';
import { Banner, Btn, Card, Empty, Field, Input, Pill, Select, Table } from '../forecasting/ui';

const STATUS_LABEL: Record<string, string> = { DRAFT: 'Draft', PUBLISHED: 'Published', ARCHIVED: 'Archived' };
const STATUS_TONE: Record<string, 'good' | 'neutral'> = { PUBLISHED: 'good', DRAFT: 'neutral', ARCHIVED: 'neutral' };
const updated = (v: ScheduleVersion) => v.publishedAt ?? v.createdAt;
const NOT_PUBLISHED = 'A published schedule cannot be deleted. Publish a newer one first; this one is then archived and can be deleted.';

export const SchedulesSection: React.FC<{ open: (v: ScheduleVersion) => void; onChanged?: () => void }> = ({ open, onChanged }) => {
  const { groups, can } = useForecast();
  const [tick, setTick] = useState(0);
  const all = useApi<ScheduleVersion[]>('/scheduling/versions', [tick]);
  const [status, setStatus] = useState('All statuses');
  const [groupFilter, setGroupFilter] = useState('');
  const [query, setQuery] = useState('');
  const [picked, setPicked] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ kind: 'ok' | 'err' | 'warn'; text: string } | null>(null);
  const canDelete = can('schedule:generate');
  const gname = (v: ScheduleVersion) => v.groupName ?? groups.find((g) => g.id === v.wfmGroupId)?.name ?? '–';

  const rows = useMemo(() => (all.data ?? []).filter((v) =>
    (status === 'All statuses' || v.status === status.toUpperCase()) &&
    (!groupFilter || v.wfmGroupId === groupFilter) &&
    (v.name.toLowerCase().includes(query.toLowerCase()) || `v${v.seq}`.includes(query.toLowerCase()) || gname(v).toLowerCase().includes(query.toLowerCase()))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  ).sort((a, b) => updated(b).localeCompare(updated(a))), [all.data, status, groupFilter, query, groups]);

  const deletable = rows.filter((v) => v.status !== 'PUBLISHED');
  const chosen = deletable.filter((v) => picked.includes(v.id));
  const allTicked = deletable.length > 0 && chosen.length === deletable.length;
  const toggle = (id: string) => setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));

  /** Deletes each schedule in turn and reports what happened, so one that cannot go does not hide the others. */
  const remove = async (list: ScheduleVersion[]) => {
    if (!list.length) return;
    const names = list.slice(0, 5).map((v) => `${v.name} (${gname(v)})`).join('\n');
    if (!confirm(`Delete ${list.length === 1 ? 'this schedule' : `these ${list.length} schedules`}?\n\n${names}${list.length > 5 ? `\n…and ${list.length - 5} more` : ''}\n\nThis cannot be undone.`)) return;
    setBusy(true); setNote(null);
    const failed: string[] = [];
    let done = 0;
    for (const v of list) {
      try { await api(`/scheduling/versions/${v.id}`, { method: 'DELETE' }); done++; } catch (e: any) { failed.push(`${v.name}: ${e.message}`); }
    }
    setPicked([]); setTick((t) => t + 1); onChanged?.(); setBusy(false);
    setNote(failed.length
      ? { kind: done ? 'warn' : 'err', text: `${done ? `${done} deleted. ` : ''}${failed.length} could not be deleted: ${failed.slice(0, 3).join('; ')}${failed.length > 3 ? '…' : ''}` }
      : { kind: 'ok', text: `${done} schedule${done === 1 ? '' : 's'} deleted.` });
  };

  return (
    <Card title="All schedules" sub="Every schedule version across every WFM group. Click one to open it on the timeline."
      actions={canDelete && chosen.length > 0 ? <Btn disabled={busy} onClick={() => remove(chosen)}><Trash2 className="w-3.5 h-3.5" />Delete {chosen.length} selected</Btn> : undefined}>
      <div className="flex flex-wrap items-end gap-3">
        <div className="w-56"><Field label="Search"><Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search schedules" /></Field></div>
        <div className="w-40"><Field label="Status"><Select value={status} onChange={(e) => setStatus(e.target.value)}>{['All statuses', 'Draft', 'Published', 'Archived'].map((s) => <option key={s} value={s}>{s}</option>)}</Select></Field></div>
        <div className="w-56"><Field label="Group"><Select value={groupFilter} onChange={(e) => setGroupFilter(e.target.value)}><option value="">All groups</option>{groups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}</Select></Field></div>
        <span className="text-[12px] text-[#737373] ml-auto">{rows.length} schedule{rows.length === 1 ? '' : 's'}</span>
      </div>
      {note && <Banner kind={note.kind} onClose={() => setNote(null)}>{note.text}</Banner>}
      {all.error && <p className="text-[12px] text-[#C84A4A]">{all.error}</p>}
      {rows.length === 0 && !all.loading ? (
        <Empty title="No schedules yet">Generate the first one under Scheduling › Generate Schedule.</Empty>
      ) : (
        <Table head={[
          canDelete ? <input key="all" type="checkbox" aria-label="Select all drafts and archived schedules" checked={allTicked} disabled={deletable.length === 0} onChange={() => setPicked(allTicked ? [] : deletable.map((v) => v.id))} /> : '',
          'Schedule', 'Group', 'Dates', 'Status', 'Ver.', 'Coverage', 'People', 'Updated', '',
        ]}>
          {rows.map((v) => (
            <tr key={v.id} className="cursor-pointer hover:bg-[#FAFAF8]" onClick={() => open(v)}>
              <td className="p-3 w-8" onClick={(e) => e.stopPropagation()}>
                {canDelete && v.status !== 'PUBLISHED' && <input type="checkbox" aria-label={`Select ${v.name}`} checked={picked.includes(v.id)} onChange={() => toggle(v.id)} />}
              </td>
              <td className="p-3 font-semibold"><button className="hover:underline" onClick={(e) => { e.stopPropagation(); open(v); }}>{v.name}</button>{v.stale && v.stale.length > 0 && <span className="ml-2"><Pill tone="warn" title={v.stale.join(' ')}>Out of date</Pill></span>}</td>
              <td className="p-3 text-[#737373]">{gname(v)}</td>
              <td className="p-3 text-[12px] text-[#737373]">{dayYear(v.periodStart)} → {dayYear(v.periodEnd)}</td>
              <td className="p-3"><Pill tone={STATUS_TONE[v.status]}>{STATUS_LABEL[v.status]}</Pill></td>
              <td className="p-3 text-[12px]">v{v.seq}</td>
              <td className="p-3 text-[12px]">{v.stats?.coverage ? `${Math.round(v.stats.coverage.percent)}%` : '–'}</td>
              <td className="p-3 text-[12px]">{v.stats?.people ?? '–'}</td>
              <td className="p-3 text-[12px] text-[#737373]">{when(updated(v))}</td>
              <td className="p-3 text-right" onClick={(e) => e.stopPropagation()}>
                {canDelete && (
                  <button aria-label={`Delete ${v.name}`} title={v.status === 'PUBLISHED' ? NOT_PUBLISHED : 'Delete this schedule'} disabled={busy || v.status === 'PUBLISHED'}
                    className="text-[#737373] hover:text-[#C84A4A] disabled:opacity-30 disabled:hover:text-[#737373]" onClick={() => remove([v])}><Trash2 className="w-4 h-4" /></button>
                )}
              </td>
            </tr>
          ))}
        </Table>
      )}
    </Card>
  );
};
