// Builds qa/route-inventory.json: every gateway route with its full path and the permission guard on it.
// Static parse of backend/gateway/src (router.method('path', requires(...)) pattern + index.ts mount points).
import fs from 'node:fs';
import path from 'node:path';

const SRC = path.resolve(import.meta.dirname, '../../backend/gateway/src');
const index = fs.readFileSync(path.join(SRC, 'index.ts'), 'utf8');

// router variable -> mount prefix under /api/v1 (or /scim/v2)
const mounts = {};
for (const m of index.matchAll(/api\.use\((?:'([^']+)',\s*)?(\w+)\)/g)) (mounts[m[2]] ??= []).push('/api/v1' + (m[1] ?? ''));
for (const m of index.matchAll(/app\.use\('([^']+)',\s*(\w+)\)/g)) (mounts[m[2]] ??= []).push(m[1]);

const files = [];
const walk = (d) => { for (const f of fs.readdirSync(d)) { const p = path.join(d, f); fs.statSync(p).isDirectory() ? walk(p) : p.endsWith('.ts') && files.push(p); } };
walk(SRC);

// "import { a as b }" aliases in index.ts
const alias = {};
for (const m of index.matchAll(/import\s*\{([^}]+)\}\s*from/g)) for (const part of m[1].split(',')) { const [a, b] = part.trim().split(/\s+as\s+/); if (a) alias[(b ?? a).trim()] = a.trim(); }

const routes = [];
for (const f of files) {
  const txt = fs.readFileSync(f, 'utf8');
  for (const m of txt.matchAll(/^\s*(\w+)\.(get|post|put|patch|delete)\(\s*'([^']+)'\s*,([^\n]*)/gm)) {
    const [, router, method, p, rest] = m;
    const guard = /requires(Any)?\(([^)]*)\)/.exec(rest);
    const perms = guard ? guard[2].split(',').map((s) => s.trim().replace(/['"]/g, '')).filter(Boolean) : [];
    const prefixes = mounts[router] ?? Object.entries(alias).filter(([, orig]) => orig === router).flatMap(([local]) => mounts[local] ?? []);
    for (const pre of prefixes.length ? prefixes : ['?']) {
      routes.push({ method: method.toUpperCase(), path: pre + p, router, file: path.relative(SRC, f).replace(/\\/g, '/'), guard: guard ? (guard[1] ? 'any' : 'all') : 'none', perms });
    }
  }
}
fs.writeFileSync(path.resolve(import.meta.dirname, '../route-inventory.json'), JSON.stringify(routes, null, 1));
const unmounted = routes.filter((r) => r.path.startsWith('?'));
const unguarded = routes.filter((r) => r.guard === 'none' && !r.path.startsWith('?'));
console.log(`${routes.length} routes, ${unguarded.length} without a requires() guard, ${unmounted.length} with unknown mount`);
console.log('unguarded:\n' + unguarded.map((r) => `  ${r.method} ${r.path}  (${r.file})`).join('\n'));
if (unmounted.length) console.log('unknown mount routers: ' + [...new Set(unmounted.map((r) => r.router + '@' + r.file))].join(', '));
