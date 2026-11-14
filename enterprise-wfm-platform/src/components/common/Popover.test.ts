/** The closed state of the toolbar popover, rendered to HTML (opening needs a browser).  backend/gateway/node_modules/.bin/tsx --test src/components/common/Popover.test.ts */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Popover } from './Popover.tsx';

const render = (p: Record<string, unknown> = {}) => renderToStaticMarkup(React.createElement(Popover, { label: 'Filters', children: () => React.createElement('p', null, 'inside'), ...p } as any));

describe('popover', () => {
  it('starts closed: a button that says it opens something, and nothing inside drawn', () => {
    const html = render();
    assert.match(html, /aria-haspopup="true"/); assert.match(html, /aria-expanded="false"/); assert.match(html, /Filters/); assert.doesNotMatch(html, /inside|role="dialog"/);
  });
  it('shows how many things are set inside it, and nothing when none are', () => {
    assert.match(render({ badge: 2 }), /rounded-full[^>]*>2</);
    assert.doesNotMatch(render({ badge: 0 }), /rounded-full/);
  });
  it('an icon-only one has an accessible name and no arrow', () => {
    const html = render({ iconOnly: true, ariaLabel: 'More actions', label: 'x' });
    assert.match(html, /aria-label="More actions"/); assert.doesNotMatch(html, /lucide-chevron-down/);
  });
});
