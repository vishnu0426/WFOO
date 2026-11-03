import { metricsText, requestFinished, requestStarted, sizing } from './metrics.ts';
import { autosizeDatabasePool } from './autosize.ts';
import v8 from 'node:v8';
import os from 'node:os';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import express, { Router } from 'express';
import compression from 'compression';
import cors from 'cors';
import helmet from 'helmet';
import { config } from './config.ts';
import { isRlsEnforced, migrate, pool, withStartupLock } from './db.ts';
import { bootstrapIfEmpty } from './bootstrap.ts';
import { closeAll, connectNats, consume, engine, engineReady, startEngineDiscovery, jetStreamEnabled, natsReady, redis } from './infra.ts';
import { authenticate } from './auth.ts';
import { HttpError, errorHandler } from './http.ts';
import { authed, publicAuth } from './modules/authRoutes.ts';
import { platform as platformRoutes } from './modules/platform/routes.ts';
import { organization as organizationRoutes, workspaces as workspaceRoutes } from './modules/workspaceRoutes.ts';
import { config as configRoutes } from './modules/configRoutes.ts';
import { groupAdmin } from './modules/groupAdminRoutes.ts';
import { policy as policyRoutes } from './modules/policyRoutes.ts';
import { compliance as complianceRoutes } from './modules/compliance/routes.ts';
import { selfService as selfServiceRoutes, selfAdmin as selfAdminRoutes } from './modules/selfService.ts';
import { swapsMe, swapsAdmin } from './modules/swaps.ts';
import { poolingRoutes, rollupRoutes, sitesRoutes } from './modules/sites.ts';
import { bidsAdmin, bidsMe, startBidTicker } from './modules/bids/routes.ts';
import { offersAdmin, offersMe, offerPolicyRoutes, startOfferTicker } from './modules/offers/routes.ts';
import { intraday } from './modules/intradayRoutes.ts';
import './modules/intradayGapRoutes.ts';   // adds the gap-fix routes to the intraday router
import { rotations } from './modules/rotations.ts';
import { attendance } from './modules/attendance.ts';
import { integrationsAdmin, integrationsPublic } from './modules/integrations/routes.ts';
import { startAllSubscriptions, stopAllSubscriptions } from './modules/integrations/natsSubscriber.ts';
import { ingestion, ingestLive, LiveRows, recordFeedRejection } from './modules/ingestionRoutes.ts';
import { startConnectorScheduler, stopConnectorScheduler } from './modules/integrations/runner.ts';
import './modules/adherenceRoutes.ts';        // adds the paged adherence routes to the intraday router
import { startAdherenceWatch, stopAdherenceWatch } from './modules/adherenceWatch.ts';
import { savedViews } from './modules/savedViews.ts';
import { workforce } from './modules/workforceRoutes.ts';
import { approvalRoutes, startApprovalTicker } from './modules/approvals.ts';
import { orgChart } from './modules/orgChart.ts';
import { scheduling, invalidateLive } from './modules/scheduleRoutes.ts';
import { planRoutes, startScheduleWorker, stopScheduleWorker } from './modules/scheduleJobs.ts';
import { developer, startWebhooks, stopWebhooks } from './modules/developer.ts';
import { ssoPublic, ssoAdmin } from './modules/sso.ts';
import { scim } from './modules/scim.ts';
import { payroll } from './modules/payroll.ts';
import { encryptExisting, security } from './modules/secretsAdmin.ts';
import { followTheSun } from './modules/followTheSun.ts';
import { channels, startChannelSender, stopChannelSender } from './modules/channels.ts';
import { reports, startReportTimer, stopReportTimer } from './modules/reports.ts';
import { forecast } from './modules/forecast/routes.ts';
import { startLearningTicker } from './modules/forecast/learning.ts';
import { auditRoutes } from './modules/auditRoutes.ts';
import { license as licenseRoutes } from './modules/licensing/routes.ts';
import { attachWebSocket } from './ws.ts';

// Nothing in this process is allowed to take the whole service down. A failed background task is logged and the service carries on; a storm of uncaught
// errors (the process is in a bad state) ends it so the supervisor (docker's restart policy, systemd) starts it clean.
const recent: number[] = [];
const noteFault = (kind: string, e: unknown) => {
  console.error(`[process] ${kind}:`, e instanceof Error ? e.stack ?? e.message : e);
  const now = Date.now(); recent.push(now); while (recent.length && now - recent[0] > 60_000) recent.shift();
  if (recent.length > 25) { console.error('[process] too many unexpected errors in a minute; restarting cleanly'); process.exit(1); }
};
process.on('unhandledRejection', (e) => noteFault('unhandled rejection', e));
process.on('uncaughtException', (e) => noteFault('uncaught exception', e));

/** Wait for something the service cannot work without (the database) instead of dying when it is not up yet. Only connection problems are retried; a real error (a bad migration) still stops start-up. */
const CONNECTION = /ECONNREFUSED|ENOTFOUND|ETIMEDOUT|ECONNRESET|EAI_AGAIN|57P03|08001|08006|the database system is (starting|shutting)/i;
async function untilReady<T>(what: string, fn: () => Promise<T>): Promise<T> {
  for (let i = 0; ; i++) {
    try { return await fn(); } catch (e: any) {
      if (!CONNECTION.test(`${e?.code ?? ''} ${e?.message ?? ''}`)) throw e;
      if (i % 5 === 0) console.error(`[startup] ${what} is not reachable (${e.message}); waiting for it`);
      await new Promise((r) => setTimeout(r, Math.min(10_000, 1000 * (i + 1))));
    }
  }
}
await untilReady('the database', () => migrate());
await autosizeDatabasePool(pool, config.dbPoolExplicit);
{
  // Node cannot change its heap limit once running (docker/gateway-entry.sh sets it before start); say plainly when it is small for the job
  const heapMb = Math.round(v8.getHeapStatistics().heap_size_limit / 1048576), ramMb = Math.round(os.totalmem() / 1048576);
  sizing.heap_limit_mb = heapMb; sizing.machine_memory_mb = ramMb; sizing.engines = engine.count;
  if (config.role !== 'web' && heapMb < 3000 && ramMb > 8000) console.warn(`[autosize] this process may use ${heapMb} MB of heap on a machine with ${ramMb} MB; builds for tens of thousands of people need more. Start it with NODE_OPTIONS=--max-old-space-size=${Math.round(ramMb * 0.6)}`);
}
await untilReady('the database', () => withStartupLock(() => bootstrapIfEmpty()));
// secrets saved as plain text by an older version, or under a previous key, are moved under the current key; this never stops start-up
encryptExisting().then((n) => { const t = Object.values(n).reduce((a, b) => a + b, 0); if (t) console.log(`[secrets] encrypted ${t} stored secret${t === 1 ? '' : 's'} under the current key`, n); }).catch((e) => console.error('[secrets]', e.message));
startEngineDiscovery();
await connectNats();             // in the background: the gateway starts serving whether or not the event bus is up
startAllSubscriptions().catch((e) => console.error('[integrations] startAllSubscriptions', e.message));

const app = express();
app.disable('x-powered-by');
app.use(helmet());
// anything changed through the API makes the short-lived schedule calculations out of date: clear them, so a read after a change always sees the change
app.use((req, res, next) => { if (req.method !== 'GET' && req.method !== 'HEAD' && req.method !== 'OPTIONS') res.on('finish', () => { if (res.statusCode < 400) invalidateLive(); }); next(); });
app.use(compression());                    // a 6,000-person schedule is ~15 MB of JSON; it crosses the wire at a tenth of that
app.use(cors({ origin: config.corsOrigin, exposedHeaders: ['X-Total-Count', 'X-Page-Limit'] }));       // a browser on another origin can only read a header listed here
app.use(express.json({ limit: '14mb' }));   // CSV imports are posted as text (up to 10MB)
app.use((req, res, next) => {
  req.requestId = String(req.headers['x-request-id'] || randomUUID());
  res.setHeader('X-Request-Id', req.requestId);
  const t = Date.now();
  requestStarted();
  res.on('close', () => requestFinished(res.statusCode, Date.now() - t));
  res.on('finish', () => { if (req.path !== '/health') console.log(`${req.method} ${req.originalUrl.split('?')[0]} ${res.statusCode} ${Date.now() - t}ms ${req.principal?.username ?? '-'}`); });
  next();
});

/** Prometheus metrics. With METRICS_TOKEN set it needs `Authorization: Bearer <token>`; without one it answers only callers on this machine or a private network (and the web proxy does not publish it). */
const privateAddress = (a = '') => /^(::1|127\.|::ffff:127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|::ffff:10\.|::ffff:192\.168\.|::ffff:172\.(1[6-9]|2\d|3[01])\.|fc|fd)/i.test(a);
app.get('/metrics', async (req, res) => {
  const token = process.env.METRICS_TOKEN;
  if (token ? req.headers.authorization !== `Bearer ${token}` : !privateAddress(req.socket.remoteAddress)) return void res.status(token ? 401 : 403).end();
  res.type('text/plain; version=0.0.4').send(await metricsText({ pool, role: config.role, engines: engine.state }));
});

app.get('/health', async (_req, res) => {
  const check = async (f: () => Promise<unknown>) => { try { await f(); return true; } catch { return false; } };
  const [db, cache, engine] = await Promise.all([check(() => pool.query('SELECT 1')), check(() => redis.ping()), engineReady()]);
  const nats = natsReady();
  // down = it cannot do its job (no database); degraded = it works but something it uses is missing (cache, event bus, engine)
  res.status(db ? 200 : 503).json({ status: !db ? 'down' : db && cache && nats && engine ? 'ok' : 'degraded', db, redis: cache, nats, jetstream: jetStreamEnabled(), engine, rowLevelSecurity: isRlsEnforced() });
});

const api = Router();
// Every API answer carries an ETag, so a browser can ask "has this changed?" and get a one-line "no" instead of the whole body. `no-cache` means exactly that: keep a copy, but
// check with us before using it (never serve data that was edited a moment ago from the browser's own cache). Lists the code itself defines override this below.
api.use((req, res, next) => { if (req.method === 'GET' || req.method === 'HEAD') res.setHeader('Cache-Control', 'private, no-cache'); next(); });
api.use('/platform', platformRoutes);          // platform / super admin routes (own authentication)
api.use(publicAuth);                       // sign-in is the only unauthenticated route
api.use('/auth/sso', ssoPublic);            // sign in through the organisation's identity provider
api.use('/integrations', integrationsPublic); // connector-key/webhook-signed ingest: a relay script or a vendor webhook, no user session
api.use(authenticate);
api.use(authed);                           // me, logout, users, RBAC matrix
api.use('/config', groupAdmin);            // group summary, impact, members, history, clone, file import (before the plain routes: /groups/summary is not an id)
api.use('/license', licenseRoutes);        // licensing, subscription, and capacity governance
api.use('/organization', organizationRoutes); // organisation profile
api.use('/workspaces', workspaceRoutes);   // workspaces and their members
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
api.use('/workforce', approvalRoutes);       // cover while a supervisor is away
api.use('/workforce', orgChart);             // reporting lines as a chart
api.use('/workforce', workforce);          // employees, teams, skills, availability, time off
api.use('/intraday', intraday);            // RTA state map + events, adherence, live coverage
api.use('/views', savedViews);             // a person's own saved filter sets
api.use('/scheduling/rollup', rollupRoutes); // every published schedule side by side, by site
api.use('/scheduling/bids', bidsAdmin);     // bid rounds, allocation and awarding
api.use('/scheduling/offers', offersAdmin); // open and manage offers
api.use('/scheduling/swaps', swapsAdmin);   // swap requests waiting for a manager
api.use('/scheduling/rotations', rotations); // rotating rosters (4-on-4-off, DuPont...), materialized into real shifts
api.use('/sso', ssoAdmin);                 // single sign-on settings
api.use('/developer', developer);         // API keys and webhooks
api.use('/scheduling/follow-the-sun', followTheSun); // several sites on one clock
api.use('/scheduling', planRoutes);        // long plans: background jobs, windowed publish, year view, rotation lines
api.use('/scheduling', scheduling);        // shift templates, schedule versions (CP-SAT), coverage, publish, compare
api.use('/channels', channels);            // email and SMS: settings, alert rules, what each person receives
api.use('/reports', reports);              // reports to run now or on a timetable, sent by email
api.use('/security', security);          // proof that stored secrets are encrypted, and re-encryption under a new key
api.use('/payroll', payroll);              // pay periods turned into pay codes, approved and exported
api.use('/attendance', attendance);        // time punches and the payroll export
api.use('/integrations', integrationsAdmin); // connector CRUD, mapping, entity matching (the ingest half is mounted above, before auth)
api.use(auditRoutes);                      // audit ledger
app.use('/scim/v2', scim);                // user provisioning from an identity provider (own token, not a session)
app.use('/api/v1', api);
app.use((_req, _res, next) => next(new HttpError(404, 'NOT_FOUND', 'No such endpoint')));
app.use(errorHandler);

const server = http.createServer(app);
attachWebSocket(server);

// live interval feed over NATS: publish {rows:[...]} to wfm.<tenant>.ingest.interval
await consume('ingest-worker', 'wfm.*.ingest.interval', async (payload, tokens) => {
  const tenantId = tokens[1];
  const parsed = LiveRows.safeParse(Array.isArray(payload) ? { rows: payload } : payload.rows ? payload : { rows: [payload] });
  if (!parsed.success) {
    const msg = `${parsed.error.issues[0]?.path.join('.') || 'message'}: ${parsed.error.issues[0]?.message}`;
    await recordFeedRejection(tenantId, 'NATS', msg).catch(() => {});
    throw new Error(`ingest payload rejected: ${msg}`);
  }
  await ingestLive(tenantId, parsed.data.rows, { source: 'NATS' });
});

server.listen(config.port, () => { console.log(`[gateway] http://localhost:${config.port}  (health: /health, api: /api/v1)`); if (config.role === 'web') { console.log('[gateway] role web: background jobs run in the jobs process'); return; } startOfferTicker(); startApprovalTicker(); startBidTicker(); startLearningTicker(); startScheduleWorker(); startWebhooks().catch((e) => console.error('[webhooks]', e.message)); startChannelSender(); startReportTimer(); startConnectorScheduler(); startAdherenceWatch(); });

let stopping = false;
const shutdown = async (why = 'shutdown') => { if (stopping) return; stopping = true; console.log(`[gateway] shutting down (${why})`); setTimeout(() => { console.error('[gateway] shutdown took over 15 s; exiting'); process.exit(1); }, 15000).unref(); stopScheduleWorker(); stopWebhooks(); stopChannelSender(); stopReportTimer(); stopConnectorScheduler(); stopAdherenceWatch(); server.close(); await stopAllSubscriptions(); await closeAll(); await pool.end(); process.exit(0); };
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK'] as const) process.on(sig, () => { void shutdown(sig); });   // SIGHUP / SIGBREAK: a closed terminal window or Ctrl+Break on Windows
// Whatever ends the process leaves one line saying so, with the memory it held. A kill the system does not announce (out of memory, End Task) cannot be logged,
// but the missing "exited" line next to a high heap figure in the line above points at it.
process.on('exit', (code) => console.log(`[gateway] exited with code ${code} (heap ${Math.round(process.memoryUsage().heapUsed / 1048576)} MB, rss ${Math.round(process.memoryUsage().rss / 1048576)} MB)`));
setInterval(() => { const m = process.memoryUsage(); if (m.rss > 1.5 * 1024 ** 3) console.warn(`[gateway] memory is high: rss ${Math.round(m.rss / 1048576)} MB, heap ${Math.round(m.heapUsed / 1048576)} MB`); }, 60000).unref();
