/** The PDF of a report: a real PDF, a header on every page, a page count, a logo, and a note when the table is cut short. */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { toPdf } from '../src/modules/reportPdf.ts';

// a 1x1 transparent PNG
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
const base = { title: 'Next week roster', subtitle: 'Roster · 2026-11-02 to 2026-11-08', orgName: 'My Organisation', logo: null, generatedAt: '30 Oct 2026, 09:00 (UTC)' };
const pages = (b: Buffer) => (b.toString('latin1').match(/\/Type\s*\/Page\b/g) ?? []).length;

describe('toPdf', () => {
  it('makes a PDF from a small table', async () => {
    const b = await toPdf({ ...base, columns: ['Date', 'Name', 'Hours'], rows: [['2026-11-02', 'Asha Rao', 8], ['2026-11-03', 'Ben Cole', 7.5]] });
    assert.equal(b.subarray(0, 5).toString(), '%PDF-');
    assert.equal(pages(b), 1);
  });
  it('runs a long table over several pages', async () => {
    const rows = Array.from({ length: 200 }, (_, i) => [`2026-11-${String(1 + (i % 28)).padStart(2, '0')}`, `Person ${i}`, 'Team', 'Group', '09:00', '17:00', 'Day shift', 'x']);
    const b = await toPdf({ ...base, columns: ['Date', 'Name', 'Team', 'Group', 'Start', 'End', 'Shift', 'Note'], rows });
    assert.ok(pages(b) > 2, `pages: ${pages(b)}`);
    assert.ok(b.toString('latin1').includes('Next week roster'));
  });
  it('draws a logo and still works when the logo is not a picture', async () => {
    const withLogo = await toPdf({ ...base, logo: PNG, columns: ['A'], rows: [['x']] });
    assert.ok(withLogo.length > 0 && withLogo.toString('latin1').includes('/Subtype /Image'));
    const broken = await toPdf({ ...base, logo: Buffer.from('not a picture'), columns: ['A'], rows: [['x']] });
    assert.equal(broken.subarray(0, 5).toString(), '%PDF-');
  });
  it('handles no rows, odd letters and a cut-short table', async () => {
    assert.equal((await toPdf({ ...base, columns: ['A', 'B'], rows: [] })).subarray(0, 5).toString(), '%PDF-');
    assert.equal((await toPdf({ ...base, columns: ['Name'], rows: [['Ānanda 日本']] })).subarray(0, 5).toString(), '%PDF-');
    const cut = await toPdf({ ...base, columns: ['A'], rows: Array.from({ length: 30 }, (_, i) => [i]), maxRows: 10 });
    assert.ok(cut.length > 0);
  });
});
