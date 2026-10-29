/**
 * Shown instead of the app when someone signs in with a temporary password (a new account, an administrator's reset, or the first
 * administrator). The gateway refuses everything else until a new password has been chosen, so there is nothing to skip.
 */
import React, { useState } from 'react';
import { KeyRound } from 'lucide-react';
import { api, storeSession, Session } from '../../services/api';

export const ChangePasswordView: React.FC<{ session: Session; onChanged: (session: Session) => void; onSignOut: () => void }> = ({ session, onChanged, onSignOut }) => {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [again, setAgain] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    if (next !== again) { setError('The two new passwords do not match.'); return; }
    setBusy(true);
    try {
      const r = await api<{ token: string } & Session>('/auth/change-password', { method: 'POST', body: { currentPassword: current, newPassword: next } });
      const { token, ...fresh } = r;
      storeSession(token, fresh);
      onChanged(fresh);
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
          <div className="w-9 h-9 rounded bg-[#171717] flex items-center justify-center text-white"><KeyRound className="w-4 h-4" /></div>
          <div>
            <h1 className="text-[16px] font-semibold text-[#171717] leading-tight">Choose your own password</h1>
            <p className="text-[12px] text-[#737373]">{session.user.userName}, you signed in with a temporary password.</p>
          </div>
        </div>
        <label className="block text-[12px] font-semibold text-[#171717]">
          Temporary password
          <input type="password" value={current} onChange={(e) => setCurrent(e.target.value)} autoFocus autoComplete="current-password" className={field} />
        </label>
        <label className="block text-[12px] font-semibold text-[#171717]">
          New password
          <input type="password" value={next} onChange={(e) => setNext(e.target.value)} autoComplete="new-password" className={field} />
        </label>
        <label className="block text-[12px] font-semibold text-[#171717]">
          New password again
          <input type="password" value={again} onChange={(e) => setAgain(e.target.value)} autoComplete="new-password" className={field} />
        </label>
        <p className="text-[11px] text-[#737373]">At least 8 characters, mixing letters with numbers or symbols. Not your username, not a common word or number run, and not the temporary password.</p>
        {error && <div className="text-[12px] text-[#C84A4A] bg-[#FCEBEC] border border-[#C84A4A]/20 rounded px-3 py-2">{error}</div>}
        <button disabled={busy || !current || next.length < 8 || !again} className="w-full px-4 py-2 rounded bg-[#171717] hover:bg-[#333333] text-white text-[13px] font-semibold disabled:opacity-50">
          {busy ? 'Saving…' : 'Save password and continue'}
        </button>
        <button type="button" onClick={onSignOut} className="block w-full text-center text-[12px] text-[#737373] underline">Sign out</button>
      </form>
    </div>
  );
};
