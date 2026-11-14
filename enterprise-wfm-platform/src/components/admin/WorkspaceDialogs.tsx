/**
 * Administration › Workspaces: the dialogs to create and to change a workspace.
 * Creating asks for little: a name, and optionally a country (its time zone, currency, holidays, working week and labour-law pack are filled in) or an existing workspace to start from
 * (its setup is copied, never its people, schedules or history), and who manages it. The code and web address are made from the name and only shown under "Advanced".
 * Changing one lets you rename it and archive it (hidden, nothing deleted) or bring it back.
 */
import React, { useMemo, useState } from 'react';
import { X } from 'lucide-react';
import { api, LicenseUsageReport, Session, Workspace } from '../../services/api';
import { useApi } from '../forecasting/hooks';
import { Banner, Btn, Field, Input, Select } from '../forecasting/ui';

type Country = { code: string; name: string };
type Defaults = { code: string; name: string; timezone: string | null; currency: string | null; compliancePack: { code: string; name: string } | null; holidaysThisYear: number };
type UserRow = { id: string; userName: string; username: string; role: string; status: string };
export type Created = Workspace & { setup?: { copied: string[]; holidaysAdded: number; packName: string | null; failed: string | null } };

const COPY_ITEMS: [string, string][] = [['shiftTemplates', 'Shift templates'], ['schedulingRules', 'Scheduling rules'], ['holidays', 'Holidays'], ['labourLawPacks', 'Labour-law packs'], ['skills', 'Skills']];
const ROLE: Record<string, string> = { WFM_ADMIN: 'Administrator', WFM_MANAGER: 'Manager', FORECAST_PLANNER: 'Forecast planner', SCHEDULER: 'Scheduler', SUPERVISOR_RTA: 'Supervisor', ANALYST: 'Analyst', AGENT: 'Agent' };

const Shell: React.FC<{ title: string; sub?: string; onClose: () => void; children: React.ReactNode; footer: React.ReactNode }> = ({ title, sub, onClose, children, footer }) => (
  <div className="fixed inset-0 bg-black/40 flex items-center justify-center p-4 z-50" role="dialog" aria-modal="true" aria-label={title}>
    <div className="bg-white rounded-lg border border-[#E5E5E0] shadow-2xl w-full max-w-xl max-h-[92vh] flex flex-col">
      <div className="px-6 pt-5 pb-3 border-b border-[#E5E5E0] flex items-start justify-between gap-3">
        <div><h3 className="text-[16px] font-semibold text-[#171717]">{title}</h3>{sub && <p className="text-[12px] text-[#6B6B6B] mt-0.5">{sub}</p>}</div>
        <button aria-label="Close" onClick={onClose} className="text-[#737373] hover:text-[#171717]"><X className="w-4 h-4" /></button>
      </div>
      <div className="px-6 py-4 space-y-4 overflow-y-auto">{children}</div>
      <div className="px-6 py-3.5 border-t border-[#E5E5E0] flex items-center justify-end gap-2">{footer}</div>
    </div>
  </div>
);

export const CreateWorkspaceDialog: React.FC<{ session: Session; workspaces: Workspace[]; onClose: () => void; onCreated: (w: Created) => void }> = ({ session, workspaces, onClose, onCreated }) => {
  const countries = useApi<Country[]>('/holidays/countries');
  const users = useApi<UserRow[]>('/users');
  const license = useApi<LicenseUsageReport>('/license');
  const [name, setName] = useState('');
  const [country, setCountry] = useState('');
  const [mode, setMode] = useState<'EMPTY' | 'COPY'>('EMPTY');
  const [copyFrom, setCopyFrom] = useState('');
  const [copy, setCopy] = useState<Record<string, boolean>>(Object.fromEntries(COPY_ITEMS.map(([k]) => [k, true])));
  const [addHolidays, setAddHolidays] = useState(true);
  const [applyPack, setApplyPack] = useState(true);
  const [admins, setAdmins] = useState<string[]>([]);
  const [code, setCode] = useState('');
  const [slug, setSlug] = useState('');
  const [description, setDescription] = useState('');
  const [timezone, setTimezone] = useState('');
  const [currency, setCurrency] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const defaults = useApi<Defaults>(country ? `/config/country-defaults?country=${country}` : null, [country]);
  const zones = useMemo(() => { try { return (Intl as any).supportedValuesOf('timeZone') as string[]; } catch { return ['UTC', 'Asia/Kolkata', 'Europe/London', 'America/New_York']; } }, []);

  const cap = license.data?.capacity?.workspaces;
  const full = !!cap && cap.remaining <= 0;
  const sources = workspaces.filter((w) => w.status === 'ACTIVE');
  const d = defaults.data;
  const effTz = timezone || d?.timezone || session.tenant.timezone;
  const effCur = currency || d?.currency || session.tenant.currency;
  const people = (users.data ?? []).filter((u) => u.status === 'ACTIVE' && u.id !== session.user.id && !admins.includes(u.id));
  const ready = name.trim().length > 0 && !full && (mode === 'EMPTY' || !!copyFrom);

  const create = async () => {
    setBusy(true); setError('');
    try {
      const body: any = {
        name: name.trim(), ...(country ? { country } : {}), ...(description.trim() ? { description: description.trim() } : {}),
        ...(timezone ? { timezone } : {}), ...(currency ? { currency: currency.toUpperCase() } : {}), ...(code.trim() ? { code: code.trim().toUpperCase() } : {}), ...(slug.trim() ? { slug: slug.trim().toLowerCase() } : {}),
        addHolidays, applyPack, adminUserIds: admins,
        ...(mode === 'COPY' ? { copyFromWorkspaceId: copyFrom, copy } : {}),
      };
      onCreated(await api<Created>('/workspaces', { method: 'POST', body }));
    } catch (e: any) { setError(e.message); } finally { setBusy(false); }
  };

  return (
    <Shell title="New workspace" sub="A separate operation with its own queues, schedules and people. To add a new location, add a site instead (Configuration › Organisation)." onClose={onClose}
      footer={<><Btn onClick={onClose}>Cancel</Btn><Btn variant="primary" onClick={create} disabled={!ready || busy}>{busy ? 'Creating…' : 'Create workspace'}</Btn></>}>
      {error && <Banner kind="err" onClose={() => setError('')}>{error}</Banner>}
      {cap && <p className={`text-[12px] ${full ? 'text-[#BC3F3F]' : 'text-[#6B6B6B]'}`}>{full ? `Your plan allows ${cap.max} workspace${cap.max === 1 ? '' : 's'} and all are in use. Archive one, or ask for a plan change.` : `You are using ${cap.current} of ${cap.max} workspaces.`}</p>}

      <Field label="Workspace name"><Input autoFocus value={name} maxLength={120} onChange={(e) => setName(e.target.value)} placeholder="EMEA Customer Care" /></Field>
      <Field label="Country" hint="Optional. Fills in the time zone, currency, holidays, working week and labour-law pack.">
        <Select value={country} onChange={(e) => setCountry(e.target.value)}><option value="">No country: use the organisation's settings</option>{(countries.data ?? []).map((c) => <option key={c.code} value={c.code}>{c.name}</option>)}</Select>
      </Field>

      <fieldset className="space-y-2">
        <legend className="text-[12px] font-semibold text-[#171717] mb-1">Start from</legend>
        <div className="grid grid-cols-2 gap-2" role="radiogroup" aria-label="Start from">
          {([['EMPTY', 'Empty', 'Set it up as you go'], ['COPY', 'Another workspace', 'Copy its setup, not its people']] as const).map(([k, t, s]) => (
            <button key={k} type="button" role="radio" aria-checked={mode === k} disabled={k === 'COPY' && sources.length === 0} onClick={() => setMode(k)}
              className={`text-left rounded-lg border p-3 ${mode === k ? 'border-[#171717] ring-1 ring-[#171717]' : 'border-[#E5E5E0] hover:border-[#A3A3A3]'} disabled:opacity-50`}>
              <div className="text-[13px] font-semibold">{t}</div><div className="text-[12px] text-[#6B6B6B]">{s}</div>
            </button>
          ))}
        </div>
        {mode === 'COPY' && (
          <div className="border border-[#E5E5E0] rounded-lg p-3 space-y-2 bg-[#FAFAF8]">
            <Field label="Copy from"><Select value={copyFrom} onChange={(e) => setCopyFrom(e.target.value)}><option value="">Choose a workspace</option>{sources.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}</Select></Field>
            <div className="text-[12px] font-semibold">What to copy</div>
            <div className="grid grid-cols-2 gap-x-4 gap-y-1">
              {COPY_ITEMS.map(([k, l]) => <label key={k} className="flex items-center gap-2 text-[13px]"><input type="checkbox" checked={copy[k]} onChange={(e) => setCopy({ ...copy, [k]: e.target.checked })} />{l}</label>)}
            </div>
            <p className="text-[12px] text-[#6B6B6B]">People, WFM groups, schedules, forecasts and history are never copied.</p>
          </div>
        )}
        {mode === 'EMPTY' && country && d && (
          <div className="border border-[#E5E5E0] rounded-lg p-3 space-y-1.5 bg-[#FAFAF8]">
            <div className="text-[12px] text-[#525252]">It will start with the time zone <strong>{effTz}</strong> and the currency <strong>{effCur}</strong>.</div>
            <label className="flex items-start gap-2 text-[13px]"><input type="checkbox" className="mt-0.5" checked={addHolidays && d.holidaysThisYear > 0} disabled={d.holidaysThisYear === 0} onChange={(e) => setAddHolidays(e.target.checked)} /><span>Add {d.name}'s public holidays{d.holidaysThisYear ? ` (${d.holidaysThisYear} this year and next year's)` : ''}</span></label>
            <label className="flex items-start gap-2 text-[13px]"><input type="checkbox" className="mt-0.5" checked={applyPack && !!d.compliancePack} disabled={!d.compliancePack} onChange={(e) => setApplyPack(e.target.checked)} /><span>{d.compliancePack ? `Use the ${d.compliancePack.name} labour-law pack` : 'No ready-made labour-law pack for this country'}</span></label>
          </div>
        )}
      </fieldset>

      <div className="space-y-2">
        <div className="text-[12px] font-semibold text-[#171717]">Who manages it</div>
        <p className="text-[12px] text-[#6B6B6B]">You are added automatically. Add anyone else who should be able to work in it; more can be added later.</p>
        <div className="flex flex-wrap gap-1.5">{admins.map((id) => { const u = users.data?.find((x) => x.id === id); return <span key={id} className="inline-flex items-center gap-1 text-[12px] bg-[#F0F4F8] border border-[#D6DEE8] rounded-full pl-2.5 pr-1.5 py-0.5">{u?.userName ?? 'User'}<button type="button" aria-label={`Remove ${u?.userName}`} onClick={() => setAdmins(admins.filter((x) => x !== id))}><X className="w-3 h-3" /></button></span>; })}</div>
        {people.length > 0 && <Select aria-label="Add a person" value="" onChange={(e) => e.target.value && setAdmins([...admins, e.target.value])}><option value="">Add a person…</option>{people.map((u) => <option key={u.id} value={u.id}>{u.userName} ({ROLE[u.role] ?? u.role})</option>)}</Select>}
      </div>

      <details className="text-[13px]">
        <summary className="cursor-pointer text-[#525252]">Advanced settings</summary>
        <div className="mt-3 grid grid-cols-2 gap-3">
          <Field label="Code" hint={name.trim() ? 'Made from the name when blank' : undefined}><Input value={code} maxLength={40} onChange={(e) => setCode(e.target.value.toUpperCase())} placeholder="EMEA_CC" /></Field>
          <Field label="Web address" hint="Lowercase letters, numbers and dashes"><Input value={slug} maxLength={60} onChange={(e) => setSlug(e.target.value.toLowerCase())} placeholder="emea-customer-care" /></Field>
          <Field label="Time zone" hint="New WFM groups start with it"><Input list="ws-zones" value={timezone} onChange={(e) => setTimezone(e.target.value)} placeholder={effTz} /><datalist id="ws-zones">{zones.map((z) => <option key={z} value={z} />)}</datalist></Field>
          <Field label="Currency"><Input value={currency} maxLength={3} onChange={(e) => setCurrency(e.target.value.toUpperCase())} placeholder={effCur} /></Field>
          <div className="col-span-2"><Field label="Description"><Input value={description} maxLength={500} onChange={(e) => setDescription(e.target.value)} placeholder="What this operation is for" /></Field></div>
        </div>
      </details>
    </Shell>
  );
};

export const EditWorkspaceDialog: React.FC<{ workspace: Workspace; current: boolean; onClose: () => void; onChanged: (message: string) => void }> = ({ workspace, current, onClose, onChanged }) => {
  const [name, setName] = useState(workspace.name);
  const [description, setDescription] = useState(workspace.description ?? '');
  const [timezone, setTimezone] = useState(workspace.timezone);
  const [currency, setCurrency] = useState(workspace.currency);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const zones = useMemo(() => { try { return (Intl as any).supportedValuesOf('timeZone') as string[]; } catch { return ['UTC']; } }, []);
  const archived = workspace.status === 'ARCHIVED';
  const dirty = name.trim() !== workspace.name || description !== (workspace.description ?? '') || timezone !== workspace.timezone || currency !== workspace.currency;
  const run = async (fn: () => Promise<unknown>, msg: string) => { setBusy(true); setError(''); try { await fn(); onChanged(msg); } catch (e: any) { setError(e.message); } finally { setBusy(false); } };

  return (
    <Shell title={`Edit ${workspace.name}`} onClose={onClose}
      footer={<><Btn onClick={onClose}>Close</Btn><Btn variant="primary" disabled={!dirty || busy || !name.trim()} onClick={() => run(() => api(`/workspaces/${workspace.id}`, { method: 'PATCH', body: { name: name.trim(), description, timezone, currency: currency.toUpperCase() } }), 'Workspace updated.')}>{busy ? 'Saving…' : 'Save changes'}</Btn></>}>
      {error && <Banner kind="err" onClose={() => setError('')}>{error}</Banner>}
      <Field label="Workspace name"><Input value={name} maxLength={120} onChange={(e) => setName(e.target.value)} /></Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Time zone" hint="New WFM groups start with it. Existing groups keep their own."><Input list="ws-edit-zones" value={timezone} onChange={(e) => setTimezone(e.target.value)} /><datalist id="ws-edit-zones">{zones.map((z) => <option key={z} value={z} />)}</datalist></Field>
        <Field label="Currency"><Input value={currency} maxLength={3} onChange={(e) => setCurrency(e.target.value.toUpperCase())} /></Field>
      </div>
      <Field label="Description"><Input value={description} maxLength={500} onChange={(e) => setDescription(e.target.value)} /></Field>
      <div className="text-[12px] text-[#6B6B6B]">Code <span className="font-mono">{workspace.code}</span> · address <span className="font-mono">/{workspace.slug}</span>. These are fixed once a workspace exists, because links and integrations use them.</div>

      <div className="border-t border-[#E5E5E0] pt-3 space-y-2">
        <div className="text-[13px] font-semibold text-[#171717]">{archived ? 'This workspace is archived' : 'Archive this workspace'}</div>
        <p className="text-[12px] text-[#525252]">{archived ? 'It is hidden and nobody can open it. Everything in it is kept. Restore it to use it again (it counts against your plan again).' : 'Archiving hides it from the workspace list and stops anyone opening it. Nothing is deleted, and you can restore it at any time. It stops counting against your plan.'}</p>
        {!archived && (workspace.isDefault ? <p className="text-[12px] text-[#8F6200]">This is the default workspace. Make another workspace the default before archiving it.</p> : current ? <p className="text-[12px] text-[#8F6200]">You are working in this workspace. Switch to another one first.</p> : null)}
        {archived
          ? <Btn disabled={busy} onClick={() => run(() => api(`/workspaces/${workspace.id}/restore`, { method: 'POST' }), 'Workspace restored.')}>Restore workspace</Btn>
          : <Btn disabled={busy || workspace.isDefault || current} onClick={() => confirm(`Archive "${workspace.name}"? Nothing is deleted and you can restore it.`) && run(() => api(`/workspaces/${workspace.id}/archive`, { method: 'POST' }), 'Workspace archived.')}>Archive workspace</Btn>}
      </div>
    </Shell>
  );
};
