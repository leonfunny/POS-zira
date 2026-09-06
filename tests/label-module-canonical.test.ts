import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  filterValidLabelSelectionIds,
  isPrintableLabelProduct,
  toggleLabelSelectionId,
} from '../src/renderer/utils/product-label';

const ROOT = path.resolve(__dirname, '..');
const APP = fs.readFileSync(path.join(ROOT, 'src/renderer/App.tsx'), 'utf8');
const SETTINGS = fs.readFileSync(path.join(ROOT, 'src/renderer/components/Settings.tsx'), 'utf8');
const LABEL_MODULE = fs.readFileSync(path.join(ROOT, 'src/renderer/components/label/LabelModule.tsx'), 'utf8');
const API_CLIENT = fs.readFileSync(path.join(ROOT, 'src/main/network/api-client.ts'), 'utf8');
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
    expect(LABEL_MODULE).toContain('const printableProducts = useMemo(');
    expect(LABEL_MODULE).toContain('.filter(isPrintableLabelProduct)');
    expect(LABEL_MODULE).toContain('const staleSelectionCount = loading || error');
    expect(LABEL_MODULE).toContain('const setupConfigured = pinnedProductIds.size > 0 || configuredCategoryIds.size > 0;');
    expect(LABEL_MODULE).toContain('if (!setupConfigured) return [];');
    expect(LABEL_MODULE).toContain('const categorySelected = !!product.category_id && configuredCategoryIds.has(product.category_id);');
    expect(LABEL_MODULE).toContain('return categorySelected || pinnedProductIds.has(product.id);');
  });

  it('treats drafts and inactive rows as non-printable', () => {
    expect(isPrintableLabelProduct({ is_active: 1 })).toBe(true);
    expect(isPrintableLabelProduct({ is_active: 0 })).toBe(false);
    expect(isPrintableLabelProduct({ is_active: 1, _isDraft: true })).toBe(false);
    expect(LABEL_MODULE).toContain('products.filter(isPrintableLabelProduct)');
  });

  it('locks customer-facing label content to Polish without changing the POS UI language', () => {
    expect(CONFIG_STORE).toContain("labelModuleLanguage: { type: 'string', enum: ['vi', 'pl'] }");
    expect(SHARED_TYPES).toContain("labelModuleLanguage?: 'vi' | 'pl'");
    expect(LABEL_MODULE).toContain('const labelLanguage: LabelLanguage = PRODUCT_LABEL_NAME_LOCALE;');
    // The printed label content stays Polish (the line above). The module's
    // own wording is a separate matter: it is written in vi/pl/en, and a till
    // set to one of the app's other four languages now falls back to English
    // rather than Vietnamese, which it could not read either way.
    expect(LABEL_MODULE).toContain('const copy = COPY[language] || COPY.en;');
    expect(LABEL_MODULE).not.toContain('saveConfig({ labelModuleLanguage: next })');
    expect(LABEL_MODULE).not.toContain('saveConfig({ posLanguage: next })');
  });

  it('repairs stale selections only after an explicit operator action', () => {
    expect(LABEL_MODULE).toContain('const repairLabelSettings = async () => {');
    expect(LABEL_MODULE).toContain('if (loading || error || repairingSettings) return;');
    expect(LABEL_MODULE).toContain('onClick={() => void repairLabelSettings()}');
    expect(LABEL_MODULE).toContain('labelModuleCategoryIds: nextCategoryIds');
    expect(LABEL_MODULE).toContain('labelModuleProductIds: nextProductIds');
    expect(LABEL_MODULE).not.toContain('void repairLabelSettings();');
    expect(LABEL_MODULE).toContain('if (!saved) {');
    expect(LABEL_MODULE).toContain('labelSelectionIdsEqual(current, nextCategoryIds) ? previousCategoryIds : current');
    expect(LABEL_MODULE).toContain('labelSelectionIdsEqual(current, nextProductIds) ? previousProductIds : current');
  });

  it('preserves unrelated stale IDs during normal toggles and removes them only during repair', () => {
    expect(toggleLabelSelectionId(['stale', 'selected'], 'new')).toEqual(['stale', 'selected', 'new']);
    expect(toggleLabelSelectionId(['stale', 'selected'], 'selected')).toEqual(['stale']);
    expect(filterValidLabelSelectionIds(['stale', 'selected', 'selected'], new Set(['selected'])))
      .toEqual(['selected']);
    expect(LABEL_MODULE).toContain('toggleLabelSelectionId(current, categoryId)');
    expect(LABEL_MODULE).toContain('toggleLabelSelectionId(current, productId)');
  });

  it('keeps Label settings toggles optimistic and saves canonical config payloads', () => {
    expect(LABEL_MODULE).toContain('const [optimisticCategoryIds, setOptimisticCategoryIds] = useState<string[]>([]);');
    expect(LABEL_MODULE).toContain('const [optimisticProductIds, setOptimisticProductIds] = useState<string[]>([]);');
    expect(LABEL_MODULE).toContain('const pendingCategoryConfigSavesRef = useRef(0);');
    expect(LABEL_MODULE).toContain('const pendingProductConfigSavesRef = useRef(0);');
    expect(LABEL_MODULE).toContain('if (pendingCategoryConfigSavesRef.current > 0) return;');
    expect(LABEL_MODULE).toContain('if (pendingProductConfigSavesRef.current > 0) return;');
    expect(LABEL_MODULE).toContain('setOptimisticCategoryIds(normalizeLabelSelectionIds(config?.labelModuleCategoryIds || []));');
    expect(LABEL_MODULE).toContain('setOptimisticProductIds(normalizeLabelSelectionIds(config?.labelModuleProductIds || []));');
    expect(LABEL_MODULE).toContain('setOptimisticCategoryIds((current) => {');
    expect(LABEL_MODULE).toContain('setOptimisticProductIds((current) => {');
    expect(LABEL_MODULE).toContain('void persistLabelConfig({ labelModuleCategoryIds: next });');
    expect(LABEL_MODULE).toContain('void persistLabelConfig({ labelModuleProductIds: next });');
    expect(LABEL_MODULE).toContain('const configSaveChainRef = useRef<Promise<void>>(Promise.resolve());');
    expect(LABEL_MODULE).toContain('configSaveChainRef.current.then(saveNext, saveNext)');
    expect(LABEL_MODULE).toContain('pendingCategoryConfigSavesRef.current = Math.max(0, pendingCategoryConfigSavesRef.current - 1);');
    expect(LABEL_MODULE).toContain('pendingProductConfigSavesRef.current = Math.max(0, pendingProductConfigSavesRef.current - 1);');
  });

  it('groups a style\'s variants into one card instead of listing every cell', () => {
    expect(LABEL_MODULE).toContain('const key = product.template_id || product.id;');
    expect(LABEL_MODULE).toContain('data-testid="style-card"');
    expect(LABEL_MODULE).toContain('onClick={() => selectGroup(group)}');
    // The template row is hidden from every list read, so its name has to be
    // fetched by id. Cutting a variant name apart would break on a style whose
    // own name holds a dash, and this shop sells "KOMPLET DRESOWY".
    expect(LABEL_MODULE).toContain('bridge.getByIds(missing)');
    expect(LABEL_MODULE).toContain('const template = templateRows[group.key];');
  });

  it('opens a catalogue style as the order sheet itself, not a second panel', () => {
    // One sheet for both tabs: a second renderer for "the same" label is how
    // two lanes drift apart, and the shop could not tell the two screens apart.
    expect(fs.existsSync(path.join(ROOT, 'src/renderer/components/label/StyleReprintPanel.tsx'))).toBe(false);
    expect(LABEL_MODULE).not.toContain('StyleReprintPanel');
    expect(LABEL_MODULE).toContain('catalogue={{ templateId: styleSheet.key');
    expect(LABEL_MODULE).not.toContain('window.electronAPI.printLabel');
  });

  it('lets the renderer see that the server can rename a style', () => {
    // Capabilities pass through an explicit map in the API client; a field
    // left out of it is silently false, and the rename button then blames
    // the server for what the till dropped.
    expect(API_CLIENT).toContain('supportsStyleRename: raw?.supportsStyleRename === true');
  });

  it('keeps the pinned-product settings search above the shared touch keyboard', () => {
    expect(LABEL_MODULE).toContain('const pinSearchSectionRef = useRef<HTMLElement | null>(null);');
    expect(LABEL_MODULE).toContain("paddingBottom: 'calc(var(--touch-keyboard-inset, 0px) + 0.75rem)'");
    expect(LABEL_MODULE).toContain("pinSearchSectionRef.current?.scrollIntoView({ block: 'start', behavior: 'smooth' });");
    expect(LABEL_MODULE).toContain('ref={pinSearchSectionRef}');
    expect(LABEL_MODULE).toContain('onFocus={scrollPinSearchIntoView}');
    expect(LABEL_MODULE).toContain('onPointerDown={scrollPinSearchIntoView}');
  });

  it('blocks background label shortcuts while settings is open', () => {
    const shortcutHandler = LABEL_MODULE.slice(
      LABEL_MODULE.indexOf('const onKeyDown = (event: KeyboardEvent) => {'),
      LABEL_MODULE.indexOf("if (event.key === '/' ||", LABEL_MODULE.indexOf('const onKeyDown = (event: KeyboardEvent) => {')),
    );

    expect(shortcutHandler).toContain('if (settingsOpen) {');
    expect(shortcutHandler).toContain("if (event.key === 'Escape') {");
    expect(shortcutHandler).toContain('setSettingsOpen(false);');
    expect(shortcutHandler).toContain('return;');
  });
});
