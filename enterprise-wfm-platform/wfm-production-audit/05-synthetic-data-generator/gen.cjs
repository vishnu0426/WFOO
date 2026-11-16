// Deterministic synthetic WFM data, identical in Node and in a browser (same seed => same bytes).
// Node:    node gen.js --employees 500 --groups 5 --seed 42 --run-id TR0042S500 --start 2026-08-16
// Browser: paste the function body; call WFMGEN({...}) -> { setup, employeesCsv, history: {queue: csv}, holdout: {queue: csv}, truth: {queue: csv} }
// Same demand model as generate.py (channel shapes, weekday, trend, 91-day season, holidays, spike days, Poisson arrivals, abandons),
// but with its own seeded PRNG so it runs in a page. History AHT is left blank when nothing was handled (the importer rejects 0: AUD-05).
function WFMGEN(o) {
  const SEED = o.seed ?? 42, RUN = o.runId, N = o.employees, START = o.start ?? '2026-08-16', DAYS = o.days ?? 90, HOLD = o.holdout ?? 28, IV = o.interval ?? 15;
  let s = (SEED * 2654435761) >>> 0;
  const rnd = () => { s = (s + 0x6D2B79F5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const pick = (a) => a[Math.floor(rnd() * a.length)];
  const randint = (a, b) => a + Math.floor(rnd() * (b - a + 1));
  const normal = () => { const u = 1 - rnd(), v = rnd(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };
  const poisson = (l) => { if (l <= 0) return 0; if (l > 40) return Math.max(0, Math.round(l + Math.sqrt(l) * normal())); const L = Math.exp(-l); let k = 0, p = 1; do { k++; p *= rnd(); } while (p > L); return k - 1; };
  const binom = (n, p) => { let k = 0; for (let i = 0; i < n; i++) if (rnd() < p) k++; return k; };
  const r2 = (x) => Math.round(x * 100) / 100;
  const FIRST = 'Asha Ben Chen Dara Eli Fay Gus Hana Ivo Jun Kai Lea Max Nia Omar Pia Quin Ravi Sara Tom Uma Vik Wen Xia Yan Zoe'.split(' ');
  const LAST = 'Adams Bose Cruz Diaz Eng Fox Gill Hart Iyer Jain Khan Lund Moss Nair Ortiz Park Quinn Rao Shah Tan Usha Vega Wong Xu Young Zhou'.split(' ');
  const CH = {
    VOICE: { aht: 300, split: [0.72, 0.10, 0.18], peaks: [[10, 1.6, 1], [14.5, 2, 0.8]], weekend: 0.55, abandon: 0.06, open: [7, 22] },
    CHAT: { aht: 540, split: [0.85, 0, 0.15], peaks: [[12, 3, 1], [19.5, 1.5, 0.7]], weekend: 0.8, abandon: 0.03, open: [8, 23] },
    EMAIL: { aht: 420, split: [0.8, 0, 0.2], peaks: [[9.5, 2.5, 1]], weekend: 0.35, abandon: 0, open: [6, 22] },
    BACKOFFICE: { aht: 900, split: [0.9, 0, 0.1], peaks: [[11, 4, 1]], weekend: 0, abandon: 0, open: [8, 18] },
  };
  const WEEKDAY = [1.15, 1.05, 1.0, 0.98, 0.95, 1.0, 1.0];
  const SITES = [['BLR', 'Asia/Kolkata', 'India'], ['MNL', 'Asia/Manila', 'Philippines'], ['LON', 'Europe/London', 'United Kingdom'], ['NYC', 'America/New_York', 'United States'], ['MEX', 'America/Mexico_City', 'Mexico']];
  const LANGS = ['English', 'Spanish', 'Hindi', 'Tagalog', 'French'];
  const MIX = ['VOICE', 'VOICE', 'CHAT', 'EMAIL', 'BACKOFFICE'];
  const G = o.groups ?? Math.max(1, Math.round(N / 2000));
  const addDays = (d, n) => { const x = new Date(d + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
  const slots = (24 * 60) / IV;
  const groups = [];
  for (let i = 0; i < G; i++) groups.push({ code: `G${String(i + 1).padStart(3, '0')}`, channel: MIX[i % MIX.length], site: SITES[i % SITES.length], people: Math.floor(N / G) + (i < N % G ? 1 : 0) });
  const skills = [...Object.keys(CH).map((c) => `${RUN}-${c}`), ...LANGS.map((l) => `${RUN}-LANG-${l}`)];
  const setup = { tag: { TEST_RUN_ID: RUN, TEST_DATA_FLAG: 'TRUE', CREATED_BY_TEST_RUN: RUN }, skills, sites: [], groups: [], teams: [] };
  for (const [c, tz, country] of SITES) if (groups.some((g) => g.site[0] === c)) setup.sites.push({ name: `${RUN}-${c}`, tz, country });
  const emp = ['employee_number,first_name,last_name,team,wfm_group,employment_type,weekly_hours,max_weekly_hours,days_per_week,status,hire_date,skills'];
  let seq = 0;
  for (const g of groups) {
    const gname = `${RUN}-${g.code}`;
    setup.groups.push({ name: gname, channel: g.channel, site: `${RUN}-${g.site[0]}`, tz: g.site[1], queue: `${gname}-Q`, people: g.people, interval: IV });
    for (let t = 0; t < Math.ceil(g.people / 15); t++) setup.teams.push({ name: `${gname}-T${String(t + 1).padStart(3, '0')}`, group: gname });
    for (let i = 0; i < g.people; i++) {
      seq++;
      const num = `${RUN}-${String(seq).padStart(6, '0')}`, team = `${gname}-T${String(Math.floor(i / 15) + 1).padStart(3, '0')}`;
      const pt = rnd() < 0.22, weekly = pt ? pick([20, 24, 30]) : pick([37.5, 40, 40, 40]);
      const maxw = pt ? weekly : Math.min(48, weekly + 8), dpw = pt ? Math.max(Math.ceil(weekly / 8), pick([3, 4, 5])) : 5;
      const hire = addDays(START, -randint(30, 3650));
      const lang = rnd() < 0.7 ? 'English' : pick(LANGS.slice(1));
      const other = rnd() < 0.25 ? pick(Object.keys(CH).filter((c) => c !== g.channel)) : null;
      const sk = [`${RUN}-${g.channel}:${randint(2, 5)}`, `${RUN}-LANG-${lang}:${randint(3, 5)}`, ...(other ? [`${RUN}-${other}:${randint(1, 3)}`] : [])];
      const status = rnd() > 0.01 ? 'ACTIVE' : 'SUSPENDED';
      emp.push([num, pick(FIRST), `${pick(LAST)}-${RUN.slice(-4)}`, team, gname, pt ? 'PART_TIME' : 'FULL_TIME', weekly, maxw, dpw, status, hire, sk.join('; ')].join(','));
    }
  }
  const history = {}, holdout = {}, truth = {};
  for (const g of setup.groups) {
    const ch = CH[g.channel];
    const prof = []; let tot = 0;
    for (let k = 0; k < slots; k++) { const h = (k + 0.5) * IV / 60; let y = 0; for (const [mu, sd, w] of ch.peaks) y += w * Math.exp(-0.5 * ((h - mu) / sd) ** 2); if (h < ch.open[0] || h >= ch.open[1]) y = 0; prof.push(y); tot += y; }
    const weeklyWork = g.people * 0.99 * 36 * 0.7 * 0.8;
    const dailyBase = (weeklyWork * 3600) / ch.aht / (5 + 2 * ch.weekend);
    const total = DAYS + HOLD, nSpike = Math.max(1, Math.floor(total / 30)), spikes = new Set();
    while (spikes.size < nSpike) spikes.add(Math.floor(rnd() * total));
    const H = ['date,interval,offered,abandoned,aht'], O = ['date,interval,offered,handled,abandoned,aht'], T = ['date,interval,expected_offered,split'];
    for (let d = 0; d < total; d++) {
      const day = addDays(START, d), wd = (new Date(day + 'T00:00:00Z').getUTCDay() + 6) % 7, md = day.slice(5);
      let f = WEEKDAY[wd] * (wd >= 5 ? ch.weekend : 1) * (1 + 0.0015 * d) * (1 + 0.08 * Math.sin((2 * Math.PI * d) / 91));
      if (['08-15', '10-02', '11-01', '12-25'].includes(md)) f *= 0.4;
      const spike = spikes.has(d) ? 1.6 : 1;
      for (let k = 0; k < slots; k++) {
        const lam = tot ? (dailyBase * f * prof[k]) / tot : 0;
        if (lam <= 0) continue;
        const offered = poisson(lam * spike), ab = offered && ch.abandon ? binom(offered, ch.abandon * (spike > 1 ? 1.5 : 1)) : 0, handled = offered - ab;
        const aht = handled ? r2(Math.max(30, ch.aht * (1 + 0.08 * normal()))) : '';
        const hh = String(Math.floor((k * IV) / 60)).padStart(2, '0'), mm = String((k * IV) % 60).padStart(2, '0');
        if (d < DAYS) H.push(`${day},${hh}:${mm},${offered},${ab},${aht}`); else O.push(`${day},${hh}:${mm},${offered},${handled},${ab},${aht}`);
        T.push(`${day},${hh}:${mm},${lam.toFixed(4)},${d < DAYS ? 'history' : 'holdout'}`);
      }
    }
    history[g.queue] = H.join('\n'); holdout[g.queue] = O.join('\n'); truth[g.queue] = T.join('\n');
  }
  return { setup, employeesCsv: emp.join('\n'), history, holdout, truth };
}
if (typeof module !== 'undefined' && require.main === module) {
  const fs = require('fs'), path = require('path'), crypto = require('crypto');
  const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : d; };
  const o = { employees: +arg('employees'), groups: arg('groups') ? +arg('groups') : undefined, seed: +arg('seed', 42), runId: arg('run-id'), start: arg('start', '2026-08-16'), days: +arg('days', 90), holdout: +arg('holdout', 28) };
  const t0 = Date.now(), r = WFMGEN(o), out = path.join(__dirname, 'out', o.runId);
  fs.mkdirSync(out, { recursive: true });
  const sha = (x) => crypto.createHash('sha256').update(x).digest('hex');
  const files = {};
  const put = (n, x) => { fs.writeFileSync(path.join(out, n), x); files[n] = { rows: x.split('\n').length - 1, sha256: sha(x) }; };
  put('employees.csv', r.employeesCsv);
  for (const q in r.history) { put(`history_${q}.csv`, r.history[q]); put(`holdout_${q}.csv`, r.holdout[q]); put(`truth_${q}.csv`, r.truth[q]); }
  fs.writeFileSync(path.join(out, 'setup.json'), JSON.stringify(r.setup, null, 1));
  // quality
  const rows = r.employeesCsv.split('\n').slice(1).map((l) => l.split(','));
  const nums = rows.map((x) => x[0]), teams = new Set(r.setup.teams.map((t) => t.name)), groups = new Set(r.setup.groups.map((g) => g.name));
  const checks = {
    duplicateNumbers: nums.length - new Set(nums).size,
    unknownTeam: rows.filter((x) => !teams.has(x[3])).length, unknownGroup: rows.filter((x) => !groups.has(x[4])).length,
    weeklyOverMax: rows.filter((x) => +x[6] > +x[7]).length, weeklyOverDaysX8or9: rows.filter((x) => +x[6] > +x[8] * (x[5] === 'PART_TIME' ? 8 : 10)).length,
    unknownSkill: rows.filter((x) => x[11].split(';').some((k) => !r.setup.skills.includes(k.split(':')[0].trim()))).length,
    historyOfferedLtAbandoned: Object.values(r.history).reduce((n, c) => n + c.split('\n').slice(1).filter((l) => { const p = l.split(','); return +p[3] > +p[2]; }).length, 0),
  };
  fs.writeFileSync(path.join(out, 'quality.json'), JSON.stringify({ checks, passed: Object.values(checks).every((v) => v === 0) }, null, 1));
  fs.writeFileSync(path.join(out, 'manifest.json'), JSON.stringify({ ...r.setup.tag, generator: 'gen.js', args: o, generated_at: new Date().toISOString(), files }, null, 1));
  console.log(JSON.stringify({ run: o.runId, ms: Date.now() - t0, employees: rows.length, groups: r.setup.groups.length, teams: r.setup.teams.length, historyRows: Object.values(r.history).reduce((n, c) => n + c.split('\n').length - 1, 0), quality: checks, employeesSha: files['employees.csv'].sha256.slice(0, 16) }));
}
