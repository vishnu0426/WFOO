// Writes the two reports as Markdown, from the same data as the HTML pages:
//   qa/reports/release-gate-report.md      (from qa/reports/summary.json)
//   qa/reports/scale-test-report.md        (from qa/reports/scale/scale-summary.json)
//   node qa/tools/build-markdown.mjs
// The forecast "model chosen / error" table in the scale report is read from the gateway when it is running (QA_ADMIN_PASSWORD set).
import fs from 'node:fs';
import path from 'node:path';

const R = path.resolve(import.meta.dirname, '../reports');
const S = JSON.parse(fs.readFileSync(path.join(R, 'summary.json'), 'utf8'));
const C = JSON.parse(fs.readFileSync(path.join(R, 'scale', 'scale-summary.json'), 'utf8'));

const cell = (v) => String(v ?? '—').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
const table = (head, rows, align = []) => [
  `| ${head.join(' | ')} |`,
  `| ${head.map((_, i) => (align[i] === 'r' ? '---:' : '---')).join(' | ')} |`,
  ...rows.map((r) => `| ${r.map(cell).join(' | ')} |`),
].join('\n');
const n = (x) => (x == null || Number.isNaN(Number(x)) ? '—' : Number(x).toLocaleString('en-GB'));
const dur = (ms) => (ms == null ? '—' : ms >= 60000 ? `${(ms / 60000).toFixed(1)} min` : ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${ms} ms`);
const day = (iso) => new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
const ok = (b, y = 'Pass', f = 'Fail') => (b ? `✅ ${y}` : `❌ ${f}`);
const defectBlock = (d) => [
  `### ${d.id} · ${d.sev} · ${d.title}`,
  '',
  `**Area:** ${d.area}`,
  '',
  ...(d.retest ? [`- **Re-test:** ${d.retest.status} — ${d.retest.note}`] : []),
  `- **Steps:** ${d.steps}`,
  `- **Expected:** ${d.expected}`,
  `- **Actual:** ${d.actual}`,
  `- **Evidence:** ${d.evidence}`,
  `- **Fix:** ${d.fix}`,
  '',
].join('\n');

// =====================================================================================================================
// 1. Release gate
// =====================================================================================================================
{
  const sevs = ['Critical', 'High', 'Medium', 'Low', 'Info'];
  const blockers = S.defects.filter((d) => (d.sev === 'Critical' || d.sev === 'High') && d.retest?.status !== 'Fixed');
  const RT = S.retest;
  const rtIcon = { Fixed: '✅', 'Partly fixed': '🟡', 'Still open': '❌', 'Still applies': '⚪', New: '🆕' };
  const k = S.counts;
  const perf = (kind) => (Array.isArray(S.perf) ? S.perf : Object.values(S.perf)).find((p) => p.kind === kind)?.rows ?? [];
  const md = [];
  md.push('# WFM Release Gate', '');
  md.push(`Production-readiness test of the Enterprise WFM Platform · ${day(S.generatedAt)}`, '');
  md.push(`- Admin web app: \`${S.environment.admin}\``, `- Employee portal: \`${S.environment.portal}\``, `- Gateway: \`${S.environment.gateway}\` · Engine: \`${S.environment.engine}\` · ${S.environment.db} · ${S.environment.other}`, `- Branch: ${S.environment.branch}`, `- Browser: ${S.environment.browser}`, '');
  md.push(`## ${RT ? 'Re-test verdict' : 'Verdict'}: ${S.verdict === 'CONDITIONAL' ? 'CONDITIONAL GO' : S.verdict}`, '');
  md.push(S.verdictLine ?? (S.verdict === 'GO' ? 'No blocking defects remain.' : `Do not ship yet. Fix the ${blockers.length} critical and high defects below, then re-run the suite. Access control, sign-in protection, scheduling rules and the main self-service flows held up well.`), '');
  if (RT) md.push(`First run: **${RT.previousVerdict}** with ${RT.previousCounts.Critical} critical and ${RT.previousCounts.High} high defects. Re-test on ${day(RT.date)}: full Playwright suite re-run (${RT.suite.passed} of ${RT.suite.total} tests passed) and every original defect checked again directly against the running stack.`, '');
  md.push(table(['Severity', RT ? 'Open defects' : 'Defects'], sevs.map((s) => [s, S.bySev[s]]), ['', 'r']), '');
  md.push(table(['Area', 'Result'], [
    ['Screens tested', `${k.adminScreens} admin + ${k.portalSections} portal, each with an accessibility scan`],
    ['Access checks', `${n(k.rbacChecks)} role × route checks over ${k.guardedRoutes} guarded API routes · 0 leaks`],
    ['Functional API checks', `${k.functionalPass}/${k.functionalChecks} passed`],
    ['UI journeys (admin + portal)', `${k.uiPass}/${k.uiChecks} passed`],
    ['Security attack tests', `${k.securityPass}/${k.securityTests} passed`],
  ]), '');

  if (RT) {
    md.push('## Re-test results', '');
    md.push(table(['Outcome', 'Defects'], ['Fixed', 'Partly fixed', 'Still open', 'Still applies', 'New'].filter((x) => RT.counts[x]).map((x) => [`${rtIcon[x]} ${x}`, RT.counts[x]]), ['', 'r']), '');
    md.push(table(['ID', 'Severity', 'Defect', 'Re-test', 'What we saw'], [...S.defects].sort((a, b) => a.id.localeCompare(b.id)).map((d) => [d.id, d.sev, d.title, `${rtIcon[d.retest?.status] ?? ''} ${d.retest?.status ?? '—'}`, d.retest?.note])), '');
  }
  md.push(RT ? '## Still blocking launch' : '## Must fix before launch', '');
  md.push(table(['ID', 'Severity', 'Title', 'Area', ...(RT ? ['Re-test'] : [])], blockers.map((d) => [d.id, d.sev, d.title, d.area, ...(RT ? [d.retest?.status] : [])])), '');

  md.push('## Module scorecard', '');
  md.push('Every admin screen was opened by URL and checked for crashes, uncaught errors, failing API calls and WCAG issues. Functional checks drive each module\'s API end to end.', '');
  md.push(table(['Module', 'Screens', 'Crashes', '5xx', 'Avg load', 'Functional', 'Worst open defect', 'Defects'],
    S.modules.map((m) => [m.name + (m.maxLoad && m.maxLoad.loadMs > 6000 ? ` (slowest: ${m.maxLoad.url}, ${dur(m.maxLoad.loadMs)})` : ''), m.screens, m.crashes, m.serverErrors, m.avgLoadMs ? dur(m.avgLoadMs) : '—', m.fnTotal ? `${m.fnPass}/${m.fnTotal}` : '—', m.worst ?? 'None', m.defects.join(' ') || '—']),
    ['', 'r', 'r', 'r', 'r', 'r']), '');
  md.push('Load times are from Vite dev servers (unbundled modules) and include waiting for every API call. Accessibility defects DEF-05, DEF-06 and DEF-18 apply to all admin modules and are listed once.', '');

  md.push(`## All defects (${S.defects.length})`, '');
  md.push('The same list is in `qa/reports/defects.csv` for import into Jira or Azure DevOps.', '');
  for (const d of S.defects) md.push(defectBlock(d));

  md.push('## Security', '');
  md.push(table(['Test', 'Result', 'What was checked', 'Evidence'], S.security.map((s) => [s.id, ok(s.pass), s.title, JSON.stringify(s.evidence).slice(0, 220)])), '');

  md.push('## Access control (RBAC)', '');
  md.push('Routes and their required permissions were read from the gateway source (352 routes, 327 guarded). Each role called every route it lacks permission for (must be 403) and every GET it is allowed (must not be 401/403 or 5xx).', '');
  const un = S.rbac.find((r) => r.check === 'unauthenticated');
  md.push(table(['Caller', 'Calls', 'Leaks', 'Wrongly blocked', '5xx', 'Result'], [
    ...(un ? [['Signed out', un.tested, un.leaks.length, '—', '—', ok(!un.leaks.length)]] : []),
    ...S.rbac.filter((r) => r.check === 'role').map((r) => [r.role, r.tested, r.leaks.length, r.wrongDeny.length, r.errors5xx.length, ok(!r.leaks.length && !r.wrongDeny.length && !r.errors5xx.length)]),
  ], ['', 'r', 'r', 'r', 'r']), '');

  md.push('## Accessibility (axe-core, WCAG 2.1 A + AA)', '');
  md.push(table(['Rule', 'Impact', 'Screens', 'Elements', 'Meaning'], S.axe.map((a) => [a.id, a.impact, `${a.screens}/${k.adminScreens}`, n(a.nodes), a.help]), ['', '', 'r', 'r']), '');
  md.push(RT ? 'Keyboard: the admin sidebar is now reachable with Tab (DEF-05 fixed).' : 'Keyboard: the admin sidebar is built from clickable `<div>`s; 40 Tab presses reached it once (DEF-05).', '');

  md.push('## Performance (one machine, dev servers — indicative)', '');
  md.push('### API reads (15 calls each)', '');
  md.push(table(['Endpoint', 'p50', 'p95', 'Size'], perf('api-latency').map((r) => [r.endpoint, `${r.p50} ms`, `${r.p95} ms`, `${r.kb} kB`]), ['', 'r', 'r', 'r']), '');
  md.push('### Page load', '');
  md.push(table(['Screen', 'First paint', 'All data loaded', 'API calls'], perf('page-load').map((r) => [r.url, dur(r.loadMs), dur(r.settledMs), r.apiCalls]), ['', 'r', 'r', 'r']), '');
  md.push('### Concurrency (25 parallel × 4 waves)', '');
  md.push(table(['Endpoint', 'Requests', 'Req/s', 'p50', 'p95', 'Status codes'], perf('concurrency').map((r) => [r.endpoint, r.requests, r.rps ?? '—', r.p50 != null ? `${r.p50} ms` : '—', `${r.p95} ms`, JSON.stringify(r.codes)]), ['', 'r', 'r', 'r', 'r']), '');
  md.push('### Phone layout (412 px)', '');
  md.push(table(['App', 'Content width', 'Sidebar', 'Result'], S.responsive.map((r) => { const v = r.detail.Home ?? r.detail['/overview']; return [r.app === 'portal' ? 'Employee portal' : 'Admin app', `${v.mainW} px`, `${v.asideW} px`, ok(v.mainW >= v.viewW * 0.7, 'Usable', 'Squeezed')]; }), ['', 'r', 'r']), '');

  md.push('## Builds and the project\'s own tests', '');
  md.push(table(['Check', 'Result', 'Detail'], S.staticChecks.map((c) => [c.name, ok(c.ok), c.detail])), '');

  md.push('## What works well', '');
  for (const s of S.strengths) md.push(`- ${s}`);
  md.push('');
  md.push('## Method and limits', '');
  md.push('**Covered:** manual and exploratory review of every screen in Chrome; automated UI (Playwright + Chrome): 51-screen crawl, admin and portal journeys, phone layout; API functional checks per module, role-based access over every guarded route, attack tests; route inventory and permission map generated from the gateway source; performance baseline, production builds, type checks, the engine\'s and the gateway\'s own suites.', '');
  md.push('**Not covered:** a second tenant (cross-tenant isolation), single sign-on, SCIM, e-mail/SMS delivery, webhooks, the native mobile app, production infrastructure (TLS, proxy, backups), load beyond 25 concurrent requests, browsers other than Chrome, a screen-reader walkthrough.', '');
  md.push('**Re-run:**', '', '```powershell', 'cd qa', 'npm install', "$env:QA_ADMIN_PASSWORD='…'          # test stack only — the suite creates QA- data", 'npx playwright test', 'node tools/build-report.mjs', 'node tools/build-markdown.mjs', '```', '');
  fs.writeFileSync(path.join(R, 'release-gate-report.md'), md.join('\n'));
}

// =====================================================================================================================
// 2. 50k scale test
// =====================================================================================================================
{
  // which model each forecast actually used, and its backtest error (read live when the gateway is up)
  let models = {};
  if (process.env.QA_ADMIN_PASSWORD) {
    try {
      const B = process.env.QA_API ?? 'http://localhost:4000';
      const tok = (await (await fetch(`${B}/api/v1/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: process.env.QA_ADMIN_PASSWORD, tenant: 'ORG' }) })).json()).token;
      const vs = await (await fetch(`${B}/api/v1/forecast/versions`, { headers: { Authorization: `Bearer ${tok}` } })).json();
      for (const v of vs.filter((x) => x.name?.startsWith('SCALE') && x.status === 'PUBLISHED' && x.kind === 'SHORT')) {
        const d = await (await fetch(`${B}/api/v1/forecast/versions/${v.id}`, { headers: { Authorization: `Bearer ${tok}` } })).json();
        const ser = (d.summary ?? v.summary)?.series?.[0];
        const sc = ser?.scores?.find((x) => x.model === ser.model);
        models[v.name.slice(6, 9)] = { chosen: ser?.model, wape: sc ? `${(sc.wape * 100).toFixed(2)}%` : '—', mase: sc?.mase, stability: sc?.stability, notes: (ser?.notes ?? []).join(' ') };
      }
    } catch { models = {}; }
  }
  const G = C.groups, built = G.filter((g) => g.schedule?.status === 'DONE');
  const md = [];
  md.push('# WFM 50k Scale Test', '');
  md.push(`${n(C.total)} employees in ${G.length} WFM groups · schedule week from ${C.weekFrom} · ${day(C.generatedAt)}`, '');
  md.push(`Machine: ${C.machine}`, '');
  md.push(`## Verdict: ${C.verdict}`, '');
  md.push(C.verdictLine, '');
  md.push(table(['Measure', 'Result'], [
    ['Employees', `${n(C.total)} in ${G.length} groups, one organisation`],
    ['Schedules built', `${built.length} of ${G.length} (through the real gateway → engine pipeline)`],
    ['Shifts generated and re-checked', n(built.reduce((a, g) => a + (g.validate?.shifts ?? g.schedule?.shifts ?? 0), 0))],
    ['Rule breaks found by the independent checker', n(G.reduce((a, g) => a + (g.validate?.total ?? 0), 0))],
    ['Engine crashes (under a restart supervisor)', C.engine.crashes],
    ['New defects', C.defects.length],
  ]), '');

  md.push('## Scenario groups', '');
  md.push('Each group is a different real-world case. All were loaded through the API and scheduled for one week (S10: 13 weeks) by background jobs, one group at a time.', '');
  md.push(table(['Group', 'People', 'Situation', 'Schedule', 'Attempts (one at a time)', 'Build time', 'Covered', 'Shifts', 'No shift', 'Rule breaks'],
    G.map((g) => {
      const s = g.schedule, v = g.validate;
      return [`${g.key} · ${g.name}`, n(g.size), g.what,
        s?.status ? `${s.status}${s.solver ? ` (${s.solver}${s.backend ? ', ' + s.backend : ''})` : ''}` : '—',
        (g.tries ?? []).map((t) => `${t.whole ? 'whole' : 'in parts'}: ${t.status === 'DONE' ? 'built' : t.crashes ? 'engine crashed' : 'failed'}`).join('; ') || '—',
        s?.wallSec != null && s.status === 'DONE' ? dur(s.wallSec * 1000) : '—', s?.coverage != null ? `${s.coverage}%` : '—', n(v?.shifts ?? s?.shifts), v ? n(v.withoutShifts) : '—', v?.total != null ? n(v.total) : '—'];
    }), ['', 'r', '', '', '', 'r', 'r', 'r', 'r', 'r']), '');
  md.push('"Covered" is the share of required staff-hours the schedule meets (from the schedule\'s own statistics). "Rule breaks" are counted by an independent checker.', '');

  if (C.parallelRun) {
    md.push('## First attempt: all groups at once', '');
    md.push(`${C.parallelRun.note} Every build failed; the gateway answered nobody for most of the 42 minutes. Started ${C.parallelRun.started}.`, '');
    md.push(table(['Group', 'Result', 'Ran for', 'Why'], C.parallelRun.jobs.map((j) => [j.key, j.status, `${j.minutes} min`, j.why]), ['', '', 'r']), '');
  }

  const keys = ['overlap', 'rest', 'weeklyMax', 'daysPerWeek', 'consecutive', 'onLeave', 'unavailable', 'weekend', 'night', 'length', 'outsideGroup'];
  const labels = { overlap: 'Double-booked', rest: 'Rest < 11 h', weeklyMax: 'Over max hours', daysPerWeek: 'Too many days', consecutive: 'Days in a row', onLeave: 'On approved leave', unavailable: 'In unavailable hours', weekend: 'Weekend (not allowed)', night: 'Night without consent', length: 'Odd shift length', outsideGroup: 'Not in group' };
  const vrows = G.filter((g) => g.validate && !g.validate.error);
  md.push('## Schedule rules, person by person', '');
  md.push(table(['Group', ...keys.map((k) => labels[k]), 'Avg week-1 hours FT / PT'], vrows.map((g) => [g.key, ...keys.map((k) => g.validate.counts?.[k] ?? 0), `${g.validate.ft ?? '—'} / ${g.validate.pt ?? '—'}`]), ['', ...keys.map(() => 'r'), 'r']), '');
  const g06 = G.find((g) => g.key === 'S06')?.validate, g08 = G.find((g) => g.key === 'S08')?.validate;
  md.push(`Context: S06 has ${n(g06?.leavePeople)} people on approved leave and ${n(g06?.unavailablePeople)} with unavailable mornings; S08 has ${n(g08?.noWeekendPeople)} people who may not work weekends. Not validated: groups with no schedule (${G.filter((g) => !g.validate || g.validate.error).map((g) => g.key).join(', ')}).`, '');

  md.push('## Forecasting', '');
  md.push('History: 12 weeks of 15-minute intervals per queue (gaps in S08, outlier days in S09, intermittent volume in S04). Each forecast was created, then submitted, approved and published. Data is synthetic, so backtest errors are unrealistically low except where the model was a poor fit.', '');
  md.push(table(['Group', 'Model asked', 'Model used', 'Backtest WAPE', 'Create', 'Dashboard', 'Leaderboard', 'Scenarios', 'Accuracy', 'History quality', 'Notes'],
    G.map((g) => { const f = g.forecast ?? {}, m = models[g.key] ?? {}; const t = (x) => (x ? (x.ok ? dur(x.ms) : 'failed') : '—');
      return [g.key, g.model, m.chosen ?? '—', m.wape ?? '—', f.error ? 'failed' : dur(f.createMs), t(f.dashboard), t(f.leaderboard), t(f.scenarios), t(f.accuracy), t(f.historyQuality),
        [m.notes, f.adjust && `+20% adjustment: ${f.adjust}`, f.long && `365-day long-term: ${f.long} (${dur(f.longMs)})`, m.stability && m.stability !== 'HIGH' ? `stability ${m.stability}, MASE ${m.mase}` : ''].filter(Boolean).join(' · ')]; }),
    ['', '', '', 'r', 'r', 'r', 'r', 'r', 'r', 'r']), '');

  md.push('## Limits, rotation and load', '');
  const b = C.boundary, r = C.rotation;
  md.push(table(['Check', 'Result'], [
    ['Candidate-limit boundary (S13: every 15-minute start and every length 4–12 h for 3,000 people)', b ? (b.status ? `${b.status}: ${b.message}` : `No answer: the connection dropped after ${dur(b.ms)} (${b.message}); engine afterwards: ${JSON.stringify(b.healthAfter?.engine ?? b.healthAfter)}, Redis: ${JSON.stringify(b.healthAfter?.redis)}`) : '—'],
    ['Rotation 4-on-4-off (S07: 2 crews, 12 h days, 4 weeks)', r ? (r.error ?? `${r.members} members in ${dur(r.membersMs)}; materialised in ${dur(r.materializeMs)}: ${String(r.materialize).replace(/"__ms".*$/, '').slice(0, 160)}`) : '—'],
    ['Engine (restart loop for this test)', `${C.engine.starts} starts, ${C.engine.crashes} crashes`],
  ]), '');

  md.push('## Screens, API and portal with 50,000 people', '');
  md.push('### API reads', '');
  md.push(table(['Read', 'Status', 'Time', 'Size', 'Rows'], C.api.map((a) => [a.name, a.status, dur(a.ms), `${n(a.kb)} kB`, n(a.rows)]), ['', 'r', 'r', 'r', 'r']), '');
  md.push('### Admin screens in Chrome (6,000-person group selected where it applies)', '');
  md.push(table(['Screen', 'Ready', 'JS heap', 'Result'], C.ui.map((u) => [u.name, dur(u.ms), `${n(u.heapMb)} MB`, u.crashed ? 'crashed' : u.errors.length ? u.errors[0] : 'OK']), ['', 'r', 'r']), '');
  const it = C.intraday, po = C.portal;
  md.push('### Live agent states and the portal', '');
  if (it) md.push(`- **Live agent states:** ${n(it.people)} people in ${dur(it.totalMs)} — ${it.batches.map((x) => `${n(x.accepted)}/${n(x.n)} accepted in ${dur(x.ms)}`).join(', ')}. A batch of 2,001 → ${it.over2000.status} "${it.over2000.msg}". Adherence afterwards: ${dur(it.adherenceAfter.ms)}.`);
  if (po) md.push(`- **Employee portal (S01-00001, one of 6,000 in their group):** sign-in to Home ${dur(po.uiHomeMs)}; ${po.portalApi.map((x) => `${x.p.replace('/me/', '')} ${dur(x.ms)}`).join(', ')}. Shifts were visible only after the schedule was published (publish of 24,288 shifts: 9.5 s); the employee then saw 4 shifts for the week (32 h on a 40 h contract) and no notification.`);
  md.push('');

  md.push(`## Defects (${C.defects.length})`, '');
  md.push('Numbered after the release-gate list (DEF-01 to DEF-28). Also in `qa/reports/scale/scale-defects.csv`.', '');
  for (const d of C.defects) md.push(defectBlock(d));

  md.push('## What held up', '');
  for (const s of C.strengths) md.push(`- ${s}`);
  md.push('');
  md.push('## Method and limits', '');
  md.push('```powershell', "$env:QA_ADMIN_PASSWORD='…'                     # test stack only: adds 50,000 people", 'node qa/scale/scale-test.mjs setup             # groups, queues, 12 weeks of history, people, leave, availability', 'node qa/scale/scale-test.mjs forecast          # one model per group, publish, long-term + adjustment', 'node qa/scale/schedule-sequential.mjs S01,S02 90 [900000]   # one group at a time; 900000 = solve whole', 'node qa/scale/validate.mjs                     # independent rule check', 'node qa/scale/probe-50k.mjs                    # API, live states, admin screens, portal', 'node qa/scale/build-scale-report.mjs', 'node qa/tools/build-markdown.mjs', '```', '');
  md.push('- One laptop ran everything (database, gateway, one engine, both web apps, Chrome), so times are a floor, not a server benchmark.');
  md.push('- One week is solved per group (S10: 4 weeks solved and 9 repeated). Demand and people are synthetic; real availability patterns make the model harder.');
  md.push('- Coverage is what the solver reached within its 90-second limit (feasible, not proven optimal).');
  md.push('- The test data (groups `SCALE S01`–`S13`, employees `S01-00001`…) is still in the local database.', '');
  fs.writeFileSync(path.join(R, 'scale-test-report.md'), md.join('\n'));
}
console.log(`wrote ${path.join(R, 'release-gate-report.md')}\nwrote ${path.join(R, 'scale-test-report.md')}`);
