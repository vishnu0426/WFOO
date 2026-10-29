/** Sign-in: same /auth/login endpoint as the admin app and the mobile app. Rejects an account with no self-service access. */
import React, { useState } from 'react';
import { api, ApiError, Session, storeSession } from '../api';
import { Banner, Btn, Field, Input, Modal } from '../ui';

export const Login: React.FC<{ onLogin: (s: Session) => void }> = ({ onLogin }) => {
  const [tenant, setTenant] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [forgot, setForgot] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true); setError('');
    try {
      const r = await api<{ token: string; user: Session['user']; tenant: Session['tenant']; permissions: string[]; mustChangePassword?: boolean }>('/auth/login', { method: 'POST', body: { tenant: tenant.trim() || undefined, username: username.trim(), password } });
      if (!r.permissions.includes('self:use')) throw new ApiError('This account cannot use the employee portal. Ask your administrator to set one up for you.', 403);
      const session: Session = { user: r.user, tenant: r.tenant, permissions: r.permissions, mustChangePassword: !!r.mustChangePassword };
      storeSession(r.token, session);
      onLogin(session);
    } catch (e: any) { setError(e instanceof ApiError ? e.message : 'Sign-in failed'); } finally { setBusy(false); }
  };

  return (
    <div className="min-h-screen bg-[#FAFAF8] flex items-center justify-center p-4">
      <form onSubmit={submit} className="w-full max-w-sm bg-white border border-[#E5E5E0] rounded-lg shadow-xs p-6 space-y-4">
        <div className="flex items-center gap-2 mb-2">
          <div className="w-8 h-8 rounded-md bg-[#171717] text-white flex items-center justify-center text-[12px] font-bold">W</div>
          <div>
            <div className="font-semibold text-[15px] text-[#171717]">My WFM</div>
            <div className="text-[11px] text-[#737373]">Your schedule, time off, swaps and offers</div>
          </div>
        </div>
        {error && <Banner kind="err" onClose={() => setError('')}>{error}</Banner>}
        <Field label="Organisation code" hint="Leave blank if you only have one organisation"><Input value={tenant} onChange={(e) => setTenant(e.target.value)} autoCapitalize="none" /></Field>
        <Field label="Username"><Input value={username} onChange={(e) => setUsername(e.target.value)} autoCapitalize="none" autoFocus /></Field>
        <Field label="Password"><Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} /></Field>
        <Btn variant="primary" type="submit" disabled={busy || !username.trim() || !password} className="w-full">{busy ? 'Signing in…' : 'Sign in'}</Btn>
        <button type="button" onClick={() => setForgot(true)} className="block w-full text-center text-[12px] text-[#737373] hover:text-accent underline">Forgot your password?</button>
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
