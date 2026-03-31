import { _electron as electron } from 'playwright';
import { mkdtempSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const ROOT = 'C:/print-agent-master';
const OUT = join(ROOT, 'tests', 'e2e', 'screenshots');
const tempUserData = mkdtempSync(join(tmpdir(), 'zira-inv-'));

const app = await electron.launch({
  args: ['.', `--user-data-dir=${tempUserData}`],
  cwd: ROOT,
  env: { ...process.env, NODE_ENV: 'production', E2E_TEST: '1' },
  timeout: 30_000,
});

const page = await app.firstWindow();
await page.waitForLoadState('domcontentloaded');
await page.waitForTimeout(3000);

await page.click('button:has-text("Offline")', { timeout: 3000 }).catch(() => {});
await page.waitForTimeout(1200);

// Go to Invoicing
await page.click('button:has-text("Invoic")', { timeout: 3000 }).catch(() => {});
await page.waitForTimeout(800);

// Fill seller settings
const inputs = page.locator('input[type="text"], input:not([type])');
await inputs.nth(0).fill('Test Salon Sp. z o.o.').catch(() => {});
await page.fill('input[placeholder="1234567890"]', '1234567890').catch(() => {});
await page.fill('input[placeholder="ul. Przykladowa 1/2"]', 'ul. Testowa 1').catch(() => {});
await page.fill('input[placeholder="00-000"]', '00-001').catch(() => {});
await page.fill('input[placeholder="Warszawa"]', 'Warszawa').catch(() => {});
await page.click('button:has-text("Save")', { timeout: 2000 }).catch(() => {});
await page.waitForTimeout(1500);

// Screenshot: Receipt (default)
await page.screenshot({ path: join(OUT, 'invoice-receipt.png') });
console.log('saved invoice-receipt.png');

// Click VAT Invoice type pill (2nd button in the invoice type pills row — language-agnostic)
const typePills = page.locator('.panel .bg-slate-100 button');
await typePills.nth(1).click({ timeout: 3000 }).catch(async () => {
  // fallback: try text variants
  await page.click('button:has-text("VAT")', { timeout: 2000 }).catch(() => {});
});
await page.waitForTimeout(600);
await page.screenshot({ path: join(OUT, 'invoice-vat.png') });
console.log('saved invoice-vat.png');

// Click Proforma type pill (3rd button)
await typePills.nth(2).click({ timeout: 3000 }).catch(async () => {
  await page.click('button:has-text("roforma")', { timeout: 2000 }).catch(() => {});
});
await page.waitForTimeout(600);
await page.screenshot({ path: join(OUT, 'invoice-proforma.png') });
console.log('saved invoice-proforma.png');

await app.close();
