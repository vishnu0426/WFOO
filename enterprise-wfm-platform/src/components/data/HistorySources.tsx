/**
 * Data Management › Data Feeds: the places forecast history comes from (and only those: agent state, HR and CRM connectors are in
 * Configuration › Integration Station). A source is one of five kinds, chosen by what the customer has rather than by vendor or category.
 */
import React, { useEffect, useState } from 'react';
import { Database, FileText, Globe, Plug, Radio, Plus } from 'lucide-react';
import { api, Connector, ConnectorCreated, IntegrationCatalog, IntegrationPreset, when } from '../../services/api';
import { useForecast } from '../../services/forecastStore';
import { useApi } from '../forecasting/hooks';
import { Banner, Btn, Card, Empty, Field, Input, Pill, Select } from '../forecasting/ui';
import { ConnectorDetail, FieldInput } from '../configuration/IntegrationStationPanel';
import { describeSchedule, NO_SCHEDULE, ScheduleEditor, type ScheduleDraft } from './ScheduleEditor';

export type SourceKind = 'PUSH' | 'DATABASE' | 'DATABASE_RELAY' | 'API' | 'FILES';
export type FeedState = 'WAITING' | 'HEALTHY' | 'LATE' | 'REJECTING' | 'FAILING' | 'PAUSED' | 'NOT_SET_UP' | 'CLOSED';
export type FeedConnector = {
  id: string; name: string; kind: SourceKind; category: string; method: string; preset: string; status: string; backfillStatus: string; nextStep: string | null;
  lastReceivedAt: string | null; lastError: string | null; state: FeedState; scheduleMin: number | null; scheduleAt: string | null; scheduleDays: number[] | null;
  nextRunAt: string | null; lastRunAt: string | null; lastRunStatus: string | null; filesNeedAttention: number;
};

export const FEED_TONE: Record<FeedState, 'good' | 'warn' | 'bad' | 'info' | 'neutral'> = { HEALTHY: 'good', WAITING: 'info', LATE: 'warn', REJECTING: 'warn', FAILING: 'bad', PAUSED: 'neutral', NOT_SET_UP: 'neutral', CLOSED: 'neutral' };
export const FEED_LABEL: Record<FeedState, string> = { HEALTHY: 'Healthy', WAITING: 'Waiting for first data', LATE: 'Late', REJECTING: 'Rejecting rows', FAILING: 'Failing', PAUSED: 'Paused', NOT_SET_UP: 'Not started', CLOSED: 'Closed now' };

const KIND: Record<SourceKind, { label: string; icon: React.ReactNode }> = {
  PUSH: { label: 'Pushed to us', icon: <Radio className="w-4 h-4" /> },
  DATABASE: { label: 'Database we read', icon: <Database className="w-4 h-4" /> },
  DATABASE_RELAY: { label: 'Database read by a relay', icon: <Database className="w-4 h-4" /> },
  API: { label: 'REST API we call', icon: <Globe className="w-4 h-4" /> },
  FILES: { label: 'Exported files', icon: <FileText className="w-4 h-4" /> },
};

/** "12 minutes ago" beside the exact time, so a planner can tell at a glance whether a source is current. */
export const ago = (iso: string | null) => {
  if (!iso) return 'never';
  const m = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
  return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : m < 48 * 60 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} days ago`;
};

// ---------------------------------------------------------------- the list of sources

export const SourceCard: React.FC<{
  icon: React.ReactNode; kindLabel: string; name: string; state: FeedState; lastData: string | null; schedule?: string; detail?: React.ReactNode; hint?: string | null;
  action: { label: string; onClick: () => void }; selected?: boolean;
}> = ({ icon, kindLabel, name, state, lastData, schedule, detail, hint, action, selected }) => (
  <div className={`rounded-lg border p-4 space-y-2 ${selected ? 'border-[#171717] bg-[#FAFAF8]' : 'border-[#E5E5E0] bg-white'}`}>
    <div className="flex items-start justify-between gap-2">
      <div className="flex items-center gap-2 min-w-0">
        <span className="w-8 h-8 rounded bg-[#F5F5F2] flex items-center justify-center text-[#525252] shrink-0">{icon}</span>
        <div className="min-w-0"><div className="font-semibold text-[14px] truncate">{name}</div><div className="text-[12px] text-[#6B6B6B]">{kindLabel}</div></div>
      </div>
      <Pill tone={FEED_TONE[state]}>{FEED_LABEL[state]}</Pill>
    </div>
    <div className="text-[12px] text-[#525252] space-y-0.5">
      <div>Last data: <span className="font-semibold">{lastData ? `${ago(lastData)}` : 'none yet'}</span>{lastData && <span className="text-[#6B6B6B]"> · {when(lastData)}</span>}</div>
      {schedule && <div>{schedule}</div>}
      {detail}
    </div>
    {hint && <div className="text-[12px] text-[#8F6200] bg-[#FFF5DD] border border-[#E9D9B4] rounded px-2 py-1">Next: {hint}</div>}
    <div><Btn onClick={action.onClick}>{action.label}</Btn></div>
  </div>
);

export const connectorCard = (c: FeedConnector, onManage: () => void, selected: boolean, tz: string) => (
  <SourceCard key={c.id} icon={KIND[c.kind].icon} kindLabel={KIND[c.kind].label} name={c.name} state={c.state} lastData={c.lastReceivedAt} selected={selected}
    schedule={c.scheduleMin ? `${describeSchedule({ scheduleMin: c.scheduleMin, scheduleAt: c.scheduleAt, scheduleDays: c.scheduleDays })}${c.nextRunAt && c.status === 'ACTIVE' ? ` · next ${when(c.nextRunAt)} (${tz})` : ''}` : undefined}
    detail={<>
      {c.state === 'FAILING' && c.lastError && <div className="text-[#B42318] font-semibold">{c.lastError}</div>}
      {c.filesNeedAttention > 0 && <div className="text-[#8F6200] font-semibold">{c.filesNeedAttention} file{c.filesNeedAttention === 1 ? '' : 's'} need{c.filesNeedAttention === 1 ? 's' : ''} attention</div>}
    </>}
    hint={c.nextStep} action={{ label: selected ? 'Hide settings' : 'Settings, schedule and runs', onClick: onManage }} />
);

// ---------------------------------------------------------------- adding a source

type Choice = { id: string; title: string; text: string; icon: React.ReactNode; category: string; preset: string };
const CHOICES: Choice[] = [
  { id: 'postgres', title: 'I have a PostgreSQL database', text: 'We read it on a schedule with a read-only login and a query you write.', icon: <Database className="w-5 h-5" />, category: 'DATABASE', preset: 'DATABASE_POSTGRES_PULL' },
  { id: 'otherdb', title: 'I have another kind of database', text: 'Oracle, SQL Server, Informix and others. A small relay inside your network reads it and sends us the rows.', icon: <Database className="w-5 h-5" />, category: 'DATABASE', preset: 'GENERIC_DATABASE' },
  { id: 'api', title: 'I have a REST API', text: 'We call it on a schedule with your key and read the rows it returns.', icon: <Globe className="w-5 h-5" />, category: 'ACD', preset: 'GENERIC_ACD_API' },
  { id: 'files', title: 'I get exported files', text: 'We pick up new CSV files from your SFTP server and stage each one for review.', icon: <FileText className="w-5 h-5" />, category: 'SFTP', preset: 'GENERIC_SFTP' },
  { id: 'script', title: 'A script of ours will send the data', text: 'We give your team a key. Their script posts the history and recent intervals to us.', icon: <Plug className="w-5 h-5" />, category: 'ACD', preset: 'GENERIC_ACD_RELAY' },
];

const Chooser: React.FC<{ catalog: IntegrationCatalog; groups: { id: string; name: string }[]; onPush: () => void; onCreated: (c: ConnectorCreated) => void; onCancel: () => void; onError: (m: string) => void }> = ({ catalog, groups, onPush, onCreated, onCancel, onError }) => {
  const { session } = useForecast();
  const [picked, setPicked] = useState<Choice | null>(null);
  const [name, setName] = useState('');
  const [groupId, setGroupId] = useState('');
  const [config, setConfig] = useState<Record<string, string>>({});
  const [schedule, setSchedule] = useState<ScheduleDraft>(NO_SCHEDULE);
  const [busy, setBusy] = useState(false);
  const preset: IntegrationPreset | undefined = picked ? (catalog[picked.category] ?? []).find((p) => p.id === picked.preset) : undefined;
  useEffect(() => { setConfig({}); setSchedule(NO_SCHEDULE); setName(''); }, [picked?.id]);

  const create = async () => {
    if (!picked) return;
    setBusy(true);
    try {
      const c = await api<ConnectorCreated>('/integrations', { method: 'POST', body: { category: picked.category, preset: picked.preset, name: name.trim() || picked.title.replace(/^I have (a |an )?/, '').replace(/^A script of ours/, 'Script feed'), wfmGroupId: groupId || null, config, ...(preset?.canPull && (schedule.scheduleAt || schedule.scheduleMin) ? schedule : {}) } });
      onCreated(c);
    } catch (e: any) { onError(e.message); } finally { setBusy(false); }
  };

  return (
    <Card title="Add a source of history" sub="What do you have? Pick the one that matches how your phone system or contact centre data is kept." actions={<Btn onClick={onCancel}>Cancel</Btn>}>
      <div className="space-y-4">
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
          <button className="text-left rounded-lg border border-[#E5E5E0] bg-white hover:bg-[#FAFAF8] p-4 space-y-1" onClick={onPush}>
            <div className="flex items-center gap-2 font-semibold text-[14px]"><Radio className="w-5 h-5" />My phone system sends data to you</div>
            <div className="text-[12px] text-[#6B6B6B]">Nothing to set up here. Your phone system calls our address with each finished interval. The address and a way to test it are under “For your IT team”.</div>
          </button>
          {CHOICES.map((c) => (
            <button key={c.id} onClick={() => setPicked(c)}
              className={`text-left rounded-lg border p-4 space-y-1 ${picked?.id === c.id ? 'border-[#171717] bg-[#FAFAF8]' : 'border-[#E5E5E0] bg-white hover:bg-[#FAFAF8]'}`}>
              <div className="flex items-center gap-2 font-semibold text-[14px]">{c.icon}{c.title}</div>
              <div className="text-[12px] text-[#6B6B6B]">{c.text}</div>
            </button>
          ))}
        </div>

        {picked && preset && (
          <div className="border border-[#E5E5E0] rounded-lg p-4 space-y-4">
            <div className="text-[13px] font-semibold">{picked.title}</div>
            {preset.note && <p className="text-[12px] text-[#525252] bg-[#FAFAF8] border border-[#E5E5E0] rounded p-2">{preset.note}</p>}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <Field label="Name"><Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Nightly call history" /></Field>
              <Field label="Which group's queues" hint="Leave on all groups unless this source only covers one."><Select value={groupId} onChange={(e) => setGroupId(e.target.value)}><option value="">All groups</option>{groups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}</Select></Field>
            </div>
            {preset.fields.length > 0 && (
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                {preset.fields.map((f) => (
                  <div key={f.key} className={f.kind === 'textarea' ? 'md:col-span-3' : ''}>
                    <Field label={f.label + (f.required ? ' *' : '')} hint={f.help}><FieldInput f={f} value={config[f.key] ?? ''} onChange={(v) => setConfig((s) => ({ ...s, [f.key]: v }))} /></Field>
                  </div>
                ))}
              </div>
            )}
            {preset.fields.length === 0 && <p className="text-[12px] text-[#6B6B6B]">No details to enter. We issue a key when you create it, and your team’s script uses it.</p>}
            {preset.canPull && (
              <div className="space-y-1">
                <div className="text-[12px] font-semibold">When should we fetch it?</div>
                <ScheduleEditor value={schedule} onChange={setSchedule} timezone={session.tenant.timezone} />
                <p className="text-[12px] text-[#6B6B6B]">It starts once the source is set to Active.</p>
              </div>
            )}
            <Btn variant="primary" disabled={busy} onClick={create}>{busy ? 'Creating…' : 'Create source'}</Btn>
          </div>
        )}
      </div>
    </Card>
  );
};

// ---------------------------------------------------------------- the whole panel

export const SourcesManager: React.FC<{
  connectors: FeedConnector[]; timezone: string; phoneCard: React.ReactNode; onShowPush: () => void; onChanged: () => void;
}> = ({ connectors, timezone, phoneCard, onShowPush, onChanged }) => {
  const { groups, can } = useForecast();
  const canWrite = can('config:write');
  const catalog = useApi<IntegrationCatalog>('/integrations/catalog');
  const [adding, setAdding] = useState(false);
  const [selected, setSelected] = useState('');
  const [created, setCreated] = useState<ConnectorCreated | null>(null);
  const [error, setError] = useState('');
  const [tick, setTick] = useState(0);
  const detail = useApi<Connector>(selected ? `/integrations/${selected}` : null, [selected, tick]);

  const run = async (fn: () => Promise<void>) => { setError(''); try { await fn(); setTick((t) => t + 1); onChanged(); } catch (e: any) { setError(e.message); } };

  return (
    <div className="space-y-4">
      {created && (
        <Banner kind="ok" onClose={() => setCreated(null)}>
          <div className="space-y-1">
            <div className="font-semibold">“{created.name}” created.{created.apiKey ? ' Save this key now: it will not be shown again.' : ''}</div>
            {created.apiKey && <div className="font-mono text-[12px] bg-white/60 rounded px-2 py-1 select-all">{created.apiKey}</div>}
            {created.apiKey && <div className="text-[12px]">Your team posts to <span className="font-mono">/api/v1/integrations/{created.id}/live</span> (and <span className="font-mono">/backfill</span> for history) with <span className="font-mono">Authorization: Bearer &lt;key&gt;</span>.</div>}
          </div>
        </Banner>
      )}
      {error && <Banner kind="err" onClose={() => setError('')}>{error}</Banner>}

      <div className="flex items-center justify-between">
        <div className="text-[14px] font-semibold">Where your history comes from</div>
        {canWrite && !adding && <Btn variant="primary" onClick={() => { setAdding(true); setSelected(''); }}><Plus className="w-3.5 h-3.5" />Add a source</Btn>}
      </div>

      {adding && catalog.data && (
        <Chooser catalog={catalog.data} groups={groups} onError={setError} onCancel={() => setAdding(false)} onPush={() => { setAdding(false); onShowPush(); }}
          onCreated={(c) => { setAdding(false); setCreated(c); setSelected(c.id); onChanged(); }} />
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 xl:grid-cols-3 gap-3">
        {phoneCard}
        {connectors.map((c) => connectorCard(c, () => setSelected(selected === c.id ? '' : c.id), selected === c.id, timezone))}
      </div>
      {connectors.length === 0 && !adding && <Empty title="No other sources yet">Add a database, an API, a folder of files or a script. The direct feed above works without one.</Empty>}

      {selected && detail.data && (
        <div id="source-detail">
          <ConnectorDetail feeds connector={detail.data} catalog={catalog.data ?? null} canWrite={canWrite} onChanged={() => { setTick((t) => t + 1); onChanged(); }}
            onDeleted={() => { setSelected(''); onChanged(); }} onError={setError} run={run} />
        </div>
      )}
    </div>
  );
};
