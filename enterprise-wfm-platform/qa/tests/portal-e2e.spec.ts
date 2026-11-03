/** Employee portal (localhost:3001) end-to-end through the real UI. */
import { test, expect, Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { PORTAL_URL, adminToken, call, record, testData, RUN, TENANT } from './helpers';

const log = (check: string, ok: boolean, detail: unknown = '') => record('portal', { check, ok, detail });
const day = (n: number) => { const d = new Date(); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10); };

async function signIn(page: Page, user: string, pass: string) {
  await page.goto(PORTAL_URL + '/');
  const org = page.getByLabel(/Organisation code/i);
  if (await org.isVisible().catch(() => false)) await org.fill(TENANT);
  await page.getByLabel(/^Username/).fill(user);
  await page.getByLabel(/^Password/).fill(pass);
  await page.getByRole('button', { name: 'Sign in' }).click();
}
/** Cancel every still-open time-off request created by earlier QA runs for demo.agent1. */
async function cancelQaTimeOff() {
  const t = (await call(null, 'POST', '/auth/login', { username: 'demo.agent1', password: testData.agentPassword, tenant: TENANT })).body.token;
  const list = (await call(t, 'GET', '/me/time-off')).body.requests as any[];
  for (const r of list.filter((x) => /^QA-/.test(x.reason ?? '') && ['APPROVED', 'REQUESTED'].includes(x.status))) await call(t, 'POST', `/me/time-off/${r.id}/cancel`, {});
}
const tab = (page: Page, name: string) => page.getByRole('button', { name, exact: true }).click();

test.describe('Employee portal', () => {
  let pageErrors: string[];
  test.beforeEach(async ({ page }) => { pageErrors = []; page.on('pageerror', (e) => pageErrors.push(e.message)); });
  test.afterEach(async () => { expect.soft(pageErrors, 'uncaught JS errors').toEqual([]); });

  test('P-01 sign-in validation: empty form disabled, wrong password shows error, forgot-password help', async ({ page }) => {
    await page.goto(PORTAL_URL + '/');
    const btn = page.getByRole('button', { name: 'Sign in' });
    await expect(btn).toBeDisabled();
    await page.getByLabel(/^Username/).fill('demo.agent1');
    await page.getByLabel(/^Password/).fill('definitely-wrong-' + RUN);
    await btn.click();
    await expect(page.getByText('Invalid username or password')).toBeVisible();
    log('wrong password shows a generic error', true);
    await page.getByRole('button', { name: 'Forgot your password?' }).click();
    await expect(page.getByText(/reset by your WFM administrator/i)).toBeVisible();
    log('forgot password explains admin reset', true);
    const axe = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze();
    log('login screen a11y', axe.violations.length === 0, axe.violations.map((v) => `${v.impact} ${v.id} (${v.nodes.length})`));
  });

  test('P-02 first sign-in forces a new password; weak and mismatched passwords rejected', async ({ page }) => {
    const A = await adminToken();
    const logins = JSON.stringify((await call(A, 'GET', '/self-service/logins')).body);
    const emp = ((await call(A, 'GET', '/workforce/employees')).body as any[]).find((e) => /^D0\d\d$/.test(e.employeeNumber) && !logins.includes(e.id));
    const username = `qa.portal.${RUN}`;
    const temp = 'Tmp-' + testData.agentPassword;
    const c = await call(A, 'POST', '/self-service/logins', { employeeId: emp.id, username, password: temp });
    if (c.status !== 201) { test.skip(true, `could not create login: ${c.status} ${JSON.stringify(c.body)}`); }
    await signIn(page, username, temp);
    await expect(page.getByLabel('Temporary password')).toBeVisible();
    log('temporary password leads to change-password screen', true);
    const fill = async (cur: string, n: string, again: string) => {
      await page.getByLabel('Temporary password').fill(cur); await page.getByLabel(/^New password/).first().fill(n); await page.getByLabel('New password again').fill(again);
      await page.getByRole('button', { name: /Save password/ }).click();
    };
    await fill(temp, 'password123', 'password123');
    const weakMsg = await page.getByText(/too easy|common/i).first().isVisible({ timeout: 5000 }).catch(() => false);
    log('weak password rejected in UI', weakMsg); expect.soft(weakMsg).toBe(true);
    await fill(temp, 'Good-Pass-' + RUN + 'x', 'Different-' + RUN);
    const mismatch = await page.getByText(/match|same/i).first().isVisible({ timeout: 5000 }).catch(() => false);
    log('mismatched confirmation rejected', mismatch); expect.soft(mismatch).toBe(true);
    await fill(temp, testData.agentPassword + 'p', testData.agentPassword + 'p');
    await expect(page.getByText(/^Hi, /)).toBeVisible({ timeout: 15_000 });
    log('valid new password signs the person in', true);
  });

  test('P-03 every section renders with data and without errors', async ({ page }) => {
    await signIn(page, 'demo.agent1', testData.agentPassword);
    await expect(page.getByText(/^Hi, Agent1/)).toBeVisible({ timeout: 15_000 });
    const out: Record<string, unknown> = {};
    for (const [t, expectText] of [['Home', /Next shift|Today/], ['Schedule', /Week|Month/], ['Requests', /Balances|Request time off/], ['Inbox', /Notifications/], ['Me', /Availability|Password/]] as const) {
      const t0 = Date.now();
      await tab(page, t);
      await expect(page.locator('main')).toContainText(expectText);
      const txt = await page.locator('main').innerText();
      const bad = txt.match(/\b(undefined|NaN|\[object Object\]|Invalid Date)\b/g);
      const axe = await new AxeBuilder({ page }).include('main').withTags(['wcag2a', 'wcag2aa']).analyze();
      out[t] = { ms: Date.now() - t0, bad, axe: axe.violations.map((v) => `${v.impact} ${v.id} (${v.nodes.length})`) };
      expect.soft(bad, `${t} renders raw placeholders`).toBeNull();
    }
    log('all five sections render', true, out);
  });

  test('P-04 schedule: week/month toggle and week navigation', async ({ page }) => {
    await signIn(page, 'demo.agent1', testData.agentPassword);
    await tab(page, 'Schedule');
    const range = page.locator('main').getByText(/–/).first();
    const before = await page.locator('main').innerText();
    await page.getByRole('button', { name: 'Next' }).click();
    await page.waitForTimeout(800);
    const after = await page.locator('main').innerText();
    log('next week changes the view', before !== after); expect.soft(before).not.toBe(after);
    await page.getByRole('button', { name: 'Month' }).click();
    await page.waitForTimeout(800);
    const month = await page.locator('main').innerText();
    log('month view renders', month !== after, month.slice(0, 80)); expect.soft(month).not.toBe(after);
    await range.isVisible();
  });

  test('P-05 request time off through the form, see it in history, cancel it', async ({ page }) => {
    await cancelQaTimeOff();
    await signIn(page, 'demo.agent1', testData.agentPassword);
    await tab(page, 'Requests');
    await page.getByRole('button', { name: 'Request time off' }).click();
    await page.getByLabel('Type').selectOption('VACATION');
    await page.getByLabel('Start').fill(day(45));
    await page.getByLabel('End').fill(day(46));
    const marker = `QA-${RUN} <img src=x onerror="window.__xss=1"> portal`;
    await page.getByLabel('Reason (optional)').fill(marker);
    await expect(page.locator('main')).toContainText(/2 days/);
    await page.getByRole('button', { name: 'Submit request' }).click();
    await expect(page.locator('main')).toContainText(`${day(45)} – ${day(46)}`, { timeout: 15_000 });
    log('time-off request submitted from the UI', true, day(45));
    const xss = await page.evaluate(() => (window as any).__xss);
    log('reason text is not executed (XSS)', xss === undefined); expect(xss).toBeUndefined();
    // reversed dates in the form
    await page.getByRole('button', { name: 'Request time off' }).click();
    await page.getByLabel('Start').fill(day(60)); await page.getByLabel('End').fill(day(55));
    const blocked = await page.getByRole('button', { name: 'Submit request' }).isDisabled().catch(() => false) || await page.getByText(/before the start/i).isVisible().catch(() => false);
    log('form flags end date before start date before submitting', blocked);
    if (!blocked) { await page.getByRole('button', { name: 'Submit request' }).click(); const srv = await page.getByText(/before the start/i).isVisible({ timeout: 8000 }).catch(() => false); log('server error shown after submitting reversed dates', srv); expect.soft(srv).toBe(true); }
    await page.getByRole('button', { name: 'Cancel' }).first().click().catch(() => {});
    await cancelQaTimeOff();
  });

  test('P-06 opportunities: decline an overtime offer; inbox mark-all-read', async ({ page }) => {
    await signIn(page, 'demo.agent1', testData.agentPassword);
    await tab(page, 'Requests');
    await page.getByRole('button', { name: 'Opportunities', exact: true }).click();
    const decline = page.getByRole('button', { name: 'Decline' }).first();
    if (await decline.waitFor({ timeout: 8000 }).then(() => true).catch(() => false)) {
      await decline.click();
      await expect(page.locator('main')).toContainText(/declined/i, { timeout: 10_000 });
      log('decline overtime offer from the UI', true);
    } else log('decline overtime offer from the UI', false, 'no open offer to decline');
    await tab(page, 'Inbox');
    const mark = page.getByRole('button', { name: 'Mark all read' });
    if (await mark.isEnabled().catch(() => false)) await mark.click();
    await tab(page, 'Home');
    const unread = await page.getByText(/unread notification/).isVisible().catch(() => false);
    log('mark all read clears the unread badge on Home', !unread); expect.soft(unread).toBe(false);
  });

  test('P-07 change password with wrong current password is refused', async ({ page }) => {
    await signIn(page, 'demo.agent1', testData.agentPassword);
    await tab(page, 'Me');
    await page.getByRole('button', { name: 'Change password' }).click();
    await page.getByLabel('Current password').fill('wrong-' + RUN);
    await page.getByLabel(/^New password/).first().fill('Another-' + testData.agentPassword);
    await page.getByLabel('Confirm new password').fill('Another-' + testData.agentPassword);
    await page.getByRole('button', { name: 'Save new password' }).click();
    const err = await page.getByText(/incorrect|too many attempts/i).waitFor({ timeout: 20_000 }).then(() => true).catch(() => false);
    log('wrong current password refused', err); expect.soft(err).toBe(true);
  });

  test('P-08 session: survives reload, section is lost on reload, sign out clears token', async ({ page }) => {
    await signIn(page, 'demo.agent1', testData.agentPassword);
    await expect(page.getByText(/^Hi, /)).toBeVisible({ timeout: 15_000 });
    await tab(page, 'Inbox');
    await page.reload();
    const still = await page.getByRole('button', { name: 'Sign out' }).isVisible({ timeout: 10_000 }).catch(() => false);
    const onInbox = await page.locator('main').getByText('Notifications').isVisible().catch(() => false);
    log('session survives reload', still); expect(still).toBe(true);
    log('current section kept after reload / shareable URL', onInbox, `url=${page.url()}`);
    const token = await page.evaluate(() => localStorage.getItem('wfm_token') ?? Object.keys(localStorage).join(','));
    await page.getByRole('button', { name: 'Sign out' }).click();
    await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();
    const left = await page.evaluate(() => Object.keys(localStorage).filter((k) => /token|session/i.test(k)));
    log('sign out clears stored session', left.length === 0, left); expect.soft(left).toEqual([]);
    if (token && token.startsWith('ey')) { const r = await call(token, 'GET', '/me/home'); log('signed-out token rejected by API', r.status === 401, r.status); expect.soft(r.status).toBe(401); }
    await page.goBack();
    const back = await page.getByText(/^Hi, /).isVisible().catch(() => false);
    log('browser Back after sign out does not show private data', !back); expect.soft(back).toBe(false);
  });

  test('P-09 an admin-only account cannot use the portal', async ({ page }) => {
    await signIn(page, 'qa.scheduler', testData.rolePassword);
    await page.waitForTimeout(3000);
    const inside = await page.getByRole('button', { name: 'Schedule', exact: true }).isVisible().catch(() => false);
    const txt = (await page.locator('body').innerText()).slice(0, 300);
    log('non-employee account (SCHEDULER, no linked employee) blocked or shown a clear message', !inside || /cannot use|not linked|no employee/i.test(txt), txt.replace(/\n+/g, ' | '));
  });
});
