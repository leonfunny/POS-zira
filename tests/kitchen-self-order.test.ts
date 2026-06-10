import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  formatKitchenSelfOrderNumber,
  normalizeKitchenSelfOrderQuantity,
  sanitizeKitchenSelfOrderNote,
} from '../src/shared/kitchen-self-order';

function readSource(relativePath: string): string {
  return readFileSync(new URL(`../${relativePath}`, import.meta.url), 'utf8');
}

describe('kitchen self-order MVP wiring', () => {
  it('formats customer-facing order numbers as K-042 style', () => {
    expect(formatKitchenSelfOrderNumber(1)).toBe('K-001');
    expect(formatKitchenSelfOrderNumber(42)).toBe('K-042');
    expect(formatKitchenSelfOrderNumber(1002)).toBe('K-1002');
  });

  it('normalizes kiosk quantities and notes before persistence', () => {
    expect(normalizeKitchenSelfOrderQuantity(0)).toBe(1);
    expect(normalizeKitchenSelfOrderQuantity(200)).toBe(99);
    expect(sanitizeKitchenSelfOrderNote('  no   onion  ')).toBe('no onion');
    expect(sanitizeKitchenSelfOrderNote('')).toBeNull();
  });

  it('uses separate local tables instead of POS orders/order_items', () => {
    const migrationSource = readSource('src/main/database/migrations.ts');
    const repoSource = readSource('src/main/database/repos/kitchen-self-order-repo.ts');

    expect(migrationSource).toContain('CREATE TABLE IF NOT EXISTS kitchen_self_orders');
    expect(migrationSource).toContain('CREATE TABLE IF NOT EXISTS kitchen_self_order_items');
    expect(repoSource).toContain('formatKitchenSelfOrderNumber(sequence)');
    expect(repoSource).not.toContain('INSERT INTO orders');
    expect(repoSource).not.toContain('INSERT INTO order_items');
  });

  it('has a separate window, preload, Vite entry, and IPC namespace', () => {
    const windowSource = readSource('src/main/windows/window-manager.ts');
    const viteSource = readSource('vite.config.ts');
    const preloadSource = readSource('src/preload/preload-kitchen-self-order.ts');
    const posModuleSource = readSource('src/main/modules/pos.module.ts');

    expect(windowSource).toContain('kitchenSelfOrder');
    expect(windowSource).toContain('preload-kitchen-self-order.js');
    expect(viteSource).toContain('windows/kitchen-self-order/index.html');
    expect(preloadSource).toContain('kitchen-self-order:submit');
    expect(posModuleSource).toContain("ipcMain.handle('kitchen-self-order:submit'");
    expect(posModuleSource).toContain('printKitchenSelfOrderTicket(ticket)');
    expect(posModuleSource).toContain('printKitchenSelfOrderCustomerSlip(ticket)');
  });

  it('operator launch settings are separate from store self-checkout settings', () => {
    const tabSource = readSource('src/renderer/components/SelfCheckoutTab.tsx');

    expect(tabSource).toContain("window.open('kitchenSelfOrder')");
    expect(tabSource).toContain('kitchenSelfOrderLanguage');
    expect(tabSource).toContain('kitchenSelfOrderDefaultFulfillment');
    expect(tabSource).toContain('kitchenSelfOrderSlipPrinterType');
    expect(tabSource).toContain('selfCheckoutProfile');
  });

  it('opens directly on the menu while keeping language and fulfillment editable inline', () => {
    const appSource = readSource('src/renderer/windows/kitchen-self-order/KitchenSelfOrderApp.tsx');

    expect(appSource).toContain("useState<Step>('menu')");
    expect(appSource).toContain('function FulfillmentToggle');
    expect(appSource).toContain('function LanguageToggle');
    expect(appSource).not.toContain("setStep('language')");
    expect(appSource).not.toContain("setStep('fulfillment')");
  });
});
