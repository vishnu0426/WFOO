/**
 * Sign-in screen. The gateway issues a JWT; what each person can do follows their role's permissions.
 * The organisation comes from the link or address when it can (?org=ACME, /org/acme), else the one used last on this device, else the only one there is;
 * failing that they type the code, or find it from their work email.
 */
import React, { useEffect, useState } from 'react';
import { LogIn } from 'lucide-react';
import { api, ApiError, storeSession, Session } from '../../services/api';
import { orgFromAddress, type OrgSource } from '../../services/orgAddress';

const ORG_KEY = 'wfm_tenant';                                // the organisation signed in to last on this device
const FROM_SUBDOMAIN = (import.meta as any).env?.VITE_ORG_FROM_SUBDOMAIN === 'true';
type Org = { code: string; name: string };
type Known = Org & { source: OrgSource | 'only' | 'email' | 'typed' };
type Options = { singleOrganisation: Org | null; discovery: boolean };
const NOT_FOUND = "We couldn't find that organisation. Check the code on your welcome message, or ask your manager.";

export const LoginView: React.FC<{ onLogin: (session: Session) => void }> = ({ onLogin }) => {
  const [known, setKnown] = useState<Known | null>(null);
  const [resolving, setResolving] = useState(true);
  const [opts, setOpts] = useState<Options | null>(null);
  const [tenant, setTenant] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [finder, setFinder] = useState(false);
  const [email, setEmail] = useState('');
  const [choices, setChoices] = useState<Org[] | null>(null);
  const [codeError, setCodeError] = useState('');
  // single sign-on: offered when the organisation has switched it on; a failed attempt comes back with the reason
  const [sso, setSso] = useState<{ enabled: boolean; name: string | null; passwordLogin: boolean } | null>(null);
  useEffect(() => {
    const e = sessionStorage.getItem('wfm_sso_error');
    if (e) { setError(e); sessionStorage.removeItem('wfm_sso_error'); }
  }, []);

  useEffect(() => {
    let live = true;
    (async () => {
      // read the address before anything is waited for: by the time the answer arrives the app may have rewritten it
      const where = orgFromAddress(location, localStorage.getItem(ORG_KEY), { subdomain: FROM_SUBDOMAIN });
      const o = await api<Options>('/auth/login-options').catch(() => null);
      if (!live) return;
      setOpts(o);
      let found: Known | null = null;
      if (where) {
        try { const r = await api<Org>(`/auth/org/${encodeURIComponent(where.code)}`); found = { ...r, source: where.source }; }
        catch (e) {
          if (e instanceof ApiError && e.status === 404) {
            if (where.source === 'remembered') localStorage.removeItem(ORG_KEY);
            else if (where.source === 'link' || where.source === 'path') setError(`This sign-in link names an organisation we don't recognise ("${where.code}"). Enter the organisation code below.`);
          }
        }
      }
      if (!found && o?.singleOrganisation) found = { ...o.singleOrganisation, source: 'only' };
      if (!live) return;
      if (found && found.source !== 'only') localStorage.setItem(ORG_KEY, found.code);     // kept at once: a refresh must not forget it
      setKnown(found); setResolving(false);
    })();
    return () => { live = false; };
  }, []);

  const orgCode = known?.code ?? tenant.trim();
  useEffect(() => {
    if (resolving) return;
    const id = setTimeout(() => { api<{ enabled: boolean; name: string | null; passwordLogin: boolean }>(`/auth/sso/${encodeURIComponent(orgCode || '_')}/info`).then(setSso).catch(() => setSso(null)); }, 300);
    return () => clearTimeout(id);
  }, [orgCode, resolving]);

  const change = () => { localStorage.removeItem(ORG_KEY); setKnown(null); setTenant(''); setSso(null); setCodeError(''); setError(''); };
  const checkTyped = async () => {
    const c = tenant.trim();
    if (!c) { setCodeError(''); return; }
    try { const r = await api<Org>(`/auth/org/${encodeURIComponent(c)}`); setKnown({ ...r, source: 'typed' }); localStorage.setItem(ORG_KEY, r.code); setCodeError(''); }
    catch { setCodeError(NOT_FOUND); }
  };
  const pick = (o: Org) => { localStorage.setItem(ORG_KEY, o.code); setKnown({ ...o, source: 'email' }); setChoices(null); setFinder(false); if (!username) setUsername(email.trim()); };
  const find = async () => {
    setBusy(true); setError(''); setChoices(null);
    try {
      const r = await api<{ organisations: Org[] }>('/auth/discover', { method: 'POST', body: { identifier: email.trim() } });
      if (r.organisations.length === 1) pick(r.organisations[0]); else setChoices(r.organisations);
    } catch (e: any) { setError(e.message); } finally { setBusy(false); }
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const r = await api<{ token: string } & Session>('/auth/login', { method: 'POST', body: { username, password, tenant: orgCode || undefined } });
      const { token, ...session } = r;
      storeSession(token, session);
      localStorage.setItem(ORG_KEY, session.tenant.code);
      onLogin(session);
    } catch (err: any) {
      setError(err.message);
      if (err instanceof ApiError && (err.code === 'ORG_REQUIRED' || err.code === 'ORG_UNKNOWN')) { setKnown(null); setFinder(!!opts?.discovery); }
    } finally {
      setBusy(false);
    }
  };

  const field = 'w-full mt-1 p-2 border border-[#E5E5E0] rounded text-[13px] font-normal';
  return (
    <div className="min-h-screen bg-[#FAFAF8] flex items-center justify-center p-4">
      <form onSubmit={submit} className="w-full max-w-sm bg-white border border-[#E5E5E0] rounded-lg shadow-xs p-6 space-y-4">
        <div className="flex items-center gap-2.5">
          <div className="w-9 h-9 rounded bg-[#171717] flex items-center justify-center text-white font-bold text-sm tracking-wider">WFM</div>
          <div>
            <h1 className="text-[16px] font-semibold text-[#171717] leading-tight">AgnoWFM</h1>
            <p className="text-[12px] text-[#6B6B6B]">Sign in to continue</p>
          </div>
        </div>

        {resolving ? <div className="text-[12px] text-[#6B6B6B]">Loading…</div> : known ? (
          <div className="rounded border border-[#E5E5E0] bg-[#FAFAF8] px-3 py-2">
            <div className="text-[11px] text-[#6B6B6B]">Signing in to</div>
            <div className="flex items-center justify-between gap-2">
              <span className="font-semibold text-[14px] text-[#171717]">{known.name}</span>
              {known.source !== 'only' && <button type="button" onClick={change} className="text-[12px] text-[#6B6B6B] hover:text-[#171717] underline">Not your organisation?</button>}
            </div>
          </div>
        ) : !known && (
          <div className="space-y-2">
            <label className="block text-[12px] font-semibold text-[#171717]">
              Organisation code
              <input value={tenant} onChange={(e) => { setTenant(e.target.value); setCodeError(''); }} onBlur={checkTyped} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void checkTyped(); } }} className={field} autoCapitalize="none" />
              <span className="block text-[12px] font-normal text-[#6B6B6B] mt-0.5">It is on your welcome message, or in the link you were sent.</span>
            </label>
            {codeError && <div className="text-[12px] text-[#BC3F3F]">{codeError}</div>}
            {opts?.discovery ? <button type="button" onClick={() => setFinder((v) => !v)} className="text-[12px] text-[#6B6B6B] hover:text-[#171717] underline">{finder ? 'Hide' : "Don't know it? Find my organisation"}</button> : <div className="text-[12px] text-[#6B6B6B]">Don't have it? Ask your manager.</div>}
            {finder && (
              <div className="rounded border border-[#E5E5E0] bg-[#FAFAF8] p-3 space-y-2">
                <label className="block text-[12px] font-semibold text-[#171717]">Your work email or username
                  <input value={email} onChange={(e) => { setEmail(e.target.value); setChoices(null); }} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); if (email.trim().length >= 3) void find(); } }} className={field} autoCapitalize="none" />
                </label>
                <button type="button" disabled={busy || email.trim().length < 3} onClick={find} className="w-full px-3 py-1.5 rounded border border-[#E5E5E0] bg-white hover:bg-[#FAFAF8] text-[12px] font-semibold disabled:opacity-60">{busy ? 'Looking…' : 'Find my organisation'}</button>
                {choices && choices.length === 0 && <div className="text-[12px] text-[#525252]">We couldn't find an account for that. Check the spelling, or ask your manager for the organisation code.</div>}
                {choices && choices.length > 1 && (
                  <div className="space-y-1.5">
                    <div className="text-[12px] text-[#525252]">You have an account in more than one organisation. Which one?</div>
                    {choices.map((o) => <button key={o.code} type="button" onClick={() => pick(o)} className="w-full text-left rounded border border-[#E5E5E0] bg-white px-3 py-2 text-[13px] hover:bg-[#F5F5F0]">{o.name}</button>)}
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        <label className="block text-[12px] font-semibold text-[#171717]">
          Username
          <input value={username} onChange={(e) => setUsername(e.target.value)} autoFocus={!!known} autoComplete="username" className={field} />
        </label>
        <label className="block text-[12px] font-semibold text-[#171717]">
          Password
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" className={field} />
        </label>

        {sso?.enabled && (
          <a href={`/api/v1/auth/sso/${encodeURIComponent(orgCode || '_')}/start`} className="w-full px-4 py-2 rounded border border-[#171717] text-[#171717] hover:bg-[#FAFAF8] text-[13px] font-semibold flex items-center justify-center gap-2">
            <LogIn className="w-4 h-4" />Sign in with {sso.name || 'single sign-on'}
          </a>
        )}
        {sso?.enabled && !sso.passwordLogin && <p className="text-[11px] text-[#6B6B6B]">Your organisation uses single sign-on. The password form below is for the administrator account only.</p>}

        {error && <div className="text-[12px] text-[#BC3F3F] bg-[#FCEBEC] border border-[#C84A4A]/20 rounded px-3 py-2">{error}</div>}

        <button disabled={busy || resolving || !username || !password || (!known && !!opts && !tenant.trim())} className="w-full px-4 py-2 rounded bg-[#171717] hover:bg-[#333333] text-white text-[13px] font-semibold flex items-center justify-center gap-2 disabled:opacity-60">
          <LogIn className="w-4 h-4" />
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </div>
  );
};
