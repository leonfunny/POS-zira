import { _electron as electron } from 'playwright';
import { mkdtempSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const ROOT = 'C:/print-agent-master';
const OUT = join(ROOT, 'tests', 'e2e', 'screenshots');
const tempUserData = mkdtempSync(join(tmpdir(), 'zira-kb-'));

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

// Navigate to Invoicing tab
await page.click('button:has-text("Invoic")', { timeout: 5000 }).catch(() => {});
await page.waitForTimeout(1000);

// Screenshot before keyboard
await page.screenshot({ path: join(OUT, 'kb-invoicing-before.png') });
console.log('[kb] Saved kb-invoicing-before.png');

// Click on a visible text input to trigger the global keyboard
const firstInput = page.locator('input[type="text"]:visible, input:not([type]):visible').first();
await firstInput.click({ timeout: 5000 }).catch(async () => {
  await page.locator('input:visible').first().click({ timeout: 3000 }).catch(() => {});
});
await page.waitForTimeout(700);

// Screenshot WITH keyboard visible
await page.screenshot({ path: join(OUT, 'kb-invoicing-keyboard.png') });
console.log('[kb] Saved kb-invoicing-keyboard.png');

await app.close();
