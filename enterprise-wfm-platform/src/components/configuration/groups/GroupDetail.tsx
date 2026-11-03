/** One group: its settings at a glance, and tabs for queues, people, shrinkage, manual coverage and history. */
import React, { useState } from 'react';
import { ArrowLeft, Copy, Pencil, Power, Trash2 } from 'lucide-react';
import { api, GroupDto, MODEL_LABEL, Queue, Team } from '../../../services/api';
import { Btn, Card, Field, Input, Pill } from '../../forecasting/ui';
import { GroupForm, valuesOf } from './GroupForm';
import { PeopleTab } from './PeopleTab';
import { QueuesTab } from './QueuesTab';
import { CoverageTab, HistoryTab, ShrinkageTab } from './SmallTabs';
import { Confirm, DAYS_LONG, dayRange, GroupSummary, Site } from './shared';

const TABS = [['overview', 'Overview'], ['queues', 'Queues'], ['people', 'People'], ['shrinkage', 'Shrinkage'], ['coverage', 'Manual coverage'], ['history', 'History']] as const;
type TabId = (typeof TABS)[number][0];

const Row: React.FC<{ k: string; v: React.ReactNode }> = ({ k, v }) => (
  <div className="flex justify-between gap-3 py-1.5 border-b border-[#F0F0EB] last:border-0 text-[13px]"><span className="text-[#6B6B6B]">{k}</span><span className="font-medium text-[#171717] text-right">{v}</span></div>
);

export const GroupDetail: React.FC<{
  group: GroupDto; summary?: GroupSummary; sites: Site[]; teams: Team[]; queues: Queue[]; canWrite: boolean;
  onBack: () => void; onChanged: () => Promise<void>; onDeleted: () => Promise<void>; notify: (kind: 'ok' | 'err', text: string) => void; onOpen: (id: string) => void;
}> = ({ group, summary, sites, teams, queues, canWrite, onBack, onChanged, onDeleted, notify, onOpen }) => {
  const [tab, setTab] = useState<TabId>('overview');
  const [editing, setEditing] = useState(false);
  const [dialog, setDialog] = useState<null | 'clone' | 'off' | 'delete'>(null);
  const [warn, setWarn] = useState('');          // the gateway's warning that a published schedule is still running
  const [dlgError, setDlgError] = useState('');
  const [busy, setBusy] = useState(false);
  const [cloneName, setCloneName] = useState('');
  const [copy, setCopy] = useState({ queues: true, shrinkage: true, coverage: true });
  const [historyTick, setHistoryTick] = useState(0);
  const site = sites.find((s) => s.id === group.siteId);
  const off = group.status === 'INACTIVE';
  const changed = async () => { setHistoryTick((t) => t + 1); await onChanged(); };
  const close = () => { setDialog(null); setWarn(''); setDlgError(''); };

  const save = async (v: ReturnType<typeof valuesOf>, reason: string) => {
    await api(`/config/groups/${group.id}`, { method: 'PUT', body: { ...v, ...(reason ? { reason } : {}) } });
    notify('ok', 'Group saved. Staffing numbers use the new targets straight away.');
    setEditing(false); await changed();
  };
  const switchOff = async (reason: string) => {
    setBusy(true); setDlgError('');
    try {
      await api(`/config/groups/${group.id}`, { method: 'PUT', body: { status: off ? 'ACTIVE' : 'INACTIVE', reason, ...(warn ? { acknowledge: true } : {}) } });
      notify('ok', off ? `${group.name} is active again.` : `${group.name} is switched off. Its history is kept.`);
      close(); await changed();
    } catch (e: any) { if (e.status === 409 && !warn) setWarn(e.message); else setDlgError(e.message); } finally { setBusy(false); }
  };
  const remove = async (reason: string) => {
    setBusy(true); setDlgError('');
    try { await api(`/config/groups/${group.id}?reason=${encodeURIComponent(reason)}`, { method: 'DELETE' }); notify('ok', `${group.name} was deleted.`); close(); await onDeleted(); }
    catch (e: any) { setDlgError(e.message); } finally { setBusy(false); }
  };
  const clone = async () => {
    setBusy(true); setDlgError('');
    try { const c = await api<GroupDto & { copiedQueues: number }>(`/config/groups/${group.id}/clone`, { method: 'POST', body: { name: cloneName.trim(), ...copy } }); notify('ok', `Created ${c.name}${c.copiedQueues ? ` with ${c.copiedQueues} queue${c.copiedQueues === 1 ? '' : 's'}` : ''}. Add its people next.`); close(); await onChanged(); onOpen(c.id); }
    catch (e: any) { setDlgError(e.message); } finally { setBusy(false); }
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <button className="inline-flex items-center gap-1 text-[12px] text-[#6B6B6B] hover:text-[#171717]" onClick={onBack}><ArrowLeft className="w-3.5 h-3.5" />All WFM groups</button>
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-[20px] font-semibold text-[#171717]">{group.name}</h2>
            {off ? <Pill>Switched off</Pill> : <Pill tone="good">Active</Pill>}
          </div>
          <div className="text-[12px] text-[#6B6B6B]"><span className="font-mono">{group.code}</span> · {group.timezone}{site ? ` · ${site.name}` : ''}</div>
          {group.description && <p className="text-[13px] text-[#525252] max-w-3xl">{group.description}</p>}
        </div>
        {canWrite && (
          <div className="flex flex-wrap gap-2">
            <Btn onClick={() => { setTab('overview'); setEditing(true); }}><Pencil className="w-3.5 h-3.5" />Edit</Btn>
            <Btn onClick={() => { setCloneName(`${group.name} copy`); setDialog('clone'); }}><Copy className="w-3.5 h-3.5" />Clone</Btn>
            <Btn onClick={() => setDialog('off')}><Power className="w-3.5 h-3.5" />{off ? 'Switch on' : 'Switch off'}</Btn>
            <Btn className="!text-[#BC3F3F]" onClick={() => setDialog('delete')}><Trash2 className="w-3.5 h-3.5" />Delete</Btn>
          </div>
        )}
      </div>

      <div className="flex gap-1 border-b border-[#E5E5E0] overflow-x-auto" role="tablist">
        {TABS.map(([id, label]) => {
          const n = id === 'queues' ? queues.length : id === 'people' ? summary?.people : undefined;
          return (
            <button key={id} role="tab" aria-selected={tab === id} onClick={() => setTab(id)}
              className={`px-3 py-2 text-[13px] font-semibold whitespace-nowrap border-b-2 -mb-px transition-colors ${tab === id ? 'border-[#171717] text-[#171717]' : 'border-transparent text-[#6B6B6B] hover:text-[#171717]'}`}>
              {label}{n !== undefined && <span className="ml-1.5 text-[11px] font-medium text-[#6B6B6B]">{n}</span>}
            </button>
          );
        })}
      </div>

      {tab === 'overview' && (editing
        ? <GroupForm id={group.id} initial={valuesOf(group)} sites={sites} onSave={save} onCancel={() => setEditing(false)} />
        : (
          <div className="grid grid-cols-1 xl:grid-cols-3 gap-4 items-start">
            <Card title="Service targets"><div>
              <Row k="Service goal" v={`${group.serviceLevelGoal}% in ${group.serviceLevelThresholdSec}s`} />
              <Row k="Occupancy cap" v={`${group.targetOccupancy}%`} />
              <Row k="Shrinkage" v={`${group.shrinkagePercent}%`} />
            </div></Card>
            <Card title="Staffing and forecast"><div>
              <Row k="Method" v={group.method === 'erlang_a' ? `Erlang A, patience ${group.patienceSec}s` : 'Erlang C'} />
              <Row k="Blended voice and chat" v={group.blended ? 'Yes' : 'No'} />
              <Row k="Forecast model" v={group.model === 'auto' ? 'Chosen for each run' : `${MODEL_LABEL[group.model] ?? group.model} (set earlier)`} />
            </div></Card>
            <Card title="Working week"><div>
              <Row k="Pay week starts on" v={group.payWeekStart == null ? 'Company setting' : DAYS_LONG[group.payWeekStart]} />
              <Row k="Full-time hours" v={`${group.fteHoursWeek} h a week`} />
              <Row k="Time zone" v={group.timezone} />
              <Row k="Group manager" v={group.managerName ?? <span className="text-[#A3A3A3]">None</span>} />
            </div></Card>
            <Card title="Where it stands" className="xl:col-span-3">
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-[13px]">
                <div><div className="text-[11px] uppercase tracking-wider font-semibold text-[#6B6B6B]">People</div><div className="text-[20px] font-semibold tabular-nums">{summary?.people ?? '…'}</div><div className="text-[12px] text-[#6B6B6B]">{summary ? `${summary.primaryPeople} with this as their primary group` : ''}</div></div>
                <div><div className="text-[11px] uppercase tracking-wider font-semibold text-[#6B6B6B]">Queues</div><div className="text-[20px] font-semibold tabular-nums">{queues.length}</div><div className="text-[12px] text-[#6B6B6B]">{group.channels.length ? group.channels.map((c) => c.charAt(0) + c.slice(1).toLowerCase()).join(', ') : 'None yet'}</div></div>
                <div><div className="text-[11px] uppercase tracking-wider font-semibold text-[#6B6B6B]">Published forecast</div>{summary?.forecast ? <><div className="text-[14px] font-semibold mt-1">{summary.forecast.kind === 'SHORT' ? 'Short' : 'Long'} v{summary.forecast.seq}</div><div className="text-[12px] text-[#6B6B6B]">{dayRange(summary.forecast.fromDay, summary.forecast.toDay)}</div></> : <div className="text-[13px] text-[#6B6B6B] mt-1">None published</div>}</div>
                <div><div className="text-[11px] uppercase tracking-wider font-semibold text-[#6B6B6B]">Running schedule</div>{summary?.schedule ? <><div className="text-[14px] font-semibold mt-1">{dayRange(summary.schedule.periodStart, summary.schedule.periodEnd)}</div><div className="text-[12px] text-[#6B6B6B]">{summary.schedule.coverage != null ? `${summary.schedule.coverage}% covered · ` : ''}{summary.schedule.name}</div></> : <div className="text-[13px] text-[#6B6B6B] mt-1">None published</div>}</div>
              </div>
            </Card>
          </div>
        ))}
      {tab === 'queues' && <QueuesTab group={group} queues={queues} canWrite={canWrite} onChange={changed} />}
      {tab === 'people' && <PeopleTab group={group} teams={teams} canWrite={canWrite} onChange={() => { setHistoryTick((t) => t + 1); void onChanged(); }} />}
      {tab === 'shrinkage' && <ShrinkageTab group={group} canWrite={canWrite} />}
      {tab === 'coverage' && <CoverageTab group={group} canWrite={canWrite} />}
      {tab === 'history' && <HistoryTab group={group} sites={sites} tick={historyTick} />}

      {dialog === 'clone' && (
        <Confirm title={`Clone ${group.name}`} confirmLabel="Create copy" busy={busy} disabled={!cloneName.trim()} error={dlgError} onCancel={close} onConfirm={clone}>
          <Field label="Name of the new group"><Input autoFocus value={cloneName} maxLength={80} onChange={(e) => setCloneName(e.target.value)} /></Field>
          <p>The copy gets the same targets, site, pay week and forecast model. Choose what else comes with it:</p>
          {([['queues', `Queues (${queues.length}), named after the new group; aliases stay with the originals`], ['shrinkage', 'Shrinkage categories'], ['coverage', 'Manual coverage windows']] as const).map(([k, label]) => (
            <label key={k} className="flex items-center gap-2 text-[13px]"><input type="checkbox" checked={copy[k]} onChange={(e) => setCopy({ ...copy, [k]: e.target.checked })} />{label}</label>
          ))}
          <p className="text-[12px] text-[#6B6B6B]">People, forecasts and schedules are not copied.</p>
        </Confirm>
      )}
      {dialog === 'off' && (
        <Confirm title={off ? `Switch ${group.name} on?` : warn ? `${group.name} is still running a schedule` : `Switch ${group.name} off?`} confirmLabel={off ? 'Switch on' : warn ? 'Switch off anyway' : 'Switch off'} danger={!off} reason busy={busy} error={dlgError} onCancel={close} onConfirm={switchOff}>
          {warn ? <p>{warn}</p> : off ? <p>New forecasts and schedules can be made for this group again.</p> : <p>No new forecasts or schedules can be made for this group. Its people, queues, forecasts, schedules and history are kept, and you can switch it on again any time.</p>}
        </Confirm>
      )}
      {dialog === 'delete' && (
        <Confirm title={`Delete ${group.name}?`} confirmLabel="Delete group" danger reason busy={busy} error={dlgError} onCancel={close} onConfirm={remove}>
          <p>Only a group nothing was built on can be deleted. If it has queues, people, forecasts or schedules, switch it off instead: that keeps its history.</p>
        </Confirm>
      )}
    </div>
  );
};
