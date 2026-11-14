/** Settings: the plan catalogue and the country templates the New organisation form starts from. */
import React, { useEffect, useMemo, useState } from 'react';

type Api = <T>(path: string, options?: RequestInit) => Promise<T>;

export interface Plan {
  code: string; name: string; description: string; seatsMin: number; seatsMax: number; maxUsers: number; maxSites: number; maxWorkspaces: number;
  modules: string[]; gracePeriodDays: number; trialDays: number; listPrice: number | null; priceCurrency: string; status: 'ACTIVE' | 'RETIRED'; isCustom: boolean; sortOrder: number;
  customers?: number; outOfDate?: number;
}
export interface CountryTemplate { code: string; name: string; timezone: string; currency: string; locale: string; payWeekStart: number; weekendDays: number[]; addHolidays: boolean; compliancePack: string | null; sortOrder: number }

export const MODULE_LABELS: [string, string][] = [
  ['FORECASTING', 'Forecasting'], ['SCHEDULING', 'Scheduling'], ['INTRADAY', 'Intraday'], ['ADHERENCE', 'Adherence'], ['TIME_OFF', 'Time off'],
  ['SHIFT_BIDDING', 'Shift bidding'], ['EMPLOYEE_SELF_SERVICE', 'Employee self-service'], ['REPORTING', 'Reporting'], ['AI_COPILOT', 'AI assistant'],
];
const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const LOCALES: [string, string][] = [['en', 'English'], ['en-GB', 'English (UK)'], ['en-IN', 'English (India)'], ['es', 'Spanish'], ['fr', 'French'], ['de', 'German']];

const inputCls = 'w-full h-9 px-3 border border-[#D4D4CF] rounded text-[13px] bg-white text-[#171717] placeholder-[#A3A3A3] focus:outline-none focus:border-[#171717] focus:ring-1 focus:ring-[#171717]';
const card = 'bg-white border border-[#E5E5E0] rounded-lg shadow-xs';
const btn = 'px-4 py-2 rounded bg-[#171717] hover:bg-[#333] disabled:opacity-50 text-white text-[13px] font-semibold';
const btn2 = 'px-3 py-1.5 rounded border border-[#E5E5E0] bg-white hover:bg-[#FAFAF8] disabled:opacity-50 text-[12px] font-semibold text-[#171717]';
type Msg = { ok: boolean; text: string } | null;
const Note: React.FC<{ m: Msg }> = ({ m }) => (m ? <p role="status" className={`text-[12px] mt-2 ${m.ok ? 'text-[#2A7553]' : 'text-[#BC3F3F]'}`}>{m.text}</p> : null);
const Pill: React.FC<{ tone: 'good' | 'warn' | 'neutral'; children: React.ReactNode }> = ({ tone, children }) => (
  <span className={`text-[11px] font-semibold px-2 py-0.5 rounded border whitespace-nowrap ${tone === 'good' ? 'bg-[#EAF5EF] text-[#2A7553] border-[#2F7D5A]/20' : tone === 'warn' ? 'bg-[#FFF5DD] text-[#8F6200] border-[#B7791F]/20' : 'bg-[#FAFAF8] text-[#525252] border-[#E5E5E0]'}`}>{children}</span>
);
const Lbl: React.FC<{ id: string; text: string; hint?: string; children: React.ReactNode; wide?: boolean }> = ({ id, text, hint, children, wide }) => (
  <div className={wide ? 'md:col-span-2' : ''}>
    <label htmlFor={id} className="block text-[12px] font-semibold text-[#171717] mb-1">{text}</label>
    {children}
    {hint && <p className="text-[11px] text-[#737373] mt-1">{hint}</p>}
  </div>
);
const Modal: React.FC<{ title: string; onClose: () => void; children: React.ReactNode; wide?: boolean }> = ({ title, onClose, children, wide }) => (
  <div className="fixed inset-0 bg-black/40 flex items-center justify-center p-4 z-50" role="dialog" aria-modal="true" aria-label={title}>
    <div className={`bg-white border border-[#E5E5E0] rounded-lg shadow-2xl w-full ${wide ? 'max-w-3xl' : 'max-w-xl'} max-h-[90vh] overflow-y-auto`}>
      <div className="px-5 py-3.5 border-b border-[#E5E5E0] flex items-center justify-between sticky top-0 bg-white">
        <h3 className="text-[15px] font-semibold text-[#171717]">{title}</h3>
        <button onClick={onClose} className="text-[13px] text-[#525252] hover:underline">Close</button>
      </div>
      <div className="p-5">{children}</div>
    </div>
  </div>
);

// ---------------------------------------------------------------- plans

type PlanForm = { code: string; name: string; description: string; seatsMin: string; seatsMax: string; maxUsers: string; maxSites: string; maxWorkspaces: string; gracePeriodDays: string; trialDays: string; listPrice: string; priceCurrency: string; sortOrder: string; modules: string[] };
const blankPlan = (): PlanForm => ({ code: '', name: '', description: '', seatsMin: '1', seatsMax: '500', maxUsers: '100', maxSites: '10', maxWorkspaces: '3', gracePeriodDays: '14', trialDays: '30', listPrice: '', priceCurrency: 'USD', sortOrder: '100', modules: MODULE_LABELS.map(([k]) => k) });
const formOf = (p: Plan): PlanForm => ({ code: p.code, name: p.name, description: p.description, seatsMin: String(p.seatsMin), seatsMax: String(p.seatsMax), maxUsers: String(p.maxUsers), maxSites: String(p.maxSites), maxWorkspaces: String(p.maxWorkspaces), gracePeriodDays: String(p.gracePeriodDays), trialDays: String(p.trialDays), listPrice: p.listPrice == null ? '' : String(p.listPrice), priceCurrency: p.priceCurrency, sortOrder: String(p.sortOrder), modules: p.modules });

const PlansTab: React.FC<{ api: Api }> = ({ api }) => {
  const [plans, setPlans] = useState<Plan[]>([]);
  const [msg, setMsg] = useState<Msg>(null);
  const [edit, setEdit] = useState<{ isNew: boolean; isCustom: boolean; form: PlanForm } | null>(null);
  const [editMsg, setEditMsg] = useState<Msg>(null);
  const [busy, setBusy] = useState('');
  const [apply, setApply] = useState<{ plan: Plan; rows: any[] } | null>(null);

  const load = () => api<Plan[]>('/plans').then(setPlans).catch((e) => setMsg({ ok: false, text: e.message }));
  useEffect(() => { load(); }, []);

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!edit) return;
    const f = edit.form;
    setBusy('save'); setEditMsg(null);
    try {
      const body = JSON.stringify({
        code: f.code, name: f.name, description: f.description, seatsMin: 1, seatsMax: Number(f.seatsMax), maxUsers: Number(f.maxUsers), maxSites: Number(f.maxSites),
        maxWorkspaces: Number(f.maxWorkspaces), gracePeriodDays: Number(f.gracePeriodDays), trialDays: Number(f.trialDays), listPrice: f.listPrice === '' ? null : Number(f.listPrice),
        priceCurrency: f.priceCurrency, sortOrder: Number(f.sortOrder), modules: f.modules,
      });
      await api(edit.isNew ? '/plans' : `/plans/${f.code}`, { method: edit.isNew ? 'POST' : 'PATCH', body });
      setEdit(null); setMsg({ ok: true, text: edit.isNew ? 'Plan created.' : 'Plan saved. Customers already on it keep their current limits until you apply the change.' });
      await load();
    } catch (err: any) { setEditMsg({ ok: false, text: err.message }); } finally { setBusy(''); }
  };
  const setStatus = async (p: Plan, status: 'ACTIVE' | 'RETIRED') => {
    if (status === 'RETIRED' && !window.confirm(`Retire ${p.name}? It can no longer be given to new customers. Customers already on it keep it.`)) return;
    setBusy(p.code); setMsg(null);
    try { await api(`/plans/${p.code}/status`, { method: 'POST', body: JSON.stringify({ status }) }); await load(); } catch (err: any) { setMsg({ ok: false, text: err.message }); } finally { setBusy(''); }
  };
  const openApply = async (p: Plan) => {
    setBusy(p.code); setMsg(null);
    try { setApply({ plan: p, rows: await api<any[]>(`/plans/${p.code}/apply-preview`) }); } catch (err: any) { setMsg({ ok: false, text: err.message }); } finally { setBusy(''); }
  };
  const doApply = async () => {
    if (!apply) return;
    setBusy('apply');
    try {
      const r = await api<{ updated: number }>(`/plans/${apply.plan.code}/apply`, { method: 'POST', body: '{}' });
      setApply(null); setMsg({ ok: true, text: `${r.updated} customer${r.updated !== 1 ? 's' : ''} updated to the current ${apply.plan.name} plan.` }); await load();
    } catch (err: any) { setMsg({ ok: false, text: err.message }); } finally { setBusy(''); }
  };

  const set = (k: keyof PlanForm, v: any) => setEdit((e) => (e ? { ...e, form: { ...e.form, [k]: v } } : e));
  const f = edit?.form;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-[13px] text-[#525252] max-w-2xl">What each plan includes. A licence copies these numbers when it is issued, so changing a plan never changes a customer by itself.</p>
        <button onClick={() => { setEdit({ isNew: true, isCustom: false, form: blankPlan() }); setEditMsg(null); }} className={btn}>New plan</button>
      </div>
      <Note m={msg} />
      <div className={`${card} overflow-x-auto`}>
        <table className="w-full text-left text-[13px]">
          <thead className="bg-[#FAFAF8] text-[#737373] text-[11px] uppercase tracking-wider border-b border-[#E5E5E0]">
            <tr><th className="px-4 py-2">Plan</th><th className="px-4 py-2">Employee seats</th><th className="px-4 py-2">Users</th><th className="px-4 py-2">Sites</th><th className="px-4 py-2">Workspaces</th><th className="px-4 py-2">Modules</th><th className="px-4 py-2">Price per seat</th><th className="px-4 py-2">Customers</th><th className="px-4 py-2" /></tr>
          </thead>
          <tbody className="divide-y divide-[#E5E5E0]">
            {plans.map((p) => (
              <tr key={p.code} className={p.status === 'RETIRED' ? 'bg-[#FAFAF8] text-[#737373]' : ''}>
                <td className="px-4 py-2.5">
                  <div className="font-semibold text-[#171717] flex items-center gap-2">{p.name}{p.status === 'RETIRED' && <Pill tone="neutral">Retired</Pill>}{p.isCustom && <Pill tone="neutral">Negotiated</Pill>}</div>
                  <div className="text-[11px] text-[#737373]">{p.code}</div>
                </td>
                <td className="px-4 py-2.5 tabular-nums">{p.isCustom ? 'Per customer' : `Up to ${p.seatsMax.toLocaleString()}`}</td>
                <td className="px-4 py-2.5 tabular-nums">{p.isCustom ? 'Per customer' : p.maxUsers.toLocaleString()}</td>
                <td className="px-4 py-2.5 tabular-nums">{p.isCustom ? 'Per customer' : p.maxSites.toLocaleString()}</td>
                <td className="px-4 py-2.5 tabular-nums">{p.isCustom ? 'Per customer' : p.maxWorkspaces.toLocaleString()}</td>
                <td className="px-4 py-2.5 tabular-nums">{p.modules.length} of {MODULE_LABELS.length}</td>
                <td className="px-4 py-2.5 tabular-nums">{p.listPrice == null ? 'Not set' : `${p.priceCurrency} ${p.listPrice}`}</td>
                <td className="px-4 py-2.5">
                  <span className="tabular-nums">{p.customers ?? 0}</span>
                  {!!p.outOfDate && <span className="ml-2 inline-flex"><Pill tone="warn">{p.outOfDate} not up to date</Pill></span>}
                </td>
                <td className="px-4 py-2.5 whitespace-nowrap text-right space-x-2">
                  {!!p.outOfDate && <button onClick={() => openApply(p)} disabled={busy === p.code} className={btn2}>Apply to customers</button>}
                  <button onClick={() => { setEdit({ isNew: false, isCustom: p.isCustom, form: formOf(p) }); setEditMsg(null); }} className={btn2}>Edit</button>
                  {!p.isCustom && (p.status === 'ACTIVE'
                    ? <button onClick={() => setStatus(p, 'RETIRED')} disabled={busy === p.code} className={`${btn2} text-[#BC3F3F]`}>Retire</button>
                    : <button onClick={() => setStatus(p, 'ACTIVE')} disabled={busy === p.code} className={btn2}>Reactivate</button>)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {edit && f && (
        <Modal title={edit.isNew ? 'New plan' : `Edit ${f.name}`} onClose={() => setEdit(null)} wide>
          <form onSubmit={save} className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <Lbl id="pl-name" text="Name"><input id="pl-name" className={inputCls} value={f.name} onChange={(e) => set('name', e.target.value)} required /></Lbl>
            <Lbl id="pl-code" text="Code" hint={edit.isNew ? 'Capital letters, digits and underscores. Cannot be changed later.' : 'Fixed.'}>
              <input id="pl-code" className={inputCls} value={f.code} onChange={(e) => set('code', e.target.value.toUpperCase())} readOnly={!edit.isNew} required />
            </Lbl>
            <Lbl id="pl-desc" text="Description" wide><input id="pl-desc" className={inputCls} value={f.description} onChange={(e) => set('description', e.target.value)} /></Lbl>
            {edit.isCustom ? (
              <p className="md:col-span-2 text-[12px] text-[#737373]">The Custom plan has no fixed limits: users, sites, workspaces and modules are agreed for each customer when the licence is issued. Only its name, trial and grace period are set here.</p>
            ) : (
              <>
                <Lbl id="pl-smax" text="Employee seats included" hint="The employee limit a customer gets with this plan."><input id="pl-smax" type="number" min={1} className={inputCls} value={f.seatsMax} onChange={(e) => set('seatsMax', e.target.value)} /></Lbl>
                <Lbl id="pl-users" text="User accounts"><input id="pl-users" type="number" min={1} className={inputCls} value={f.maxUsers} onChange={(e) => set('maxUsers', e.target.value)} /></Lbl>
                <Lbl id="pl-sites" text="Sites"><input id="pl-sites" type="number" min={1} className={inputCls} value={f.maxSites} onChange={(e) => set('maxSites', e.target.value)} /></Lbl>
                <Lbl id="pl-ws" text="Workspaces"><input id="pl-ws" type="number" min={1} className={inputCls} value={f.maxWorkspaces} onChange={(e) => set('maxWorkspaces', e.target.value)} /></Lbl>
              </>
            )}
            <Lbl id="pl-grace" text="Grace period after expiry (days)"><input id="pl-grace" type="number" min={0} max={365} className={inputCls} value={f.gracePeriodDays} onChange={(e) => set('gracePeriodDays', e.target.value)} /></Lbl>
            <Lbl id="pl-trial" text="Trial length (days)"><input id="pl-trial" type="number" min={1} max={365} className={inputCls} value={f.trialDays} onChange={(e) => set('trialDays', e.target.value)} /></Lbl>
            <Lbl id="pl-price" text="List price per employee seat per month" hint="Optional. For reporting only; nothing is invoiced from it.">
              <div className="flex gap-2">
                <input id="pl-price" type="number" min={0} step="0.01" className={inputCls} value={f.listPrice} onChange={(e) => set('listPrice', e.target.value)} placeholder="Not set" />
                <input aria-label="Currency" className={`${inputCls} w-24`} value={f.priceCurrency} maxLength={3} onChange={(e) => set('priceCurrency', e.target.value.toUpperCase())} />
              </div>
            </Lbl>
            <Lbl id="pl-sort" text="Order in lists"><input id="pl-sort" type="number" min={0} className={inputCls} value={f.sortOrder} onChange={(e) => set('sortOrder', e.target.value)} /></Lbl>
            {!edit.isCustom && (
              <div className="md:col-span-2">
                <div className="text-[12px] font-semibold text-[#171717] mb-1.5">Modules included</div>
                <div className="grid grid-cols-2 md:grid-cols-3 gap-x-4 gap-y-1.5">
                  {MODULE_LABELS.map(([k, label]) => (
                    <label key={k} className="flex items-center gap-2 text-[13px] text-[#171717]">
                      <input type="checkbox" checked={f.modules.includes(k)} onChange={() => set('modules', f.modules.includes(k) ? f.modules.filter((m) => m !== k) : [...f.modules, k])} /> {label}
                    </label>
                  ))}
                </div>
              </div>
            )}
            <div className="md:col-span-2 flex items-center gap-2 pt-2">
              <button disabled={busy === 'save'} className={btn}>{busy === 'save' ? 'Saving...' : 'Save plan'}</button>
              <button type="button" onClick={() => setEdit(null)} className={btn2}>Cancel</button>
            </div>
            <div className="md:col-span-2"><Note m={editMsg} /></div>
          </form>
        </Modal>
      )}

      {apply && (
        <Modal title={`Apply the ${apply.plan.name} plan to customers`} onClose={() => setApply(null)} wide>
          <p className="text-[13px] text-[#525252] mb-3">These customers are on {apply.plan.name} with numbers that differ from it. Applying copies the plan's employee limit, users, sites, workspaces, grace period and modules to them. Their dates do not change. Customers with custom terms are never touched.</p>
          <table className="w-full text-left text-[13px] border border-[#E5E5E0] rounded">
            <thead className="bg-[#FAFAF8] text-[#737373] text-[11px] uppercase tracking-wider border-b border-[#E5E5E0]"><tr><th className="px-3 py-2">Customer</th><th className="px-3 py-2">Employees</th><th className="px-3 py-2">Users</th><th className="px-3 py-2">Sites</th><th className="px-3 py-2">Workspaces</th><th className="px-3 py-2">Modules</th></tr></thead>
            <tbody className="divide-y divide-[#E5E5E0]">
              {apply.rows.map((r) => (
                <tr key={r.licenseId}>
                  <td className="px-3 py-2 font-medium text-[#171717]">{r.tenantName}</td>
                  <td className="px-3 py-2 tabular-nums">{r.current.maxEmployees} to {r.next.maxEmployees}</td>
                  <td className="px-3 py-2 tabular-nums">{r.current.maxUsers} to {r.next.maxUsers}</td>
                  <td className="px-3 py-2 tabular-nums">{r.current.maxSites} to {r.next.maxSites}</td>
                  <td className="px-3 py-2 tabular-nums">{r.current.maxWorkspaces} to {r.next.maxWorkspaces}</td>
                  <td className="px-3 py-2 tabular-nums">{r.current.modules.length} to {r.next.modules.length}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="flex gap-2 pt-4">
            <button onClick={doApply} disabled={busy === 'apply'} className={btn}>{busy === 'apply' ? 'Applying...' : `Apply to ${apply.rows.length} customer${apply.rows.length !== 1 ? 's' : ''}`}</button>
            <button onClick={() => setApply(null)} className={btn2}>Cancel</button>
          </div>
        </Modal>
      )}
    </div>
  );
};

// ---------------------------------------------------------------- country templates

type TplForm = { code: string; name: string; timezone: string; currency: string; locale: string; payWeekStart: string; weekendDays: number[]; addHolidays: boolean; compliancePack: string; sortOrder: string };
const blankTpl = (): TplForm => ({ code: '', name: '', timezone: 'UTC', currency: 'USD', locale: 'en', payWeekStart: '0', weekendDays: [5, 6], addHolidays: true, compliancePack: '', sortOrder: '200' });

const TemplatesTab: React.FC<{ api: Api }> = ({ api }) => {
  const [rows, setRows] = useState<CountryTemplate[]>([]);
  const [msg, setMsg] = useState<Msg>(null);
  const [edit, setEdit] = useState<{ isNew: boolean; form: TplForm } | null>(null);
  const [editMsg, setEditMsg] = useState<Msg>(null);
  const [busy, setBusy] = useState('');
  const [packs, setPacks] = useState<{ code: string; name: string; region: string }[]>([]);
  useEffect(() => { api<{ code: string; name: string; region: string }[]>('/builtin-packs').then(setPacks).catch(() => {}); }, []);
  const zones = useMemo(() => { try { return (Intl as any).supportedValuesOf('timeZone') as string[]; } catch { return ['UTC']; } }, []);

  const load = () => api<CountryTemplate[]>('/country-templates').then(setRows).catch((e) => setMsg({ ok: false, text: e.message }));
  useEffect(() => { load(); }, []);

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!edit) return;
    const f = edit.form;
    setBusy('save'); setEditMsg(null);
    try {
      await api(`/country-templates/${f.code.toUpperCase()}`, { method: 'PUT', body: JSON.stringify({ name: f.name, timezone: f.timezone, currency: f.currency, locale: f.locale, payWeekStart: Number(f.payWeekStart), weekendDays: f.weekendDays, addHolidays: f.addHolidays, compliancePack: f.compliancePack || null, sortOrder: Number(f.sortOrder) }) });
      setEdit(null); setMsg({ ok: true, text: 'Country template saved.' }); await load();
    } catch (err: any) { setEditMsg({ ok: false, text: err.message }); } finally { setBusy(''); }
  };
  const remove = async (t: CountryTemplate) => {
    if (!window.confirm(`Delete the template for ${t.name}? Customers already set up are not affected.`)) return;
    setBusy(t.code); setMsg(null);
    try { await api(`/country-templates/${t.code}`, { method: 'DELETE' }); await load(); } catch (err: any) { setMsg({ ok: false, text: err.message }); } finally { setBusy(''); }
  };
  const set = (k: keyof TplForm, v: any) => setEdit((e) => (e ? { ...e, form: { ...e.form, [k]: v } } : e));
  const f = edit?.form;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-[13px] text-[#525252] max-w-2xl">What the New organisation form suggests when a country is chosen. They only pre-fill the form: changing a template never changes a customer that already exists.</p>
        <button onClick={() => { setEdit({ isNew: true, form: blankTpl() }); setEditMsg(null); }} className={btn}>Add country</button>
      </div>
      <Note m={msg} />
      <div className={`${card} overflow-x-auto`}>
        <table className="w-full text-left text-[13px]">
          <thead className="bg-[#FAFAF8] text-[#737373] text-[11px] uppercase tracking-wider border-b border-[#E5E5E0]">
            <tr><th className="px-4 py-2">Country</th><th className="px-4 py-2">Timezone</th><th className="px-4 py-2">Currency</th><th className="px-4 py-2">Language</th><th className="px-4 py-2">Pay week starts</th><th className="px-4 py-2">Weekend</th><th className="px-4 py-2">Public holidays</th><th className="px-4 py-2">Labour-law pack</th><th className="px-4 py-2" /></tr>
          </thead>
          <tbody className="divide-y divide-[#E5E5E0]">
            {rows.map((t) => (
              <tr key={t.code}>
                <td className="px-4 py-2.5"><span className="font-semibold text-[#171717]">{t.name}</span> <span className="text-[11px] text-[#737373]">{t.code}</span></td>
                <td className="px-4 py-2.5">{t.timezone}</td>
                <td className="px-4 py-2.5">{t.currency}</td>
                <td className="px-4 py-2.5">{LOCALES.find(([k]) => k === t.locale)?.[1] ?? t.locale}</td>
                <td className="px-4 py-2.5">{DAYS[t.payWeekStart]}</td>
                <td className="px-4 py-2.5">{t.weekendDays.map((d) => DAYS[d].slice(0, 3)).join(', ')}</td>
                <td className="px-4 py-2.5">{t.addHolidays ? 'Added' : 'Not added'}</td>
                <td className="px-4 py-2.5">{packs.find((p) => p.code === t.compliancePack)?.region ?? 'None'}</td>
                <td className="px-4 py-2.5 whitespace-nowrap text-right space-x-2">
                  <button onClick={() => { setEdit({ isNew: false, form: { code: t.code, name: t.name, timezone: t.timezone, currency: t.currency, locale: t.locale, payWeekStart: String(t.payWeekStart), weekendDays: t.weekendDays, addHolidays: t.addHolidays, compliancePack: t.compliancePack ?? '', sortOrder: String(t.sortOrder) } }); setEditMsg(null); }} className={btn2}>Edit</button>
                  <button onClick={() => remove(t)} disabled={busy === t.code} className={`${btn2} text-[#BC3F3F]`}>Delete</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {edit && f && (
        <Modal title={edit.isNew ? 'Add a country' : `Edit ${f.name}`} onClose={() => setEdit(null)}>
          <form onSubmit={save} className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <Lbl id="ct-code" text="Country code" hint={edit.isNew ? 'Two letters, for example EG. It also picks the public-holiday list.' : 'Fixed.'}>
              <input id="ct-code" className={inputCls} value={f.code} maxLength={2} onChange={(e) => set('code', e.target.value.toUpperCase())} readOnly={!edit.isNew} required />
            </Lbl>
            <Lbl id="ct-name" text="Country name"><input id="ct-name" className={inputCls} value={f.name} onChange={(e) => set('name', e.target.value)} required /></Lbl>
            <Lbl id="ct-tz" text="Timezone">
              <input id="ct-tz" list="ct-zones" className={inputCls} value={f.timezone} onChange={(e) => set('timezone', e.target.value)} required />
              <datalist id="ct-zones">{zones.map((z) => <option key={z} value={z} />)}</datalist>
            </Lbl>
            <Lbl id="ct-cur" text="Currency" hint="Three letters, for example EGP."><input id="ct-cur" className={inputCls} value={f.currency} maxLength={3} onChange={(e) => set('currency', e.target.value.toUpperCase())} required /></Lbl>
            <Lbl id="ct-loc" text="Language">
              <select id="ct-loc" className={inputCls} value={f.locale} onChange={(e) => set('locale', e.target.value)}>{LOCALES.map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
            </Lbl>
            <Lbl id="ct-pw" text="Pay week starts on">
              <select id="ct-pw" className={inputCls} value={f.payWeekStart} onChange={(e) => set('payWeekStart', e.target.value)}>{DAYS.map((d, i) => <option key={d} value={i}>{d}</option>)}</select>
            </Lbl>
            <div className="md:col-span-2">
              <div className="text-[12px] font-semibold text-[#171717] mb-1.5">Weekend days (one to three)</div>
              <div className="flex flex-wrap gap-x-4 gap-y-1.5">
                {DAYS.map((d, i) => {
                  const on = f.weekendDays.includes(i);
                  return <label key={d} className="flex items-center gap-1.5 text-[13px] text-[#171717]"><input type="checkbox" checked={on} disabled={(!on && f.weekendDays.length >= 3) || (on && f.weekendDays.length <= 1)} onChange={() => set('weekendDays', on ? f.weekendDays.filter((x) => x !== i) : [...f.weekendDays, i].sort())} /> {d}</label>;
                })}
              </div>
            </div>
            <Lbl id="ct-pack" text="Labour-law pack" hint="Assigned to a new customer in this country, so schedule and rotation checks have rules from the first day. They can change it later." wide>
              <select id="ct-pack" className={inputCls} value={f.compliancePack} onChange={(e) => set('compliancePack', e.target.value)}>
                <option value="">None</option>
                {packs.map((p) => <option key={p.code} value={p.code}>{p.name}</option>)}
              </select>
            </Lbl>
            <div className="md:col-span-2 flex items-center gap-2">
              <input id="ct-hol" type="checkbox" checked={f.addHolidays} onChange={(e) => set('addHolidays', e.target.checked)} />
              <label htmlFor="ct-hol" className="text-[13px] text-[#171717]">Tick "add public holidays" by default for this country</label>
            </div>
            <div className="md:col-span-2 flex items-center gap-2 pt-2">
              <button disabled={busy === 'save'} className={btn}>{busy === 'save' ? 'Saving...' : 'Save'}</button>
              <button type="button" onClick={() => setEdit(null)} className={btn2}>Cancel</button>
            </div>
            <div className="md:col-span-2"><Note m={editMsg} /></div>
          </form>
        </Modal>
      )}
    </div>
  );
};

export { PlansTab, TemplatesTab };
