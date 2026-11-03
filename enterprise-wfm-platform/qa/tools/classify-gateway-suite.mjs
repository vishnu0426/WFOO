// Groups the failures of backend/gateway's own test run (node --test spec output) by likely cause.
//   node qa/tools/classify-gateway-suite.mjs <gateway-suite.txt>
import fs from 'node:fs';
const txt = fs.readFileSync(process.argv[2], 'utf8');
const tail = txt.slice(txt.indexOf('failing tests:'));
const blocks = tail.split(/\n(?=test at )/).slice(1);
const cause = (b) =>
  /ENGINE_UNAVAILABLE|503 !==|actual: 503/.test(b) ? 'engine down after its crash' :
  /PASSWORD_CHANGE_REQUIRED/.test(b) ? 'test users hit the forced password change' :
  /actual: 403|403 !== 20\d/.test(b) ? '403 (forced password change on test users)' :
  /cancelled|still pending|parent/.test(b) ? 'cancelled after an earlier failure' : 'other';
const out = {};
for (const b of blocks) {
  const file = (b.match(/test at test[\\/]([\w.-]+)/) ?? [])[1] ?? '?';
  const title = (b.split('\n')[1] ?? '').replace(/^✖\s*/, '').replace(/\s*\([\d.]+ms\)$/, '');
  const c = cause(b);
  (out[c] ??= []).push({ file, title, first: b.split('\n').slice(2, 4).join(' ').trim().slice(0, 220) });
}
const summary = Object.fromEntries(Object.entries(out).map(([k, v]) => [k, { count: v.length, files: [...new Set(v.map((x) => x.file))], items: v }]));
fs.writeFileSync(process.argv[2].replace(/\.txt$/, '-classified.json'), JSON.stringify(summary, null, 1));
for (const [k, v] of Object.entries(summary)) {
  console.log(`${v.count}  ${k}  [${v.files.join(', ')}]`);
  if (k === 'other') for (const x of v.items) console.log(`     - ${x.file}: ${x.title} :: ${x.first}`);
}
