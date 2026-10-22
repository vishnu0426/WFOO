import type { Request } from 'express';
import type { Tx } from './db.ts';
import type { Principal } from './auth.ts';

export type AuditAction = 'CREATE' | 'UPDATE' | 'DELETE' | 'SUBMIT' | 'APPROVE' | 'REJECT' | 'PUBLISH' | 'IMPORT' | 'EXPORT' | 'GENERATE' | 'ROLLBACK' | 'LOGIN' | 'ADJUST';

export interface AuditInput {
  action: AuditAction;
  entityType: string;
  entityId: string;
  entityName?: string;
  reason?: string;
  before?: unknown;
  after?: unknown;
  diffSummary?: string;
}

/** Append-only. Runs inside the caller's transaction, so the audit row commits or rolls back with the change it describes. */
export async function audit(tx: Tx, who: Principal, req: Request | null, a: AuditInput): Promise<void> {
  await tx.exec(
    `INSERT INTO audit_log (tenant_id, actor_id, actor_name, actor_role, action, entity_type, entity_id, entity_name, reason, before, after, diff_summary, ip_address, request_id)
     VALUES (:t, $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
    [who.userId, who.name, who.role, a.action, a.entityType, a.entityId, a.entityName ?? null, a.reason ?? null,
      a.before === undefined ? null : JSON.stringify(a.before), a.after === undefined ? null : JSON.stringify(a.after),
      a.diffSummary ?? null, req?.ip ?? null, req?.requestId ?? null]);
}
