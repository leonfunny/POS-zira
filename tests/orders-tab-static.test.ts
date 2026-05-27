import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

function readSource(relativePath: string): string {
  return readFileSync(join(__dirname, relativePath), 'utf-8').replace(/\r\n/g, '\n');
}

const ordersTab = readSource('../src/renderer/components/OrdersTab.tsx');
const translations = readSource('../src/renderer/i18n/translations.ts');
const apiClient = readSource('../src/main/network/api-client.ts');
const posModule = readSource('../src/main/modules/pos.module.ts');
const electronDts = readSource('../src/shared/electron.d.ts');
const orderAdapter = readSource('../src/main/sync/pos-order-adapter.ts');

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
      'pos.payment.credit',
    ];

    for (const lang of ['en', 'vi', 'tr', 'zh', 'uk', 'ru', 'pl']) {
      const block = translationBlock(lang);
      for (const key of requiredKeys) {
        expect(block, `${lang} missing ${key}`).toContain(`'${key}'`);
      }
    }
  });

  it('uses the live backend order filters instead of broad period=all fetches', () => {
    expect(ordersTab).toContain('SERVER_ORDER_FETCH_LIMIT = 200');
    expect(ordersTab).toContain('serverPaymentFilter(paymentMethod)');
    expect(ordersTab).toContain("if (method === 'TRANSFER') return { paymentMethod: 'BANK_TRANSFER' }");
    expect(ordersTab).toContain("if (method === 'INVOICE') return { requiresInvoice: true }");
    expect(ordersTab).toContain("if (method === 'INVOICE') return Boolean(order.requires_invoice || order.customer_nip)");
    expect(ordersTab).toContain('from: range.from');
    expect(ordersTab).toContain('to: range.to');
    expect(ordersTab).toContain('...(trimmedSearch ? { search: trimmedSearch } : {})');
    expect(ordersTab).toContain('...(trimmedStaffName ? { staffName: trimmedStaffName } : {})');
    expect(ordersTab).not.toContain("period === 'custom' ? 'all'");
  });

  it('passes supported server order query params through IPC and HTTP', () => {
    expect(apiClient).toContain("if (params.from) qs.set('from', params.from);");
    expect(apiClient).toContain("if (params.to) qs.set('to', params.to);");
    expect(apiClient).toContain("if (params.staffName) qs.set('staffName', params.staffName);");
    expect(apiClient).toContain("if (params.search) qs.set('search', params.search);");
    expect(apiClient).toContain("if (params.paymentMethod) qs.set('paymentMethod', params.paymentMethod);");
    expect(apiClient).toContain("if (params.requiresInvoice !== undefined) qs.set('requiresInvoice', String(params.requiresInvoice));");
    expect(posModule).toContain('type ServerOrderListParams');
    expect(electronDts).toContain('from?: string;');
    expect(electronDts).toContain('staffName?: string;');
    expect(electronDts).toContain('paymentMethod?: string;');
    expect(electronDts).toContain('requiresInvoice?: boolean;');
  });

  it('adapts inline server order item quantities from weighted-aware fields', () => {
    expect(orderAdapter).toContain('item.saleQuantity ?? item.sale_quantity ?? item.quantity ?? item.totalUnits ?? item.packQuantity ?? 1');
    expect(orderAdapter).toContain('item.variantSku ?? item.productSku ?? null');
    expect(orderAdapter).toContain('calculateLineTotalGrosze(price, quantity, sellBy)');
    expect(orderAdapter).toContain('requires_invoice: Boolean(s.requiresInvoice)');
  });
});
