/**
 * WebSocket fan-out: NATS events for a tenant are pushed to that tenant's signed-in browsers.
 * High-volume subjects (ingest, agent state) are not forwarded raw; the workers publish summaries instead.
 */
import type http from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import { principalFromToken } from './auth.ts';
import { subscribe } from './infra.ts';

const NOISY = new Set(['ingest', 'state']);

export function attachWebSocket(server: http.Server): void {
  const wss = new WebSocketServer({ server, path: '/ws' });
  const byTenant = new Map<string, Set<WebSocket>>();

  wss.on('connection', async (ws, req) => {
    try {
      const token = new URL(req.url ?? '', 'http://x').searchParams.get('token') ?? '';
      const p = await principalFromToken(token);
      if (p.mustChangePassword) throw new Error('password change required');
      const set = byTenant.get(p.tenantId) ?? new Set();
      set.add(ws); byTenant.set(p.tenantId, set);
      ws.on('close', () => set.delete(ws));
      ws.send(JSON.stringify({ subject: 'hello', payload: { tenantId: p.tenantId } }));
    } catch { ws.close(4401, 'unauthorized'); }
  });

  // wfm.<tenant>.<domain>.<event...>
  subscribe('wfm.>', (payload, tokens) => {
    const [, tenantId, domain, ...rest] = tokens;
    if (!tenantId || !domain || NOISY.has(domain)) return;
    const msg = JSON.stringify({ subject: `${domain}.${rest.join('.')}`, payload });
    byTenant.get(tenantId)?.forEach((c) => c.readyState === 1 && c.send(msg));
  });
}
