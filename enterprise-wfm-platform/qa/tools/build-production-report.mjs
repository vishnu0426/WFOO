// Consolidated "Production Readiness Test": release-gate re-test + 50,000-person scale re-test in one report.
//   node qa/tools/build-production-report.mjs
// Reads  qa/reports/summary.json (release gate), qa/reports/scale/scale-summary.json (scale run 1),
//        <tmp>/wfm-qa/run2/scale/results.jsonl (scale run 2), qa/scale/scale-findings.json + qa/scale/scale-retest.json
// Writes qa/reports/production-readiness/{production-readiness-test.html, artifact.html, production-readiness-test.md, summary.json, defects.csv}
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SCENARIOS, TOTAL, WEEK_FROM } from '../scale/scenarios.mjs';

const QA = path.resolve(import.meta.dirname, '..');
const OUT = path.join(QA, 'reports', 'production-readiness');
fs.mkdirSync(OUT, { recursive: true });
const J = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const gate = J(path.join(QA, 'reports', 'summary.json'));
const run1 = J(path.join(QA, 'reports', 'scale', 'scale-summary.json'));
const sf = J(path.join(QA, 'scale', 'scale-findings.json'));
const srt = J(path.join(QA, 'scale', 'scale-retest.json'));
const R2 = path.join(process.env.QA_OUT ?? path.join(os.tmpdir(), 'wfm-qa', 'run2'), 'scale');
const rows = fs.readFileSync(path.join(R2, 'results.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
const lastOf = (phase, key) => rows.filter((r) => r.phase === phase && (key === undefined || r.key === key)).at(-1);

// ---------------------------------------------------------------- scale run 2 per group
const groups = SCENARIOS.map((s) => {
  const g1 = run1.groups.find((g) => g.key === s.key) ?? {};
  const par = lastOf('schedule-parallel', s.key);
  const seq = rows.filter((r) => (r.phase === 'schedule-queue' || r.phase === 'schedule-direct' || (r.phase === 'schedule-seq' && r.status !== 'ERROR')) && r.key === s.key).map((r) => ({ ...r, mode: r.mode ?? (r.requeued ? 're-queued after the standby' : 'same queue, after the standby') }));
  const best = [par, ...seq].filter(Boolean).find((r) => r.status === 'DONE') ?? seq.at(-1) ?? par;
  const va = lastOf('validate', s.key);
  return {
    key: s.key, name: s.name, size: s.size, what: s.what,
    run1: { status: g1.schedule?.status ?? '—', parallel: run1.parallelRun?.jobs?.find((j) => j.key === s.key)?.status ?? '—', coverage: g1.schedule?.coverage, shifts: g1.schedule?.shifts, wallSec: g1.schedule?.wallSec, violations: g1.validate?.total, how: (g1.tries ?? []).map((t) => `${t.whole ? 'whole' : 'in parts'}: ${t.status === 'DONE' ? 'built' : t.crashes ? 'engine crashed' : 'failed'}`).join('; ') },
    run2: {
      parallel: par ? { status: par.status === 'TIMEOUT_4H' ? 'Interrupted by standby' : par.status, wallSec: par.wallSec, runSec: par.runSec, error: par.error, note: par.note } : null,
      tries: seq.map((r) => ({ mode: r.mode, status: r.status, wallSec: r.wallSec, error: r.error })),
      status: best?.status ?? '—', via: best === par ? 'queued with all 13' : best ? best.mode : '—',
      backend: best?.backend, solver: best?.solver, attemptsLog: best?.attemptsLog, parts: best?.parts, candidates: best?.candidates,
      coverage: best?.coveragePercent, shifts: best?.shifts, wallSec: best?.wallSec, error: best?.status === 'DONE' ? undefined : best?.error,
    },
    validate: va && !va.error ? { shifts: va.shifts, people: va.people, withoutShifts: va.peopleWithoutShifts, total: va.totalViolations, counts: va.violations, examples: va.examples, ft: va.avgWeek1HoursFT, pt: va.avgWeek1HoursPT } : va ? { error: va.error } : null,
  };
});
const built2 = groups.filter((g) => g.run2.status === 'DONE');
const builtPar = groups.filter((g) => g.run2.parallel?.status === 'DONE');
const startRow = rows.find((r) => r.phase === 'start'), endRow = lastOf('end');
const scale = {
  total: TOTAL, weekFrom: WEEK_FROM, machine: run1.machine, groups,
  parallel: { run1: { started: run1.parallelRun?.started, note: run1.parallelRun?.note, built: 0, of: run1.parallelRun?.jobs?.length ?? 12 }, run2: srt.parallelWindow ?? lastOf('probe-during-parallel'), queued: lastOf('parallel-queued'), built: builtPar.length },
  boundary: { run1: run1.boundary, run2: lastOf('boundary') },
  engine: { run1Crashes: run1.engine?.crashes, run2Crashes: endRow && startRow ? endRow.crashesAfter - startRow.crashesBefore : null, exits: endRow?.engineExits },
  built: { run1: run1.groups.filter((g) => g.schedule?.status === 'DONE').length, run2: built2.length },
  shiftsChecked: groups.reduce((n, g) => n + (g.validate?.shifts ?? 0), 0),
  ruleBreaks: groups.reduce((n, g) => n + (g.validate?.total ?? 0), 0), validated: groups.filter((g) => g.validate && !g.validate.error).length,
  api: { run1: run1.api, run2: lastOf('probe-api')?.rows ?? [] }, ui: { run1: run1.ui, run2: lastOf('probe-ui')?.rows ?? [] },
  intraday: { run1: run1.intraday, run2: lastOf('probe-intraday') }, portal: { run1: run1.portal, run2: lastOf('probe-portal') },
  caps: srt.caps ?? [], forecast: run1.groups.map((g) => ({ key: g.key, name: g.name, model: g.model, used: (() => { try { return JSON.parse(g.forecast?.summary ?? '{}').series?.[0]?.model; } catch { return null; } })(), createMs: g.forecast?.createMs })),
};

// ---------------------------------------------------------------- defects: one list, two tracks
const gateDefects = gate.defects.map((d) => ({ ...d, track: 'Release gate' }));
const scaleDefects = [...sf.defects, ...(srt.newDefects ?? []).map((d) => ({ ...d, retest: d.retest ?? { status: 'New', note: 'Found in this re-test.' } }))].map((d) => ({ ...d, track: '50k scale', retest: d.retest ?? (srt.retest[d.id] ? { status: srt.retest[d.id][0], note: srt.retest[d.id][1] } : undefined) }));
const defects = [...gateDefects, ...scaleDefects];
const isOpen = (d) => !['Fixed'].includes(d.retest?.status);
const sevs = ['Critical', 'High', 'Medium', 'Low', 'Info'];
const openBy = (list) => Object.fromEntries(sevs.map((s) => [s, list.filter((d) => d.sev === s && isOpen(d)).length]));
const rtCounts = (list) => list.reduce((m, d) => ((m[d.retest?.status ?? 'Not re-tested'] = (m[d.retest?.status ?? 'Not re-tested'] ?? 0) + 1), m), {});
const blocking = defects.filter((d) => ['Critical', 'High'].includes(d.sev) && isOpen(d));

const summary = {
  generatedAt: new Date().toISOString(), date: '2026-11-01', environment: gate.environment,
  verdict: srt.overallVerdict, verdictLine: srt.overallVerdictLine,
  tracks: [
    { id: 'gate', name: 'Release gate', verdict: gate.verdict, line: gate.verdictLine.replace(/ The 50,000-person scale findings in the separate report still stand./, ''), previous: gate.retest?.previousVerdict, openBySev: openBy(gateDefects), retest: rtCounts(gateDefects), total: gateDefects.length },
    { id: 'scale', name: '50,000-person scale', verdict: srt.verdict, line: srt.verdictLine, previous: run1.verdict, openBySev: openBy(scaleDefects), retest: rtCounts(scaleDefects), total: scaleDefects.length },
  ],
  openBySev: openBy(defects), blocking: blocking.map((d) => ({ id: d.id, sev: d.sev, track: d.track, title: d.title, status: d.retest?.status, note: d.retest?.note, fix: d.fix })),
  gate: { counts: gate.counts, suite: gate.retest?.suite, security: gate.security.map((s) => ({ id: s.id, title: s.title, pass: s.pass })), rbac: gate.rbac, axe: gate.axe, staticChecks: gate.staticChecks, modules: gate.modules.map((m) => ({ name: m.name, screens: m.screens, crashes: m.crashes, serverErrors: m.serverErrors, avgLoadMs: m.avgLoadMs, functional: m.functional, worst: m.worst })), perf: gate.perf },
  scale, defects, strengths: [...(srt.strengths ?? []), ...gate.strengths.slice(0, 6)], method: srt.method ?? [], boundaryLine: srt.boundaryLine,
};
fs.writeFileSync(path.join(OUT, 'summary.json'), JSON.stringify(summary, null, 1));

// ---------------------------------------------------------------- CSV
const cell = (v) => { let s = String(v ?? ''); if (/^[=+\-@]/.test(s)) s = "'" + s; return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
fs.writeFileSync(path.join(OUT, 'defects.csv'), ['ID,Track,Severity,Area,Title,Re-test status,Re-test note,Steps,Expected,Actual,Evidence,Recommended fix',
  ...defects.map((d) => [d.id, d.track, d.sev, d.area, d.title, d.retest?.status, d.retest?.note, d.steps, d.expected, d.actual, d.evidence, d.fix].map(cell).join(','))].join('\r\n'));

// ---------------------------------------------------------------- HTML (shares the release-gate stylesheet)
const gateTpl = fs.readFileSync(path.join(import.meta.dirname, 'report-template.html'), 'utf8');
const style = gateTpl.slice(gateTpl.indexOf('<style>'), gateTpl.indexOf('</style>') + 8);
const fonts = gateTpl.slice(gateTpl.indexOf('<link rel="preconnect"'), gateTpl.indexOf('<style>'));
const tpl = fs.readFileSync(path.join(import.meta.dirname, 'production-template.html'), 'utf8');
const body = tpl.replace('<!--__FONTS__-->', fonts).replace('<!--__STYLE__-->', style).replace('/*__DATA__*/null', JSON.stringify(summary).replace(/</g, '\\u003c'));
fs.writeFileSync(path.join(OUT, 'artifact.html'), body);
fs.writeFileSync(path.join(OUT, 'production-readiness-test.html'), `<!doctype html>\n<html lang="en">\n<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"></head>\n<body>\n${body}\n</body>\n</html>\n`);

// ---------------------------------------------------------------- Markdown
const n = (x) => (x == null || Number.isNaN(Number(x)) ? '—' : Number(x).toLocaleString('en-GB'));
const sec = (x) => (x == null ? '—' : x >= 90 ? `${Math.round(x / 6) / 10} min` : `${x} s`);
const ms = (x) => (x == null ? '—' : x >= 1000 ? `${Math.round(x / 100) / 10} s` : `${x} ms`);
const pipe = (s) => String(s ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');
const tbl = (head, body) => [`| ${head.join(' | ')} |`, `| ${head.map((h) => (/^#|People|Shifts|Covered|Time|Rule|Size|Crash|Built|Before|After|Now|p50|p95/.test(h) ? '---:' : '---')).join(' | ')} |`, ...body.map((r) => `| ${r.map(pipe).join(' | ')} |`)].join('\n');
const vword = (v) => (v === 'CONDITIONAL' ? 'CONDITIONAL GO' : v);
const S = scale, P2 = S.parallel.run2 ?? {};
const md = [];
md.push('# Production Readiness Test', '', `Enterprise WFM Platform · release gate and 50,000-person scale, re-tested · 1–2 November 2026`, '');
md.push(`Admin app :3000 · employee portal :3001 · gateway :4000 · engine :50051 · branch \`qa/production-readiness\`. Machine: ${pipe(S.machine)}`, '');
md.push(`## Verdict: ${vword(summary.verdict)}`, '', summary.verdictLine, '');
md.push(tbl(['Track', 'First run', 'Re-test', 'Open critical', 'Open high', 'Open medium', 'Open low'], summary.tracks.map((t) => [t.name, vword(t.previous), `**${vword(t.verdict)}**`, t.openBySev.Critical, t.openBySev.High, t.openBySev.Medium, t.openBySev.Low])), '');
for (const t of summary.tracks) md.push(`- **${t.name}:** ${t.line}`);
md.push('', '## Still blocking launch', '', blocking.length ? tbl(['ID', 'Track', 'Severity', 'Defect', 'Status', 'What to do'], blocking.map((d) => [d.id, d.track, d.sev, d.title, d.retest?.status ?? 'Open', d.fix])) : 'Nothing.', '');

md.push('## 50,000-person scale re-test', '', `${n(S.total)} employees in ${S.groups.length} WFM groups, one organisation, schedule week from ${S.weekFrom}. Same data, forecasts and machine as the first run; only the code changed.`, '');
md.push(tbl(['Measure', 'Run 1 (31 Oct)', 'Run 2 (1 Nov)'], [
  ['All builds started together', `${S.parallel.run1.built} of ${S.parallel.run1.of} built`, `${S.parallel.built} of ${S.parallel.queued?.queued ?? '—'} built`],
  ['Builds running at once (limit 2)', 'up to 10', n(P2.maxRunning)],
  ['Gateway while building (health check)', 'no answer for most of 42 min', P2.samples ? `p50 ${ms(P2.healthP50)}, p95 ${ms(P2.healthP95)}, worst ${ms(P2.worstHealthMs)}; ${P2.failures} failed of ${P2.samples}` : '—'],
  ['Schedules built (any way)', `${S.built.run1} of 13`, `${S.built.run2} of 13`],
  ['Engine crashes', n(S.engine.run1Crashes), n(S.engine.run2Crashes)],
  ['Over-limit request', 'ran 8.5 min, then the connection dropped', srt.boundaryLine ?? '—'],
  ['Shifts re-checked by the independent checker', '250,495', n(S.shiftsChecked)],
  ['Rule breaks found', '0', n(S.ruleBreaks)],
]), '');
md.push('### Per group', '', tbl(['Group', 'People', 'Run 1', 'Run 2 all at once', 'Run 2 result', 'Solver', 'Covered', 'Shifts', 'Rule breaks'], S.groups.map((g) => [`${g.key} · ${g.name}`, n(g.size), g.run1.status === 'DONE' ? `built (${g.run1.coverage}%)` : 'failed', g.run2.parallel ? `${g.run2.parallel.status}${g.run2.parallel.wallSec ? ' · ' + sec(g.run2.parallel.wallSec) : ''}` : '—', g.run2.status === 'DONE' ? `built (${g.run2.via})` : `${g.run2.status}${g.run2.error ? ': ' + String(g.run2.error).slice(0, 120) : ''}`, g.run2.backend ?? '—', g.run2.coverage == null ? '—' : `${g.run2.coverage}%`, n(g.run2.shifts), g.validate?.error ? 'not checked' : n(g.validate?.total)])), '');
md.push('"Covered" is the share of required staff-hours the schedule meets. "Rule breaks" are counted by an independent checker that re-reads every shift against each person\'s rules (double-booking, rest, weekly hours, days in a row, leave, unavailable hours, weekends, night consent, shift length).', '');
if (S.caps.length) md.push('### Organisations above 2,000 people', '', tbl(['Check', 'Run 1', 'Run 2'], S.caps.map((c) => [c.check, c.run1, c.run2])), '');
if (S.api.run2.length) {
  const a1 = Object.fromEntries(S.api.run1.map((r) => [r.name, r]));
  md.push('### API reads at 50,000 people', '', tbl(['Read', 'Run 1 time', 'Run 2 time', 'Run 2 size', 'Rows'], S.api.run2.map((r) => [r.name, ms(a1[r.name]?.ms), `${r.status === 200 ? '' : r.status + ' · '}${ms(r.ms)}`, `${n(r.kb)} kB`, n(r.rows)])), '');
}
if (S.ui.run2.length) {
  const u1 = Object.fromEntries(S.ui.run1.map((r) => [r.name, r]));
  md.push('### Admin screens at 50,000 people (Chrome, dev server)', '', tbl(['Screen', 'Run 1', 'Run 2', 'Memory', 'Problems'], S.ui.run2.map((r) => [r.name, ms(u1[r.name]?.ms), ms(r.ms), `${r.heapMb} MB`, r.crashed ? 'crashed' : r.errors.length ? r.errors.join('; ').slice(0, 140) : 'none'])), '');
}
const pr2 = S.portal.run2;
if (pr2) md.push(`### Employee portal for one of the 50,000`, '', `Signed in as an S01 agent: home in ${ms(pr2.uiHomeMs)} (${pr2.uiHomeOk ? 'ok' : 'failed'}); portal API ${pr2.portalApi.map((p) => `${p.p} ${p.status} ${ms(p.ms)}`).join(', ')}; ${pr2.shiftsThisPeriod} shifts visible this period.`, '');

md.push('## Release gate re-test', '', summary.tracks[0].line, '');
const C = gate.counts;
md.push(tbl(['Area', 'Result'], [
  ['Playwright suite', `${gate.retest.suite.passed} of ${gate.retest.suite.total} passed`],
  ['Functional API checks', `${C.functionalPass} of ${C.functionalChecks}`], ['UI journeys (admin + portal)', `${C.uiPass} of ${C.uiChecks}`],
  ['Security attack tests', `${C.securityPass} of ${C.securityTests}`], ['Access control (role × route)', `${n(C.rbacChecks)} checks over ${C.guardedRoutes} guarded routes, 0 leaks`],
  ['Screens crawled', `${C.adminScreens} admin + ${C.portalSections} portal`], ['Static checks', gate.staticChecks.map((s) => `${s.name}: ${s.ok ? 'ok' : 'FAIL'}`).join('; ')],
]), '');
md.push(tbl(['Re-test result', 'Release gate', '50k scale'], ['Fixed', 'Partly fixed', 'Still open', 'Still applies', 'New', 'Not re-tested'].filter((k) => summary.tracks.some((t) => t.retest[k])).map((k) => [k, n(summary.tracks[0].retest[k] ?? 0), n(summary.tracks[1].retest[k] ?? 0)])), '');

md.push('## All defects', '', `${defects.length} defects across both tracks (the CSV has the full text: \`defects.csv\`).`, '');
md.push(tbl(['ID', 'Track', 'Severity', 'Defect', 'Re-test', 'Note'], defects.map((d) => [d.id, d.track, d.sev, d.title, d.retest?.status ?? '—', d.retest?.note ?? ''])), '');
md.push('### Defect details', '');
for (const d of defects.filter(isOpen)) md.push(`#### ${d.id} · ${d.sev} · ${d.title}`, '', `- **Track / area:** ${d.track} · ${d.area}`, `- **Re-test:** ${d.retest?.status ?? '—'}. ${d.retest?.note ?? ''}`, `- **Steps:** ${d.steps}`, `- **Expected:** ${d.expected}`, `- **Actual:** ${d.actual}`, `- **Fix:** ${d.fix}`, '');
md.push('## What works well', '', ...summary.strengths.map((s) => `- ${s}`), '');
md.push('## Method and limits', '', ...(srt.method ?? []).map((s) => `- ${s}`), '');
fs.writeFileSync(path.join(OUT, 'production-readiness-test.md'), md.join('\n'));
console.log('production readiness report ->', OUT, { blocking: blocking.length, defects: defects.length, built2: built2.length });
