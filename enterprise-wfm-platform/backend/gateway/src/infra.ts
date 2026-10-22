/**
 * Redis (cache + live state), NATS (event backbone) and the Python engine (gRPC).
 * Keys and subjects are always prefixed with the tenant id.
 */
import Redis from 'ioredis';
import {
  connect, AckPolicy, RetentionPolicy, StorageType, StringCodec,
  type NatsConnection, type JetStreamClient,
} from 'nats';
import grpc from '@grpc/grpc-js';
import protoLoader from '@grpc/proto-loader';
import { config } from './config.ts';

// ---------------------------------------------------------------- Redis

export const redis = new Redis(config.redisUrl, { maxRetriesPerRequest: 2, lazyConnect: false });
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

export async function dropCache(tenantId: string, pattern: string): Promise<void> {
  try {
    const keys = await redis.keys(key(tenantId, pattern));
    if (keys.length) await redis.del(...keys);
  } catch { /* ignore */ }
}

// ---------------------------------------------------------------- NATS

const sc = StringCodec();
export let nc: NatsConnection;
let js: JetStreamClient | null = null;
export const jetStreamEnabled = () => js !== null;
const STREAM = 'WFM';

export async function connectNats(): Promise<void> {
  nc = await connect({ servers: config.natsUrl, name: 'wfm-gateway', maxReconnectAttempts: -1 });
  try {
    const jsm = await nc.jetstreamManager();
    const cfg = { name: STREAM, subjects: ['wfm.>'], retention: RetentionPolicy.Limits, storage: StorageType.File, max_age: 7 * 24 * 3600 * 1e9 };
    try { await jsm.streams.info(STREAM); await jsm.streams.update(STREAM, cfg); } catch { await jsm.streams.add(cfg); }
    js = nc.jetstream();
    console.log('[nats] connected, JetStream stream WFM ready (wfm.>)');
  } catch (e) {
    js = null;
    console.warn(`[nats] connected WITHOUT JetStream (${(e as Error).message}). Events are live-only, not durable. Start nats-server with -js.`);
  }
}

export const subject = (tenantId: string, ...parts: string[]) => `wfm.${tenantId}.${parts.join('.')}`;

export function publish(tenantId: string, parts: string[], payload: unknown): void {
  const s = subject(tenantId, ...parts);
  const data = sc.encode(JSON.stringify(payload));
  try {
    if (js) js.publish(s, data).catch((e) => console.error('[nats] publish', s, e.message));
    else nc.publish(s, data);
  } catch (e) { console.error('[nats] publish', s, (e as Error).message); }
}

/** Live (non-durable) subscription, used for WebSocket fan-out. Handler gets the parsed payload and the subject tokens. */
export function subscribe(pattern: string, handler: (payload: any, tokens: string[]) => void): void {
  const sub = nc.subscribe(pattern);
  (async () => {
    for await (const m of sub) {
      try { handler(JSON.parse(sc.decode(m.data)), m.subject.split('.')); } catch (e) { console.error('[nats] handler', (e as Error).message); }
    }
  })();
}

/** Durable consumer with explicit acks (JetStream) or a plain subscription when JetStream is not available. */
export async function consume(durable: string, filter: string, handler: (payload: any, tokens: string[]) => Promise<void>): Promise<void> {
  if (!js) { subscribe(filter, (p, t) => { handler(p, t).catch((e) => console.error(`[${durable}]`, e.message)); }); return; }
  const jsm = await nc.jetstreamManager();
  try { await jsm.consumers.info(STREAM, durable); }
  catch { await jsm.consumers.add(STREAM, { durable_name: durable, ack_policy: AckPolicy.Explicit, filter_subject: filter, max_deliver: 5 }); }
  const consumer = await js.consumers.get(STREAM, durable);
  const messages = await consumer.consume();
  (async () => {
    for await (const m of messages) {
      try { await handler(JSON.parse(sc.decode(m.data)), m.subject.split('.')); m.ack(); }
      catch (e) { console.error(`[${durable}]`, (e as Error).message); m.nak(5000); }
    }
  })();
}

// ---------------------------------------------------------------- Engine (gRPC)

const def = protoLoader.loadSync(config.protoPath, { keepCase: true, longs: Number, defaults: true });
const wfm = (grpc.loadPackageDefinition(def) as any).wfm;
const client = new wfm.Engine(config.engineAddr, grpc.credentials.createInsecure(), {
  'grpc.max_receive_message_length': -1, 'grpc.max_send_message_length': -1,
});

const call = <Q, R>(method: string) => (req: Q, timeoutMs = 120_000): Promise<R> =>
  new Promise((resolve, reject) => {
    client[method](req, { deadline: Date.now() + timeoutMs }, (e: grpc.ServiceError | null, r: R) => {
      if (!e) return resolve(r);
      if (e.code === grpc.status.UNAVAILABLE) return reject(Object.assign(new Error('The forecasting engine is not reachable. Start the Python engine (backend/engine).'), { status: 503, code: 'ENGINE_UNAVAILABLE' }));
      reject(e);
    });
  });

export const engine = {
  forecastSeries: call<any, any>('ForecastSeries'),
  staffing: call<any, any>('Staffing'),
  intraday: call<any, any>('Intraday'),
  schedule: call<any, any>('Schedule'),
};

/** True when the engine answers within the timeout (used by /health). */
export const engineReady = (timeoutMs = 700): Promise<boolean> =>
  new Promise((resolve) => client.waitForReady(Date.now() + timeoutMs, (e: Error | undefined) => resolve(!e)));

export async function closeAll(): Promise<void> {
  try { await nc?.drain(); } catch { /* ignore */ }
  redis.disconnect();
  client.close();
}
