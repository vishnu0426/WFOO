import http from 'node:http';
import { randomUUID } from 'node:crypto';
import express, { Router } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { config } from './config.ts';
import { isRlsEnforced, migrate, pool } from './db.ts';
import { bootstrapIfEmpty } from './bootstrap.ts';
import { closeAll, connectNats, consume, engineReady, jetStreamEnabled, nc, redis } from './infra.ts';
import { authenticate } from './auth.ts';
import { HttpError, errorHandler } from './http.ts';
import { authed, publicAuth } from './modules/authRoutes.ts';
import { config as configRoutes } from './modules/configRoutes.ts';
import { policy as policyRoutes } from './modules/policyRoutes.ts';
import { compliance as complianceRoutes } from './modules/compliance/routes.ts';
import { selfService as selfServiceRoutes, selfAdmin as selfAdminRoutes } from './modules/selfService.ts';
import { swapsMe, swapsAdmin } from './modules/swaps.ts';
import { poolingRoutes, rollupRoutes, sitesRoutes } from './modules/sites.ts';
import { bidsAdmin, bidsMe, startBidTicker } from './modules/bids/routes.ts';
import { offersAdmin, offersMe, offerPolicyRoutes, startOfferTicker } from './modules/offers/routes.ts';
import { intraday } from './modules/intradayRoutes.ts';
import { rotations } from './modules/rotations.ts';
import { attendance } from './modules/attendance.ts';
import { integrationsAdmin, integrationsPublic } from './modules/integrations/routes.ts';
import { startAllSubscriptions, stopAllSubscriptions } from './modules/integrations/natsSubscriber.ts';
import { ingestion, ingestLive, LiveRows } from './modules/ingestionRoutes.ts';
import { workforce } from './modules/workforceRoutes.ts';
import { scheduling } from './modules/scheduleRoutes.ts';
import { forecast } from './modules/forecast/routes.ts';
import { startLearningTicker } from './modules/forecast/learning.ts';
import { auditRoutes } from './modules/auditRoutes.ts';
import { attachWebSocket } from './ws.ts';

await migrate();
await bootstrapIfEmpty();
await connectNats();
startAllSubscriptions().catch((e) => console.error('[integrations] startAllSubscriptions', e.message));

const app = express();
app.disable('x-powered-by');
app.use(helmet());
app.use(cors({ origin: config.corsOrigin }));
app.use(express.json({ limit: '14mb' }));   // CSV imports are posted as text (up to 10MB)
app.use((req, res, next) => {
  req.requestId = String(req.headers['x-request-id'] || randomUUID());
  res.setHeader('X-Request-Id', req.requestId);
  const t = Date.now();
  res.on('finish', () => { if (req.path !== '/health') console.log(`${req.method} ${req.originalUrl.split('?')[0]} ${res.statusCode} ${Date.now() - t}ms ${req.principal?.username ?? '-'}`); });
  next();
});

app.get('/health', async (_req, res) => {
  const check = async (f: () => Promise<unknown>) => { try { await f(); return true; } catch { return false; } };
  const [db, cache, engine] = await Promise.all([check(() => pool.query('SELECT 1')), check(() => redis.ping()), engineReady()]);
  const nats = !nc.isClosed();
  res.status(db && cache && nats ? 200 : 503).json({ status: db && cache && nats ? (engine ? 'ok' : 'degraded') : 'down', db, redis: cache, nats, jetstream: jetStreamEnabled(), engine, rowLevelSecurity: isRlsEnforced() });
});

const api = Router();
api.use(publicAuth);                       // sign-in is the only unauthenticated route
api.use('/integrations', integrationsPublic); // connector-key/webhook-signed ingest: a relay script or a vendor webhook, no user session
api.use(authenticate);
api.use(authed);                           // me, logout, users, RBAC matrix
api.use('/config', configRoutes);          // WFM groups, queues
api.use('/config', sitesRoutes);            // sites, required skills per group, the pool they define
api.use('/config', policyRoutes);          // activity definitions, scheduling policy
api.use('/compliance', complianceRoutes);   // labour-law packs and where they apply
api.use('/me/bids', bidsMe);                 // shift bidding, the person's side
api.use('/me/offers', offersMe);             // voluntary time off and overtime offers, the person's side
api.use('/me/swaps', swapsMe);               // shift swaps and the giveaway board, the person's side
api.use('/me', selfServiceRoutes);           // the signed-in person's own schedule, requests and inbox
api.use('/self-service/offer-policy', offerPolicyRoutes);   // how offers are ordered
api.use('/self-service', selfAdminRoutes);  // rules for what can be approved automatically, and logins for employees
api.use('/data', ingestion);               // staged imports, coverage, quality, live feed
api.use('/forecast/pooling', poolingRoutes); // shared pool against separate pools
api.use('/forecast', forecast);            // versions, leaderboard, adjustments, lifecycle, scenarios, accuracy, capacity
api.use('/workforce', workforce);          // employees, teams, skills, availability, time off
api.use('/intraday', intraday);            // RTA state map + events, adherence, live coverage
api.use('/scheduling/rollup', rollupRoutes); // every published schedule side by side, by site
api.use('/scheduling/bids', bidsAdmin);     // bid rounds, allocation and awarding
api.use('/scheduling/offers', offersAdmin); // open and manage offers
api.use('/scheduling/swaps', swapsAdmin);   // swap requests waiting for a manager
api.use('/scheduling/rotations', rotations); // rotating rosters (4-on-4-off, DuPont...), materialized into real shifts
api.use('/scheduling', scheduling);        // shift templates, schedule versions (CP-SAT), coverage, publish, compare
api.use('/attendance', attendance);        // time punches and the payroll export
api.use('/integrations', integrationsAdmin); // connector CRUD, mapping, entity matching (the ingest half is mounted above, before auth)
api.use(auditRoutes);                      // audit ledger
app.use('/api/v1', api);
app.use((_req, _res, next) => next(new HttpError(404, 'NOT_FOUND', 'No such endpoint')));
app.use(errorHandler);

const server = http.createServer(app);
attachWebSocket(server);

// live interval feed over NATS: publish {rows:[...]} to wfm.<tenant>.ingest.interval
await consume('ingest-worker', 'wfm.*.ingest.interval', async (payload, tokens) => {
  const tenantId = tokens[1];
  const parsed = LiveRows.safeParse(Array.isArray(payload) ? { rows: payload } : payload.rows ? payload : { rows: [payload] });
  if (!parsed.success) throw new Error(`ingest payload rejected: ${parsed.error.issues[0]?.message}`);
  await ingestLive(tenantId, parsed.data.rows);
});

server.listen(config.port, () => { console.log(`[gateway] http://localhost:${config.port}  (health: /health, api: /api/v1)`); startOfferTicker(); startBidTicker(); startLearningTicker(); });

const shutdown = async () => { console.log('[gateway] shutting down'); server.close(); await stopAllSubscriptions(); await closeAll(); await pool.end(); process.exit(0); };
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
