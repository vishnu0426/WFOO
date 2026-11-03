/**
 * Redis (cache + live state), NATS (event backbone) and the Python engine (gRPC).
 * Keys and subjects are always prefixed with the tenant id.
 */
import { retryWhileBusy } from './busyWait.ts';
import { reconcile, type EngineSet } from './engineSet.ts';
import dns from 'node:dns/promises';
import { engineStats } from './metrics.ts';
import Redis from 'ioredis';
import {
  connect, AckPolicy, DeliverPolicy, RetentionPolicy, StorageType, StringCodec,
  type NatsConnection, type JetStreamClient,
} from 'nats';
import grpc from '@grpc/grpc-js';
import protoLoader from '@grpc/proto-loader';
import { config } from './config.ts';
import { currentScope } from './db.ts';

// ---------------------------------------------------------------- Redis

// Redis is a cache and a rate-limit counter, never the source of truth, so when it is down every command must fail at once (and the caller carries on) instead of
// queueing behind a connection that is not there: with the default queue a sign-in took twenty seconds. It reconnects by itself, backing off to five seconds.
export const redis = new Redis(config.redisUrl, { maxRetriesPerRequest: 1, commandTimeout: 1000, enableOfflineQueue: false, retryStrategy: (n) => Math.min(n * 500, 5000), lazyConnect: false });
redis.on('error', (e) => console.error('[redis]', e.message));

/** Tenant-prefixed key: wfm:<tenant>:a:b */
export const key = (tenantId: string, ...parts: (string | number)[]) => `wfm:${tenantId}:${parts.join(':')}`;

export async function cached<T>(k: string, ttlSec: number, load: () => Promise<T>): Promise<T> {
  try {
    const hit = await redis.get(k);
    if (hit) return JSON.parse(hit) as T;
  } catch { /* cache is best effort */ }
  const v = await load();
  try { await redis.set(k, JSON.stringify(v), 'EX', ttlSec); } catch { /* ignore */ }
  return v;
}

/** What is kept under a key, or undefined when nothing is (or the cache is down). */
export async function peekCache<T>(k: string): Promise<T | undefined> {
  try { const hit = await redis.get(k); return hit ? (JSON.parse(hit) as T) : undefined; } catch { return undefined; }
}
export async function storeCache(k: string, ttlSec: number, v: unknown): Promise<void> {
  try { await redis.set(k, JSON.stringify(v), 'EX', ttlSec); } catch { /* best effort */ }
}

export async function dropCache(tenantId: string, pattern: string): Promise<void> {
  try {
    const keys = await redis.keys(key(tenantId, pattern));
    if (keys.length) await redis.del(...keys);
  } catch { /* ignore */ }
}

// ---------------------------------------------------------------- NATS

const sc = StringCodec();
export let nc: NatsConnection | undefined;
let js: JetStreamClient | null = null;
export const jetStreamEnabled = () => js !== null;
export const natsReady = () => !!nc && !nc.isClosed();
const STREAM = 'WFM';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// The event bus can be down when the gateway starts, or go away while it runs. The gateway keeps serving either way: it connects in the background, starts the
// subscriptions it has been asked for once it is connected (and again after a full reconnect), and holds the events published in the meantime.
const starters: { name: string; start: () => Promise<void> }[] = [];
const backlog: { subject: string; data: Uint8Array }[] = [];
const MAX_BACKLOG = 5000;
let supervising = false;
let lastWarn = 0;
const warn = (msg: string) => { if (Date.now() - lastWarn > 30_000) { lastWarn = Date.now(); console.warn(msg); } };

async function runStarter(st: { name: string; start: () => Promise<void> }) {
  for (let i = 0; natsReady(); i++) {
    try { await st.start(); return; } catch (e) { warn(`[nats] ${st.name} could not start (${(e as Error).message}); trying again`); await sleep(Math.min(15_000, 2000 * (i + 1))); }
  }
}

async function setupJetStream(conn: NatsConnection) {
  try {
    const jsm = await conn.jetstreamManager();
    const cfg = { name: STREAM, subjects: ['wfm.>'], retention: RetentionPolicy.Limits, storage: StorageType.File, max_age: 7 * 24 * 3600 * 1e9 };
    try { await jsm.streams.info(STREAM); await jsm.streams.update(STREAM, cfg); } catch { await jsm.streams.add(cfg); }
    js = conn.jetstream();
    console.log('[nats] connected, JetStream stream WFM ready (wfm.>)');
  } catch (e) {
    js = null;
    console.warn(`[nats] connected WITHOUT JetStream (${(e as Error).message}). Events are live-only, not durable. Start nats-server with -js.`);
  }
}

async function superviseNats() {
  if (supervising) return;
  supervising = true;
  for (let attempt = 0; ; attempt++) {
    try {
      const conn = await connect({ servers: config.natsUrl, user: config.natsUser, pass: config.natsPass, timeout: 5000, maxReconnectAttempts: -1, reconnectTimeWait: 2000, ...(config.natsTlsRejectUnauthorized === undefined ? {} : { tls: { rejectUnauthorized: config.natsTlsRejectUnauthorized } as any }), name: 'wfm-gateway' });
      nc = conn;
      await setupJetStream(conn);
      for (const st of starters) void runStarter(st);                                            // subscriptions asked for while the bus was down
      for (const m of backlog.splice(0)) publishRaw(m.subject, m.data);                        // events held while it was down
      void conn.closed().then(() => { nc = undefined; js = null; supervising = false; console.warn('[nats] connection closed; reconnecting'); void superviseNats(); });
      return;
    } catch (e) {
      warn(`[nats] not reachable (${(e as Error).message}); the gateway keeps running and will keep trying`);
      await sleep(Math.min(30_000, 1000 * 2 ** Math.min(attempt, 5)));
    }
  }
}
/** Start connecting in the background. Returns at once: the gateway does not wait for the event bus. */
export async function connectNats(): Promise<void> { void superviseNats(); }

export const subject = (tenantId: string, ...parts: string[]) => `wfm.${tenantId}.${parts.join('.')}`;

function publishRaw(subj: string, data: Uint8Array) {
  try {
    if (js) js.publish(subj, data).catch((e) => console.error('[nats] publish', subj, e.message));
    else nc!.publish(subj, data);
  } catch (e) { console.error('[nats] publish', subj, (e as Error).message); }
}
export function publish(tenantId: string, parts: string[], payload: unknown): void {
  const s = subject(tenantId, ...parts);
  const workspaceId = currentScope()?.workspaceId;
  const body = workspaceId && payload && typeof payload === 'object' && !Array.isArray(payload) ? { ...payload, workspaceId } : payload;
  let data: Uint8Array;
  try { data = sc.encode(JSON.stringify(body)); } catch (e) { console.error('[nats] cannot encode', s, (e as Error).message); return; }
  if (!natsReady()) { if (backlog.length < MAX_BACKLOG) backlog.push({ subject: s, data }); else warn('[nats] event bus is down and the backlog is full; dropping events'); return; }
  publishRaw(s, data);
}

/** Live (non-durable) subscription, used for WebSocket fan-out. Handler gets the parsed payload and the subject tokens. */
export function subscribe(pattern: string, handler: (payload: any, tokens: string[]) => void): void {
  const start = async () => {
    const sub = nc!.subscribe(pattern);
    void (async () => {
      try { for await (const m of sub) { try { handler(JSON.parse(sc.decode(m.data)), m.subject.split('.')); } catch (e) { console.error('[nats] handler', (e as Error).message); } } } catch (e) { console.error('[nats] subscription ended', (e as Error).message); }
    })();
  };
  const st = { name: `subscription ${pattern}`, start };
  starters.push(st);
  if (natsReady()) void runStarter(st);
}

/** Durable consumer with explicit acks (JetStream) or a plain subscription when JetStream is not available. Returns at once; it starts when the bus is up. */
export async function consume(baseName: string, filter: string, handler: (payload: any, tokens: string[]) => Promise<void>, opts: { fromNow?: boolean } = {}): Promise<void> {
  // gateways of ONE deployment share a durable name (the work is shared between them); separate deployments on one NATS server set NATS_CONSUMER_PREFIX so they do not take each other's events
  const durable = process.env.NATS_CONSUMER_PREFIX ? `${process.env.NATS_CONSUMER_PREFIX}-${baseName}` : baseName;
  const start = async () => {
    if (!js) { subscribe(filter, (p, t) => { handler(p, t).catch((e) => console.error(`[${durable}]`, e.message)); }); return; }
    const jsm = await nc!.jetstreamManager();
    try { await jsm.consumers.info(STREAM, durable); }
    catch { await jsm.consumers.add(STREAM, { durable_name: durable, ack_policy: AckPolicy.Explicit, filter_subject: filter, max_deliver: 5, ...(opts.fromNow ? { deliver_policy: DeliverPolicy.New } : {}) }); }
    const consumer = await js.consumers.get(STREAM, durable);
    const messages = await consumer.consume();
    void (async () => {
      try {
        for await (const m of messages) {
          try { await handler(JSON.parse(sc.decode(m.data)), m.subject.split('.')); m.ack(); }
          catch (e) { console.error(`[${durable}]`, (e as Error).message); m.nak(5000); }
        }
      } catch (e) { console.error(`[${durable}] consumer ended`, (e as Error).message); }
    })();
  };
  const st = { name: `consumer ${durable}`, start };
  starters.push(st);
  if (natsReady()) void runStarter(st);
}

// ---------------------------------------------------------------- Engine (gRPC)

const def = protoLoader.loadSync(config.protoPath, { keepCase: true, longs: Number, defaults: true });
const wfm = (grpc.loadPackageDefinition(def) as any).wfm;
// ENGINE_ADDR may list several engines separated by commas: work goes to the least busy one, and an engine that is down is skipped.
// with ENGINE_DISCOVER and no ENGINE_ADDR the list starts empty and is filled by the lookup
const engineAddrs = process.env.ENGINE_DISCOVER && !process.env.ENGINE_ADDR ? [] : config.engineAddr.split(',').map((x) => x.trim()).filter(Boolean);
const makeClient = (addr: string) => new wfm.Engine(addr, grpc.credentials.createInsecure(), { 'grpc.max_receive_message_length': -1, 'grpc.max_send_message_length': -1 });
const clients = engineAddrs.map(makeClient);
const inFlight = clients.map(() => 0);
const downUntil = clients.map(() => 0);
const set: EngineSet = { addrs: [...engineAddrs], gone: clients.map(() => false), fixed: new Set(engineAddrs) };
const live = () => clients.map((_, i) => i).filter((i) => !set.gone[i]);
/** ENGINE_DISCOVER=host:port finds engines by looking the name up every few seconds, so engines added or removed by an autoscaler are used (or dropped) without a restart. */
export function startEngineDiscovery(): void {
  const target = process.env.ENGINE_DISCOVER;
  if (!target) return;
  const [host, port = '50051'] = target.split(':');
  const every = Number(process.env.ENGINE_DISCOVER_SEC || 10) * 1000;
  const look = async () => {
    try {
      const found = (await dns.lookup(host, { all: true, family: 4 })).map((r) => `${r.address}:${port}`);
      if (!found.length) return;                                     // an empty answer is more likely a hiccup than "every engine is gone"
      for (const a of reconcile(set, found)) { clients.push(makeClient(a)); inFlight.push(0); downUntil.push(0); console.log(`[engine] found ${a} (${live().length} in use)`); }
    } catch (e: any) { console.warn(`[engine] looking up ${host}: ${e.message}`); }
  };
  void look();
  setInterval(look, every).unref();
}
let turn = 0;
/** Engines in the order to try them: healthy and least busy first; ones that just failed last. */
const order = () => (live().length ? live() : clients.map((_, i) => i)).sort((a, b) => (downUntil[a] > Date.now() ? 1 : 0) - (downUntil[b] > Date.now() ? 1 : 0) || inFlight[a] - inFlight[b] || ((a + turn) % clients.length) - ((b + turn) % clients.length)).map((i) => (turn++, i));
const unreachable = () => Object.assign(new Error('The forecasting engine is not reachable. Start the Python engine (backend/engine).'), { status: 503, code: 'ENGINE_UNAVAILABLE' });
const busy = () => Object.assign(new Error('The engine is busy with other work. Try again in a moment.'), { status: 503, code: 'ENGINE_BUSY' });
const stopped = () => Object.assign(new Error('The engine stopped while it was working on this (it is restarting). The request can be repeated.'), { status: 503, code: 'ENGINE_CRASHED' });
const timedOut = (ms: number) => Object.assign(new Error(`The engine did not finish within ${Math.round(ms / 60000) || 1} minute(s). It may be busy with other large builds; try again or build a smaller part.`), { status: 504, code: 'ENGINE_TIMEOUT' });
/** Wait for any engine to accept connections (it may be restarting after a crash). */
const waitReady = (ms: number) => Promise.all(live().map((i) => clients[i]).map((c) => new Promise<boolean>((resolve) => c.waitForReady(Date.now() + ms, (e: Error | undefined) => resolve(!e))))).then((all) => all.some(Boolean));
/** The engine's own admission limit says this; a problem too big for the solver says something else with the same status code. */
const isBusy = (e: grpc.ServiceError) => /concurrent rpcs|ENGINE_BUSY/i.test(e.details ?? '');
const mapError = (e: grpc.ServiceError) => {
  if (e.code === grpc.status.DEADLINE_EXCEEDED) return Object.assign(new Error('The engine did not answer in time.'), { status: 504, code: 'ENGINE_TIMEOUT' });
  if (e.code === grpc.status.RESOURCE_EXHAUSTED && isBusy(e)) return busy();
  if (e.code === grpc.status.RESOURCE_EXHAUSTED) return Object.assign(new Error(e.details || 'The problem is too large for the solver.'), { status: 400, code: 'TOO_LARGE' });
  if (e.code === grpc.status.UNAVAILABLE) return unreachable();
  return e;
};

/** How long a request waits for an engine to have room before it is told the engine is busy (a build waits much longer than a quick calculation). */
const QUEUE_WAIT_MS = Number(process.env.ENGINE_QUEUE_WAIT_SEC || 30) * 1000, BUILD_QUEUE_WAIT_MS = Number(process.env.ENGINE_BUILD_QUEUE_WAIT_SEC || 300) * 1000;
const call = <Q, R>(method: string) => async (req: Q, timeoutMs = 120_000): Promise<R> => {
  const t0 = Date.now(); engineStats.calls++;
  try {
    return await retryWhileBusy(QUEUE_WAIT_MS, engineStats, async () => {
      for (let round = 0; ; round++) {
        try { return await callOnce<Q, R>(method, req, timeoutMs); }
        catch (e: any) { if (e?.code !== 'ENGINE_UNAVAILABLE' || round >= 1 || !(await waitReady(30_000))) throw e; }   // an engine that is restarting is waited for once, not failed at once
      }
    });
  } catch (e) { engineStats.errors++; throw e; } finally { engineStats.callSec += (Date.now() - t0) / 1000; }
};
const callOnce = async <Q, R>(method: string, req: Q, timeoutMs: number): Promise<R> => {
  let last: any = unreachable();
  for (const i of order()) {
    inFlight[i]++;
    try {
      return await new Promise<R>((resolve, reject) => {
        clients[i][method](req, { deadline: Date.now() + timeoutMs }, (e: grpc.ServiceError | null, r: R) => (e ? reject(e) : resolve(r)));
      });
    } catch (e: any) {
      if (e.code === grpc.status.UNAVAILABLE) { downUntil[i] = Date.now() + 15_000; last = unreachable(); continue; }   // try the next engine
      if (e.code === grpc.status.RESOURCE_EXHAUSTED && isBusy(e)) { downUntil[i] = Date.now() + 2_000; last = busy(); continue; }   // full: another engine may have room
      if (e.code === grpc.status.DEADLINE_EXCEEDED) throw timedOut(timeoutMs);
      throw mapError(e);
    } finally { inFlight[i]--; }
  }
  throw last;
};

/** Long solve with progress. `onEvent` gets every event ({chunk, chunks, note}); resolves with the final result. Aborting the signal cancels the solve inside the engine. */
const scheduleStream = async (req: any, o: { timeoutMs: number; onEvent?: (ev: any) => void; signal?: AbortSignal }): Promise<any> => {
  const t0 = Date.now(); engineStats.calls++;
  try {
    return await retryWhileBusy(BUILD_QUEUE_WAIT_MS, engineStats, async () => {
      for (let round = 0; ; round++) {
        try { return await streamOnce(req, o); }
        catch (e: any) { if (e?.code !== 'ENGINE_UNAVAILABLE' || round >= 1 || o.signal?.aborted || !(await waitReady(45_000))) throw e; }
      }
    }, o.signal);
  } catch (e) { engineStats.errors++; throw e; } finally { engineStats.callSec += (Date.now() - t0) / 1000; }
};
const streamOnce = async (req: any, o: { timeoutMs: number; onEvent?: (ev: any) => void; signal?: AbortSignal }): Promise<any> => {
  let last: any = unreachable();
  for (const i of order()) {
    inFlight[i]++;
    try {
      return await new Promise<any>((resolve, reject) => {
        const stream = clients[i].ScheduleStream(req, { deadline: Date.now() + o.timeoutMs });
        let result: any = null, started = false;
        const stop = () => stream.cancel();
        o.signal?.addEventListener('abort', stop, { once: true });
        if (o.signal?.aborted) stop();
        stream.on('data', (ev: any) => { started = true; if (ev.done) result = ev.result; else o.onEvent?.(ev); });
        stream.on('error', (e: grpc.ServiceError) => {
          o.signal?.removeEventListener('abort', stop);
          if (e.code === grpc.status.CANCELLED) return reject(Object.assign(new Error('The solve was cancelled.'), { code: 'CANCELLED' }));
          reject(Object.assign(e, { started }));
        });
        stream.on('end', () => { o.signal?.removeEventListener('abort', stop); result ? resolve(result) : reject(new Error('The engine ended the solve without an answer.')); });
      });
    } catch (e: any) {
      if (e.code === 'CANCELLED') throw e;
      if (e.code === grpc.status.UNAVAILABLE && !e.started) { downUntil[i] = Date.now() + 15_000; last = unreachable(); continue; }
      if (e.code === grpc.status.UNAVAILABLE) { downUntil[i] = Date.now() + 15_000; throw stopped(); }     // it had begun: the engine died mid-solve
      if (e.code === grpc.status.DEADLINE_EXCEEDED) throw timedOut(o.timeoutMs);
      throw mapError(e);
    } finally { inFlight[i]--; }
  }
  throw last;
};

export const engine = {
  forecastSeries: call<any, any>('ForecastSeries'),
  staffing: call<any, any>('Staffing'),
  intraday: call<any, any>('Intraday'),
  schedule: call<any, any>('Schedule'),
  simulate: call<any, any>('Simulate'),
  scheduleStream,
  /** How many engines are configured and how many answer right now. */
  get count() { return live().length || engineAddrs.length; },
  /** What each engine is doing for this process (for /metrics). */
  state: () => ({ inFlight: [...inFlight], down: downUntil.map((t, i) => t > Date.now() || set.gone[i]) }),
};

/** True when the engine answers within the timeout (used by /health). */
export const engineReady = (timeoutMs = 700): Promise<boolean> =>
  Promise.all(live().map((i) => clients[i]).map((c) => new Promise<boolean>((resolve) => c.waitForReady(Date.now() + timeoutMs, (e: Error | undefined) => resolve(!e))))).then((all) => all.some(Boolean));

export async function closeAll(): Promise<void> {
  try { await nc?.drain(); } catch { /* ignore */ }
  redis.disconnect();
  clients.forEach((c) => c.close());
}
