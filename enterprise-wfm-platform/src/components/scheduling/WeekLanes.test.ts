/** What the week view draws, checked by rendering it to HTML.  backend/gateway/node_modules/.bin/tsx --test src/components/scheduling/WeekLanes.test.ts */
import { before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
// the shared api module reads localStorage when it loads
(globalThis as any).localStorage ??= { getItem: () => null, setItem: () => undefined, removeItem: () => undefined };
let WeekLanes: any;
before(async () => { WeekLanes = (await import('./WeekLanes.tsx')).WeekLanes; });

const shift = (id: string, employeeId: string, name: string, day: string, over: Record<string, unknown> = {}) => ({
  id, employeeId, employeeName: name, employeeNumber: 'E' + employeeId, teamName: 'Support', day, templateId: 't', templateName: 'Day', startTime: '09:00', endTime: '17:00',
  startSlot: 36, lengthSlots: 32, overnight: false, source: 'SOLVER', activities: [{ type: 'MEAL', startSlot: 52, slots: 4 }], ...over,
}) as any;
const days = ['2026-11-09', '2026-11-10', '2026-11-11'];
const render = (p: Record<string, unknown> = {}) => renderToStaticMarkup(React.createElement(WeekLanes, {
  shifts: [shift('1', 'a', 'Asha', days[0]), shift('2', 'a', 'Asha', days[1]), shift('3', 'b', 'Ben', days[0])], days, bad: new Set<string>(), groupBy: false, compact: false, dayPercent: new Map(), onPickDay: () => undefined, onOpen: () => undefined, ...p,
}));

describe('week lanes', () => {
  it('one lane per person, with the paid hours (unpaid meal taken off)', () => {
    const html = render();
    assert.match(html, /Asha/); assert.match(html, /Ben/);
    assert.match(html, />7<\/div>/, 'Ben: 8h shift minus a 1h meal');
    assert.match(html, />14<\/div>/, 'Asha: two days of 7h');
  });
  it('a day off is drawn as off, and a day with a shift says when', () => {
    const html = render();
    assert.match(html, /Ben, 2026-11-10: off/); assert.match(html, /Asha, 2026-11-09: 09:00 to 17:00/);
  });
  it('a day that breaks a rule is marked in words as well as colour', () => {
    const html = render({ bad: new Set(['a|2026-11-09']) });
    assert.match(html, /09:00 to 17:00, breaks a rule/); assert.match(html, /bg-\[#C9605F\]/);
  });
  it('the day columns show how well each day is covered', () => {
    const html = render({ dayPercent: new Map([[days[0], 97.2], [days[1], 80]]) });
    assert.match(html, /97%/); assert.match(html, /80%/);
  });
  it('grouping by team adds a collapsible header with the head count', () => {
    const html = render({ groupBy: true });
    assert.match(html, /aria-expanded="true"/); assert.match(html, /Support <span[^>]*>\(2\)/);
  });
  it('nobody working that week says so', () => {
    assert.match(render({ shifts: [] }), /Nobody matches this week/);
  });
});
