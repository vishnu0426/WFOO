/**
 * New organisation: one page, no wizard. Sections on the left, a live summary on the right,
 * and a sticky action bar. Required fields are marked and checked together on submit.
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { MODULE_LABELS, type CountryTemplate, type Plan } from './PlansSettings';

interface Props {
  existingCodes: string[];
  timezones: string[];
  currencies: string[];
  plans: Plan[];
  templates: CountryTemplate[];
  packs: { code: string; name: string; region: string }[];
  onSubmit: (payload: Record<string, any>) => Promise<any>;
  onCancel: () => void;
  onDone: () => void;
}

const COUNTRIES = ['India', 'United States', 'United Kingdom', 'Canada', 'Australia', 'Singapore', 'United Arab Emirates', 'Germany', 'France', 'Netherlands', 'Ireland', 'Spain', 'Italy', 'Philippines', 'Malaysia', 'South Africa', 'Saudi Arabia', 'Japan', 'Brazil', 'Mexico', 'New Zealand', 'Other'];
const INDUSTRIES = ['Contact centre / BPO', 'Banking and financial services', 'Insurance', 'Healthcare', 'Telecom', 'Retail and e-commerce', 'Travel and hospitality', 'Technology and software', 'Utilities', 'Government', 'Education', 'Other'];
const SIZES = ['1 to 200', '201 to 1,000', '1,001 to 5,000', '5,001 to 20,000', 'More than 20,000'];
const LOCALES: [string, string][] = [['en', 'English'], ['en-GB', 'English (UK)'], ['en-IN', 'English (India)'], ['es', 'Spanish'], ['fr', 'French'], ['de', 'German']];

const DAY_NAMES = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

const iso = (d: Date) => d.toISOString().slice(0, 10);
const emailOk = (v: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.trim());
const inputCls = 'w-full h-9 px-3 border border-[#D4D4CF] rounded text-[13px] bg-white text-[#171717] placeholder-[#A3A3A3] focus:outline-none focus:border-[#171717] focus:ring-1 focus:ring-[#171717]';

const blank = () => ({
  name: '', legalName: '', code: '', country: '', industry: '', companySize: '', registrationId: '', website: '',
  contactName: '', contactEmail: '', contactPhone: '', billingContactName: '', billingContactEmail: '', securityContactName: '', securityContactEmail: '',
  addr1: '', addr2: '', city: '', state: '', postalCode: '',
  billingSame: true, bAddr1: '', bAddr2: '', bCity: '', bState: '', bPostalCode: '',
  timezone: 'UTC', currency: 'USD', locale: 'en', mainSiteName: '',
  payWeekStart: '0', weekend: [5, 6] as number[], addHolidays: true, compliancePack: '',
  planTier: '', maxEmployees: '', term: '12', startDate: iso(new Date()), endDate: '', isTrial: false,
  customise: false, maxUsers: '', maxSites: '', maxWorkspaces: '', modules: [] as string[], customReason: '',
  adminName: '', adminEmail: '',
  accountOwner: '', contractRef: '', internalNotes: '', termsAccepted: false,
});
type Form = ReturnType<typeof blank>;

const Section: React.FC<{ id: string; title: string; hint?: string; children: React.ReactNode }> = ({ id, title, hint, children }) => (
  <section id={id} className="bg-white border border-[#E5E5E0] rounded-lg shadow-xs scroll-mt-4">
    <div className="px-5 py-3.5 border-b border-[#E5E5E0]">
      <h2 className="text-[14px] font-semibold text-[#171717]">{title}</h2>
      {hint && <p className="text-[12px] text-[#737373] mt-0.5">{hint}</p>}
    </div>
    <div className="p-5 grid grid-cols-1 md:grid-cols-2 gap-x-4 gap-y-4">{children}</div>
  </section>
);

const Field: React.FC<{ label: string; required?: boolean; error?: string; hint?: string; wide?: boolean; htmlFor: string; children: React.ReactNode }> = ({ label, required, error, hint, wide, htmlFor, children }) => (
  <div className={wide ? 'md:col-span-2' : ''}>
    <label htmlFor={htmlFor} className="block text-[12px] font-semibold text-[#171717] mb-1">
      {label}{required && <span className="text-[#BC3F3F]"> *</span>}
    </label>
    {children}
    {error ? <p role="alert" className="text-[11px] text-[#BC3F3F] mt-1">{error}</p> : hint ? <p className="text-[11px] text-[#737373] mt-1">{hint}</p> : null}
  </div>
);

export const NewOrganisationForm: React.FC<Props> = ({ existingCodes, timezones, currencies, plans, templates, packs, onSubmit, onCancel, onDone }) => {
  const [f, setF] = useState<Form>(blank);
  const [submitted, setSubmitted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [serverError, setServerError] = useState('');
  const [result, setResult] = useState<any | null>(null);
  const [copied, setCopied] = useState(false);
  const codeTouched = useRef(false);
  const touched = useRef(new Set<string>());      // regional fields the person set by hand: a later country change leaves them alone

  const set = <K extends keyof Form>(k: K, v: Form[K]) => setF((p) => ({ ...p, [k]: v }));
  const setRegional = <K extends keyof Form>(k: K, v: Form[K]) => { touched.current.add(k as string); set(k, v); };
  const pickCountry = (country: string) => {
    const t = templates.find((x) => x.name === country);
    setF((p) => ({
      ...p, country,
      ...(t && !touched.current.has('timezone') ? { timezone: t.timezone } : {}),
      ...(t && !touched.current.has('currency') ? { currency: t.currency } : {}),
      ...(t && !touched.current.has('locale') ? { locale: t.locale } : {}),
      ...(t && !touched.current.has('payWeekStart') ? { payWeekStart: String(t.payWeekStart) } : {}),
      ...(t && !touched.current.has('weekend') ? { weekend: t.weekendDays } : {}),
      ...(!touched.current.has('compliancePack') ? { compliancePack: t?.compliancePack ?? '' } : {}),
      addHolidays: !!t && t.addHolidays,
    }));
  };
  const info = templates.find((x) => x.name === f.country);
  const countryOptions = useMemo(() => [...new Set([...COUNTRIES.filter((c) => c !== 'Other'), ...templates.map((t) => t.name)])].sort((a, b) => a.localeCompare(b)).concat('Other'), [templates]);

  // the plan and its terms
  const plan = plans.find((x) => x.code === f.planTier);
  useEffect(() => {
    if (!f.planTier && plans.length) setF((p) => ({ ...p, planTier: (plans.find((x) => x.code === 'ENTERPRISE') ?? plans[0]).code }));
  }, [plans]);
  const showLimits = !!plan && (plan.isCustom || f.customise);
  const limit = (k: 'maxUsers' | 'maxSites' | 'maxWorkspaces') => (showLimits && f[k] !== '' ? Number(f[k]) : plan ? plan[k] : 0);
  const addMonthsIso = (from: string, months: number) => { const d = new Date(`${from}T00:00:00Z`); d.setUTCMonth(d.getUTCMonth() + months); return d.toISOString().slice(0, 10); };
  const licenceEnd = !plan ? '' : f.isTrial ? new Date(new Date(`${f.startDate}T00:00:00Z`).getTime() + plan.trialDays * 86400000).toISOString().slice(0, 10) : f.term === 'custom' ? f.endDate : addMonthsIso(f.startDate, Number(f.term));
  const text = (k: keyof Form) => ({
    value: f[k] as string,
    onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => set(k, e.target.value as any),
  });

  const errors = useMemo(() => {
    const e: Record<string, string> = {};
    const req = (k: keyof Form, label: string) => { if (!String(f[k]).trim()) e[k] = `${label} is required`; };
    req('name', 'Organisation name'); req('legalName', 'Legal name'); req('country', 'Country');
    req('contactName', 'Primary contact name'); req('adminName', 'Administrator name');
    if (!f.code.trim()) e.code = 'Code is required';
    else if (!/^[A-Za-z0-9._-]+$/.test(f.code)) e.code = 'Use letters, numbers, dot, dash or underscore';
    else if (existingCodes.some((c) => c.toUpperCase() === f.code.trim().toUpperCase())) e.code = 'This code is already in use';
    if (!emailOk(f.contactEmail)) e.contactEmail = 'Enter a valid email address';
    if (!emailOk(f.adminEmail)) e.adminEmail = 'Enter a valid email address';
    if (f.billingContactEmail && !emailOk(f.billingContactEmail)) e.billingContactEmail = 'Enter a valid email address';
    if (f.securityContactEmail && !emailOk(f.securityContactEmail)) e.securityContactEmail = 'Enter a valid email address';
    if (!plan) e.planTier = 'Choose a plan';
    if (showLimits) {
      const seats = Number(f.maxEmployees);
      if (!Number.isInteger(seats) || seats < 1) e.maxEmployees = 'Enter the number of employee seats';
      const pos = (k: 'maxUsers' | 'maxSites' | 'maxWorkspaces', label: string) => { const n = Number(f[k]); if (!Number.isInteger(n) || n < 1) e[k] = `${label} must be a whole number of at least 1`; };
      pos('maxUsers', 'User accounts'); pos('maxSites', 'Sites'); pos('maxWorkspaces', 'Workspaces');
      if (f.modules.length === 0) e.modules = 'Enable at least one module';
      if (!plan?.isCustom && f.customReason.trim().length < 5) e.customReason = 'Say why this customer differs from the plan';
    }
    if (!f.isTrial && f.term === 'custom' && !f.endDate) e.endDate = 'End date is required';
    if (licenceEnd && licenceEnd <= f.startDate) e.endDate = 'The licence must end after it starts';
    return e;
  }, [f, existingCodes, plan, showLimits, licenceEnd]);

  const labels: Record<string, string> = { name: 'Organisation name', legalName: 'Legal name', code: 'Code', country: 'Country', contactName: 'Primary contact', contactEmail: 'Primary contact email', adminName: 'Administrator name', adminEmail: 'Administrator email', endDate: 'Licence end date', planTier: 'Plan', customReason: 'Reason for custom terms', maxUsers: 'User accounts', maxSites: 'Sites', maxWorkspaces: 'Workspaces', maxEmployees: 'Employee seats', modules: 'Modules' };
  const missing = Object.keys(errors).map((k) => labels[k] || k);
  const err = (k: string) => (submitted ? errors[k] : undefined);

  const pickPlan = (code: string) => {
    const next = plans.find((x) => x.code === code);
    setF((prev) => {
      return { ...prev, planTier: code, customise: false, maxEmployees: '', maxUsers: '', maxSites: '', maxWorkspaces: '', modules: [], customReason: '' };
    });
  };
  const startCustomise = () => plan && setF((prev) => ({ ...prev, customise: true, maxEmployees: String(plan.seatsMax), maxUsers: String(plan.maxUsers), maxSites: String(plan.maxSites), maxWorkspaces: String(plan.maxWorkspaces), modules: plan.modules }));
  const stopCustomise = () => setF((prev) => ({ ...prev, customise: false, maxEmployees: '', maxUsers: '', maxSites: '', maxWorkspaces: '', modules: [], customReason: '' }));

  const submit = async (ev: React.FormEvent) => {
    ev.preventDefault();
    setSubmitted(true);
    setServerError('');
    const firstBad = Object.keys(errors)[0];
    if (firstBad) {
      document.getElementById(`f-${firstBad}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      (document.getElementById(`f-${firstBad}`) as HTMLElement | null)?.focus?.();
      return;
    }
    const registered = { line1: f.addr1, line2: f.addr2, city: f.city, state: f.state, postalCode: f.postalCode, country: f.country };
    const billing = f.billingSame ? registered : { line1: f.bAddr1, line2: f.bAddr2, city: f.bCity, state: f.bState, postalCode: f.bPostalCode, country: f.country };
    setBusy(true);
    try {
      const res = await onSubmit({
        name: f.name.trim(), code: f.code.trim().toUpperCase(), legalName: f.legalName.trim(),
        timezone: f.timezone, currency: f.currency, locale: f.locale,
        ...(f.mainSiteName.trim() ? { mainSiteName: f.mainSiteName.trim() } : {}),
        payWeekStart: Number(f.payWeekStart), weekendDays: f.weekend, ...(f.compliancePack ? { compliancePack: f.compliancePack } : {}), ...(f.addHolidays && info ? { holidayCountry: info.code } : {}),
        country: f.country, industry: f.industry, companySize: f.companySize, registrationId: f.registrationId.trim(), website: f.website.trim(),
        contactName: f.contactName.trim(), contactEmail: f.contactEmail.trim(), contactPhone: f.contactPhone.trim(),
        billingContactName: f.billingContactName.trim(), billingContactEmail: f.billingContactEmail.trim(),
        securityContactName: f.securityContactName.trim(), securityContactEmail: f.securityContactEmail.trim(),
        registeredAddress: registered, billingAddress: billing, billingSameAsRegistered: f.billingSame,
        contractRef: f.contractRef.trim(), accountOwner: f.accountOwner.trim(), internalNotes: f.internalNotes.trim(),
        termsAcceptedAt: f.termsAccepted ? new Date().toISOString() : null, isTrial: f.isTrial,
        adminName: f.adminName.trim(), adminEmail: f.adminEmail.trim(),
        planTier: f.planTier, startDate: f.startDate,
        ...(f.isTrial ? {} : f.term === 'custom' ? { endDate: f.endDate } : { termMonths: Number(f.term) }),
        ...(showLimits ? { maxEmployees: Number(f.maxEmployees), maxUsers: Number(f.maxUsers), maxSites: Number(f.maxSites), maxWorkspaces: Number(f.maxWorkspaces), modules: f.modules, customReason: f.customReason.trim() } : {}),
      });
      setResult(res);
    } catch (e: any) {
      setServerError(e.message || 'The organisation could not be created');
    } finally {
      setBusy(false);
    }
  };

  // ---------------------------------------------------------------- created
  if (result) {
    return (
      <div className="max-w-2xl bg-white border border-[#E5E5E0] rounded-lg shadow-xs p-6 space-y-4">
        <div>
          <h2 className="text-[16px] font-semibold text-[#171717]">Organisation created</h2>
          <p className="text-[13px] text-[#737373] mt-1">{result.organization?.name} ({result.organization?.code}) is ready, with its default workspace and licence.{result.holidaysAdded ? ` ${result.holidaysAdded} public holidays were added to its calendar.` : ''}</p>
        </div>
        {result.admin && (
          <div className="border border-[#E5E5E0] rounded p-4 bg-[#FAFAF8] space-y-2 text-[13px]">
            <div className="font-semibold text-[#171717]">First administrator</div>
            <div>Name: <span className="text-[#171717]">{result.admin.displayName}</span></div>
            <div>Sign-in: <span className="text-[#171717] select-all">{result.admin.username}</span></div>
            {result.invite ? (
              result.invite.email?.sent ? (
                <p className="text-[#2A7553]">An email with a one-time link to set a password was sent to {result.admin.email}. The link works once and expires in 7 days.</p>
              ) : (
                <>
                  <p className="text-[#8F6200]">{result.invite.email ? `The invitation email could not be sent: ${result.invite.email.error}` : 'No email address was given, so no email was sent.'} Send this one-time link to the administrator yourself. It works once and expires in 7 days.</p>
                  <input readOnly aria-label="One-time set-password link" value={result.invite.link} onFocus={(e) => e.currentTarget.select()} className="w-full h-9 px-3 border border-[#D4D4CF] rounded text-[12px] bg-white text-[#171717] font-mono" />
                  <button onClick={() => { navigator.clipboard?.writeText(result.invite.link).then(() => { setCopied(true); setTimeout(() => setCopied(false), 2000); }).catch(() => {}); }} className="px-3 py-1.5 rounded border border-[#E5E5E0] bg-white hover:bg-[#FAFAF8] text-[12px] font-semibold">{copied ? 'Copied' : 'Copy link'}</button>
                </>
              )
            ) : (
              <p className="text-[12px] text-[#737373]">The password was set by the operator.</p>
            )}
          </div>
        )}
        <div className="flex gap-2 pt-2">
          <button onClick={onDone} className="px-4 py-2 rounded bg-[#171717] hover:bg-[#333] text-white text-[13px] font-semibold">Back to organisations</button>
          <button onClick={() => { setResult(null); setF(blank()); setSubmitted(false); codeTouched.current = false; }} className="px-4 py-2 rounded border border-[#E5E5E0] bg-white hover:bg-[#FAFAF8] text-[13px] font-semibold">Create another</button>
        </div>
      </div>
    );
  }

  // ---------------------------------------------------------------- form
  
  return (
    <form onSubmit={submit} noValidate className="grid grid-cols-1 xl:grid-cols-[minmax(0,1fr)_300px] gap-6 items-start">
      <div className="space-y-5 pb-24">
        {submitted && missing.length > 0 && (
          <div role="alert" className="text-[13px] rounded px-3.5 py-2.5 border bg-[#FCEBEC] text-[#BC3F3F] border-[#C84A4A]/20">
            {missing.length} field{missing.length !== 1 ? 's' : ''} need attention: {missing.join(', ')}.
          </div>
        )}
        {serverError && <div role="alert" className="text-[13px] rounded px-3.5 py-2.5 border bg-[#FCEBEC] text-[#BC3F3F] border-[#C84A4A]/20">{serverError}</div>}

        <Section id="s-org" title="Organisation" hint="Who the customer is. The code is used in sign-in and cannot be changed later.">
          <Field label="Organisation name" required htmlFor="f-name" error={err('name')}>
            <input id="f-name" className={inputCls} placeholder="e.g. Acme Services" value={f.name} onChange={(e) => {
              const name = e.target.value;
              setF((p) => ({ ...p, name, legalName: p.legalName || '', code: codeTouched.current ? p.code : name.replace(/[^A-Za-z0-9]/g, '').slice(0, 12).toUpperCase() }));
            }} />
          </Field>
          <Field label="Legal entity name" required htmlFor="f-legalName" error={err('legalName')}>
            <input id="f-legalName" className={inputCls} placeholder="e.g. Acme Services Private Limited" {...text('legalName')} />
          </Field>
          <Field label="Organisation code" required htmlFor="f-code" error={err('code')} hint="Letters and numbers, up to 40 characters.">
            <input id="f-code" className={inputCls} placeholder="ACME" value={f.code} onChange={(e) => { codeTouched.current = true; set('code', e.target.value.toUpperCase()); }} />
          </Field>
          <Field label="Country" required htmlFor="f-country" error={err('country')}>
            <select id="f-country" className={inputCls} value={f.country} onChange={(e) => pickCountry(e.target.value)}>
              <option value="">Select a country</option>
              {countryOptions.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
          </Field>
          <Field label="Industry" htmlFor="f-industry">
            <select id="f-industry" className={inputCls} {...text('industry')}>
              <option value="">Select an industry</option>
              {INDUSTRIES.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
          </Field>
          <Field label="Company size (employees)" htmlFor="f-companySize">
            <select id="f-companySize" className={inputCls} {...text('companySize')}>
              <option value="">Select a size</option>
              {SIZES.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
          </Field>
          <Field label="Registration or tax number" htmlFor="f-registrationId">
            <input id="f-registrationId" className={inputCls} {...text('registrationId')} />
          </Field>
          <Field label="Website" htmlFor="f-website">
            <input id="f-website" className={inputCls} placeholder="https://" {...text('website')} />
          </Field>
        </Section>

        <Section id="s-contacts" title="Contacts" hint="Who we speak to about this account.">
          <Field label="Primary contact name" required htmlFor="f-contactName" error={err('contactName')}>
            <input id="f-contactName" className={inputCls} {...text('contactName')} />
          </Field>
          <Field label="Primary contact email" required htmlFor="f-contactEmail" error={err('contactEmail')}>
            <input id="f-contactEmail" type="email" className={inputCls} placeholder="name@company.com" {...text('contactEmail')} />
          </Field>
          <Field label="Primary contact phone" htmlFor="f-contactPhone">
            <input id="f-contactPhone" className={inputCls} placeholder="+91 98765 43210" {...text('contactPhone')} />
          </Field>
          <div className="hidden md:block" />
          <Field label="Billing contact name" htmlFor="f-billingContactName">
            <input id="f-billingContactName" className={inputCls} {...text('billingContactName')} />
          </Field>
          <Field label="Billing contact email" htmlFor="f-billingContactEmail" error={err('billingContactEmail')}>
            <input id="f-billingContactEmail" type="email" className={inputCls} {...text('billingContactEmail')} />
          </Field>
          <Field label="Security contact name" htmlFor="f-securityContactName" hint="Receives security notices.">
            <input id="f-securityContactName" className={inputCls} {...text('securityContactName')} />
          </Field>
          <Field label="Security contact email" htmlFor="f-securityContactEmail" error={err('securityContactEmail')}>
            <input id="f-securityContactEmail" type="email" className={inputCls} {...text('securityContactEmail')} />
          </Field>
        </Section>

        <Section id="s-address" title="Address">
          <Field label="Registered address, line 1" htmlFor="f-addr1" wide><input id="f-addr1" className={inputCls} {...text('addr1')} /></Field>
          <Field label="Line 2" htmlFor="f-addr2" wide><input id="f-addr2" className={inputCls} {...text('addr2')} /></Field>
          <Field label="City" htmlFor="f-city"><input id="f-city" className={inputCls} {...text('city')} /></Field>
          <Field label="State or region" htmlFor="f-state"><input id="f-state" className={inputCls} {...text('state')} /></Field>
          <Field label="Postal code" htmlFor="f-postalCode"><input id="f-postalCode" className={inputCls} {...text('postalCode')} /></Field>
          <div className="md:col-span-2 flex items-center gap-2">
            <input id="f-billingSame" type="checkbox" checked={f.billingSame} onChange={(e) => set('billingSame', e.target.checked)} />
            <label htmlFor="f-billingSame" className="text-[13px] text-[#171717]">Billing address is the same as the registered address</label>
          </div>
          {!f.billingSame && (
            <>
              <Field label="Billing address, line 1" htmlFor="f-bAddr1" wide><input id="f-bAddr1" className={inputCls} {...text('bAddr1')} /></Field>
              <Field label="Line 2" htmlFor="f-bAddr2" wide><input id="f-bAddr2" className={inputCls} {...text('bAddr2')} /></Field>
              <Field label="City" htmlFor="f-bCity"><input id="f-bCity" className={inputCls} {...text('bCity')} /></Field>
              <Field label="State or region" htmlFor="f-bState"><input id="f-bState" className={inputCls} {...text('bState')} /></Field>
              <Field label="Postal code" htmlFor="f-bPostalCode"><input id="f-bPostalCode" className={inputCls} {...text('bPostalCode')} /></Field>
            </>
          )}
        </Section>

        <Section id="s-regional" title="Regional defaults" hint="Used as the starting point for the organisation and its first workspace.">
          <Field label="Main site name" htmlFor="f-mainSiteName" hint="The first site is created for you from the country, time zone and company address above. Leave blank for “Head office”.">
            <input id="f-mainSiteName" className={inputCls} placeholder="Head office" maxLength={80} {...text('mainSiteName')} />
          </Field>
          <Field label="Timezone" required htmlFor="f-timezone">
            <select id="f-timezone" className={inputCls} value={f.timezone} onChange={(e) => setRegional('timezone', e.target.value)}>{timezones.map((z) => <option key={z} value={z}>{z}</option>)}</select>
          </Field>
          <Field label="Currency" required htmlFor="f-currency">
            <select id="f-currency" className={inputCls} value={f.currency} onChange={(e) => setRegional('currency', e.target.value)}>{currencies.map((z) => <option key={z} value={z}>{z}</option>)}</select>
          </Field>
          <Field label="Language" htmlFor="f-locale">
            <select id="f-locale" className={inputCls} value={f.locale} onChange={(e) => setRegional('locale', e.target.value)}>{LOCALES.map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
          </Field>
          <Field label="Pay week starts on" required htmlFor="f-payWeekStart" hint="Weekly hours, days per week and overtime are counted from this day.">
            <select id="f-payWeekStart" className={inputCls} value={f.payWeekStart} onChange={(e) => setRegional('payWeekStart', e.target.value)}>{DAY_NAMES.map((n, i) => <option key={n} value={i}>{n}</option>)}</select>
          </Field>
          <div className="md:col-span-2">
            <div id="f-weekend" className="text-[12px] font-semibold text-[#171717] mb-1.5">Weekend days <span className="text-[#BC3F3F]">*</span></div>
            <div className="flex flex-wrap gap-x-4 gap-y-1.5" role="group" aria-label="Weekend days">
              {DAY_NAMES.map((n, i) => {
                const on = f.weekend.includes(i);
                return (
                  <label key={n} className="flex items-center gap-1.5 text-[13px] text-[#171717]">
                    <input type="checkbox" checked={on} disabled={(!on && f.weekend.length >= 3) || (on && f.weekend.length <= 1)} onChange={() => setRegional('weekend', on ? f.weekend.filter((x) => x !== i) : [...f.weekend, i].sort((a, b) => a - b))} /> {n}
                  </label>
                );
              })}
            </div>
            <p className="text-[11px] text-[#737373] mt-1">Used for weekend pay, fair sharing of weekend shifts, and paid leave. It does not close anything: a 24x7 call centre is still scheduled on these days. Choose one to three days. A WFM group can use its own weekend later.</p>
          </div>
          <Field label="Labour-law pack" htmlFor="f-compliancePack" hint="Rules every schedule and rotation pattern is checked against. Suggested from the country; the customer can change it under Compliance Packs." wide>
            <select id="f-compliancePack" className={inputCls} value={f.compliancePack} onChange={(e) => setRegional('compliancePack', e.target.value)}>
              <option value="">None for now</option>
              {packs.map((p) => <option key={p.code} value={p.code}>{p.name}</option>)}
            </select>
          </Field>
          <div className="md:col-span-2 flex items-center gap-2">
            <input id="f-addHolidays" type="checkbox" checked={f.addHolidays} disabled={!info} onChange={(e) => set('addHolidays', e.target.checked)} />
            <label htmlFor="f-addHolidays" className="text-[13px] text-[#171717]">Add {f.country && info ? `${f.country}'s` : 'the country\'s'} public holidays for this year and next</label>
            {!info && f.country && <span className="text-[11px] text-[#737373]">(not available for this country yet; the customer can add holidays themselves)</span>}
          </div>
          {info && <p className="md:col-span-2 text-[11px] text-[#737373]">Suggested for {f.country}: change anything that differs for this customer.</p>}
        </Section>

        <Section id="s-licence" title="Licence" hint="Choose the plan the customer bought and how many employees. The plan sets the rest. Plans are managed under Settings.">
          <Field label="Plan" required htmlFor="f-planTier" error={err('planTier')}>
            <select id="f-planTier" className={inputCls} value={f.planTier} onChange={(e) => pickPlan(e.target.value)}>
              {plans.map((p) => <option key={p.code} value={p.code}>{p.name}</option>)}
            </select>
          </Field>
          <Field label="Term" required htmlFor="f-term">
            <select id="f-term" className={inputCls} value={f.isTrial ? 'trial' : f.term} disabled={f.isTrial} onChange={(e) => set('term', e.target.value)}>
              {f.isTrial && <option value="trial">Trial ({plan?.trialDays ?? 30} days)</option>}
              <option value="12">1 year</option><option value="24">2 years</option><option value="36">3 years</option><option value="custom">Choose the end date</option>
            </select>
          </Field>
          <Field label="Starts" required htmlFor="f-startDate">
            <input id="f-startDate" type="date" className={inputCls} {...text('startDate')} />
          </Field>
          {!f.isTrial && f.term === 'custom' ? (
            <Field label="Ends" required htmlFor="f-endDate" error={err('endDate')}>
              <input id="f-endDate" type="date" className={inputCls} {...text('endDate')} />
            </Field>
          ) : (
            <div>
              <div className="block text-[12px] font-semibold text-[#171717] mb-1">Ends</div>
              <div id="f-endDate" tabIndex={-1} className="h-9 px-3 flex items-center border border-[#E5E5E0] rounded text-[13px] bg-[#FAFAF8] text-[#171717]">{licenceEnd || 'Choose a plan'}</div>
              {err('endDate') && <p role="alert" className="text-[11px] text-[#BC3F3F] mt-1">{errors.endDate}</p>}
            </div>
          )}
          <div className="flex items-center gap-2 self-end h-9">
            <input id="f-isTrial" type="checkbox" checked={f.isTrial} onChange={(e) => set('isTrial', e.target.checked)} />
            <label htmlFor="f-isTrial" className="text-[13px] text-[#171717]">This is a trial</label>
          </div>

          {plan && (
            <div className="md:col-span-2 border border-[#E5E5E0] rounded-lg bg-[#FAFAF8] p-4 space-y-3">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <div className="text-[13px] font-semibold text-[#171717]">{plan.name}{plan.isCustom ? ' (negotiated terms)' : ' includes'}</div>
                  {plan.description && <p className="text-[12px] text-[#737373] mt-0.5">{plan.description}</p>}
                </div>
                {!plan.isCustom && (f.customise
                  ? <button type="button" onClick={stopCustomise} className="text-[12px] font-semibold text-[#2A7553] hover:underline shrink-0">Back to the plan</button>
                  : <button type="button" onClick={startCustomise} className="text-[12px] font-semibold text-[#2A7553] hover:underline shrink-0">Customise for this customer</button>)}
              </div>
              {!showLimits ? (
                <>
                  <dl className="grid grid-cols-2 md:grid-cols-4 gap-3 text-[13px]">
                    <div><dt className="text-[11px] text-[#737373]">Employee seats</dt><dd className="tabular-nums text-[#171717]">{plan.seatsMax.toLocaleString()}</dd></div>
                    <div><dt className="text-[11px] text-[#737373]">User accounts</dt><dd className="tabular-nums text-[#171717]">{plan.maxUsers.toLocaleString()}</dd></div>
                    <div><dt className="text-[11px] text-[#737373]">Sites</dt><dd className="tabular-nums text-[#171717]">{plan.maxSites.toLocaleString()}</dd></div>
                    <div><dt className="text-[11px] text-[#737373]">Workspaces</dt><dd className="tabular-nums text-[#171717]">{plan.maxWorkspaces.toLocaleString()}</dd></div>
                  </dl>
                  <div className="text-[12px] text-[#525252]"><span className="text-[#737373]">Modules: </span>{MODULE_LABELS.filter(([k]) => plan.modules.includes(k)).map(([, l]) => l).join(', ')}</div>
                </>
              ) : (
                <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                  <Field label="Employee seats" required htmlFor="f-maxEmployees" error={err('maxEmployees')}><input id="f-maxEmployees" type="number" min={1} className={inputCls} {...text('maxEmployees')} /></Field>
                  <Field label="User accounts" required htmlFor="f-maxUsers" error={err('maxUsers')}><input id="f-maxUsers" type="number" min={1} className={inputCls} {...text('maxUsers')} /></Field>
                  <Field label="Sites" required htmlFor="f-maxSites" error={err('maxSites')}><input id="f-maxSites" type="number" min={1} className={inputCls} {...text('maxSites')} /></Field>
                  <Field label="Workspaces" required htmlFor="f-maxWorkspaces" error={err('maxWorkspaces')}><input id="f-maxWorkspaces" type="number" min={1} className={inputCls} {...text('maxWorkspaces')} /></Field>
                  <div className="md:col-span-3">
                    <div id="f-modules" tabIndex={-1} className="text-[12px] font-semibold text-[#171717] mb-1.5">Modules <span className="text-[#BC3F3F]">*</span></div>
                    <div className="grid grid-cols-2 md:grid-cols-3 gap-x-4 gap-y-1.5">
                      {MODULE_LABELS.map(([k, label]) => (
                        <label key={k} className="flex items-center gap-2 text-[13px] text-[#171717]">
                          <input type="checkbox" checked={f.modules.includes(k)} onChange={() => set('modules', f.modules.includes(k) ? f.modules.filter((m) => m !== k) : [...f.modules, k])} /> {label}
                        </label>
                      ))}
                    </div>
                    {err('modules') && <p role="alert" className="text-[11px] text-[#BC3F3F] mt-1">{errors.modules}</p>}
                  </div>
                  <div className="md:col-span-3">
                    <Field label={plan.isCustom ? 'Notes on the agreement (optional)' : 'Why this customer differs from the plan'} required={!plan.isCustom} htmlFor="f-customReason" error={err('customReason')} hint={plan.isCustom ? undefined : 'Recorded on the licence as custom terms.'}>
                      <input id="f-customReason" className={inputCls} {...text('customReason')} />
                    </Field>
                  </div>
                </div>
              )}
            </div>
          )}
        </Section>

        <Section id="s-admin" title="First administrator" hint="The customer's own administrator. They get a one-time link to set their own password, by email if the mail server is set up under Settings.">
          <Field label="Full name" required htmlFor="f-adminName" error={err('adminName')}>
            <input id="f-adminName" className={inputCls} {...text('adminName')} />
          </Field>
          <Field label="Email (used to sign in)" required htmlFor="f-adminEmail" error={err('adminEmail')}>
            <input id="f-adminEmail" type="email" className={inputCls} placeholder="admin@company.com" {...text('adminEmail')} />
          </Field>
        </Section>

        <Section id="s-internal" title="Internal" hint="For our own records. The customer never sees these.">
          <Field label="Account owner" htmlFor="f-accountOwner" hint="Who looks after this customer.">
            <input id="f-accountOwner" className={inputCls} {...text('accountOwner')} />
          </Field>
          <Field label="Contract or purchase order reference" htmlFor="f-contractRef">
            <input id="f-contractRef" className={inputCls} {...text('contractRef')} />
          </Field>
          <Field label="Notes" htmlFor="f-internalNotes" wide>
            <textarea id="f-internalNotes" rows={3} className={`${inputCls} h-auto py-2`} {...text('internalNotes')} />
          </Field>
          <div className="md:col-span-2 flex items-center gap-2">
            <input id="f-termsAccepted" type="checkbox" checked={f.termsAccepted} onChange={(e) => set('termsAccepted', e.target.checked)} />
            <label htmlFor="f-termsAccepted" className="text-[13px] text-[#171717]">The customer has accepted the terms and the data processing agreement</label>
          </div>
        </Section>
      </div>

      {/* Summary */}
      <aside className="xl:sticky xl:top-0 space-y-4">
        <div className="bg-white border border-[#E5E5E0] rounded-lg shadow-xs">
          <div className="px-4 py-3 border-b border-[#E5E5E0] text-[14px] font-semibold text-[#171717]">Summary</div>
          <dl className="p-4 space-y-2.5 text-[13px]">
            {([
              ['Organisation', f.name || 'Not set'],
              ['Code', f.code || 'Not set'],
              ['Country', f.country || 'Not set'],
              ['Plan', plan ? `${plan.name}${f.isTrial ? ' (trial)' : ''}${showLimits && !plan.isCustom ? ', custom terms' : ''}` : 'Not set'],
              ['Employee seats', plan ? (showLimits && Number(f.maxEmployees) ? Number(f.maxEmployees) : plan.seatsMax).toLocaleString() : 'Not set'],
              ['Licence ends', licenceEnd || 'Not set'],
              ['Administrator', f.adminEmail || 'Not set'],
            ] as [string, string][]).map(([k, v]) => (
              <div key={k} className="flex justify-between gap-3"><dt className="text-[#737373]">{k}</dt><dd className="text-[#171717] text-right break-all">{v}</dd></div>
            ))}
          </dl>
          <div className="px-4 py-3 border-t border-[#E5E5E0] text-[12px]">
            {missing.length === 0 ? <span className="text-[#2A7553] font-semibold">All required fields are filled in.</span> : <span className="text-[#8F6200]">{missing.length} required field{missing.length !== 1 ? 's' : ''} left.</span>}
          </div>
        </div>
      </aside>

      {/* Action bar */}
      <div className="fixed bottom-0 left-56 right-0 z-20 border-t border-[#E5E5E0] bg-white/95 backdrop-blur px-6 py-3 flex items-center justify-end gap-2">
        <button type="button" onClick={onCancel} className="px-4 py-2 rounded border border-[#E5E5E0] bg-white hover:bg-[#FAFAF8] text-[13px] font-semibold">Cancel</button>
        <button type="submit" disabled={busy} className="px-4 py-2 rounded bg-[#171717] hover:bg-[#333] disabled:opacity-50 text-white text-[13px] font-semibold">{busy ? 'Creating...' : 'Create organisation'}</button>
      </div>
    </form>
  );
};
