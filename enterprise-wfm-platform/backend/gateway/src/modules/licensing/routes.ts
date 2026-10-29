import { Router } from 'express';
import { z } from 'zod';
import { withTenant } from '../../db.ts';
import { me, requires } from '../../auth.ts';
import { parse, bad } from '../../http.ts';
import { getTenantLicenseUsage } from './service.ts';

export const license = Router();

const CapacityRequestBody = z.object({
  resourceType: z.enum(['EMPLOYEES', 'USERS', 'SITES', 'MODULES']),
  currentCapacity: z.number().int().min(0),
  requestedCapacity: z.number().int().min(1),
  additionalNeeded: z.number().int().min(1),
  justification: z.string().max(1000).default(''),
});

license.get('/', requires('users:read'), async (req, res) => {
  const p = me(req);
  const report = await withTenant(p.tenantId, (tx) => getTenantLicenseUsage(tx, p.tenantId));
  res.json(report);
});

license.get('/requests', requires('users:read'), async (req, res) => {
  const p = me(req);
  const rows = await withTenant(p.tenantId, (tx) =>
    tx.q(
      `SELECT r.*, u.username AS requester_name, u.email AS requester_email
       FROM wfm.license_capacity_requests r
       JOIN wfm.users u ON u.id = r.requested_by_user_id
       WHERE r.tenant_id = :t
       ORDER BY r.created_at DESC`
    )
  );
  res.json(rows);
});

license.post('/requests', requires('users:write'), async (req, res) => {
  const p = me(req);
  const b = parse(CapacityRequestBody, req.body);

  const row = await withTenant(p.tenantId, async (tx) => {
    return tx.one(
      `INSERT INTO wfm.license_capacity_requests (
        tenant_id, requested_by_user_id, resource_type,
        current_capacity, requested_capacity, additional_needed, justification
      ) VALUES (:t, $1, $2, $3, $4, $5, $6)
      RETURNING *`,
      [p.userId, b.resourceType, b.currentCapacity, b.requestedCapacity, b.additionalNeeded, b.justification]
    );
  });

  res.status(201).json(row);
});
