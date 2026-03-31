/**
 * Quick screenshot script — launches app, enters offline mode,
 * navigates to POS, saves screenshots.
 */
import { _electron as electron } from 'playwright';
import { mkdtempSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');
const OUT = join(ROOT, 'tests', 'e2e', 'screenshots');

const tempUserData = mkdtempSync(join(tmpdir(), 'zira-ss-'));

console.log('[ss] Launching Electron...');
const app = await electron.launch({
  args: ['.', `--user-data-dir=${tempUserData}`],
  cwd: ROOT,
  env: { ...process.env, NODE_ENV: 'production', E2E_TEST: '1' },
  timeout: 30_000,
});

const page = await app.firstWindow();
await page.waitForLoadState('domcontentloaded');
await page.waitForTimeout(3000);

// Enter offline mode
const offlineSels = ['button:has-text("Offline")', 'button:has-text("offline")', 'text=Offline'];
for (const sel of offlineSels) {
  try {
    await page.click(sel, { timeout: 3000 });
    console.log('[ss] Clicked offline via:', sel);
    break;
  } catch { /* try next */ }
}

// Wait for sidebar
try {
  await page.waitForSelector('aside', { timeout: 10000 });
  console.log('[ss] Sidebar visible — in app');
} catch {
  console.log('[ss] No sidebar, saving debug screenshot');
  await page.screenshot({ path: join(OUT, 'debug-no-sidebar.png') });
  await app.close();
  process.exit(1);
}

// Navigate to POS
const posSel = 'aside button.sidebar-item:has-text("POS"), aside button[data-tooltip="POS"]';
try { await page.click(posSel, { timeout: 5000 }); } catch { console.log('[ss] POS tab not found via sidebar'); }
await page.waitForTimeout(2000);

// Screenshot 1: POS main view
await page.screenshot({ path: join(OUT, 'pos-main.png'), fullPage: true });
console.log('[ss] Saved pos-main.png');

// Add 3 items to cart by clicking the "+" buttons
const addBtns = page.locator('button[aria-label^="Add"]');
const count = await addBtns.count();
for (let i = 0; i < Math.min(3, count); i++) {
  try { await addBtns.nth(i).click({ timeout: 2000 }); await page.waitForTimeout(300); } catch { /* skip */ }
}
await page.waitForTimeout(800);

// Screenshot 2: with cart items
await page.screenshot({ path: join(OUT, 'pos-cart.png'), fullPage: true });
console.log('[ss] Saved pos-cart.png');

// Try to open the category dropdown
const dropdownSel = 'button[aria-haspopup="listbox"]';
try {
  await page.click(dropdownSel, { timeout: 3000 });
  await page.waitForTimeout(500);
  await page.screenshot({ path: join(OUT, 'pos-dropdown.png'), fullPage: true });
  console.log('[ss] Saved pos-dropdown.png');
} catch { console.log('[ss] Category dropdown not found'); }

await app.close();
console.log('[ss] Done');
