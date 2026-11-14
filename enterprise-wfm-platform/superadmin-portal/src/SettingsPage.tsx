/** Platform settings: mail server and sign-in security. */
import React, { useEffect, useState } from 'react';
import { PlansTab, TemplatesTab } from './PlansSettings';

type Api = <T>(path: string, options?: RequestInit) => Promise<T>;

interface Field { key: string; label: string; secret?: boolean; required?: boolean; help?: string; placeholder?: string; options?: { value: string; label: string }[]; default?: string; advanced?: boolean; multiline?: boolean }
interface Provider { id: string; label: string; kind: string; help: string; fields: Field[] }
interface EmailView {
  providers: Provider[]; enabled: boolean; provider: string; from: string; values: Record<string, string>; saved: Record<string, boolean>;
  lastTest: { at: string; ok: boolean; error?: string; to: string; by: string } | null;
}

const inputCls = 'w-full h-9 px-3 border border-[#D4D4CF] rounded text-[13px] bg-white text-[#171717] placeholder-[#A3A3A3] focus:outline-none focus:border-[#171717] focus:ring-1 focus:ring-[#171717]';
const card = 'bg-white border border-[#E5E5E0] rounded-lg shadow-xs';
const btn = 'px-4 py-2 rounded bg-[#171717] hover:bg-[#333] disabled:opacity-50 text-white text-[13px] font-semibold';
const btn2 = 'px-4 py-2 rounded border border-[#E5E5E0] bg-white hover:bg-[#FAFAF8] disabled:opacity-50 text-[13px] font-semibold text-[#171717]';

type Msg = { ok: boolean; text: string } | null;
const Note: React.FC<{ m: Msg }> = ({ m }) => (m ? <p role="status" className={`text-[12px] mt-2 ${m.ok ? 'text-[#2A7553]' : 'text-[#BC3F3F]'}`}>{m.text}</p> : null);

// ---------------------------------------------------------------- email

const EmailTab: React.FC<{ api: Api }> = ({ api }) => {
  const [view, setView] = useState<EmailView | null>(null);
  const [provider, setProvider] = useState('SMTP');
  const [enabled, setEnabled] = useState(false);
  const [from, setFrom] = useState('');
  const [values, setValues] = useState<Record<string, string>>({});
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [msg, setMsg] = useState<Msg>(null);
  const [to, setTo] = useState('');
  const [testMsg, setTestMsg] = useState<Msg>(null);
  const [busy, setBusy] = useState('');

  const load = () => api<EmailView>('/settings/email').then((v) => {
    setView(v); setProvider(v.provider); setEnabled(v.enabled); setFrom(v.from); setValues(v.values || {});
  }).catch((e) => setMsg({ ok: false, text: e.message }));
  useEffect(() => { load(); }, []);

  const info = view?.providers.find((p) => p.id === provider);
  const savedForThis = view && view.provider === provider ? view.saved : {};
  const visible = (info?.fields || []).filter((f) => showAdvanced || !f.advanced);
  const hasAdvanced = (info?.fields || []).some((f) => f.advanced);

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy('save'); setMsg(null);
    try {
      await api('/settings/email', { method: 'PUT', body: JSON.stringify({ enabled, provider, from, values }) });
      setMsg({ ok: true, text: 'Mail settings saved.' });
      await load();
    } catch (err: any) { setMsg({ ok: false, text: err.message }); } finally { setBusy(''); }
  };
  const sendTest = async () => {
    setBusy('test'); setTestMsg(null);
    try {
      const r = await api<{ ok: boolean; error?: string }>('/settings/email/test', { method: 'POST', body: JSON.stringify({ to }) });
      setTestMsg(r.ok ? { ok: true, text: `Test email sent to ${to}. Check the inbox.` } : { ok: false, text: r.error || 'The test email could not be sent.' });
      await load();
    } catch (err: any) { setTestMsg({ ok: false, text: err.message }); } finally { setBusy(''); }
  };

  if (!view) return <p className="text-[13px] text-[#737373]">{msg ? msg.text : 'Loading...'}</p>;

  return (
    <div className="space-y-5 max-w-3xl">
      <form onSubmit={save} className={card}>
        <div className="px-5 py-3.5 border-b border-[#E5E5E0]">
          <h2 className="text-[14px] font-semibold text-[#171717]">Mail server</h2>
          <p className="text-[12px] text-[#737373] mt-0.5">Used for invitations to new administrators, password resets, licence reminders and security notices. Passwords are stored encrypted.</p>
        </div>
        <div className="p-5 grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="md:col-span-2 flex items-center gap-2">
            <input id="em-enabled" type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
            <label htmlFor="em-enabled" className="text-[13px] text-[#171717]">Send email from the platform</label>
          </div>
          <div>
            <label htmlFor="em-provider" className="block text-[12px] font-semibold text-[#171717] mb-1">Mail provider</label>
            <select id="em-provider" className={inputCls} value={provider} onChange={(e) => { setProvider(e.target.value); setValues({}); }}>
              {view.providers.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
            </select>
          </div>
          <div>
            <label htmlFor="em-from" className="block text-[12px] font-semibold text-[#171717] mb-1">Send from <span className="text-[#BC3F3F]">*</span></label>
            <input id="em-from" className={inputCls} placeholder="Enterprise WFM <noreply@yourcompany.com>" value={from} onChange={(e) => setFrom(e.target.value)} />
          </div>
          {info && <p className="md:col-span-2 text-[12px] text-[#737373]">{info.help}</p>}
          {visible.map((f) => (
            <div key={f.key} className={f.multiline ? 'md:col-span-2' : ''}>
              <label htmlFor={`em-${f.key}`} className="block text-[12px] font-semibold text-[#171717] mb-1">{f.label}{f.required && <span className="text-[#BC3F3F]"> *</span>}</label>
              {f.options ? (
                <select id={`em-${f.key}`} className={inputCls} value={values[f.key] ?? f.default ?? ''} onChange={(e) => setValues({ ...values, [f.key]: e.target.value })}>
                  {f.options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                </select>
              ) : f.multiline ? (
                <textarea id={`em-${f.key}`} rows={4} className={`${inputCls} h-auto py-2`} value={values[f.key] ?? ''} onChange={(e) => setValues({ ...values, [f.key]: e.target.value })} />
              ) : (
                <input
                  id={`em-${f.key}`}
                  type={f.secret ? 'password' : 'text'}
                  autoComplete="off"
                  className={inputCls}
                  placeholder={f.secret && savedForThis[f.key] ? 'Saved. Leave empty to keep it.' : f.placeholder || f.default || ''}
                  value={values[f.key] ?? ''}
                  onChange={(e) => setValues({ ...values, [f.key]: e.target.value })}
                />
              )}
              {f.help && <p className="text-[11px] text-[#737373] mt-1">{f.help}</p>}
            </div>
          ))}
          {hasAdvanced && (
            <div className="md:col-span-2">
              <button type="button" onClick={() => setShowAdvanced((v) => !v)} className="text-[12px] font-semibold text-[#2A7553] hover:underline">{showAdvanced ? 'Hide advanced options' : 'Show advanced options'}</button>
            </div>
          )}
          <div className="md:col-span-2">
            <button disabled={busy === 'save'} className={btn}>{busy === 'save' ? 'Saving...' : 'Save mail settings'}</button>
            <Note m={msg} />
          </div>
        </div>
      </form>

      <section className={card}>
        <div className="px-5 py-3.5 border-b border-[#E5E5E0]">
          <h2 className="text-[14px] font-semibold text-[#171717]">Send a test email</h2>
          <p className="text-[12px] text-[#737373] mt-0.5">Uses the settings as saved above. Save first if you changed anything.</p>
        </div>
        <div className="p-5 space-y-3">
          <div className="flex gap-2 max-w-lg">
            <input aria-label="Send the test to" className={inputCls} type="email" placeholder="you@yourcompany.com" value={to} onChange={(e) => setTo(e.target.value)} />
            <button onClick={sendTest} disabled={busy === 'test' || !to} className={btn2}>{busy === 'test' ? 'Sending...' : 'Send test'}</button>
          </div>
          <Note m={testMsg} />
          {view.lastTest && (
            <p className="text-[12px] text-[#737373]">
              Last test: {new Date(view.lastTest.at).toLocaleString()} to {view.lastTest.to} by {view.lastTest.by}. {view.lastTest.ok ? 'It was sent.' : `It failed: ${view.lastTest.error || 'unknown reason'}`}
            </p>
          )}
        </div>
      </section>
    </div>
  );
};

// ---------------------------------------------------------------- security

const SecurityTab: React.FC<{ api: Api; mfaEnabled: boolean; goAccount: () => void }> = ({ api, mfaEnabled, goAccount }) => {
  const [requireMfa, setRequireMfa] = useState(false);
  const [hours, setHours] = useState(8);
  const [msg, setMsg] = useState<Msg>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { api<{ requireMfa: boolean; sessionHours: number }>('/settings/security').then((s) => { setRequireMfa(s.requireMfa); setHours(s.sessionHours); }).catch((e) => setMsg({ ok: false, text: e.message })); }, []);
  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true); setMsg(null);
    try { await api('/settings/security', { method: 'PUT', body: JSON.stringify({ requireMfa, sessionHours: hours }) }); setMsg({ ok: true, text: 'Security settings saved.' }); } catch (err: any) { setMsg({ ok: false, text: err.message }); } finally { setBusy(false); }
  };
  return (
    <form onSubmit={save} className={`${card} max-w-3xl`}>
      <div className="px-5 py-3.5 border-b border-[#E5E5E0]">
        <h2 className="text-[14px] font-semibold text-[#171717]">Super Admin sign-in</h2>
        <p className="text-[12px] text-[#737373] mt-0.5">Applies to everyone who signs in to this portal.</p>
      </div>
      <div className="p-5 space-y-4">
        <div>
          <div className="flex items-center gap-2">
            <input id="sec-mfa" type="checkbox" checked={requireMfa} onChange={(e) => setRequireMfa(e.target.checked)} />
            <label htmlFor="sec-mfa" className="text-[13px] font-semibold text-[#171717]">Require two-factor sign-in for every Super Admin</label>
          </div>
          <p className="text-[12px] text-[#737373] mt-1 ml-6">
            Anyone without it can only open their Account page until they set it up with an authenticator app.
            {!mfaEnabled && <> You have not set it up on your own account yet: <button type="button" onClick={goAccount} className="text-[#2A7553] font-semibold hover:underline">set it up now</button>, then come back to switch this on.</>}
          </p>
        </div>
        <div className="max-w-xs">
          <label htmlFor="sec-hours" className="block text-[12px] font-semibold text-[#171717] mb-1">Session length</label>
          <select id="sec-hours" className={inputCls} value={hours} onChange={(e) => setHours(Number(e.target.value))}>
            {[1, 4, 8, 12, 24].map((h) => <option key={h} value={h}>{h} hour{h !== 1 ? 's' : ''}</option>)}
          </select>
          <p className="text-[11px] text-[#737373] mt-1">How long a sign-in lasts. Applies to new sign-ins.</p>
        </div>
        <button disabled={busy} className={btn}>{busy ? 'Saving...' : 'Save security settings'}</button>
        <Note m={msg} />
      </div>
    </form>
  );
};

// ---------------------------------------------------------------- page

export const SettingsPage: React.FC<{ api: Api; mfaEnabled: boolean; goAccount: () => void }> = ({ api, mfaEnabled, goAccount }) => {
  const [tab, setTab] = useState<'EMAIL' | 'PLANS' | 'COUNTRIES' | 'SECURITY'>('EMAIL');
  const tabs: ['EMAIL' | 'PLANS' | 'COUNTRIES' | 'SECURITY', string][] = [['EMAIL', 'Email'], ['PLANS', 'Plans'], ['COUNTRIES', 'Country templates'], ['SECURITY', 'Sign-in security']];
  return (
    <div className="space-y-5">
      <div className="flex gap-1 border-b border-[#E5E5E0]" role="tablist">
        {tabs.map(([id, label]) => (
          <button
            key={id}
            role="tab"
            aria-selected={tab === id}
            onClick={() => setTab(id)}
            className={`px-4 py-2 text-[13px] -mb-px border-b-2 ${tab === id ? 'border-[#171717] text-[#171717] font-semibold' : 'border-transparent text-[#525252] hover:text-[#171717]'}`}
          >
            {label}
          </button>
        ))}
      </div>
      {tab === 'EMAIL' && <EmailTab api={api} />}
      {tab === 'PLANS' && <PlansTab api={api} />}
      {tab === 'COUNTRIES' && <TemplatesTab api={api} />}
      {tab === 'SECURITY' && <SecurityTab api={api} mfaEnabled={mfaEnabled} goAccount={goAccount} />}
    </div>
  );
};
