import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

function readSource(relativePath: string): string {
  return readFileSync(join(__dirname, relativePath), 'utf-8').replace(/\r\n/g, '\n');
}

const ordersTab = readSource('../src/renderer/components/OrdersTab.tsx');
const translations = readSource('../src/renderer/i18n/translations.ts');

function translationBlock(lang: string): string {
  const match = translations.match(new RegExp(`\\n  ${lang}: \\{([\\s\\S]*?)(?=\\n  [a-z]{2}: \\{|\\n\\};)`));
  return match?.[1] || '';
}

describe('Orders tab localization and contract', () => {
  it('keeps data-source and backend fallback messages localized', () => {
    expect(ordersTab).toContain("orders.source.localServer");
    expect(ordersTab).toContain("orders.source.serverUnreachable");
    expect(ordersTab).toContain("orders.source.localOnly");
    expect(ordersTab).toContain("orders.loadFailed");
    expect(ordersTab).toContain("orders.mirrorFailed");
    expect(ordersTab).toContain('dataSourceLabel(dataSource, t)');
    expect(ordersTab).not.toContain("return 'Split'");
  });

  it('keeps required order labels present in every configured language', () => {
    const requiredKeys = [
      'orders.title',
      'orders.subtitle',
      'orders.source.localServer',
      'orders.source.serverUnreachable',
      'orders.source.localOnly',
      'orders.loadFailed',
      'orders.mirrorFailed',
      'orders.reprint',
      'orders.status.completed',
      'orders.status.partial_refund',
      'pos.payment.split',
      'pos.payment.bank_transfer',
    ];

    for (const lang of ['en', 'vi', 'tr', 'zh', 'uk', 'ru', 'pl']) {
      const block = translationBlock(lang);
      for (const key of requiredKeys) {
        expect(block, `${lang} missing ${key}`).toContain(`'${key}'`);
      }
    }
  });
});
