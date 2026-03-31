import { _electron as electron } from 'playwright';
import { mkdtempSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const ROOT = 'C:/print-agent-master';
const OUT = join(ROOT, 'tests', 'e2e', 'screenshots');
const tempUserData = mkdtempSync(join(tmpdir(), 'zira-pos-kb-'));

const app = await electron.launch({
  args: ['.', `--user-data-dir=${tempUserData}`],
  cwd: ROOT,
  env: { ...process.env, NODE_ENV: 'production', E2E_TEST: '1' },
  timeout: 30_000,
});

const page = await app.firstWindow();
await page.waitForLoadState('domcontentloaded');
await page.waitForTimeout(3000);

// Offline mode
await page.click('button:has-text("Offline")', { timeout: 5000 }).catch(() => {});
await page.waitForTimeout(1500);

// Navigate to POS tab
await page.click('button:has-text("POS")', { timeout: 5000 }).catch(() => {});
await page.waitForTimeout(1000);

// Screenshot of POS before any input focus
await page.screenshot({ path: join(OUT, 'pos-keyboard-before.png') });
console.log('[pos-kb] Saved pos-keyboard-before.png');

// Click the search bar input in POS
const searchInput = page.locator('input[placeholder*="Search"], input[placeholder*="search"], input[type="search"]').first();
await searchInput.click({ timeout: 5000 }).catch(async () => {
  // fallback: first visible input
  await page.locator('input:visible').first().click({ timeout: 3000 }).catch(() => {});
});
await page.waitForTimeout(700);

// Screenshot WITH keyboard visible
await page.screenshot({ path: join(OUT, 'pos-keyboard-focused.png') });
console.log('[pos-kb] Saved pos-keyboard-focused.png');

await app.close();
