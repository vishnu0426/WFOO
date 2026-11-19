/**
 * Opened from the one-time link in an invitation or a password reset (/reset-password?token=...&org=CODE).
 * The link works once: choosing a password uses it up, and the person then signs in as usual.
 */
import React, { useEffect, useState } from 'react';
import { PasswordInput } from '../common/PasswordInput';
import { api } from '../../services/api';

interface Link { valid: boolean; username?: string; name?: string; organisation?: string; code?: string }

export const SetPasswordView: React.FC = () => {
  const q = new URLSearchParams(location.search);
  const token = q.get('token') || '';
  const invite = q.get('invite') === '1';
  const [info, setInfo] = useState<Link | null>(null);
  const [next, setNext] = useState('');
  const [again, setAgain] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  useEffect(() => {
    if (!token) { setInfo({ valid: false }); return; }
    api<Link>('/auth/emergency-reset/check', { method: 'POST', body: { token } }).then(setInfo).catch(() => setInfo({ valid: false }));
  }, [token]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    if (next !== again) { setError('The two passwords do not match.'); return; }
    setBusy(true);
    try {
      await api('/auth/emergency-reset/complete', { method: 'POST', body: { token, newPassword: next } });
      setDone(true);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const signInHref = `/${info?.code || q.get('org') ? `?org=${encodeURIComponent(info?.code || q.get('org') || '')}` : ''}`;
  const field = 'w-full mt-1 p-2 border border-[#E5E5E0] rounded text-[13px] font-normal';
  const shell = (children: React.ReactNode) => (
    <div className="min-h-screen bg-[#FAFAF8] flex items-center justify-center p-4">
      <div className="w-full max-w-sm bg-white border border-[#E5E5E0] rounded-lg shadow-xs p-6 space-y-4">
        <div className="flex items-center gap-2.5">
          <div className="w-9 h-9 rounded bg-[#171717] flex items-center justify-center text-white font-bold text-[11px] tracking-wider">WFM</div>
          <div className="text-[15px] font-bold text-[#171717] tracking-tight">Enterprise WFM</div>
        </div>
        {children}
      </div>
    </div>
  );

  if (!info) return shell(<p className="text-[13px] text-[#6B6B6B]">Checking your link...</p>);

  if (!info.valid) {
    return shell(
      <>
        <h1 className="text-[16px] font-semibold text-[#171717]">This link no longer works</h1>
        <p className="text-[13px] text-[#6B6B6B]">It may have been used already, or it has expired. Ask your administrator to send you a new one.</p>
        <a href="/" className="inline-block px-4 py-2 rounded border border-[#E5E5E0] bg-white hover:bg-[#FAFAF8] text-[13px] font-semibold text-[#171717]">Go to sign in</a>
      </>
    );
  }

  if (done) {
    return shell(
      <>
        <h1 className="text-[16px] font-semibold text-[#171717]">Password saved</h1>
        <p className="text-[13px] text-[#6B6B6B]">You can now sign in{info.organisation ? ` to ${info.organisation}` : ''}{info.username ? ` as ${info.username}` : ''}.</p>
        <a href={signInHref} className="block text-center px-4 py-2 rounded bg-[#171717] hover:bg-[#333333] text-white text-[13px] font-semibold">Go to sign in</a>
      </>
    );
  }

  return shell(
    <form onSubmit={submit} className="space-y-4">
      <div>
        <h1 className="text-[16px] font-semibold text-[#171717]">{invite ? 'Welcome. Set your password' : 'Choose a new password'}</h1>
        <p className="text-[12px] text-[#6B6B6B] mt-1">
          {info.name ? `${info.name}, ` : ''}{info.organisation ? `for ${info.organisation}` : ''}{info.username ? ` (sign-in: ${info.username})` : ''}
        </p>
      </div>
      <label className="block text-[12px] font-semibold text-[#171717]">
        New password
        <PasswordInput wrapperClassName="mt-1" value={next} onChange={(e) => setNext(e.target.value)} autoFocus autoComplete="new-password" className={field.replace('mt-1', '')} />
      </label>
      <label className="block text-[12px] font-semibold text-[#171717]">
        New password again
        <PasswordInput wrapperClassName="mt-1" value={again} onChange={(e) => setAgain(e.target.value)} autoComplete="new-password" className={field.replace('mt-1', '')} />
      </label>
      <p className="text-[11px] text-[#6B6B6B]">At least 8 characters, mixing letters with numbers or symbols. Not your username and not a common word or number run.</p>
      {error && <div role="alert" className="text-[12px] text-[#BC3F3F] bg-[#FCEBEC] border border-[#C84A4A]/20 rounded px-3 py-2">{error}</div>}
      <button disabled={busy || next.length < 8 || !again} className="w-full px-4 py-2 rounded bg-[#171717] hover:bg-[#333333] text-white text-[13px] font-semibold disabled:opacity-50">
        {busy ? 'Saving...' : 'Save password'}
      </button>
    </form>
  );
};
