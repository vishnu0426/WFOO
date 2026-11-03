/**
 * Sign-in: same /auth/login endpoint as the admin app and the mobile app. Rejects an account with no self-service access.
 * Nobody should have to know an "organisation code": it comes from the link they were sent (?org=), the address (/org/acme, or acme.example.com when that
 * is switched on), the organisation used last on this device, or, when there is only one organisation, nowhere at all. Failing that, they type it, or find
 * it from their work email.
 */
import React, { useEffect, useState } from 'react';
import { api, ApiError, Session, storeSession } from '../api';
import { Banner, Btn, Field, Input, Modal } from '../ui';
import { infoUrl, loginMode, startUrl, type SsoInfo } from '../sso';
import { orgFromAddress, type OrgSource } from '../orgAddress';

const ORG_KEY = 'wfm_org';                                   // the organisation signed in to last on this device
const FROM_SUBDOMAIN = (import.meta as any).env?.VITE_ORG_FROM_SUBDOMAIN === 'true';
type Org = { code: string; name: string };
type Known = Org & { source: OrgSource | 'only' | 'email' | 'typed' };
type Options = { singleOrganisation: Org | null; discovery: boolean };
const NOT_FOUND = "We couldn't find that organisation. Check the code on your welcome message, or ask your manager.";

export const Login: React.FC<{ onLogin: (s: Session) => void; initialError?: string }> = ({ onLogin, initialError }) => {
  const [known, setKnown] = useState<Known | null>(null);      // the organisation we are signing in to, once we are sure it exists
  const [resolving, setResolving] = useState(true);
  const [opts, setOpts] = useState<Options | null>(null);
  const [tenant, setTenant] = useState('');                    // a code typed by hand
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(initialError ?? '');
  const [sso, setSso] = useState<SsoInfo | null>(null);
  const [adminForm, setAdminForm] = useState(false);
  const [finder, setFinder] = useState(false);                 // "find my organisation by email" is open
  const [email, setEmail] = useState('');
  const [choices, setChoices] = useState<Org[] | null>(null);
  const [codeError, setCodeError] = useState('');

  // work out the organisation before showing the form: from the link or address, else the last one used here, else the only one there is
  useEffect(() => {
    let live = true;
    (async () => {
      const o = await api<Options>('/auth/login-options').catch(() => null);
      if (!live) return;
      setOpts(o);
      const where = orgFromAddress(location, localStorage.getItem(ORG_KEY), { subdomain: FROM_SUBDOMAIN });
      let found: Known | null = null;
      if (where) {
        try { const r = await api<Org>(`/auth/org/${encodeURIComponent(where.code)}`); found = { ...r, source: where.source }; }
        catch (e) {
          if (e instanceof ApiError && e.status === 404) {
            if (where.source === 'remembered') localStorage.removeItem(ORG_KEY);
            else if (where.source === 'link' || where.source === 'path') setError(`This sign-in link names an organisation we don't recognise ("${where.code}"). Ask your manager for a new link, or enter the organisation code below.`);
          }
        }
      }
      if (!found && o?.singleOrganisation) found = { ...o.singleOrganisation, source: 'only' };
      if (!live) return;
      setKnown(found); setResolving(false);
    })();
    return () => { live = false; };
  }, []);

  const orgCode = known?.code ?? tenant.trim();
  // does this organisation use single sign-on? Asked again when the organisation changes; no answer means the password form, never a dead end
  useEffect(() => {
    if (resolving) return;
    let live = true;
    const h = setTimeout(() => { api<SsoInfo>(infoUrl(orgCode)).then((i) => live && setSso(i)).catch(() => live && setSso(null)); }, 350);
    return () => { live = false; clearTimeout(h); };
  }, [orgCode, resolving]);
  const mode = loginMode(sso);
  const showForm = mode === 'password' || mode === 'both' || adminForm;
  const [forgot, setForgot] = useState(false);

  const change = () => { localStorage.removeItem(ORG_KEY); setKnown(null); setTenant(''); setSso(null); setCodeError(''); setError(''); };
  /** A typed code is checked when they leave the box, so a typing slip is caught before the password. */
  const checkTyped = async () => {
    const c = tenant.trim();
    if (!c) { setCodeError(''); return; }
    try { const r = await api<Org>(`/auth/org/${encodeURIComponent(c)}`); setKnown({ ...r, source: 'typed' }); setCodeError(''); }
    catch (e) { setCodeError(e instanceof ApiError && e.status === 404 ? NOT_FOUND : e instanceof ApiError ? e.message : NOT_FOUND); }
  };
  const find = async () => {
    setBusy(true); setError(''); setChoices(null);
    try {
      const r = await api<{ organisations: Org[] }>('/auth/discover', { method: 'POST', body: { identifier: email.trim() } });
      if (r.organisations.length === 1) pick(r.organisations[0]); else setChoices(r.organisations);
    } catch (e) { setError(e instanceof ApiError ? e.message : 'Could not look that up. Try again.'); } finally { setBusy(false); }
  };
  const pick = (o: Org) => { setKnown({ ...o, source: 'email' }); setChoices(null); setFinder(false); if (!username) setUsername(email.trim()); };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true); setError('');
    try {
      const r = await api<{ token: string; user: Session['user']; tenant: Session['tenant']; permissions: string[]; mustChangePassword?: boolean }>('/auth/login', { method: 'POST', body: { tenant: orgCode || undefined, username: username.trim(), password } });
      if (!r.permissions.includes('self:use')) throw new ApiError('This account cannot use the employee portal. Ask your administrator to set one up for you.', 403);
      const session: Session = { user: r.user, tenant: r.tenant, permissions: r.permissions, mustChangePassword: !!r.mustChangePassword };
      localStorage.setItem(ORG_KEY, r.tenant.code);        // next time on this device, no code to type
      storeSession(r.token, session);
      onLogin(session);
    } catch (e: any) {
      setError(e instanceof ApiError ? e.message : 'Sign-in failed');
      if (e instanceof ApiError && (e.code === 'ORG_REQUIRED' || e.code === 'ORG_UNKNOWN')) { setKnown(null); setFinder(!!opts?.discovery); }
    } finally { setBusy(false); }
  };

  return (
    <div className="min-h-screen bg-[#FAFAF8] flex items-center justify-center p-4">
      <form onSubmit={submit} className="w-full max-w-sm bg-white border border-[#E5E5E0] rounded-lg shadow-xs p-6 space-y-4">
        <div className="flex items-center gap-2 mb-2">
          <div className="w-8 h-8 rounded-md bg-[#171717] text-white flex items-center justify-center text-[12px] font-bold">W</div>
          <div>
            <div className="font-semibold text-[15px] text-[#171717]">AgnoWFM</div>
            <div className="text-[11px] text-[#6B6B6B]">Your schedule, time off, swaps and offers</div>
          </div>
        </div>
        {error && <Banner kind="err" onClose={() => setError('')}>{error}</Banner>}
        {mode === 'blocked' && <Banner kind="err">Your organisation signs in with single sign-on, but this portal has not been set up for it yet. Ask your administrator.</Banner>}

        {resolving ? <div className="text-[12px] text-[#6B6B6B]">Loading…</div> : known && known.source !== 'only' ? (
          <div className="rounded-md border border-[#E5E5E0] bg-[#FAFAF8] px-3 py-2">
            <div className="text-[11px] text-[#6B6B6B]">Signing in to</div>
            <div className="flex items-center justify-between gap-2">
              <span className="font-semibold text-[14px] text-[#171717]">{known.name}</span>
              <button type="button" onClick={change} className="text-[12px] text-[#6B6B6B] hover:text-accent underline">Not your organisation?</button>
            </div>
          </div>
        ) : !known && (
          <div className="space-y-2">
            <Field label="Organisation code" hint="It is on your welcome message, or in the link your manager sent you.">
              <Input value={tenant} onChange={(e) => { setTenant(e.target.value); setCodeError(''); }} onBlur={checkTyped} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void checkTyped(); } }} autoCapitalize="none" autoFocus />
            </Field>
            {codeError && <div className="text-[12px] text-[#BC3F3F]">{codeError}</div>}
            {opts?.discovery ? (
              <button type="button" onClick={() => setFinder((v) => !v)} className="text-[12px] text-[#6B6B6B] hover:text-accent underline">{finder ? 'Hide' : "Don't know it? Find my organisation"}</button>
            ) : <div className="text-[12px] text-[#6B6B6B]">Don't have it? Ask your manager.</div>}
            {finder && (
              <div className="rounded-md border border-[#E5E5E0] bg-[#FAFAF8] p-3 space-y-2">
                <Field label="Your work email or username"><Input value={email} onChange={(e) => { setEmail(e.target.value); setChoices(null); }} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); if (email.trim().length >= 3) void find(); } }} autoCapitalize="none" /></Field>
                <Btn type="button" disabled={busy || email.trim().length < 3} onClick={find} className="w-full justify-center">{busy ? 'Looking…' : 'Find my organisation'}</Btn>
                {choices && choices.length === 0 && <div className="text-[12px] text-[#525252]">We couldn't find an account for that. Check the spelling, or ask your manager for the organisation code.</div>}
                {choices && choices.length > 1 && (
                  <div className="space-y-1.5">
                    <div className="text-[12px] text-[#525252]">You have an account in more than one organisation. Which one?</div>
                    {choices.map((o) => <button key={o.code} type="button" onClick={() => pick(o)} className="w-full text-left rounded-md border border-[#E5E5E0] bg-white px-3 py-2 text-[13px] hover:bg-[#F5F5F0]">{o.name}</button>)}
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {(mode === 'both' || mode === 'sso-only') && (
          <>
            <a href={startUrl(orgCode, sso)} className="block w-full text-center rounded-md bg-accent text-white text-[13px] font-medium py-2 hover:opacity-90">Sign in with {sso?.name || 'single sign-on'}</a>
            {mode === 'both' && <div className="text-center text-[11px] text-[#6B6B6B]">or sign in with a password</div>}
          </>
        )}
        {showForm && (
          <>
          <Field label="Username" hint={known ? 'Your username, or your work email' : undefined}><Input value={username} onChange={(e) => setUsername(e.target.value)} autoCapitalize="none" autoFocus={!!known} /></Field>
          <Field label="Password"><Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} /></Field>
          <Btn variant="primary" type="submit" disabled={busy || resolving || !username.trim() || !password || (!known && !!opts && !tenant.trim())} className="w-full">{busy ? 'Signing in…' : 'Sign in'}</Btn>
          </>
        )}
        {mode === 'sso-only' && !adminForm && <button type="button" onClick={() => setAdminForm(true)} className="block w-full text-center text-[12px] text-[#6B6B6B] hover:text-accent underline">Administrator sign-in</button>}
        {mode === 'blocked' && !adminForm && <button type="button" onClick={() => setAdminForm(true)} className="block w-full text-center text-[12px] text-[#6B6B6B] hover:text-accent underline">Administrator sign-in</button>}
        {showForm && <button type="button" onClick={() => setForgot(true)} className="block w-full text-center text-[12px] text-[#6B6B6B] hover:text-accent underline">Forgot your password?</button>}
      </form>
      {forgot && (
        <Modal title="Forgot your password?" onClose={() => setForgot(false)}>
          <p className="text-[13px] text-[#525252]">
            Passwords for this portal are reset by your WFM administrator or team lead, not by email. Reach out to them with your employee number and
            they can issue you a new temporary password to sign in with — you can then set your own from <span className="font-semibold">Me &rarr; Password</span>.
          </p>
          <Btn variant="primary" className="w-full mt-4" onClick={() => setForgot(false)}>Got it</Btn>
        </Modal>
      )}
    </div>
  );
};
