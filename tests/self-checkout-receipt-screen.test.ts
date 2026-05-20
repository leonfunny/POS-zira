import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import ReceiptScreen from '../src/renderer/windows/self-checkout/screens/ReceiptScreen';

describe('self-checkout receipt screen', () => {
  it('does not offer a continue path when fiscal receipt printing fails', () => {
    const html = renderToStaticMarkup(
      React.createElement(ReceiptScreen, {
        lang: 'en',
        mode: 'production',
        method: 'CARD',
        totalGrosze: 700,
        receiptPrinted: false,
        fiscalPrinting: false,
        onComplete: () => undefined,
        onLangChange: () => undefined,
        onCallStaff: () => undefined,
      }),
    );

    expect(html).toContain('Payment was accepted, but the receipt did not print');
    expect(html).toContain('Order saved');
    expect(html).toContain('Fiscal receipt');
    expect(html).toContain('Call staff');
    expect(html).not.toContain('Continue');
    expect(html).not.toContain('Thank you');
  });
});
