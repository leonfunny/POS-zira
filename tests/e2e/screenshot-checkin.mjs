import { _electron as electron } from 'playwright';
import { mkdtempSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');
const OUT = join(ROOT, 'tests', 'e2e', 'screenshots');

const tempUserData = mkdtempSync(join(tmpdir(), 'zira-checkin-'));
const app = await electron.launch({
  args: ['.', `--user-data-dir=${tempUserData}`, '--start-fullscreen'],
  cwd: ROOT,
  env: { ...process.env, NODE_ENV: 'production', E2E_TEST: '1' },
  timeout: 30_000,
});

const page = await app.firstWindow();
await page.waitForLoadState('domcontentloaded');
await page.waitForTimeout(3000);

for (const sel of ['button:has-text("Offline")', 'text=Offline']) {
  try { await page.click(sel, { timeout: 3000 }); break; } catch {}
}
await page.waitForSelector('aside', { timeout: 10000 });

// Turn off stats bar and queue panel
try {
  await page.evaluate(() => {
    window.electronAPI?.saveConfig?.({ checkinShowStatsBar: false, checkinShowQueue: false });
  });
  await page.waitForTimeout(500);
} catch {}

// Navigate to Check-in
for (const sel of ['aside button[data-tooltip="Check-in"]', 'aside button:has-text("Check-in")', 'aside [data-tab="checkin"]']) {
  try { await page.click(sel, { timeout: 3000 }); console.log('[ss] Check-in via:', sel); break; } catch {}
}
await page.waitForTimeout(2000);

// Screen 1: Entry screen
await page.screenshot({ path: join(OUT, 'checkin-entry.png') });
console.log('[ss] Saved checkin-entry.png');

// Navigate to Walk-in → Phone entry
const walkInSels = ['text=Walk-in', 'button:has-text("Walk")', '[data-action="walkin"]'];
for (const sel of walkInSels) {
  try { await page.click(sel, { timeout: 2000 }); console.log('[ss] Clicked walk-in via:', sel); break; } catch {}
}
await page.waitForTimeout(1500);

// Screen 2: Phone entry
await page.screenshot({ path: join(OUT, 'checkin-phone.png') });
console.log('[ss] Saved checkin-phone.png');

// Type a few digits
const numBtns = page.locator('button').filter({ hasText: /^[0-9]$/ });
const numCount = await numBtns.count();
if (numCount > 0) {
  for (let i = 0; i < 6; i++) {
    try { await numBtns.nth(i % numCount).click({ timeout: 1000 }); await page.waitForTimeout(150); } catch {}
  }
  // Also press + to test the fix
  try {
    const plusBtn = page.locator('button').filter({ hasText: /^\+$/ });
    await plusBtn.click({ timeout: 1000 });
    await page.waitForTimeout(200);
  } catch {}
  await page.waitForTimeout(400);
  await page.screenshot({ path: join(OUT, 'checkin-phone-typing.png') });
  console.log('[ss] Saved checkin-phone-typing.png');
}

// Try Skip → New Customer screen
const skipSels = ['text=Skip', 'button:has-text("Skip")'];
for (const sel of skipSels) {
  try { await page.click(sel, { timeout: 2000 }); console.log('[ss] Clicked skip via:', sel); break; } catch {}
}
await page.waitForTimeout(1500);

// Screen 3: New Customer
await page.screenshot({ path: join(OUT, 'checkin-new-customer.png') });
console.log('[ss] Saved checkin-new-customer.png');

await app.close();
console.log('[ss] Done');
