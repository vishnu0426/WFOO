/**
 * Administration › API & Webhooks. Let another system read from the platform with an API key, and be told when something happens with a signed webhook.
 * A key's secret and a webhook's signing secret are shown once, when they are made.
 */
import React, { useState } from 'react';
import { api } from '../../services/api';
import { useForecast } from '../../services/forecastStore';
import { useApi } from '../forecasting/hooks';
import { Banner, Btn, Busy, Card, Field, Input, Pill, Select } from '../forecasting/ui';
import { addScopes, claimChoices, customScopes, removeScope, toggleScope } from './ssoLogic';

type Key = { id: string; name: string; prefix: string; scopes: string[]; status: 'ACTIVE' | 'REVOKED'; rateLimit: number; expiresAt: string | null; lastUsedAt: string | null; createdBy: string | null; createdAt: string };
type Hook = { id: string; name: string; url: string; events: string[]; active: boolean; consecutiveFailures: number; disabledReason: string | null; pending: number; failedLastWeek: number; lastDeliveredAt: string | null };
type Delivery = { id: string; event: string; status: 'PENDING' | 'DELIVERED' | 'FAILED'; attempts: number; responseStatus: number | null; error: string | null; createdAt: string; deliveredAt: string | null; nextAttemptAt: string | null };
type Catalog = { id: string; label: string }[];
const when = (d: string | null) => (d ? new Date(d).toLocaleString('en', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : 'never');

const Secret: React.FC<{ title: string; value: string; onDone: () => void }> = ({ title, value, onDone }) => {
  const [copied, setCopied] = useState(false);
  return (
    <Banner kind="warn">
      <div className="font-semibold">{title}</div>
      <div className="mt-1 flex flex-wrap items-center gap-2">
        <code className="text-[12px] bg-white border border-[#E5E5E0] rounded px-2 py-1 break-all select-all">{value}</code>
        <Btn onClick={async () => { await navigator.clipboard?.writeText(value).catch(() => {}); setCopied(true); }}>{copied ? 'Copied' : 'Copy'}</Btn>
        <Btn onClick={onDone}>I have saved it</Btn>
      </div>
      <div className="text-[11px] mt-1">It is not shown again. If it is lost, make a new one.</div>
    </Banner>
  );
};

type Preset = { id: string; label: string; button: string; fields: { key: string; label: string; hint?: string; placeholder?: string; optional?: boolean }[]; defaults: { scopes: string; usernameClaim: string; groupClaim: string }; steps: string[]; limits: string[]; scopeOptions: { id: string; hint: string; locked: boolean }[]; claimHints: { username: string[]; group: string[] } };
type Sso = { portalUrl: string | null; preset: string; presetValues: Record<string, string>; tested: { at: string; login: string | null; ok: boolean } | null; configured: boolean; name: string; issuer: string; clientId: string; hasSecret: boolean; scopes: string; usernameClaim: string; groupClaim: string; groupRoles: Record<string, string>; defaultRole: string; jit: boolean; syncRole: boolean; passwordLogin: boolean; enabled: boolean; redirectUri: string };
type TryResult = { status: 'waiting' | 'done' | 'error' | 'expired'; error?: string; claims?: { name: string; value: string; list: boolean }[]; login?: string; usernameClaim?: string; groupClaim?: string; groups?: string[]; mappedRole?: string | null; outcome?: { ok: boolean; text: string }; employee?: { ok: boolean; text: string }; hints?: string[]; tried?: boolean };
const ROLE_NAMES: [string, string][] = [['AGENT', 'Agent'], ['ANALYST', 'Analyst'], ['SUPERVISOR_RTA', 'Supervisor'], ['SCHEDULER', 'Scheduler'], ['FORECAST_PLANNER', 'Planner'], ['WFM_MANAGER', 'Manager'], ['WFM_ADMIN', 'Admin']];

/** Tick the scopes to ask the provider for. `openid` is always on; anything else the provider knows can be added as another scope. */
const ScopePicker: React.FC<{ value: string; options: { id: string; hint: string; locked: boolean }[]; disabled: boolean; onChange: (v: string) => void }> = ({ value, options, disabled, onChange }) => {
  const [extra, setExtra] = useState('');
  const have = value.split(/[\s,]+/).filter(Boolean);
  const add = () => { if (extra.trim()) onChange(addScopes(value, extra)); setExtra(''); };
  return (
    <div className="space-y-1">
      {options.map((o) => (
        <label key={o.id} className="flex items-baseline gap-2 text-[12px]">
          <input type="checkbox" disabled={disabled || o.locked} checked={o.locked || have.includes(o.id)} onChange={() => onChange(toggleScope(value, o.id))} />
          <span className="font-mono">{o.id}</span><span className="text-[#6B6B6B]">{o.hint}</span>
        </label>
      ))}
      {customScopes(value, options.map((o) => o.id)).map((c) => <span key={c} className="inline-flex items-center gap-1 mr-1 border border-[#E5E5E0] rounded px-2 py-0.5 text-[12px] font-mono">{c}{!disabled && <button aria-label={`Remove ${c}`} onClick={() => onChange(removeScope(value, c))}>×</button>}</span>)}
      {!disabled && <div className="flex gap-2 max-w-sm pt-1"><Input value={extra} onChange={(e) => setExtra(e.target.value)} placeholder="Another scope, if your provider needs one" onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); add(); } }} /><Btn disabled={!extra.trim()} onClick={add}>Add</Btn></div>}
    </div>
  );
};

/** Choose one of the details the provider sends (with an example value once a sign-in has been tried), or type another name. */
const ClaimSelect: React.FC<{ value: string; options: { name: string; note?: string }[]; disabled: boolean; onChange: (v: string) => void }> = ({ value, options, disabled, onChange }) => {
  const known = options.some((o) => o.name === value);
  const [other, setOther] = useState(!known && !!value);
  const isOther = other || (!known && !!value);
  return (
    <div className="space-y-1">
      <Select disabled={disabled} value={isOther ? '__other' : value} onChange={(e) => { if (e.target.value === '__other') setOther(true); else { setOther(false); onChange(e.target.value); } }}>
        {options.map((o) => <option key={o.name} value={o.name}>{o.name}{o.note ? ` — ${o.note}` : ''}</option>)}
        <option value="__other">Other…</option>
      </Select>
      {isOther && <Input disabled={disabled} value={value} onChange={(e) => onChange(e.target.value)} placeholder="The name, exactly as the provider sends it" />}
    </div>
  );
};

/** Sign in through the company's identity provider (Microsoft Entra ID, Okta, Google, Keycloak...). */
const SsoCard: React.FC<{ canWrite: boolean }> = ({ canWrite }) => {
  const res = useApi<Sso>('/sso/config');
  const cat = useApi<Preset[]>('/sso/providers');
  const [d, setD] = useState<Sso | null>(null);
  const [secret, setSecret] = useState('');
  const [rows, setRows] = useState<{ group: string; role: string }[]>([]);
  const [advanced, setAdvanced] = useState(false);
  const [paste, setPaste] = useState('');
  const [copied, setCopied] = useState(false);
  const [prev, setPrev] = useState<{ ok: boolean; issuer?: string; error?: string; adminLink?: string | null } | null>(null);
  const [trying, setTrying] = useState(false);
  const [result, setResult] = useState<TryResult | null>(null);
  const [seen, setSeen] = useState<{ name: string; value: string; list: boolean }[]>([]);
  const [testedKey, setTestedKey] = useState('');
  const [savedKey, setSavedKey] = useState('');
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const alive = React.useRef(true);
  React.useEffect(() => () => { alive.current = false; }, []);

  const keyOf = (x: Sso, sec: string) => JSON.stringify([x.preset, x.presetValues, x.clientId, sec, x.scopes]);
  const load = (x: Sso) => {
    const v = x.preset === 'generic' && !x.presetValues.issuer ? { ...x, presetValues: { issuer: x.issuer } } : x;
    setD(v); setSavedKey(keyOf(v, '')); setRows(Object.entries(x.groupRoles).map(([group, role]) => ({ group, role })));
  };
  React.useEffect(() => { if (res.data) load(res.data); }, [res.data]);

  // the address that will be used, and a link to the provider's admin screen, as the boxes are filled in
  const valuesKey = d ? JSON.stringify([d.preset, d.presetValues]) : '';
  React.useEffect(() => {
    if (!d) return;
    const h = setTimeout(() => { api<{ ok: boolean; issuer?: string; error?: string; adminLink?: string | null }>('/sso/preview', { method: 'POST', body: { preset: d.preset, presetValues: d.presetValues } }).then((r) => alive.current && setPrev(r)).catch(() => {}); }, 350);
    return () => clearTimeout(h);
  }, [valuesKey]);

  if (!d || !cat.data) return res.error || cat.error ? <Banner kind="err">{res.error || cat.error}</Banner> : <Busy text="Loading…" />;
  const pr = cat.data.find((x) => x.id === d.preset) ?? cat.data[cat.data.length - 1];
  const formKey = keyOf(d, secret);
  const changed = (p: Partial<Sso>) => { setD({ ...d, ...p }); setMsg(null); };
  const set = <K extends keyof Sso>(k: K, v: Sso[K]) => changed({ [k]: v } as Partial<Sso>);
  const pick = (id: string) => {
    const n = cat.data!.find((x) => x.id === id)!;
    // a different provider starts with empty boxes and its own defaults, so nothing typed for one is sent to another
    changed({ preset: id, presetValues: {}, name: n.button, ...n.defaults, hasSecret: id === d.preset ? d.hasSecret : false }); setSecret(''); setResult(null); setSeen([]);
  };
  const setVal = (k: string, v: string) => changed({ presetValues: { ...d.presetValues, [k]: v } });
  const missing = pr.fields.some((f) => !f.optional && !(d.presetValues[f.key] ?? '').trim());
  const groupRoles = Object.fromEntries(rows.filter((r) => r.group.trim()).map((r) => [r.group.trim(), r.role]));
  const tried = testedKey === formKey || (!!d.tested?.ok && formKey === savedKey);       // this exact setup has had a real sign-in
  const body = () => ({ ...d, issuer: undefined, clientSecret: secret || undefined, groupRoles });

  const detect = async () => {
    try {
      const r = await api<{ ok: boolean; error?: string; preset: string; values: Record<string, string>; label?: string }>('/sso/detect', { method: 'POST', body: { text: paste } });
      if (!r.ok) return setMsg({ kind: 'err', text: r.error ?? 'Could not tell which provider that is.' });
      const n = cat.data!.find((x) => x.id === r.preset)!;
      setD({ ...d, preset: r.preset, presetValues: r.values, name: n.button, ...n.defaults, hasSecret: r.preset === d.preset ? d.hasSecret : false }); setSecret(''); setResult(null); setSeen([]); setPaste('');
      setMsg({ kind: 'ok', text: `Recognised ${n.label}. Its boxes are filled in; add the Client ID and secret next.` });
    } catch (e: any) { setMsg({ kind: 'err', text: e.message }); }
  };

  const save = async () => {
    try {
      const out = await api<Sso>('/sso/config', { method: 'PUT', body: body() });
      load(out); setSecret(''); setTestedKey('');
      setMsg({ kind: 'ok', text: out.enabled ? 'Saved. Single sign-on is on.' : 'Saved. Single sign-on is off.' });
    } catch (e: any) { setMsg({ kind: 'err', text: e.message }); }
  };
  const test = async () => { try { const r = await api<{ ok: boolean; error?: string; warning?: string | null }>('/sso/test', { method: 'POST', body: { preset: d.preset, presetValues: d.presetValues } }); setMsg(!r.ok ? { kind: 'err', text: r.error ?? 'It did not answer.' } : r.warning ? { kind: 'err', text: r.warning } : { kind: 'ok', text: 'The provider answered and published its keys.' }); } catch (e: any) { setMsg({ kind: 'err', text: e.message }); } };

  // a real sign-in in a small window; nobody is signed in, and the result is shown here
  const tryIn = async () => {
    setMsg(null); setResult(null); setTrying(true);
    const win = window.open('', 'wfm-sso-test', 'width=520,height=720');      // opened first, inside the click, or the browser blocks it
    if (!win) { setTrying(false); return setMsg({ kind: 'err', text: 'The browser blocked the sign-in window. Allow pop-ups for this site and try again.' }); }
    try {
      const started = await api<{ id: string; url: string }>('/sso/try', { method: 'POST', body: { ...body(), groupRoles } });
      win.location.href = started.url;
      const key = formKey, began = Date.now();
      let closedAt = 0;
      for (;;) {
        await new Promise((ok) => setTimeout(ok, 1500));
        if (!alive.current) return;
        const r = await api<TryResult>(`/sso/try/${started.id}`);
        if (r.status !== 'waiting') {
          setResult(r);
          if (r.status === 'done' && r.claims) setSeen(r.claims);
          if (r.status === 'done' && r.tried) setTestedKey(key);
          if (r.status === 'expired') setMsg({ kind: 'err', text: 'The test expired. Press Try sign-in again.' });
          break;
        }
        if (win.closed) { closedAt = closedAt || Date.now(); if (Date.now() - closedAt > 6000) { setMsg({ kind: 'err', text: 'The sign-in window was closed before it finished.' }); break; } }
        if (Date.now() - began > 10 * 60_000) { setMsg({ kind: 'err', text: 'The test took too long. Press Try sign-in again.' }); break; }
      }
    } catch (e: any) { win.close(); setMsg({ kind: 'err', text: e.message }); } finally { if (alive.current) setTrying(false); }
  };
  const addGroup = (g: string) => setRows((x) => (x.some((r) => r.group === g) ? x : [...x, { group: g, role: 'AGENT' }]));
  const copy = async () => { await navigator.clipboard?.writeText(d.redirectUri).catch(() => {}); setCopied(true); setTimeout(() => alive.current && setCopied(false), 2000); };
  const link = prev?.adminLink;
  const usernameOptions = claimChoices('username', seen, pr.claimHints.username, d.usernameClaim);
  const groupOptions = claimChoices('group', seen, pr.claimHints.group, d.groupClaim);

  return (
    <Card title="Single sign-on" sub="Let people sign in with your company's identity provider instead of a password here. Works with Microsoft Entra ID, Okta, Google Workspace, Keycloak, Auth0 and any other OpenID Connect provider.">
      {msg && <Banner kind={msg.kind} onClose={() => setMsg(null)}>{msg.text}</Banner>}
      <p className="text-[12px] text-[#525252]">In your provider, register this platform as a web application with the redirect address <code className="bg-[#FAFAF8] border border-[#E5E5E0] rounded px-1.5 py-0.5 select-all">{d.redirectUri}</code> <button className="underline" onClick={copy}>{copied ? 'Copied' : 'Copy'}</button>{link && <> · <a className="underline" href={link} target="_blank" rel="noreferrer">Open {pr.label.replace(/ \(.*\)/, '')} admin ↗</a></>}, then fill in what it gives you. It must match exactly; in production set PUBLIC_URL on the server to your real https address.</p>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 max-w-4xl">
        <Field label="Identity provider"><Select disabled={!canWrite} value={d.preset} onChange={(e) => pick(e.target.value)}>{cat.data.map((x) => <option key={x.id} value={x.id}>{x.label}</option>)}</Select></Field>
        <Field label="Or paste your provider's address" hint="Picks the provider and fills its boxes, e.g. company.okta.com">
          <div className="flex gap-2"><Input disabled={!canWrite} value={paste} onChange={(e) => setPaste(e.target.value)} placeholder="https://" /><Btn disabled={!canWrite || !paste.trim()} onClick={detect}>Detect</Btn></div>
        </Field>
        {pr.fields.map((f) => <Field key={`${pr.id}-${f.key}`} label={f.label} hint={f.hint}><Input disabled={!canWrite} value={d.presetValues[f.key] ?? ''} onChange={(e) => setVal(f.key, e.target.value)} placeholder={f.placeholder} /></Field>)}
        <Field label="Button text" hint="Shown on the sign-in page"><Input disabled={!canWrite} value={d.name} onChange={(e) => set('name', e.target.value)} /></Field>
        <Field label="Client ID"><Input disabled={!canWrite} value={d.clientId} onChange={(e) => set('clientId', e.target.value)} /></Field>
        <Field label="Client secret" hint={d.hasSecret ? 'One is saved. Leave empty to keep it' : 'Required by most providers'}><Input type="password" disabled={!canWrite} value={secret} onChange={(e) => setSecret(e.target.value)} placeholder={d.hasSecret ? '••••••••' : ''} /></Field>
      </div>
      {prev && <p className={`text-[12px] max-w-4xl ${prev.ok ? 'text-[#6B6B6B]' : 'text-[#8a5a00]'}`}>{prev.ok ? <>Provider address used: <code className="select-all">{prev.issuer}</code></> : prev.error}</p>}
      <details className="text-[12px] text-[#525252] max-w-4xl">
        <summary className="cursor-pointer font-medium">Setup steps and limits for {pr.label}</summary>
        <ol className="list-decimal ml-5 mt-1 space-y-0.5">{pr.steps.map((t, i) => <li key={i}>{t.split('{redirect}').flatMap((part, j, arr) => j < arr.length - 1 ? [part, <code key={j} className="bg-[#FAFAF8] border border-[#E5E5E0] rounded px-1.5 py-0.5 select-all">{d.redirectUri}</code>] : [part])}</li>)}</ol>
        {pr.limits.length > 0 && <ul className="list-disc ml-5 mt-1 text-[#8a5a00]">{pr.limits.map((t, i) => <li key={i}>{t}</li>)}</ul>}
      </details>

      {canWrite && (
        <div className="max-w-4xl space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <Btn disabled={missing || !d.clientId || trying} onClick={tryIn}>{trying ? 'Waiting for the sign-in window…' : 'Try sign-in'}</Btn>
            <Btn disabled={missing} onClick={test}>Test the connection</Btn>
            {tried ? <Pill tone="good">Tried: it works{d.tested?.login && formKey === savedKey ? ` (as ${d.tested.login})` : ''}</Pill> : <Pill tone="warn">Not tried yet</Pill>}
            <span className="text-[11px] text-[#6B6B6B]">Try sign-in opens your provider in a small window and shows what it sends back. Nobody is signed in.</span>
          </div>
          {result?.status === 'error' && <Banner kind="err">{result.error}</Banner>}
          {result?.status === 'done' && (
            <div className="rounded border border-[#E5E5E0] p-3 space-y-2 text-[12px]">
              <Banner kind={result.outcome?.ok ? 'ok' : 'warn'}>{result.outcome?.text}</Banner>
              {result.employee && <div className={result.employee.ok ? 'text-[#2f7d4f]' : 'text-[#8a5a00]'}>{result.employee.ok ? '✓' : '•'} {result.employee.text}</div>}
              {result.hints?.map((h, i) => <div key={i} className="text-[#8a5a00]">• {h}</div>)}
              <div className="flex flex-wrap items-center gap-1"><span className="font-medium mr-1">Groups found{result.groups?.length ? ' (click to add a role)' : ': none'}:</span>{result.groups?.slice(0, 25).map((g) => (
                <button key={g} disabled={rows.some((r) => r.group === g)} onClick={() => addGroup(g)} className="border border-[#E5E5E0] rounded px-2 py-0.5 disabled:opacity-50 break-all">{rows.some((r) => r.group === g) ? '✓ ' : '+ '}{g}</button>
              ))}{(result.groups?.length ?? 0) > 25 && <span className="text-[#6B6B6B]">…and {(result.groups?.length ?? 0) - 25} more</span>}</div>
              <details>
                <summary className="cursor-pointer font-medium">Everything the provider sent ({result.claims?.length})</summary>
                <table className="mt-1 w-full"><tbody>{result.claims?.map((c) => (
                  <tr key={c.name} className="border-t border-[#EFEFEA] align-top"><td className="py-0.5 pr-3 font-mono whitespace-nowrap">{c.name}</td><td className="py-0.5 break-all">{c.value}{c.name === result.usernameClaim && <span className="ml-1 text-[#2f7d4f]">← who they are</span>}{c.name === result.groupClaim && <span className="ml-1 text-[#2f7d4f]">← their groups</span>}</td></tr>
                ))}</tbody></table>
              </details>
            </div>
          )}
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 max-w-4xl">
        <Field label="Roles from groups" hint="The first group in the list that matches a person decides their role. Groups found by Try sign-in can be added with one click.">
          <div className="space-y-1">
            {rows.map((r, i) => (
              <div key={i} className="flex gap-1">
                <Input disabled={!canWrite} value={r.group} placeholder="Group in the provider" onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, group: e.target.value } : x)))} />
                <Select disabled={!canWrite} value={r.role} onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, role: e.target.value } : x)))}>{ROLE_NAMES.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</Select>
                {canWrite && <Btn onClick={() => setRows(rows.filter((_, j) => j !== i))}>×</Btn>}
              </div>
            ))}
            {canWrite && <Btn onClick={() => setRows([...rows, { group: '', role: 'AGENT' }])}>+ Add a group</Btn>}
          </div>
        </Field>
        <div className="space-y-3">
          <Field label="Role when no group matches"><Select disabled={!canWrite} value={d.defaultRole} onChange={(e) => set('defaultRole', e.target.value)}>{ROLE_NAMES.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</Select></Field>
          <label className="flex items-start gap-2 text-[12px]"><input type="checkbox" disabled={!canWrite} checked={d.jit} onChange={(e) => set('jit', e.target.checked)} /><span><b>Create people when they first sign in.</b> Off: only people already added here can sign in.</span></label>
          <label className="flex items-start gap-2 text-[12px]"><input type="checkbox" disabled={!canWrite} checked={d.syncRole} onChange={(e) => set('syncRole', e.target.checked)} /><span><b>Keep roles in step with the provider's groups</b> at every sign-in.</span></label>
          <label className="flex items-start gap-2 text-[12px]"><input type="checkbox" disabled={!canWrite} checked={d.passwordLogin} onChange={(e) => { if (!e.target.checked && !tried && d.passwordLogin) return setMsg({ kind: 'err', text: 'Use Try sign-in first, then switch passwords off.' }); set('passwordLogin', e.target.checked); }} /><span><b>Still allow passwords.</b> Off: everyone except the administrator must use single sign-on, so a lost password no longer matters. The mobile app does not support single sign-on yet: switching passwords off blocks it.</span></label>
          <label className="flex items-start gap-2 text-[12px]"><input type="checkbox" disabled={!canWrite || (!tried && !d.enabled)} checked={d.enabled} onChange={(e) => set('enabled', e.target.checked)} /><span><b>Single sign-on is on.</b> {tried || d.enabled ? 'We check the provider answers before turning it on.' : 'Use Try sign-in first: it can only be switched on for a setup that has worked once.'}</span></label>
        </div>
      </div>

      <details className="max-w-4xl text-[12px]" open={advanced} onToggle={(e) => setAdvanced((e.target as HTMLDetailsElement).open)}>
        <summary className="cursor-pointer font-medium text-[#525252]">Advanced: which details to read from the provider</summary>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mt-2">
          <Field label="Who they are, in the provider" hint={seen.length ? 'Details your provider sent in the last Try sign-in, with an example' : 'The detail that matches a person here: usually email. Try sign-in lists what your provider really sends'}><ClaimSelect key={`u-${d.preset}-${seen.length}`} disabled={!canWrite} value={d.usernameClaim} options={usernameOptions} onChange={(v) => set('usernameClaim', v)} /></Field>
          <Field label="Where their groups are" hint={seen.length ? 'Details that hold a list, from the last Try sign-in' : 'The detail that lists a person\'s groups, usually groups'}><ClaimSelect key={`g-${d.preset}-${seen.length}`} disabled={!canWrite} value={d.groupClaim} options={groupOptions} onChange={(v) => set('groupClaim', v)} /></Field>
          <div className="md:col-span-2"><Field label="What to ask the provider for (scopes)" hint="Tick what your provider should send. Normally leave as it is; a change needs a new Try sign-in"><ScopePicker disabled={!canWrite} value={d.scopes} options={pr.scopeOptions} onChange={(v) => set('scopes', v)} /></Field></div>
        </div>
      </details>
      <p className="text-[12px] text-[#6B6B6B] max-w-4xl">{d.portalUrl ? <>Employees get the same button on the employee portal at <code className="select-all">{d.portalUrl}</code>; they land there after signing in, and are linked to their employee record by email.</> : <>The employee portal has no single sign-on button yet: set PORTAL_URL on the server to its address (for example http://localhost:3001).</>}</p>
      {canWrite && <div className="flex gap-2"><Btn variant="primary" disabled={missing || !d.clientId} onClick={save}>Save</Btn></div>}
    </Card>
  );
};

/** A token the identity provider uses to create and switch off accounts automatically (SCIM 2.0). */
const ScimCard: React.FC<{ canWrite: boolean; onSecret: (title: string, value: string) => void }> = ({ canWrite, onSecret }) => {
  const [err, setErr] = useState('');
  const make = async () => { setErr(''); try { const r = await api<{ key: string }>('/developer/scim-token', { method: 'POST', body: {} }); onSecret('SCIM token', r.key); } catch (e: any) { setErr(e.message); } };
  return (
    <Card title="Automatic user provisioning (SCIM)" sub="Your identity provider can create, update and switch off accounts here by itself, so leavers lose access the moment they are removed there. Give it the address below and a token.">
      {err && <Banner kind="err" onClose={() => setErr('')}>{err}</Banner>}
      <p className="text-[12px]">SCIM address: <code className="bg-[#FAFAF8] border border-[#E5E5E0] rounded px-1.5 py-0.5 select-all">{location.origin}/scim/v2</code> · each person is matched on their sign-in name; a <code>roles</code> value picks their role and the enterprise <code>employeeNumber</code> links them to their employee record. Removing someone switches the account off; it is never erased.</p>
      {canWrite && <div><Btn onClick={make}>Make a SCIM token</Btn> <span className="text-[11px] text-[#6B6B6B]">Tokens appear in the key list above and can be revoked there.</span></div>}
    </Card>
  );
};

type SecretsStatus = { key: { source: 'SECRETS_KEY' | 'DERIVED_FROM_JWT_SECRET'; fingerprint: string; previousKeys: number }; groups: Record<string, { total: number; current: number; oldKey: number; plain: number; unreadable: number }>; total: number; current: number; oldKey: number; plain: number; unreadable: number; allProtected: boolean };

/** Proof that the secrets saved in this system are encrypted, and the key they are encrypted with. Never shows a secret. */
const SecretsCard: React.FC<{ canWrite: boolean }> = ({ canWrite }) => {
  const [tick, setTick] = useState(0);
  const st = useApi<SecretsStatus>('/security/secrets', [tick]);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const d = st.data;
  if (!d) return st.error ? <Banner kind="err">{st.error}</Banner> : <Busy text="Checking stored secrets…" />;
  const redo = async () => { setBusy(true); setMsg(null); try { await api('/security/secrets/reencrypt', { method: 'POST', body: {} }); setTick((n) => n + 1); setMsg({ kind: 'ok', text: 'Done. Every readable secret is now encrypted under the current key.' }); } catch (e: any) { setMsg({ kind: 'err', text: e.message }); } finally { setBusy(false); } };
  return (
    <Card title="Stored secrets" sub="Passwords, API keys and signing secrets saved in this system (mail and SMS credentials, webhook secrets, the sign-in client secret, connector credentials) are encrypted in the database with AES-256. They are decrypted only at the moment they are used, and are never shown again after saving.">
      {msg && <Banner kind={msg.kind} onClose={() => setMsg(null)}>{msg.text}</Banner>}
      <div className="flex flex-wrap items-center gap-3 text-[13px]">
        {d.allProtected ? <Pill tone="good">{d.total === 0 ? 'No secrets saved yet' : `All ${d.total} saved secret${d.total === 1 ? '' : 's'} encrypted`}</Pill> : <Pill tone="warn">{d.plain} not encrypted · {d.oldKey} under an old key · {d.unreadable} unreadable</Pill>}
        <span className="text-[#6B6B6B]">Key in use: <span className="font-mono">{d.key.fingerprint}</span> ({d.key.source === 'SECRETS_KEY' ? 'set by SECRETS_KEY' : 'derived from JWT_SECRET'})</span>
        {canWrite && !d.allProtected && <Btn disabled={busy} onClick={redo}>Encrypt now</Btn>}
      </div>
      {d.key.source === 'DERIVED_FROM_JWT_SECRET' && <Banner kind="warn">No SECRETS_KEY is set, so the encryption key is derived from JWT_SECRET. That works, but if JWT_SECRET is ever changed the saved secrets can no longer be read and would have to be entered again. Set SECRETS_KEY in the server settings (<code>openssl rand -hex 32</code>) and restart.</Banner>}
      {d.unreadable > 0 && <Banner kind="err">{d.unreadable} saved secret{d.unreadable === 1 ? ' cannot' : 's cannot'} be read with the current key. Put the previous key in SECRETS_KEY_PREVIOUS and restart, or enter {d.unreadable === 1 ? 'it' : 'them'} again.</Banner>}
      <details className="text-[12px]"><summary className="cursor-pointer text-[#525252]">Show by kind</summary>
        <table className="text-[12px]"><thead className="text-left text-[#6B6B6B]"><tr><th className="pr-8 py-1">Kind</th><th className="px-3">Saved</th><th className="px-3">Encrypted</th></tr></thead>
        <tbody>{Object.entries(d.groups).map(([k, g]) => <tr key={k} className="border-t border-[#E5E5E0]"><td className="py-1 pr-8">{k}</td><td className="px-3 tabular-nums">{g.total}</td><td className="px-3 tabular-nums">{g.current}</td></tr>)}</tbody></table>
      </details>
    </Card>
  );
};

export const ApiAccessView: React.FC = () => {
  const { can } = useForecast();
  const canWrite = can('users:write');
  const [tick, setTick] = useState(0);
  const keys = useApi<Key[]>('/developer/keys', [tick]);
  const hooks = useApi<Hook[]>('/developer/webhooks', [tick]);
  const scopes = useApi<{ id: string; label: string }[]>('/developer/scopes');
  const events = useApi<Catalog>('/developer/events');
  const [error, setError] = useState('');
  const [secret, setSecret] = useState<{ title: string; value: string } | null>(null);
  const [testing, setTesting] = useState<Record<string, string>>({});
  const [open, setOpen] = useState<string | null>(null);
  const deliveries = useApi<Delivery[]>(open ? `/developer/webhooks/${open}/deliveries` : null, [open, tick]);

  const [kf, setKf] = useState({ name: '', scopes: ['schedule:read'] as string[], expires: '' as string, rate: 600 });
  const [hf, setHf] = useState({ name: '', url: '', events: ['schedule.published'] as string[] });
  const toggle = (list: string[], v: string) => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);
  const fail = (e: any) => setError(e.message);

  const makeKey = async () => {
    setError('');
    try {
      const r = await api<{ key: string }>('/developer/keys', { method: 'POST', body: { name: kf.name, scopes: kf.scopes, rateLimit: kf.rate, expiresInDays: kf.expires ? Number(kf.expires) : null } });
      setSecret({ title: `API key “${kf.name}”`, value: r.key }); setKf({ name: '', scopes: ['schedule:read'], expires: '', rate: 600 }); setTick((n) => n + 1);
    } catch (e) { fail(e); }
  };
  const makeHook = async () => {
    setError('');
    try {
      const r = await api<{ secret: string }>('/developer/webhooks', { method: 'POST', body: { name: hf.name, url: hf.url, events: hf.events } });
      setSecret({ title: `Signing secret for “${hf.name}”`, value: r.secret }); setHf({ name: '', url: '', events: ['schedule.published'] }); setTick((n) => n + 1);
    } catch (e) { fail(e); }
  };
  const test = async (h: Hook) => {
    setTesting((t) => ({ ...t, [h.id]: 'Sending…' }));
    try { const r = await api<{ ok: boolean; status: number | null; ms: number; error: string | null }>(`/developer/webhooks/${h.id}/test`, { method: 'POST', body: {} }); setTesting((t) => ({ ...t, [h.id]: r.ok ? `The receiver answered ${r.status} in ${r.ms} ms.` : `Failed: ${r.error}` })); }
    catch (e: any) { setTesting((t) => ({ ...t, [h.id]: e.message })); }
  };
  const act = async (fn: () => Promise<unknown>) => { setError(''); try { await fn(); setTick((n) => n + 1); } catch (e) { fail(e); } };

  return (
    <div className="flex-1 flex flex-col h-[calc(100vh-3.5rem)] overflow-y-auto bg-white p-6 space-y-6">
      <div><h1 className="text-[22px] font-bold text-[#171717]">API & Single Sign-On</h1><p className="text-[13px] text-[#6B6B6B]">Sign people in through your company login, provision accounts automatically, let another system read your schedules and people, and tell it when something changes.</p></div>
      {error && <Banner kind="err" onClose={() => setError('')}>{error}</Banner>}
      {secret && <Secret {...secret} onDone={() => setSecret(null)} />}

      <SecretsCard canWrite={canWrite} />
      <SsoCard canWrite={canWrite} />
      <ScimCard canWrite={canWrite} onSecret={(title, value) => setSecret({ title, value })} />

      <Card title="API keys" sub="A key lets another system read data, never change it. Give it only the parts it needs. Send it as “Authorization: Bearer wfm_…” to the same addresses the app uses; the list of addresses is at /api/v1/developer/openapi.json.">
        {keys.loading && !keys.data ? <Busy text="Loading…" /> : (keys.data ?? []).length === 0 ? <p className="text-[12px] text-[#6B6B6B]">No keys yet.</p> : (
          <table className="w-full text-[12px]">
            <thead className="text-left text-[#6B6B6B]"><tr><th className="py-1">Name</th><th>Key</th><th>Can read</th><th>Last used</th><th>Expires</th><th /></tr></thead>
            <tbody>{keys.data!.map((k) => (
              <tr key={k.id} className="border-t border-[#E5E5E0]">
                <td className="py-1.5 font-semibold">{k.name}{k.status === 'REVOKED' && <span className="ml-2"><Pill tone="bad">Revoked</Pill></span>}</td>
                <td className="font-mono text-[#6B6B6B]">{k.prefix}</td><td>{k.scopes.map((s) => s.split(':')[0]).join(', ')}</td><td>{when(k.lastUsedAt)}</td><td>{k.expiresAt ? when(k.expiresAt) : 'Never'}</td>
                <td className="text-right">{canWrite && k.status === 'ACTIVE' && <button className="underline text-[#BC3F3F]" onClick={() => confirm(`Revoke “${k.name}”? Anything using it stops working immediately.`) && act(() => api(`/developer/keys/${k.id}`, { method: 'DELETE' }))}>Revoke</button>}</td>
              </tr>))}</tbody>
          </table>
        )}
        {canWrite && (
          <div className="border-t border-[#E5E5E0] pt-3 space-y-3">
            <div className="flex flex-wrap items-end gap-3">
              <Field label="Name"><Input value={kf.name} onChange={(e) => setKf({ ...kf, name: e.target.value })} placeholder="Payroll export" /></Field>
              <Field label="Expires after"><Select value={kf.expires} onChange={(e) => setKf({ ...kf, expires: e.target.value })} className="!w-auto"><option value="">Never</option><option value="30">30 days</option><option value="90">90 days</option><option value="365">1 year</option></Select></Field>
              <Field label="Requests a minute"><Input type="number" min={1} max={100000} className="!w-24" value={kf.rate} onChange={(e) => setKf({ ...kf, rate: Number(e.target.value) })} /></Field>
              <Btn variant="primary" disabled={kf.name.trim().length < 2 || kf.scopes.length === 0} onClick={makeKey}>Create key</Btn>
            </div>
            <div className="flex flex-wrap gap-x-5 gap-y-1 text-[12px]">{(scopes.data ?? []).map((s) => <label key={s.id} className="flex items-center gap-1.5"><input type="checkbox" checked={kf.scopes.includes(s.id)} onChange={() => setKf({ ...kf, scopes: toggle(kf.scopes, s.id) })} />{s.label}</label>)}</div>
          </div>
        )}
      </Card>

      <Card title="Webhooks" sub="When one of the events you pick happens, the platform sends a message to your address. Each message is signed so you can check it came from here; failed ones are tried again with longer and longer waits, and an address that keeps failing is switched off.">
        {hooks.loading && !hooks.data ? <Busy text="Loading…" /> : (hooks.data ?? []).length === 0 ? <p className="text-[12px] text-[#6B6B6B]">No webhooks yet.</p> : (
          <div className="space-y-3">{hooks.data!.map((h) => (
            <div key={h.id} className="border border-[#E5E5E0] rounded-lg p-3 space-y-2">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div><span className="font-semibold text-[13px]">{h.name}</span> {h.active ? <Pill tone="good">On</Pill> : <Pill tone="bad">Off</Pill>}{h.pending > 0 && <span className="ml-2"><Pill tone="warn">{h.pending} waiting</Pill></span>}{h.failedLastWeek > 0 && <span className="ml-2"><Pill tone="bad">{h.failedLastWeek} failed this week</Pill></span>}
                  <div className="font-mono text-[11px] text-[#6B6B6B] break-all">{h.url}</div></div>
                <div className="flex flex-wrap items-center gap-3 text-[12px]">
                  <button className="underline" onClick={() => test(h)}>Send a test</button>
                  <button className="underline" onClick={() => setOpen(open === h.id ? null : h.id)}>{open === h.id ? 'Hide history' : 'History'}</button>
                  {canWrite && <button className="underline" onClick={() => act(() => api(`/developer/webhooks/${h.id}`, { method: 'PUT', body: { name: h.name, url: h.url, events: h.events, active: !h.active } }))}>{h.active ? 'Switch off' : 'Switch on'}</button>}
                  {canWrite && <button className="underline" onClick={async () => { if (!confirm('Replace the signing secret? The old one stops working.')) return; try { const r = await api<{ secret: string }>(`/developer/webhooks/${h.id}/rotate-secret`, { method: 'POST', body: {} }); setSecret({ title: `New signing secret for “${h.name}”`, value: r.secret }); } catch (e) { fail(e); } }}>New secret</button>}
                  {canWrite && <button className="underline text-[#BC3F3F]" onClick={() => confirm(`Delete “${h.name}”?`) && act(() => api(`/developer/webhooks/${h.id}`, { method: 'DELETE' }))}>Delete</button>}
                </div>
              </div>
              <div className="text-[11px] text-[#6B6B6B]">Listens for: {h.events.includes('*') ? 'everything' : h.events.join(', ')} · last delivered {when(h.lastDeliveredAt)}</div>
              {h.disabledReason && <Banner kind="warn">{h.disabledReason}</Banner>}
              {testing[h.id] && <p className="text-[12px]">{testing[h.id]}</p>}
              {open === h.id && (
                <table className="w-full text-[11px]">
                  <thead className="text-left text-[#6B6B6B]"><tr><th>When</th><th>Event</th><th>Result</th><th>Tries</th><th /></tr></thead>
                  <tbody>{(deliveries.data ?? []).map((d) => (
                    <tr key={d.id} className="border-t border-[#E5E5E0]">
                      <td className="py-1">{when(d.createdAt)}</td><td>{d.event}</td>
                      <td>{d.status === 'DELIVERED' ? <Pill tone="good">Delivered {d.responseStatus ?? ''}</Pill> : d.status === 'PENDING' ? <Pill tone="warn">Will try again {when(d.nextAttemptAt)}{d.error ? ` · ${d.error}` : ''}</Pill> : <Pill tone="bad">Failed{d.error ? ` · ${d.error}` : ''}</Pill>}</td>
                      <td>{d.attempts}</td><td>{canWrite && d.status === 'FAILED' && <button className="underline" onClick={() => act(() => api(`/developer/deliveries/${d.id}/retry`, { method: 'POST', body: {} }))}>Try again</button>}</td>
                    </tr>))}</tbody>
                </table>
              )}
            </div>))}</div>
        )}
        {canWrite && (
          <div className="border-t border-[#E5E5E0] pt-3 space-y-3">
            <div className="flex flex-wrap items-end gap-3">
              <Field label="Name"><Input value={hf.name} onChange={(e) => setHf({ ...hf, name: e.target.value })} placeholder="Payroll system" /></Field>
              <Field label="Address to send to"><Input className="!w-96" value={hf.url} onChange={(e) => setHf({ ...hf, url: e.target.value })} placeholder="https://example.com/wfm-events" /></Field>
              <Btn variant="primary" disabled={hf.name.trim().length < 2 || !hf.url || hf.events.length === 0} onClick={makeHook}>Add webhook</Btn>
            </div>
            <div className="flex flex-wrap gap-x-5 gap-y-1 text-[12px]">{(events.data ?? []).filter((e) => e.id !== 'webhook.ping').map((e) => <label key={e.id} className="flex items-center gap-1.5"><input type="checkbox" checked={hf.events.includes(e.id)} onChange={() => setHf({ ...hf, events: toggle(hf.events, e.id) })} />{e.label}</label>)}</div>
          </div>
        )}
        <details className="text-[12px] text-[#525252]">
          <summary className="cursor-pointer font-semibold">How to check a message came from here</summary>
          <p className="mt-1">Each message has <code>X-WFM-Timestamp</code> and <code>X-WFM-Signature</code>. Compute <code>sha256=</code> followed by the hex HMAC-SHA256 of <code>timestamp + "." + body</code> using the signing secret, and compare. Ignore messages whose timestamp is more than five minutes old. Answer with any 2xx to say it arrived.</p>
        </details>
      </Card>
    </div>
  );
};
