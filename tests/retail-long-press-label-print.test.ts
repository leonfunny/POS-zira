import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

function readSource(relativePath: string): string {
  return readFileSync(join(__dirname, relativePath), 'utf8').replace(/\r\n/g, '\n');
}

const retailTemplate = readSource('../src/renderer/components/pos/templates/retail/RetailTemplate.tsx');
const cart = readSource('../src/renderer/components/pos/Cart.tsx');
const cartItem = readSource('../src/renderer/components/pos/CartItem.tsx');
const hardwareModule = readSource('../src/main/modules/hardware.module.ts');
const preloadPos = readSource('../src/preload/preload-pos.ts');
const posLayout = readSource('../src/renderer/components/pos/POSLayout.tsx');
const searchBar = readSource('../src/renderer/components/pos/SearchBar.tsx');

describe('retail POS long-press label printing', () => {
  it('exposes label printing in the POS window preload', () => {
    expect(preloadPos).toContain('printLabel: (barcode: string, text?: string, options?:');
    expect(preloadPos).toContain('quantity?: number; copies?: number');
    expect(preloadPos).toContain("ipcRenderer.invoke('print-label', barcode, text, options)");
  });

  it('prints the product barcode, name, price, and sku through the Zebra label path', () => {
    expect(retailTemplate).toContain('const handlePrintProductCode = useCallback(async (product: Product, options: { quantity?: number } = {}) => {');
    expect(retailTemplate).toContain('const barcode = product.barcode?.trim();');
    expect(retailTemplate).toContain("const priceText = formatProductLabelPriceText(product, tOr('pos.currency', 'zl'));");
    expect(retailTemplate).toContain('window.electronAPI.printLabel(barcode, displayName, {');
    expect(retailTemplate).toContain('priceText,');
    expect(retailTemplate).toContain('sku: product.sku?.trim() || undefined');
    expect(retailTemplate).toContain('quantity: options.quantity');
    expect(retailTemplate).toContain('onLongPressProduct={canUseLabelPrint ? handlePrintProductCode : undefined}');
  });

  it('reuses the same label print path from the cart print button', () => {
    expect(cartItem).toContain('onPrintLabel?: (item: CartItemType)');
    expect(cartItem).toContain('<Printer size={15} strokeWidth={2.4} />');
    expect(cart).toContain('onPrintItemLabel?: (item: CartItem)');
    expect(cart).toContain('onPrintLabel={onPrintItemLabel}');
    expect(retailTemplate).toContain('const handlePrintCartItemCode = useCallback(async (item: CartItem) => {');
    expect(retailTemplate).toContain('window.electronAPI.pos.products.getById(item.variantId)');
    expect(retailTemplate).toContain('return handlePrintProductCode(product, { quantity: labelCopiesForCartItem(item) });');
    expect(retailTemplate).toContain('onPrintItemLabel={canUseLabelPrint ? handlePrintCartItemCode : undefined}');
  });

  it('supports the 00000000 scan command for printing the last scanned cart item quantity', () => {
    expect(retailTemplate).toContain("const PRINT_LAST_CART_LABEL_COMMAND = '00000000';");
    expect(retailTemplate).toContain('const lastLabelVariantIdRef = useRef<string | null>(null);');
    expect(retailTemplate).toContain('lastLabelVariantIdRef.current = product.id;');
    expect(retailTemplate).toContain('if (code === PRINT_LAST_CART_LABEL_COMMAND) {');
    expect(retailTemplate).toContain('await onPrintLastCartLabelCommand();');
    expect(posLayout).toContain("const PRINT_LAST_CART_LABEL_COMMAND = '00000000';");
    expect(posLayout).toContain('if (code === PRINT_LAST_CART_LABEL_COMMAND) {');
    expect(posLayout).toContain('await handlePrintLastCartLabelCommand();');
    expect(posLayout).toContain('const lastLabelVariantIdRef = useRef<string | null>(null);');
    expect(posLayout).toContain('rememberLastLabelVariant(result.item.variantId);');
    expect(posLayout).toContain('onLastLabelVariantChange={rememberLastLabelVariant}');
    expect(posLayout).toContain('onPrintLastCartLabelCommand={canUseLabelPrint ? handlePrintLastCartLabelCommand : undefined}');
    expect(retailTemplate).toContain('commandBarcodes={RETAIL_SCAN_COMMANDS}');
    expect(searchBar).toContain('commandBarcodes?: string[]');
    expect(searchBar).toContain('if (code && commandBarcodeSetRef.current.has(code)) {');
    expect(searchBar).toContain("document.body.dataset.posPaymentOpen === 'true'");
    expect(searchBar).toContain("if (e.key !== 'Enter' && e.key !== 'Tab') return;");
    expect(retailTemplate).toContain('const item = [...cart.items].reverse().find((line) => line.variantId === variantId);');
    expect(retailTemplate).toContain('return Math.max(1, Math.min(999, Math.round(Number(item.quantity) || 1)));');
    expect(hardwareModule).toContain('const requestedQuantity = Number(options?.quantity ?? options?.copies ?? 1);');
    expect(hardwareModule).toContain('quantity,');
  });
});
