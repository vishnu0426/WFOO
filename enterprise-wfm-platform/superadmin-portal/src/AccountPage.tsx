/** Super Admin account: profile, password and signed-in devices. */
import React, { useEffect, useState } from 'react';
import { PasswordInput } from './PasswordInput';
import QRCode from 'qrcode';

type Api = <T>(path: string, options?: RequestInit) => Promise<T>;

interface Me {
  email: string;
  displayName?: string;
  lastLoginAt?: string | null;
  passwordChangedAt?: string | null;
  mfaEnabled?: boolean;
}
interface SessionRow {
  id: string;
  current: boolean;
  ipAddress: string | null;
  userAgent: string | null;
  createdAt: string;
  lastSeenAt: string;
  expiresAt: string;
}

const inputCls = 'w-full h-9 px-3 border border-[#D4D4CF] rounded text-[13px] bg-white text-[#171717] placeholder-[#A3A3A3] focus:outline-none focus:border-[#171717] focus:ring-1 focus:ring-[#171717]';
const card = 'bg-white border border-[#E5E5E0] rounded-lg shadow-xs';

const deviceName = (ua?: string | null) => {
  if (!ua) return 'Unknown device';
  const browser = /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'Browser';
  const os = /Windows/.test(ua) ? 'Windows' : /Android/.test(ua) ? 'Android' : /iPhone|iPad|iOS/.test(ua) ? 'iOS' : /Mac OS/.test(ua) ? 'macOS' : /Linux/.test(ua) ? 'Linux' : 'Unknown system';
  return `${browser} on ${os}`;
};
const when = (iso?: string | null) => (iso ? new Date(iso).toLocaleString() : 'Never');

const RULES: [string, (p: string) => boolean][] = [
  ['At least 12 characters', (p) => p.length >= 12],
  ['A lowercase letter', (p) => /[a-z]/.test(p)],
  ['An uppercase letter', (p) => /[A-Z]/.test(p)],
  ['A number', (p) => /[0-9]/.test(p)],
];

export const AccountPage: React.FC<{ api: Api; onProfileSaved: (displayName: string) => void; setupRequired?: boolean; onMfaChanged?: () => void }> = ({ api, onProfileSaved, setupRequired, onMfaChanged }) => {
  const [me, setMe] = useState<Me | null>(null);
  const [name, setName] = useState('');
  const [profileMsg, setProfileMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [cur, setCur] = useState('');
  const [next, setNext] = useState('');
  const [again, setAgain] = useState('');
  const [pwMsg, setPwMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [sessions, setSessions] = useState<SessionRow[]>([]);
  const [sessMsg, setSessMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState('');

  // two-factor sign-in
  const [setup, setSetup] = useState<{ secret: string; qr: string } | null>(null);
  const [mfaCode, setMfaCode] = useState('');
  const [recovery, setRecovery] = useState<string[] | null>(null);
  const [mfaPw, setMfaPw] = useState('');
  const [mfaOff, setMfaOff] = useState('');
  const [mfaMsg, setMfaMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [mfaAction, setMfaAction] = useState<'' | 'disable' | 'codes'>('');

  const reloadMe = () => api<{ admin: Me }>('/auth/me').then((r) => { setMe(r.admin); setName(r.admin.displayName || ''); }).catch(() => {});
  const startSetup = async () => {
    setBusy('mfa'); setMfaMsg(null);
    try {
      const r = await api<{ secret: string; otpauthUri: string }>('/auth/mfa/setup', { method: 'POST', body: '{}' });
      setSetup({ secret: r.secret, qr: await QRCode.toDataURL(r.otpauthUri, { margin: 1, width: 180 }) });
    } catch (err: any) { setMfaMsg({ ok: false, text: err.message }); } finally { setBusy(''); }
  };
  const enableMfa = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy('mfa'); setMfaMsg(null);
    try {
      const r = await api<{ recoveryCodes: string[] }>('/auth/mfa/enable', { method: 'POST', body: JSON.stringify({ code: mfaCode }) });
      setRecovery(r.recoveryCodes); setSetup(null); setMfaCode('');
      await reloadMe(); onMfaChanged?.();
    } catch (err: any) { setMfaMsg({ ok: false, text: err.message }); } finally { setBusy(''); }
  };
  const mfaChange = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy('mfa'); setMfaMsg(null);
    try {
      if (mfaAction === 'disable') {
        await api('/auth/mfa/disable', { method: 'POST', body: JSON.stringify({ password: mfaPw, code: mfaOff }) });
        setMfaMsg({ ok: true, text: 'Two-factor sign-in is off.' });
      } else {
        const r = await api<{ recoveryCodes: string[] }>('/auth/mfa/recovery-codes', { method: 'POST', body: JSON.stringify({ password: mfaPw, code: mfaOff }) });
        setRecovery(r.recoveryCodes);
      }
      setMfaPw(''); setMfaOff(''); setMfaAction('');
      await reloadMe(); onMfaChanged?.();
    } catch (err: any) { setMfaMsg({ ok: false, text: err.message }); } finally { setBusy(''); }
  };
  const downloadCodes = () => {
    const blob = new Blob([`Enterprise WFM recovery codes for ${me?.email}\nEach code works once.\n\n${(recovery || []).join('\n')}\n`], { type: 'text/plain' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'wfm-recovery-codes.txt'; a.click(); URL.revokeObjectURL(a.href);
  };

  const loadSessions = () => api<SessionRow[]>('/auth/sessions').then(setSessions).catch((e) => setSessMsg({ ok: false, text: e.message }));
  useEffect(() => {
    api<{ admin: Me }>('/auth/me').then((r) => { setMe(r.admin); setName(r.admin.displayName || ''); }).catch(() => {});
    loadSessions();
  }, []);

  const saveProfile = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy('profile'); setProfileMsg(null);
    try {
      await api('/auth/profile', { method: 'PATCH', body: JSON.stringify({ displayName: name }) });
      setProfileMsg({ ok: true, text: 'Profile saved.' });
      onProfileSaved(name.trim());
    } catch (err: any) { setProfileMsg({ ok: false, text: err.message }); } finally { setBusy(''); }
  };

  const changePassword = async (e: React.FormEvent) => {
    e.preventDefault();
    setPwMsg(null);
    if (!RULES.every(([, ok]) => ok(next))) return setPwMsg({ ok: false, text: 'The new password does not meet all the rules below.' });
    if (next !== again) return setPwMsg({ ok: false, text: 'The new password and its confirmation do not match.' });
    setBusy('password');
    try {
      const r = await api<{ otherSessionsEnded: number }>('/auth/change-password', { method: 'POST', body: JSON.stringify({ currentPassword: cur, newPassword: next }) });
      setCur(''); setNext(''); setAgain('');
      setPwMsg({ ok: true, text: `Password changed.${r.otherSessionsEnded ? ` ${r.otherSessionsEnded} other session${r.otherSessionsEnded !== 1 ? 's were' : ' was'} signed out.` : ''}` });
      api<{ admin: Me }>('/auth/me').then((x) => setMe(x.admin)).catch(() => {});
      loadSessions();
    } catch (err: any) { setPwMsg({ ok: false, text: err.message }); } finally { setBusy(''); }
  };

  const revoke = async (id: string) => {
    setBusy(id); setSessMsg(null);
    try { await api(`/auth/sessions/${id}`, { method: 'DELETE' }); await loadSessions(); } catch (err: any) { setSessMsg({ ok: false, text: err.message }); } finally { setBusy(''); }
  };
  const revokeOthers = async () => {
    if (!window.confirm('Sign out every other device?')) return;
    setBusy('others'); setSessMsg(null);
    try {
      const r = await api<{ ended: number }>('/auth/sessions/revoke-others', { method: 'POST', body: '{}' });
      setSessMsg({ ok: true, text: `${r.ended} other session${r.ended !== 1 ? 's' : ''} signed out.` });
      await loadSessions();
    } catch (err: any) { setSessMsg({ ok: false, text: err.message }); } finally { setBusy(''); }
  };

  const Msg: React.FC<{ m: { ok: boolean; text: string } | null }> = ({ m }) => m ? (
    <p role="status" className={`text-[12px] mt-2 ${m.ok ? 'text-[#2A7553]' : 'text-[#BC3F3F]'}`}>{m.text}</p>
  ) : null;

  return (
    <div className="space-y-5 max-w-4xl">
      <section className={card}>
        <div className="px-5 py-3.5 border-b border-[#E5E5E0]"><h2 className="text-[14px] font-semibold text-[#171717]">Profile</h2></div>
        <form onSubmit={saveProfile} className="p-5 grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <label className="block text-[12px] font-semibold text-[#171717] mb-1" htmlFor="acc-email">Email</label>
            <input id="acc-email" className={`${inputCls} bg-[#FAFAF8] text-[#737373]`} value={me?.email || ''} readOnly />
            <p className="text-[11px] text-[#737373] mt-1">Your sign-in. It can only be changed by creating another Super Admin.</p>
          </div>
          <div>
            <label className="block text-[12px] font-semibold text-[#171717] mb-1" htmlFor="acc-name">Display name</label>
            <input id="acc-name" className={inputCls} value={name} maxLength={120} onChange={(e) => setName(e.target.value)} placeholder="Shown in the header" />
          </div>
          <div className="text-[12px] text-[#737373] md:col-span-2">
            Last sign-in: {when(me?.lastLoginAt)}. Password last changed: {me?.passwordChangedAt ? when(me.passwordChangedAt) : 'never'}.
          </div>
          <div className="md:col-span-2">
            <button disabled={busy === 'profile'} className="px-4 py-2 rounded bg-[#171717] hover:bg-[#333] disabled:opacity-50 text-white text-[13px] font-semibold">Save profile</button>
            <Msg m={profileMsg} />
          </div>
        </form>
      </section>

      <section className={card}>
        <div className="px-5 py-3.5 border-b border-[#E5E5E0]"><h2 className="text-[14px] font-semibold text-[#171717]">Change password</h2></div>
        <form onSubmit={changePassword} className="p-5 grid grid-cols-1 md:grid-cols-2 gap-4" autoComplete="off">
          <div className="md:col-span-2 max-w-sm">
            <label className="block text-[12px] font-semibold text-[#171717] mb-1" htmlFor="acc-cur">Current password</label>
            <PasswordInput id="acc-cur" autoComplete="current-password" className={inputCls} value={cur} onChange={(e) => setCur(e.target.value)} />
          </div>
          <div>
            <label className="block text-[12px] font-semibold text-[#171717] mb-1" htmlFor="acc-new">New password</label>
            <PasswordInput id="acc-new" autoComplete="new-password" className={inputCls} value={next} onChange={(e) => setNext(e.target.value)} />
          </div>
          <div>
            <label className="block text-[12px] font-semibold text-[#171717] mb-1" htmlFor="acc-again">Confirm new password</label>
            <PasswordInput id="acc-again" autoComplete="new-password" className={inputCls} value={again} onChange={(e) => setAgain(e.target.value)} />
          </div>
          <ul className="md:col-span-2 grid grid-cols-2 md:grid-cols-4 gap-x-4 gap-y-1 text-[12px]">
            {RULES.map(([label, ok]) => (
              <li key={label} className={next && ok(next) ? 'text-[#2A7553]' : 'text-[#737373]'}>{next && ok(next) ? 'Met: ' : 'Needs: '}{label}</li>
            ))}
          </ul>
          <div className="md:col-span-2">
            <button disabled={busy === 'password' || !cur || !next} className="px-4 py-2 rounded bg-[#171717] hover:bg-[#333] disabled:opacity-50 text-white text-[13px] font-semibold">Change password</button>
            <p className="text-[11px] text-[#737373] mt-1.5">Changing your password signs out every other device.</p>
            <Msg m={pwMsg} />
          </div>
        </form>
      </section>

      <section className={card}>
        <div className="px-5 py-3.5 border-b border-[#E5E5E0] flex items-center justify-between">
          <h2 className="text-[14px] font-semibold text-[#171717]">Two-factor sign-in</h2>
          <span className={`text-[11px] font-semibold px-2 py-0.5 rounded border ${me?.mfaEnabled ? 'bg-[#EAF5EF] text-[#2A7553] border-[#2F7D5A]/20' : 'bg-[#FAFAF8] text-[#525252] border-[#E5E5E0]'}`}>{me?.mfaEnabled ? 'On' : 'Off'}</span>
        </div>
        <div className="p-5 space-y-4">
          {setupRequired && <div role="alert" className="text-[13px] rounded px-3.5 py-2.5 border bg-[#FFF5DD] text-[#8F6200] border-[#B7791F]/20">Two-factor sign-in is required for all Super Admins. Set it up below to continue.</div>}
          {recovery ? (
            <div className="space-y-3">
              <p className="text-[13px] text-[#171717] font-semibold">Save your recovery codes</p>
              <p className="text-[12px] text-[#737373]">Each code works once if you lose your phone. They are shown only now.</p>
              <ul className="grid grid-cols-2 gap-x-6 gap-y-1 font-mono text-[13px] text-[#171717] bg-[#FAFAF8] border border-[#E5E5E0] rounded p-3 max-w-sm">{recovery.map((c) => <li key={c}>{c}</li>)}</ul>
              <div className="flex gap-2">
                <button onClick={downloadCodes} className="px-3 py-1.5 rounded border border-[#E5E5E0] bg-white hover:bg-[#FAFAF8] text-[12px] font-semibold">Download</button>
                <button onClick={() => setRecovery(null)} className="px-3 py-1.5 rounded bg-[#171717] hover:bg-[#333] text-white text-[12px] font-semibold">I have saved them</button>
              </div>
            </div>
          ) : me?.mfaEnabled ? (
            <div className="space-y-3">
              <p className="text-[13px] text-[#525252]">Signing in asks for a 6-digit code from your authenticator app.</p>
              {!mfaAction && (
                <div className="flex gap-2">
                  <button onClick={() => { setMfaAction('codes'); setMfaMsg(null); }} className="px-3 py-1.5 rounded border border-[#E5E5E0] bg-white hover:bg-[#FAFAF8] text-[12px] font-semibold">New recovery codes</button>
                  <button onClick={() => { setMfaAction('disable'); setMfaMsg(null); }} className="px-3 py-1.5 rounded border border-[#E5E5E0] bg-white hover:bg-[#FAFAF8] text-[12px] font-semibold text-[#BC3F3F]">Turn off</button>
                </div>
              )}
              {mfaAction && (
                <form onSubmit={mfaChange} className="grid grid-cols-1 md:grid-cols-2 gap-3 max-w-lg" autoComplete="off">
                  <div>
                    <label className="block text-[12px] font-semibold text-[#171717] mb-1" htmlFor="mfa-pw">Password</label>
                    <PasswordInput id="mfa-pw" className={inputCls} value={mfaPw} onChange={(e) => setMfaPw(e.target.value)} autoComplete="current-password" />
                  </div>
                  <div>
                    <label className="block text-[12px] font-semibold text-[#171717] mb-1" htmlFor="mfa-off">Code from your app</label>
                    <input id="mfa-off" inputMode="numeric" className={inputCls} value={mfaOff} onChange={(e) => setMfaOff(e.target.value)} placeholder="123456" />
                  </div>
                  <div className="md:col-span-2 flex gap-2">
                    <button disabled={busy === 'mfa' || !mfaPw || !mfaOff} className="px-4 py-2 rounded bg-[#171717] hover:bg-[#333] disabled:opacity-50 text-white text-[13px] font-semibold">{mfaAction === 'disable' ? 'Turn off two-factor' : 'Create new codes'}</button>
                    <button type="button" onClick={() => setMfaAction('')} className="px-4 py-2 rounded border border-[#E5E5E0] bg-white hover:bg-[#FAFAF8] text-[13px] font-semibold">Cancel</button>
                  </div>
                </form>
              )}
            </div>
          ) : setup ? (
            <form onSubmit={enableMfa} className="space-y-3">
              <p className="text-[13px] text-[#171717]">1. Scan this code with an authenticator app (Microsoft Authenticator, Google Authenticator, 1Password and similar).</p>
              <div className="flex items-start gap-4">
                <img src={setup.qr} alt="Authenticator setup code" width={180} height={180} className="border border-[#E5E5E0] rounded" />
                <div className="text-[12px] text-[#737373] max-w-xs">
                  Cannot scan? Enter this key in the app instead:
                  <div className="mt-1 font-mono text-[13px] text-[#171717] break-all select-all">{setup.secret}</div>
                </div>
              </div>
              <p className="text-[13px] text-[#171717]">2. Enter the 6-digit code the app shows.</p>
              <div className="flex gap-2 max-w-xs">
                <input aria-label="Code from your app" inputMode="numeric" autoFocus className={inputCls} value={mfaCode} onChange={(e) => setMfaCode(e.target.value)} placeholder="123456" />
                <button disabled={busy === 'mfa' || mfaCode.length < 6} className="px-4 py-2 rounded bg-[#171717] hover:bg-[#333] disabled:opacity-50 text-white text-[13px] font-semibold">Turn on</button>
              </div>
            </form>
          ) : (
            <div className="space-y-3">
              <p className="text-[13px] text-[#525252]">Add a second step to sign-in: a 6-digit code from an authenticator app on your phone.</p>
              <button onClick={startSetup} disabled={busy === 'mfa'} className="px-4 py-2 rounded bg-[#171717] hover:bg-[#333] disabled:opacity-50 text-white text-[13px] font-semibold">Set up two-factor</button>
            </div>
          )}
          <Msg m={mfaMsg} />
        </div>
      </section>

      <section className={card}>
        <div className="px-5 py-3.5 border-b border-[#E5E5E0] flex items-center justify-between">
          <h2 className="text-[14px] font-semibold text-[#171717]">Signed-in devices</h2>
          <button onClick={revokeOthers} disabled={busy === 'others' || sessions.filter((s) => !s.current).length === 0} className="px-3 py-1.5 rounded border border-[#E5E5E0] bg-white hover:bg-[#FAFAF8] disabled:opacity-50 text-[12px] font-semibold">Sign out all other devices</button>
        </div>
        <table className="w-full text-left text-[13px]">
          <thead className="bg-[#FAFAF8] text-[#737373] text-[11px] uppercase tracking-wider border-b border-[#E5E5E0]">
            <tr><th className="px-5 py-2">Device</th><th className="px-5 py-2">IP address</th><th className="px-5 py-2">Signed in</th><th className="px-5 py-2">Last active</th><th className="px-5 py-2" /></tr>
          </thead>
          <tbody className="divide-y divide-[#E5E5E0]">
            {sessions.length === 0 && <tr><td colSpan={5} className="px-5 py-6 text-[#737373]">No sessions recorded. Sessions started before this feature was added are not listed.</td></tr>}
            {sessions.map((s) => (
              <tr key={s.id}>
                <td className="px-5 py-2.5 text-[#171717]">{deviceName(s.userAgent)} {s.current && <span className="ml-1.5 text-[11px] font-semibold px-2 py-0.5 rounded border bg-[#EAF5EF] text-[#2A7553] border-[#2F7D5A]/20">This device</span>}</td>
                <td className="px-5 py-2.5 text-[#525252]">{s.ipAddress || 'Unknown'}</td>
                <td className="px-5 py-2.5 text-[#525252] whitespace-nowrap">{when(s.createdAt)}</td>
                <td className="px-5 py-2.5 text-[#525252] whitespace-nowrap">{when(s.lastSeenAt)}</td>
                <td className="px-5 py-2.5 text-right">{!s.current && <button onClick={() => revoke(s.id)} disabled={busy === s.id} className="text-[12px] font-semibold text-[#BC3F3F] hover:underline">Sign out</button>}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="px-5 pb-3"><Msg m={sessMsg} /></div>
      </section>
    </div>
  );
};
