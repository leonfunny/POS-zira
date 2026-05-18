/**
 * PRD-driven self-checkout smoke.
 *
 * Source requirements: docs/SELF_CHECKOUT_DESIGN_BRIEF.md.
 * This checks the customer flow, not implementation internals:
 * welcome -> scanner-start shopping -> cart/bag quantity -> payment modal
 * -> assisted BLIK/card -> receipt -> thank-you/reset, plus abandon,
 * staff lock, empty-cart pay disabled, and production welcome language switching.
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
const COMPACT_CART_PRODUCTS = [
  PRODUCT,
  {
    ...PRODUCT,
    id: 'prd-smoke-bamboo-1l',
    template_id: 'prd-smoke-bamboo',
    name: 'Bamboo Tree coconut water 1L',
    sku: 'BAMBOO-1L',
    barcode: '5900000000012',
    retail_price: 700,
  },
  {
    ...PRODUCT,
    id: 'prd-smoke-gengar-case',
    template_id: 'prd-smoke-gengar',
    name: 'Etui-sluchawki-gengar',
    sku: 'GENGAR-CASE',
    barcode: '5900000000013',
    retail_price: 200,
  },
];
const PRODUCTS_BY_BARCODE = Object.fromEntries(
  COMPACT_CART_PRODUCTS.map((product) => [product.barcode, product]),
);

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

  await page.addInitScript(({ productsByBarcode, config }) => {
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
          getAll: async () => Object.values(productsByBarcode),
          getByBarcode: async (barcode) => productsByBarcode[barcode] || null,
          getByCategory: async () => [],
          searchByCode: async () => [],
          search: async () => [],
        },
      },
      selfCheckout: {
        helpRequest: async () => ({ id: 'prd-smoke-help', acknowledgedAt: null }),
        checkStatus: async () => ({ id: 'prd-smoke-help', acknowledgedAt: null, resolvedAt: null }),
      },
    };
  }, {
    productsByBarcode: PRODUCTS_BY_BARCODE,
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
    if (input.type === 'checkbox') return false;
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

async function assertPaymentDialogViewportSafe(page, label) {
  const metrics = await page.evaluate(() => {
    const dialog = document.querySelector('[role="dialog"]');
    const body = dialog?.querySelector('.sc-payment-body');
    if (!dialog) return { exists: false };

    const dialogRect = dialog.getBoundingClientRect();
    const dialogStyle = window.getComputedStyle(dialog);
    const bodyStyle = body ? window.getComputedStyle(body) : null;
    const clippedButtons = Array.from(dialog.querySelectorAll('button'))
      .map((button) => {
        const rect = button.getBoundingClientRect();
        return {
          text: (button.textContent || '').trim().replace(/\s+/g, ' '),
          bottom: rect.bottom,
          right: rect.right,
          visible: rect.width > 0
            && rect.height > 0
            && window.getComputedStyle(button).visibility !== 'hidden'
            && window.getComputedStyle(button).display !== 'none',
        };
      })
      .filter((button) => button.visible)
      .filter((button) => (
        button.bottom > dialogRect.bottom + 1
        || button.right > dialogRect.right + 1
      ));

    const bodyScrollable = Boolean(body)
      && ['auto', 'scroll'].includes(bodyStyle?.overflowY || '')
      && body.scrollHeight >= body.clientHeight;

    return {
      exists: true,
      dialogClientHeight: dialog.clientHeight,
      dialogScrollHeight: dialog.scrollHeight,
      dialogOverflowY: dialogStyle.overflowY,
      bodyClientHeight: body?.clientHeight ?? 0,
      bodyScrollHeight: body?.scrollHeight ?? 0,
      bodyOverflowY: bodyStyle?.overflowY ?? '',
      bodyScrollable,
      clippedButtons,
    };
  });

  assert(metrics.exists, `${label}: payment dialog is missing`);
  assert(
    metrics.dialogScrollHeight <= metrics.dialogClientHeight + 1 || metrics.bodyScrollable,
    `${label}: dialog content is hard-clipped (dialog ${metrics.dialogScrollHeight}/${metrics.dialogClientHeight}, body ${metrics.bodyScrollHeight}/${metrics.bodyClientHeight}, overflow=${metrics.bodyOverflowY})`,
  );
  assert(
    metrics.clippedButtons.length === 0,
    `${label}: visible payment controls are clipped: ${metrics.clippedButtons.map((button) => button.text).join(', ')}`,
  );
}

async function assertCartRowsVisible(page, minRows, label) {
  const metrics = await page.evaluate(() => {
    const footer = document.querySelector('aside > div:last-child');
    const footerTop = footer?.getBoundingClientRect().top ?? window.innerHeight;
    const rows = Array.from(document.querySelectorAll('aside li')).map((row) => {
      const rect = row.getBoundingClientRect();
      return {
        full: rect.top >= 0 && rect.bottom <= footerTop,
        height: rect.height,
      };
    });
    return {
      rowCount: rows.length,
      fullRows: rows.filter((row) => row.full).length,
      cartViewportHeight: document.querySelector('aside .overflow-y-auto')?.clientHeight ?? 0,
      footerHeight: footer?.getBoundingClientRect().height ?? 0,
    };
  });
  assert(metrics.rowCount >= minRows, `${label}: expected ${minRows} cart rows, got ${metrics.rowCount}`);
  assert(
    metrics.fullRows >= minRows,
    `${label}: expected ${minRows} fully visible cart rows, got ${metrics.fullRows} (cart=${metrics.cartViewportHeight}, footer=${metrics.footerHeight})`,
  );
}

async function assertReceiptTotalVisible(page, label) {
  const metrics = await page.evaluate(() => {
    const totals = Array.from(document.querySelectorAll('.sc-tabular'));
    const total = totals[totals.length - 1];
    const rect = total?.getBoundingClientRect();
    return {
      exists: Boolean(rect),
      top: rect?.top ?? -1,
      bottom: rect?.bottom ?? -1,
      viewportHeight: window.innerHeight,
    };
  });
  assert(metrics.exists, `${label}: receipt total is missing`);
  assert(
    metrics.top >= 0 && metrics.bottom <= metrics.viewportHeight,
    `${label}: receipt total is clipped (${metrics.top}-${metrics.bottom} of ${metrics.viewportHeight})`,
  );
}

async function runEmptyCartAndProductionChecks(browser) {
  {
    const { context, page } = await createPage(browser);
    assert(await languageButtonCount(page) === 3, 'welcome exposes PL/EN/VI');
    await page.getByRole('button', { name: /^grocery$/i }).click();
    await page.waitForSelector('text=Scan a product');
    assert(await languageButtonCount(page) === 3, 'shopping exposes PL/EN/VI');
    const payDisabled = await page.getByRole('button', { name: /^pay$/i }).isDisabled();
    assert(payDisabled, 'empty cart cannot open payment');
    await assertNoOverflow(page, 'empty shopping');
    await context.close();
  }

  {
    const { context, page } = await createPage(browser, { mode: 'production' });
    assert(await languageButtonCount(page) === 3, 'production welcome exposes PL/EN/VI');
    assert(await page.getByRole('button', { name: /^grocery$/i }).count() > 0, 'production welcome has shopping CTA');
    await assertNoOverflow(page, 'production welcome');
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
  await assertPaymentDialogViewportSafe(page, 'payment modal');
  assert(await languageButtonCount(page, '[role="dialog"]') === 3, 'payment modal exposes PL/EN/VI');
  assert(await visibleInputCount(page, '[role="dialog"]') === 0, 'payment modal has no visible payment inputs');
  const paymentText = await page.locator('[role="dialog"]').innerText();
  assert(paymentText.includes('Choose payment method'), 'payment modal shows payment choice');
  assert(paymentText.includes('Send via BLIK to the shop phone number.'), 'BLIK is assisted phone-transfer driven');
  assert(!paymentText.includes('______'), 'BLIK keypad placeholder is absent');

  await page.getByRole('button', { name: /^cancel$/i }).click();
  await page.waitForSelector('[role="dialog"]', { state: 'detached' });
  await page.waitForSelector(`text=${PRODUCT.name}`);

  await page.getByRole('button', { name: /^pay$/i }).click();
  await page.waitForSelector('[role="dialog"]');
  await page.getByRole('button', { name: /^BLIK/ }).click();
  await page.waitForSelector('text=Money received');
  await page.getByRole('button', { name: /^Money received$/i }).click();
  await page.waitForSelector('text=Finalizing sale', { timeout: 5000 });
  assert(await languageButtonCount(page) === 3, 'receipt exposes PL/EN/VI');
  await page.waitForSelector('text=Thank you!', { timeout: 8000 });
  assert(await languageButtonCount(page) === 3, 'thank-you exposes PL/EN/VI');
  await page.getByRole('button', { name: /start shopping/i }).click();
  await page.waitForSelector('text=Start shopping');

  await context.close();
}

async function runCardTerminalFlow(browser) {
  const { context, page } = await createPage(browser);

  await page.getByRole('button', { name: /^grocery$/i }).click();
  await page.waitForSelector('text=Scan a product');
  await emitBarcode(page);
  await page.waitForSelector(`text=${PRODUCT.name}`);
  await page.getByRole('button', { name: /^pay$/i }).click();
  await page.waitForSelector('[role="dialog"]');
  await page.getByRole('button', { name: /^Card/ }).click();
  await page.waitForSelector('text=Money received');
  await page.getByRole('button', { name: /^Money received$/i }).click();
  await page.waitForSelector('text=Finalizing sale', { timeout: 5000 });

  await context.close();
}

async function runCompactViewportChecks(browser) {
  const { context, page } = await createPage(browser, {
    viewport: { width: 1280, height: 720 },
  });

  for (const product of COMPACT_CART_PRODUCTS) {
    await emitBarcode(page, product.barcode);
  }
  await page.waitForSelector(`text=${COMPACT_CART_PRODUCTS[2].name}`);
  await assertNoOverflow(page, 'compact shopping');
  await assertCartRowsVisible(page, 3, 'compact shopping');

  await page.getByRole('button', { name: /^pay$/i }).click();
  await page.waitForSelector('[role="dialog"]');
  await assertNoOverflow(page, 'compact payment modal');
  await assertPaymentDialogViewportSafe(page, 'compact payment modal');
  await page.getByRole('button', { name: /^Card/ }).click();
  await page.waitForSelector('text=Money received');
  await page.getByRole('button', { name: /^Money received$/i }).click();
  await page.waitForSelector('text=Finalizing sale', { timeout: 5000 });
  await assertNoOverflow(page, 'compact receipt');
  await assertReceiptTotalVisible(page, 'compact receipt');

  await context.close();
}

async function runAbandonAndStaffChecks(browser) {
  {
    const { context, page } = await createPage(browser);
    await page.getByRole('button', { name: /^grocery$/i }).click();
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
    await page.getByRole('button', { name: /^grocery$/i }).click();
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
    await runEmptyCartAndProductionChecks(browser);
    await runPrimaryBLIKFlow(browser);
    await runCardTerminalFlow(browser);
    await runCompactViewportChecks(browser);
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
      'BLIK and card assisted-payment demo paths reach receipt',
      'receipt and thank-you language availability',
      'compact viewport shows three cart rows and unclipped receipt total',
      'abandon clears cart',
      'call staff locks kiosk',
      'production welcome remains available',
    ],
  }, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
