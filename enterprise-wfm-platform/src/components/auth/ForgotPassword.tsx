/**
 * "Forgot your password?" from the sign-in screen, on the server's existing reset: ask for a six-digit code by email or SMS (whichever the organisation allows), then type the code with a new
 * password. The server never says whether an account exists, so neither does this screen. The code works once and lasts ten minutes.
 */
import React, { useEffect, useState } from 'react';
import { ArrowLeft } from 'lucide-react';
import { api } from '../../services/api';
import { PasswordInput } from '../common/PasswordInput';

export type ResetChannel = 'EMAIL' | 'SMS';
const field = 'w-full mt-1 p-2 border border-[#E5E5E0] rounded text-[13px] font-normal';
const WORD: Record<ResetChannel, string> = { EMAIL: 'email', SMS: 'text message' };

export const ForgotPassword: React.FC<{ orgCode: string; orgName?: string; channels: ResetChannel[]; initialUsername: string; onDone: (username: string) => void; onCancel: () => void }> = ({ orgCode, orgName, channels, initialUsername, onDone, onCancel }) => {
  const [step, setStep] = useState<'ASK' | 'CODE' | 'DONE'>('ASK');
  const [username, setUsername] = useState(initialUsername);
  const [channel, setChannel] = useState<ResetChannel>(channels[0]);
  const [code, setCode] = useState('');
  const [next, setNext] = useState('');
  const [again, setAgain] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [told, setTold] = useState('');
  const [wait, setWait] = useState(0);                        // seconds before another code may be asked for
  useEffect(() => { if (wait <= 0) return undefined; const t = setTimeout(() => setWait((w) => w - 1), 1000); return () => clearTimeout(t); }, [wait]);

  const ask = async (e?: React.FormEvent) => {
    e?.preventDefault(); setBusy(true); setError('');
    try {
      const r = await api<{ message: string; resendSeconds: number }>('/auth/password-reset/request', { method: 'POST', body: { tenant: orgCode, username: username.trim(), channel } });
      setTold(r.message); setWait(r.resendSeconds ?? 60); setStep('CODE');
    } catch (err: any) { setError(err.message); } finally { setBusy(false); }
  };
  const confirm = async (e: React.FormEvent) => {
    e.preventDefault(); setError('');
    if (next !== again) { setError('The two new passwords are not the same.'); return; }
    setBusy(true);
    try { await api('/auth/password-reset/confirm', { method: 'POST', body: { tenant: orgCode, username: username.trim(), code: code.trim(), newPassword: next } }); setStep('DONE'); }
    catch (err: any) { setError(err.message); } finally { setBusy(false); }
  };

  return (
    <div className="min-h-screen bg-[#FAFAF8] flex items-center justify-center p-4">
      <form onSubmit={step === 'ASK' ? ask : confirm} className="w-full max-w-sm bg-white border border-[#E5E5E0] rounded-lg shadow-xs p-6 space-y-4">
        <div>
          <h1 className="text-[16px] font-semibold text-[#171717] leading-tight">Reset your password</h1>
          {orgName && <p className="text-[12px] text-[#6B6B6B]">{orgName}</p>}
        </div>

        {step === 'ASK' && (
          <>
            <label className="block text-[12px] font-semibold text-[#171717]">Username
              <input value={username} onChange={(e) => setUsername(e.target.value)} autoFocus autoComplete="username" className={field} />
            </label>
            {channels.length > 1 && (
              <fieldset className="space-y-1">
                <legend className="text-[12px] font-semibold text-[#171717]">Send the code by</legend>
                {channels.map((c) => <label key={c} className="flex items-center gap-2 text-[13px]"><input type="radio" name="channel" checked={channel === c} onChange={() => setChannel(c)} />{c === 'EMAIL' ? 'Email' : 'Text message'}</label>)}
              </fieldset>
            )}
          </>
        )}

        {step === 'CODE' && (
          <>
            <p className="text-[12px] text-[#525252]">{told}</p>
            <label className="block text-[12px] font-semibold text-[#171717]">Six-digit code
              <input value={code} onChange={(e) => setCode(e.target.value.replace(/[^\d\s]/g, ''))} inputMode="numeric" autoComplete="one-time-code" autoFocus maxLength={8} className={`${field} tracking-[0.3em] tabular-nums`} />
            </label>
            <label className="block text-[12px] font-semibold text-[#171717]">New password
              <PasswordInput wrapperClassName="mt-1" value={next} onChange={(e) => setNext(e.target.value)} autoComplete="new-password" className={field.replace('mt-1', '')} />
            </label>
            <label className="block text-[12px] font-semibold text-[#171717]">New password again
              <PasswordInput wrapperClassName="mt-1" value={again} onChange={(e) => setAgain(e.target.value)} autoComplete="new-password" className={field.replace('mt-1', '')} />
            </label>
            <p className="text-[11px] text-[#6B6B6B]">At least 8 characters, mixing letters with numbers or symbols. Not your username and not a common word or number run.</p>
          </>
        )}

        {step === 'DONE' && <p className="text-[13px] text-[#2A7553]">Your password has been changed. Sign in with the new one.</p>}
        {error && <div className="text-[12px] text-[#BC3F3F] bg-[#FCEBEC] border border-[#C84A4A]/20 rounded px-3 py-2" role="alert">{error}</div>}

        {step === 'ASK' && <button disabled={busy || username.trim().length < 1} className="w-full px-4 py-2 rounded bg-[#171717] hover:bg-[#333333] text-white text-[13px] font-semibold disabled:opacity-50">{busy ? 'Sending…' : `Send a code by ${WORD[channel]}`}</button>}
        {step === 'CODE' && (
          <>
            <button disabled={busy || code.replace(/\s/g, '').length < 6 || !next || !again} className="w-full px-4 py-2 rounded bg-[#171717] hover:bg-[#333333] text-white text-[13px] font-semibold disabled:opacity-50">{busy ? 'Changing…' : 'Change password'}</button>
            <button type="button" disabled={wait > 0 || busy} onClick={() => void ask()} className="text-[12px] underline text-[#6B6B6B] hover:text-[#171717] disabled:no-underline disabled:opacity-60">{wait > 0 ? `Send a new code in ${wait} s` : 'Send a new code'}</button>
          </>
        )}
        {step === 'DONE' && <button type="button" onClick={() => onDone(username.trim())} className="w-full px-4 py-2 rounded bg-[#171717] hover:bg-[#333333] text-white text-[13px] font-semibold">Back to sign in</button>}
        {step !== 'DONE' && <button type="button" onClick={onCancel} className="flex items-center gap-1 text-[12px] text-[#6B6B6B] hover:text-[#171717]"><ArrowLeft className="h-3.5 w-3.5" />Back to sign in</button>}
      </form>
    </div>
  );
};
