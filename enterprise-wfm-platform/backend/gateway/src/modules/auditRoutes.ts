import { Router } from 'express';
import { z } from 'zod';
import { withTenant } from '../db.ts';
import { me, requires } from '../auth.ts';
import { audit } from '../audit.ts';
import { isoDay, parse } from '../http.ts';

export const auditRoutes = Router();

const Filters = z.object({
  entityType: z.string().optional(), entityId: z.string().optional(), action: z.string().optional(), actor: z.string().optional(), q: z.string().trim().optional(),
  from: z.string().regex(isoDay).optional(), to: z.string().regex(isoDay).optional(),
});
const WHERE = `tenant_id = :t AND ($1::text IS NULL OR entity_type = $1) AND ($2::text IS NULL OR entity_id = $2) AND ($3::text IS NULL OR action = $3)
  AND ($4::text IS NULL OR actor_name ILIKE '%' || $4 || '%') AND ($5::date IS NULL OR at >= $5::date) AND ($6::date IS NULL OR at < $6::date + 1)
  AND ($7::text IS NULL OR concat_ws(' ', actor_name, action, entity_type, entity_name, reason, diff_summary) ILIKE '%' || $7 || '%')`;
const args = (f: z.infer<typeof Filters>) => [f.entityType ?? null, f.entityId ?? null, f.action ?? null, f.actor ?? null, f.from ?? null, f.to ?? null, f.q || null];
const COLS = 'id, tenant_id, at, actor_id, actor_name, actor_role, action, entity_type, entity_id, entity_name, reason, before, after, diff_summary, source, ip_address, request_id';
const dto = (r: any) => ({
  id: String(r.id), tenantId: r.tenantId, actorId: r.actorId, actorName: r.actorName, actorRole: r.actorRole, action: r.action, entityType: r.entityType, entityId: r.entityId,
  entityName: r.entityName, timestamp: r.at, source: r.source, reason: r.reason, beforeSnapshot: r.before, afterSnapshot: r.after, diffSummary: r.diffSummary, ipAddress: r.ipAddress, requestId: r.requestId,
});

/** Append-only ledger, newest first. */
auditRoutes.get('/audit', requires('audit:read'), async (req, res) => {
  const q = parse(Filters.extend({ limit: z.coerce.number().int().min(1).max(500).default(100), before: z.coerce.number().int().optional() }), req.query);
  const rows = await withTenant(me(req).tenantId, (tx) => tx.q<any>(
    `SELECT ${COLS} FROM audit_log WHERE ${WHERE} AND ($8::bigint IS NULL OR id < $8) ORDER BY id DESC LIMIT $9`, [...args(q), q.before ?? null, q.limit]));
  res.json(rows.map(dto));
});

/** Counts for the summary strip and the filter drop-downs. */
auditRoutes.get('/audit/summary', requires('audit:read'), async (req, res) => {
  const f = parse(Filters, req.query);
  const out = await withTenant(me(req).tenantId, async (tx) => {
    const total = (await tx.one<{ n: number }>(`SELECT count(*)::int AS n FROM audit_log WHERE ${WHERE}`, args(f)))!.n;
    const last24 = (await tx.one<{ n: number }>(`SELECT count(*)::int AS n FROM audit_log WHERE tenant_id = :t AND at > now() - interval '24 hours'`))!.n;
    const actors = (await tx.one<{ n: number }>(`SELECT count(DISTINCT actor_name)::int AS n FROM audit_log WHERE ${WHERE}`, args(f)))!.n;
    const entityTypes = await tx.q<any>('SELECT entity_type, count(*)::int AS n FROM audit_log WHERE tenant_id = :t GROUP BY entity_type ORDER BY n DESC');
    const actions = await tx.q<any>('SELECT action, count(*)::int AS n FROM audit_log WHERE tenant_id = :t GROUP BY action ORDER BY n DESC');
    const actorNames = await tx.q<any>('SELECT actor_name, count(*)::int AS n FROM audit_log WHERE tenant_id = :t GROUP BY actor_name ORDER BY n DESC LIMIT 50');
    return { total, last24h: last24, actors, entityTypes: entityTypes.map((r) => ({ value: r.entityType, count: r.n })), actions: actions.map((r) => ({ value: r.action, count: r.n })), actorNames: actorNames.map((r) => ({ value: r.actorName, count: r.n })) };
  });
  res.json(out);
});

const csvCell = (v: unknown) => { const s = v == null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v); return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };

/** Compliance export of the filtered ledger (up to 20,000 rows). Exporting is itself recorded. */
auditRoutes.get('/audit/export.csv', requires('audit:read'), async (req, res) => {
  const p = me(req), f = parse(Filters, req.query);
  const rows = await withTenant(p.tenantId, async (tx) => {
    const r = await tx.q<any>(`SELECT ${COLS} FROM audit_log WHERE ${WHERE} ORDER BY id DESC LIMIT 20000`, args(f));
    await audit(tx, p, req, { action: 'EXPORT', entityType: 'AUDIT_LOG', entityId: 'audit', entityName: 'Audit ledger', diffSummary: `${r.length} rows exported` });
    return r;
  });
  const head = ['id', 'time_utc', 'actor', 'role', 'action', 'entity_type', 'entity_id', 'entity_name', 'reason', 'summary', 'source', 'ip_address', 'request_id'];
  const lines = [head.join(','), ...rows.map((r) => [r.id, new Date(r.at).toISOString(), r.actorName, r.actorRole, r.action, r.entityType, r.entityId, r.entityName, r.reason, r.diffSummary, r.source, r.ipAddress, r.requestId].map(csvCell).join(','))];
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="audit-log.csv"');
  res.send(lines.join('\n') + '\n');
});
