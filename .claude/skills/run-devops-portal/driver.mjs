/**
 * Playwright smoke driver for devops-portal.
 *
 * Usage:
 *   node .claude/skills/run-devops-portal/driver.mjs [base-url] [screenshot-dir]
 *
 * Defaults:
 *   base-url       = http://localhost:5174
 *   screenshot-dir = /tmp/portal-screenshots
 *
 * Exit 0 on success, 1 on failure.
 */
// Resolve playwright-core from the project root (three dirs up from skill dir)
import { createRequire } from 'module';
const require = createRequire(new URL('../../../package.json', import.meta.url));
const { chromium } = require('playwright-core');
import { mkdirSync } from 'fs';
import { join } from 'path';

const BASE = process.argv[2] ?? 'http://localhost:5174';
const SS_DIR = process.argv[3] ?? '/tmp/portal-screenshots';

mkdirSync(SS_DIR, { recursive: true });

async function ss(page, name) {
  const p = join(SS_DIR, `${name}.png`);
  await page.screenshot({ path: p, fullPage: true });
  console.log(`[ss] ${p}`);
  return p;
}

async function run() {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await ctx.newPage();

  page.on('console', m => {
    if (m.type() === 'error') console.error('[browser-error]', m.text());
  });
  page.on('pageerror', e => console.error('[page-error]', e.message));

  // ── 1. Home (Tickets default) ────────────────────────────────────────────
  console.log('[1] Loading portal...');
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await ss(page, '01-home');

  const navCount = await page.locator('nav.app-nav button').count();
  console.log(`[nav] ${navCount} module buttons`);
  if (navCount === 0) throw new Error('Nav failed to render — server may be down');

  // ── 2. Walk every module ─────────────────────────────────────────────────
  const modules = await page.locator('nav.app-nav button').all();
  for (let i = 0; i < modules.length; i++) {
    const label = (await modules[i].textContent())?.trim() ?? `module-${i}`;
    console.log(`[nav] → ${label}`);
    await modules[i].click();
    await page.waitForTimeout(600);
    await ss(page, `0${2 + i}-${label.toLowerCase().replace(/\s+/g, '-')}`);
  }

  // ── 3. Ticket creation flow ───────────────────────────────────────────────
  console.log('[ticket] Creating new ticket...');
  await page.locator('nav.app-nav button').first().click();
  await page.waitForTimeout(400);

  await page.locator('button', { hasText: /^\+?\s*New$/ }).first().click();
  await page.waitForTimeout(400);
  await ss(page, '10-new-ticket-modal');

  // Bare <input> (no name/type attr) for title, bare <textarea> for description
  await page.locator('input').first().fill('Driver smoke test');
  await page.locator('textarea').first().fill('Created by the Playwright driver for skill verification.');
  await ss(page, '11-new-ticket-filled');

  // Submit button: <button class="primary">Submit</button> — no type attr
  await page.locator('button.primary', { hasText: /submit/i }).click();
  await page.waitForTimeout(800);
  await ss(page, '12-after-submit');

  // ── 4. Admin role ─────────────────────────────────────────────────────────
  const adminBtn = page.locator('.role-toggle button', { hasText: 'Admin' });
  if (await adminBtn.count() > 0) {
    console.log('[role] Switching to Admin...');
    await adminBtn.click();
    await page.waitForTimeout(600);
    await page.locator('nav.app-nav button').first().click();
    await page.waitForTimeout(600);
    await ss(page, '13-admin-queue');
  }

  await browser.close();
  console.log(`[done] Screenshots in ${SS_DIR}`);
}

run().catch(e => {
  console.error('[FAIL]', e.message);
  process.exit(1);
});
