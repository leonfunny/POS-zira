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
  await page.waitForLoadState('domcontentloaded');
  await page.waitForTimeout(2000);

  await configure(page, 'retail_assisted', 'retail');
  const customer = await openCustomerWindow(page, app);
  await captureBothSizes(customer, 'display-on-retail-assisted-idle');

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
