/**
 * Password hashing off the main thread.
 *
 * bcrypt at cost 12 is meant to take a quarter of a second of CPU. bcryptjs does that work on the thread that serves every request, so one sign-in froze the whole
 * gateway for that long: 60 people signing in together took 8 s, and during it even /health waited 3 s. The work now runs on a small pool of worker threads (the same
 * bcryptjs, so every stored hash still verifies), and the main thread only waits for the answer.
 *
 * - PASSWORD_HASH_THREADS: workers (default: cores - 1, between 1 and 4, since each is a full core while it works);
 * - PASSWORD_HASH_QUEUE_MAX: sign-ins waiting for a worker before new ones are told to try again in a moment (default 400), so a stampede is answered, not piled up.
 */
import { Worker } from 'node:worker_threads';
import os from 'node:os';
import { createRequire } from 'node:module';
import bcrypt from 'bcryptjs';

const require = createRequire(import.meta.url);
const WORKER_CODE = `
const { parentPort, workerData } = require('node:worker_threads');
const bcrypt = require(workerData.bcryptPath);
parentPort.on('message', async ({ id, op, a, b }) => {
  try { parentPort.postMessage({ id, ok: true, value: op === 'hash' ? await bcrypt.hash(a, b) : await bcrypt.compare(a, b) }); }
  catch (e) { parentPort.postMessage({ id, ok: false, error: String(e && e.message || e) }); }
});`;

type Job = { id: number; op: 'hash' | 'compare'; a: string; b: string | number; resolve: (v: any) => void; reject: (e: Error) => void };
interface Slot { worker: Worker; busy: Job | null }

const THREADS = Math.max(0, Number(process.env.PASSWORD_HASH_THREADS ?? Math.min(4, Math.max(1, os.cpus().length - 1))));
const QUEUE_MAX = Number(process.env.PASSWORD_HASH_QUEUE_MAX || 400);
const slots: Slot[] = [];
const queue: Job[] = [];
let nextId = 1, broken = false;
export const hashStats = { done: 0, rejected: 0, inline: 0, waitSec: 0 };
export const hashQueueLength = () => queue.length;
export const hashThreads = () => slots.length;

export class HashBusy extends Error { status = 503; code = 'BUSY'; constructor() { super('Too many people are signing in at once. Try again in a few seconds.'); } }

function start(): void {
  if (slots.length || broken || THREADS === 0) return;
  try {
    for (let i = 0; i < THREADS; i++) {
      const slot: Slot = { worker: new Worker(WORKER_CODE, { eval: true, workerData: { bcryptPath: require.resolve('bcryptjs') } }), busy: null };
      slot.worker.on('message', (m: { id: number; ok: boolean; value?: any; error?: string }) => {
        const job = slot.busy; slot.busy = null;
        if (job && job.id === m.id) { hashStats.done++; if (m.ok) job.resolve(m.value); else job.reject(new Error(m.error)); }
        pump();
      });
      slot.worker.on('error', (e) => {                 // a worker that dies fails the job it held and is replaced; hashing falls back to the main thread if they keep dying
        console.error('[passwordHash] worker error:', e.message);
        const job = slot.busy; slot.busy = null;
        if (job) job.reject(new Error('password check failed, try again'));
        slots.splice(slots.indexOf(slot), 1);
        if (!slots.length) broken = true;
      });
      slots.push(slot);
      slot.worker.unref();                              // after the listeners are attached (attaching one makes a worker count again): idle threads never keep the process alive
    }
  } catch (e: any) { console.error('[passwordHash] workers unavailable, hashing on the main thread:', e.message); broken = true; slots.length = 0; }
}

function pump(): void {
  for (const slot of slots) {
    if (slot.busy) continue;
    const job = queue.shift();
    if (!job) return;
    slot.busy = job;
    slot.worker.postMessage({ id: job.id, op: job.op, a: job.a, b: job.b });
  }
}

function run<T>(op: 'hash' | 'compare', a: string, b: string | number): Promise<T> {
  start();
  if (broken || !slots.length) { hashStats.inline++; return (op === 'hash' ? bcrypt.hash(a, b as number) : bcrypt.compare(a, b as string)) as Promise<T>; }
  if (queue.length >= QUEUE_MAX) { hashStats.rejected++; return Promise.reject(new HashBusy()); }
  const t0 = Date.now();
  return new Promise<T>((resolve, reject) => {
    queue.push({ id: nextId++, op, a, b, resolve: (v) => { hashStats.waitSec += (Date.now() - t0) / 1000; resolve(v); }, reject });
    pump();
  });
}

/** Same as bcrypt.hash(password, cost), without holding up the gateway. */
export const hashPassword = (password: string, cost = 12): Promise<string> => run<string>('hash', password, cost);
/** Same as bcrypt.compare(password, hash), without holding up the gateway. */
export const checkPassword = (password: string, hash: string): Promise<boolean> => run<boolean>('compare', password, hash);
