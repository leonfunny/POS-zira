import { _electron as electron } from 'playwright';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = process.cwd();
const OUT_DIR = join(ROOT, 'docs', 'screenshots');
const FIXED_CUSTOMER_TIME_ISO = '2026-04-19T12:00:00+02:00';
mkdirSync(OUT_DIR, { recursive: true });

function run(command) {
  const result = spawnSync(command, { cwd: ROOT, shell: true, stdio: 'inherit' });
  if (result.status !== 0) throw new Error(`Command failed: ${command}`);
}

async function configure(page, profile, posMode = 'retail') {
  await page.evaluate(async ({ profile, posMode }) => {
    await window.electronAPI.setConfig({
      posEnabled: true,
      posMode,
      customerDisplayEnabled: true,
      customerDisplayForceKiosk: false,
      customerDisplayProfile: profile,
    });
  }, { profile, posMode });
}

async function enterOfflineMode(page) {
  for (const selector of ['button:has-text("Offline")', 'text=Offline']) {
    try {
      await page.click(selector, { timeout: 3000 });
      break;
    } catch {}
  }
}

async function navigateToSettings(page) {
  await page.waitForSelector('aside', { timeout: 10000 });
  for (const selector of ['aside button[data-tooltip="Settings"]', 'aside button:has-text("Settings")']) {
    try {
      await page.click(selector, { timeout: 3000 });
      break;
    } catch {}
  }
  await page.waitForTimeout(500);
}

async function openCustomerWindow(page, app) {
  await page.evaluate(async () => {
    await window.electronAPI.window.open('customer');
  });
  await page.waitForTimeout(1000);
  const customer = app.windows().find((candidate) => candidate !== page);
  if (!customer) throw new Error('Customer display window did not open');
  await customer.waitForLoadState('domcontentloaded');
  await freezeCustomerClock(customer);
  await reloadCustomerWindow(customer);
  return customer;
}

async function freezeCustomerClock(customer) {
  await customer.addInitScript((fixedIso) => {
    const fixedTime = new Date(fixedIso).getTime();
    const RealDate = Date;

    class FixedDate extends RealDate {
      constructor(...args) {
        super(...(args.length > 0 ? args : [fixedTime]));
      }

      static now() {
        return fixedTime;
      }
    }

    FixedDate.UTC = RealDate.UTC;
    FixedDate.parse = RealDate.parse;
    FixedDate.prototype = RealDate.prototype;
    window.Date = FixedDate;
  }, FIXED_CUSTOMER_TIME_ISO);
}

async function reloadCustomerWindow(customer) {
  await customer.reload();
  await customer.waitForLoadState('domcontentloaded');
  await customer.waitForTimeout(500);
}

async function screenshot(page, name, width, height) {
  await page.setViewportSize({ width, height });
  await page.waitForTimeout(250);
  await page.screenshot({
    path: join(OUT_DIR, `${name}-${width}x${height}.png`),
    fullPage: true,
  });
}

async function dispatch(page, action) {
  await page.evaluate(async (action) => {
    await window.electronAPI.pos.dispatch(action);
  }, action);
  await page.waitForTimeout(400);
}

async function changeSettingsProfileAndOpen(page, profile) {
  await navigateToSettings(page);
  const profileSelect = page.locator('select').filter({
    has: page.locator(`option[value="${profile}"]`),
  }).first();
  await profileSelect.waitFor({ state: 'visible', timeout: 10000 });
  await profileSelect.selectOption(profile);
  const openButton = page.locator('button', { hasText: 'Open Customer Display' });
  await openButton.click();
  const deadline = Date.now() + 5000;
  let saved = false;
  while (Date.now() < deadline) {
    const savedProfile = await page.evaluate(async () => {
      const config = await window.electronAPI.getConfig();
      return config.customerDisplayProfile;
    });
    if (savedProfile === profile) {
      saved = true;
      break;
    }
    await page.waitForTimeout(100);
  }
  if (!saved) {
    throw new Error(`Settings did not save customerDisplayProfile=${profile} before opening`);
  }
  await page.waitForTimeout(800);
}

async function assertCustomerDisplaySafeForPromoOnly(customer) {
  try {
    await customer.waitForSelector('[data-customer-display-promo-only-idle="true"], img', { timeout: 5000 });
  } catch (error) {
    const bodyText = await customer.locator('body').innerText().catch(() => '<unavailable>');
    const customerConfig = await customer.evaluate(() => window.electronAPI.getConfig()).catch(() => null);
    const refreshApiType = await customer.evaluate(() => typeof window.electronAPI.display?.onRefreshConfig).catch(() => '<unavailable>');
    await customer.screenshot({
      path: join(OUT_DIR, 'debug-settings-open-promo-only.png'),
      fullPage: true,
    }).catch(() => {});
    console.error('[display-profile] Customer body after Settings open:', bodyText);
    console.error('[display-profile] Customer config after Settings open:', customerConfig);
    console.error('[display-profile] Customer refresh API type:', refreshApiType);
    throw error;
  }
  const bodyText = await customer.locator('body').innerText();
  const bannedText = [
    'Staff will scan your items',
    'Your items will appear here',
    'Staff will take payment',
    'Payment status',
    'Waiting for terminal',
  ];

  for (const text of bannedText) {
    if (bodyText.includes(text)) {
      throw new Error(`promo_only customer display leaked retail-assisted copy: ${text}`);
    }
  }

  const blockedSurfaceCount = await customer.locator([
    '[data-customer-display-hub="hub"]',
    '[data-customer-display-checkin-booking-list="true"]',
    '[data-customer-display-checkin-phone-selection="true"]',
  ].join(',')).count();
  if (blockedSurfaceCount > 0) {
    throw new Error('promo_only customer display leaked check-in surface');
  }
}

async function captureBothSizes(page, name) {
  await screenshot(page, name, 1280, 720);
  await screenshot(page, name, 1600, 900);
}

async function main() {
  run('npm run build');

  const tempUserData = mkdtempSync(join(tmpdir(), 'zira-display-profile-'));
  const app = await electron.launch({
    args: ['.', `--user-data-dir=${tempUserData}`],
    cwd: ROOT,
    env: {
      ...process.env,
      NODE_ENV: 'production',
      E2E_TEST: '1',
      ELECTRON_USER_DATA_DIR: tempUserData,
    },
    timeout: 30000,
  });

  const page = await app.firstWindow();
  page.on('console', (message) => {
    if (['error', 'warning'].includes(message.type())) {
      console.log(`[main:${message.type()}] ${message.text()}`);
    }
  });
  page.on('pageerror', (error) => {
    console.error('[main:pageerror]', error);
  });
  await page.waitForLoadState('domcontentloaded');
  await page.waitForTimeout(2000);
  await enterOfflineMode(page);

  await configure(page, 'retail_assisted', 'retail');
  const customer = await openCustomerWindow(page, app);
  await captureBothSizes(customer, 'display-on-retail-assisted-idle');

  await changeSettingsProfileAndOpen(page, 'promo_only');
  await assertCustomerDisplaySafeForPromoOnly(customer);
  await captureBothSizes(customer, 'display-on-settings-open-promo-only');

  await configure(page, 'retail_assisted', 'retail');
  await reloadCustomerWindow(customer);
  await dispatch(page, {
    type: 'cart/addItem',
    payload: { id: 'shot-item-1', variantId: 'shot-var-1', name: 'Coffee Beans', sku: 'COF-001', price: 2499, quantity: 2, total: 4998, vatRate: 23 },
  });
  await dispatch(page, {
    type: 'cart/addItem',
    payload: { id: 'shot-item-2', variantId: 'shot-var-2', name: 'Chocolate Bar', sku: 'CHO-001', price: 699, quantity: 1, total: 699, vatRate: 23 },
  });
  await dispatch(page, { type: 'cart/applyDiscount', payload: { amount: 500 } });
  await captureBothSizes(customer, 'display-on-retail-assisted-cart');

  await dispatch(page, { type: 'display/setMode', payload: { mode: 'cart', paymentStatus: 'Waiting for terminal' } });
  await captureBothSizes(customer, 'display-on-retail-assisted-payment');

  await dispatch(page, { type: 'display/setMode', payload: { mode: 'thankyou', lastOrderTotal: 5197 } });
  await captureBothSizes(customer, 'display-on-retail-assisted-thankyou');

  await configure(page, 'salon_checkin', 'salon');
  await reloadCustomerWindow(customer);
  await dispatch(page, { type: 'cart/clear' });
  await dispatch(page, { type: 'display/setMode', payload: { mode: 'checkin', salonName: 'Salon' } });
  await captureBothSizes(customer, 'display-on-salon-checkin-route');

  await configure(page, 'promo_only', 'retail');
  await reloadCustomerWindow(customer);
  await dispatch(page, { type: 'cart/clear' });
  await dispatch(page, {
    type: 'cart/addItem',
    payload: { id: 'promo-only-item', variantId: 'promo-only-var', name: 'Hidden Cart Item', sku: 'HID-001', price: 1000, quantity: 1, total: 1000, vatRate: 23 },
  });
  await captureBothSizes(customer, 'display-on-promo-only-suppressed');

  await app.close();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
