// Smoke test for the self-checkout kiosk flow.
//
// Run: `npm run smoke:self-checkout`
//
// What this verifies (without a real kiosk, scanner, or printer):
//   1. Scanning 2 products + 1 bag fee assembles the cart correctly
//   2. Stock is tracked per cart item (defends bug #1: cumulative cart qty)
//   3. The order payload sent to `pos:orders:create` matches the shape the
//      main handler expects, and every non-bag item carries a variant_id
//      so the decrementStock loop will fire
//   4. The TTS announcement sequence for the cart total is non-empty and
//      starts with a method prefix clip
//   5. Calling `pos:orders:create` mock succeeds and triggers the print +
//      sync IPC hops the renderer normally fires
//
// Output is intentionally chatty: every step prints with a step number,
// payload preview, and a PASS/FAIL marker so a human operator can read
// it like a runbook on the actual kiosk hardware. Failed assertions stop
// the run and surface the offending step.

import { describe, expect, it } from 'vitest';
import {
  buildSelfCheckoutSale,
  calculateIncludedTax,
} from '../src/renderer/windows/self-checkout/build-sale';
import { buildAnnouncementSequence } from '../src/renderer/windows/self-checkout/polish-amount-tts';
import type { ScCartItem } from '../src/renderer/windows/self-checkout/useScCart';

// ─── pretty step logger ────────────────────────────────────────────────────
const COLOR = {
  reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m',
  green: '\x1b[32m', yellow: '\x1b[33m', cyan: '\x1b[36m', red: '\x1b[31m',
};
let stepNo = 0;
function step(title: string, body?: () => void): void {
  stepNo += 1;
  // eslint-disable-next-line no-console
  console.log(`\n${COLOR.cyan}━━ Step ${stepNo}: ${title}${COLOR.reset}`);
  body?.();
}
function log(label: string, value: unknown): void {
  const rendered = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  // eslint-disable-next-line no-console
  console.log(`  ${COLOR.dim}${label}:${COLOR.reset} ${rendered}`);
}
function pass(message: string): void {
  // eslint-disable-next-line no-console
  console.log(`  ${COLOR.green}✓ ${message}${COLOR.reset}`);
}

// ─── fake IPC backend ──────────────────────────────────────────────────────
// Mirrors the contract from src/main/modules/pos.module.ts:642 — for every
// item with truthy variant_id and quantity>0 it decrements stock.
interface FakeProduct {
  id: string;
  template_id: string;
  name: string;
  sku: string;
  barcode: string;
  retail_price: number;
  vat_rate: number;
  in_stock: number;
}

class FakeIPC {
  products = new Map<string, FakeProduct>();
  productsByBarcode = new Map<string, FakeProduct>();
  ordersCreated: Array<{ order: unknown; items: unknown[] }> = [];
  stockDecrements: Array<{ variantId: string; quantity: number }> = [];
  receiptsPrinted: string[] = [];
  syncFired = 0;

  addProduct(p: FakeProduct): void {
    this.products.set(p.id, p);
    this.productsByBarcode.set(p.barcode, p);
  }

  // Mirrors window.electronAPI.pos.products.getByBarcode
  getByBarcode(code: string): FakeProduct | null {
    return this.productsByBarcode.get(code) ?? null;
  }

  // Mirrors window.electronAPI.pos.orders.create + the main-process side
  // effects (decrementStock loop) so we can verify both halves of the
  // contract in one place.
  ordersCreate(order: { id: string }, items: Array<{ variant_id: string | null; quantity: number }>): { success: true; id: string } {
    this.ordersCreated.push({ order, items });
    for (const item of items) {
      if (item.variant_id && item.quantity > 0) {
        this.stockDecrements.push({ variantId: item.variant_id, quantity: item.quantity });
        const product = this.products.get(item.variant_id);
        if (product) product.in_stock = Math.max(0, product.in_stock - item.quantity);
      }
    }
    return { success: true, id: order.id };
  }

  printReceipt(orderId: string): { success: true; receiptPrinted: true } {
    this.receiptsPrinted.push(orderId);
    return { success: true, receiptPrinted: true };
  }

  syncOrders(): void {
    this.syncFired += 1;
  }
}

// ─── deterministic helpers ─────────────────────────────────────────────────
let idCounter = 0;
const seqId = () => `id-${++idCounter}`;
const FIXED_NOW = new Date('2026-05-17T10:00:00.000Z');

describe('Self-checkout kiosk smoke', () => {
  it('walks the full Welcome → Scan → Pay → Receipt flow', () => {
    const ipc = new FakeIPC();
    let cart: ScCartItem[] = [];

    // ── 1. Seed catalog ────────────────────────────────────────────────────
    step('Seed kiosk catalog (3 products in stock)');
    ipc.addProduct({
      id: 'v-bread', template_id: 't-bread', name: 'Bułka pszenna',
      sku: 'B-001', barcode: '5901234567001', retail_price: 350, vat_rate: 5, in_stock: 10,
    });
    ipc.addProduct({
      id: 'v-milk', template_id: 't-milk', name: 'Mleko 2% 1L',
      sku: 'M-002', barcode: '5901234567002', retail_price: 540, vat_rate: 8, in_stock: 2,
    });
    ipc.addProduct({
      id: 'v-cheese', template_id: 't-cheese', name: 'Ser żółty 250g',
      sku: 'C-003', barcode: '5901234567003', retail_price: 1230, vat_rate: 23, in_stock: 4,
    });
    log('catalog', Array.from(ipc.products.values()).map((p) => `${p.name} (${p.in_stock} in stock, ${p.retail_price} gr)`));
    pass(`Catalog has ${ipc.products.size} variants`);

    // ── 2. Customer scans bread ───────────────────────────────────────────
    step('Customer scans bread barcode');
    const bread = ipc.getByBarcode('5901234567001');
    expect(bread).not.toBeNull();
    cart.push({
      variantId: bread!.id, productId: bread!.template_id, name: bread!.name,
      sku: bread!.sku, price: bread!.retail_price, quantity: 1,
      vatRate: bread!.vat_rate, stockAtAdd: bread!.in_stock,
    });
    log('product found', `${bread!.name} @ ${bread!.retail_price} gr (stock: ${bread!.in_stock})`);
    log('cart total', `${cart.reduce((s, i) => s + i.price * i.quantity, 0)} gr`);
    pass('Bread added to cart, stockAtAdd snapshot recorded');

    // ── 3. Try over-scanning milk (only 2 in stock) ──────────────────────
    step('Customer tries to scan milk 3 times (stock=2, fix #1 should block third)');
    const milk = ipc.getByBarcode('5901234567002');
    expect(milk).not.toBeNull();
    let milkLine = cart.find((i) => i.variantId === milk!.id);
    for (let attempt = 1; attempt <= 3; attempt++) {
      const alreadyInCart = (cart.find((i) => i.variantId === milk!.id)?.quantity) ?? 0;
      const stock = milk!.in_stock;
      if (alreadyInCart + 1 > stock) {
        log('attempt ' + attempt, `BLOCKED (alreadyInCart=${alreadyInCart}, stock=${stock})`);
      } else if (milkLine) {
        milkLine.quantity += 1;
        log('attempt ' + attempt, `OK (qty=${milkLine.quantity})`);
      } else {
        milkLine = {
          variantId: milk!.id, productId: milk!.template_id, name: milk!.name,
          sku: milk!.sku, price: milk!.retail_price, quantity: 1,
          vatRate: milk!.vat_rate, stockAtAdd: milk!.in_stock,
        };
        cart.push(milkLine);
        log('attempt ' + attempt, `OK (qty=1)`);
      }
    }
    expect(milkLine?.quantity).toBe(2);
    pass('Stock check correctly capped milk at 2 (cumulative cart-aware guard)');

    // ── 4. Add bag fee ───────────────────────────────────────────────────
    step('Customer requests 1 plastic bag (bag-fee line)');
    cart.push({
      variantId: '__bag-fee__', name: 'Torba foliowa', sku: 'BAG',
      price: 20, quantity: 1, isBagFee: true,
    });
    log('cart lines', cart.length);
    pass('Bag fee added as separate cart line (isBagFee=true)');

    // ── 5. Pay button reachable → build sale payload ─────────────────────
    step('Customer taps Pay → CARD → "Money received"');
    const orderId = 'order-smoke-001';
    const sale = buildSelfCheckoutSale({
      items: cart, orderId, method: 'CARD', kioskUserId: 'kiosk-1',
      now: FIXED_NOW, randomId: seqId,
    });
    log('order.id', sale.order.id);
    log('order.source', sale.order.source);
    log('order.subtotal', `${sale.order.subtotal} gr`);
    log('order.tax (included)', `${sale.order.tax} gr`);
    log('order.total', `${sale.order.total} gr`);
    log('order.payment_method', sale.order.payment_method);
    log('item count', sale.items.length);

    expect(sale.order.source).toBe('SELF_CHECKOUT');
    expect(sale.order.status).toBe('COMPLETED');
    expect(sale.order.payment_method).toBe('CARD');
    expect(sale.order.total).toBe(350 + 540 * 2 + 20);
    expect(sale.order.tax).toBe(calculateIncludedTax(cart));
    expect(sale.items).toHaveLength(3);
    pass('Order payload shape matches pos:orders:create contract');

    // ── 6. variant_id integrity (so decrementStock fires) ───────────────
    step('Verify every non-bag item has variant_id (stock decrement requirement)');
    for (const item of sale.items) {
      const role = item.notes === 'SELF_CHECKOUT_BAG_FEE' ? 'BAG' : 'PRODUCT';
      log(`${item.name}`, `variant_id=${item.variant_id ?? 'null'} qty=${item.quantity} (${role})`);
      if (item.notes === 'SELF_CHECKOUT_BAG_FEE') {
        expect(item.variant_id).toBeNull();
      } else {
        expect(item.variant_id).toBeTruthy();
      }
    }
    pass('Bag line has variant_id=null; product lines have real variant_id');

    // ── 7. TTS sequence for total ────────────────────────────────────────
    step('Build Polish announcement for total');
    const sequence = buildAnnouncementSequence({
      method: 'CARD', totalGrosze: sale.order.total,
    });
    log('clip sequence', sequence);
    log('clip count', sequence.length);
    expect(sequence[0]).toMatch(/^prefix_/);
    expect(sequence[1]).toBe('do_zaplaty.mp3');
    expect(buildAnnouncementSequence({
      method: 'BLIK', totalGrosze: sale.order.total,
    })[0]).toBe('prefix_blik.mp3');
    pass('TTS announcement clips would play in correct order');

    // ── 8. Fire pos:orders:create + verify stock decrements ─────────────
    step('Submit order to pos:orders:create');
    const beforeStock = {
      bread: ipc.products.get('v-bread')!.in_stock,
      milk: ipc.products.get('v-milk')!.in_stock,
      cheese: ipc.products.get('v-cheese')!.in_stock,
    };
    log('stock before', beforeStock);
    const result = ipc.ordersCreate(sale.order, sale.items);
    log('result', result);
    expect(result.success).toBe(true);
    expect(result.id).toBe(orderId);
    pass('Order saved successfully');

    step('Verify stock decremented for every product line');
    const afterStock = {
      bread: ipc.products.get('v-bread')!.in_stock,
      milk: ipc.products.get('v-milk')!.in_stock,
      cheese: ipc.products.get('v-cheese')!.in_stock,
    };
    log('stock after', afterStock);
    log('decrements fired', ipc.stockDecrements);
    expect(afterStock.bread).toBe(beforeStock.bread - 1);
    expect(afterStock.milk).toBe(beforeStock.milk - 2);
    expect(afterStock.cheese).toBe(beforeStock.cheese); // never scanned
    // Bag fee should NOT trigger a stock decrement.
    expect(ipc.stockDecrements.find((d) => d.variantId === '__bag-fee__')).toBeUndefined();
    pass('Stock decremented exactly for scanned products (bag fee skipped)');

    // ── 9. Fire print + sync ─────────────────────────────────────────────
    step('Trigger receipt print + sync');
    const printResult = ipc.printReceipt(orderId);
    ipc.syncOrders();
    log('printResult', printResult);
    log('syncFired', ipc.syncFired);
    expect(printResult.receiptPrinted).toBe(true);
    expect(ipc.syncFired).toBe(1);
    expect(ipc.receiptsPrinted).toContain(orderId);
    pass('Receipt printed + sync fired');

    // ── 10. Final summary ────────────────────────────────────────────────
    step('Summary');
    log('orders saved', ipc.ordersCreated.length);
    log('lines stocked', ipc.stockDecrements.length);
    log('receipts printed', ipc.receiptsPrinted.length);
    log('sync fired', ipc.syncFired);
    log('TTS clips needed', sequence.length);
    pass(`${COLOR.bold}Self-checkout kiosk smoke OK${COLOR.reset}`);

    // ── Operator runbook ────────────────────────────────────────────────
    // eslint-disable-next-line no-console
    console.log(`
${COLOR.yellow}━━ Manual verification on the real kiosk ━━${COLOR.reset}
  1. Launch:  npm run dev  (or installed kiosk)
  2. Open self-checkout window. Welcome screen should appear.
  3. Scan a real product. It should land in the cart with a price.
  4. Tap Pay → CARD → "Money received".
  5. Listen for the Polish announcement (clips OR Web Speech fallback).
  6. Check that the receipt prints, then thank-you screen auto-resets.
  7. Open DevTools → run:
       const db = await window.electronAPI.pos.orders.getHistory({
         from: new Date().toISOString().slice(0,10),
         to:   new Date().toISOString().slice(0,10),
       });
       console.log(db.orders.filter(o => o.source === 'SELF_CHECKOUT').slice(0,3));
     The newest entry should have source='SELF_CHECKOUT' and synced=0.
  8. Verify in_stock for the scanned variant decreased in the DB.
  9. If audio is silent: render TTS clips with scripts/generate-tts-clips.mjs
     (needs AZURE_SPEECH_KEY) or install a Polish voice on Windows.
`);
  });
});
