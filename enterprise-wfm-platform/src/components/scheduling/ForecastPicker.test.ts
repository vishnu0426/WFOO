/** The closed forecast picker, rendered to HTML (opening it needs a browser).  backend/gateway/node_modules/.bin/tsx --test src/components/scheduling/ForecastPicker.test.ts */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ForecastPicker } from './ForecastPicker.tsx';
import { forecastChoices, type Fv } from '../../services/liveForecasts.ts';

const fv = (seq: number, status: string, from: string, to: string, name = `Short-term v${seq} · 2 wk from 16 Nov`): Fv => ({ id: `id${seq}`, seq, name, status, kind: 'SHORT', fromDay: from, toDay: to, publishedAt: '2026-11-12T00:00:00Z' });
const choices = forecastChoices({ from: '2026-11-16', to: '2026-11-29', forecasts: [fv(8, 'PUBLISHED', '2026-11-16', '2026-11-29'), fv(7, 'DRAFT', '2026-11-16', '2026-11-29')] });
const render = (value = 'AUTO', extra: Record<string, unknown> = {}) => renderToStaticMarkup(React.createElement(ForecastPicker, { value, onChange: () => {}, choices, accuracy: {}, yearOf: 2026, showUnapproved: false, onShowUnapproved: () => {}, showOld: false, onShowOld: () => {}, ...extra } as any));

describe('the forecast picker, closed', () => {
  it('says which forecast Automatic will use, in a short line, and lists nothing until opened', () => {
    const html = render();
    assert.match(html, /Automatic/);
    assert.match(html, /Forecast v8 · Nov 16 – 29/);
    assert.match(html, /aria-haspopup="listbox"/);
    assert.match(html, /aria-expanded="false"/);
    assert.ok(!/role="listbox"/.test(html), 'the list is not drawn until it is opened');
  });
  it('shows the forecast that is chosen, with its state and coverage', () => {
    const html = render('id8');
    assert.match(html, /Forecast v8/);
    assert.match(html, /Live · covers all 14 days · Nov 16 – 29/);
  });
  it('still shows a draft that is already chosen, so a choice is never hidden', () => {
    assert.match(render('id7'), /Draft · covers all 14 days/);
  });
});


const live = (seq: number, name: string, to: string, published: string) => ({ ...fv(seq, 'PUBLISHED', '2026-11-16', to, name), publishedAt: published, publishedBy: 'Administrator' });
const scene = forecastChoices({ from: '2026-11-23', to: '2026-11-29', forecasts: [
  live(8, 'November campaign', '2026-11-29', '2026-11-18T00:00:00Z'), live(6, 'Nov-camp', '2026-12-27', '2026-11-17T00:00:00Z'), fv(7, 'DRAFT', '2026-11-23', '2026-11-29'),
  ...[5, 4, 3, 2].map((n) => fv(n, 'DRAFT', '2026-09-29', '2026-11-09')), { ...fv(9, 'PUBLISHED', '2026-12-01', '2027-01-04'), publishedAt: '2026-11-15T00:00:00Z' }] });
const open = (value = 'AUTO', extra: Record<string, unknown> = {}) => renderToStaticMarkup(React.createElement(ForecastPicker, { value, onChange: () => {}, choices: scene, accuracy: { id6: { state: 'SPARSE', days: 2, accuracyPct: 85.6 } }, yearOf: 2026, showUnapproved: false, onShowUnapproved: () => {}, showOld: false, onShowOld: () => {}, defaultOpen: true, ...extra } as any));

describe('the forecast picker, open', () => {
  it('marks the chosen option with a filled dot, and only that one', () => {
    const html = open();
    assert.equal((html.match(/aria-selected="true"/g) ?? []).length, 1);
    assert.match(html, /aria-selected="true"[^>]*>(?:(?!<\/button>).)*?bg-\[#171717\]/s, 'the chosen row has the filled dot');
  });
  it('says what Automatic uses once in the panel, in full', () => {
    const html = open();
    assert.equal((html.match(/Uses November campaign \(v8\) · live · covers all 7 days \(Nov 16 – 29\)/g) ?? []).length, 1);
  });
  it('writes every date in one style, and puts no date in the heading', () => {
    const html = open();
    assert.match(html, /Can be used for this schedule/);
    assert.match(html, /Nov 16 – 29/);
    assert.ok(!/\d{1,2} (Nov|Dec)\b/.test(html.replace(/<[^>]+>/g, ' ')), 'no "16 Nov" style dates');
  });
  it('keeps the rows that are all live and covering quiet: no Live or Covers chip, only what is unusual', () => {
    const html = open();
    const usable = html.slice(html.indexOf('Can be used for'), html.indexOf('more forecasts'));
    assert.ok(!/>Live</.test(usable) && !/Covers all/.test(usable));
    assert.match(usable, /Automatic uses this/);
    assert.match(usable, /Automatic prefers November campaign for these dates/);
  });
  it('shows no percentage from two days', () => {
    const html = open();
    assert.match(html, /Too early to judge \(2 days so far\)/);
    assert.ok(!/85\.6/.test(html));
  });
  it('has no empty heading: what is hidden is said once, in the footer', () => {
    const html = open();
    assert.ok(!/Not approved yet|Not published yet/.test(html), 'no heading for hidden forecasts');
    assert.match(html, /6 more forecasts are hidden: 1 not published yet, 5 that do not reach these dates/);
    assert.ok(!/type="checkbox"/.test(html), 'no checkboxes');
  });
  it('shows them under their own headings when asked, with the warning on a draft', () => {
    const html = open('AUTO', { showUnapproved: true });
    assert.match(html, /Not published yet/);
    assert.match(html, /Do not reach these dates/);
    assert.match(html, /Not approved: fine for a trial schedule/);
    assert.ok(!/more forecasts are hidden/.test(html));
    assert.match(html, /Hide forecasts that are not published or do not reach these dates/);
  });
});

describe('while the forecasts load, or fail to', () => {
  it('says so, instead of "no published forecast reaches these dates"', () => {
    const none = (state: string) => renderToStaticMarkup(React.createElement(ForecastPicker, { value: 'AUTO', onChange: () => {}, choices: [], accuracy: {}, yearOf: 2026, showUnapproved: false, onShowUnapproved: () => {}, showOld: false, onShowOld: () => {}, state, defaultOpen: true } as any));
    assert.match(none('loading'), /Loading the forecasts…/);
    assert.ok(!/No published forecast reaches these dates/.test(none('loading')));
    assert.match(none('error'), /could not be loaded/);
    assert.ok(!/No published forecast reaches these dates/.test(none('error')));
  });
  it('still says no forecast reaches the dates once they have loaded and none does', () => {
    const html = renderToStaticMarkup(React.createElement(ForecastPicker, { value: 'AUTO', onChange: () => {}, choices: [], accuracy: {}, yearOf: 2026, showUnapproved: false, onShowUnapproved: () => {}, showOld: false, onShowOld: () => {}, state: null, defaultOpen: true } as any));
    assert.match(html, /No published forecast reaches these dates/);
  });
});
