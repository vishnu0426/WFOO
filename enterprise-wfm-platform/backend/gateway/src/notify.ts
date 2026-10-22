/**
 * Inbox and push notifications. A notification is a row in the person's inbox (what the app shows); if they have registered a device,
 * a push is sent as well so it arrives with the app closed. Push is best effort: a failure never fails the action that caused it.
 */
import type { Tx } from './db.ts';

export interface Note { kind: 'TIME_OFF' | 'SWAP' | 'SCHEDULE' | 'OFFER' | 'BID' | 'INFO'; title: string; body?: string; data?: Record<string, unknown> }

/** The login accounts that belong to these employees (people without a login simply get no notification). */
export async function usersOf(tx: Tx, employeeIds: (string | null | undefined)[]): Promise<string[]> {
  const ids = employeeIds.filter((x): x is string => !!x);
  if (!ids.length) return [];
  return (await tx.q<{ id: string }>(`SELECT id FROM users WHERE tenant_id = :t AND employee_id = ANY($1::uuid[]) AND status = 'ACTIVE'`, [ids])).map((r) => r.id);
}

export async function notify(tx: Tx, userIds: string[], n: Note): Promise<void> {
  const users = [...new Set(userIds)];
  if (!users.length) return;
  for (const u of users) await tx.exec('INSERT INTO notifications (tenant_id, user_id, kind, title, body, data) VALUES (:t, $1, $2, $3, $4, $5)', [u, n.kind, n.title, n.body ?? '', JSON.stringify(n.data ?? {})]);
  const tokens = (await tx.q<{ token: string }>('SELECT token FROM push_tokens WHERE tenant_id = :t AND user_id = ANY($1::uuid[])', [users])).map((r) => r.token);
  if (tokens.length) setImmediate(() => void sendPush(tokens, n));
}

async function sendPush(tokens: string[], n: Note): Promise<void> {
  if (process.env.PUSH_DISABLED === '1') return;
  const expo = tokens.filter((t) => t.startsWith('ExponentPushToken['));
  if (!expo.length) return;
  try {
    await fetch('https://exp.host/--/api/v2/push/send', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(expo.map((to) => ({ to, title: n.title, body: n.body ?? '', data: n.data ?? {}, sound: 'default' }))),
      signal: AbortSignal.timeout(8000),
    });
  } catch (e) { console.error('[push]', (e as Error).message); }
}
