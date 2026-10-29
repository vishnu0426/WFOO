/**
 * Sign-in screen. The gateway issues a JWT; what each person can do follows their role's permissions.
 * The organisation code is only needed when the platform hosts more than one organisation.
 */
import React, { useState } from 'react';
import { LogIn } from 'lucide-react';
import { api, storeSession, Session } from '../../services/api';

export const LoginView: React.FC<{ onLogin: (session: Session) => void }> = ({ onLogin }) => {
  const [tenant, setTenant] = useState(() => localStorage.getItem('wfm_tenant') || '');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const r = await api<{ token: string } & Session>('/auth/login', { method: 'POST', body: { username, password, tenant: tenant.trim() || undefined } });
      const { token, ...session } = r;
      storeSession(token, session);
      if (tenant.trim()) localStorage.setItem('wfm_tenant', tenant.trim());
      onLogin(session);
    } catch (err: any) {
      setError(err.message);
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
            <h1 className="text-[16px] font-semibold text-[#171717] leading-tight">Enterprise WFM Platform</h1>
            <p className="text-[12px] text-[#737373]">Sign in to continue</p>
          </div>
        </div>

        <label className="block text-[12px] font-semibold text-[#171717]">
          Organisation code <span className="font-normal text-[#737373]">(if asked)</span>
          <input value={tenant} onChange={(e) => setTenant(e.target.value)} className={field} autoCapitalize="characters" />
        </label>
        <label className="block text-[12px] font-semibold text-[#171717]">
          Username
          <input value={username} onChange={(e) => setUsername(e.target.value)} autoFocus autoComplete="username" className={field} />
        </label>
        <label className="block text-[12px] font-semibold text-[#171717]">
          Password
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" className={field} />
        </label>

        {error && <div className="text-[12px] text-[#C84A4A] bg-[#FCEBEC] border border-[#C84A4A]/20 rounded px-3 py-2">{error}</div>}

        <button disabled={busy || !username || !password} className="w-full px-4 py-2 rounded bg-[#171717] hover:bg-[#333333] text-white text-[13px] font-semibold flex items-center justify-center gap-2 disabled:opacity-60">
          <LogIn className="w-4 h-4" />
          {busy ? 'Signing in…' : 'Sign in'}
        </button>

        <div className="pt-2 text-center border-t border-[#E5E5E0]">
          <a
            href="/platform"
            className="text-[11px] text-[#737373] hover:text-[#171717] hover:underline inline-flex items-center gap-1"
          >
            Platform Super Admin Portal →
          </a>
        </div>
      </form>
    </div>
  );
};
