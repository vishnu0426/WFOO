/** Phone-size layout (Pixel 7, 412px): no horizontal scroll, navigation usable, key screens readable. */
import { test, expect, Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { ADMIN_URL, PORTAL_URL, OUT_ROOT, record, testData, TENANT } from './helpers';

const SHOTS = path.join(OUT_ROOT, 'screens'); fs.mkdirSync(SHOTS, { recursive: true });
const overflow = (page: Page) => page.evaluate(() => ({ docW: document.documentElement.scrollWidth, viewW: window.innerWidth, mainW: (document.querySelector('main') as HTMLElement | null)?.getBoundingClientRect().width ?? 0, asideW: (document.querySelector('aside') as HTMLElement | null)?.getBoundingClientRect().width ?? 0 }));

test('R-01 employee portal on a phone', async ({ page }) => {
  await page.goto(PORTAL_URL + '/');
  const login = await overflow(page);
  await page.screenshot({ path: path.join(SHOTS, 'mobile-portal-login.png') });
  const org = page.getByLabel(/Organisation code/i); if (await org.isVisible().catch(() => false)) await org.fill(TENANT);
  await page.getByLabel(/^Username/).fill('demo.agent1');
  await page.getByLabel(/^Password/).fill(testData.agentPassword);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.getByText(/^Hi, /).waitFor({ timeout: 15_000 });
  const out: Record<string, unknown> = { login };
  for (const t of ['Home', 'Schedule', 'Requests']) {
    await page.getByRole('button', { name: t, exact: true }).click().catch(() => {});
    await page.waitForTimeout(1200);
    out[t] = await overflow(page);
    await page.screenshot({ path: path.join(SHOTS, `mobile-portal-${t.toLowerCase()}.png`), fullPage: true });
  }
  const home = out.Home as any;
  const ok = home.docW <= home.viewW + 2 && home.mainW >= home.viewW * 0.7;
  record('responsive', { app: 'portal', ok, detail: out, note: 'sidebar is a fixed 224px column (w-56) with no mobile layout' });
  expect.soft(home.docW, 'horizontal scroll on phone').toBeLessThanOrEqual(home.viewW + 2);
  expect.soft(home.mainW, 'content squeezed by the fixed sidebar').toBeGreaterThanOrEqual(home.viewW * 0.7);
});

test('R-02 admin app on a phone', async ({ browser }) => {
  const ctx = await browser.newContext({ viewport: { width: 412, height: 915 }, isMobile: true, hasTouch: true, storageState: '.auth/admin.json' });
  const page = await ctx.newPage();
  const out: Record<string, unknown> = {};
  for (const u of ['/overview', '/workforce/employees', '/scheduling/schedule-timeline']) {
    await page.goto(ADMIN_URL + u); await page.waitForTimeout(3000);
    out[u] = await overflow(page);
    await page.screenshot({ path: path.join(SHOTS, `mobile-admin${u.replace(/\//g, '-')}.png`) });
  }
  const o = out['/overview'] as any;
  record('responsive', { app: 'admin', ok: o.docW <= o.viewW + 2, detail: out });
  expect.soft(o.docW, 'admin overview scrolls sideways on a phone').toBeLessThanOrEqual(o.viewW + 2);
  await ctx.close();
});
