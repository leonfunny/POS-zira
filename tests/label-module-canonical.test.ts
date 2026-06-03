import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '..');
const APP = fs.readFileSync(path.join(ROOT, 'src/renderer/App.tsx'), 'utf8');
const SETTINGS = fs.readFileSync(path.join(ROOT, 'src/renderer/components/Settings.tsx'), 'utf8');
const LABEL_MODULE = fs.readFileSync(path.join(ROOT, 'src/renderer/components/label/LabelModule.tsx'), 'utf8');
const CONFIG_STORE = fs.readFileSync(path.join(ROOT, 'src/main/config/store.ts'), 'utf8');
const SHARED_TYPES = fs.readFileSync(path.join(ROOT, 'src/shared/types.ts'), 'utf8');

describe('canonical Label tab workflow', () => {
  it('retires the duplicate Label Station kiosk path', () => {
    expect(fs.existsSync(path.join(ROOT, 'src/renderer/components/LabelStationTab.tsx'))).toBe(false);
    expect(APP).not.toContain('LabelStationTab');
    expect(APP).not.toContain('labelStationActive');
    expect(APP).not.toContain('labelStationEnabled');
    expect(APP).not.toContain('setKiosk(labelStation');
    expect(CONFIG_STORE).not.toContain('labelStationEnabled');
    expect(CONFIG_STORE).not.toContain('labelStationCategoryIds');
    expect(CONFIG_STORE).not.toContain('labelStationCopies');
    expect(CONFIG_STORE).not.toContain('labelStationExitPin');
    expect(SHARED_TYPES).not.toContain('labelStationEnabled');
  });

  it('keeps Settings free of Label Station controls', () => {
    expect(SETTINGS).not.toContain('Label Station');
    expect(SETTINGS).not.toContain('POS3 Label Station');
    expect(SETTINGS).not.toContain('labelStation');
    expect(SETTINGS).not.toContain('Allowed categories');
    expect(SETTINGS).not.toContain('Exit PIN');
  });

  it('uses category and explicit product selections for Label tab visibility', () => {
    expect(CONFIG_STORE).toContain('labelModuleCategoryIds: { type: \'array\', items: { type: \'string\' }, default: [] }');
    expect(SHARED_TYPES).toContain('labelModuleCategoryIds?: string[]');
    expect(LABEL_MODULE).toContain('config?.labelModuleCategoryIds');
    expect(LABEL_MODULE).toContain('config?.labelModuleProductIds');
    expect(LABEL_MODULE).toContain('if (!setupConfigured) return [];');
    expect(LABEL_MODULE).toContain('const categorySelected = !!product.category_id && configuredCategoryIds.has(product.category_id);');
    expect(LABEL_MODULE).toContain('return categorySelected || pinnedProductIds.has(product.id);');
  });

  it('keeps Label settings toggles optimistic and saves canonical config payloads', () => {
    expect(LABEL_MODULE).toContain('const [optimisticCategoryIds, setOptimisticCategoryIds] = useState<string[]>([]);');
    expect(LABEL_MODULE).toContain('const [optimisticProductIds, setOptimisticProductIds] = useState<string[]>([]);');
    expect(LABEL_MODULE).toContain('const pendingCategoryConfigSavesRef = useRef(0);');
    expect(LABEL_MODULE).toContain('const pendingProductConfigSavesRef = useRef(0);');
    expect(LABEL_MODULE).toContain('if (pendingCategoryConfigSavesRef.current > 0) return;');
    expect(LABEL_MODULE).toContain('if (pendingProductConfigSavesRef.current > 0) return;');
    expect(LABEL_MODULE).toContain('setOptimisticCategoryIds(uniqueIds((config?.labelModuleCategoryIds || []) as string[]));');
    expect(LABEL_MODULE).toContain('setOptimisticProductIds(uniqueIds((config?.labelModuleProductIds || []) as string[]));');
    expect(LABEL_MODULE).toContain('setOptimisticCategoryIds((current) => {');
    expect(LABEL_MODULE).toContain('setOptimisticProductIds((current) => {');
    expect(LABEL_MODULE).toContain('void persistLabelConfig({ labelModuleCategoryIds: uniqueNext });');
    expect(LABEL_MODULE).toContain('void persistLabelConfig({ labelModuleProductIds: uniqueNext });');
    expect(LABEL_MODULE).toContain('const configSaveChainRef = useRef<Promise<void>>(Promise.resolve());');
    expect(LABEL_MODULE).toContain('configSaveChainRef.current.then(saveNext, saveNext)');
    expect(LABEL_MODULE).toContain('pendingCategoryConfigSavesRef.current = Math.max(0, pendingCategoryConfigSavesRef.current - 1);');
    expect(LABEL_MODULE).toContain('pendingProductConfigSavesRef.current = Math.max(0, pendingProductConfigSavesRef.current - 1);');
  });

  it('does not fall back to SKU or product id as the printable barcode', () => {
    const resolver = LABEL_MODULE.slice(
      LABEL_MODULE.indexOf('function resolveLabelCode'),
      LABEL_MODULE.indexOf('function productImage'),
    );
    expect(resolver).toContain('product.barcode ?? product.ean ??');
    expect(resolver).not.toContain('product.sku');
    expect(resolver).not.toContain('product.id');
    expect(LABEL_MODULE).toContain('copy.missingEan');
    expect(LABEL_MODULE).toContain('disabled={!canPrint}');
  });

  it('selects cards for preview and passes quantity to the existing print API', () => {
    expect(LABEL_MODULE).toContain('onClick={() => selectProduct(product)}');
    expect(LABEL_MODULE).not.toContain('onClick={() => void printProductLabel(product)}');

    const printCall = LABEL_MODULE.slice(
      LABEL_MODULE.indexOf('window.electronAPI.printLabel'),
      LABEL_MODULE.indexOf('});', LABEL_MODULE.indexOf('window.electronAPI.printLabel')),
    );
    expect(printCall).toContain('barcode, displayName');
    expect(printCall).toContain('priceText');
    expect(printCall).toContain('sku: product.sku?.trim() || undefined');
    expect(printCall).toContain('quantity');
  });

  it('guards success reset timeouts so stale timers cannot clear newer print state', () => {
    expect(LABEL_MODULE).toContain('const statusResetTimeoutRef = useRef<number | null>(null);');
    expect(LABEL_MODULE).toContain('const printSequenceRef = useRef(0);');
    expect(LABEL_MODULE).toContain('window.clearTimeout(statusResetTimeoutRef.current);');
    expect(LABEL_MODULE).toContain('return () => clearStatusResetTimeout();');
    expect(LABEL_MODULE).toContain('const printToken = ++printSequenceRef.current;');
    expect(LABEL_MODULE).toContain('statusResetTimeoutRef.current = window.setTimeout(() => {');
    expect(LABEL_MODULE).toContain('if (printSequenceRef.current === printToken) {');
    expect(LABEL_MODULE).toContain('statusResetTimeoutRef.current = null;');
  });
});
