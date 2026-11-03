/**
 * Moving every stored secret under the current key, and showing an administrator that it is done.
 *
 * `encryptExisting` runs at start-up (and from the "re-encrypt" button): any secret saved as plain text by an older version, or encrypted under a previous key, is rewritten
 * under the current key. It is safe to run any number of times and never stops the service starting. `status` counts what is where without ever returning a secret.
 */
import { Router } from 'express';
import { raw, withTenant } from '../db.ts';
import { me, requires } from '../auth.ts';
import { audit } from '../audit.ts';
import { CONFIG_SECRET_KEYS, encrypt, isCurrent, isEncrypted, keyStatus, open } from '../secrets.ts';
import { emailProvider, normaliseSettings, smsProvider } from './providers.ts';

export const security = Router();

interface Count { total: number; current: number; oldKey: number; plain: number; unreadable: number }
const empty = (): Count => ({ total: 0, current: 0, oldKey: 0, plain: 0, unreadable: 0 });
const tally = (c: Count, v: unknown) => {
  if (typeof v !== 'string' || !v) return;
  c.total++;
  if (!isEncrypted(v)) c.plain++;
  else if (!open(v)) c.unreadable++;
  else if (isCurrent(v)) c.current++;
  else c.oldKey++;
};
const needsWork = (v: unknown) => typeof v === 'string' && !!v && !isCurrent(v) && (!isEncrypted(v) || !!open(v));     // plain or old key, and readable
const redo = (v: string) => encrypt(open(v));

const secretKeysOf = (list: { fields: { key: string; secret?: boolean }[] } | undefined) => (list?.fields ?? []).filter((f) => f.secret).map((f) => f.key);

/** The secret values held in a channel_settings row, as [side, key] pairs, given its normalised form. */
function channelSecrets(s: ReturnType<typeof normaliseSettings>) {
  return [
    ...secretKeysOf(emailProvider(s.email.provider)?.info).map((k) => ({ side: 'email' as const, key: k })),
    ...secretKeysOf(smsProvider(s.sms.provider)?.info).map((k) => ({ side: 'sms' as const, key: k })),
  ];
}

export async function encryptExisting(onlyOrg?: string): Promise<Record<string, number>> {
  const out = { channels: 0, webhooks: 0, sso: 0, connectors: 0 };
  const orgs = onlyOrg ? [{ id: onlyOrg }] : await raw<{ id: string }>('SELECT id FROM tenants');
  for (const o of orgs) {
    try {
      const [row] = await raw<any>('SELECT * FROM channel_settings WHERE org_id = $1', [o.id]);
      if (row) {
        const s = normaliseSettings({ email: row.email, sms: row.sms, defaults: row.defaults });
        let changed = false;
        for (const { side, key } of channelSecrets(s)) { const v = s[side].values[key]; if (needsWork(v)) { s[side].values[key] = redo(v); changed = true; out.channels++; } }
        const legacy = row.email?.provider === undefined && row.email?.pass && needsWork(row.email.pass);        // a row still in the old shape is converted and locked together
        if (changed || legacy) await raw('UPDATE channel_settings SET email = $2, sms = $3 WHERE org_id = $1', [o.id, JSON.stringify(s.email), JSON.stringify(s.sms)]);
      }
      for (const w of await raw<any>('SELECT id, secret FROM webhook_endpoints WHERE org_id = $1', [o.id])) if (needsWork(w.secret)) { await raw('UPDATE webhook_endpoints SET secret = $2 WHERE id = $1', [w.id, redo(w.secret)]); out.webhooks++; }
      await withTenant(o.id, async (tx) => {
        const p = await tx.one<any>('SELECT client_secret FROM sso_providers WHERE tenant_id = :t');
        if (p && needsWork(p.clientSecret)) { await tx.exec('UPDATE sso_providers SET client_secret = $1 WHERE tenant_id = :t', [redo(p.clientSecret)]); out.sso++; }
        for (const c of await tx.q<any>('SELECT id, config, webhook_secret FROM integration_connectors WHERE tenant_id = :t')) {
          const cfg = { ...(c.config ?? {}) };
          let changed = false;
          for (const k of CONFIG_SECRET_KEYS) if (needsWork(cfg[k])) { cfg[k] = redo(cfg[k]); changed = true; out.connectors++; }
          const ws = needsWork(c.webhookSecret) ? redo(c.webhookSecret) : c.webhookSecret;
          if (changed || ws !== c.webhookSecret) { await tx.exec('UPDATE integration_connectors SET config = $2, webhook_secret = $3 WHERE tenant_id = :t AND id = $1', [c.id, JSON.stringify(cfg), ws]); if (ws !== c.webhookSecret) out.connectors++; }
        }
      });
    } catch (e) { console.error('[secrets] could not re-encrypt for', o.id, (e as Error).message); }
  }
  return out;
}

async function status(orgId: string) {
  const groups: Record<string, Count> = { 'Email and SMS credentials': empty(), 'Webhook signing secrets': empty(), 'Single sign-on client secret': empty(), 'Connector credentials': empty() };
  const [row] = await raw<any>('SELECT * FROM channel_settings WHERE org_id = $1', [orgId]);
  if (row) { const s = normaliseSettings({ email: row.email, sms: row.sms, defaults: row.defaults }); for (const { side, key } of channelSecrets(s)) tally(groups['Email and SMS credentials'], s[side].values[key]); }
  for (const w of await raw<any>('SELECT secret FROM webhook_endpoints WHERE org_id = $1', [orgId])) tally(groups['Webhook signing secrets'], w.secret);
  await withTenant(orgId, async (tx) => {
    const p = await tx.one<any>('SELECT client_secret FROM sso_providers WHERE tenant_id = :t');
    if (p) tally(groups['Single sign-on client secret'], p.clientSecret);
    for (const c of await tx.q<any>('SELECT config, webhook_secret FROM integration_connectors WHERE tenant_id = :t')) { for (const k of CONFIG_SECRET_KEYS) tally(groups['Connector credentials'], c.config?.[k]); tally(groups['Connector credentials'], c.webhookSecret); }
  });
  const sum = Object.values(groups).reduce((a, g) => ({ total: a.total + g.total, current: a.current + g.current, oldKey: a.oldKey + g.oldKey, plain: a.plain + g.plain, unreadable: a.unreadable + g.unreadable }), empty());
  return { key: keyStatus(), groups, ...sum, allProtected: sum.plain === 0 && sum.oldKey === 0 && sum.unreadable === 0 };
}

security.get('/secrets', requires('users:read'), async (req, res) => { res.json(await status(me(req).tenantId)); });
security.post('/secrets/reencrypt', requires('users:write'), async (req, res) => {
  const p = me(req);
  const done = await encryptExisting(p.tenantId);
  await withTenant(p.tenantId, (tx) => audit(tx, p, req, { action: 'UPDATE', entityType: 'SECRETS', entityId: 'secrets', entityName: 'Stored secrets', diffSummary: `Re-encrypted under the current key: ${JSON.stringify(done)}` }));
  res.json({ rewritten: done, ...(await status(p.tenantId)) });
});
