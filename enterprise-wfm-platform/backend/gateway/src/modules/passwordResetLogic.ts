/**
 * Pure rules for "I forgot my password": which channels an organisation allows, which one a request uses, how a code is made and checked, and what the
 * message says. No database and no sending here, so each rule is tested on its own.
 */
import crypto from 'node:crypto';

export type ResetMethod = 'OFF' | 'EMAIL' | 'SMS' | 'EITHER';
export type ResetChannel = 'EMAIL' | 'SMS';
export const RESET_METHODS: ResetMethod[] = ['OFF', 'EMAIL', 'SMS', 'EITHER'];

export const CODE_DIGITS = 6;
export const CODE_MINUTES = 10;
export const MAX_CODE_TRIES = 5;           // wrong guesses before the code is burned
export const RESEND_SECONDS = 60;          // no new code for the same person inside this time
export const MAX_CODES_PER_HOUR = 5;       // per person

/** The channels the organisation allows AND has switched on (a method that needs SMS does nothing while SMS is off). */
export function usableChannels(method: ResetMethod, emailOn: boolean, smsOn: boolean): ResetChannel[] {
  const out: ResetChannel[] = [];
  if ((method === 'EMAIL' || method === 'EITHER') && emailOn) out.push('EMAIL');
  if ((method === 'SMS' || method === 'EITHER') && smsOn) out.push('SMS');
  return out;
}

/** The channel a request uses: the one asked for when it is allowed, else the only one there is. Null when the person has to choose. */
export function pickChannel(usable: ResetChannel[], asked?: string | null): ResetChannel | null {
  if (asked) return usable.includes(asked as ResetChannel) ? (asked as ResetChannel) : null;
  return usable.length === 1 ? usable[0] : null;
}

/** A six-digit code, drawn uniformly (leading zeros kept). */
export const makeCode = (): string => String(crypto.randomInt(0, 10 ** CODE_DIGITS)).padStart(CODE_DIGITS, '0');
/** Codes are short, so the stored hash is keyed with the server secret and the person: a copy of the table cannot be searched offline without both. */
export const hashCode = (code: string, userId: string, secret: string): string => crypto.createHmac('sha256', secret).update(`${userId}:${code}`).digest('hex');
export function codeMatches(given: string, storedHash: string, userId: string, secret: string): boolean {
  const a = Buffer.from(hashCode(given.replace(/\s+/g, ''), userId, secret)), b = Buffer.from(storedHash);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export function messageFor(channel: ResetChannel, org: string, code: string): { subject: string; body: string } {
  const subject = `${org}: your password reset code`;
  return channel === 'EMAIL'
    ? { subject, body: `Your password reset code is ${code}.\n\nIt works once and expires in ${CODE_MINUTES} minutes. If you did not ask for it, ignore this message: your password has not changed.` }
    : { subject, body: `${org}: your password reset code is ${code}. It expires in ${CODE_MINUTES} minutes. Not you? Ignore this.` };
}

/** What a request always answers, whether or not the account exists, has a contact, or was sent a code: nobody can use it to find out who has an account. */
export const REQUEST_ANSWER = `If that account can be reset this way, a code is on its way. It arrives within a minute or two and works for ${CODE_MINUTES} minutes.`;
export const BAD_CODE = 'That code is wrong or has expired. Check it, or ask for a new one.';
