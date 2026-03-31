import { _electron as electron } from 'playwright';
import { mkdtempSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');
const OUT = join(ROOT, 'tests', 'e2e', 'screenshots');

const tempUserData = mkdtempSync(join(tmpdir(), 'zira-settings-'));
const app = await electron.launch({
  args: ['.', `--user-data-dir=${tempUserData}`],
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

for (const sel of ['aside button[data-tooltip="Settings"]', 'aside button:has-text("Settings")']) {
  try { await page.click(sel, { timeout: 3000 }); break; } catch {}
}
await page.waitForTimeout(2000);

const scrolls = [0, 500, 1000, 1500, 2200];
const names = ['settings-top', 'settings-mid1', 'settings-mid2', 'settings-bot1', 'settings-bot2'];
for (let i = 0; i < scrolls.length; i++) {
  await page.evaluate((y) => { const m = document.querySelector('main'); if (m) m.scrollTop = y; }, scrolls[i]);
  await page.waitForTimeout(400);
  await page.screenshot({ path: join(OUT, names[i] + '.png') });
  console.log('[ss] Saved', names[i] + '.png');
}

await app.close();
console.log('[ss] Done');
