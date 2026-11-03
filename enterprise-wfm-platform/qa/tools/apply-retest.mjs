// Writes the 2026-11-01 re-test outcome into findings.json (retest field per defect, new findings, verdict).
//   node qa/tools/apply-retest.mjs
import fs from 'node:fs';
import path from 'node:path';

const F = path.resolve(import.meta.dirname, '../findings.json');
const f = JSON.parse(fs.readFileSync(F, 'utf8'));
const R = {
  'DEF-01': ['Fixed', 'Old token refused straight after the account is disabled: 200 before, 401 immediately after and 6 s later.'],
  'DEF-02': ['Fixed', 'A second, overlapping admin booking now returns 409 with a clear message naming the existing vacation.'],
  'DEF-03': ['Still open', 'Admin still signs in with the blocklisted bootstrap password and is not asked to change it (mustChangePassword=false). SEC-01 fails.'],
  'DEF-04': ['Fixed', 'Prototype SEED_ data is gone. In the live palette "Jane" and "Voice Inbound" now find nothing, while "Agent1" lists the real employees, "Demo Support" the real group and "Shift Templates" the screen; Enter opens the result.'],
  'DEF-05': ['Fixed', 'Sidebar items are now focusable buttons: Tab reaches Overview, Workforce, Employees, Teams, Skills and the rest (A-03 passes).'],
  'DEF-06': ['Partly fixed', 'Unnamed buttons are gone: 530 elements on 51 screens down to 0. Still 6 form fields without labels on Administration > Alerts & reports (critical "label" rule).'],
  'DEF-07': ['Still open', 'ag-grid-enterprise is still a dependency, there is no licence key in any env file, and the licence banner is still logged on 4 screens (Employees, Time off, Attendance, Activities).'],
  'DEF-08': ['Fixed', 'The audit CSV now writes the team name with a leading apostrophe (\'=HYPERLINK...), so spreadsheets show it as text.'],
  'DEF-09': ['Fixed', 'GET /users?token=<valid JWT> now returns 401.'],
  'DEF-10': ['Fixed', 'Median sign-in time is 293 ms for a real user and 301 ms for an unknown one.'],
  'DEF-11': ['Fixed', '2026-02-30 now returns 400 "One of the values is not valid (check dates and numbers)." with no database text.'],
  'DEF-12': ['Fixed', 'A failed admin sign-in now appears in the audit log.'],
  'DEF-13': ['Fixed', 'History-quality API answers in 21 ms (2 ms cached); Forecast Builder settles in 6.6 s on the dev server (was about 34 s).'],
  'DEF-14': ['Fixed', 'Crash injection: the CP-SAT solver process was killed mid-build. The engine stayed up (0 restarts), the build fell back to HiGHS and finished DONE ("cpsat: failed (the solver process ended without an answer)", "highs: feasible"). Each solve now runs in its own process.'],
  'DEF-15': ['Fixed', 'Screens are now lazy-loaded: entry chunk 282 kB (87 kB gzip) across 35 chunks. AG Grid (2.7 MB) and exceljs (940 kB) load only on screens that use them.'],
  'DEF-16': ['Partly fixed', '?limit= and ?offset= are now accepted, but paging happens after a capped 2,000-row load: x-total-count says 2000 on a 50,656-person tenant, offset 40000 returns 0 rows, and 50 rows cost the same ~500 ms as 2,000. Push LIMIT/OFFSET (or keyset paging) into the SQL and return the true total (see scale DEF-29).'],
  'DEF-17': ['Fixed', 'At 412 px the portal has no sidebar and no sideways scroll; content uses the full width on every section.'],
  'DEF-18': ['Partly fixed', 'Low-contrast elements roughly halved (822 to 457) but still present on all 51 admin screens; the portal sign-in still has 2.'],
  'DEF-19': ['Still open', 'backend/.env still has NATS_TLS_REJECT_UNAUTHORIZED=false.'],
  'DEF-20': ['Fixed', 'Code check: /me/offers now joins wfm_groups and returns group_name. Not seen live, because the demo agent had no open offers during the run.'],
  'DEF-21': ['Fixed', 'Each portal section has its own URL; reloading on /inbox stays on Inbox (P-08 passes).'],
  'DEF-22': ['Fixed', 'The form flags an end date before the start date before it is submitted (P-05 passes).'],
  'DEF-23': ['Fixed', 'Hire date 2099-01-01 now returns 400 "hireDate must be between 1950 and a year from now".'],
  'DEF-24': ['Fixed', 'Broken JSON now returns 400 BAD_JSON.'],
  'DEF-25': ['Still open', 'Unchanged (a configuration choice): /auth/discover still returns the organisation for a known login and an empty list for an unknown one; /auth/login-options names the organisation. Set LOGIN_DISCOVERY=false if org codes are handed out another way.'],
  'DEF-26': ['Fixed', 'Both apps link /favicon.svg, served as image/svg+xml.'],
  'DEF-27': ['Fixed', 'Code check: the seed now handles the forced password change. Not re-run, because it rewrites the demo data.'],
  'DEF-28': ['Still applies', 'Still a pre-launch housekeeping item. The database now also holds the 50,000-person SCALE test data and QA- records from both runs.'],
};
for (const d of f.defects) if (R[d.id]) d.retest = { status: R[d.id][0], note: R[d.id][1] };
f.defects = f.defects.filter((d) => !/^DEF-4[3-9]$/.test(d.id));
f.defects.push(
  {
    id: 'DEF-43', sev: 'Medium', area: 'Performance · Intraday', title: 'Adherence takes about 2 s per call on a large tenant',
    steps: 'GET /intraday/adherence?groupId=<Demo Support> 15 times, on the tenant that now also holds the 50,656-person scale data',
    expected: 'Close to the first run (p95 23 ms): the group still has the same people',
    actual: 'p50 1,913 ms, p95 2,232 ms. The three SQL queries behind it take about 20 ms in total when run directly as the database owner (row-level security does not apply there), so the time goes on row-level-security checks or work in the gateway. /workforce/employees is 641 ms and 1.6 MB for 2,000 rows, and under 25 parallel requests it manages 1 request per second (p50 15 s, p95 21 s; all 200).',
    evidence: 'performance > PERF-01 (re-run on a restarted gateway); EXPLAIN ANALYZE of the adherence queries in psql',
    fix: 'Profile the endpoint as the app role (RLS on); make sure the RLS policy uses an indexed, STABLE tenant lookup; add an index on employees(primary_group_id) and a GIN index on eligible_group_ids.',
    retest: { status: 'New', note: 'Found in this re-test.' },
  },
  {
    id: 'DEF-44', sev: 'Low', area: 'Reliability · Gateway', title: 'Gateway process ended once with no log line',
    steps: 'Run the API-latency test (12 endpoints x 15 calls) straight after the full suite',
    expected: 'The gateway stays up, or logs why it stopped',
    actual: 'The process ended with exit code 127 and nothing in its log; the test got ECONNRESET. After a restart the same test ran cleanly, so it did not reproduce.',
    evidence: 'The gateway log ends on normal 200 lines; the shell reported exit code 127',
    fix: 'Run the gateway under a process manager that restarts it, and log uncaughtException, unhandledRejection and process exit before quitting.',
    retest: { status: 'New', note: 'Found in this re-test; seen once.' },
  },
  {
    id: 'DEF-45', sev: 'Low', area: 'Tooling · Engine tests', title: 'Engine unit tests: 3 of 91 fail after the solver change',
    steps: 'cd backend/engine && python -m pytest -q',
    expected: '91 passed (as in the first run)',
    actual: '88 passed, 3 failed. test_a_failing_primary_falls_through_to_the_next_solver and test_every_solver_failing_still_ends_with_the_greedy_roster stub solve_cpsat, but the solver now runs in a separate process the stub never reaches (both pass with ENGINE_ISOLATE_SOLVES=0). test_no_history_changes_nothing is flaky: the same request can give a different roster (it failed 1 of 2 times in-process).',
    evidence: 'pytest output saved as static/pytest-rerun.txt in the QA run folder',
    fix: 'Stub solve_cpsat_isolated (or set ENGINE_ISOLATE_SOLVES=0) in those two tests; fix the CP-SAT random seed and use 1 search worker in the determinism test.',
    retest: { status: 'New', note: 'Found in this re-test.' },
  },
);
f.retest = { date: '2026-11-01', previousVerdict: 'NO-GO', previousCounts: { Critical: 2, High: 5, Medium: 12, Low: 8, Info: 1 }, suite: { passed: 104, failed: 4, total: 108 } };
f.verdict = 'CONDITIONAL';
f.verdictLine = 'Both critical defects and 18 others are fixed and checked. Three high items remain open, and none needs a large change: rotate the bootstrap admin password and force a change (DEF-03, a setting); add an AG Grid licence key or move to the Community edition (DEF-07, a setting or purchase); and label the last 6 form fields on Alerts & reports (DEF-06, a small code fix). Close those and NATS certificate checking (DEF-19), and this gate is a GO. The 50,000-person scale findings in the separate report still stand.';
fs.writeFileSync(F, JSON.stringify(f, null, 1));
const c = {}; for (const d of f.defects) c[d.retest?.status ?? '?'] = (c[d.retest?.status ?? '?'] ?? 0) + 1;
console.log(c);
