/** A user created outside the Users screen (single sign-on, SCIM, an employee login) joins the organisation's default workspace, so they can sign in. */
import type { Tx } from '../db.ts';

export async function joinDefaultWorkspace(tx: Tx, userId: string, employeeId: string | null, role: string): Promise<void> {
  await tx.exec(
    `INSERT INTO workspace_members (tenant_id, workspace_id, user_id, employee_id, role, is_default)
     SELECT :t, w.id, $1, $2, $3, true FROM workspaces w WHERE w.tenant_id = :t AND w.is_default AND w.status = 'ACTIVE' ON CONFLICT DO NOTHING`, [userId, employeeId, role]);
  await tx.exec('UPDATE users SET default_workspace_id = (SELECT id FROM workspaces WHERE tenant_id = :t AND is_default AND status = \'ACTIVE\' LIMIT 1) WHERE tenant_id = :t AND id = $1 AND default_workspace_id IS NULL', [userId]);
}
