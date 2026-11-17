/**
 * "Forgot your password?" Asks the server which ways the organisation allows (email, SMS, both or neither). With neither it says to ask an administrator,
 * as before. Otherwise: username (and email or SMS when both are allowed) -> a code arrives -> the code and a new password -> sign in.
 * The server never says whether the account exists, so this screen does not either.
 */
import React, { useEffect, useState } from 'react';
import { api, ApiError } from '../api';
import { Banner, Btn, Field, Input, Modal, PasswordInput } from '../ui';

type Channel = 'EMAIL' | 'SMS';

export const ForgotPassword: React.FC<{ org: string; username: string; onClose: () => void; onDone: (username: string) => void }> = ({ org, username: initialName, onClose, onDone }) => {
  const [channels, setChannels] = useState<Channel[] | null>(null);
  const [step, setStep] = useState<'ask' | 'code'>('ask');
  const [name, setName] = useState(initialName);
  const [channel, setChannel] = useState<Channel | ''>('');
  const [code, setCode] = useState('');
  const [next, setNext] = useState('');
  const [again, setAgain] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  const [wait, setWait] = useState(0);

  useEffect(() => {
    api<{ channels: Channel[] }>('/auth/password-reset/options', { method: 'POST', body: { tenant: org || undefined } })
      .then((r) => { setChannels(r.channels); if (r.channels.length === 1) setChannel(r.channels[0]); })
      .catch((e) => { setChannels([]); if (e instanceof ApiError && (e.code === 'ORG_REQUIRED' || e.code === 'ORG_UNKNOWN')) setError(e.message); });
  }, [org]);
  useEffect(() => { if (wait <= 0) return; const h = setTimeout(() => setWait(wait - 1), 1000); return () => clearTimeout(h); }, [wait]);

  const request = async () => {
    setBusy(true); setError(''); setNote('');
    try {
      const r = await api<{ message: string; resendSeconds: number }>('/auth/password-reset/request', { method: 'POST', body: { tenant: org || undefined, username: name.trim(), channel: channel || undefined } });
      setNote(r.message); setWait(r.resendSeconds); setStep('code');
    } catch (e: any) { setError(e instanceof ApiError ? e.message : 'Could not send a code. Try again.'); } finally { setBusy(false); }
  };
  const confirm = async () => {
    setError('');
    if (next !== again) { setError('The two new passwords are not the same.'); return; }
    setBusy(true);
    try {
      await api('/auth/password-reset/confirm', { method: 'POST', body: { tenant: org || undefined, username: name.trim(), code: code.trim(), newPassword: next } });
      onDone(name.trim());
    } catch (e: any) { setError(e instanceof ApiError ? e.message : 'Could not change the password. Try again.'); } finally { setBusy(false); }
  };

  if (channels === null) return <Modal title="Forgot your password?" onClose={onClose}><p className="text-[13px] text-[#525252]">One moment…</p></Modal>;

  if (!channels.length) {
    return (
      <Modal title="Forgot your password?" onClose={onClose}>
        {error && <Banner kind="err">{error}</Banner>}
        <p className="text-[13px] text-[#525252]">
          Your organisation does not offer password reset by email or SMS. Ask your WFM administrator or team lead for a new temporary password. Give them your employee number.
          You can then choose your own under <span className="font-semibold">Me &rarr; Password</span>.
        </p>
        <Btn variant="primary" className="w-full mt-4" onClick={onClose}>Got it</Btn>
      </Modal>
    );
  }

  return (
    <Modal title="Forgot your password?" onClose={onClose}>
      <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); if (step === 'ask') void request(); else void confirm(); }}>
        {error && <Banner kind="err" onClose={() => setError('')}>{error}</Banner>}
        {step === 'ask' ? (
          <>
            <p className="text-[13px] text-[#525252]">We will send a one-time code to the {channels.length === 2 ? 'email address or mobile number' : channels[0] === 'EMAIL' ? 'email address' : 'mobile number'} on your record.</p>
            <Field label="Username" hint="Your username, or your work email"><Input value={name} onChange={(e) => setName(e.target.value)} autoCapitalize="none" autoComplete="username" autoFocus /></Field>
            {channels.length === 2 && (
              <div role="radiogroup" aria-label="Send the code by" className="flex gap-4 text-[13px] text-[#171717]">
                {(['EMAIL', 'SMS'] as const).map((c) => <label key={c} className="flex items-center gap-1.5"><input type="radio" name="reset-channel" checked={channel === c} onChange={() => setChannel(c)} /> {c === 'EMAIL' ? 'Email me' : 'Text me'}</label>)}
              </div>
            )}
            <Btn variant="primary" type="submit" className="w-full" disabled={busy || !name.trim() || !channel}>{busy ? 'Sending…' : 'Send me a code'}</Btn>
            <p className="text-[11px] text-[#6B6B6B]">No email address or mobile number on your record? Ask your administrator for a temporary password.</p>
          </>
        ) : (
          <>
            {note && <Banner kind="ok">{note}</Banner>}
            <Field label="Code" hint="The six digits we sent you"><Input value={code} onChange={(e) => setCode(e.target.value.replace(/[^\d\s]/g, '').slice(0, 7))} inputMode="numeric" autoComplete="one-time-code" autoFocus /></Field>
            <Field label="New password" hint="At least 8 characters, mixing letters with numbers or symbols. Not your username or a common word."><PasswordInput value={next} onChange={(e) => setNext(e.target.value)} autoComplete="new-password" /></Field>
            <Field label="New password again"><PasswordInput value={again} onChange={(e) => setAgain(e.target.value)} autoComplete="new-password" /></Field>
            <Btn variant="primary" type="submit" className="w-full" disabled={busy || code.replace(/\s/g, '').length !== 6 || !next || !again}>{busy ? 'Saving…' : 'Set new password'}</Btn>
            <div className="flex items-center justify-between text-[12px] text-[#6B6B6B]">
              <button type="button" className="underline disabled:no-underline disabled:opacity-50" disabled={busy || wait > 0} onClick={() => void request()}>{wait > 0 ? `Send a new code in ${wait}s` : 'Send a new code'}</button>
              <button type="button" className="underline" onClick={() => { setStep('ask'); setCode(''); setError(''); }}>Start again</button>
            </div>
          </>
        )}
      </form>
    </Modal>
  );
};
