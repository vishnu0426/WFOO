/** Admin web app (localhost:3000) — key user journeys through the real UI. */
import { test, expect } from '@playwright/test';
import { ADMIN_URL, ADMIN_USER, adminToken, call, record, testData, RUN, TENANT } from './helpers';

const log = (check: string, ok: boolean, detail: unknown = '') => record('admin-e2e', { check, ok, detail });

test.describe('Admin journeys', () => {
  let pageErrors: string[];
  test.beforeEach(async ({ page }) => { pageErrors = []; page.on('pageerror', (e) => pageErrors.push(e.message)); });
  test.afterEach(async () => { expect.soft(pageErrors, 'uncaught JS errors').toEqual([]); });

  test('A-01 wrong password is refused with a clear message', async ({ browser }) => {
    const ctx = await browser.newContext({ storageState: { cookies: [], origins: [] } }); const page = await ctx.newPage();
    await page.goto(ADMIN_URL + '/');
    const org = page.getByLabel(/Organisation code/i); if (await org.isVisible().catch(() => false)) await org.fill(TENANT);
    await page.getByLabel(/^Username/).fill(ADMIN_USER);
    await page.getByLabel(/^Password/).fill('wrong-' + RUN);
    await page.getByRole('button', { name: /^Sign in$/ }).click();
    const msg = await page.getByText(/invalid username or password/i).waitFor({ timeout: 10_000 }).then(() => true).catch(() => false);
    log('wrong admin password refused with message', msg); expect(msg).toBe(true);
    await ctx.close();
  });

  test('A-02 sidebar navigation, deep links, back/forward', async ({ page }) => {
    await page.goto(ADMIN_URL + '/overview');
    await page.locator('aside').getByText('Teams', { exact: true }).click();
    await expect(page).toHaveURL(/\/workforce\/teams$/);
    await page.locator('aside').getByText('Forecast Builder', { exact: true }).click();
    await expect(page).toHaveURL(/\/forecasting\/forecast-builder$/);
    await page.goBack(); await expect(page).toHaveURL(/\/workforce\/teams$/);
    await expect(page.locator('main')).toContainText('Teams');
    await page.goForward(); await expect(page).toHaveURL(/forecast-builder$/);
    await page.goto(ADMIN_URL + '/scheduling/shift-templates'); await page.reload();
    await expect(page).toHaveURL(/shift-templates$/);
    const unknown = await page.goto(ADMIN_URL + '/no-such-module/xyz').then(() => page.url());
    log('sidebar + deep link + back/forward', true, { unknownRouteLandsOn: unknown });
  });

  test('A-03 sidebar is reachable by keyboard (Tab)', async ({ page }) => {
    await page.goto(ADMIN_URL + '/overview');
    await page.waitForTimeout(1500);
    const seen = new Set<string>();
    for (let i = 0; i < 40; i++) {
      await page.keyboard.press('Tab');
      const info = await page.evaluate(() => { const a = document.activeElement as HTMLElement | null; return a ? `${a.tagName}|${a.closest('aside') ? 'aside' : 'main'}|${(a.innerText || a.getAttribute('aria-label') || '').slice(0, 30)}` : ''; });
      seen.add(info);
    }
    const asideStops = [...seen].filter((s) => s.includes('|aside|'));
    log('keyboard users can reach sidebar navigation', asideStops.length > 3, { asideStops: asideStops.slice(0, 10), totalStops: seen.size });
    expect.soft(asideStops.length, 'sidebar items are <div onClick> — not focusable').toBeGreaterThan(3);
  });

  test('A-04 command palette (Ctrl+K) finds and opens a screen', async ({ page }) => {
    await page.goto(ADMIN_URL + '/overview'); await page.waitForTimeout(1000);
    await page.keyboard.press('Control+k');
    const input = page.getByPlaceholder(/Type a command|Search screens/);
    await expect(input).toBeVisible();
    await input.fill('Shift Templates'); await page.waitForTimeout(700);
    const screenHit = !(await page.getByText(/No matching records or actions/).isVisible());
    log('command palette finds a screen by its name', screenHit, 'searched "Shift Templates"');
    await input.fill('Demo Support'); await page.waitForTimeout(700);
    const groupHit = !(await page.getByText(/No matching records or actions/).isVisible());
    log('command palette finds a WFM group by name', groupHit);
    if (groupHit) { await page.keyboard.press('Enter'); await page.waitForTimeout(1500); log('palette Enter opens the result', !page.url().endsWith('/overview'), page.url()); }
    expect.soft(screenHit, 'palette cannot find screens by name').toBe(true);

  });

  test('A-05 create a team via the UI, see it listed, stored XSS not executed', async ({ page }) => {
    const name = `QA-${RUN}-UI <img src=x onerror="window.__xss=1">`;
    await page.goto(ADMIN_URL + '/workforce/teams');
    await page.getByRole('button', { name: 'Add team' }).click();
    await page.getByLabel('Name').fill(name);
    await page.getByLabel('Location').fill('QA Lab');
    await page.getByRole('button', { name: 'Save team' }).click();
    await expect(page.locator('main')).toContainText(`QA-${RUN}-UI`, { timeout: 10_000 });
    await page.reload(); await page.waitForTimeout(2500);
    const xss = await page.evaluate(() => (window as any).__xss);
    log('team created from UI and listed after reload', true);
    log('team name with HTML is rendered as text (no XSS)', xss === undefined); expect(xss).toBeUndefined();
    const A = await adminToken();
    const t = ((await call(A, 'GET', '/workforce/teams')).body as any[]).find((x) => x.name === name);
    if (t) await call(A, 'DELETE', `/workforce/teams/${t.id}`);
    // empty name
    await page.getByRole('button', { name: 'Add team' }).click();
    const save = page.getByRole('button', { name: 'Save team' });
    const disabled = await save.isDisabled();
    if (!disabled) await save.click();
    const err = disabled || await page.getByText(/required|enter a name|name/i).first().isVisible().catch(() => false);
    log('empty team name blocked', err); expect.soft(err).toBe(true);
  });

  test('A-06 read-only role sees no write actions', async ({ browser }) => {
    const ctx = await browser.newContext({ storageState: { cookies: [], origins: [] } }); const page = await ctx.newPage();
    await page.goto(ADMIN_URL + '/');
    const org = page.getByLabel(/Organisation code/i); if (await org.isVisible().catch(() => false)) await org.fill(TENANT);
    await page.getByLabel(/^Username/).fill('qa.analyst');
    await page.getByLabel(/^Password/).fill(testData.rolePassword);
    await page.getByRole('button', { name: /^Sign in$/ }).click();
    await page.waitForTimeout(3000);
    await page.goto(ADMIN_URL + '/workforce/teams'); await page.waitForTimeout(2500);
    const add = await page.getByRole('button', { name: 'Add team' }).isVisible().catch(() => false);
    const addEnabled = add && await page.getByRole('button', { name: 'Add team' }).isEnabled();
    let outcome = 'hidden';
    if (addEnabled) {
      await page.getByRole('button', { name: 'Add team' }).click();
      await page.getByLabel('Name').fill(`QA-${RUN}-analyst`);
      await page.getByRole('button', { name: 'Save team' }).click();
      outcome = (await page.getByText(/not allowed|permission|forbidden/i).first().isVisible({ timeout: 5000 }).catch(() => false)) ? 'shown, server refuses with message' : 'shown, unclear result';
    }
    await page.goto(ADMIN_URL + '/administration/users'); await page.waitForTimeout(2000);
    const usersTxt = (await page.locator('main').innerText().catch(() => '')).slice(0, 200);
    log('ANALYST: write actions hidden or refused clearly', outcome !== 'shown, unclear result', { addTeamButton: outcome, usersScreen: usersTxt.replace(/\n+/g, ' | ') });
    expect.soft(outcome).not.toBe('shown, unclear result');
    await ctx.close();
  });

  test('A-07 corrupted / expired session returns to sign-in cleanly', async ({ page }) => {
    await page.goto(ADMIN_URL + '/overview');
    await page.evaluate(() => localStorage.setItem('wfm_token', 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.invalid'));
    await page.goto(ADMIN_URL + '/workforce/employees');
    const login = await page.getByRole('button', { name: /^Sign in$/ }).waitFor({ timeout: 15_000 }).then(() => true).catch(() => false);
    log('invalid stored token -> sign-in screen', login); expect(login).toBe(true);
  });

  test('A-08 sign out from the header', async ({ browser }) => {
    const ctx = await browser.newContext({ storageState: { cookies: [], origins: [] } }); const page = await ctx.newPage();
    await page.goto(ADMIN_URL + '/');   // its own session: signing out revokes the token server-side, so the shared one must not be used
    const org = page.getByLabel(/Organisation code/i); if (await org.isVisible().catch(() => false)) await org.fill(TENANT);
    await page.getByLabel(/^Username/).fill(ADMIN_USER); await page.getByLabel(/^Password/).fill(process.env.QA_ADMIN_PASSWORD ?? '');
    await page.getByRole('button', { name: /^Sign in$/ }).click(); await page.getByRole('button', { name: 'Account menu' }).waitFor();
    await page.getByRole('button', { name: 'Account menu' }).click();
    const out = page.getByText(/^(Sign out|Log out)$/).first();
    const has = await out.waitFor({ timeout: 5000 }).then(() => true).catch(() => false);
    if (has) { await out.click(); await expect(page.getByRole('button', { name: /^Sign in$/ })).toBeVisible(); }
    log('sign out available from the user menu', has); expect.soft(has).toBe(true);
    await ctx.close();
  });
});
