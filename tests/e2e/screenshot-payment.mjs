/**
 * Screenshot script — PaymentModal numeric keypad verification.
 * Opens shift, adds items, then captures payment modal at 1280x720 and 1600x900.
 */
import { _electron as electron } from 'playwright';
import { mkdtempSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');
const OUT = join(ROOT, 'tests', 'e2e', 'screenshots');
if (!existsSync(OUT)) mkdirSync(OUT, { recursive: true });

const tempUserData = mkdtempSync(join(tmpdir(), 'zira-pay-'));

console.log('[pay] Launching Electron...');
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
for (const sel of ['button:has-text("Offline")', 'button:has-text("offline")', 'text=Offline']) {
  try { await page.click(sel, { timeout: 3000 }); console.log('[pay] Offline clicked'); break; } catch { /* next */ }
}
await page.waitForTimeout(2000);

// Wait for sidebar
try {
  await page.waitForSelector('aside', { timeout: 10000 });
  console.log('[pay] Sidebar visible');
} catch {
  await page.screenshot({ path: join(OUT, 'payment-debug.png') });
  await app.close(); process.exit(1);
}

// Navigate to POS
for (const sel of [
  'aside button:has-text("POS")',
  'aside button[data-tooltip="POS"]',
]) {
  try { await page.click(sel, { timeout: 3000 }); console.log('[pay] POS tab clicked'); break; } catch { /* next */ }
}
await page.waitForTimeout(2000);

// Open a shift — click "Open Shift" button in header
let shiftOpened = false;
for (const sel of [
  'button:has-text("Open Shift")',
  'button:has-text("Mở ca")',
]) {
  try { await page.click(sel, { timeout: 3000 }); shiftOpened = true; console.log('[pay] Open Shift clicked'); break; } catch { /* next */ }
}

if (shiftOpened) {
  await page.waitForTimeout(1000);

  // Target the shift modal overlay, not the search bar
  const modalOverlay = page.locator('.fixed.inset-0').last();

  // Fill staff name — first text input in the modal (second is cash amount)
  try {
    const nameInput = modalOverlay.locator('input[type="text"]').first();
    await nameInput.click({ timeout: 2000 });
    await nameInput.fill('Test', { timeout: 2000 });
    console.log('[pay] Staff name entered in modal');
  } catch (e) { console.log('[pay] Name input failed:', e.message); }
  await page.waitForTimeout(500);

  // Click the green submit button (force: true to bypass disabled check if needed)
  try {
    const submitBtn = modalOverlay.locator('button:has-text("Open Shift"), button:has-text("Mở ca")').last();
    await submitBtn.click({ timeout: 5000 });
    console.log('[pay] Shift submitted');
  } catch (e) { console.log('[pay] Shift submit failed:', e.message); }
  await page.waitForTimeout(2000);
}

// Clear the search bar if it has text from accidental input
try {
  const searchInput = page.locator('input[placeholder*="Search"], input[placeholder*="search"], input[placeholder*="Tìm"]');
  const searchVal = await searchInput.inputValue({ timeout: 1000 });
  if (searchVal) {
    await searchInput.clear();
    console.log('[pay] Cleared search bar');
    await page.waitForTimeout(1000);
  }
} catch { /* no search bar or empty */ }

// Add items to cart
const addBtns = page.locator('button[aria-label^="Add"]');
const addCount = await addBtns.count();
console.log(`[pay] Found ${addCount} add buttons`);
for (let i = 0; i < Math.min(3, addCount); i++) {
  try { await addBtns.nth(i).click({ timeout: 2000 }); await page.waitForTimeout(400); } catch { /* skip */ }
}
await page.waitForTimeout(500);

// Try to click Pay button
let payClicked = false;
for (const sel of [
  'button:has-text("Pay")',
  'button:has-text("Zapłać")',
  'button:has-text("Thanh toán")',
]) {
  try {
    const btn = page.locator(sel).last();
    const isDisabled = await btn.isDisabled().catch(() => true);
    if (!isDisabled) {
      await btn.click({ timeout: 3000 });
      payClicked = true;
      console.log('[pay] Pay opened via:', sel);
      break;
    } else {
      console.log('[pay] Pay disabled:', sel);
    }
  } catch { /* next */ }
}

if (!payClicked) {
  console.log('[pay] Pay button not clickable');
  await page.screenshot({ path: join(OUT, 'payment-no-pay.png') });
  await app.close();
  process.exit(1);
}

await page.waitForTimeout(1000);

// Helper: resize and screenshot
async function shot(w, h, name) {
  try {
    await app.evaluate(async ({ BrowserWindow }, { w, h }) => {
      const wins = BrowserWindow.getAllWindows();
      if (wins.length > 0) wins[0].setSize(w, h);
    }, { w, h });
    await page.waitForTimeout(600);
    await page.screenshot({ path: join(OUT, `payment-${name}-${w}x${h}.png`) });
    console.log(`[pay] Screenshot: ${name} ${w}x${h}`);
  } catch (err) {
    console.log(`[pay] Screenshot failed: ${name}`, err.message);
  }
}

// ── 1. Cash mode with keypad visible ──────────────────────
for (const [w, h] of [[1280, 720], [1600, 900]]) {
  await shot(w, h, 'cash-keypad');
}

// ── 2. Enter amount via keypad ────────────────────────────
const kp = page.locator('[aria-label="Numeric keypad"]');
const kpCount = await kp.count();
console.log(`[pay] Keypad found: ${kpCount > 0}`);

if (kpCount > 0) {
  // Click: 5, 0, ., 0, 0 → "50.00"
  for (const label of ['5', '0', '.', '0', '0']) {
    try {
      await kp.locator(`button:text-is("${label}")`).first().click({ timeout: 1500 });
      await page.waitForTimeout(150);
    } catch {
      console.log(`[pay] Keypad key "${label}" missed`);
    }
  }
  await page.waitForTimeout(500);

  for (const [w, h] of [[1280, 720], [1600, 900]]) {
    await shot(w, h, 'cash-entered');
  }

  // Test backspace (4th button in keypad = index 3)
  try {
    await kp.locator('button').nth(3).click({ timeout: 1000 });
    await page.waitForTimeout(200);
    console.log('[pay] Backspace OK');
  } catch { console.log('[pay] Backspace failed'); }

  // Test clear
  try {
    await kp.locator('button:text-is("C")').first().click({ timeout: 1000 });
    await page.waitForTimeout(200);
    console.log('[pay] Clear OK');
  } catch { console.log('[pay] Clear failed'); }

  // Test Exact (col-span-2 button)
  try {
    await kp.locator('button.col-span-2').first().click({ timeout: 1000 });
    await page.waitForTimeout(500);
    console.log('[pay] Exact OK');

    for (const [w, h] of [[1280, 720], [1600, 900]]) {
      await shot(w, h, 'cash-exact');
    }
  } catch { console.log('[pay] Exact failed'); }
}

// ── 3. Split mode with keypad ─────────────────────────────
try {
  // Target the Split button inside the payment dialog, not quick actions behind it
  const dialog = page.locator('[role="dialog"]');
  const splitBtn = dialog.locator('button[aria-pressed]');
  await splitBtn.click({ timeout: 3000 });
  await page.waitForTimeout(800);
  console.log('[pay] Split mode activated');

  for (const [w, h] of [[1280, 720], [1600, 900]]) {
    await shot(w, h, 'split-keypad');
  }

  // Enter split amount via keypad
  const kpSplit = page.locator('[aria-label="Numeric keypad"]');
  if (await kpSplit.count() > 0) {
    for (const label of ['2', '5']) {
      try {
        await kpSplit.locator(`button:text-is("${label}")`).first().click({ timeout: 1000 });
        await page.waitForTimeout(150);
      } catch {}
    }
    console.log('[pay] Split amount keyed');

    // Add tender via + button
    try {
      await page.locator('button[aria-label="Add tender"]').click({ timeout: 2000 });
      await page.waitForTimeout(500);
      console.log('[pay] Tender added');
    } catch { console.log('[pay] Add tender failed'); }

    // Remove tender
    try {
      await page.locator('button[aria-label="Remove tender"]').first().click({ timeout: 2000 });
      await page.waitForTimeout(500);
      console.log('[pay] Tender removed');
    } catch { console.log('[pay] Remove tender failed'); }
  }
} catch (e) {
  console.log('[pay] Split toggle failed:', e.message);
}

// ── Close modal ───────────────────────────────────────────
try {
  await page.click('button[aria-label="Close"]', { timeout: 2000 });
  await page.waitForTimeout(500);
  console.log('[pay] Modal closed OK');
} catch {
  console.log('[pay] Close failed');
}

await app.close();
console.log('[pay] All done');
