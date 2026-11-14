/** Is the history fit to forecast from: what is flagged, and what is left alone. */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { analyseQueue, type DayRow } from '../src/modules/forecast/historyQuality.ts';
import { demandVolume } from '../src/modules/forecast/demand.ts';

const add = (d: string, n: number) => { const [y, m, dd] = d.split('-').map(Number); return new Date(Date.UTC(y, m - 1, dd + n)).toISOString().slice(0, 10); };
const TODAY = '2027-03-01';
/** `n` days ending yesterday, a steady 1000 calls a day (300 at the weekend), unless `tweak` changes a day or drops it. */
const history = (n: number, tweak: (i: number, row: DayRow) => DayRow | null = (_i, r) => r): DayRow[] => {
  const out: DayRow[] = [];
  for (let i = 0; i < n; i++) {
    const day = add(TODAY, -(n - i));
    const wk = ((new Date(`${day}T00:00:00Z`).getUTCDay() + 6) % 7) >= 5;
    const r = tweak(i, { day, intervals: 96, volume: wk ? 300 : 1000, abandoned: 20, ahtOutliers: 0 });
    if (r) out.push(r);
  }
  return out;
};
type Over = Partial<Parameters<typeof analyseQueue>[0]>;
const q = (rows: DayRow[], over: Over = {}) => analyseQueue({ id: 'q', name: 'Support', openSlot: 0, closeSlot: 96, volumeBasis: 'OFFERED', rows, ...over }, TODAY);
const codes = (r: ReturnType<typeof q>) => r.findings.map((f) => f.code);

describe('history quality', () => {
  it('calls a long, clean history good and says nothing', () => {
    const r = q(history(120));
    assert.equal(r.status, 'GOOD'); assert.deepEqual(r.findings, []); assert.equal(r.repairedDays, 0); assert.equal(r.days, 120);
  });
  it('refuses to call no history, or under four weeks, fit', () => {
    assert.equal(q([]).status, 'POOR'); assert.deepEqual(codes(q([])), ['NO_HISTORY']);
    const short = q(history(20)); assert.equal(short.status, 'POOR'); assert.ok(codes(short).includes('SHORT'));
    assert.equal(q(history(40)).status, 'CHECK', 'four to eight weeks is enough to start but is flagged');
  });
  it('finds days with no data inside the history, and counts them as repaired', () => {
    const r = q(history(120, (i, row) => (i === 50 || i === 51 ? null : row)));
    const f = r.findings.find((x) => x.code === 'MISSING_DAYS')!;
    assert.equal(f.count, 2); assert.equal(f.days!.length, 2); assert.equal(r.repairedDays, 2); assert.equal(r.status, 'CHECK');
  });
  it('finds a feed that stopped: stale data', () => {
    const r = q(history(100).slice(0, 90));       // the last ten days are missing from the end
    const f = r.findings.find((x) => x.code === 'STALE')!;
    assert.ok(f && f.count! >= 10 && f.severity === 'CRITICAL', JSON.stringify(r.findings));
  });
  it('finds days that are cut short, and days far below or far above the usual for their weekday', () => {
    const r = q(history(120, (i, row) => (i === 30 ? { ...row, intervals: 40, volume: 400 } : i === 60 ? { ...row, volume: 20 } : i === 90 ? { ...row, volume: 9000 } : row)));
    assert.ok(codes(r).includes('PARTIAL_DAYS')); assert.ok(codes(r).includes('LOW_DAYS')); assert.ok(codes(r).includes('SPIKE_DAYS'));
    assert.ok(r.repairedDays >= 2);
  });
  it('does not treat a quiet weekend as an outage: each day is compared with the same weekday', () => {
    assert.ok(!codes(q(history(120))).includes('LOW_DAYS'));
  });
  it('respects the hours a queue is open', () => {
    const r = q(history(120, (_i, row) => ({ ...row, intervals: 48 })), { openSlot: 32, closeSlot: 80 });    // open 08:00 to 20:00: 48 intervals is a full day
    assert.ok(!codes(r).includes('PARTIAL_DAYS'));
  });
  it('suggests answered-calls-only when many callers abandon, and warns when that setting has no abandoned data', () => {
    const heavy = q(history(120, (_i, row) => ({ ...row, abandoned: row.volume * 0.12 })));
    assert.ok(codes(heavy).includes('ABANDON_BASIS')); assert.ok(heavy.abandonRatePct! >= 11);
    const answered = q(history(120, (_i, row) => ({ ...row, abandoned: 0 })), { volumeBasis: 'ANSWERED' });
    assert.ok(codes(answered).includes('ABANDON_MISSING'));
  });
  it('puts the worst problems first', () => {
    const r = q(history(60, (i, row) => (i === 10 ? null : { ...row, ahtOutliers: i === 20 ? 3 : 0 })).slice(0, 50));
    const sev = r.findings.map((f) => f.severity), order = { CRITICAL: 0, WARNING: 1, INFO: 2 };
    assert.deepEqual([...sev].sort((a, b) => order[a] - order[b]), sev);
  });
});

describe('plain-language advice on each finding', () => {
  it('gives every finding a kind, a title, what it means and a fix', () => {
    const r = q(history(100).slice(0, 56));
    const st = r.findings.find((f) => f.code === 'STALE')!;
    assert.equal(st.kind, 'CAUTION'); assert.equal(st.title, 'Newest data is 45 days old'); assert.match(st.effect!, /less sharp/); assert.deepEqual(st.fix, { action: 'IMPORT', label: 'Import the latest data' });
    assert.ok(r.findings.every((f) => f.kind && f.title && f.effect !== undefined));
  });
  it('only a missing history blocks; stale and short are cautions; optional things are tips', () => {
    assert.equal(q([]).findings[0].kind, 'BLOCK');
    assert.equal(q(history(20)).findings.find((f) => f.code === 'SHORT')!.kind, 'CAUTION');
    const spiky = q(history(120, (i, row) => (i === 90 ? { ...row, volume: 9000 } : row)));
    assert.equal(spiky.findings.find((f) => f.code === 'SPIKE_DAYS')!.kind, 'TIP');
  });
  it('the abandoned-calls finding offers the one-click setting', () => {
    const heavy = q(history(120, (_i, row) => ({ ...row, abandoned: row.volume * 0.12 })));
    assert.deepEqual(heavy.findings.find((f) => f.code === 'ABANDON_BASIS')!.fix!.action, 'SET_ANSWERED');
  });
});

describe('length and freshness are two separate facts', () => {
  it('a long history that is old is good on length and behind on freshness', () => {
    const r = q(history(100).slice(0, 90));
    assert.deepEqual(r.length, { level: 'GOOD', days: 90 }); assert.equal(r.freshness.level, 'OLD'); assert.equal(r.freshness.daysBehind, 11);
  });
  it('current data reads as current, and a short history as low', () => {
    const r = q(history(20)); assert.equal(r.freshness.level, 'CURRENT'); assert.equal(r.length.level, 'LOW');
    assert.equal(q(history(40)).length.level, 'OK');
  });
});

describe('how old is out of date can be set', () => {
  const old = () => history(100).slice(0, 94);
  it('is three days by default: a week-old feed is flagged as a caution', () => {
    const f = q(old()).findings.find((x) => x.code === 'STALE')!;
    assert.ok(f && f.severity === 'WARNING');
    assert.ok(!codes(q(history(100).slice(0, 98))).includes('STALE'), 'two days behind is fine by default');
  });
  it('a group that imports weekly can raise it so a normal gap is not flagged', () => {
    const r = analyseQueue({ id: 'q', name: 'S', openSlot: 0, closeSlot: 96, volumeBasis: 'OFFERED', rows: old() }, TODAY, { staleAfterDays: 8 });
    assert.ok(!r.findings.some((f) => f.code === 'STALE')); assert.equal(r.freshness.level, 'CURRENT');
  });
  it('becomes serious at twice the limit, and at least seven days', () => {
    const at = (n: number, limit: number) => analyseQueue({ id: 'q', name: 'S', openSlot: 0, closeSlot: 96, volumeBasis: 'OFFERED', rows: history(100).slice(0, 100 - n + 1) }, TODAY, { staleAfterDays: limit }).findings.find((x) => x.code === 'STALE')?.severity;
    assert.equal(at(8, 3), 'CRITICAL'); assert.equal(at(7, 3), 'WARNING'); assert.equal(at(12, 8), 'WARNING'); assert.equal(at(17, 8), 'CRITICAL');
  });
});

describe('demand from history', () => {
  it('leaves an offered-calls volume alone', () => { assert.equal(demandVolume(100, 20, 'OFFERED', 0), 100); });
  it('adds abandoned callers back to an answered-calls volume', () => { assert.equal(demandVolume(100, 20, 'ANSWERED', 0), 120); });
  it('leaves out the share of abandoned callers who ring again', () => {
    assert.equal(demandVolume(100, 20, 'ANSWERED', 50), 110);
    assert.equal(demandVolume(100, 20, 'ANSWERED', 100), 100);
    assert.equal(demandVolume(100, 20, 'ANSWERED', 150), 100, 'a share over 100 is capped');
    assert.equal(demandVolume(100, -5, 'ANSWERED', 0), 100, 'a bad count never lowers demand');
  });
});
