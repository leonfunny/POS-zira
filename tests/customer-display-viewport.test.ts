import fs from 'node:fs';
import path from 'node:path';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import CustomerDisplayShell from '../src/renderer/windows/customer/components/CustomerDisplayShell';
import IdleView from '../src/renderer/windows/customer/views/IdleView';
import RetailAssistedIdleView from '../src/renderer/windows/customer/views/RetailAssistedIdleView';
import RetailAssistedCartView from '../src/renderer/windows/customer/views/RetailAssistedCartView';
import RetailAssistedThankYouView from '../src/renderer/windows/customer/views/RetailAssistedThankYouView';

const REPO_ROOT = path.resolve(__dirname, '..');

describe('Customer display viewport contract', () => {
  it('renders CustomerDisplayShell with fixed-height viewport wrappers', () => {
    const markup = renderToStaticMarkup(
      React.createElement(CustomerDisplayShell, {
        language: 'en',
        onLanguageChange: () => undefined,
        title: 'Walk-in',
        subtitle: 'Enter your name',
        children: React.createElement('div', null, 'content'),
      }),
    );

    expect(markup).toContain('relative h-screen overflow-hidden');
    expect(markup).toContain('relative z-10 flex h-full flex-col overflow-hidden');
    expect(markup).not.toContain('min-h-screen');
  });

  it('renders IdleView inside a fixed-height viewport shell', () => {
    const markup = renderToStaticMarkup(
      React.createElement(IdleView, {
        salonName: 'Zira AI',
      }),
    );

    expect(markup).toContain('h-screen');
    expect(markup).toContain('bg-gradient-to-br');
    expect(markup).not.toContain('min-h-screen');
  });

  it('scopes fixed-height root rules to the customer renderer entrypoint', () => {
    const entrySource = fs.readFileSync(
      path.join(REPO_ROOT, 'src/renderer/windows/customer/main.tsx'),
      'utf8',
    );
    const cssSource = fs.readFileSync(
      path.join(REPO_ROOT, 'src/renderer/index.css'),
      'utf8',
    );

    expect(entrySource).toContain("document.documentElement.classList.add('customer-display-root')");
    expect(entrySource).toContain("document.body.classList.add('customer-display-root')");
    expect(cssSource).toContain('html.customer-display-root');
    expect(cssSource).toContain('html.customer-display-root body');
    expect(cssSource).toContain('html.customer-display-root body #root');
    expect(cssSource).toContain('overflow: hidden;');
  });

  it('removes min-height fallback wrappers from CustomerApp customer-display modes', () => {
    const appSource = fs.readFileSync(
      path.join(REPO_ROOT, 'src/renderer/windows/customer/CustomerApp.tsx'),
      'utf8',
    );

    expect(appSource).not.toContain('min-h-screen');
    expect(appSource).toContain('h-screen');
  });

  it('routes customer display profiles before salon display modes', () => {
    const appSource = fs.readFileSync(
      path.join(REPO_ROOT, 'src/renderer/windows/customer/CustomerApp.tsx'),
      'utf8',
    );

    expect(appSource).toContain("displayProfile === 'promo_only'");
    expect(appSource).toContain("displayProfile === 'retail_assisted'");
    expect(appSource).toContain('useState<LiveCustomerDisplayProfile | null>(null)');
    expect(appSource).toContain('if (!displayProfile)');
    expect(appSource.indexOf('if (!displayProfile)')).toBeLessThan(appSource.indexOf("displayProfile === 'promo_only'"));
    expect(appSource.indexOf("displayProfile === 'retail_assisted'")).toBeLessThan(appSource.indexOf("displayMode === 'checkin'"));
    expect(appSource.indexOf("displayProfile === 'promo_only'")).toBeLessThan(appSource.indexOf("displayMode === 'checkin'"));
  });

  it('keeps promo_only routing off the retail assisted idle surface', () => {
    const appSource = fs.readFileSync(
      path.join(REPO_ROOT, 'src/renderer/windows/customer/CustomerApp.tsx'),
      'utf8',
    );
    const promoOnlyStart = appSource.indexOf("displayProfile === 'promo_only'");
    const retailAssistedStart = appSource.indexOf("displayProfile === 'retail_assisted'");

    expect(promoOnlyStart).toBeGreaterThan(-1);
    expect(retailAssistedStart).toBeGreaterThan(promoOnlyStart);

    const promoOnlyBlock = appSource.slice(promoOnlyStart, retailAssistedStart);
    expect(promoOnlyBlock).toContain('PromoOnlyIdleView');
    expect(promoOnlyBlock).toContain("displayMode === 'promo'");
    expect(promoOnlyBlock).toContain('fallback={');
    expect(promoOnlyBlock).not.toContain('RetailAssistedIdleView');
  });

  it('keeps the promo_only idle surface neutral and free of assisted retail copy', () => {
    const promoOnlyViewPath = path.join(
      REPO_ROOT,
      'src/renderer/windows/customer/views/PromoOnlyIdleView.tsx',
    );
    const promoOnlyViewSource = fs.existsSync(promoOnlyViewPath)
      ? fs.readFileSync(promoOnlyViewPath, 'utf8')
      : '';

    expect(fs.existsSync(promoOnlyViewPath)).toBe(true);
    expect(promoOnlyViewSource).toContain('data-customer-display-promo-only-idle="true"');
    expect(promoOnlyViewSource).not.toContain('customer.retail');
    expect(promoOnlyViewSource).not.toMatch(/Staff will scan your items|Your items will appear here/i);
  });

  it('renders retail assisted idle copy without self-scan language', () => {
    const t = (key: string) => ({
      'customer.retail.idleTitle': 'Staff will scan your items',
      'customer.retail.idleSubtitle': 'Your items will appear here',
      'customer.retail.paymentPrompt': 'Staff will take payment when ready',
      'customer.brandName': 'Zira AI',
    }[key] || key);

    const markup = renderToStaticMarkup(
      React.createElement(RetailAssistedIdleView, {
        t,
        businessName: 'Retail Shop',
      }),
    );

    expect(markup).toContain('Staff will scan your items');
    expect(markup).toContain('Your items will appear here');
    expect(markup).not.toMatch(/scan a product|self-checkout|pay now/i);
  });

  it('renders retail assisted cart without salon upsell copy', () => {
    const t = (key: string) => ({
      'customer.retail.cartTitle': 'Your items',
      'customer.retail.cartSubtitle': 'Staff will continue adding your items',
      'customer.retail.paymentPrompt': 'Staff will take payment when ready',
      'customer.retail.paymentStatus': 'Payment status',
      'customer.retail.total': 'Total',
      'customer.discount': 'Discount',
      'customer.retail.idleSubtitle': 'Your items will appear here',
    }[key] || key);

    const markup = renderToStaticMarkup(
      React.createElement(RetailAssistedCartView, {
        t,
        language: 'en',
        cart: {
          items: [
            { id: '1', variantId: 'v1', name: 'Coffee', sku: 'COF', price: 1000, quantity: 2, total: 2000 },
          ],
          subtotal: 2000,
          discount: 0,
          tax: 0,
          total: 2000,
        },
      }),
    );

    expect(markup).toContain('Your items');
    expect(markup).toContain('Staff will continue adding your items');
    expect(markup).not.toContain('Complete your look');
    expect(markup).not.toContain('Add to my visit');
  });

  it('renders retail assisted thank-you without salon booking copy', () => {
    const t = (key: string) => ({
      'customer.retail.thankYou': 'Thank you',
      'customer.retail.thankYouSubtitle': 'Your payment is complete',
    }[key] || key);

    const markup = renderToStaticMarkup(
      React.createElement(RetailAssistedThankYouView, {
        t,
        language: 'en',
        lastOrderTotal: 2000,
      }),
    );

    expect(markup).toContain('Your payment is complete');
    expect(markup).not.toContain('Book your next visit');
    expect(markup).not.toContain('Scan to book online');
  });

  it('includes Polish public copy for retail assisted display', () => {
    const translationsSource = fs.readFileSync(
      path.join(REPO_ROOT, 'src/renderer/i18n/translations.ts'),
      'utf8',
    );

    expect(translationsSource).toContain("'customer.retail.idleTitle': 'Obsługa zeskanuje Twoje produkty'");
    expect(translationsSource).toContain("'customer.retail.idleSubtitle': 'Twoje produkty pojawią się tutaj'");
    expect(translationsSource).toContain("'customer.retail.paymentPrompt': 'Obsługa przyjmie płatność, gdy zamówienie będzie gotowe'");
    expect(translationsSource).toContain("'customer.retail.thankYouSubtitle': 'Płatność zakończona'");
  });
});
