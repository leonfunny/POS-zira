import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  Barcode,
  Check,
  CheckCircle2,
  FileImage,
  Plus,
  Printer,
  RefreshCw,
  Search,
  Settings,
  Table2,
  Tag,
  Tags,
  X,
} from 'lucide-react';
import { PRODUCT_LABEL_NAME_LOCALE, resolveName } from '../../../shared/catalog-names';
import { rowBelongsToStyle, sameStyleCode, styleCodeOfRow } from '../../../shared/order-to-product';
import type { AgentConfig, ProductAdminCapabilities } from '../../../shared/types';
import { useConfig } from '../../hooks/useConfig';
import { useProducts } from '../../hooks/useProducts';
import FabricArtworkPanel from './FabricArtworkPanel';
import PrintOrderPanel from './PrintOrderPanel';
import CategoryManagerDialog from '../products/CategoryManagerDialog';
import StyleReprintPanel from './StyleReprintPanel';
import type { ProductListItem } from '../../hooks/useProducts';
import type { Category } from '../../hooks/usePosDb';
import { getTranslation, type Language } from '../../i18n/translations';
import rlog from '../../utils/logger';
import {
  filterValidLabelSelectionIds,
  isPrintableLabelProduct,
  labelSelectionIdsEqual,
  normalizeLabelSelectionIds,
  toggleLabelSelectionId,
  type LabelLanguage,
} from '../../utils/product-label';

interface LabelModuleProps {
  language: Language;
}

type LabelProduct = ProductListItem & { ean?: string | null };

/**
 * One style, with the physical rows under it.
 *
 * The catalogue keeps a colour-and-size style as one row per cell, and every
 * list read hides the template that groups them so the till never sells the
 * stock-0 parent. Printed labels are the other way round: the operator thinks
 * of one style and picks colours inside it, which is what this groups back
 * together. A plain item with no variants is a group of one.
 */
interface StyleGroup {
  key: string;
  name: string;
  styleCode: string;
  categoryId: string | null;
  variants: LabelProduct[];
}

/**
 * The tab's own status line. Printing reports inside the reprint panel, so what
 * is left here is the settings drawer: a category or pin that fails to save is
 * otherwise silent, and the operator would go on believing it was kept.
 */
type LabelStatus = { type: 'idle' | 'error'; message: string };

interface LabelCopy {
  title: string;
  subtitle: string;
  settings: string;
  close: string;
  sync: string;
  manageCategories: string;
  manageCategoriesUnavailable: string;
  syncing: string;
  search: string;
  allCategories: string;
  products: string;
  selected: string;
  setupTitle: string;
  setupHint: string;
  openSettings: string;
  noMatch: string;
  noSelection: string;
  loading: string;
  loadError: string;
  selectProductHint: string;
  category: string;
  missingEan: string;
  categories: string;
  categoryHint: string;
  pinnedProducts: string;
  pinSearch: string;
  pinned: string;
  availableProducts: string;
  clear: string;
  noCategories: string;
  noProductsAvailable: string;
  staleSelections: (quantity: number) => string;
  repair: string;
  variantSummary: (colors: number, sizes: number, rows: number) => string;
}


type LabelMode = 'order' | 'fabric' | 'ean';

const COPY: Record<string, LabelCopy> = {
  en: {
    title: 'Label',
    subtitle: 'Reprint bag labels and fabric tags',
    settings: 'Settings',
    close: 'Close',
    sync: 'Sync',
    manageCategories: 'Categories',
    manageCategoriesUnavailable: 'Categories cannot be managed from this till right now',
    syncing: 'Syncing',
    search: 'Search name, SKU, EAN, category',
    allCategories: 'All label products',
    products: 'products',
    selected: 'Selected',
    setupTitle: 'Choose categories or pinned products',
    setupHint: 'The Label tab stays empty until this counter is configured.',
    openSettings: 'Open settings',
    noMatch: 'No matching label products',
    noSelection: 'No style selected',
    loading: 'Loading products...',
    loadError: 'Could not load products',
    selectProductHint: 'Pick a style to print its colours and sizes.',
    category: 'Category',
    missingEan: 'Missing EAN',
    categories: 'Categories',
    categoryHint: 'Selected categories are visible in the Label tab.',
    pinnedProducts: 'Pinned products',
    pinSearch: 'Search product to pin',
    pinned: 'Pinned',
    availableProducts: 'Available products',
    clear: 'Clear',
    noCategories: 'No local categories found',
    noProductsAvailable: 'No products found',
    staleSelections: (quantity) => `${quantity} saved Label selection(s) no longer exist or cannot be printed.`,
    repair: 'Repair settings',
    variantSummary: (colors, sizes, rows) =>
      colors + sizes === 0
        ? `${rows} row${rows === 1 ? '' : 's'}`
        : `${colors} colour${colors === 1 ? '' : 's'} · ${sizes} size${sizes === 1 ? '' : 's'}`,
  },
  vi: {
    title: 'Label',
    subtitle: 'In lại tem đóng gói và tem vải',
    settings: 'Cài đặt',
    close: 'Đóng',
    sync: 'Đồng bộ',
    manageCategories: 'Nhóm hàng',
    manageCategoriesUnavailable: 'Máy này hiện chưa sửa được nhóm hàng — kiểm tra mạng rồi thử lại',
    syncing: 'Đang đồng bộ',
    search: 'Tìm tên, SKU, EAN, danh mục',
    allCategories: 'Tất cả sản phẩm tem',
    products: 'sản phẩm',
    selected: 'Đang chọn',
    setupTitle: 'Chọn danh mục hoặc ghim sản phẩm',
    setupHint: 'Tab Label để trống cho đến khi quầy này được cấu hình.',
    openSettings: 'Mở cài đặt',
    noMatch: 'Không tìm thấy sản phẩm tem',
    noSelection: 'Chưa chọn mẫu nào',
    loading: 'Đang tải sản phẩm...',
    loadError: 'Không tải được sản phẩm',
    selectProductHint: 'Chọn một mẫu để in màu và size của nó.',
    category: 'Danh mục',
    missingEan: 'Thiếu EAN',
    categories: 'Danh mục',
    categoryHint: 'Danh mục đã chọn sẽ hiện trong tab Label.',
    pinnedProducts: 'Sản phẩm ghim',
    pinSearch: 'Tìm sản phẩm để ghim',
    pinned: 'Đã ghim',
    availableProducts: 'Sản phẩm có thể chọn',
    clear: 'Xóa',
    noCategories: 'Không có danh mục cục bộ',
    noProductsAvailable: 'Không tìm thấy sản phẩm',
    staleSelections: (quantity) => `${quantity} lựa chọn Label đã lưu không còn tồn tại hoặc không thể in.`,
    repair: 'Sửa cấu hình',
    variantSummary: (colors, sizes, rows) =>
      colors + sizes === 0 ? `${rows} dòng` : `${colors} màu · ${sizes} size`,
  },
  pl: {
    title: 'Label',
    subtitle: 'Ponowny druk etykiet i metek',
    settings: 'Ustawienia',
    close: 'Zamknij',
    sync: 'Synchronizuj',
    manageCategories: 'Kategorie',
    manageCategoriesUnavailable: 'Z tej kasy nie da się teraz edytować kategorii — sprawdź sieć i spróbuj ponownie',
    syncing: 'Synchronizacja',
    search: 'Szukaj nazwy, SKU, EAN, kategorii',
    allCategories: 'Wszystkie produkty etykiet',
    products: 'produkty',
    selected: 'Wybrane',
    setupTitle: 'Wybierz kategorie albo przypięte produkty',
    setupHint: 'Zakładka Label jest pusta, dopóki ta lada nie jest skonfigurowana.',
    openSettings: 'Otwórz ustawienia',
    noMatch: 'Brak pasujących produktów',
    noSelection: 'Nie wybrano modelu',
    loading: 'Ładowanie produktów...',
    loadError: 'Nie udało się załadować produktów',
    selectProductHint: 'Wybierz model, aby wydrukować jego kolory i rozmiary.',
    category: 'Kategoria',
    missingEan: 'Brak EAN',
    categories: 'Kategorie',
    categoryHint: 'Wybrane kategorie są widoczne w zakładce Label.',
    pinnedProducts: 'Przypięte produkty',
    pinSearch: 'Szukaj produktu do przypięcia',
    pinned: 'Przypięto',
    availableProducts: 'Dostępne produkty',
    clear: 'Wyczyść',
    noCategories: 'Brak lokalnych kategorii',
    noProductsAvailable: 'Nie znaleziono produktów',
    staleSelections: (quantity) => `${quantity} zapisanych wyborów Label już nie istnieje lub nie nadaje się do druku.`,
    repair: 'Napraw ustawienia',
    variantSummary: (colors, sizes, rows) =>
      colors + sizes === 0 ? `${rows} poz.` : `${colors} kolor. · ${sizes} rozm.`,
  },
};

function normalizeSearch(value: string): string {
  return value
    .replace(/[\u0110\u0111]/g, (ch) => (ch === '\u0110' ? 'D' : 'd'))
    .replace(/[\u0141\u0142]/g, (ch) => (ch === '\u0141' ? 'L' : 'l'))
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();
}

function resolveLabelCode(product: LabelProduct | null): string {
  if (!product) return '';
  return String(product.barcode ?? product.ean ?? '').trim();
}

function productImage(product: LabelProduct): string | null {
  return (product.thumbnail_url || product.image_url || null) as string | null;
}

function productMatches(
  product: LabelProduct,
  query: string,
  categoryById: Map<string, Category>,
  labelLanguage: LabelLanguage,
): boolean {
  if (!query) return true;
  const category = product.category_id ? categoryById.get(product.category_id) : null;
  const haystack = [
    product.name,
    resolveName(product, labelLanguage),
    product.sku,
    product.barcode,
    product.ean,
    category?.name,
    category ? resolveName(category, labelLanguage) : '',
  ].filter(Boolean).join(' ');
  return normalizeSearch(haystack).includes(query);
}

export default function LabelModule({ language }: LabelModuleProps) {
  const { config, saveConfig } = useConfig();
  const labelLanguage: LabelLanguage = PRODUCT_LABEL_NAME_LOCALE;
  const copy = COPY[language] || COPY.vi;
  const t = getTranslation(language);
  const tOr = (key: string, fallback: string) => {
    const value = t(key);
    return value && value !== key ? value : fallback;
  };
  const { allProducts, categories, loading, error, refresh, syncProducts, syncing } = useProducts(labelLanguage);
  const products = allProducts as LabelProduct[];
  // The order sheet is what staff reach for daily; the other two lanes are for
  // customer artwork files and for catalog EAN labels.
  const [labelMode, setLabelMode] = useState<LabelMode>('order');
  const [fabricArtworkPrinting, setFabricArtworkPrinting] = useState(false);
  const fabricArtworkPrintingRef = useRef(false);
  const handleFabricArtworkPrintingChange = useCallback((printing: boolean) => {
    fabricArtworkPrintingRef.current = printing;
    setFabricArtworkPrinting(printing);
  }, []);
  // A print run keeps the operator on its own tab: switching away would unmount
  // the loop that is waiting for Continue between fabric batches.
  const [orderPrinting, setOrderPrinting] = useState(false);
  const orderPrintingRef = useRef(false);
  const handleOrderPrintingChange = useCallback((printing: boolean) => {
    orderPrintingRef.current = printing;
    setOrderPrinting(printing);
  }, []);
  const [query, setQuery] = useState('');
  const [settingsQuery, setSettingsQuery] = useState('');
  const [activeCategoryId, setActiveCategoryId] = useState('');
  const [settingsOpen, setSettingsOpen] = useState(false);
  // The same category manager the product tab has, opened from here so the
  // workshop never has to leave the label tab to add, rename or delete a
  // group. Its rights are read when the button is pressed, not on mount: the
  // tab must open offline, and the manager is useless offline anyway.
  const [categoryManager, setCategoryManager] = useState<ProductAdminCapabilities | null>(null);
  const [categoryManagerOpening, setCategoryManagerOpening] = useState(false);
  const [categoryManagerError, setCategoryManagerError] = useState<string | null>(null);
  const openCategoryManager = async () => {
    if (categoryManagerOpening) return;
    setCategoryManagerOpening(true);
    setCategoryManagerError(null);
    try {
      const response = await window.electronAPI.pos.productAdmin.getCapabilities();
      const capabilities = response?.ok ? response.capabilities : null;
      const usable = capabilities?.canCreateCategory === true
        || capabilities?.canUpdateCategory === true
        || capabilities?.canDeleteCategory === true;
      if (!capabilities || !usable) {
        setCategoryManagerError(copy.manageCategoriesUnavailable);
        return;
      }
      setCategoryManager(capabilities);
    } catch {
      setCategoryManagerError(copy.manageCategoriesUnavailable);
    } finally {
      setCategoryManagerOpening(false);
    }
  };
  const localProductCountsByCategory = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const product of allProducts) {
      if (!product.category_id) continue;
      counts[product.category_id] = (counts[product.category_id] || 0) + 1;
    }
    return counts;
  }, [allProducts]);
  const [selectedGroupKey, setSelectedGroupKey] = useState('');
  const [status, setStatus] = useState<LabelStatus>({ type: 'idle', message: '' });
  const [imageErrors, setImageErrors] = useState<Record<string, boolean>>({});
  const [optimisticCategoryIds, setOptimisticCategoryIds] = useState<string[]>([]);
  const [optimisticProductIds, setOptimisticProductIds] = useState<string[]>([]);
  const [repairingSettings, setRepairingSettings] = useState(false);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const pinSearchSectionRef = useRef<HTMLElement | null>(null);
  const configSaveChainRef = useRef<Promise<void>>(Promise.resolve());
  const pendingCategoryConfigSavesRef = useRef(0);
  const pendingProductConfigSavesRef = useRef(0);

  useEffect(() => {
    if (pendingCategoryConfigSavesRef.current > 0) return;
    setOptimisticCategoryIds(normalizeLabelSelectionIds(config?.labelModuleCategoryIds || []));
  }, [config?.labelModuleCategoryIds]);

  useEffect(() => {
    if (pendingProductConfigSavesRef.current > 0) return;
    setOptimisticProductIds(normalizeLabelSelectionIds(config?.labelModuleProductIds || []));
  }, [config?.labelModuleProductIds]);

  const categoryById = useMemo(() => new Map(categories.map((category) => [category.id, category])), [categories]);
  const printableProducts = useMemo(
    () => products.filter(isPrintableLabelProduct),
    [products],
  );
  const printableProductIds = useMemo(
    () => new Set(printableProducts.map((product) => product.id)),
    [printableProducts],
  );
  const staleCategoryIds = useMemo(
    () => optimisticCategoryIds.filter((id) => !categoryById.has(id)),
    [categoryById, optimisticCategoryIds],
  );
  const staleProductIds = useMemo(
    () => optimisticProductIds.filter((id) => !printableProductIds.has(id)),
    [optimisticProductIds, printableProductIds],
  );
  const configuredCategoryIds = useMemo(
    () => new Set(optimisticCategoryIds.filter((id) => categoryById.has(id))),
    [categoryById, optimisticCategoryIds],
  );
  const pinnedProductIds = useMemo(
    () => new Set(optimisticProductIds.filter((id) => printableProductIds.has(id))),
    [optimisticProductIds, printableProductIds],
  );
  const staleSelectionCount = loading || error
    ? 0
    : staleCategoryIds.length + staleProductIds.length;
  const setupConfigured = pinnedProductIds.size > 0 || configuredCategoryIds.size > 0;

  const labelProducts = useMemo(() => {
    if (!setupConfigured) return [];
    return printableProducts.filter((product) => {
      const categorySelected = !!product.category_id && configuredCategoryIds.has(product.category_id);
      return categorySelected || pinnedProductIds.has(product.id);
    });
  }, [configuredCategoryIds, pinnedProductIds, printableProducts, setupConfigured]);

  const filterCategories = useMemo(() => {
    const representedCategoryIds = new Set(
      labelProducts
        .map((product) => product.category_id)
        .filter((categoryId): categoryId is string => !!categoryId),
    );
    return categories.filter((category) => configuredCategoryIds.has(category.id) || representedCategoryIds.has(category.id));
  }, [categories, configuredCategoryIds, labelProducts]);

  useEffect(() => {
    if (activeCategoryId && !filterCategories.some((category) => category.id === activeCategoryId)) {
      setActiveCategoryId('');
    }
  }, [activeCategoryId, filterCategories]);

  /**
   * The template rows behind the styles on screen.
   *
   * Read by id on purpose: every list query hides a template that has variants,
   * and the template is where the style's own name and lot code live. Guessing
   * the name by cutting a variant name apart breaks on any style whose name
   * holds a dash, and this shop names styles "KOMPLET DRESOWY".
   */
  const [templateRows, setTemplateRows] = useState<Record<string, LabelProduct>>({});
  /**
   * Ids already asked for, whether or not a row came back.
   *
   * Keyed off the answer instead, a style whose template row is missing would
   * be requested again on every render — the read returns nothing, the state
   * object is replaced, the effect sees the id still missing, and the machine
   * spends the day asking. Asking once per id ends that.
   */
  const templateIdsAskedRef = useRef<Set<string>>(new Set());
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);
  const templateIdsWanted = useMemo(() => {
    const ids = new Set<string>();
    for (const product of labelProducts) {
      if (product.template_id) ids.add(product.template_id);
    }
    return [...ids].sort();
  }, [labelProducts]);

  useEffect(() => {
    const missing = templateIdsWanted.filter((id) => !templateIdsAskedRef.current.has(id));
    if (missing.length === 0) return;
    const bridge = (window as any).electronAPI?.pos?.products;
    if (!bridge?.getByIds) return;
    for (const id of missing) templateIdsAskedRef.current.add(id);
    // Deliberately not cancelled when the effect re-runs. An id is asked for
    // once, so dropping the answer because the product list changed shape mid
    // flight would leave that style unnamed for as long as the app is open.
    // Only an unmounted component ignores it.
    Promise.resolve()
      .then(() => bridge.getByIds(missing))
      .then((rows: LabelProduct[]) => {
        if (!mountedRef.current || !Array.isArray(rows) || rows.length === 0) return;
        setTemplateRows((current) => {
          const next = { ...current };
          for (const row of rows) {
            if (row?.id) next[row.id] = row;
          }
          return next;
        });
      })
      .catch((err: unknown) => {
        rlog.error('[LabelModule] Failed to read style rows:', err);
        // Left marked as asked: a read that fails for one style fails for the
        // next too, and retrying on every render turns a broken bridge into a
        // busy loop. The style still shows, under its variant's name.
      });
  }, [templateIdsWanted]);

  const styleGroups = useMemo(() => {
    const groups = new Map<string, StyleGroup>();
    for (const product of labelProducts) {
      const key = product.template_id || product.id;
      let group = groups.get(key);
      if (!group) {
        group = {
          key,
          name: '',
          styleCode: '',
          categoryId: product.category_id ?? null,
          variants: [],
        };
        groups.set(key, group);
      }
      group.variants.push(product);
      // A style is shown under whichever category its rows carry; the first one
      // that has one wins, so a variant saved without a category does not hide
      // the style from its own category chip.
      if (!group.categoryId && product.category_id) group.categoryId = product.category_id;
    }
    for (const group of groups.values()) {
      // An import can leave a colourless, sizeless row beside the real ones —
      // the style's own parent, carried in as if it were sellable. It would
      // print a tag naming no garment, so drop it wherever the style has rows
      // that do name one. A style where nothing carries colour or size keeps
      // every row: that is an ordinary product, not a leftover.
      const described = group.variants.filter(
        (variant) => (variant.color_name || '').trim() || (variant.size_name || '').trim(),
      );
      if (described.length > 0) group.variants = described;
      const template = templateRows[group.key];
      // Falling back to the shortest variant name rather than the first: the
      // rows read "KOMPLET DRESOWY - CZARNY / S", so the shortest is the one
      // closest to the style itself while the template row is still loading.
      const fallback = group.variants
        .map((variant) => variant.name)
        .reduce((shortest, name) => (name.length < shortest.length ? name : shortest), group.variants[0].name);
      // Polish first, like every other customer-facing name in the app: the bag
      // label leaves the workshop, and the style is written the way the buyer
      // reads it rather than the way the till happens to be set.
      group.name = (template ? resolveName(template, labelLanguage) || template.name : '') || fallback;
      // A style filed from the sheet has no template row of its own on this
      // till: its code is what the first row's SKU was built from.
      const first = group.variants[0];
      group.styleCode = String(
        template?.sku || styleCodeOfRow(first.sku, first.color_name, first.size_name) || '',
      ).trim();
      if (!group.categoryId && template?.category_id) group.categoryId = template.category_id;
    }
    return [...groups.values()].sort((a, b) => a.name.localeCompare(b.name, 'pl'));
  }, [labelProducts, templateRows]);

  const visibleGroups = useMemo(() => {
    const normalized = normalizeSearch(query);
    return styleGroups
      .filter((group) => !activeCategoryId || group.categoryId === activeCategoryId)
      .filter(
        (group) =>
          !normalized
          || normalizeSearch(group.name).includes(normalized)
          || group.variants.some((variant) =>
            productMatches(variant, normalized, categoryById, labelLanguage),
          ),
      );
  }, [activeCategoryId, categoryById, labelLanguage, query, styleGroups]);

  useEffect(() => {
    if (styleGroups.length === 0) {
      if (selectedGroupKey) setSelectedGroupKey('');
      return;
    }
    if (!selectedGroupKey || !styleGroups.some((group) => group.key === selectedGroupKey)) {
      setSelectedGroupKey(styleGroups[0].key);
    }
  }, [selectedGroupKey, styleGroups]);

  const selectedGroup = useMemo(
    () => styleGroups.find((group) => group.key === selectedGroupKey) || null,
    [selectedGroupKey, styleGroups],
  );

  const selectedCategory = selectedGroup?.categoryId
    ? categoryById.get(selectedGroup.categoryId)
    : null;

  const selectableProducts = useMemo(() => {
    const normalized = normalizeSearch(settingsQuery);
    return printableProducts
      .filter((product) => productMatches(product, normalized, categoryById, labelLanguage))
      .slice(0, 160);
  }, [categoryById, labelLanguage, printableProducts, settingsQuery]);

  const selectedCategories = useMemo(
    () => categories.filter((category) => configuredCategoryIds.has(category.id)),
    [categories, configuredCategoryIds],
  );

  const pinnedProducts = useMemo(
    () => printableProducts.filter((product) => pinnedProductIds.has(product.id)),
    [pinnedProductIds, printableProducts],
  );

  const persistLabelConfig = useCallback((partial: Partial<AgentConfig>) => {
    const hasCategoryIds = Object.prototype.hasOwnProperty.call(partial, 'labelModuleCategoryIds');
    const hasProductIds = Object.prototype.hasOwnProperty.call(partial, 'labelModuleProductIds');
    if (hasCategoryIds) pendingCategoryConfigSavesRef.current += 1;
    if (hasProductIds) pendingProductConfigSavesRef.current += 1;

    const saveNext = async (): Promise<boolean> => {
      try {
        await saveConfig(partial);
        return true;
      } catch (err: any) {
        rlog.error('[LabelModule] Failed to save label settings:', err);
        setStatus({ type: 'error', message: err?.message || 'Failed to save label settings' });
        return false;
      } finally {
        if (hasCategoryIds) pendingCategoryConfigSavesRef.current = Math.max(0, pendingCategoryConfigSavesRef.current - 1);
        if (hasProductIds) pendingProductConfigSavesRef.current = Math.max(0, pendingProductConfigSavesRef.current - 1);
      }
    };

    const nextSave = configSaveChainRef.current.then(saveNext, saveNext);
    configSaveChainRef.current = nextSave.then(() => undefined, () => undefined);
    return nextSave;
  }, [saveConfig]);

  const scrollPinSearchIntoView = useCallback(() => {
    window.requestAnimationFrame(() => {
      pinSearchSectionRef.current?.scrollIntoView({ block: 'start', behavior: 'smooth' });
    });
  }, []);

  const repairLabelSettings = async () => {
    if (loading || error || repairingSettings) return;
    const previousCategoryIds = optimisticCategoryIds;
    const previousProductIds = optimisticProductIds;
    const nextCategoryIds = filterValidLabelSelectionIds(previousCategoryIds, new Set(categoryById.keys()));
    const nextProductIds = filterValidLabelSelectionIds(previousProductIds, printableProductIds);
    setOptimisticCategoryIds(nextCategoryIds);
    setOptimisticProductIds(nextProductIds);
    setRepairingSettings(true);
    try {
      const saved = await persistLabelConfig({
        labelModuleCategoryIds: nextCategoryIds,
        labelModuleProductIds: nextProductIds,
      });
      if (!saved) {
        setOptimisticCategoryIds((current) => (
          labelSelectionIdsEqual(current, nextCategoryIds) ? previousCategoryIds : current
        ));
        setOptimisticProductIds((current) => (
          labelSelectionIdsEqual(current, nextProductIds) ? previousProductIds : current
        ));
      }
    } finally {
      setRepairingSettings(false);
    }
  };

  const toggleCategory = (categoryId: string) => {
    setOptimisticCategoryIds((current) => {
      const next = toggleLabelSelectionId(current, categoryId);
      void persistLabelConfig({ labelModuleCategoryIds: next });
      return next;
    });
  };

  const clearCategories = () => {
    setOptimisticCategoryIds([]);
    void persistLabelConfig({ labelModuleCategoryIds: [] });
  };

  /**
   * A sheet was just filed into this category. Show it here from now on, so a
   * style the workshop invented today is on the tab today — not after someone
   * works out that it is hiding behind the settings gear.
   */
  const ensureCategoryShown = (categoryId: string) => {
    setOptimisticCategoryIds((current) => {
      if (current.includes(categoryId)) return current;
      const next = [...current, categoryId];
      void persistLabelConfig({ labelModuleCategoryIds: next });
      return next;
    });
  };

  const togglePinnedProduct = (productId: string) => {
    setOptimisticProductIds((current) => {
      const next = toggleLabelSelectionId(current, productId);
      void persistLabelConfig({ labelModuleProductIds: next });
      return next;
    });
  };

  const selectGroup = (group: StyleGroup) => {
    setSelectedGroupKey(group.key);
    setStatus({ type: 'idle', message: '' });
  };

  /**
   * A run inside the reprint panel pins the operator to this tab, the same way
   * the order sheet's run does: switching away would unmount the loop that is
   * feeding the printer batch by batch.
   */
  const [reprinting, setReprinting] = useState(false);
  const reprintingRef = useRef(false);
  const handleReprintingChange = useCallback((printing: boolean) => {
    reprintingRef.current = printing;
    setReprinting(printing);
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      // The fabric workflow owns its own explicit print action. Never let a
      // background Enter key leak into the secondary EAN printer.
      if (labelMode !== 'ean') return;
      const target = event.target as HTMLElement | null;
      const tagName = target?.tagName;
      const isTyping = tagName === 'INPUT'
        || tagName === 'TEXTAREA'
        || tagName === 'SELECT'
        || !!target?.isContentEditable;
      const isInteractive = !!target?.closest('button, a, [role="button"], [role="dialog"]');

      if (settingsOpen) {
        if (event.key === 'Escape') {
          event.preventDefault();
          setSettingsOpen(false);
        }
        return;
      }

      if (isTyping || isInteractive) return;

      if (event.key === '/' || (event.ctrlKey && event.key.toLowerCase() === 'f')) {
        event.preventDefault();
        searchInputRef.current?.focus();
        return;
      }

      if (event.key === 'Escape' && query) {
        event.preventDefault();
        setQuery('');
        return;
      }

    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [labelMode, query, settingsOpen]);

  return (
    <>
    <div className="h-[calc(100vh-2rem)] min-h-0 overflow-hidden bg-slate-50 text-slate-900 flex flex-col">
      <nav
        className="mb-3 shrink-0 rounded-lg border border-slate-200 bg-white p-1.5 shadow-sm"
        aria-label={language === 'vi' ? 'Chọn loại mác' : language === 'pl' ? 'Wybierz rodzaj etykiety' : 'Choose label type'}
      >
        <div className="grid max-w-3xl grid-cols-3 gap-2">
          <button
            type="button"
            onClick={() => {
              if (orderPrintingRef.current) return;
              setSettingsOpen(false);
              setLabelMode('order');
            }}
            disabled={fabricArtworkPrinting}
            aria-pressed={labelMode === 'order'}
            className={`min-h-11 rounded-md border px-3 text-sm font-extrabold transition-colors inline-flex items-center justify-center gap-2 ${
              labelMode === 'order'
                ? 'border-emerald-600 bg-emerald-50 text-emerald-800'
                : 'border-transparent bg-white text-slate-600 hover:border-slate-200 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50'
            }`}
          >
            <Table2 size={18} aria-hidden="true" />
            {language === 'vi' ? 'Đơn in' : language === 'pl' ? 'Zlecenie druku' : 'Print order'}
          </button>
          <button
            type="button"
            onClick={() => {
              if (orderPrintingRef.current) return;
              setSettingsOpen(false);
              setLabelMode('fabric');
            }}
            disabled={orderPrinting}
            aria-pressed={labelMode === 'fabric'}
            className={`min-h-11 rounded-md border px-3 text-sm font-extrabold transition-colors inline-flex items-center justify-center gap-2 ${
              labelMode === 'fabric'
                ? 'border-emerald-600 bg-emerald-50 text-emerald-800'
                : 'border-transparent bg-white text-slate-600 hover:border-slate-200 hover:bg-slate-50'
            }`}
          >
            <FileImage size={18} aria-hidden="true" />
            {language === 'vi' ? 'Mác vải từ file khách' : language === 'pl' ? 'Metki z pliku klienta' : 'Fabric labels from customer files'}
          </button>
          <button
            type="button"
            onClick={() => {
              if (!fabricArtworkPrintingRef.current && !orderPrintingRef.current) setLabelMode('ean');
            }}
            disabled={fabricArtworkPrinting || orderPrinting}
            aria-pressed={labelMode === 'ean'}
            className={`min-h-11 rounded-md border px-3 text-sm font-extrabold transition-colors inline-flex items-center justify-center gap-2 ${
              labelMode === 'ean'
                ? 'border-emerald-600 bg-emerald-50 text-emerald-800'
                : 'border-transparent bg-white text-slate-600 hover:border-slate-200 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50'
            }`}
          >
            <Barcode size={18} aria-hidden="true" />
            {language === 'vi' ? 'Tem mã sản phẩm / EAN' : language === 'pl' ? 'Etykieta produktu / EAN' : 'Product code / EAN label'}
          </button>
        </div>
      </nav>

      <div className="min-h-0 flex-1">
        <div
          data-label-mode-panel="order"
          hidden={labelMode !== 'order'}
          aria-hidden={labelMode !== 'order'}
          className="h-full min-h-0"
        >
          <PrintOrderPanel
            language={language}
            active={labelMode === 'order'}
            onPrintingChange={handleOrderPrintingChange}
            categories={categories}
            onCategoriesChanged={refresh}
            onProductFiled={({ categoryId }) => {
              ensureCategoryShown(categoryId);
              // The style exists on the server now; the tab lists it after a
              // pull, the same way an added colour arrives.
              void syncProducts();
            }}
            styleById={(templateId) => {
              const group = styleGroups.find((candidate) => candidate.key === templateId);
              return group
                ? { name: group.name, categoryId: group.categoryId, variants: group.variants }
                : null;
            }}
            styleByCode={(styleCode) => {
              // By the style's own code first, then by any row whose SKU was
              // built from it: a style whose first row is "115-CZARNY-S-2" or
              // an imported one whose rows read "MOON-VE114-BEZ" still answers.
              const group = styleGroups.find(
                (candidate) =>
                  sameStyleCode(candidate.styleCode, styleCode)
                  || candidate.variants.some((row) => rowBelongsToStyle(row.sku, styleCode)),
              );
              return group
                ? { id: group.key, name: group.name, categoryId: group.categoryId, variants: group.variants }
                : null;
            }}
          />
        </div>
        <div
          data-label-mode-panel="fabric"
          hidden={labelMode !== 'fabric'}
          aria-hidden={labelMode !== 'fabric'}
          className="h-full min-h-0"
        >
          <FabricArtworkPanel
            language={language}
            active={labelMode === 'fabric'}
            onPrintingChange={handleFabricArtworkPrintingChange}
          />
        </div>
        <div
          data-label-mode-panel="ean"
          hidden={labelMode !== 'ean'}
          aria-hidden={labelMode !== 'ean'}
          className="h-full min-h-0"
        >
      <div className="grid h-full min-h-0 gap-3 lg:grid-cols-[minmax(360px,400px),minmax(0,1fr)]">
        <aside className="min-h-0 rounded-lg border border-slate-200 bg-white flex flex-col overflow-hidden">
          <div className="border-b border-slate-200 px-4 py-3">
            <div className="flex items-center gap-3">
              <div className="h-10 w-10 rounded-lg bg-emerald-50 text-emerald-700 flex items-center justify-center shrink-0">
                <Tag size={22} />
              </div>
              <div className="min-w-0 flex-1">
                <h1 className="text-lg font-extrabold leading-tight">{copy.title}</h1>
                <p className="text-xs font-semibold text-slate-500 truncate">{copy.subtitle}</p>
              </div>
            </div>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto p-3 space-y-3">
            {status.type === 'error' && (
              <div
                className="flex items-center gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm font-bold text-amber-800"
                data-testid="label-status"
              >
                <AlertTriangle size={17} />
                <span>{status.message}</span>
              </div>
            )}
            {selectedGroup ? (
              <>
                <section className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2">
                  <div className="text-sm font-black leading-tight text-slate-950">
                    {selectedGroup.name}
                  </div>
                  <div className="mt-1 flex flex-wrap gap-x-3 text-xs font-bold text-slate-500">
                    {selectedGroup.styleCode ? <span>{selectedGroup.styleCode}</span> : null}
                    <span>
                      {selectedCategory ? resolveName(selectedCategory, labelLanguage) : '-'}
                    </span>
                  </div>
                </section>

                <StyleReprintPanel
                  key={selectedGroup.key}
                  language={language}
                  templateId={selectedGroup.key}
                  styleName={selectedGroup.name}
                  styleCode={selectedGroup.styleCode}
                  variants={selectedGroup.variants}
                  onPrintingChange={handleReprintingChange}
                  // A colour added on the server reaches this list through a
                  // sync; without one the operator adds it and sees nothing.
                  categoryId={selectedGroup.categoryId}
                  categories={categories}
                  onCatalogChanged={syncProducts}
                />
              </>
            ) : (
              <div className="rounded-lg border border-dashed border-slate-200 px-4 py-6 text-center">
                <Tag className="mx-auto mb-3 text-slate-300" size={36} />
                <div className="text-sm font-extrabold text-slate-800">{copy.noSelection}</div>
                <p className="mt-1 text-xs font-semibold text-slate-500">{copy.selectProductHint}</p>
              </div>
            )}
          </div>
        </aside>

        <section className="min-h-0 rounded-lg border border-slate-200 bg-white flex flex-col overflow-hidden">
          <div className="border-b border-slate-200 px-4 py-3 space-y-3">
            <div className="flex items-center gap-2">
              <div className="relative flex-1 min-w-0">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" size={18} />
                <input
                  ref={searchInputRef}
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder={copy.search}
                  className="h-11 w-full rounded-lg border border-slate-200 bg-white pl-10 pr-11 text-sm font-semibold outline-none focus:ring-2 focus:ring-emerald-200"
                />
                {query && (
                  <button
                    type="button"
                    onClick={() => setQuery('')}
                    aria-label={copy.clear}
                    title={copy.clear}
                    className="absolute right-1.5 top-1/2 h-8 w-8 -translate-y-1/2 rounded-md text-slate-400 hover:bg-slate-100 hover:text-slate-700"
                  >
                    <X size={17} className="mx-auto" />
                  </button>
                )}
              </div>
              <button
                type="button"
                onClick={() => void syncProducts()}
                disabled={syncing}
                className="h-11 w-11 rounded-lg border border-slate-200 bg-white text-slate-600 hover:bg-slate-50 disabled:opacity-60 inline-flex items-center justify-center"
                title={syncing ? copy.syncing : copy.sync}
                aria-label={syncing ? copy.syncing : copy.sync}
              >
                <RefreshCw size={17} className={syncing ? 'animate-spin' : ''} />
              </button>
              <button
                type="button"
                data-testid="manage-categories"
                onClick={() => void openCategoryManager()}
                disabled={categoryManagerOpening}
                className="h-11 px-3 rounded-lg border border-slate-200 bg-white text-sm font-bold text-slate-700 hover:bg-slate-50 disabled:opacity-60 inline-flex items-center gap-2"
                title={categoryManagerError ?? copy.manageCategories}
              >
                <Tags size={17} />
                {copy.manageCategories}
              </button>
              <button
                type="button"
                onClick={() => setSettingsOpen((value) => !value)}
                className={`h-11 px-3 rounded-lg text-sm font-extrabold inline-flex items-center gap-2 ${
                  settingsOpen
                    ? 'bg-emerald-600 text-white hover:bg-emerald-700'
                    : 'bg-slate-950 text-white hover:bg-black'
                }`}
              >
                <Settings size={17} />
                {copy.settings}
              </button>
            </div>

            <div className="flex gap-2 overflow-x-auto pb-1">
              <button
                type="button"
                onClick={() => setActiveCategoryId('')}
                className={`min-h-10 px-3 rounded-md border text-sm font-bold whitespace-nowrap ${
                  activeCategoryId === ''
                    ? 'border-emerald-500 bg-emerald-50 text-emerald-800'
                    : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50'
                }`}
              >
                {copy.allCategories}
                <span className="ml-2 tabular-nums">{styleGroups.length}</span>
              </button>
              {filterCategories.map((category) => {
                // Styles, not variants: the grid shows one card per style, and a
                // chip promising seven where one card appears reads as a fault.
                const count = styleGroups.filter((group) => group.categoryId === category.id).length;
                return (
                  <button
                    key={category.id}
                    type="button"
                    onClick={() => setActiveCategoryId(category.id)}
                    className={`min-h-10 px-3 rounded-md border text-sm font-bold whitespace-nowrap ${
                      activeCategoryId === category.id
                        ? 'border-emerald-500 bg-emerald-50 text-emerald-800'
                        : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50'
                    }`}
                  >
                    {resolveName(category, labelLanguage)}
                    <span className="ml-2 tabular-nums">{count}</span>
                  </button>
                );
              })}
            </div>
          </div>

          <div className="min-h-0 flex-1 overflow-hidden p-3">
            <div className="h-full min-h-0 overflow-y-auto">
              {loading ? (
                <div className="h-full min-h-[360px] flex items-center justify-center text-sm font-semibold text-slate-500">{copy.loading}</div>
              ) : error ? (
                <div className="h-full min-h-[360px] flex items-center justify-center text-sm font-bold text-red-600">
                  {error || copy.loadError}
                </div>
              ) : !setupConfigured ? (
                <div className="h-full min-h-[360px] flex items-center justify-center p-6 text-center">
                  <div className="max-w-sm">
                    <Tag className="mx-auto mb-3 text-slate-300" size={42} />
                    <h2 className="text-base font-extrabold text-slate-900">{copy.setupTitle}</h2>
                    <p className="mt-1 text-sm font-semibold text-slate-500">{copy.setupHint}</p>
                    {staleSelectionCount > 0 ? (
                      <div className="mt-4 rounded-lg border border-amber-200 bg-amber-50 px-3 py-3 text-sm font-semibold text-amber-800">
                        <p>{copy.staleSelections(staleSelectionCount)}</p>
                        <button
                          type="button"
                          onClick={() => void repairLabelSettings()}
                          disabled={repairingSettings}
                          className="mt-3 min-h-11 rounded-md border border-amber-300 bg-white px-3 text-xs font-extrabold text-amber-800 hover:bg-amber-100 disabled:cursor-not-allowed disabled:opacity-60"
                        >
                          {copy.repair}
                        </button>
                      </div>
                    ) : null}
                    <button
                      type="button"
                      onClick={() => setSettingsOpen(true)}
                      className="mt-4 h-10 px-4 rounded-lg bg-slate-950 text-white text-sm font-extrabold hover:bg-black inline-flex items-center gap-2"
                    >
                      <Settings size={16} />
                      {copy.openSettings}
                    </button>
                  </div>
                </div>
              ) : visibleGroups.length === 0 ? (
                <div className="h-full min-h-[360px] flex items-center justify-center text-sm font-semibold text-slate-500">
                  {copy.noMatch}
                </div>
              ) : (
                <div className="grid grid-cols-[repeat(auto-fill,minmax(150px,1fr))] 2xl:grid-cols-[repeat(auto-fill,minmax(168px,1fr))] gap-3 pb-2">
                  {visibleGroups.map((group) => {
                    const first = group.variants[0];
                    const category = group.categoryId ? categoryById.get(group.categoryId) : null;
                    const img = productImage(first);
                    const selected = selectedGroupKey === group.key;
                    const showImage = img && !imageErrors[group.key];
                    const colors = new Set(
                      group.variants
                        .map((variant) => (variant.color_name || '').trim())
                        .filter(Boolean),
                    ).size;
                    const sizes = new Set(
                      group.variants
                        .map((variant) => (variant.size_name || '').trim())
                        .filter(Boolean),
                    ).size;

                    return (
                      <button
                        key={group.key}
                        type="button"
                        onClick={() => selectGroup(group)}
                        data-testid="style-card"
                        className={`relative min-h-[178px] rounded-lg border-2 text-left overflow-hidden transition-colors touch-manipulation focus:outline-none focus:ring-2 focus:ring-emerald-300 ${
                          selected
                            ? 'border-emerald-600 bg-emerald-50 shadow-sm'
                            : 'border-slate-200 bg-white hover:border-slate-300 hover:bg-slate-50'
                        }`}
                      >
                        {selected && (
                          <span className="absolute right-2 top-2 z-[1] rounded-md bg-emerald-600 px-2 py-1 text-[10px] font-extrabold uppercase text-white shadow-sm">
                            {copy.selected}
                          </span>
                        )}
                        <div className="aspect-[4/3] bg-slate-100 flex items-center justify-center overflow-hidden">
                          {showImage ? (
                            <img
                              src={img}
                              alt=""
                              className="h-full w-full object-cover"
                              onError={() => setImageErrors((prev) => ({ ...prev, [group.key]: true }))}
                            />
                          ) : (
                            <Tag size={28} className="text-slate-300" />
                          )}
                        </div>
                        <div className="p-2.5 space-y-1.5">
                          <div className="min-h-[36px] text-sm font-extrabold leading-tight text-slate-950 line-clamp-2">
                            {group.name}
                          </div>
                          <div className="flex items-center justify-between gap-2 text-xs">
                            <span className="truncate font-semibold text-slate-500">
                              {category ? resolveName(category, labelLanguage) : '-'}
                            </span>
                            <span className="shrink-0 font-extrabold text-slate-950">
                              {group.styleCode || '-'}
                            </span>
                          </div>
                          <div className="max-w-full truncate rounded-md bg-slate-100 px-2 py-1 text-[11px] font-bold text-slate-700">
                            {copy.variantSummary(colors, sizes, group.variants.length)}
                          </div>
                        </div>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>

            {settingsOpen && (
              <div
                className="fixed inset-0 z-50 flex justify-end bg-slate-950/30 p-3"
                style={{ paddingBottom: 'calc(var(--touch-keyboard-inset, 0px) + 0.75rem)' }}
                onClick={() => setSettingsOpen(false)}
              >
                <aside
                  className="h-full min-h-0 w-full max-w-[420px] rounded-lg border border-slate-200 bg-slate-50 shadow-2xl flex flex-col overflow-hidden"
                  onClick={(event) => event.stopPropagation()}
                >
                <div className="border-b border-slate-200 bg-white p-3 flex items-start gap-2">
                  <div className="h-9 w-9 rounded-lg bg-slate-100 text-slate-700 flex items-center justify-center shrink-0">
                    <Settings size={18} />
                  </div>
                  <div className="min-w-0 flex-1">
                    <h2 className="text-sm font-extrabold text-slate-900">{copy.settings}</h2>
                    <p className="mt-0.5 text-xs font-semibold text-slate-500">{copy.categoryHint}</p>
                  </div>
                  <button
                    type="button"
                    onClick={() => setSettingsOpen(false)}
                    className="h-8 w-8 rounded-md text-slate-500 hover:bg-slate-100 inline-flex items-center justify-center"
                    aria-label={copy.close}
                    title={copy.close}
                  >
                    <X size={17} />
                  </button>
                </div>

                <div className="min-h-0 flex-1 overflow-y-auto p-3 space-y-4">
                  {staleSelectionCount > 0 ? (
                    <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-3 text-sm font-semibold text-amber-800">
                      <p>{copy.staleSelections(staleSelectionCount)}</p>
                      <button
                        type="button"
                        onClick={() => void repairLabelSettings()}
                        disabled={repairingSettings}
                        className="mt-2 min-h-11 rounded-md border border-amber-300 bg-white px-3 text-xs font-extrabold text-amber-800 hover:bg-amber-100 disabled:cursor-not-allowed disabled:opacity-60"
                      >
                        {copy.repair}
                      </button>
                    </div>
                  ) : null}
                  <section className="space-y-2">
                    <div className="flex items-center justify-between gap-2">
                      <div>
                        <div className="text-xs font-extrabold uppercase tracking-wide text-slate-400">{copy.categories}</div>
                        <div className="text-[11px] font-bold text-slate-500">{selectedCategories.length} {copy.selected}</div>
                      </div>
                      {configuredCategoryIds.size > 0 && (
                        <button
                          type="button"
                          onClick={clearCategories}
                          className="h-8 rounded-md border border-slate-200 bg-white px-2 text-[11px] font-extrabold text-slate-600 hover:bg-slate-100"
                        >
                          {copy.clear}
                        </button>
                      )}
                    </div>

                    {categories.length === 0 ? (
                      <div className="rounded-lg border border-dashed border-slate-200 bg-white px-3 py-3 text-sm font-semibold text-slate-400">
                        {copy.noCategories}
                      </div>
                    ) : (
                      <div className="max-h-48 overflow-y-auto space-y-1.5 pr-1">
                        {categories.map((category) => {
                          const selected = configuredCategoryIds.has(category.id);
                          return (
                            <label
                              key={category.id}
                              className={`flex items-center gap-2 rounded-lg border px-3 py-2 cursor-pointer ${
                                selected
                                  ? 'border-emerald-400 bg-emerald-50 text-emerald-800'
                                  : 'border-slate-200 bg-white text-slate-700 hover:bg-slate-50'
                              }`}
                            >
                              <input
                                type="checkbox"
                                checked={selected}
                                onChange={() => toggleCategory(category.id)}
                                className="h-4 w-4 rounded border-slate-300 text-emerald-600 focus:ring-emerald-300"
                              />
                              <span className="min-w-0 flex-1 truncate text-sm font-bold">
                                {resolveName(category, labelLanguage)}
                              </span>
                            </label>
                          );
                        })}
                      </div>
                    )}
                  </section>

                  <section ref={pinSearchSectionRef} className="space-y-2">
                    <div>
                      <div className="text-xs font-extrabold uppercase tracking-wide text-slate-400">{copy.pinnedProducts}</div>
                      <div className="text-[11px] font-bold text-slate-500">{pinnedProducts.length} {copy.selected}</div>
                    </div>
                    <div className="relative">
                      <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" size={16} />
                      <input
                        value={settingsQuery}
                        onChange={(event) => setSettingsQuery(event.target.value)}
                        onFocus={scrollPinSearchIntoView}
                        onPointerDown={scrollPinSearchIntoView}
                        placeholder={copy.pinSearch}
                        className="h-10 w-full rounded-lg border border-slate-200 bg-white pl-9 pr-3 text-sm font-semibold outline-none focus:ring-2 focus:ring-emerald-200"
                      />
                    </div>

                    {selectableProducts.length === 0 ? (
                      <div className="rounded-lg border border-dashed border-slate-200 bg-white px-3 py-3 text-sm font-semibold text-slate-400">
                        {copy.noProductsAvailable}
                      </div>
                    ) : (
                      <div className="space-y-1.5">
                        <div className="text-[11px] font-extrabold uppercase tracking-wide text-slate-400">{copy.availableProducts}</div>
                        {selectableProducts.map((product) => {
                          const displayName = resolveName(product, labelLanguage) || product.name;
                          const pinned = pinnedProductIds.has(product.id);
                          const barcode = resolveLabelCode(product);
                          const category = product.category_id ? categoryById.get(product.category_id) : null;
                          const img = productImage(product);
                          return (
                            <div key={product.id} className="flex items-center gap-2 rounded-lg border border-slate-200 bg-white p-2">
                              <div className="h-11 w-11 rounded-md overflow-hidden bg-slate-100 shrink-0">
                                {img ? (
                                  <img src={img} alt="" className="h-full w-full object-cover" />
                                ) : (
                                  <div className="h-full w-full flex items-center justify-center text-slate-400">
                                    <Tag size={18} />
                                  </div>
                                )}
                              </div>
                              <div className="min-w-0 flex-1">
                                <div className="text-xs font-extrabold text-slate-900 line-clamp-2">{displayName}</div>
                                <div className="mt-0.5 text-[11px] font-semibold text-slate-400 truncate">
                                  {category ? `${resolveName(category, labelLanguage)} - ` : ''}{barcode || copy.missingEan}
                                </div>
                              </div>
                              <button
                                type="button"
                                onClick={() => togglePinnedProduct(product.id)}
                                className={`h-9 w-9 rounded-md flex items-center justify-center shrink-0 ${
                                  pinned
                                    ? 'bg-emerald-50 text-emerald-700 hover:bg-emerald-100'
                                    : 'bg-slate-950 text-white hover:bg-black'
                                }`}
                                aria-label={pinned ? copy.pinned : copy.openSettings}
                                title={pinned ? copy.pinned : copy.openSettings}
                              >
                                {pinned ? <Check size={16} /> : <Plus size={16} />}
                              </button>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </section>
                </div>
                </aside>
              </div>
            )}
          </div>
        </section>
      </div>
        </div>
      </div>
    </div>
    {categoryManagerError && (
      <p role="alert" data-testid="manage-categories-error" className="sr-only">
        {categoryManagerError}
      </p>
    )}
    {categoryManager && (
      <CategoryManagerDialog
        language={language}
        t={t}
        canCreateCategory={categoryManager.canCreateCategory === true}
        canUpdateCategory={categoryManager.canUpdateCategory === true}
        canReorderCategory={categoryManager.canReorderCategory === true && categoryManager.supportsCategoryBatchUpdate === true}
        canDeleteCategory={categoryManager.canDeleteCategory === true}
        canReplaceCategoryImage={categoryManager.canReplaceCategoryImage === true}
        supportsCategoryImageUpload={categoryManager.supportsCategoryImageUpload === true}
        localCategoryCount={categories.length}
        localProductCounts={localProductCountsByCategory}
        onClose={() => setCategoryManager(null)}
        onChanged={refresh}
      />
    )}
    </>
  );
}
