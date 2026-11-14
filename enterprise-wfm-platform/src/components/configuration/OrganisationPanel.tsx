/**
 * Configuration › Organisation. Where the organisation is laid out: regions, sites and the WFM groups at each, with the teams and people that belong to them.
 * The tree on the left is for finding your way; everything is done on the right, in the context of what is picked. A site is a small workspace of its own: a setup checklist that says what is
 * left to do, and tabs for its groups, teams, people, rules and settings, each with the "add" action where the customer needs it. Nothing is hidden behind another screen.
 */
import { Waiting, LoadFailed } from '../common/loading';
import React, { useEffect, useMemo, useState } from 'react';
import { Check, ChevronDown, ChevronRight, Circle, Globe2, MapPin, Plus, Users } from 'lucide-react';
import { api } from '../../services/api';
import { useForecast } from '../../services/forecastStore';
import { useApi } from '../forecasting/hooks';
import { PersonPicker } from '../common/PersonPicker';
import { Banner, Btn, Busy, Card, Empty, Field, Input, Kpi, KpiRow, Pill, Select } from '../forecasting/ui';
import { HelpSection, PageHelp } from '../common/HelpTip';

type Site = {
  id: string; name: string; code: string; timezone: string; country: string; countryCode: string; regionId: string | null; regionName: string | null; address: string; status: 'ACTIVE' | 'CLOSED'; closedOn: string | null;
  managerId: string | null; managerName: string | null; packName: string | null; holidays: number; groups: { id: string; name: string }[]; people: number;
};
type Region = { id: string; name: string };
type GroupNode = { id: string; name: string; status: string; siteId: string | null; timezone: string; queues: number; people: number; teams: { name: string; n: number }[] };
type TeamNode = { id: string; name: string; siteId: string | null; supervisor: string | null; people: number };
type Structure = { regions: Region[]; sites: Site[]; groups: GroupNode[]; unplacedPeople: number; teams: TeamNode[]; teamPlaces: { siteId: string; teamId: string; people: number }[] };
type Country = { code: string; name: string };
type Defaults = { code: string; name: string; timezones: string[]; timezone: string | null; compliancePack: { code: string; name: string } | null; holidaysThisYear: number };
type Pack = { id: string; name: string };
type Assignment = { scopeType: string; scopeId: string | null; packId: string; packName: string };
type Pick = { kind: 'org' } | { kind: 'region' | 'site' | 'group' | 'newSite' | 'newRegion' | 'noSite'; id?: string; regionId?: string };
type Ctx = {
  d: Structure; canWrite: boolean; countries: Country[]; packs: Pack[]; assigns: Assignment[]; reload: () => void; notify: (m: string) => void; fail: (m: string) => void;
  select: (p: Pick) => void; go: (sub: string, module?: string) => void; tick: number;
};

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const localTime = (tz: string) => { try { return new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date()); } catch { return ''; } };
const groupsAt = (d: Structure, siteId: string | null) => d.groups.filter((g) => (g.siteId ?? null) === siteId);

/** What is left to do at a site, as the checklist shows it. */
const setupSteps = (s: Site, d: Structure) => [
  { id: 'country', label: 'Country and time zone', done: !!s.countryCode, hint: 'Choose the country so its holidays and labour-law rules can be offered', tab: 'settings' as const, action: 'Choose a country' },
  { id: 'holidays', label: 'Public holidays', done: s.holidays > 0, hint: s.countryCode ? `Add ${s.country}'s public holidays for this site` : 'Needs a country first', tab: 'rules' as const, action: 'Add holidays' },
  { id: 'pack', label: 'Labour-law pack', done: !!s.packName, hint: 'So schedules for this site are checked against the local rules', tab: 'rules' as const, action: 'Choose a pack' },
  { id: 'groups', label: 'A WFM group', done: groupsAt(d, s.id).length > 0, hint: 'People who share a schedule work in a group', tab: 'groups' as const, action: 'Add a group' },
  { id: 'people', label: 'People', done: s.people > 0, hint: 'Add the people who work here', tab: 'people' as const, action: 'Add people' },
];

// ---------------------------------------------------------------- the site form, for a new site and for changing one

type FormState = { name: string; regionId: string; countryCode: string; country: string; timezone: string; address: string; managerId: string; managerName: string };
const BLANK: FormState = { name: '', regionId: '', countryCode: '', country: '', timezone: '', address: '', managerId: '', managerName: '' };

const SiteForm: React.FC<{
  site: Site | null; presetRegionId?: string; sites: Site[]; regions: Region[]; countries: Country[]; canWrite: boolean;
  onSaved: (s: Site, message: string) => void; onCancel?: () => void; reload: () => void;
}> = ({ site, presetRegionId, sites, regions, countries, canWrite, onSaved, onCancel, reload }) => {
  const [f, setF] = useState<FormState>(() => site ? { name: site.name, regionId: site.regionId ?? '', countryCode: site.countryCode, country: site.country, timezone: site.timezone, address: site.address, managerId: site.managerId ?? '', managerName: site.managerName ?? '' } : { ...BLANK, regionId: presetRegionId ?? '' });
  const [touchedZone, setTouchedZone] = useState(!!site);
  const [newRegion, setNewRegion] = useState<string | null>(null);
  const [copyFrom, setCopyFrom] = useState('');
  const [addHolidays, setAddHolidays] = useState(true);
  const [applyPack, setApplyPack] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const defaults = useApi<Defaults>(f.countryCode ? `/config/country-defaults?country=${f.countryCode}` : null, [f.countryCode]);
  const zones = useMemo(() => { try { return (Intl as any).supportedValuesOf('timeZone') as string[]; } catch { return ['UTC', 'Asia/Kolkata', 'Europe/London', 'America/New_York']; } }, []);
  const orderedZones = useMemo(() => [...(defaults.data?.timezones ?? []), ...zones.filter((z) => !defaults.data?.timezones.includes(z))], [zones, defaults.data]);
  // choosing a country suggests its time zone, until the person has chosen one themselves
  useEffect(() => { if (!touchedZone && defaults.data?.timezone) setF((s) => ({ ...s, timezone: defaults.data!.timezone! })); }, [defaults.data?.code]);

  const copying = !!copyFrom && !site;
  const country = defaults.data;
  const ready = f.name.trim().length > 0 && f.timezone.trim().length > 0;

  const addRegion = async () => {
    if (!newRegion?.trim()) return;
    try { const r = await api<Region>('/config/regions', { method: 'POST', body: { name: newRegion.trim() } }); setF((s) => ({ ...s, regionId: r.id })); setNewRegion(null); reload(); } catch (e: any) { setError(e.message); }
  };
  const save = async () => {
    setBusy(true); setError('');
    const body = { name: f.name.trim(), timezone: f.timezone.trim(), country: f.country, countryCode: f.countryCode, regionId: f.regionId || null, address: f.address.trim(), managerId: f.managerId || null, ...(site ? { status: site.status } : {}) };
    try {
      if (site) { const s = await api<Site>(`/config/sites/${site.id}`, { method: 'PUT', body }); onSaved(s, 'Changes saved.'); }
      else {
        const s = await api<Site & { setup: { holidaysAdded: number; packName: string | null; copied: string | null } }>('/config/sites', {
          method: 'POST', body: { ...body, setup: { addHolidays: !copying && addHolidays && !!f.countryCode, applyPack: !copying && applyPack && !!country?.compliancePack, copyFromSiteId: copyFrom || null } } });
        const bits = [s.setup.copied ? `Copied ${s.setup.copied}'s holidays and labour-law pack` : '', !s.setup.copied && s.setup.holidaysAdded ? `added ${plural(s.setup.holidaysAdded, 'public holiday')}` : '', s.setup.packName ? `applied the ${s.setup.packName} labour-law pack` : ''].filter(Boolean);
        onSaved(s, `${s.name} is ready${bits.length ? `: ${bits.join(', ')}` : ''}.`);
      }
    } catch (e: any) { setError(e.message); } finally { setBusy(false); }
  };

  return (
    <div className="space-y-4">
      {error && <Banner kind="err" onClose={() => setError('')}>{error}</Banner>}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 items-start max-w-3xl">
        <Field label="Country" hint="Fills in the time zone and offers the country's holidays and labour-law rules">
          <Select disabled={!canWrite} value={f.countryCode} onChange={(e) => { const c = countries.find((x) => x.code === e.target.value); setF({ ...f, countryCode: e.target.value, country: c?.name ?? '' }); }}>
            <option value="">Choose a country</option>{countries.map((c) => <option key={c.code} value={c.code}>{c.name}</option>)}
          </Select>
        </Field>
        <Field label="Site name"><Input disabled={!canWrite} value={f.name} maxLength={80} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="Chennai" autoFocus={!site} /></Field>
        <Field label="Time zone" hint={country?.timezones.length ? `Suggested for ${country.name}: ${country.timezones[0]}` : 'Where this site\'s days begin and end'}>
          <Input disabled={!canWrite} list="org-zones" value={f.timezone} onChange={(e) => { setTouchedZone(true); setF({ ...f, timezone: e.target.value }); }} placeholder="Asia/Kolkata" />
          <datalist id="org-zones">{orderedZones.map((z) => <option key={z} value={z} />)}</datalist>
        </Field>
        <Field label="Region" hint={regions.length || newRegion !== null ? 'Optional: a group of sites, such as EMEA' : 'Optional. Add one if you want to group sites'}>
          {newRegion === null ? (
            <Select disabled={!canWrite} value={f.regionId} onChange={(e) => (e.target.value === '__new__' ? setNewRegion('') : setF({ ...f, regionId: e.target.value }))}>
              <option value="">No region</option>{regions.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}<option value="__new__">+ New region…</option>
            </Select>
          ) : (
            <div className="flex gap-2"><Input autoFocus value={newRegion} maxLength={80} onChange={(e) => setNewRegion(e.target.value)} placeholder="EMEA" /><Btn onClick={addRegion} disabled={!newRegion.trim()}>Add</Btn><Btn onClick={() => setNewRegion(null)}>Cancel</Btn></div>
          )}
        </Field>
        <Field label="Site manager" hint="Optional: who runs this site">
          <PersonPicker ariaLabel="Site manager" statuses="ONBOARDING,ACTIVE,LEAVE" value={f.managerId} onChange={(id, p) => setF({ ...f, managerId: id, managerName: p ? `${p.firstName} ${p.lastName}` : '' })} placeholder={f.managerName || 'Choose a person'} />
        </Field>
        <Field label="Address" hint="Optional"><Input disabled={!canWrite} value={f.address} maxLength={300} onChange={(e) => setF({ ...f, address: e.target.value })} /></Field>
      </div>

      {!site && canWrite && (
        <div className="border border-[#E5E5E0] rounded-lg p-4 space-y-3 max-w-3xl bg-[#FAFAF8]">
          <div className="text-[13px] font-semibold text-[#171717]">Get this site ready</div>
          {sites.length > 0 && (
            <Field label="Start from" hint="Copy another site's holidays and labour-law pack instead of starting empty">
              <Select value={copyFrom} onChange={(e) => setCopyFrom(e.target.value)}><option value="">Nothing: set it up from the country</option>{sites.filter((x) => x.status === 'ACTIVE').map((x) => <option key={x.id} value={x.id}>A copy of {x.name}</option>)}</Select>
            </Field>
          )}
          {!copying && (
            <>
              {!f.countryCode && <p className="text-[12px] text-[#6B6B6B]">Choose a country above and this offers its public holidays and labour-law pack.</p>}
              {f.countryCode && defaults.loading && !defaults.data && <p className="text-[12px] text-[#6B6B6B]">Looking up {f.country}…</p>}
              {country && (
                <>
                  <label className="flex items-start gap-2 text-[13px]"><input type="checkbox" className="mt-0.5" checked={addHolidays} disabled={country.holidaysThisYear === 0} onChange={(e) => setAddHolidays(e.target.checked)} />
                    <span>Add {country.name}'s public holidays for this site<span className="block text-[12px] text-[#6B6B6B]">{country.holidaysThisYear ? `${plural(country.holidaysThisYear, 'holiday')} this year, and next year's too. You can change them later.` : 'No public holidays are listed for this country.'}</span></span></label>
                  <label className="flex items-start gap-2 text-[13px]"><input type="checkbox" className="mt-0.5" checked={applyPack && !!country.compliancePack} disabled={!country.compliancePack} onChange={(e) => setApplyPack(e.target.checked)} />
                    <span>{country.compliancePack ? `Use the ${country.compliancePack.name} labour-law pack` : 'No ready-made labour-law pack for this country'}<span className="block text-[12px] text-[#6B6B6B]">{country.compliancePack ? 'Schedules and rotations for this site are checked against it.' : 'You can choose or build a pack later under Compliance Packs.'}</span></span></label>
                </>
              )}
            </>
          )}
          {copying && <p className="text-[12px] text-[#525252]">The new site gets the same holidays and the same labour-law pack as {sites.find((x) => x.id === copyFrom)?.name}.</p>}
        </div>
      )}

      {canWrite && <div className="flex gap-2"><Btn variant="primary" onClick={save} disabled={!ready || busy}>{busy ? 'Saving…' : site ? 'Save changes' : 'Create site'}</Btn>{onCancel && <Btn onClick={onCancel}>Cancel</Btn>}</div>}
    </div>
  );
};

// ---------------------------------------------------------------- a site: header, checklist and tabs

type Tab = 'overview' | 'groups' | 'teams' | 'people' | 'rules' | 'settings';
const TAB_LABEL: [Tab, string][] = [['overview', 'Overview'], ['groups', 'Groups'], ['teams', 'Teams'], ['people', 'People'], ['rules', 'Rules and holidays'], ['settings', 'Settings']];

const SiteView: React.FC<{ s: Site; c: Ctx }> = ({ s, c }) => {
  const { d, canWrite, go, notify, fail, reload, select } = c;
  const [tab, setTab] = useState<Tab>('overview');
  const [adding, setAdding] = useState<'group' | 'team' | null>(null);
  useEffect(() => { setTab('overview'); setAdding(null); }, [s.id]);
  const steps = setupSteps(s, d);
  const done = steps.filter((x) => x.done).length;
  const siteGroups = groupsAt(d, s.id);
  const run = async (fn: () => Promise<void>, ok = '') => { try { await fn(); if (ok) notify(ok); reload(); } catch (e: any) { fail(e.message); } };
  const jump = (t: Tab, add: 'group' | 'team' | null = null) => { setTab(t); setAdding(add); };

  // groups of this site, and the teams that are based here or whose people work here
  const teamsHere = useMemo(() => {
    const here = new Map(d.teamPlaces.filter((p) => p.siteId === s.id).map((p) => [p.teamId, p.people]));
    return d.teams.filter((t) => t.siteId === s.id || here.has(t.id)).map((t) => ({ ...t, here: here.get(t.id) ?? 0, based: t.siteId === s.id })).sort((a, b) => Number(b.based) - Number(a.based) || a.name.localeCompare(b.name));
  }, [d.teams, d.teamPlaces, s.id]);

  const sitePack = c.assigns.find((a) => a.scopeType === 'SITE' && a.scopeId === s.id);
  const inherited = c.assigns.find((a) => a.scopeType === 'REGION' && a.scopeId === s.regionId) ?? c.assigns.find((a) => a.scopeType === 'TENANT');

  return (
    <div className="space-y-4">
      <div className="rounded-xl border border-[#E5E5E0] bg-white p-4 space-y-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="space-y-1 min-w-0">
            <div className="flex flex-wrap items-center gap-2"><h2 className="text-[20px] font-semibold text-[#171717] truncate">{s.name}</h2>{s.status === 'CLOSED' ? <Pill>Closed{s.closedOn ? ` ${s.closedOn}` : ''}</Pill> : <Pill tone="good">Open</Pill>}{s.regionName && <Pill tone="info">{s.regionName}</Pill>}</div>
            <div className="text-[12px] text-[#6B6B6B]">{[s.country || 'No country yet', `${s.timezone}, ${localTime(s.timezone)} there now`, s.managerName ? `Managed by ${s.managerName}` : 'No manager yet'].filter(Boolean).join(' · ')}</div>
            {s.address && <div className="text-[12px] text-[#6B6B6B]">{s.address}</div>}
          </div>
          {canWrite && s.status === 'ACTIVE' && (
            <div className="flex flex-wrap gap-2">
              <Btn variant="primary" onClick={() => jump('groups', 'group')}><Plus className="w-3.5 h-3.5" />Add group</Btn>
              <Btn onClick={() => jump('teams', 'team')}><Plus className="w-3.5 h-3.5" />Add team</Btn>
              <Btn onClick={() => go('employees', 'workforce')}><Plus className="w-3.5 h-3.5" />Add people</Btn>
            </div>
          )}
        </div>
        <div className="flex gap-1 border-b border-[#E5E5E0] -mb-px overflow-x-auto" role="tablist">
          {TAB_LABEL.map(([id, label]) => (
            <button key={id} role="tab" aria-selected={tab === id} onClick={() => jump(id)} className={`px-3 py-2 text-[13px] font-semibold whitespace-nowrap border-b-2 transition-colors ${tab === id ? 'border-[#171717] text-[#171717]' : 'border-transparent text-[#6B6B6B] hover:text-[#171717]'}`}>
              {label}{id === 'groups' && <span className="ml-1.5 text-[11px] font-medium text-[#6B6B6B]">{siteGroups.length}</span>}{id === 'teams' && <span className="ml-1.5 text-[11px] font-medium text-[#6B6B6B]">{teamsHere.length}</span>}{id === 'people' && <span className="ml-1.5 text-[11px] font-medium text-[#6B6B6B]">{s.people}</span>}
            </button>
          ))}
        </div>
      </div>

      {tab === 'overview' && (
        <div className="space-y-4">
          {done < steps.length ? (
            <Card title={`Set up ${s.name}`} sub={`${done} of ${steps.length} done`}>
              <div className="h-1.5 rounded-full bg-[#EDEDE8] overflow-hidden"><div className="h-full bg-[#2F7D5A] transition-all" style={{ width: `${(done / steps.length) * 100}%` }} /></div>
              <ul className="divide-y divide-[#F0F0EC]">
                {steps.map((x) => (
                  <li key={x.id} className="flex items-center gap-3 py-2.5">
                    {x.done ? <span className="w-5 h-5 rounded-full bg-[#EAF5EF] text-[#2A7553] inline-flex items-center justify-center"><Check className="w-3 h-3" /></span> : <Circle className="w-5 h-5 text-[#C4C4BD]" />}
                    <div className="flex-1 min-w-0"><div className={`text-[13px] font-medium ${x.done ? 'text-[#6B6B6B]' : 'text-[#171717]'}`}>{x.label}</div>{!x.done && <div className="text-[12px] text-[#6B6B6B]">{x.hint}</div>}</div>
                    {!x.done && canWrite && <Btn onClick={() => (x.id === 'people' ? go('employees', 'workforce') : jump(x.tab, x.id === 'groups' ? 'group' : null))}>{x.action}</Btn>}
                  </li>
                ))}
              </ul>
            </Card>
          ) : <div className="flex items-center gap-2 text-[13px] text-[#2A7553]"><Check className="w-4 h-4" />{s.name} is fully set up.</div>}
          <KpiRow><Kpi label="WFM groups" value={siteGroups.length} /><Kpi label="Teams" value={teamsHere.length} /><Kpi label="People" value={s.people} /><Kpi label="Holidays" value={s.holidays} sub="set for this site" /></KpiRow>
        </div>
      )}

      {tab === 'groups' && (
        <Card title="WFM groups at this site" sub="A group is people who share a schedule. It follows this site's time zone, holidays and labour-law pack.">
          {adding === 'group' && canWrite && <AddGroup s={s} onDone={(m) => { setAdding(null); notify(m); reload(); }} onCancel={() => setAdding(null)} fail={fail} />}
          {siteGroups.length === 0 && adding !== 'group' ? <Empty title="No groups here yet">Add the first one, or move an existing group to this site.</Empty> : (
            <ul className="divide-y divide-[#F0F0EC] border border-[#E5E5E0] rounded-lg">
              {siteGroups.map((g) => (
                <li key={g.id}><button className="w-full flex items-center gap-3 px-3 py-2.5 text-left hover:bg-[#FAFAF8]" onClick={() => select({ kind: 'group', id: g.id })}>
                  <Users className="w-4 h-4 text-[#6B6B6B]" /><span className="text-[13px] font-medium">{g.name}</span>{g.status !== 'ACTIVE' && <Pill>Switched off</Pill>}
                  <span className="ml-auto text-[12px] text-[#6B6B6B]">{plural(g.people, 'person', 'people')} · {plural(g.queues, 'queue')}</span><ChevronRight className="w-4 h-4 text-[#A3A3A3]" />
                </button></li>
              ))}
            </ul>
          )}
          {canWrite && adding !== 'group' && (
            <div className="flex flex-wrap items-end gap-3">
              <Btn variant="primary" onClick={() => setAdding('group')}><Plus className="w-3.5 h-3.5" />Add a group</Btn>
              <MoveHere kind="group" s={s} d={d} run={run} />
            </div>
          )}
        </Card>
      )}

      {tab === 'teams' && (
        <Card title="Teams" sub="Teams are how people report and are organised. A team can have people from several sites; the ones here are based at this site or have people working here.">
          {adding === 'team' && canWrite && <AddTeam s={s} onDone={(m) => { setAdding(null); notify(m); reload(); }} onCancel={() => setAdding(null)} fail={fail} />}
          {teamsHere.length === 0 && adding !== 'team' ? <Empty title="No teams here yet">Create a team for this site, or move an existing one here.</Empty> : (
            <ul className="divide-y divide-[#F0F0EC] border border-[#E5E5E0] rounded-lg">
              {teamsHere.map((t) => (
                <li key={t.id} className="flex items-center gap-3 px-3 py-2.5 text-[13px]">
                  <span className="font-medium">{t.name}</span>{t.based ? <Pill tone="info">Based here</Pill> : <Pill>People work here</Pill>}
                  <span className="ml-auto text-[12px] text-[#6B6B6B]">{t.supervisor ? `Supervisor ${t.supervisor} · ` : 'No supervisor · '}{plural(t.here, 'person', 'people')} here</span>
                </li>
              ))}
            </ul>
          )}
          {canWrite && adding !== 'team' && (
            <div className="flex flex-wrap items-end gap-3">
              <Btn variant="primary" onClick={() => setAdding('team')}><Plus className="w-3.5 h-3.5" />Add a team</Btn>
              <MoveHere kind="team" s={s} d={d} run={run} />
              <Btn onClick={() => go('teams', 'workforce')}>Manage all teams</Btn>
            </div>
          )}
        </Card>
      )}

      {tab === 'people' && (
        <Card title="People at this site" sub="Everyone whose main WFM group is at this site.">
          <KpiRow><Kpi label="People" value={s.people} /><Kpi label="WFM groups" value={siteGroups.length} /></KpiRow>
          {siteGroups.length > 0 && (
            <ul className="divide-y divide-[#F0F0EC] border border-[#E5E5E0] rounded-lg max-w-xl">
              {[...siteGroups].sort((a, b) => b.people - a.people).slice(0, 8).map((g) => <li key={g.id} className="flex justify-between px-3 py-2 text-[13px]"><span>{g.name}</span><span className="text-[#6B6B6B]">{g.people}</span></li>)}
            </ul>
          )}
          <div className="flex flex-wrap gap-2">
            {canWrite && <Btn variant="primary" onClick={() => go('employees', 'workforce')}><Plus className="w-3.5 h-3.5" />Add a person</Btn>}
            <Btn onClick={() => go('employees', 'workforce')}>Import people from a file</Btn>
            <Btn onClick={() => go('org-chart', 'workforce')}>See the org chart</Btn>
          </div>
        </Card>
      )}

      {tab === 'rules' && (
        <Card title="Rules and holidays" sub="What applies to the groups at this site, on top of the organisation's.">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6 max-w-3xl items-start text-[13px]">
            <Field label="Labour-law pack" hint={sitePack ? 'Set for this site' : inherited ? `None set here: this site follows ${inherited.packName}` : 'None set: only the scheduling rules and each contract apply'}>
              <Select disabled={!canWrite} value={sitePack?.packId ?? ''} onChange={(e) => run(async () => { await api('/compliance/assignments', { method: 'PUT', body: { scopeType: 'SITE', scopeId: s.id, packId: e.target.value || null } }); }, 'Labour-law pack saved.')}>
                <option value="">{inherited ? `Follow ${inherited.packName}` : 'None'}</option>{c.packs.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </Select>
            </Field>
            <div>
              <div className="text-[12px] font-semibold">Holidays</div>
              <p className="mt-1 text-[#525252]">{s.holidays ? `${plural(s.holidays, 'holiday')} set for ${s.name}.` : 'None set for this site, so only the organisation-wide holidays apply.'}</p>
              <div className="mt-1.5 flex flex-wrap gap-2">
                <Btn onClick={() => go('work-calendar', 'configuration')}>Manage holidays</Btn>
                {canWrite && s.countryCode && s.holidays === 0 && <Btn variant="primary" onClick={() => run(async () => { const y = new Date().getFullYear(); await api('/holidays/import', { method: 'POST', body: { country: s.countryCode, years: [y, y + 1], siteId: s.id } }); }, `${s.country}'s public holidays added.`)}>Add {s.country}'s public holidays</Btn>}
              </div>
            </div>
          </div>
        </Card>
      )}

      {tab === 'settings' && (
        <div className="space-y-4">
          <Card title="Details"><SiteForm key={s.id + c.tick} site={s} sites={d.sites} regions={d.regions} countries={c.countries} canWrite={canWrite} reload={reload} onSaved={(_, m) => { notify(m); reload(); }} /></Card>
          {canWrite && (
            <Card title="Close or remove this site">
              <p className="text-[13px] text-[#525252]">{s.status === 'CLOSED' ? 'This site is closed. Its history stays, and it no longer counts against your plan.' : 'A site that shuts down is closed, not deleted, so its history stays and it stops counting against your plan.'}</p>
              <div className="flex flex-wrap gap-2">
                <Btn onClick={() => { if (s.status === 'ACTIVE' && !confirm(`Close "${s.name}"? Its history stays and you can reopen it.`)) return; run(async () => { await api(`/config/sites/${s.id}`, { method: 'PUT', body: { name: s.name, timezone: s.timezone, country: s.country, countryCode: s.countryCode, regionId: s.regionId, address: s.address, managerId: s.managerId, status: s.status === 'CLOSED' ? 'ACTIVE' : 'CLOSED' } }); }, s.status === 'CLOSED' ? `${s.name} is open again.` : `${s.name} is closed.`); }}>{s.status === 'CLOSED' ? 'Reopen site' : 'Close site'}</Btn>
                <Btn onClick={() => { if (!confirm(`Delete "${s.name}"? Its groups keep working and simply belong to no site. To keep its history, close it instead.`)) return; run(async () => { await api(`/config/sites/${s.id}`, { method: 'DELETE' }); select({ kind: 'org' }); }); }}>Delete site</Btn>
              </div>
            </Card>
          )}
        </div>
      )}
    </div>
  );
};

/** Name a new group; it starts with this site's time zone. */
const AddGroup: React.FC<{ s: Site; onDone: (m: string) => void; onCancel: () => void; fail: (m: string) => void }> = ({ s, onDone, onCancel, fail }) => {
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try { await api('/config/groups', { method: 'POST', body: { name: name.trim(), siteId: s.id, timezone: s.timezone } }); onDone(`Group "${name.trim()}" added to ${s.name}. Next: open it to add queues and people.`); } catch (e: any) { fail(e.message); } finally { setBusy(false); }
  };
  return (
    <div className="border border-[#E5E5E0] rounded-lg p-3 bg-[#FAFAF8] space-y-2 max-w-xl">
      <Field label="Group name" hint={`It starts with ${s.name}'s time zone (${s.timezone}) and standard targets. You can change them in the group's settings.`}><Input autoFocus value={name} maxLength={80} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && name.trim() && save()} placeholder="Billing support" /></Field>
      <div className="flex gap-2"><Btn variant="primary" onClick={save} disabled={!name.trim() || busy}>{busy ? 'Adding…' : 'Add group'}</Btn><Btn onClick={onCancel}>Cancel</Btn></div>
    </div>
  );
};

/** Name a new team and, if wanted, its supervisor; it is based at this site. */
const AddTeam: React.FC<{ s: Site; onDone: (m: string) => void; onCancel: () => void; fail: (m: string) => void }> = ({ s, onDone, onCancel, fail }) => {
  const [name, setName] = useState('');
  const [sup, setSup] = useState('');
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try { await api('/workforce/teams', { method: 'POST', body: { name: name.trim(), siteId: s.id, ...(sup ? { managerId: sup } : {}) } }); onDone(`Team "${name.trim()}" added to ${s.name}. Add its people from Workforce › Employees.`); } catch (e: any) { fail(e.message); } finally { setBusy(false); }
  };
  return (
    <div className="border border-[#E5E5E0] rounded-lg p-3 bg-[#FAFAF8] space-y-3 max-w-xl">
      <Field label="Team name"><Input autoFocus value={name} maxLength={80} onChange={(e) => setName(e.target.value)} placeholder="Alpha" /></Field>
      <Field label="Supervisor" hint="Optional. Only people marked as supervisors can lead a team."><PersonPicker ariaLabel="Team supervisor" statuses="ACTIVE,LEAVE" only="supervisor" value={sup} onChange={(id) => setSup(id)} placeholder="Choose a supervisor" /></Field>
      <div className="flex gap-2"><Btn variant="primary" onClick={save} disabled={!name.trim() || busy}>{busy ? 'Adding…' : 'Add team'}</Btn><Btn onClick={onCancel}>Cancel</Btn></div>
    </div>
  );
};

/** Bring something that already exists (a group or a team) to this site. */
const MoveHere: React.FC<{ kind: 'group' | 'team'; s: Site; d: Structure; run: (fn: () => Promise<void>, ok?: string) => Promise<void> }> = ({ kind, s, d, run }) => {
  const [id, setId] = useState('');
  const options = kind === 'group'
    ? d.groups.filter((g) => g.siteId !== s.id).map((g) => ({ id: g.id, label: `${g.name}${g.siteId ? ` (now at ${d.sites.find((x) => x.id === g.siteId)?.name ?? 'another site'})` : ' (not at a site)'}` }))
    : d.teams.filter((t) => t.siteId !== s.id).map((t) => ({ id: t.id, label: `${t.name}${t.siteId ? ` (now at ${d.sites.find((x) => x.id === t.siteId)?.name ?? 'another site'})` : ''}` }));
  if (options.length === 0) return null;
  return (
    <div className="flex items-end gap-2">
      <div className="w-72"><Select aria-label={`Move a ${kind} here`} value={id} onChange={(e) => setId(e.target.value)}><option value="">Move an existing {kind} here…</option>{options.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}</Select></div>
      <Btn disabled={!id} onClick={() => run(async () => { await (kind === 'group' ? api(`/config/groups/${id}/site`, { method: 'PUT', body: { siteId: s.id } }) : api(`/workforce/teams/${id}`, { method: 'PUT', body: { siteId: s.id } })); setId(''); }, `Moved to ${s.name}.`)}>Move</Btn>
    </div>
  );
};

// ---------------------------------------------------------------- the organisation, regions and groups

const Overview: React.FC<{ c: Ctx }> = ({ c }) => {
  const { d, canWrite, select, go } = c;
  const active = d.sites.filter((s) => s.status === 'ACTIVE');
  const noSite = groupsAt(d, null);
  const attention = [
    ...(noSite.length ? [{ text: `${plural(noSite.length, 'WFM group')} ${noSite.length === 1 ? 'is' : 'are'} not at a site, so no site holidays or labour-law rules apply to ${noSite.length === 1 ? 'it' : 'them'}.`, action: 'Review', run: () => select({ kind: 'noSite' }) }] : []),
    ...(active.filter((s) => s.countryCode && s.holidays === 0).length ? [{ text: `${plural(active.filter((s) => s.countryCode && s.holidays === 0).length, 'site')} with no public holidays set.`, action: 'Open the first', run: () => select({ kind: 'site', id: active.find((s) => s.countryCode && s.holidays === 0)!.id }) }] : []),
    ...(active.filter((s) => !s.packName).length ? [{ text: `${plural(active.filter((s) => !s.packName).length, 'site')} without a labour-law pack of its own.`, action: 'Open the first', run: () => select({ kind: 'site', id: active.find((s) => !s.packName)!.id }) }] : []),
    ...(active.filter((s) => groupsAt(d, s.id).length === 0).length ? [{ text: `${plural(active.filter((s) => groupsAt(d, s.id).length === 0).length, 'site')} with no WFM group yet.`, action: 'Open the first', run: () => select({ kind: 'site', id: active.find((s) => groupsAt(d, s.id).length === 0)!.id }) }] : []),
    ...(d.unplacedPeople ? [{ text: `${plural(d.unplacedPeople, 'person', 'people')} not in a WFM group yet.`, action: 'Open Employees', run: () => go('employees', 'workforce') }] : []),
  ];
  return (
    <div className="space-y-5">
      <div className="flex items-end justify-between gap-3">
        <div><h2 className="text-[20px] font-semibold text-[#171717]">Your organisation</h2><p className="text-[13px] text-[#6B6B6B]">{plural(d.regions.length, 'region')} · {plural(active.length, 'site')} · {plural(d.groups.length, 'WFM group')} · {(d.groups.reduce((n, g) => n + g.people, 0) + d.unplacedPeople).toLocaleString()} people</p></div>
        {canWrite && <Btn variant="primary" onClick={() => select({ kind: 'newSite' })}><Plus className="w-3.5 h-3.5" />Add site</Btn>}
      </div>

      {d.sites.length === 0 ? (
        <Card title="Start here" sub="Set up where your people work. It takes a minute.">
          <ol className="list-decimal pl-5 space-y-2 text-[13px] text-[#171717]">
            <li><strong>Add your first site.</strong> Choose its country and it fills in the time zone and offers the public holidays and labour-law rules.</li>
            <li><strong>Add a WFM group</strong> for each set of people who share a schedule.</li>
            <li><strong>Add your people</strong> to their group.</li>
          </ol>
          {canWrite && <Btn variant="primary" onClick={() => select({ kind: 'newSite' })}><Plus className="w-3.5 h-3.5" />Add your first site</Btn>}
        </Card>
      ) : (
        <>
          <section aria-label="Sites" className="grid grid-cols-1 md:grid-cols-2 2xl:grid-cols-3 gap-3">
            {d.sites.slice().sort((a, b) => Number(a.status === 'CLOSED') - Number(b.status === 'CLOSED') || a.name.localeCompare(b.name)).slice(0, 12).map((s) => {
              const steps = setupSteps(s, d), done = steps.filter((x) => x.done).length;
              return (
                <button key={s.id} onClick={() => select({ kind: 'site', id: s.id })} className={`text-left rounded-xl border bg-white p-4 hover:shadow-sm hover:border-[#A3A3A3] transition ${s.status === 'CLOSED' ? 'opacity-60' : ''} border-[#E5E5E0]`}>
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0"><div className="text-[14px] font-semibold text-[#171717] truncate">{s.name}</div><div className="text-[12px] text-[#6B6B6B] truncate">{s.country || 'No country'}{s.regionName ? ` · ${s.regionName}` : ''} · {localTime(s.timezone)}</div></div>
                    {s.status === 'CLOSED' ? <Pill>Closed</Pill> : <span className="text-[11px] font-mono text-[#6B6B6B] bg-[#F0F0EC] rounded px-1.5 py-0.5">{s.countryCode || '--'}</span>}
                  </div>
                  <div className="mt-3 flex gap-4 text-[12px] text-[#525252]"><span><b className="text-[#171717]">{groupsAt(d, s.id).length}</b> {groupsAt(d, s.id).length === 1 ? 'group' : 'groups'}</span><span><b className="text-[#171717]">{s.people.toLocaleString()}</b> {s.people === 1 ? 'person' : 'people'}</span></div>
                  <div className="mt-3"><div className="h-1 rounded-full bg-[#EDEDE8] overflow-hidden"><div className={`h-full ${done === steps.length ? 'bg-[#2F7D5A]' : 'bg-[#B7791F]'}`} style={{ width: `${(done / steps.length) * 100}%` }} /></div><div className="mt-1 text-[11px] text-[#6B6B6B]">{done === steps.length ? 'Fully set up' : `Setup ${done} of ${steps.length}`}</div></div>
                </button>
              );
            })}
            {canWrite && <button onClick={() => select({ kind: 'newSite' })} className="rounded-xl border border-dashed border-[#C4C4BD] p-4 text-[13px] text-[#525252] hover:bg-[#FAFAF8] flex items-center justify-center gap-2"><Plus className="w-4 h-4" />Add a site</button>}
          </section>
          {d.sites.length > 12 && <p className="text-[12px] text-[#6B6B6B]">Showing 12 of {d.sites.length} sites. Use the tree or search to find the rest.</p>}

          <Card title="Needs attention">
            {attention.length === 0 ? <div className="flex items-center gap-2 text-[13px] text-[#2A7553]"><Check className="w-4 h-4" />Everything is set up.</div> : (
              <ul className="divide-y divide-[#F0F0EC]">{attention.map((a, i) => <li key={i} className="flex items-center gap-3 py-2.5 text-[13px]"><span className="w-1.5 h-1.5 rounded-full bg-[#B7791F] shrink-0" /><span className="flex-1 text-[#171717]">{a.text}</span><Btn onClick={a.run}>{a.action}</Btn></li>)}</ul>
            )}
          </Card>
        </>
      )}
    </div>
  );
};

const RegionView: React.FC<{ r: Region; c: Ctx }> = ({ r, c }) => {
  const sites = c.d.sites.filter((s) => s.regionId === r.id);
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2"><h2 className="text-[20px] font-semibold">{r.name}</h2><Pill tone="info">Region</Pill></div>
      <KpiRow><Kpi label="Sites" value={sites.length} /><Kpi label="WFM groups" value={sites.reduce((n, s) => n + groupsAt(c.d, s.id).length, 0)} /><Kpi label="People" value={sites.reduce((n, s) => n + s.people, 0).toLocaleString()} /></KpiRow>
      <Card title="Sites in this region" sub="A labour-law pack set on a region applies to all its sites unless a site has its own.">
        {sites.length === 0 ? <Empty title="No sites in this region yet">Add the first one.</Empty> : (
          <ul className="divide-y divide-[#F0F0EC] border border-[#E5E5E0] rounded-lg max-w-xl">{sites.map((s) => <li key={s.id}><button className="w-full flex items-center gap-3 px-3 py-2.5 text-[13px] text-left hover:bg-[#FAFAF8]" onClick={() => c.select({ kind: 'site', id: s.id })}><MapPin className="w-4 h-4 text-[#6B6B6B]" /><span className="font-medium">{s.name}</span><span className="ml-auto text-[12px] text-[#6B6B6B]">{s.country || '–'} · {plural(s.people, 'person', 'people')}</span></button></li>)}</ul>
        )}
        {c.canWrite && <Btn variant="primary" onClick={() => c.select({ kind: 'newSite', regionId: r.id })}><Plus className="w-3.5 h-3.5" />Add a site in {r.name}</Btn>}
      </Card>
      {c.canWrite && (
        <Card title="Rename or remove">
          <div className="flex flex-wrap gap-2">
            <Btn onClick={async () => { const n = prompt('Rename the region', r.name)?.trim(); if (n && n !== r.name) { try { await api(`/config/regions/${r.id}`, { method: 'PUT', body: { name: n } }); c.notify('Region renamed.'); c.reload(); } catch (e: any) { c.fail(e.message); } } }}>Rename</Btn>
            <Btn onClick={async () => { if (!confirm(`Delete the region "${r.name}"? Its sites stay, with no region.`)) return; try { await api(`/config/regions/${r.id}`, { method: 'DELETE' }); c.select({ kind: 'org' }); c.reload(); } catch (e: any) { c.fail(e.message); } }}>Delete region</Btn>
          </div>
        </Card>
      )}
    </div>
  );
};

const GroupView: React.FC<{ g: GroupNode; c: Ctx }> = ({ g, c }) => {
  const { d, canWrite, go } = c;
  const site = d.sites.find((s) => s.id === g.siteId);
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2"><h2 className="text-[20px] font-semibold">{g.name}</h2><Pill tone="info">WFM group</Pill>{g.status !== 'ACTIVE' && <Pill>Switched off</Pill>}</div>
      <KpiRow><Kpi label="People" value={g.people} /><Kpi label="Queues" value={g.queues} /><Kpi label="Time zone" value={g.timezone} /></KpiRow>
      <Card title="Where it sits">
        <Field label="Site" hint="Moving a group changes which site's holidays and labour-law pack apply to it">
          <Select disabled={!canWrite} value={g.siteId ?? ''} onChange={async (e) => { try { await api(`/config/groups/${g.id}/site`, { method: 'PUT', body: { siteId: e.target.value || null } }); c.notify('Group moved.'); c.reload(); } catch (er: any) { c.fail(er.message); } }}>
            <option value="">Not at a site</option>{d.sites.filter((s) => s.status === 'ACTIVE' || s.id === g.siteId).map((s) => <option key={s.id} value={s.id}>{s.name}{s.regionName ? ` (${s.regionName})` : ''}</option>)}
          </Select>
        </Field>
        {site && <p className="text-[12px] text-[#6B6B6B]">It follows {site.name}'s holidays{site.packName ? ` and the ${site.packName} labour-law pack` : ''}.</p>}
      </Card>
      <Card title="Teams in this group" sub="Teams are organised under Workforce; this shows how this group's people are spread across them.">
        {g.teams.length === 0 ? <p className="text-[13px] text-[#6B6B6B]">No people in this group yet.</p> : (
          <ul className="divide-y divide-[#F0F0EC] border border-[#E5E5E0] rounded-lg max-w-md">{g.teams.map((t) => <li key={t.name} className="flex justify-between px-3 py-2 text-[13px]"><span>{t.name}</span><span className="text-[#6B6B6B]">{t.n}</span></li>)}</ul>
        )}
        <div className="flex gap-2"><Btn variant="primary" onClick={() => go('wfm-groups', 'configuration')}>Open group settings</Btn><Btn onClick={() => go('teams', 'workforce')}>Manage teams</Btn></div>
      </Card>
    </div>
  );
};

/** Groups with no site: pick several and put them at a site in one go. */
const NoSiteView: React.FC<{ c: Ctx }> = ({ c }) => {
  const list = groupsAt(c.d, null);
  const [chosen, setChosen] = useState<string[]>([]);
  const [site, setSite] = useState('');
  const [busy, setBusy] = useState(false);
  const [find, setFind] = useState('');
  const shown = list.filter((g) => !find.trim() || g.name.toLowerCase().includes(find.trim().toLowerCase()));
  const move = async () => {
    setBusy(true);
    try { for (const id of chosen) await api(`/config/groups/${id}/site`, { method: 'PUT', body: { siteId: site } }); c.notify(`${plural(chosen.length, 'group')} moved to ${c.d.sites.find((s) => s.id === site)?.name}.`); setChosen([]); c.reload(); } catch (e: any) { c.fail(e.message); } finally { setBusy(false); }
  };
  return (
    <div className="space-y-4">
      <h2 className="text-[20px] font-semibold">Groups not at a site</h2>
      <p className="text-[13px] text-[#525252]">These groups follow only the organisation-wide holidays and rules. Tick the ones that belong together and put them at a site.</p>
      <div className="flex flex-wrap items-end gap-3">
        <div className="w-64"><Input aria-label="Search groups" placeholder="Search groups" value={find} onChange={(e) => setFind(e.target.value)} /></div>
        <div className="w-64"><Select aria-label="Move to site" value={site} onChange={(e) => setSite(e.target.value)}><option value="">Choose a site…</option>{c.d.sites.filter((s) => s.status === 'ACTIVE').map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</Select></div>
        <Btn variant="primary" disabled={!site || chosen.length === 0 || busy || !c.canWrite} onClick={move}>{busy ? 'Moving…' : `Move ${chosen.length || ''} selected`}</Btn>
        <Btn onClick={() => setChosen(chosen.length === shown.length ? [] : shown.map((g) => g.id))}>{chosen.length === shown.length && shown.length > 0 ? 'Clear selection' : 'Select all shown'}</Btn>
      </div>
      <ul className="divide-y divide-[#F0F0EC] border border-[#E5E5E0] rounded-lg max-h-[480px] overflow-y-auto">
        {shown.map((g) => <li key={g.id}><label className="flex items-center gap-3 px-3 py-2 text-[13px] cursor-pointer hover:bg-[#FAFAF8]"><input type="checkbox" checked={chosen.includes(g.id)} onChange={(e) => setChosen(e.target.checked ? [...chosen, g.id] : chosen.filter((x) => x !== g.id))} /><span className="font-medium">{g.name}</span><span className="ml-auto text-[12px] text-[#6B6B6B]">{plural(g.people, 'person', 'people')}</span></label></li>)}
        {shown.length === 0 && <li className="px-3 py-4 text-[13px] text-[#6B6B6B]">No group matches.</li>}
      </ul>
    </div>
  );
};

const NewRegion: React.FC<{ onDone: (m: string) => void; onCancel: () => void }> = ({ onDone, onCancel }) => {
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  const save = async () => { try { await api('/config/regions', { method: 'POST', body: { name: name.trim() } }); onDone(`Region ${name.trim()} added. Add sites to it from its page.`); } catch (e: any) { setError(e.message); } };
  return (
    <div className="space-y-3 max-w-md">
      <h2 className="text-[20px] font-semibold">Add a region</h2>
      <p className="text-[13px] text-[#525252]">A region groups sites, for example EMEA or APAC. It is optional: sites work fine without one.</p>
      {error && <Banner kind="err" onClose={() => setError('')}>{error}</Banner>}
      <Field label="Region name"><Input autoFocus value={name} maxLength={80} onChange={(e) => setName(e.target.value)} placeholder="EMEA" /></Field>
      <div className="flex gap-2"><Btn variant="primary" onClick={save} disabled={!name.trim()}>Add region</Btn><Btn onClick={onCancel}>Cancel</Btn></div>
    </div>
  );
};

// ---------------------------------------------------------------- the page

export const OrganisationPanel: React.FC = () => {
  const { can, go, reloadGroups, session } = useForecast();
  const canWrite = can('config:write') && !session.access?.restricted;
  const [tick, setTick] = useState(0);
  const data = useApi<Structure>('/config/structure', [tick]);
  const countries = useApi<Country[]>('/holidays/countries');
  const packs = useApi<Pack[]>('/compliance/packs');
  const assigns = useApi<Assignment[]>('/compliance/assignments', [tick]);
  const [pick, setPick] = useState<Pick>({ kind: 'org' });
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [find, setFind] = useState('');
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const reload = () => { setTick((t) => t + 1); reloadGroups?.(); };
  const d = data.data;
  // a large organisation opens collapsed, with the picked branch open, so the tree stays short
  const big = (d?.groups.length ?? 0) > 12;
  const isOpen = (k: string) => open[k] ?? !big;
  const toggle = (k: string) => setOpen((o) => ({ ...o, [k]: !isOpen(k) }));
  const select = (p: Pick) => {
    setPick(p); setNotice(''); setError('');
    if (p.kind === 'group') { const g = d?.groups.find((x) => x.id === p.id); if (g?.siteId) setOpen((o) => ({ ...o, [`s:${g.siteId}`]: true })); }
    if (p.kind === 'site') { const s = d?.sites.find((x) => x.id === p.id); if (s?.regionId) setOpen((o) => ({ ...o, [`r:${s.regionId}`]: true })); }
  };

  if (data.loading && !d) return <Waiting what="the organisation" shape="table" reload={data.reload} />;
  if (!d) return <LoadFailed what="the organisation" error={data.error || 'Try again in a moment.'} reload={data.reload} />;

  const c: Ctx = { d, canWrite, countries: countries.data ?? [], packs: packs.data ?? [], assigns: assigns.data ?? [], reload, notify: (m) => { setError(''); setNotice(m); }, fail: (m) => { setNotice(''); setError(m); }, select, go, tick };
  const sitesOf = (regionId: string | null) => d.sites.filter((s) => (s.regionId ?? null) === regionId).sort((a, b) => Number(a.status === 'CLOSED') - Number(b.status === 'CLOSED') || a.name.localeCompare(b.name));
  const q = find.trim().toLowerCase();
  const match = (s: string) => !q || s.toLowerCase().includes(q);
  const hasRegions = d.regions.length > 0;
  const noSiteGroups = groupsAt(d, null);

  const Row: React.FC<{ id: string; depth: number; label: string; count?: number | string; icon?: React.ReactNode; expandable?: boolean; selected: boolean; onPick: () => void; muted?: boolean; strong?: boolean }> = ({ id, depth, label, count, icon, expandable, selected, onPick, muted, strong }) => (
    <div className={`flex items-center rounded-md border-l-2 ${selected ? 'bg-[#EEF3F8] border-[#171717]' : 'border-transparent hover:bg-[#F5F5F2]'}`} style={{ paddingLeft: 2 + depth * 14 }}>
      {expandable ? <button type="button" aria-label={isOpen(id) ? `Collapse ${label}` : `Expand ${label}`} aria-expanded={isOpen(id)} className="p-1 text-[#6B6B6B] hover:text-[#171717]" onClick={() => toggle(id)}>{isOpen(id) ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}</button> : <span className="w-[22px]" />}
      <button type="button" aria-current={selected ? 'true' : undefined} onClick={onPick} className={`flex-1 min-w-0 flex items-center gap-2 py-1.5 pr-2 text-left text-[13px] text-[#171717] ${muted ? 'opacity-60' : ''}`}>
        {icon}<span className={`truncate ${strong || selected ? 'font-semibold' : 'font-medium'}`}>{label}</span>
        {count !== undefined && <span className="ml-auto text-[11px] text-[#525252] bg-[#F0F0EC] rounded-full px-1.5 py-px tabular-nums">{count}</span>}
      </button>
    </div>
  );

  const siteRows = (sites: Site[], depth: number) => sites.map((s) => {
    const gs = groupsAt(d, s.id).filter((g) => match(g.name) || match(s.name));
    if (q && !match(s.name) && gs.length === 0) return null;
    const expandable = groupsAt(d, s.id).length > 0;
    return (
      <div key={s.id}>
        <Row id={`s:${s.id}`} depth={depth} label={s.name} icon={<MapPin className="w-3.5 h-3.5 shrink-0 text-[#4F6F8F]" />} count={s.status === 'CLOSED' ? 'closed' : groupsAt(d, s.id).length} expandable={expandable} selected={pick.kind === 'site' && pick.id === s.id} onPick={() => select({ kind: 'site', id: s.id })} muted={s.status === 'CLOSED'} />
        {expandable && (isOpen(`s:${s.id}`) || !!q) && gs.slice(0, 40).map((g) => <Row key={g.id} id={`g:${g.id}`} depth={depth + 1} label={g.name} icon={<Users className="w-3.5 h-3.5 shrink-0 text-[#6B6B6B]" />} count={g.people.toLocaleString()} selected={pick.kind === 'group' && pick.id === g.id} onPick={() => select({ kind: 'group', id: g.id })} muted={g.status !== 'ACTIVE'} />)}
        {expandable && isOpen(`s:${s.id}`) && gs.length > 40 && <div className="text-[11px] text-[#6B6B6B] py-1" style={{ paddingLeft: 24 + (depth + 1) * 14 }}>and {gs.length - 40} more: open the site to see them all</div>}
      </div>
    );
  });

  const body = (() => {
    if (pick.kind === 'newSite') return <div className="space-y-3"><h2 className="text-[20px] font-semibold">Add a site</h2><SiteForm key={`new${pick.regionId ?? ''}`} site={null} presetRegionId={pick.regionId} sites={d.sites} regions={d.regions} countries={c.countries} canWrite={canWrite} reload={reload} onCancel={() => select({ kind: 'org' })} onSaved={(s, m) => { c.notify(m); reload(); select({ kind: 'site', id: s.id }); }} /></div>;
    if (pick.kind === 'newRegion') return <NewRegion onDone={(m) => { c.notify(m); reload(); select({ kind: 'org' }); }} onCancel={() => select({ kind: 'org' })} />;
    if (pick.kind === 'site') { const s = d.sites.find((x) => x.id === pick.id); return s ? <SiteView s={s} c={c} /> : <Overview c={c} />; }
    if (pick.kind === 'region') { const r = d.regions.find((x) => x.id === pick.id); return r ? <RegionView r={r} c={c} /> : <Overview c={c} />; }
    if (pick.kind === 'group') { const g = d.groups.find((x) => x.id === pick.id); return g ? <GroupView g={g} c={c} /> : <Overview c={c} />; }
    if (pick.kind === 'noSite') return <NoSiteView c={c} />;
    return <Overview c={c} />;
  })();

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <PageHelp title="How your organisation is laid out">
          <HelpSection title="The structure">
            <p>Region, then site, then WFM group, then team, then person. Regions are optional. Every person belongs to one main WFM group, and that group sits at one site.</p>
          </HelpSection>
          <HelpSection title="What each level controls">
            <p><b>Site:</b> time zone, public holidays and the labour-law pack.</p>
            <p><b>Region:</b> a labour-law pack that all its sites share unless a site has its own.</p>
            <p><b>WFM group:</b> people who share a schedule, with their own targets and rotation pattern.</p>
            <p><b>Team:</b> how people report. A team can include people from several sites.</p>
          </HelpSection>
          <HelpSection title="Which rule wins">
            <p>The most specific setting applies: person, then team, then group, then site, then region, then the whole organisation.</p>
          </HelpSection>
        </PageHelp>
      </div>
      {error && <Banner kind="err" onClose={() => setError('')}>{error}</Banner>}
      {notice && <Banner kind="ok" onClose={() => setNotice('')}>{notice}</Banner>}
      <div className="grid grid-cols-1 lg:grid-cols-[320px_minmax(0,1fr)] gap-6 items-start">
        <aside className="border border-[#E5E5E0] rounded-xl bg-white lg:sticky lg:top-4" aria-label="Organisation tree">
          <div className="p-3 border-b border-[#E5E5E0] space-y-2">
            <div className="flex gap-2">
              {canWrite && <Btn variant="primary" onClick={() => select({ kind: 'newSite' })}><Plus className="w-3.5 h-3.5" />Add site</Btn>}
              {canWrite && <Btn onClick={() => select({ kind: 'newRegion' })}>Add region</Btn>}
            </div>
            <Input aria-label="Search the organisation" placeholder="Search sites and groups" value={find} onChange={(e) => setFind(e.target.value)} />
          </div>
          <div className="p-2 space-y-0.5 max-h-[calc(100vh-260px)] min-h-[200px] overflow-y-auto">
            <Row id="org" depth={0} label={session.workspace?.name ?? 'Organisation'} strong icon={<Globe2 className="w-3.5 h-3.5 shrink-0 text-[#2F7D5A]" />} selected={pick.kind === 'org'} onPick={() => select({ kind: 'org' })} />
            {d.sites.length === 0 && d.groups.length === 0 && <p className="px-3 py-4 text-[12px] text-[#6B6B6B]">Nothing here yet. Add a site to begin.</p>}
            {hasRegions && d.regions.map((r) => {
              const sites = sitesOf(r.id);
              if (q && !match(r.name) && !sites.some((s) => match(s.name) || groupsAt(d, s.id).some((g) => match(g.name)))) return null;
              return (
                <div key={r.id}>
                  <Row id={`r:${r.id}`} depth={1} label={r.name} strong count={sites.length} expandable={sites.length > 0} selected={pick.kind === 'region' && pick.id === r.id} onPick={() => select({ kind: 'region', id: r.id })} />
                  {(isOpen(`r:${r.id}`) || !!q) && siteRows(sites, 2)}
                </div>
              );
            })}
            {siteRows(sitesOf(null), 1)}
            {noSiteGroups.length > 0 && !q && <Row id="nosite" depth={1} label="Groups not at a site" count={noSiteGroups.length} selected={pick.kind === 'noSite'} onPick={() => select({ kind: 'noSite' })} muted />}
          </div>
        </aside>
        <section aria-live="polite" className="min-w-0">{body}</section>
      </div>
    </div>
  );
};
