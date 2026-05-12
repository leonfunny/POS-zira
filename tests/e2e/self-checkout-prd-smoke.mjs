/**
 * PRD-driven self-checkout smoke.
 *
 * Source requirements: docs/SELF_CHECKOUT_DESIGN_BRIEF.md.
 * This checks the customer flow, not implementation internals:
 * welcome -> scanner-start shopping -> cart/bag quantity -> payment modal
 * -> terminal-driven BLIK/card -> receipt -> thank-you/reset, plus abandon,
 * staff lock, empty-cart pay disabled, and unavailable language switching.
 */
import { existsSync } from 'node:fs';
import { chromium } from 'playwright';

const URL = process.env.SELF_CHECKOUT_URL || 'http://localhost:3100/windows/self-checkout/index.html';
const PRODUCT_BARCODE = '5900000000011';
const PRODUCT = {
  id: 'prd-smoke-foco-350',
  template_id: 'prd-smoke-foco',
  name: 'Foco coconut water 350ml',
  sku: 'FOCO-350',
  barcode: PRODUCT_BARCODE,
  retail_price: 700,
  vat_rate: 23,
  in_stock: 20,
};

const browserCandidates = [
  process.env.PLAYWRIGHT_BROWSER_EXECUTABLE,
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
].filter(Boolean);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function findBrowserExecutable() {
  return browserCandidates.find((candidate) => existsSync(candidate));
}

async function createPage(browser, options = {}) {
  const context = await browser.newContext({
    viewport: options.viewport || { width: 1280, height: 800 },
    deviceScaleFactor: 1,
  });
  const page = await context.newPage();

  await page.addInitScript(({ product, config }) => {
    const scanCallbacks = [];
    window.__scSmoke = {
      emitBarcode: (barcode) => {
        for (const callback of scanCallbacks) callback(barcode);
      },
      storedCart: () => JSON.parse(window.localStorage.getItem('self-checkout:cart') || '{"items":[]}'),
    };

    window.electronAPI = {
      getConfig: async () => config,
      onBarcodeScanned: (callback) => {
        scanCallbacks.push(callback);
        return () => {
          const idx = scanCallbacks.indexOf(callback);
          if (idx >= 0) scanCallbacks.splice(idx, 1);
        };
      },
      pos: {
        categories: { getAll: async () => [] },
        products: {
          getByBarcode: async (barcode) => barcode === product.barcode ? product : null,
          getByCategory: async () => [],
        },
      },
      selfCheckout: {
        helpRequest: async () => ({ id: 'prd-smoke-help', acknowledgedAt: null }),
        checkStatus: async () => ({ id: 'prd-smoke-help', acknowledgedAt: null, resolvedAt: null }),
      },
    };
  }, {
    product: PRODUCT,
    config: {
      selfCheckoutLanguage: options.lang || 'en',
      selfCheckoutMode: options.mode || 'demo',
      selfCheckoutBagFeeAmount: 0.2,
      selfCheckoutIdleTimeoutMs: 90000,
    },
  });

  await page.goto(URL, { waitUntil: 'networkidle' });
  return { context, page };
}

async function languageButtonCount(page, selector = 'body') {
  return page.locator(`${selector} .sc-language-button`).count();
}

async function visibleInputCount(page, selector = 'body') {
  return page.locator(`${selector} input`).evaluateAll((inputs) => inputs.filter((input) => {
    const rect = input.getBoundingClientRect();
    const style = window.getComputedStyle(input);
    return rect.width > 1 && rect.height > 1 && style.opacity !== '0' && style.visibility !== 'hidden';
  }).length);
}

async function emitBarcode(page, barcode = PRODUCT_BARCODE) {
  await page.evaluate((code) => window.__scSmoke.emitBarcode(code), barcode);
}

async function assertNoOverflow(page, label) {
  const metrics = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
    scrollHeight: document.documentElement.scrollHeight,
    clientHeight: document.documentElement.clientHeight,
  }));
  assert(metrics.scrollWidth <= metrics.clientWidth, `${label}: horizontal overflow`);
  assert(metrics.scrollHeight <= metrics.clientHeight, `${label}: vertical overflow`);
}

async function runEmptyCartAndUnavailableChecks(browser) {
  {
    const { context, page } = await createPage(browser);
    assert(await languageButtonCount(page) === 3, 'welcome exposes PL/EN/VI');
    await page.getByRole('button', { name: /start shopping/i }).click();
    await page.waitForSelector('text=Scan a product');
    assert(await languageButtonCount(page) === 3, 'shopping exposes PL/EN/VI');
    const payDisabled = await page.getByRole('button', { name: /^pay$/i }).isDisabled();
    assert(payDisabled, 'empty cart cannot open payment');
    await assertNoOverflow(page, 'empty shopping');
    await context.close();
  }

  {
    const { context, page } = await createPage(browser, { mode: 'production' });
    await page.waitForSelector('text=This checkout is closed');
    assert(await languageButtonCount(page) === 3, 'unavailable exposes PL/EN/VI');
    assert(await page.getByRole('button', { name: /start shopping/i }).count() === 0, 'unavailable has no shopping CTA');
    await assertNoOverflow(page, 'unavailable');
    await context.close();
  }
}

async function runPrimaryBLIKFlow(browser) {
  const { context, page } = await createPage(browser);

  await emitBarcode(page);
  await page.waitForSelector(`text=${PRODUCT.name}`);
  assert(await languageButtonCount(page) === 3, 'shopping after scanner-start exposes PL/EN/VI');
  await assertNoOverflow(page, 'shopping with item');

  await page.getByLabel('+').last().click();
  await page.getByLabel('+').last().click();
  await page.waitForSelector('text=7,40 zł');
  await page.getByLabel('-').last().click();
  await page.waitForSelector('text=7,20 zł');

  await page.getByRole('button', { name: /^pay$/i }).click();
  await page.waitForSelector('[role="dialog"]');
  assert(await languageButtonCount(page, '[role="dialog"]') === 3, 'payment modal exposes PL/EN/VI');
  assert(await visibleInputCount(page, '[role="dialog"]') === 0, 'payment modal has no visible payment inputs');
  const paymentText = await page.locator('[role="dialog"]').innerText();
  assert(paymentText.includes('Choose payment method'), 'payment modal shows payment choice');
  assert(paymentText.includes('Enter the BLIK code on the payment terminal, not here.'), 'BLIK is terminal-driven');
  assert(!paymentText.includes('______'), 'BLIK keypad placeholder is absent');

  await page.getByRole('button', { name: /^cancel$/i }).click();
  await page.waitForSelector('[role="dialog"]', { state: 'detached' });
  await page.waitForSelector(`text=${PRODUCT.name}`);

  await page.getByRole('button', { name: /^pay$/i }).click();
  await page.waitForSelector('[role="dialog"]');
  await page.getByRole('button', { name: /^BLIK/ }).click();
  await page.waitForSelector('text=Waiting for terminal');
  await page.waitForSelector('text=Finalizing sale', { timeout: 5000 });
  assert(await languageButtonCount(page) === 3, 'receipt exposes PL/EN/VI');
  await page.waitForSelector('text=Thank you!', { timeout: 5000 });
  assert(await languageButtonCount(page) === 3, 'thank-you exposes PL/EN/VI');
  await page.getByRole('button', { name: /start shopping/i }).click();
  await page.waitForSelector('text=Start shopping');

  await context.close();
}

async function runCardTerminalFlow(browser) {
  const { context, page } = await createPage(browser);

  await page.getByRole('button', { name: /start shopping/i }).click();
  await page.waitForSelector('text=Scan a product');
  await emitBarcode(page);
  await page.waitForSelector(`text=${PRODUCT.name}`);
  await page.getByRole('button', { name: /^pay$/i }).click();
  await page.waitForSelector('[role="dialog"]');
  await page.getByRole('button', { name: /^Card/ }).click();
  await page.waitForSelector('text=Waiting for terminal');
  await page.waitForSelector('text=Finalizing sale', { timeout: 5000 });

  await context.close();
}

async function runAbandonAndStaffChecks(browser) {
  {
    const { context, page } = await createPage(browser);
    await page.getByRole('button', { name: /start shopping/i }).click();
    await page.waitForSelector('text=Scan a product');
    await emitBarcode(page);
    await page.waitForSelector(`text=${PRODUCT.name}`);
    await page.getByRole('button', { name: /^abandon$/i }).click();
    await page.getByRole('button', { name: /yes, abandon/i }).click();
    await page.waitForSelector('text=Start shopping');
    const storedCart = await page.evaluate(() => window.__scSmoke.storedCart());
    assert(storedCart.items.length === 0, 'abandon clears the stored cart');
    await context.close();
  }

  {
    const { context, page } = await createPage(browser);
    await page.getByRole('button', { name: /start shopping/i }).click();
    await page.waitForSelector('text=Scan a product');
    await page.getByRole('button', { name: /call staff/i }).click();
    await page.waitForSelector('text=Staff called');
    assert(await languageButtonCount(page) === 3, 'staff lock exposes PL/EN/VI');
    assert(await page.getByRole('button', { name: /^pay$/i }).count() === 0, 'staff lock removes customer pay action');
    await context.close();
  }
}

async function main() {
  const executablePath = findBrowserExecutable();
  const browser = await chromium.launch({
    headless: true,
    ...(executablePath ? { executablePath } : {}),
  });
  try {
    await runEmptyCartAndUnavailableChecks(browser);
    await runPrimaryBLIKFlow(browser);
    await runCardTerminalFlow(browser);
    await runAbandonAndStaffChecks(browser);
  } finally {
    await browser.close();
  }
  console.log(JSON.stringify({
    ok: true,
    url: URL,
    checked: [
      'welcome/shopping language availability',
      'scanner starts shopping and adds product',
      'empty cart payment disabled',
      'bag quantity changes total',
      'payment modal has no visible BLIK/card input',
      'cancel payment returns to cart',
      'BLIK and card terminal-driven demo paths reach receipt',
      'receipt and thank-you language availability',
      'abandon clears cart',
      'call staff locks kiosk',
      'production unavailable has no shopping CTA',
    ],
  }, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
