/** Email and SMS providers: the boxes each one needs and the exact request each one is sent. Pure: no network, no server. */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { emailPlanFor, emailProviders, missingFields, normaliseSettings, smsProviders, smsRequestFor, withDefaults } from '../src/modules/providers.ts';

const msg = { from: 'WFM <wfm@example.com>', to: 'pat@example.com', subject: 'Hello', text: 'Body text', attachment: { name: 'a.csv', type: 'text/csv', content: 'a,b\n1,2' } };
const fillFor = (id: string, list: ReturnType<typeof emailProviders>) => Object.fromEntries(list.find((p) => p.id === id)!.fields.filter((f) => f.required).map((f) => [f.key, `v-${f.key}`]));

describe('the catalogue', () => {
  it('lists distinct providers, each with a label, help and at least one box', () => {
    for (const list of [emailProviders(), smsProviders()]) {
      assert.equal(new Set(list.map((p) => p.id)).size, list.length, 'ids are unique');
      for (const p of list) { assert.ok(p.label && p.help && p.fields.length > 0, p.id); assert.equal(new Set(p.fields.map((f) => f.key)).size, p.fields.length, `${p.id} box names are unique`); }
    }
    assert.ok(emailProviders().length >= 10 && smsProviders().length >= 8);
    assert.ok(emailProviders().some((p) => p.id === 'SMTP') && smsProviders().some((p) => p.id === 'HTTP'), 'plain SMTP and a custom web gateway are always there');
  });
  it('every secret box is marked as one, so it is never shown again', () => {
    const secrets = [...emailProviders(), ...smsProviders()].flatMap((p) => p.fields.filter((f) => f.secret).map((f) => `${p.id}.${f.key}`));
    for (const must of ['SMTP.pass', 'GMAIL.pass', 'SENDGRID.apiKey', 'RESEND.apiKey', 'TWILIO.authToken', 'VONAGE.apiSecret', 'SNS.secretAccessKey', 'HTTP.headers']) assert.ok(secrets.includes(must), `${must} should be secret`);
  });
  it('knows which required boxes are empty, counting defaults as filled', () => {
    const smtp = emailProviders().find((p) => p.id === 'SMTP')!;
    assert.deepEqual(missingFields(smtp, {}).map((f) => f.key), ['host'], 'port and encryption have defaults; user and password are optional');
    assert.deepEqual(missingFields(smtp, { host: 'mail.example.com' }), []);
    const tw = smsProviders().find((p) => p.id === 'TWILIO')!;
    assert.deepEqual(missingFields(tw, { accountSid: 'AC1' }).map((f) => f.key), ['authToken', 'from']);
    assert.equal(withDefaults(smtp, { host: 'h' }).port, '587');
  });
});

describe('email through SMTP', () => {
  const smtp = (id: string, v: Record<string, string>) => { const p = emailPlanFor(id, v); assert.ok('smtp' in p, `${id} should be SMTP`); return (p as any).smtp; };
  it('a custom server uses what was typed, and the encryption choice decides the connection', () => {
    assert.deepEqual(smtp('SMTP', { host: 'mail.example.com', port: '465', security: 'SSL', user: 'u', pass: 'p' }), { host: 'mail.example.com', port: 465, secure: true, requireTLS: false, ignoreTLS: false, auth: { user: 'u', pass: 'p' }, tlsAllowSelfSigned: false });
    assert.equal(smtp('SMTP', { host: 'h', security: 'STARTTLS' }).requireTLS, true);
    assert.equal(smtp('SMTP', { host: 'h', security: 'NONE' }).ignoreTLS, true);
    assert.equal(smtp('SMTP', { host: 'h' }).auth, undefined, 'no login when none is given');
    assert.equal(smtp('SMTP', { host: 'h', allowSelfSigned: 'yes' }).tlsAllowSelfSigned, true);
  });
  it('each preset fills in the host, port and login style of its service', () => {
    assert.deepEqual([smtp('GMAIL', { user: 'a@x.com', pass: 'app' }).host, smtp('GMAIL', { user: 'a', pass: 'p' }).port], ['smtp.gmail.com', 587]);
    assert.equal(smtp('M365', { user: 'a', pass: 'p' }).host, 'smtp.office365.com');
    assert.equal(smtp('SES', { region: 'eu-west-1', user: 'u', pass: 'p' }).host, 'email-smtp.eu-west-1.amazonaws.com');
    assert.equal(smtp('SES', { user: 'u', pass: 'p' }).host, 'email-smtp.us-east-1.amazonaws.com', 'the region default applies');
    assert.deepEqual(smtp('SENDGRID', { apiKey: 'SG.x' }).auth, { user: 'apikey', pass: 'SG.x' });
    assert.equal(smtp('MAILGUN', { region: 'EU', user: 'u', pass: 'p' }).host, 'smtp.eu.mailgun.org');
    assert.equal(smtp('MAILGUN', { region: 'US', user: 'u', pass: 'p' }).host, 'smtp.mailgun.org');
    assert.deepEqual(smtp('POSTMARK', { token: 't' }).auth, { user: 't', pass: 't' });
    assert.equal(smtp('BREVO', { user: 'u', pass: 'p' }).host, 'smtp-relay.brevo.com');
    assert.equal(smtp('MAILJET', { user: 'u', pass: 'p' }).host, 'in-v3.mailjet.com');
    assert.equal(smtp('ZOHO', { region: 'in', user: 'u', pass: 'p' }).host, 'smtp.zoho.in');
    for (const id of ['GMAIL', 'M365', 'SES', 'SENDGRID', 'MAILGUN', 'BREVO', 'POSTMARK', 'MAILJET', 'ZOHO']) assert.equal(smtp(id, fillFor(id, emailProviders())).requireTLS, true, `${id} requires encryption`);
  });
});

describe('email through a web API', () => {
  const api = (id: string, v: Record<string, string>) => { const p = emailPlanFor(id, v); assert.ok('request' in p, id); return p as Extract<typeof p, { request: unknown }>; };
  it('Resend: bearer key, JSON body, the file as base64', () => {
    const r = api('RESEND', { apiKey: 're_1' }).request(msg);
    assert.equal(r.url, 'https://api.resend.com/emails');
    assert.equal((r.init.headers as any).Authorization, 'Bearer re_1');
    const b = JSON.parse(r.init.body as string);
    assert.deepEqual([b.from, b.to, b.subject, b.text], [msg.from, ['pat@example.com'], 'Hello', 'Body text']);
    assert.equal(Buffer.from(b.attachments[0].content, 'base64').toString(), 'a,b\n1,2');
  });
  it('SendGrid and Postmark use their own field names and keys', () => {
    const sg = api('SENDGRID_API', { apiKey: 'SG.k' }).request(msg), sgb = JSON.parse(sg.init.body as string);
    assert.equal(sg.url, 'https://api.sendgrid.com/v3/mail/send');
    assert.equal(sgb.from.email, 'wfm@example.com', 'the address is taken out of "Name <address>"');
    assert.equal(sgb.personalizations[0].to[0].email, 'pat@example.com');
    const pm = api('POSTMARK_API', { token: 'tok' }).request(msg);
    assert.equal((pm.init.headers as any)['X-Postmark-Server-Token'], 'tok');
    assert.equal(JSON.parse(pm.init.body as string).TextBody, 'Body text');
  });
  it('the API address can be pointed elsewhere, such as a regional endpoint or a test server', () => {
    assert.equal(api('RESEND', { apiKey: 'k', apiBase: 'http://127.0.0.1:9999/' }).request(msg).url, 'http://127.0.0.1:9999/emails');
  });
  it('a refusal comes back as a plain reason, success as nothing', () => {
    const p = api('RESEND', { apiKey: 'k' });
    assert.equal(p.verify(200, '{}'), null);
    assert.equal(p.verify(202, '{}'), null);
    assert.match(p.verify(403, '{"message":"The domain is not verified"}')!, /403.*not verified/);
    assert.match(p.verify(500, 'plain text failure')!, /500/);
  });
});

describe('SMS providers', () => {
  const sms = (id: string, v: Record<string, string>, to = '+91 98765-43210', text = 'Your shift changed') => smsRequestFor(id, v, to, text);
  const body = (r: { init: RequestInit }) => r.init.body as string;
  it('Twilio: account in the address, basic login, form fields, + in front of the number, a service or a number as sender', () => {
    const r = sms('TWILIO', { accountSid: 'AC123', authToken: 'tok', from: '+15550001111' });
    assert.equal(r.url, 'https://api.twilio.com/2010-04-01/Accounts/AC123/Messages.json');
    assert.equal((r.init.headers as any).Authorization, `Basic ${Buffer.from('AC123:tok').toString('base64')}`);
    const f = new URLSearchParams(body(r));
    assert.deepEqual([f.get('To'), f.get('From'), f.get('Body')], ['+919876543210', '+15550001111', 'Your shift changed']);
    assert.equal(new URLSearchParams(body(sms('TWILIO', { accountSid: 'AC1', authToken: 't', from: 'MG999' }))).get('MessagingServiceSid'), 'MG999');
    assert.equal(r.verify(201, '{}'), null);
    assert.match(r.verify(401, '{"message":"Authenticate"}')!, /401.*Authenticate/);
  });
  it('Vonage: a refusal inside a 200 answer is still a refusal', () => {
    const r = sms('VONAGE', { apiKey: 'k', apiSecret: 's', from: 'WFM' });
    assert.equal(JSON.parse(body(r)).to, '919876543210', 'digits only');
    assert.equal(r.verify(200, '{"messages":[{"status":"0"}]}'), null);
    assert.match(r.verify(200, '{"messages":[{"status":"4","error-text":"Bad Credentials"}]}')!, /Bad Credentials/);
  });
  it('MessageBird, Plivo, Infobip, Telnyx and Textlocal each use their own login and field names', () => {
    const mb = sms('MESSAGEBIRD', { accessKey: 'ak', from: 'WFM' });
    assert.equal((mb.init.headers as any).Authorization, 'AccessKey ak'); assert.deepEqual(JSON.parse(body(mb)).recipients, ['919876543210']);
    const pl = sms('PLIVO', { authId: 'MA1', authToken: 't', from: '9100' });
    assert.equal(pl.url, 'https://api.plivo.com/v1/Account/MA1/Message/'); assert.deepEqual([JSON.parse(body(pl)).src, JSON.parse(body(pl)).dst], ['9100', '919876543210']);
    const ib = sms('INFOBIP', { baseUrl: 'abc123.api.infobip.com', apiKey: 'k', from: 'WFM' });
    assert.equal(ib.url, 'https://abc123.api.infobip.com/sms/2/text/advanced'); assert.equal((ib.init.headers as any).Authorization, 'App k');
    assert.equal(JSON.parse(body(ib)).messages[0].destinations[0].to, '919876543210');
    const tx = sms('TELNYX', { apiKey: 'KEY', from: '+15550001111' });
    assert.equal((tx.init.headers as any).Authorization, 'Bearer KEY'); assert.equal(JSON.parse(body(tx)).to, '+919876543210');
    const tl = sms('TEXTLOCAL', { apiKey: 'k', from: 'WFMSMS' });
    assert.equal(new URLSearchParams(body(tl)).get('numbers'), '919876543210');
    assert.equal(tl.verify(200, '{"status":"success"}'), null); assert.match(tl.verify(200, '{"status":"failure","errors":[{"message":"Invalid template"}]}')!, /Invalid template/);
  });
  it('Amazon SNS signs the request with the secret key (which is never put in it) and names the region', () => {
    const r = sms('SNS', { region: 'ap-south-1', accessKeyId: 'AKIA1', secretAccessKey: 'SECRETVALUE', senderId: 'WFM' });
    assert.equal(r.url, 'https://sns.ap-south-1.amazonaws.com/');
    const h = r.init.headers as Record<string, string>;
    assert.match(h.Authorization, /^AWS4-HMAC-SHA256 Credential=AKIA1\/\d{8}\/ap-south-1\/sns\/aws4_request, SignedHeaders=.*Signature=[0-9a-f]{64}$/);
    assert.ok(!JSON.stringify(r).includes('SECRETVALUE'));
    const f = new URLSearchParams(body(r));
    assert.deepEqual([f.get('Action'), f.get('PhoneNumber')], ['Publish', '+919876543210']);
    assert.equal(r.verify(200, '<PublishResponse/>'), null); assert.match(r.verify(403, '<Error><Message>Not authorized</Message></Error>')!, /Not authorized/);
  });
  it('a custom gateway sends what was written, with {{to}} and {{message}} filled in, in the format chosen', () => {
    const j = sms('HTTP', { url: 'https://sms.example.com/send', method: 'POST', contentType: 'JSON', headers: 'X-Key: abc\nAuthorization: Bearer t', body: 'to = {{to}}\nmessage = {{message}}\nsender = WFM' }, '+1555', 'Hi');
    assert.deepEqual(JSON.parse(body(j)), { to: '+1555', message: 'Hi', sender: 'WFM' });
    assert.equal((j.init.headers as any)['X-Key'], 'abc'); assert.equal((j.init.headers as any)['Content-Type'], 'application/json');
    const g = sms('HTTP', { url: 'https://sms.example.com/send?k=1', method: 'GET', body: 'num = {{to}}' }, '+1555', 'Hi');
    assert.equal(g.url, 'https://sms.example.com/send?k=1&num=%2B1555'); assert.equal(g.init.body, undefined);
    assert.deepEqual(JSON.parse(body(sms('HTTP', { url: 'https://x.example/s' }, '+1', 'm'))), { to: '+1', message: 'm' }, 'with nothing written, to and message are sent');
    assert.equal(new URLSearchParams(body(sms('HTTP', { url: 'https://x.example/s', contentType: 'FORM' }, '+1', 'm'))).get('message'), 'm');
  });
  it('an unknown provider is a plain error, never a crash somewhere else', () => {
    assert.throws(() => smsRequestFor('NOPE', {}, '+1', 'm'), /Unknown SMS provider/);
    assert.throws(() => emailPlanFor('NOPE', {}), /Unknown email provider/);
  });
});

describe('settings saved before providers existed', () => {
  it('become a provider choice without anyone typing anything again', () => {
    const s = normaliseSettings({ email: { enabled: true, host: 'mail.example.com', port: 465, secure: true, user: 'u', pass: 'p', from: 'wfm@example.com' }, sms: { enabled: true, url: 'https://sms.example.com/s', method: 'POST', contentType: 'JSON', headers: { 'X-Key': 'k' }, body: { to: '{{to}}', message: '{{message}}' } }, defaults: { TIME_OFF: ['SMS'] } });
    assert.deepEqual([s.email.provider, s.email.values.host, s.email.values.security, s.email.values.pass, s.email.from], ['SMTP', 'mail.example.com', 'SSL', 'p', 'wfm@example.com']);
    assert.deepEqual([s.sms.provider, s.sms.values.url, s.sms.values.headers, s.sms.values.body], ['HTTP', 'https://sms.example.com/s', 'X-Key: k', 'to = {{to}}\nmessage = {{message}}']);
    assert.deepEqual(s.defaults, { TIME_OFF: ['SMS'] });
  });
  it('an empty or new row means off, with plain SMTP and a custom gateway as the starting choices', () => {
    const s = normaliseSettings({ email: { enabled: false }, sms: { enabled: false }, defaults: {} });
    assert.deepEqual([s.email.enabled, s.email.provider, s.sms.enabled, s.sms.provider], [false, 'SMTP', false, 'HTTP']);
    assert.equal(normaliseSettings({}).email.provider, 'SMTP');
  });
  it('a row already in the new shape is left alone', () => {
    const s = normaliseSettings({ email: { enabled: true, provider: 'GMAIL', from: 'a@b.c', values: { user: 'a', pass: 'p' } }, sms: { enabled: true, provider: 'TWILIO', values: { accountSid: 'AC' } }, defaults: {} });
    assert.deepEqual([s.email.provider, s.sms.provider, s.email.values.user], ['GMAIL', 'TWILIO', 'a']);
  });
});
