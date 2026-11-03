import { test as setup, expect } from '@playwright/test';
import { ADMIN_PASSWORD, ADMIN_URL, ADMIN_USER, TENANT } from './helpers';

setup('admin signs in through the UI and the session is saved', async ({ page }) => {
  expect(ADMIN_PASSWORD, 'set QA_ADMIN_PASSWORD').not.toBe('');
  await page.goto(ADMIN_URL + '/');
  const org = page.getByLabel(/Organisation code/i);
  if (await org.isVisible().catch(() => false)) await org.fill(TENANT);
  await page.getByLabel(/^Username/i).fill(ADMIN_USER);
  await page.getByLabel(/^Password/i).fill(ADMIN_PASSWORD);
  await page.getByRole('button', { name: /^Sign in$/ }).click();
  await expect(page.getByLabel(/^Password/i)).toBeHidden({ timeout: 30_000 });
  await expect.poll(() => page.evaluate(() => localStorage.getItem('wfm_token'))).toBeTruthy();
  await page.context().storageState({ path: '.auth/admin.json' });
});
