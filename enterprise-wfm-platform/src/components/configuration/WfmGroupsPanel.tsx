/**
 * Configuration › WFM Groups. A group is a set of queues that share one pool of agents, with the service targets that turn a forecast into a staffing
 * number. The page is a list of groups; opening one shows its settings and tabs for queues, people, shrinkage, manual coverage and history.
 * Saved to the gateway; changing targets recalculates staffing immediately.
 */
import React, { useState } from 'react';
import { FileUp, Plus } from 'lucide-react';
import { api, GroupDto, Queue, Team } from '../../services/api';
import { useForecast } from '../../services/forecastStore';
import { useApi } from '../forecasting/hooks';
import { Banner, Btn } from '../forecasting/ui';
import { DEFAULTS, GroupForm, GroupFormValues, PeopleChoice } from './groups/GroupForm';
import { GroupDetail } from './groups/GroupDetail';
import { GroupList } from './groups/GroupList';
import { ImportGroups } from './groups/ImportGroups';
import { GroupSummary, Site } from './groups/shared';

export const WfmGroupsPanel: React.FC = () => {
  const { can, reloadGroups, setNotice } = useForecast();
  const [tick, setTick] = useState(0);
  const groups = useApi<GroupDto[]>('/config/groups', [tick]);
  const queues = useApi<Queue[]>('/config/queues', [tick]);
  const summary = useApi<Record<string, GroupSummary>>('/config/groups/summary', [tick]);
  const sites = useApi<Site[]>('/config/sites', [tick]);
  const teams = useApi<Team[]>('/workforce/teams?fields=pick&counts=1', [tick]);
  const [openId, setOpenId] = useState<string | null>(null);
  const [mode, setMode] = useState<'list' | 'create' | 'import'>('list');
  const canWrite = can('config:write');
  const open = openId ? groups.data?.find((g) => g.id === openId) : undefined;
  const refresh = async () => { setTick((t) => t + 1); await reloadGroups(); };
  const notify = (kind: 'ok' | 'err', text: string) => setNotice({ kind, text });

  const create = async (v: GroupFormValues, _reason: string, people: PeopleChoice) => {
    const g = await api<GroupDto>('/config/groups', { method: 'POST', body: v });
    let added = 0, problem = '';
    if (people.teamIds.length || people.employees.length) {
      try { added = (await api<{ added: number }>(`/config/groups/${g.id}/members`, { method: 'POST', body: { teamIds: people.teamIds, employeeIds: people.employees.map((e) => e.id) } })).added; }
      catch (e: any) { problem = e.message; }
    }
    notify(problem ? 'err' : 'ok', problem ? `${g.name} was created, but its people could not be added: ${problem} Add them from the People tab.` : `${g.name} created${added ? ` with ${added} ${added === 1 ? 'person' : 'people'}` : ''}. Add its queues next.`);
    setMode('list'); await refresh(); setOpenId(g.id);
  };

  if (groups.error) return <Banner kind="err">{groups.error}</Banner>;

  if (openId && open) {
    return (
      <GroupDetail group={open} summary={summary.data?.[open.id]} sites={sites.data ?? []} teams={teams.data ?? []} queues={(queues.data ?? []).filter((q) => q.wfmGroupId === open.id)}
        canWrite={canWrite} notify={notify} onBack={() => setOpenId(null)} onChanged={refresh} onDeleted={async () => { setOpenId(null); await refresh(); }} onOpen={async (id) => { await refresh(); setOpenId(id); }} />
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-[16px] font-semibold text-[#171717]">WFM Groups</h2>
        {canWrite && mode === 'list' && (
          <div className="flex gap-2">
            <Btn onClick={() => setMode('import')}><FileUp className="w-3.5 h-3.5" />Create from a file</Btn>
            <Btn variant="primary" onClick={() => setMode('create')}><Plus className="w-3.5 h-3.5" />Create WFM Group</Btn>
          </div>
        )}
      </div>

      {mode === 'create' && <GroupForm id={null} initial={DEFAULTS} sites={sites.data ?? []} teams={teams.data ?? []} onSave={create} onCancel={() => setMode('list')} />}
      {mode === 'import' && <ImportGroups onDone={async (n) => { notify('ok', `Created ${n} group${n === 1 ? '' : 's'} from the file.`); await refresh(); }} onCancel={() => setMode('list')} />}

      {summary.error && <Banner kind="warn">The people counts, published forecasts and running schedules could not be loaded ({summary.error}). If the app was just updated, restart the gateway so it picks up the new group screens, then reload this page.</Banner>}

      {groups.data && <GroupList groups={groups.data} summary={summary.data ?? {}} summaryFailed={!!summary.error} sites={sites.data ?? []} canWrite={canWrite} onOpen={setOpenId} onCreate={() => setMode('import')} />}
    </div>
  );
};
