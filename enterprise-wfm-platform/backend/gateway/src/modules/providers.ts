/**
 * Email and SMS providers. Each provider says which credentials it needs (so the screen can show the right boxes) and how to turn a message into the request it
 * understands. Email is either SMTP (a host, a port, a login: the presets below only fill in the host and port for you) or a provider's web API. SMS is always a web
 * request to the provider.
 *
 * Nothing here talks to the network or the database: it only builds requests, so it can be tested on its own. The addresses are the providers' published ones and every
 * provider takes an optional "API address" override so a request can be pointed at a test server or a regional endpoint.
 *
 * The provider names are trademarks of their owners. They are only listed so you can choose which service your organisation already uses; no provider's software is
 * included, and none is required: "Custom SMTP" and "Any web gateway" work with any other service or your own server.
 */
import { createHash } from 'node:crypto';
import { signRequest } from './integrations/sigv4.ts';

export interface Field { key: string; label: string; secret?: boolean; required?: boolean; help?: string; placeholder?: string; options?: { value: string; label: string }[]; default?: string; advanced?: boolean; multiline?: boolean }
export interface ProviderInfo { id: string; label: string; kind: 'SMTP' | 'API' | 'HTTP'; help: string; fields: Field[] }

export interface SmtpOptions { host: string; port: number; secure: boolean; requireTLS?: boolean; ignoreTLS?: boolean; auth?: { user: string; pass: string }; tlsAllowSelfSigned?: boolean }
export interface Attachment { name: string; type: string; content: string; /** 'base64' when content is already encoded (a PDF); plain text otherwise */ encoding?: 'base64' }
export interface EmailMessage { from: string; to: string; subject: string; text: string; attachment?: Attachment | null; attachments?: Attachment[] | null }
export const attachmentsOf = (m: { attachment?: Attachment | null; attachments?: Attachment[] | null }): Attachment[] => (m.attachments?.length ? m.attachments : m.attachment ? [m.attachment] : []);
const b64 = (a: Attachment) => (a.encoding === 'base64' ? a.content : Buffer.from(a.content).toString('base64'));
export type EmailPlan = { smtp: SmtpOptions } | { request: (m: EmailMessage) => { url: string; init: RequestInit }; verify: (status: number, body: string) => string | null };
export interface SmsRequest { url: string; init: RequestInit; verify: (status: number, body: string) => string | null }

type V = Record<string, string>;
const f = (key: string, label: string, o: Partial<Field> = {}): Field => ({ key, label, required: true, ...o });
const SEC: Field['options'] = [{ value: 'AUTO', label: 'Use encryption if the server offers it' }, { value: 'STARTTLS', label: 'Encrypted after connecting (STARTTLS, usually port 587)' }, { value: 'SSL', label: 'Encrypted from the start (SSL/TLS, usually port 465)' }, { value: 'NONE', label: 'Not encrypted (only inside your own network)' }];
const API_BASE = f('apiBase', 'API address', { required: false, advanced: true, help: 'Leave empty to use the provider\'s usual address. Change it for a regional endpoint or a test server.' });
const base = (v: V, dflt: string) => (v.apiBase || dflt).replace(/\/+$/, '');
const err = (status: number, body: string, ok: number[], pick?: (b: any) => string | undefined) => {
  if (ok.includes(status)) return null;
  let detail = '';
  try { detail = pick?.(JSON.parse(body)) ?? ''; } catch { detail = body.slice(0, 120); }
  return `The provider answered ${status}${detail ? `: ${detail}` : ''}`;
};
const digits = (to: string) => to.replace(/[^\d]/g, '');
const plus = (to: string) => `+${digits(to)}`;
const basic = (u: string, p: string) => `Basic ${Buffer.from(`${u}:${p}`).toString('base64')}`;
const form = (o: Record<string, string>) => new URLSearchParams(o).toString();

// ---------------------------------------------------------------- email

const smtpPreset = (id: string, label: string, help: string, fields: Field[], opts: (v: V) => SmtpOptions): { info: ProviderInfo; plan: (v: V) => EmailPlan } =>
  ({ info: { id, label, kind: 'SMTP', help, fields: [...fields, f('allowSelfSigned', 'Accept a self-signed certificate', { required: false, advanced: true, options: [{ value: 'no', label: 'No' }, { value: 'yes', label: 'Yes (only for a server you run yourself)' }], default: 'no' })] }, plan: (v) => ({ smtp: { ...opts(v), tlsAllowSelfSigned: v.allowSelfSigned === 'yes' } }) });

const EMAIL = [
  smtpPreset('SMTP', 'Custom SMTP server', 'Any mail server: your own, Exchange, Postfix, or a relay. Ask your email administrator for these.',
    [f('host', 'Mail server', { placeholder: 'smtp.example.com' }), f('port', 'Port', { default: '587' }), f('security', 'Encryption', { options: SEC, default: 'AUTO' }), f('user', 'Sign-in name', { required: false, help: 'Leave empty if the server does not ask for a login.' }), f('pass', 'Password', { secret: true, required: false })],
    (v) => ({ host: v.host, port: Number(v.port || 587), secure: v.security === 'SSL', requireTLS: v.security === 'STARTTLS', ignoreTLS: v.security === 'NONE', auth: v.user ? { user: v.user, pass: v.pass ?? '' } : undefined })),
  smtpPreset('GMAIL', 'Gmail / Google Workspace', 'Turn on 2-step verification for the account, then create an "app password" (Google account > Security > App passwords) and use it here instead of the account password.',
    [f('user', 'Gmail address', { placeholder: 'wfm@yourcompany.com' }), f('pass', 'App password', { secret: true })],
    (v) => ({ host: 'smtp.gmail.com', port: 587, secure: false, requireTLS: true, auth: { user: v.user, pass: v.pass } })),
  smtpPreset('M365', 'Microsoft 365 / Outlook', 'Needs "SMTP AUTH" switched on for the mailbox. Microsoft is phasing out password sign-in for some tenants; if yours has, use "Custom SMTP" with your organisation\'s SMTP relay instead.',
    [f('user', 'Mailbox address', { placeholder: 'wfm@yourcompany.com' }), f('pass', 'Password', { secret: true })],
    (v) => ({ host: 'smtp.office365.com', port: 587, secure: false, requireTLS: true, auth: { user: v.user, pass: v.pass } })),
  smtpPreset('SES', 'Amazon SES (SMTP)', 'Create SMTP credentials in the SES console (they are not your AWS access keys). The sender address must be verified in SES.',
    [f('region', 'AWS region', { default: 'us-east-1', placeholder: 'us-east-1' }), f('user', 'SMTP user name'), f('pass', 'SMTP password', { secret: true })],
    (v) => ({ host: `email-smtp.${v.region || 'us-east-1'}.amazonaws.com`, port: 587, secure: false, requireTLS: true, auth: { user: v.user, pass: v.pass } })),
  smtpPreset('SENDGRID', 'SendGrid (SMTP)', 'Create an API key with "Mail Send" permission and paste it here. The sender address or domain must be verified in SendGrid.',
    [f('apiKey', 'API key', { secret: true })],
    (v) => ({ host: 'smtp.sendgrid.net', port: 587, secure: false, requireTLS: true, auth: { user: 'apikey', pass: v.apiKey } })),
  smtpPreset('MAILGUN', 'Mailgun (SMTP)', 'Use the SMTP login and password from your sending domain\'s settings in Mailgun.',
    [f('region', 'Region', { options: [{ value: 'US', label: 'United States' }, { value: 'EU', label: 'Europe' }], default: 'US' }), f('user', 'SMTP login', { placeholder: 'postmaster@mg.yourcompany.com' }), f('pass', 'SMTP password', { secret: true })],
    (v) => ({ host: v.region === 'EU' ? 'smtp.eu.mailgun.org' : 'smtp.mailgun.org', port: 587, secure: false, requireTLS: true, auth: { user: v.user, pass: v.pass } })),
  smtpPreset('BREVO', 'Brevo (SMTP)', 'Use the SMTP login and SMTP key from Brevo (SMTP & API > SMTP).',
    [f('user', 'SMTP login'), f('pass', 'SMTP key', { secret: true })],
    (v) => ({ host: 'smtp-relay.brevo.com', port: 587, secure: false, requireTLS: true, auth: { user: v.user, pass: v.pass } })),
  smtpPreset('POSTMARK', 'Postmark (SMTP)', 'Use a server\'s API token (it is both the user name and the password). The sender must be a confirmed signature or domain.',
    [f('token', 'Server API token', { secret: true })],
    (v) => ({ host: 'smtp.postmarkapp.com', port: 587, secure: false, requireTLS: true, auth: { user: v.token, pass: v.token } })),
  smtpPreset('MAILJET', 'Mailjet (SMTP)', 'Use the API key and secret key from your Mailjet account.',
    [f('user', 'API key'), f('pass', 'Secret key', { secret: true })],
    (v) => ({ host: 'in-v3.mailjet.com', port: 587, secure: false, requireTLS: true, auth: { user: v.user, pass: v.pass } })),
  smtpPreset('ZOHO', 'Zoho Mail', 'Use the mailbox address and an application-specific password (Zoho account > Security).',
    [f('region', 'Data centre', { options: [{ value: 'com', label: 'zoho.com (United States)' }, { value: 'in', label: 'zoho.in (India)' }, { value: 'eu', label: 'zoho.eu (Europe)' }], default: 'com' }), f('user', 'Mailbox address'), f('pass', 'Password', { secret: true })],
    (v) => ({ host: `smtp.zoho.${v.region || 'com'}`, port: 587, secure: false, requireTLS: true, auth: { user: v.user, pass: v.pass } })),
  {
    info: { id: 'RESEND', label: 'Resend (web API)', kind: 'API', help: 'Create an API key in Resend. The sender must be on a domain you have verified there.', fields: [f('apiKey', 'API key', { secret: true }), API_BASE] } as ProviderInfo,
    plan: (v: V): EmailPlan => ({
      request: (m) => ({ url: `${base(v, 'https://api.resend.com')}/emails`, init: { method: 'POST', headers: { Authorization: `Bearer ${v.apiKey}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ from: m.from, to: [m.to], subject: m.subject, text: m.text, ...(attachmentsOf(m).length ? { attachments: attachmentsOf(m).map((a) => ({ filename: a.name, content: b64(a) })) } : {}) }) } }),
      verify: (s, b) => err(s, b, [200, 201, 202], (j) => j.message),
    }),
  },
  {
    info: { id: 'SENDGRID_API', label: 'SendGrid (web API)', kind: 'API', help: 'The same SendGrid key as above, but sent over the web API instead of SMTP. Useful where SMTP ports are blocked.', fields: [f('apiKey', 'API key', { secret: true }), API_BASE] } as ProviderInfo,
    plan: (v: V): EmailPlan => ({
      request: (m) => ({ url: `${base(v, 'https://api.sendgrid.com')}/v3/mail/send`, init: { method: 'POST', headers: { Authorization: `Bearer ${v.apiKey}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ personalizations: [{ to: [{ email: m.to }] }], from: { email: m.from.replace(/^.*<|>$/g, '') }, subject: m.subject, content: [{ type: 'text/plain', value: m.text || ' ' }], ...(attachmentsOf(m).length ? { attachments: attachmentsOf(m).map((a) => ({ filename: a.name, type: a.type, content: b64(a) })) } : {}) }) } }),
      verify: (s, b) => err(s, b, [200, 201, 202], (j) => j.errors?.[0]?.message),
    }),
  },
  {
    info: { id: 'POSTMARK_API', label: 'Postmark (web API)', kind: 'API', help: 'A Postmark server token, sent over the web API.', fields: [f('token', 'Server API token', { secret: true }), API_BASE] } as ProviderInfo,
    plan: (v: V): EmailPlan => ({
      request: (m) => ({ url: `${base(v, 'https://api.postmarkapp.com')}/email`, init: { method: 'POST', headers: { 'X-Postmark-Server-Token': v.token, 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify({ From: m.from, To: m.to, Subject: m.subject, TextBody: m.text, ...(attachmentsOf(m).length ? { Attachments: attachmentsOf(m).map((a) => ({ Name: a.name, ContentType: a.type, Content: b64(a) })) } : {}) }) } }),
      verify: (s, b) => err(s, b, [200], (j) => j.Message),
    }),
  },
];

// ---------------------------------------------------------------- SMS

type SmsDef = { info: ProviderInfo; build: (v: V, to: string, message: string) => SmsRequest };
const SMS: SmsDef[] = [
  {
    info: { id: 'HTTP', label: 'Any web gateway (custom)', kind: 'HTTP', help: 'Any SMS gateway that takes a web request: your carrier, Kannel, Gammu, or a provider not listed. Say where to send and what to send; {{to}} and {{message}} are filled in for each text.',
      fields: [f('url', 'Gateway address', { placeholder: 'https://sms.example.com/send' }), f('method', 'Send as', { options: [{ value: 'POST', label: 'POST' }, { value: 'GET', label: 'GET (in the address)' }], default: 'POST' }), f('contentType', 'Format', { options: [{ value: 'JSON', label: 'JSON' }, { value: 'FORM', label: 'Form fields' }], default: 'JSON' }),
        f('headers', 'Headers (one per line, Name: value)', { secret: true, required: false, multiline: true, placeholder: 'Authorization: Bearer ...' }), f('body', 'What to send (one per line, name = value)', { required: false, multiline: true, default: 'to = {{to}}\nmessage = {{message}}' })] },
    build: (v, to, message) => {
      const lines = (t: string | undefined, sep: string): Record<string, string> => Object.fromEntries((t ?? '').split('\n').map((l) => { const i = l.indexOf(sep); return i < 0 ? [] : [l.slice(0, i).trim(), l.slice(i + sep.length).trim()]; }).filter((p) => p[0]));
      const fill = (s: string) => s.replace(/\{\{to\}\}/g, to).replace(/\{\{message\}\}/g, message);
      const body = Object.fromEntries(Object.entries(Object.keys(lines(v.body, '=')).length ? lines(v.body, '=') : { to: '{{to}}', message: '{{message}}' }).map(([k, x]) => [k, fill(x)]));
      const get = (v.method || 'POST') === 'GET';
      return {
        url: get ? `${v.url}${v.url.includes('?') ? '&' : '?'}${form(body)}` : v.url,
        init: { method: get ? 'GET' : 'POST', headers: { ...(get ? {} : { 'Content-Type': v.contentType === 'FORM' ? 'application/x-www-form-urlencoded' : 'application/json' }), ...lines(v.headers, ':') }, body: get ? undefined : v.contentType === 'FORM' ? form(body) : JSON.stringify(body) },
        verify: (s, b) => err(s, b, [200, 201, 202, 204]),
      };
    },
  },
  {
    info: { id: 'TWILIO', label: 'Twilio', kind: 'API', help: 'Account SID and Auth Token are on the Twilio console home page. "From" is a Twilio number (+1555…) or a Messaging Service ID (starts with MG).',
      fields: [f('accountSid', 'Account SID', { placeholder: 'AC…' }), f('authToken', 'Auth token', { secret: true }), f('from', 'From number or Messaging Service ID'), API_BASE] },
    build: (v, to, message) => ({
      url: `${base(v, 'https://api.twilio.com')}/2010-04-01/Accounts/${encodeURIComponent(v.accountSid)}/Messages.json`,
      init: { method: 'POST', headers: { Authorization: basic(v.accountSid, v.authToken), 'Content-Type': 'application/x-www-form-urlencoded' }, body: form({ To: plus(to), ...(v.from.startsWith('MG') ? { MessagingServiceSid: v.from } : { From: v.from }), Body: message }) },
      verify: (s, b) => err(s, b, [200, 201], (j) => j.message),
    }),
  },
  {
    info: { id: 'VONAGE', label: 'Vonage (SMS API)', kind: 'API', help: 'API key and secret are on the Vonage dashboard. "From" is a sender name (up to 11 letters) or a number.', fields: [f('apiKey', 'API key'), f('apiSecret', 'API secret', { secret: true }), f('from', 'Sender name or number'), API_BASE] },
    build: (v, to, message) => ({
      url: `${base(v, 'https://rest.nexmo.com')}/sms/json`,
      init: { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ api_key: v.apiKey, api_secret: v.apiSecret, to: digits(to), from: v.from, text: message }) },
      verify: (s, b) => { const e = err(s, b, [200]); if (e) return e; try { const m = JSON.parse(b).messages?.[0]; return m && m.status !== '0' ? `Vonage refused it: ${m['error-text'] ?? m.status}` : null; } catch { return 'Vonage sent something unreadable'; } },
    }),
  },
  {
    info: { id: 'MESSAGEBIRD', label: 'MessageBird / Bird', kind: 'API', help: 'A live access key from the dashboard (Developers > API access). "Sender" is a number or a name.', fields: [f('accessKey', 'Access key', { secret: true }), f('from', 'Sender'), API_BASE] },
    build: (v, to, message) => ({
      url: `${base(v, 'https://rest.messagebird.com')}/messages`,
      init: { method: 'POST', headers: { Authorization: `AccessKey ${v.accessKey}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ originator: v.from, recipients: [digits(to)], body: message }) },
      verify: (s, b) => err(s, b, [200, 201], (j) => j.errors?.[0]?.description),
    }),
  },
  {
    info: { id: 'PLIVO', label: 'Plivo', kind: 'API', help: 'Auth ID and Auth Token are on the Plivo console. "From" is a Plivo number or an approved sender ID.', fields: [f('authId', 'Auth ID'), f('authToken', 'Auth token', { secret: true }), f('from', 'From'), API_BASE] },
    build: (v, to, message) => ({
      url: `${base(v, 'https://api.plivo.com')}/v1/Account/${encodeURIComponent(v.authId)}/Message/`,
      init: { method: 'POST', headers: { Authorization: basic(v.authId, v.authToken), 'Content-Type': 'application/json' }, body: JSON.stringify({ src: v.from, dst: digits(to), text: message }) },
      verify: (s, b) => err(s, b, [200, 201, 202], (j) => j.error),
    }),
  },
  {
    info: { id: 'INFOBIP', label: 'Infobip', kind: 'API', help: 'Your personal base URL (like xxxxx.api.infobip.com) and an API key are in the Infobip portal. "Sender" is an approved sender ID.', fields: [f('baseUrl', 'Base URL', { placeholder: 'xxxxx.api.infobip.com' }), f('apiKey', 'API key', { secret: true }), f('from', 'Sender')] },
    build: (v, to, message) => ({
      url: `${/^https?:\/\//.test(v.baseUrl) ? v.baseUrl.replace(/\/+$/, '') : `https://${v.baseUrl.replace(/\/+$/, '')}`}/sms/2/text/advanced`,
      init: { method: 'POST', headers: { Authorization: `App ${v.apiKey}`, 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify({ messages: [{ from: v.from, destinations: [{ to: digits(to) }], text: message }] }) },
      verify: (s, b) => err(s, b, [200, 201], (j) => j.requestError?.serviceException?.text),
    }),
  },
  {
    info: { id: 'TELNYX', label: 'Telnyx', kind: 'API', help: 'An API key from the Telnyx portal. "From" is a Telnyx number (+1555…) with messaging enabled.', fields: [f('apiKey', 'API key', { secret: true }), f('from', 'From number'), API_BASE] },
    build: (v, to, message) => ({
      url: `${base(v, 'https://api.telnyx.com')}/v2/messages`,
      init: { method: 'POST', headers: { Authorization: `Bearer ${v.apiKey}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ from: v.from, to: plus(to), text: message }) },
      verify: (s, b) => err(s, b, [200, 201, 202], (j) => j.errors?.[0]?.detail),
    }),
  },
  {
    info: { id: 'SNS', label: 'Amazon SNS', kind: 'API', help: 'An IAM user\'s access key with permission to publish SMS (sns:Publish). New AWS accounts start in the SMS sandbox: verify the destination numbers first, or ask AWS to move you out.',
      fields: [f('region', 'AWS region', { default: 'us-east-1' }), f('accessKeyId', 'Access key ID'), f('secretAccessKey', 'Secret access key', { secret: true }), f('senderId', 'Sender name (where allowed)', { required: false }), API_BASE] },
    build: (v, to, message) => {
      const body = form({ Action: 'Publish', Version: '2010-03-31', PhoneNumber: plus(to), Message: message, ...(v.senderId ? { 'MessageAttributes.entry.1.Name': 'AWS.SNS.SMS.SenderID', 'MessageAttributes.entry.1.Value.DataType': 'String', 'MessageAttributes.entry.1.Value.StringValue': v.senderId } : {}) });
      const u = new URL(v.apiBase || `https://sns.${v.region || 'us-east-1'}.amazonaws.com/`);
      const signed = signRequest({ method: 'POST', host: u.host, path: u.pathname || '/', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body, region: v.region || 'us-east-1', service: 'sns', accessKeyId: v.accessKeyId, secretAccessKey: v.secretAccessKey });
      return { url: u.toString(), init: { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...signed }, body }, verify: (s, b) => err(s, b, [200], () => (/<Message>([^<]+)<\/Message>/.exec(b) ?? [])[1]) };
    },
  },
  {
    info: { id: 'TEXTLOCAL', label: 'Textlocal (India)', kind: 'API', help: 'An API key from the Textlocal dashboard (Settings > API Keys). "Sender" is your approved 6-letter sender ID. Indian carriers may require a registered message template.', fields: [f('apiKey', 'API key', { secret: true }), f('from', 'Sender ID (6 letters)'), API_BASE] },
    build: (v, to, message) => ({
      url: `${base(v, 'https://api.textlocal.in')}/send/`,
      init: { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: form({ apikey: v.apiKey, numbers: digits(to), message, sender: v.from }) },
      verify: (s, b) => { const e = err(s, b, [200]); if (e) return e; try { const j = JSON.parse(b); return j.status === 'success' ? null : `Textlocal refused it: ${j.errors?.[0]?.message ?? j.status}`; } catch { return 'Textlocal sent something unreadable'; } },
    }),
  },
];

// ---------------------------------------------------------------- lookups

export const emailProviders = (): ProviderInfo[] => EMAIL.map((e) => e.info);
export const smsProviders = (): ProviderInfo[] => SMS.map((s) => s.info);
export const emailProvider = (id: string) => EMAIL.find((e) => e.info.id === id);
export const smsProvider = (id: string) => SMS.find((s) => s.info.id === id);

/** Which of a provider's fields are missing from `values` (required ones only). */
export function missingFields(info: ProviderInfo, values: V): Field[] { return info.fields.filter((x) => x.required && !(String(values[x.key] ?? '').trim() || x.default)); }

/** Fill in defaults for fields left empty. */
export function withDefaults(info: ProviderInfo, values: V): V { return Object.fromEntries(info.fields.map((x) => [x.key, String(values[x.key] ?? '').trim() !== '' || x.secret || x.multiline ? String(values[x.key] ?? '') : x.default ?? ''])); }

export const emailPlanFor = (id: string, values: V): EmailPlan => {
  const p = emailProvider(id);
  if (!p) throw new Error(`Unknown email provider "${id}"`);
  return p.plan(withDefaults(p.info, values));
};
export const smsRequestFor = (id: string, values: V, to: string, message: string): SmsRequest => {
  const p = smsProvider(id);
  if (!p) throw new Error(`Unknown SMS provider "${id}"`);
  return p.build(withDefaults(p.info, values), to, message);
};
/** A short, stable fingerprint of a plan's inputs, to know when a cached connection is out of date. */
export const fingerprint = (o: unknown) => createHash('sha1').update(JSON.stringify(o)).digest('hex').slice(0, 16);

// ---------------------------------------------------------------- saved settings

type Values = Record<string, string>;

export interface Email { enabled: boolean; provider: string; from: string; values: Values }
export interface Sms { enabled: boolean; provider: string; values: Values }
export interface Settings { email: Email; sms: Sms; defaults: Record<string, string[]> }

/** Settings saved before providers existed (a host and port, a gateway address) become a provider choice, so nothing has to be entered again. */
export function normaliseSettings(raw: any): Settings {
  const e = raw.email ?? {}, m = raw.sms ?? {};
  const email: Email = e.provider ? { enabled: !!e.enabled, provider: e.provider, from: e.from ?? '', values: e.values ?? {} }
    : e.host ? { enabled: !!e.enabled, provider: 'SMTP', from: e.from ?? '', values: { host: e.host, port: String(e.port ?? 587), security: e.secure ? 'SSL' : 'AUTO', user: e.user ?? '', pass: e.pass ?? '', allowSelfSigned: e.allowSelfSigned ? 'yes' : 'no' } }
    : { enabled: false, provider: 'SMTP', from: '', values: {} };
  const sms: Sms = m.provider ? { enabled: !!m.enabled, provider: m.provider, values: m.values ?? {} }
    : m.url ? { enabled: !!m.enabled, provider: 'HTTP', values: { url: m.url, method: m.method ?? 'POST', contentType: m.contentType ?? 'JSON', headers: Object.entries(m.headers ?? {}).map(([k, v]) => `${k}: ${v}`).join('\n'), body: Object.entries(m.body ?? {}).map(([k, v]) => `${k} = ${v}`).join('\n') } }
    : { enabled: false, provider: 'HTTP', values: {} };
  return { email, sms, defaults: raw.defaults ?? {} };
}
