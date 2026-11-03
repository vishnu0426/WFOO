/**
 * A person's own saved filter sets for a screen ("my night team, out of adherence"). Private to the person: nobody else sees or changes them.
 */
import { Router } from 'express';
import { z } from 'zod';
import { withTenant } from '../db.ts';
import { me } from '../auth.ts';
import { conflict, notFound, parse } from '../http.ts';

export const savedViews = Router();
const uuid = z.string().uuid();
const Screen = z.string().trim().regex(/^[a-z][a-z0-9-]{1,40}$/);
const MAX_PER_SCREEN = 30;

savedViews.get('/', async (req, res) => {
  const p = me(req), { screen } = parse(z.object({ screen: Screen }), req.query);
  res.json(await withTenant(p.tenantId, (tx) => tx.q<any>('SELECT id, name, filters FROM saved_views WHERE tenant_id = :t AND user_id = $1 AND screen = $2 ORDER BY name', [p.userId, screen])));
});

savedViews.post('/', async (req, res) => {
  const p = me(req);
  const b = parse(z.object({ screen: Screen, name: z.string().trim().min(1).max(60), filters: z.record(z.string(), z.unknown()).refine((f) => JSON.stringify(f).length < 4000, 'That view is too big to save') }), req.body);
  const out = await withTenant(p.tenantId, async (tx) => {
    const n = (await tx.one<{ n: number }>('SELECT count(*)::int AS n FROM saved_views WHERE tenant_id = :t AND user_id = $1 AND screen = $2 AND name <> $3', [p.userId, b.screen, b.name]))!.n;
    if (n >= MAX_PER_SCREEN) throw conflict(`You can keep ${MAX_PER_SCREEN} saved views for a screen. Delete one first.`);
    // saving under a name you already use replaces that view
    return tx.one<any>(
      `INSERT INTO saved_views (tenant_id, user_id, screen, name, filters) VALUES (:t, $1, $2, $3, $4::jsonb)
       ON CONFLICT (user_id, screen, name) DO UPDATE SET filters = EXCLUDED.filters RETURNING id, name, filters`, [p.userId, b.screen, b.name, JSON.stringify(b.filters)]);
  });
  res.status(201).json(out);
});

savedViews.delete('/:id', async (req, res) => {
  const p = me(req), id = parse(uuid, req.params.id);
  const n = await withTenant(p.tenantId, (tx) => tx.exec('DELETE FROM saved_views WHERE tenant_id = :t AND user_id = $1 AND id = $2', [p.userId, id]));
  if (!n) throw notFound('Saved view');
  res.json({ ok: true });
});
