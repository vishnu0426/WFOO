/**
 * Many people using the system at once: each virtual user signs in and then works through the calls a person makes opening the main screens, a few times over.
 *
 *   node scripts/load-users.mjs --base http://localhost:4001[,http://localhost:4002 ...] --password '...' --users 200 --rounds 3 [--tenant ORG] [--username admin] [--ramp 5]
 *
 * Prints the sign-in time, the requests per second, the answers by status, the slowest calls, and what the gateway itself reported while it ran (event-loop delay, database
 * connections waiting, sign-ins queued). Exit code 1 if any request failed with a server error or the slowest 5% took longer than --p95 ms (default 3000).
 * It reads only; it creates nothing. One signed-in account is used for every user (the gateway checks the password for each sign-in, which is the part being measured).
 */
const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const BASES = arg('base', 'http://localhost:4000').split(','), BASE = BASES[0], PASSWORD = arg('password', ''), TENANT = arg('tenant', 'ORG'), USER = arg('username', 'admin');
const USERS = Number(arg('users', '100')), ROUNDS = Number(arg('rounds', '3')), RAMP = Number(arg('ramp', '0')), P95_BUDGET = Number(arg('p95', '3000'));

const stats = new Map();                 // path -> { ms: number[], status: Map }
const record = (path, ms, status) => { const s = stats.get(path) ?? { ms: [], status: new Map() }; s.ms.push(ms); s.status.set(status, (s.status.get(status) ?? 0) + 1); stats.set(path, s); };
const timed = async (path, token, opts = {}, base = BASE) => {
  const t0 = performance.now();
  try {
    const r = await fetch(base + path, { ...opts, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}), ...(opts.headers ?? {}) } });
    const body = await r.arrayBuffer(); record(path.split('?')[0].replace(/[0-9a-f-]{36}/g, ':id'), performance.now() - t0, r.status);
    return { status: r.status, body: Buffer.from(body).toString() };
  } catch (e) { record(path.split('?')[0], performance.now() - t0, 'network'); return { status: 0, body: '' }; }
};
const metrics = async () => { try { return await (await fetch(BASE + '/metrics')).text(); } catch { return ''; } };
const pick = (text, re) => { const m = re.exec(text); return m ? Number(m[1]) : null; };
const pct = (a, p) => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]; };

const first = await timed('/api/v1/auth/login', null, { method: 'POST', body: JSON.stringify({ username: USER, password: PASSWORD, tenant: TENANT }) });
if (first.status !== 200) { console.error('Could not sign in:', first.status, first.body.slice(0, 200)); process.exit(2); }
stats.clear();
const groups = JSON.parse((await timed('/api/v1/config/groups', JSON.parse(first.body).token)).body);
const gid = (groups.find((g) => /^Adh /.test(g.name)) ?? groups[0]).id;
stats.clear();

const SESSION = (g) => [
  '/api/v1/auth/me', '/api/v1/config/groups', '/api/v1/config/queues', '/api/v1/workforce/teams?fields=pick', '/api/v1/rbac/matrix', '/api/v1/scheduling/templates',
  '/api/v1/workforce/employees?limit=50', '/api/v1/scheduling/versions?limit=20', '/api/v1/forecast/versions?groupId=' + g, '/api/v1/data/coverage',
  '/api/v1/intraday/adherence/summary?groupId=' + g, '/api/v1/intraday/adherence/agents?groupId=' + g + '&limit=50', '/api/v1/config/groups/summary',
];

const before = await metrics();
let signInMs = [];
const t0 = performance.now();
await Promise.all(Array.from({ length: USERS }, async (_, i) => {
  if (RAMP) await new Promise((r) => setTimeout(r, (i / USERS) * RAMP * 1000));
  const s0 = performance.now();
  const mine = BASES[i % BASES.length];
  const l = await timed('/api/v1/auth/login', null, { method: 'POST', body: JSON.stringify({ username: USER, password: PASSWORD, tenant: TENANT }) }, mine);
  signInMs.push(performance.now() - s0);
  if (l.status !== 200) return;
  const token = JSON.parse(l.body).token;
  for (let r = 0; r < ROUNDS; r++) {
    // a person opens a screen: a few calls together, then a pause to read it
    const calls = SESSION(gid);
    for (let k = 0; k < calls.length; k += 4) await Promise.all(calls.slice(k, k + 4).map((p) => timed(p, token, {}, mine)));
    await new Promise((res) => setTimeout(res, 200 + Math.random() * 400));
  }
}));
const wall = (performance.now() - t0) / 1000;
const after = await metrics();

let total = 0, errors = 0, serverErrors = 0; const all = [];
const rows = [];
for (const [path, s] of stats) {
  total += s.ms.length; all.push(...s.ms);
  for (const [st, n] of s.status) { if (st !== 200 && st !== 304) errors += n; if (st === 'network' || (typeof st === 'number' && st >= 500)) serverErrors += n; }
  rows.push({ call: path.replace('/api/v1', ''), n: s.ms.length, p50: Math.round(pct(s.ms, 50)), p95: Math.round(pct(s.ms, 95)), max: Math.round(Math.max(...s.ms)), notOk: [...s.status].filter(([k]) => k !== 200 && k !== 304).map(([k, n]) => `${k}×${n}`).join(' ') });
}
rows.sort((a, b) => b.p95 - a.p95);
console.table(rows);
const p95All = pct(all, 95);
console.log(`${USERS} users × ${ROUNDS} rounds: ${total} requests in ${wall.toFixed(1)} s (${(total / wall).toFixed(0)} a second), ${errors} not OK (${serverErrors} server/network errors)`);
console.log(`sign-in: median ${Math.round(pct(signInMs, 50))} ms, slowest ${Math.round(Math.max(...signInMs))} ms; all requests: median ${Math.round(pct(all, 50))} ms, p95 ${Math.round(p95All)} ms, p99 ${Math.round(pct(all, 99))} ms`);
if (after) {
  console.log(`gateway reported: event-loop delay (max since the last scrape) ${pick(after, /event_loop_delay_seconds\{quantile="1"\} ([\d.]+)/)} s; database connections ${pick(after, /db_pool_connections\{state="total"\} (\d+)/)} of ${pick(after, /db_pool_connections\{state="max"\} (\d+)/)} (waiting now ${pick(after, /db_pool_connections\{state="waiting"\} (\d+)/)}); password-hash threads ${pick(after, /password_hash_threads (\d+)/)}, rejected busy ${pick(after, /result="rejected_busy"\} (\d+)/)}`);
}
process.exit(serverErrors > 0 || p95All > P95_BUDGET ? 1 : 0);
