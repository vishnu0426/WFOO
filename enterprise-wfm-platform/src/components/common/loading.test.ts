/**
 * What the loading states put on screen, checked by rendering each one to HTML (no browser needed). The timing rules (nothing for the first moment, a
 * skeleton that stays a moment, the "taking longer" note) live in the hooks and are not exercised here.
 *   backend/gateway/node_modules/.bin/tsx --test src/components/common/loading.test.ts     (from the project root)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { LoadFailed, LoadState, PageSkeleton, StaleNote, TableSkeleton, Waiting, type LoadSource } from './loading.tsx';

const h = React.createElement;
const src = <T,>(p: Partial<LoadSource<T>>): LoadSource<T> => ({ data: null, error: '', loading: false, ...p });
const show = (state: LoadSource<string[]>, extra: Record<string, unknown> = {}) =>
  renderToStaticMarkup(h(LoadState<string[]>, { state, what: 'the groups', delayMs: 0, empty: h('p', null, 'No groups yet'), isEmpty: (d: string[]) => d.length === 0, children: (d: string[]) => h('ul', null, d.map((x) => h('li', { key: x }, x))), ...extra }));

describe('loading states', () => {
  it('first load: a skeleton in the shape of the data, announced to screen readers, and never the "nothing yet" message', () => {
    const html = show(src({ loading: true }));
    assert.match(html, /role="status"/); assert.match(html, /aria-busy="true"/); assert.match(html, /Loading the groups/);
    assert.match(html, /aria-hidden="true"/, 'the grey bars are hidden from screen readers');
    assert.doesNotMatch(html, /No groups yet/, 'still loading is not the same as empty');
  });
  it('first load, before the short pause is over: only a placeholder, so a fast answer does not flash a skeleton', () => {
    const html = show(src({ loading: true }), { delayMs: 200 });
    assert.match(html, /min-h-\[96px\]/); assert.doesNotMatch(html, /motion-safe:animate-pulse/);
  });
  it('failed with nothing to show: says what failed and offers a retry', () => {
    const html = show(src({ error: 'The server is busy', reload: () => undefined }));
    assert.match(html, /role="alert"/); assert.match(html, /The groups could not be loaded/); assert.match(html, /The server is busy/); assert.match(html, /Try again/);
  });
  it('failed with no way to retry: no button', () => {
    assert.doesNotMatch(show(src({ error: 'Nope' })), /Try again/);
  });
  it('a refresh that fails keeps the information on screen, with a warning', () => {
    const html = show(src({ data: ['Sales'], error: 'The server is busy', reload: () => undefined }));
    assert.match(html, /<li>Sales<\/li>/); assert.match(html, /Could not refresh the groups: The server is busy/); assert.match(html, /The last information is shown/); assert.match(html, /Try again/);
  });
  it('a refresh in progress shows the information with a quiet "Updating…"', () => {
    const html = show(src({ data: ['Sales'], refreshing: true }));
    assert.match(html, /<li>Sales<\/li>/); assert.match(html, /Updating…/); assert.match(html, /aria-live="polite"/);
  });
  it('information that is there is shown plainly', () => {
    const html = show(src({ data: ['Sales', 'Support'] }));
    assert.match(html, /<li>Sales<\/li><li>Support<\/li>/); assert.doesNotMatch(html, /Updating…|Could not/);
  });
  it('loaded and empty: the empty message, not a blank', () => {
    const html = show(src({ data: [] }));
    assert.match(html, /No groups yet/); assert.doesNotMatch(html, /<ul>/);
  });
  it('nothing asked for: nothing drawn', () => {
    assert.equal(show(src({})), '');
  });
  it('a page skeleton says what it is loading, and a table skeleton has the rows and columns asked for', () => {
    assert.match(renderToStaticMarkup(h(PageSkeleton, { label: 'the schedule' })), /Loading the schedule/);
    const t = renderToStaticMarkup(h(TableSkeleton, { rows: 3, cols: 4 }));
    assert.equal((t.match(/border-b border-\[#F0F0EB\]/g) ?? []).length, 3, 'three body rows');
  });
});

describe('drop-ins for screens that branch on loading themselves', () => {
  it('Waiting announces what is loading, shows the skeleton when there is no pause, and offers no retry until it is slow', () => {
    const html = renderToStaticMarkup(h(Waiting, { what: 'pay runs', delayMs: 0, reload: () => undefined }));
    assert.match(html, /role="status"/); assert.match(html, /aria-busy="true"/); assert.match(html, /Loading pay runs/); assert.match(html, /motion-safe:animate-pulse/);
    assert.doesNotMatch(html, /Try again|taking longer/);
  });
  it('Waiting draws only a placeholder during the first pause', () => {
    const html = renderToStaticMarkup(h(Waiting, { what: 'pay runs' }));
    assert.match(html, /min-h-\[96px\]/); assert.doesNotMatch(html, /motion-safe:animate-pulse/);
  });
  it('Waiting uses the shape asked for', () => {
    assert.match(renderToStaticMarkup(h(Waiting, { what: 'x', delayMs: 0, shape: 'cards' })), /grid-cols-2/);
    assert.match(renderToStaticMarkup(h(Waiting, { what: 'x', delayMs: 0, shape: 'table' })), /border-b border-\[#F0F0EB\]/);
  });
  it('LoadFailed says what failed and why, and offers a retry only when there is one', () => {
    const a = renderToStaticMarkup(h(LoadFailed, { what: 'users', error: 'Server busy', reload: () => undefined }));
    assert.match(a, /role="alert"/); assert.match(a, /Users could not be loaded/); assert.match(a, /Server busy/); assert.match(a, /Try again/);
    assert.doesNotMatch(renderToStaticMarkup(h(LoadFailed, { what: 'users', error: 'x' })), /Try again/);
  });
  it('StaleNote warns only when there is information on screen and the refresh failed', () => {
    const note = (st: LoadSource<string[]>) => renderToStaticMarkup(h(StaleNote, { state: st, what: 'coverage' }));
    assert.match(note(src({ data: ['a'], error: 'Server busy', reload: () => undefined })), /Could not refresh coverage: Server busy/);
    assert.equal(note(src({ data: ['a'] })), '');
    assert.equal(note(src({ error: 'Server busy' })), '', 'nothing on screen, so the error card is the other piece task');
  });
});
