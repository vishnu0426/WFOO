import { test, expect, Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import fs from 'node:fs';
import path from 'node:path';
import { ADMIN_SCREENS, ADMIN_URL, OUT, record } from './helpers';

const SHOTS = path.resolve(OUT, '../screens');
fs.mkdirSync(SHOTS, { recursive: true });

/** Wait until the app has stopped fetching (WebSocket traffic is ignored) and spinners are gone. */
async function settle(page: Page, inflight: Set<string>) {
  const t0 = Date.now();
  while (Date.now() - t0 < 25_000) {
    const busy = inflight.size > 0 || (await page.locator('.animate-spin').count().catch(() => 0)) > 0;
    if (!busy) { await page.waitForTimeout(400); if (inflight.size === 0) return Date.now() - t0; }
    await page.waitForTimeout(150);
  }
  return Date.now() - t0;
}

for (const [module, subs] of Object.entries(ADMIN_SCREENS)) {
  test.describe(`Admin › ${module}`, () => {
    for (const sub of subs) {
      const url = `/${module}${sub ? '/' + sub : ''}`;
      test(`screen ${url} loads cleanly`, async ({ page }) => {
        const consoleErrors: string[] = [], pageErrors: string[] = [], failed: string[] = [], slow: string[] = [];
        const inflight = new Set<string>();
        page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 300)); });
        page.on('pageerror', (e) => pageErrors.push(e.message.slice(0, 300)));
        page.on('request', (r) => { if (r.url().includes('/api/')) inflight.add(r.url() + '#' + r.method()); });
        page.on('requestfailed', (r) => { inflight.delete(r.url() + '#' + r.method()); if (r.url().includes('/api/')) failed.push(`${r.method()} ${r.url().replace(ADMIN_URL, '')} FAILED ${r.failure()?.errorText}`); });
        page.on('response', async (r) => {
          const u = r.url(); if (!u.includes('/api/')) return;
          inflight.delete(u + '#' + r.request().method());
          const timing = r.request().timing(); const ms = timing.responseEnd > 0 ? timing.responseEnd : 0;
          if (ms > 2000) slow.push(`${r.request().method()} ${u.replace(ADMIN_URL, '')} ${Math.round(ms)}ms`);
          if (r.status() >= 400) { let msg = ''; try { msg = JSON.stringify((await r.json())?.error ?? '').slice(0, 200); } catch { /* not json */ } failed.push(`${r.request().method()} ${u.replace(ADMIN_URL, '')} -> ${r.status()} ${msg}`); }
        });

        const t0 = Date.now();
        await page.goto(ADMIN_URL + url, { waitUntil: 'domcontentloaded' });
        const settleMs = await settle(page, inflight);
        const loadMs = Date.now() - t0;

        const crashed = await page.getByText('This screen hit a problem').isVisible().catch(() => false);
        const crashMsg = crashed ? await page.locator('h2:has-text("This screen hit a problem") + p').innerText().catch(() => '') : '';
        const gatewayDown = await page.getByText(/Cannot reach the WFM gateway/i).isVisible().catch(() => false);
        const onLogin = await page.getByRole('button', { name: /^Sign in$/ }).isVisible().catch(() => false);
        const urlNow = new URL(page.url()).pathname;
        const heading = (await page.locator('main h1, main h2, h1').first().innerText().catch(() => '')).slice(0, 80);
        const bodyText = await page.locator('body').innerText().catch(() => '');
        const visibleErrors = [...new Set((bodyText.match(/^(?:.*(?:error|failed|could not|went wrong|not reachable|unavailable).*)$/gim) ?? []).map((s) => s.trim()).filter((s) => s.length < 200))].slice(0, 6);
        const unrendered = (bodyText.match(/\b(undefined|NaN|\[object Object\]|Invalid Date|null)\b/g) ?? []);

        let axe: { id: string; impact: string | null | undefined; nodes: number; help: string }[] = [];
        try {
          const res = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze();
          axe = res.violations.map((v) => ({ id: v.id, impact: v.impact, nodes: v.nodes.length, help: v.help }));
        } catch (e) { axe = [{ id: 'axe-failed', impact: 'minor', nodes: 0, help: String(e).slice(0, 120) }]; }

        const shot = `${module}${sub ? '-' + sub : ''}.png`;
        await page.screenshot({ path: path.join(SHOTS, shot), fullPage: false });

        record('admin-crawl', { module, sub, url, urlNow, heading, loadMs, settleMs, crashed, crashMsg, gatewayDown, onLogin, consoleErrors: [...new Set(consoleErrors)], pageErrors, failed: [...new Set(failed)], slow, visibleErrors, unrendered: [...new Set(unrendered)], axe, shot });

        expect.soft(onLogin, 'session kept (not bounced to login)').toBe(false);
        expect.soft(urlNow, 'deep link stays on the requested screen').toBe(url === '/overview' ? '/overview' : url);
        expect.soft(crashed, `error boundary: ${crashMsg}`).toBe(false);
        expect.soft(pageErrors, 'uncaught JS errors').toEqual([]);
        expect.soft(failed.filter((f) => / -> 5\d\d| FAILED /.test(f)), 'server errors / failed requests').toEqual([]);
        expect.soft(axe.filter((a) => a.impact === 'critical'), 'critical a11y violations').toEqual([]);
      });
    }
  });
}
