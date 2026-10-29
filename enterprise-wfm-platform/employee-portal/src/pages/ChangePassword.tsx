/** Shown instead of the portal when someone signs in with a temporary password. The gateway allows nothing else until they have chosen their own. */
import React, { useState } from 'react';
import { api, ApiError, Session, storeSession } from '../api';
import { Banner, Btn, Field, Input } from '../ui';

export const ChangePassword: React.FC<{ session: Session; onChanged: (s: Session) => void; onSignOut: () => void }> = ({ session, onChanged, onSignOut }) => {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [again, setAgain] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

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
    } catch (err: any) { setError(err instanceof ApiError ? err.message : 'Could not change your password'); } finally { setBusy(false); }
  };

  return (
    <div className="min-h-screen bg-[#FAFAF8] flex items-center justify-center p-4">
      <form onSubmit={submit} className="w-full max-w-sm bg-white border border-[#E5E5E0] rounded-lg shadow-xs p-6 space-y-4">
        <div>
          <div className="font-semibold text-[15px] text-[#171717]">Choose your own password</div>
          <div className="text-[12px] text-[#737373]">{session.user.userName}, you signed in with a temporary password. Choose one only you know to continue.</div>
        </div>
        {error && <Banner kind="err" onClose={() => setError('')}>{error}</Banner>}
        <Field label="Temporary password"><Input type="password" value={current} onChange={(e) => setCurrent(e.target.value)} autoFocus /></Field>
        <Field label="New password" hint="At least 8 characters, mixing letters with numbers or symbols. Not your username or a common word."><Input type="password" value={next} onChange={(e) => setNext(e.target.value)} /></Field>
        <Field label="New password again"><Input type="password" value={again} onChange={(e) => setAgain(e.target.value)} /></Field>
        <Btn variant="primary" type="submit" disabled={busy || !current || next.length < 8 || !again} className="w-full">{busy ? 'Saving…' : 'Save password and continue'}</Btn>
        <button type="button" onClick={onSignOut} className="block w-full text-center text-[12px] text-[#737373] hover:text-accent underline">Sign out</button>
      </form>
    </div>
  );
};
