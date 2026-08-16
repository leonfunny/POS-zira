import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

function readSource(relativePath: string): string {
  return readFileSync(join(__dirname, relativePath), 'utf8').replace(/\r\n/g, '\n');
}

const quickActions = readSource('../src/renderer/components/pos/templates/retail/QuickActions.tsx');
const retailTemplate = readSource('../src/renderer/components/pos/templates/retail/RetailTemplate.tsx');
const posLayout = readSource('../src/renderer/components/pos/POSLayout.tsx');
const addProductPanel = readSource('../src/renderer/components/pos/AddProductWebviewPanel.tsx');
const searchBar = readSource('../src/renderer/components/pos/SearchBar.tsx');
const addBridgePreload = readSource('../src/preload/addbridge-preload.ts');
const posPreload = readSource('../src/preload/preload-pos.ts');
const posModule = readSource('../src/main/modules/pos.module.ts');

describe('add product webview panel', () => {
  it('keeps the create-product quick action UNWIRED while /add returns 404', () => {
    // The embedded https://chesaigon.eshoper.pro/add page is chesaigon-only
    // and currently 404s, so POSLayout intentionally does not pass
    // onCreateProduct — QuickActions then hides the button entirely
    // (2026-08-16). The plumbing stays in place for when /add comes back.
    expect(quickActions).toContain("label={tOr('pos.quickAdd.createProduct', 'Tạo sản phẩm')}");
    expect(quickActions).toContain('onClick={onCreateProduct}');
    expect(quickActions).toContain('{onCreateProduct && (');
    expect(retailTemplate).toContain('onCreateProduct={onCreateProduct ? () => {');
    expect(retailTemplate).toContain('interruptAutoCamera();');
    expect(posLayout).toContain('const [showAddProduct, setShowAddProduct] = useState(false)');
    expect(posLayout).not.toContain('onCreateProduct={() => setShowAddProduct(true)}');
    expect(posLayout).toContain('<AddProductWebviewPanel');
  });

  it('resolves the embedded add-page preload through the POS preload API', () => {
    expect(addProductPanel).toContain('api?.pos?.getAddbridgePreloadPath || api?.getAddbridgePreloadPath');
    expect(addProductPanel).toContain('getAddBridgePreloadPath()');
    expect(addProductPanel).not.toContain('electronAPI\n      ?.getAddbridgePreloadPath?.()');
    expect(posPreload).toContain("getAddbridgePreloadPath: (): Promise<string> => ipcRenderer.invoke('app:addbridge-preload-path')");
    expect(posModule).toContain("ipcMain.handle('app:addbridge-preload-path'");
    expect(posModule).toContain("path.join(__dirname, '../../preload/addbridge-preload.js')");
  });

  it('does not treat normal webview navigation churn as a hard panel failure', () => {
    expect(addProductPanel).toContain('event?.isMainFrame === false || event?.errorCode === -3');
    expect(addProductPanel).toContain("wv.addEventListener('dom-ready', onReady)");
    expect(addProductPanel).toContain("wv.removeEventListener('dom-ready', onReady)");
  });

  it('keeps an external-browser fallback available in the POS window', () => {
    expect(addProductPanel).toContain('api?.shell?.openExternal || api?.openExternal');
    expect(addProductPanel).toContain('onClick={() => openExternalUrl(src)}');
    expect(posPreload).toContain("openExternal: (url: string) => ipcRenderer.invoke('shell:openExternal', url)");
  });

  it('routes scanner EAN input into the add-product webview instead of POS search', () => {
    expect(addProductPanel).toContain("const PRODUCT_INTENT_MESSAGE = 'enail:add-product-intent'");
    expect(addProductPanel).toContain("document.body.dataset.posAddProductOpen = 'true'");
    expect(addProductPanel).toContain('window as any).electronAPI?.onBarcodeScanned');
    expect(addProductPanel).toContain('await onExistingProductScanned?.(ean)');
    expect(addProductPanel).toContain('wv.send(PRODUCT_INTENT_MESSAGE');
    expect(addProductPanel).toContain('autoGenerateEan: options?.autoGenerateEan === true');
    expect(addProductPanel).toContain('Giá / szt');
    expect(addProductPanel).toContain('Giá / kg');
    expect(searchBar).toContain("if (document.body.dataset.posAddProductOpen === 'true') return;");
  });

  it('adds an already-known EAN to cart instead of creating a duplicate product', () => {
    expect(addProductPanel).toContain('onExistingProductScanned?: (ean: string) => Promise<boolean> | boolean');
    expect(posLayout).toContain('const handleAddProductPanelBarcode = useCallback(async (ean: string): Promise<boolean> => {');
    expect(posLayout).toContain('window.electronAPI.pos.products.getByBarcode(code)');
    expect(posLayout).toContain('if (!product) return false;');
    expect(posLayout).toContain('const result = await resolveRetailCartItem(product, {');
    expect(posLayout).toContain("dispatch({ type: 'cart/addItem', payload: result.item })");
    expect(posLayout).toContain('setShowAddProduct(false)');
    expect(posLayout).toContain('onExistingProductScanned={handleAddProductPanelBarcode}');
  });

  it('deduplicates created-product events before auto-adding to cart', () => {
    expect(addProductPanel).toContain('lastCreatedRef');
    expect(addProductPanel).toContain('now - lastCreatedRef.current.at < 3000');
    expect(addProductPanel).toContain('onProductCreated(buildCartLineFromCreated(payload))');
  });

  it('bridges web quick-add saves back to POS even when the page does not postMessage', () => {
    expect(addBridgePreload).toContain('const QUICK_ADD_CREATE_PATH = "/warehouse/quick-add/create"');
    expect(addBridgePreload).toContain('window.fetch = async');
    expect(addBridgePreload).toContain('patchCreateBody');
    expect(addBridgePreload).toContain('normalizeCreatedProduct');
    expect(addBridgePreload).toContain('ipcRenderer.sendToHost(CREATED_PRODUCT_MESSAGE, payload)');
  });

  it('applies POS EAN and szt/kg intent to the embedded create-product request', () => {
    expect(addBridgePreload).toContain('document.getElementById("ean")');
    expect(addBridgePreload).toContain('input[name="sellBy"][value="${sellBy}"]');
    expect(addBridgePreload).toContain('const sellBy = normalizeSellBy(body.sellBy ?? currentIntent.sellBy)');
    expect(addBridgePreload).toContain('if (ean && !String(next.ean ?? "").trim()) next.ean = ean');
    expect(addBridgePreload).toContain('const next: Record<string, any> = { ...body, sellBy }');
    expect(addBridgePreload).toContain('next.pricePerKg = next.retailPrice');
    expect(addBridgePreload).toContain('next.stockKg = next.quantity');
  });

  it('auto-generates an internal EAN before saving when no EAN was scanned', () => {
    expect(addBridgePreload).toContain('const INTERNAL_EAN_PATH = "/api/v1/master-catalog/gen-internal-ean"');
    expect(addProductPanel).toContain("const PRODUCT_INTENT_UPDATED_MESSAGE = 'enail:add-product-intent-updated'");
    expect(addProductPanel).toContain('sendIntentToWebview(scannedEan, sellBy, { autoGenerateEan: true })');
    expect(addProductPanel).toContain('Tự tạo EAN');
    expect(addBridgePreload).toContain('const PRODUCT_INTENT_UPDATED_MESSAGE = "enail:add-product-intent-updated"');
    expect(addBridgePreload).toContain('async function generateInternalEan');
    expect(addBridgePreload).toContain('function readDomProductDraft');
    expect(addBridgePreload).toContain('async function generateAndApplyInternalEan');
    expect(addBridgePreload).toContain('supplierSku: firstText(body.sku, body.suggestedSku) || undefined');
    expect(addBridgePreload).toContain('name: firstText(body.name, body.productName) || undefined');
    expect(addBridgePreload).toContain('autoGenerateEan?: boolean');
    expect(addBridgePreload).toContain('payload?.autoGenerateEan');
    expect(addBridgePreload).toContain('if (!String(next.ean ?? "").trim()) {');
    expect(addBridgePreload).toContain('next.ean = generatedEan');
    expect(addBridgePreload).toContain('currentIntent = { ...currentIntent, ean: generatedEan }');
    expect(addBridgePreload).toContain('ipcRenderer.sendToHost(PRODUCT_INTENT_UPDATED_MESSAGE, { ean: generatedEan })');
  });
});
