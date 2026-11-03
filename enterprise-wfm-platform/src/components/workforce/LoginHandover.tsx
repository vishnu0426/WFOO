/** What to give a new employee with their login: username and temporary password, the organisation code, the sign-in link, and a message ready to paste. */
import React, { useState } from 'react';
import { Copy } from 'lucide-react';

export type Cred = { username: string; password: string; organisation?: { code: string; name: string }; signInUrl?: string | null; welcomeMessage?: string };

export const LoginHandover: React.FC<{ cred: Cred; reset?: boolean }> = ({ cred, reset }) => {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try { await navigator.clipboard.writeText(cred.welcomeMessage ?? ''); setCopied(true); setTimeout(() => setCopied(false), 2500); } catch { /* the message is shown below to copy by hand */ }
  };
  return (
    <div className="text-[#2A7553] text-[12px] space-y-1">
      <div>{reset ? 'New password' : 'Created'}. Username <b>{cred.username}</b>, temporary password <b className="font-mono">{cred.password}</b>. Shown once. They are asked to choose their own the first time they sign in.</div>
      {cred.organisation && <div>Organisation code <b className="font-mono">{cred.organisation.code}</b> ({cred.organisation.name}).{cred.signInUrl ? <> Sign-in link, with the code already in it: <a className="underline break-all" href={cred.signInUrl} target="_blank" rel="noreferrer">{cred.signInUrl}</a></> : <span className="text-[#8F6200]"> No portal address is set on the server (PORTAL_URL), so there is no sign-in link to send: give them the code.</span>}</div>}
      {cred.welcomeMessage && (
        <div className="flex flex-wrap items-center gap-2 pt-0.5">
          <button type="button" onClick={copy} className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded border border-[#2F7D5A]/40 bg-white text-[#2A7553] font-semibold hover:bg-[#EAF5EF]"><Copy className="w-3.5 h-3.5" />{copied ? 'Copied' : 'Copy message to send'}</button>
          <span className="text-[#6B6B6B]">Pastes the link, code, username and temporary password into an email or chat.</span>
        </div>
      )}
    </div>
  );
};
