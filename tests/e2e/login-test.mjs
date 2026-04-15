import { _electron as electron } from 'playwright';
import { mkdtempSync } from 'fs';
import { join, dirname } from 'path';
import { tmpdir } from 'os';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');
const OUT = join(ROOT, 'tests', 'e2e', 'screenshots');

const EMAIL = 'maithiha@Wp.pl';
const PASSWORD = 'Chesaigon1234!!';

const tempUserData = mkdtempSync(join(tmpdir(), 'zira-login-'));
console.log('[login] user-data-dir =', tempUserData);

const app = await electron.launch({
  args: ['.', `--user-data-dir=${tempUserData}`],
  cwd: ROOT,
  env: { ...process.env, NODE_ENV: 'production' },
  timeout: 30_000,
});

const page = await app.firstWindow();
await page.waitForLoadState('domcontentloaded');
await page.waitForTimeout(3000);

// Capture console errors
const consoleErrors = [];
page.on('console', (msg) => {
  if (msg.type() === 'error') consoleErrors.push(msg.text());
});
page.on('pageerror', (err) => consoleErrors.push('pageerror: ' + err.message));

await page.screenshot({ path: join(OUT, 'login-01-initial.png') });
console.log('[login] saved login-01-initial.png');

// Find and fill email + password
await page.waitForSelector('#auth-email', { timeout: 10000 });
await page.fill('#auth-email', EMAIL);
await page.fill('#auth-password', PASSWORD);
await page.screenshot({ path: join(OUT, 'login-02-filled.png') });
console.log('[login] saved login-02-filled.png');

// Click Sign In
await page.click('button[type="submit"]');
console.log('[login] clicked submit, waiting...');

// Wait up to 15s for either: error message, or redirect away from auth screen
let outcome = 'unknown';
const startedAt = Date.now();
while (Date.now() - startedAt < 15000) {
  const stillOnAuth = await page.locator('#auth-email').count();
  const errorText = await page.locator('p.text-red-600').allTextContents().catch(() => []);
  if (errorText.length && errorText.some(t => t.trim())) {
    outcome = 'error: ' + errorText.join(' | ');
    break;
  }
  if (stillOnAuth === 0) {
    outcome = 'success (left auth screen)';
    break;
  }
  await page.waitForTimeout(500);
}

await page.screenshot({ path: join(OUT, 'login-03-result.png') });
console.log('[login] outcome =', outcome);
console.log('[login] console errors:', consoleErrors.length ? consoleErrors : '(none)');

// Check if sidebar is visible (indicates logged in)
const hasSidebar = await page.locator('aside').count();
console.log('[login] aside count =', hasSidebar);

await page.waitForTimeout(1000);
await app.close();
console.log('[login] Done. Outcome:', outcome);
