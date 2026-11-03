// Builds the 50,000-employee scale report from <tmp>/wfm-qa/scale/results.jsonl + qa/scale/scale-findings.json.
//   node qa/scale/build-scale-report.mjs        -> qa/reports/scale/{scale-report.html, scale-artifact.html, scale-summary.json, scale-defects.csv, screens/}
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SCENARIOS, TOTAL, WEEK_FROM } from './scenarios.mjs';

const SRC = path.join(process.env.QA_OUT ?? path.join(os.tmpdir(), 'wfm-qa'), 'scale');
const OUT = path.resolve(import.meta.dirname, '../reports/scale');
fs.mkdirSync(OUT, { recursive: true });
const rows = fs.readFileSync(path.join(SRC, 'results.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
const last = (phase, key) => rows.filter((r) => r.phase === phase && (key === undefined || r.key === key)).filter((r) => !r.error || !rows.some((x) => x.phase === phase && x.key === key && !x.error)).at(-1);
const findings = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, 'scale-findings.json'), 'utf8'));
const sup = fs.existsSync(path.join(SRC, 'engine-supervisor.log')) ? fs.readFileSync(path.join(SRC, 'engine-supervisor.log'), 'utf8').trim().split('\n') : [];
const crashes = sup.filter((l) => /EXIT/.test(l));

const groups = SCENARIOS.map((s) => {
  const su = last('setup', s.key), fc = last('forecast', s.key), va = last('validate', s.key);
  // the one-at-a-time pass is the result; prefer a finished build, else the latest attempt
  const seq = rows.filter((r) => r.phase === 'schedule-seq' && r.key === s.key);
  const sc = seq.filter((r) => r.status === 'DONE').at(-1) ?? seq.at(-1) ?? last('schedule', s.key);
  const tries = seq.map((r) => ({ status: r.status, whole: !!r.splitAbove, wallSec: r.wallSec, prepareSec: r.prepareSec, crashes: r.engineCrashesDuring }));
  return {
    key: s.key, name: s.name, size: s.size, what: s.what, model: s.model, tz: s.tz,
    setup: su ? { ms: su.ms, importMs: su.imports?.reduce((n, i) => n + i.ms, 0), timeOff: su.timeOff, availability: su.availability, nights: su.nightUpdate, noWeekend: su.noWeekendUpdate } : null,
    forecast: fc ? { createMs: fc.createMs, error: fc.error, adjust: fc.adjust, long: fc.long, longMs: fc.longMs, summary: fc.summary, dashboard: fc.dashboard, leaderboard: fc.leaderboard, scenarios: fc.scenarios, accuracy: fc.accuracy, historyQuality: fc.historyQuality } : null,
    tries,
    schedule: sc ? { whole: !!sc.splitAbove, prepareSec: sc.prepareSec, crashesDuring: sc.engineCrashesDuring, status: sc.status, error: sc.error, wallSec: sc.wallSec, solver: sc.solver, backend: sc.backend, parts: sc.parts, candidates: sc.candidates, shifts: sc.shifts, peopleUsed: sc.peopleUsed, coverage: sc.coveragePercent, violations: sc.violations, statsRaw: sc.statsRaw, progress: sc.progress } : null,
    validate: va && !va.error ? { people: va.people, shifts: va.shifts, peopleWithShifts: va.peopleWithShifts, withoutShifts: va.peopleWithoutShifts, ft: va.avgWeek1HoursFT, pt: va.avgWeek1HoursPT, total: va.totalViolations, counts: va.violations, examples: va.examples, firstDay: va.firstDay, lastDay: va.lastDay, leavePeople: va.leavePeople, unavailablePeople: va.unavailablePeople, nightConsent: va.nightConsent, noWeekendPeople: va.noWeekendPeople, shiftsKb: va.shiftsKb, shiftsMs: va.shiftsMs } : (va ? { error: va.error } : null),
  };
});
const summary = {
  generatedAt: new Date().toISOString(), total: TOTAL, weekFrom: WEEK_FROM, groups,
  boundary: last('boundary'), rotation: last('rotation'), probeDuring: last('probe-during-scheduling'),
  api: last('probe-api')?.rows ?? [], intraday: last('probe-intraday'), ui: last('probe-ui')?.rows ?? [], portal: last('probe-portal'),
  engine: { starts: sup.filter((l) => /start/.test(l)).length, crashes: crashes.length, lines: sup.slice(-12) },
  machine: findings.machine, parallelRun: findings.parallelRun, defects: findings.defects, strengths: findings.strengths, verdict: findings.verdict, verdictLine: findings.verdictLine,
};
fs.writeFileSync(path.join(OUT, 'scale-summary.json'), JSON.stringify(summary, null, 1));
const cell = (v) => { let s = String(v ?? ''); if (/^[=+\-@]/.test(s)) s = "'" + s; return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
fs.writeFileSync(path.join(OUT, 'scale-defects.csv'), ['ID,Severity,Area,Title,Steps,Expected,Actual,Evidence,Recommended fix', ...findings.defects.map((d) => [d.id, d.sev, d.area, d.title, d.steps, d.expected, d.actual, d.evidence, d.fix].map(cell).join(','))].join('\r\n'));
if (fs.existsSync(path.join(SRC, 'screens'))) fs.cpSync(path.join(SRC, 'screens'), path.join(OUT, 'screens'), { recursive: true });
const tpl = fs.readFileSync(path.join(import.meta.dirname, 'scale-template.html'), 'utf8');
const body = tpl.replace('/*__DATA__*/null', JSON.stringify(summary).replace(/</g, '\\u003c'));
fs.writeFileSync(path.join(OUT, 'scale-report.html'), `<!doctype html>\n<html lang="en">\n<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"></head>\n<body>\n${body}\n</body>\n</html>\n`);
fs.writeFileSync(path.join(OUT, 'scale-artifact.html'), body);
console.log(`scale report -> ${OUT}`);
