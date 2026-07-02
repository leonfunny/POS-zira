import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  Check,
  CheckCircle2,
  Clock,
  Minus,
  Plus,
  Printer,
  RefreshCw,
  RotateCw,
  Search,
  Settings,
  Tag,
  X,
} from 'lucide-react';
import { resolveName } from '../../../shared/catalog-names';
import type { AgentConfig } from '../../../shared/types';
import { useConfig } from '../../hooks/useConfig';
import { useProducts } from '../../hooks/useProducts';
import type { ProductListItem } from '../../hooks/useProducts';
import type { Category } from '../../hooks/usePosDb';
import { getTranslation, type Language } from '../../i18n/translations';
import rlog from '../../utils/logger';
import { formatProductLabelPriceText } from '../../utils/product-label';
import ConfirmActionDialog from '../pos/ConfirmActionDialog';

interface LabelModuleProps {
  language: Language;
}

type LabelProduct = ProductListItem & { ean?: string | null };

type LabelStatus =
  | { type: 'idle'; message: string }
  | { type: 'printing'; message: string; productId: string }
  | { type: 'success'; message: string }
  | { type: 'error'; message: string };

interface RecentPrint {
  id: string;
  productId: string;
  productName: string;
  barcode: string;
  copies: number;
  printedAt: Date;
}

interface PendingHighCopyPrint {
  product: LabelProduct;
  requestedCopies: number;
  options: { confirmHighCopy?: boolean };
}

interface LabelCopy {
  title: string;
  subtitle: string;
  settings: string;
  close: string;
  sync: string;
  syncing: string;
  search: string;
  allCategories: string;
  products: string;
  selected: string;
  setupTitle: string;
  setupHint: string;
  openSettings: string;
  noMatch: string;
  loading: string;
  loadError: string;
  labelPreview: string;
  productInfo: string;
  noSelection: string;
  selectProductHint: string;
  ean: string;
  sku: string;
  category: string;
  price: string;
  unit: string;
  missingEan: string;
  missingPrice: string;
  priceMissingHint: string;
  noPrice: string;
  copies: string;
  printing: string;
  printed: string;
  printerError: string;
  ready: string;
  recent: string;
  noRecent: string;
  reprint: string;
  categories: string;
  categoryHint: string;
  pinnedProducts: string;
  pinSearch: string;
  pinned: string;
  availableProducts: string;
  clear: string;
  noCategories: string;
  noProductsAvailable: string;
  highCopyWarning: string;
  printCopies: (quantity: number) => string;
  highCopyConfirm: (quantity: number) => string;
}

const HIGH_COPY_CONFIRM_THRESHOLD = 10;
const RECENT_PRINT_LIMIT = 5;

type LabelLanguage = 'vi' | 'pl';

const LABEL_LANGS: LabelLanguage[] = ['vi', 'pl'];

function coerceLabelLanguage(value: unknown): LabelLanguage {
  return LABEL_LANGS.includes(value as LabelLanguage) ? (value as LabelLanguage) : 'vi';
}

const COPY: Record<string, LabelCopy> = {
  en: {
    title: 'Label',
    subtitle: 'Fresh-counter labels',
    settings: 'Settings',
    close: 'Close',
    sync: 'Sync',
    syncing: 'Syncing',
    search: 'Search name, SKU, EAN, category',
    allCategories: 'All label products',
    products: 'products',
    selected: 'Selected',
    setupTitle: 'Choose categories or pinned products',
    setupHint: 'The Label tab stays empty until this counter is configured.',
    openSettings: 'Open settings',
    noMatch: 'No matching label products',
    loading: 'Loading products...',
    loadError: 'Could not load products',
    labelPreview: 'Label preview',
    productInfo: 'Product info',
    noSelection: 'No product selected',
    selectProductHint: 'Select a product card to preview its label.',
    ean: 'EAN',
    sku: 'SKU',
    category: 'Category',
    price: 'Price',
    unit: 'Unit',
    missingEan: 'Missing EAN',
    missingPrice: 'Missing price',
    priceMissingHint: 'Label can print, but the price line will be blank.',
    noPrice: 'No price',
    copies: 'Copies',
    printing: 'Printing label...',
    printed: 'Label sent to printer',
    printerError: 'Label printer error',
    ready: 'Ready to print',
    recent: 'Recent prints',
    noRecent: 'No labels printed yet',
    reprint: 'Reprint',
    categories: 'Categories',
    categoryHint: 'Selected categories are visible in the Label tab.',
    pinnedProducts: 'Pinned products',
    pinSearch: 'Search product to pin',
    pinned: 'Pinned',
    availableProducts: 'Available products',
    clear: 'Clear',
    noCategories: 'No local categories found',
    noProductsAvailable: 'No products found',
    highCopyWarning: 'Large copy count requires confirmation before printing.',
    printCopies: (quantity) => quantity === 1 ? 'Print label' : `Print ${quantity} labels`,
    highCopyConfirm: (quantity) => `You are about to print ${quantity} labels. Continue?`,
  },
  vi: {
    title: 'Label',
    subtitle: 'Tem cho quầy hàng tươi',
    settings: 'Cài đặt',
    close: 'Đóng',
    sync: 'Đồng bộ',
    syncing: 'Đang đồng bộ',
    search: 'Tìm tên, SKU, EAN, danh mục',
    allCategories: 'Tất cả sản phẩm tem',
    products: 'sản phẩm',
    selected: 'Đang chọn',
    setupTitle: 'Chọn danh mục hoặc ghim sản phẩm',
    setupHint: 'Tab Label để trống cho đến khi quầy này được cấu hình.',
    openSettings: 'Mở cài đặt',
    noMatch: 'Không tìm thấy sản phẩm tem',
    loading: 'Đang tải sản phẩm...',
    loadError: 'Không tải được sản phẩm',
    labelPreview: 'Xem trước tem',
    productInfo: 'Thông tin sản phẩm',
    noSelection: 'Chưa chọn sản phẩm',
    selectProductHint: 'Chọn một thẻ sản phẩm để xem tem.',
    ean: 'EAN',
    sku: 'SKU',
    category: 'Danh mục',
    price: 'Giá',
    unit: 'Đơn vị',
    missingEan: 'Thiếu EAN',
    missingPrice: 'Thiếu giá',
    priceMissingHint: 'Tem vẫn in được, nhưng dòng giá sẽ để trống.',
    noPrice: 'Không có giá',
    copies: 'Số bản in',
    printing: 'Đang in tem...',
    printed: 'Đã gửi tem đến máy in',
    printerError: 'Lỗi máy in tem',
    ready: 'Sẵn sàng in',
    recent: 'Lịch sử in gần đây',
    noRecent: 'Chưa in tem nào',
    reprint: 'In lại',
    categories: 'Danh mục',
    categoryHint: 'Danh mục đã chọn sẽ hiện trong tab Label.',
    pinnedProducts: 'Sản phẩm ghim',
    pinSearch: 'Tìm sản phẩm để ghim',
    pinned: 'Đã ghim',
    availableProducts: 'Sản phẩm có thể chọn',
    clear: 'Xóa',
    noCategories: 'Không có danh mục cục bộ',
    noProductsAvailable: 'Không tìm thấy sản phẩm',
    highCopyWarning: 'Số lượng lớn sẽ cần xác nhận trước khi in.',
    printCopies: (quantity) => quantity === 1 ? 'In tem' : `In ${quantity} tem`,
    highCopyConfirm: (quantity) => `Bạn sắp in ${quantity} tem. Tiếp tục?`,
  },
  pl: {
    title: 'Label',
    subtitle: 'Etykiety na ladę świeżą',
    settings: 'Ustawienia',
    close: 'Zamknij',
    sync: 'Synchronizuj',
    syncing: 'Synchronizacja',
    search: 'Szukaj nazwy, SKU, EAN, kategorii',
    allCategories: 'Wszystkie produkty etykiet',
    products: 'produkty',
    selected: 'Wybrane',
    setupTitle: 'Wybierz kategorie albo przypięte produkty',
    setupHint: 'Zakładka Label jest pusta, dopóki ta lada nie jest skonfigurowana.',
    openSettings: 'Otwórz ustawienia',
    noMatch: 'Brak pasujących produktów',
    loading: 'Ładowanie produktów...',
    loadError: 'Nie udało się załadować produktów',
    labelPreview: 'Podgląd etykiety',
    productInfo: 'Informacje o produkcie',
    noSelection: 'Nie wybrano produktu',
    selectProductHint: 'Wybierz kartę produktu, aby zobaczyć etykietę.',
    ean: 'EAN',
    sku: 'SKU',
    category: 'Kategoria',
    price: 'Cena',
    unit: 'Jednostka',
    missingEan: 'Brak EAN',
    missingPrice: 'Brak ceny',
    priceMissingHint: 'Etykieta może zostać wydrukowana, ale linia ceny będzie pusta.',
    noPrice: 'Brak ceny',
    copies: 'Kopie',
    printing: 'Drukowanie etykiety...',
    printed: 'Etykieta wysłana do drukarki',
    printerError: 'Błąd drukarki etykiet',
    ready: 'Gotowe do druku',
    recent: 'Ostatnie wydruki',
    noRecent: 'Brak wydrukowanych etykiet',
    reprint: 'Drukuj ponownie',
    categories: 'Kategorie',
    categoryHint: 'Wybrane kategorie są widoczne w zakładce Label.',
    pinnedProducts: 'Przypięte produkty',
    pinSearch: 'Szukaj produktu do przypięcia',
    pinned: 'Przypięto',
    availableProducts: 'Dostępne produkty',
    clear: 'Wyczyść',
    noCategories: 'Brak lokalnych kategorii',
    noProductsAvailable: 'Nie znaleziono produktów',
    highCopyWarning: 'Duża liczba kopii wymaga potwierdzenia przed drukiem.',
    printCopies: (quantity) => quantity === 1 ? 'Drukuj etykietę' : `Drukuj ${quantity} etyk.`,
    highCopyConfirm: (quantity) => `Zamierzasz wydrukować ${quantity} etykiet. Kontynuować?`,
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

function uniqueIds(ids: string[]): string[] {
  return Array.from(new Set(ids.map((id) => String(id || '').trim()).filter(Boolean)));
}

function clampCopies(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 1;
  return Math.max(1, Math.min(999, Math.round(parsed)));
}

function resolveLabelCode(product: LabelProduct | null): string {
  if (!product) return '';
  return String(product.barcode ?? product.ean ?? '').trim();
}

function productImage(product: LabelProduct): string | null {
  return (product.thumbnail_url || product.image_url || null) as string | null;
}

function productUnit(product: LabelProduct | null): string {
  if (!product) return '-';
  const saleUnit = String(product.sale_unit || '').trim();
  if (saleUnit) return saleUnit;
  return product.sell_by === 'WEIGHT' ? 'kg' : 'item';
}

function formatRecentTime(date: Date, labelLanguage: LabelLanguage): string {
  const locale = labelLanguage === 'pl' ? 'pl-PL' : 'vi-VN';
  return date.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' });
}

function barcodeBars(barcode: string): number[] {
  const seed = barcode || '0000000000000';
  return Array.from(seed.slice(0, 24)).map((char, index) => {
    const code = char.charCodeAt(0) + index * 7;
    return 2 + (code % 4);
  });
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

function BarcodePreview({ barcode }: { barcode: string }) {
  const bars = barcodeBars(barcode);
  return (
    <div className="rounded-md border border-slate-200 bg-white px-2 py-2" aria-label="Barcode preview">
      <div className="flex h-9 items-end justify-center gap-[2px] overflow-hidden rounded bg-white">
        {bars.map((width, index) => (
          <span
            key={`${barcode || 'empty'}-${index}`}
            className="block bg-slate-950"
            style={{
              width: `${width}px`,
              height: `${22 + ((index * 11) % 12)}px`,
            }}
          />
        ))}
      </div>
      <div className="mt-1 text-center font-mono text-[11px] font-bold tracking-[0.08em] text-slate-800">
        {barcode || '------------'}
      </div>
    </div>
  );
}

export default function LabelModule({ language }: LabelModuleProps) {
  const { config, saveConfig } = useConfig();
  const [labelLanguage, setLabelLanguage] = useState<LabelLanguage>(() => coerceLabelLanguage(config?.posLanguage));
  const copy = COPY[labelLanguage] || COPY.vi;
  const t = getTranslation(language);
  const tOr = (key: string, fallback: string) => {
    const value = t(key);
    return value && value !== key ? value : fallback;
  };
  const { allProducts, categories, loading, error, syncProducts, syncing } = useProducts(labelLanguage);
  const products = allProducts as LabelProduct[];
  const [query, setQuery] = useState('');
  const [settingsQuery, setSettingsQuery] = useState('');
  const [activeCategoryId, setActiveCategoryId] = useState('');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [selectedProductId, setSelectedProductId] = useState('');
  const [copies, setCopies] = useState(1);
  const [status, setStatus] = useState<LabelStatus>({ type: 'idle', message: '' });
  const [recentPrints, setRecentPrints] = useState<RecentPrint[]>([]);
  const [imageErrors, setImageErrors] = useState<Record<string, boolean>>({});
  const [optimisticCategoryIds, setOptimisticCategoryIds] = useState<string[]>([]);
  const [optimisticProductIds, setOptimisticProductIds] = useState<string[]>([]);
  const [pendingHighCopyPrint, setPendingHighCopyPrint] = useState<PendingHighCopyPrint | null>(null);
  const [confirmingHighCopyPrint, setConfirmingHighCopyPrint] = useState(false);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const pinSearchSectionRef = useRef<HTMLElement | null>(null);
  const statusResetTimeoutRef = useRef<number | null>(null);
  const printSequenceRef = useRef(0);
  const configSaveChainRef = useRef<Promise<void>>(Promise.resolve());
  const pendingCategoryConfigSavesRef = useRef(0);
  const pendingProductConfigSavesRef = useRef(0);

  const clearStatusResetTimeout = useCallback(() => {
    if (statusResetTimeoutRef.current !== null) {
      window.clearTimeout(statusResetTimeoutRef.current);
      statusResetTimeoutRef.current = null;
    }
  }, []);

  useEffect(() => {
    setLabelLanguage(coerceLabelLanguage(config?.posLanguage));
  }, [config?.posLanguage]);

  useEffect(() => {
    if (pendingCategoryConfigSavesRef.current > 0) return;
    setOptimisticCategoryIds(uniqueIds((config?.labelModuleCategoryIds || []) as string[]));
  }, [config?.labelModuleCategoryIds]);

  useEffect(() => {
    if (pendingProductConfigSavesRef.current > 0) return;
    setOptimisticProductIds(uniqueIds((config?.labelModuleProductIds || []) as string[]));
  }, [config?.labelModuleProductIds]);

  useEffect(() => {
    return () => clearStatusResetTimeout();
  }, [clearStatusResetTimeout]);

  const pinnedProductIds = useMemo(
    () => new Set(optimisticProductIds),
    [optimisticProductIds],
  );

  const configuredCategoryIds = useMemo(
    () => new Set(optimisticCategoryIds),
    [optimisticCategoryIds],
  );

  const categoryById = useMemo(() => new Map(categories.map((category) => [category.id, category])), [categories]);
  const setupConfigured = pinnedProductIds.size > 0 || configuredCategoryIds.size > 0;

  const labelProducts = useMemo(() => {
    if (!setupConfigured) return [];
    return products.filter((product) => {
      const categorySelected = !!product.category_id && configuredCategoryIds.has(product.category_id);
      return categorySelected || pinnedProductIds.has(product.id);
    });
  }, [configuredCategoryIds, pinnedProductIds, products, setupConfigured]);

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

  const visibleProducts = useMemo(() => {
    const normalized = normalizeSearch(query);
    return labelProducts
      .filter((product) => !activeCategoryId || product.category_id === activeCategoryId)
      .filter((product) => productMatches(product, normalized, categoryById, labelLanguage));
  }, [activeCategoryId, categoryById, labelLanguage, labelProducts, query]);

  useEffect(() => {
    if (labelProducts.length === 0) {
      if (selectedProductId) setSelectedProductId('');
      return;
    }
    if (!selectedProductId || !labelProducts.some((product) => product.id === selectedProductId)) {
      setSelectedProductId(labelProducts[0].id);
    }
  }, [labelProducts, selectedProductId]);

  const selectedProduct = useMemo(
    () => labelProducts.find((product) => product.id === selectedProductId) || null,
    [labelProducts, selectedProductId],
  );

  const selectedBarcode = resolveLabelCode(selectedProduct);
  const selectedName = selectedProduct ? (resolveName(selectedProduct, labelLanguage) || selectedProduct.name || selectedBarcode) : '';
  const selectedPriceText = selectedProduct ? formatProductLabelPriceText(selectedProduct, 'zl') : undefined;
  const selectedCategory = selectedProduct?.category_id ? categoryById.get(selectedProduct.category_id) : null;
  const selectedUnit = productUnit(selectedProduct);
  const normalizedCopies = clampCopies(copies);
  const priceMissing = !!selectedProduct && !selectedPriceText;
  const canPrint = !!selectedProduct && !!selectedBarcode && status.type !== 'printing';
  const statusText = status.message || (
    selectedProduct ? (selectedBarcode ? copy.ready : copy.missingEan) : copy.noSelection
  );
  const printButtonText = status.type === 'printing'
    ? copy.printing
    : selectedProduct && selectedBarcode
      ? copy.printCopies(normalizedCopies)
      : selectedProduct
        ? copy.missingEan
        : copy.noSelection;

  const selectableProducts = useMemo(() => {
    const normalized = normalizeSearch(settingsQuery);
    return products
      .filter((product) => productMatches(product, normalized, categoryById, labelLanguage))
      .slice(0, 160);
  }, [categoryById, labelLanguage, products, settingsQuery]);

  const selectedCategories = useMemo(
    () => categories.filter((category) => configuredCategoryIds.has(category.id)),
    [categories, configuredCategoryIds],
  );

  const pinnedProducts = useMemo(
    () => products.filter((product) => pinnedProductIds.has(product.id)),
    [pinnedProductIds, products],
  );

  const handleLabelLanguageChange = useCallback((next: LabelLanguage) => {
    setLabelLanguage(next);
    saveConfig({ posLanguage: next }).catch((err: any) => {
      rlog.error('[LabelModule] Failed to save label language:', err);
    });
  }, [saveConfig]);

  const persistLabelConfig = useCallback((partial: Partial<AgentConfig>) => {
    const hasCategoryIds = Object.prototype.hasOwnProperty.call(partial, 'labelModuleCategoryIds');
    const hasProductIds = Object.prototype.hasOwnProperty.call(partial, 'labelModuleProductIds');
    if (hasCategoryIds) pendingCategoryConfigSavesRef.current += 1;
    if (hasProductIds) pendingProductConfigSavesRef.current += 1;

    const saveNext = async () => {
      try {
        await saveConfig(partial);
      } catch (err: any) {
        clearStatusResetTimeout();
        rlog.error('[LabelModule] Failed to save label settings:', err);
        setStatus({ type: 'error', message: err?.message || 'Failed to save label settings' });
      } finally {
        if (hasCategoryIds) pendingCategoryConfigSavesRef.current = Math.max(0, pendingCategoryConfigSavesRef.current - 1);
        if (hasProductIds) pendingProductConfigSavesRef.current = Math.max(0, pendingProductConfigSavesRef.current - 1);
      }
    };

    const nextSave = configSaveChainRef.current.then(saveNext, saveNext);
    configSaveChainRef.current = nextSave.catch(() => undefined);
    return nextSave;
  }, [clearStatusResetTimeout, saveConfig]);

  const scrollPinSearchIntoView = useCallback(() => {
    window.requestAnimationFrame(() => {
      pinSearchSectionRef.current?.scrollIntoView({ block: 'start', behavior: 'smooth' });
    });
  }, []);

  const toggleCategory = (categoryId: string) => {
    setOptimisticCategoryIds((current) => {
      const next = current.includes(categoryId)
        ? current.filter((id) => id !== categoryId)
        : [...current, categoryId];
      const uniqueNext = uniqueIds(next);
      void persistLabelConfig({ labelModuleCategoryIds: uniqueNext });
      return uniqueNext;
    });
  };

  const clearCategories = () => {
    setOptimisticCategoryIds([]);
    void persistLabelConfig({ labelModuleCategoryIds: [] });
  };

  const togglePinnedProduct = (productId: string) => {
    setOptimisticProductIds((current) => {
      const next = current.includes(productId)
        ? current.filter((id) => id !== productId)
        : [...current, productId];
      const uniqueNext = uniqueIds(next);
      void persistLabelConfig({ labelModuleProductIds: uniqueNext });
      return uniqueNext;
    });
  };

  const selectProduct = (product: LabelProduct) => {
    setSelectedProductId(product.id);
    if (status.type !== 'printing') {
      clearStatusResetTimeout();
      setStatus({ type: 'idle', message: '' });
    }
  };

  const printProduct = useCallback(async (
    product: LabelProduct,
    requestedCopies: number,
    options: { confirmHighCopy?: boolean } = {},
  ) => {
    const barcode = resolveLabelCode(product);
    const quantity = clampCopies(requestedCopies);
    const displayName = resolveName(product, labelLanguage) || product.name || barcode;
    const priceText = formatProductLabelPriceText(product, 'zl');
    const printToken = ++printSequenceRef.current;

    clearStatusResetTimeout();
    setSelectedProductId(product.id);
    setCopies(quantity);

    if (!barcode) {
      setStatus({ type: 'error', message: copy.missingEan });
      return;
    }

    if (options.confirmHighCopy !== false && quantity > HIGH_COPY_CONFIRM_THRESHOLD) {
      setPendingHighCopyPrint({ product, requestedCopies, options });
      return;
    }

    setStatus({ type: 'printing', message: copy.printing, productId: product.id });
    try {
      const result = await window.electronAPI.printLabel(barcode, displayName, {
        priceText,
        sku: product.sku?.trim() || undefined,
        quantity,
      });
      if (!result?.success) {
        setStatus({ type: 'error', message: result?.error || copy.printerError });
        return;
      }
      setStatus({ type: 'success', message: `${copy.printed}: ${displayName}` });
      setRecentPrints((prev) => [
        {
          id: `${Date.now()}-${product.id}`,
          productId: product.id,
          productName: displayName,
          barcode,
          copies: quantity,
          printedAt: new Date(),
        },
        ...prev,
      ].slice(0, RECENT_PRINT_LIMIT));
      statusResetTimeoutRef.current = window.setTimeout(() => {
        if (printSequenceRef.current === printToken) {
          setStatus({ type: 'idle', message: '' });
        }
        statusResetTimeoutRef.current = null;
      }, 3200);
    } catch (err: any) {
      rlog.error('[LabelModule] printLabel failed:', err);
      setStatus({ type: 'error', message: err?.message || copy.printerError });
    }
  }, [clearStatusResetTimeout, copy, labelLanguage]);

  const handleCancelHighCopyPrint = useCallback(() => {
    if (confirmingHighCopyPrint) return;
    setPendingHighCopyPrint(null);
    setStatus({ type: 'idle', message: copy.ready });
  }, [confirmingHighCopyPrint, copy.ready]);

  const handleConfirmHighCopyPrint = useCallback(async () => {
    const pending = pendingHighCopyPrint;
    if (!pending || confirmingHighCopyPrint) return;
    setConfirmingHighCopyPrint(true);
    try {
      await printProduct(pending.product, pending.requestedCopies, {
        ...pending.options,
        confirmHighCopy: false,
      });
      setPendingHighCopyPrint(null);
    } finally {
      setConfirmingHighCopyPrint(false);
    }
  }, [confirmingHighCopyPrint, pendingHighCopyPrint, printProduct]);

  const handlePrint = useCallback(() => {
    if (!selectedProduct) {
      clearStatusResetTimeout();
      setStatus({ type: 'error', message: copy.noSelection });
      return;
    }
    void printProduct(selectedProduct, copies);
  }, [clearStatusResetTimeout, copies, copy.noSelection, printProduct, selectedProduct]);

  const handleQuickReprint = useCallback((entry: RecentPrint) => {
    const product = products.find((row) => row.id === entry.productId);
    if (!product) {
      clearStatusResetTimeout();
      setStatus({ type: 'error', message: copy.noProductsAvailable });
      return;
    }
    void printProduct(product, entry.copies);
  }, [clearStatusResetTimeout, copy.noProductsAvailable, printProduct, products]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const tagName = target?.tagName;
      const isTyping = tagName === 'INPUT' || tagName === 'TEXTAREA' || tagName === 'SELECT';

      if (settingsOpen) {
        if (event.key === 'Escape') {
          event.preventDefault();
          setSettingsOpen(false);
        }
        return;
      }

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

      if (isTyping) return;

      if (event.key === 'Enter') {
        event.preventDefault();
        handlePrint();
        return;
      }
      if (event.key === '+' || event.key === '=') {
        event.preventDefault();
        setCopies((value) => clampCopies(value + 1));
        return;
      }
      if (event.key === '-') {
        event.preventDefault();
        setCopies((value) => clampCopies(value - 1));
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [handlePrint, query, settingsOpen]);

  return (
    <>
    <div className="h-[calc(100vh-2rem)] min-h-0 overflow-hidden bg-slate-50 text-slate-900">
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
              <div className="shrink-0 rounded-lg border border-slate-200 bg-slate-100 p-0.5 inline-flex">
                {LABEL_LANGS.map((lang) => (
                  <button
                    key={lang}
                    type="button"
                    onClick={() => handleLabelLanguageChange(lang)}
                    className={`h-8 min-w-9 rounded-md px-2 text-xs font-black uppercase transition-colors ${
                      labelLanguage === lang
                        ? 'bg-white text-emerald-700 shadow-sm'
                        : 'text-slate-500 hover:bg-white/70 hover:text-slate-800'
                    }`}
                    aria-pressed={labelLanguage === lang}
                    aria-label={lang.toUpperCase()}
                    title={lang.toUpperCase()}
                  >
                    {lang.toUpperCase()}
                  </button>
                ))}
              </div>
            </div>
          </div>

          <div className="shrink-0 p-3 space-y-3">
            <div
              className={`rounded-lg border px-3 py-2 text-sm font-bold inline-flex w-full items-center gap-2 ${
                status.type === 'success'
                  ? 'border-emerald-200 bg-emerald-50 text-emerald-800'
                  : status.type === 'printing'
                    ? 'border-sky-200 bg-sky-50 text-sky-800'
                    : status.type === 'error' || (!!selectedProduct && !selectedBarcode)
                      ? 'border-amber-200 bg-amber-50 text-amber-800'
                      : 'border-slate-200 bg-slate-50 text-slate-700'
              }`}
            >
              {status.type === 'success' ? <CheckCircle2 size={17} /> : status.type === 'printing' ? <RefreshCw size={17} className="animate-spin" /> : status.type === 'error' || (!!selectedProduct && !selectedBarcode) ? <AlertTriangle size={17} /> : <Printer size={17} />}
              <span>{statusText}</span>
            </div>

            {selectedProduct ? (
              <>
                <section className="space-y-2">
                  <div className="text-xs font-extrabold uppercase tracking-wide text-slate-400">{copy.labelPreview}</div>
                  <div className="rounded-lg border border-slate-200 bg-slate-50 p-2">
                    <div className="mx-auto aspect-[58/40] w-full max-w-[270px] rounded-lg bg-white p-3 shadow-sm flex flex-col justify-between">
                      <div className="text-sm font-black leading-tight text-slate-950 line-clamp-2">{selectedName}</div>
                      <div className="flex items-baseline justify-between gap-3">
                        <span className={`text-xl font-black tabular-nums ${selectedPriceText ? 'text-slate-950' : 'text-amber-700'}`}>
                          {selectedPriceText || copy.noPrice}
                        </span>
                        <span className="rounded-md bg-slate-100 px-2 py-1 text-xs font-extrabold text-slate-600">{selectedUnit}</span>
                      </div>
                      <div>
                        <BarcodePreview barcode={selectedBarcode} />
                      </div>
                    </div>
                  </div>
                </section>

                {priceMissing && (
                  <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs font-bold text-amber-800">
                    {copy.missingPrice}. {copy.priceMissingHint}
                  </div>
                )}

                <section className="space-y-2">
                  <div className="flex items-center justify-between gap-3">
                    <div className="min-w-0 text-xs font-extrabold uppercase tracking-wide text-slate-400">{copy.copies}</div>
                    <div className="grid w-40 grid-cols-[38px,1fr,38px] gap-1.5">
                      <button
                        type="button"
                        onClick={() => setCopies((value) => clampCopies(value - 1))}
                        className="h-10 rounded-lg border border-slate-200 bg-white text-slate-700 hover:bg-slate-50 inline-flex items-center justify-center"
                        aria-label="Decrease copies"
                      >
                        <Minus size={17} />
                      </button>
                      <input
                        type="number"
                        min={1}
                        max={999}
                        value={copies}
                        onChange={(event) => setCopies(clampCopies(event.target.value))}
                        className="h-10 min-w-0 rounded-lg border border-slate-200 text-center text-base font-extrabold outline-none focus:ring-2 focus:ring-emerald-200"
                      />
                      <button
                        type="button"
                        onClick={() => setCopies((value) => clampCopies(value + 1))}
                        className="h-10 rounded-lg border border-slate-200 bg-white text-slate-700 hover:bg-slate-50 inline-flex items-center justify-center"
                        aria-label="Increase copies"
                      >
                        <Plus size={17} />
                      </button>
                    </div>
                  </div>
                  {normalizedCopies > HIGH_COPY_CONFIRM_THRESHOLD && (
                    <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs font-bold text-amber-800">
                      {copy.highCopyWarning}
                    </div>
                  )}
                </section>
              </>
            ) : (
              <div className="rounded-lg border border-dashed border-slate-200 px-4 py-6 text-center">
                <Tag className="mx-auto mb-3 text-slate-300" size={36} />
                <div className="text-sm font-extrabold text-slate-800">{copy.noSelection}</div>
                <p className="mt-1 text-xs font-semibold text-slate-500">{copy.selectProductHint}</p>
              </div>
            )}

            <button
              type="button"
              onClick={handlePrint}
              disabled={!canPrint}
              className={`w-full h-14 rounded-lg text-base font-black inline-flex items-center justify-center gap-2 transition-colors touch-manipulation focus:outline-none focus:ring-2 focus:ring-emerald-300 focus:ring-offset-2 ${
                canPrint
                  ? 'bg-slate-950 text-white hover:bg-black active:bg-slate-800 shadow-lg shadow-slate-950/20'
                  : 'bg-slate-200 text-slate-500 cursor-not-allowed'
              }`}
            >
              {status.type === 'printing' ? <RefreshCw size={20} className="animate-spin" /> : <Printer size={20} />}
              {printButtonText}
            </button>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto border-t border-slate-200 p-3 space-y-3">
            {selectedProduct && (
              <section className="space-y-2">
                <div className="text-xs font-extrabold uppercase tracking-wide text-slate-400">{copy.productInfo}</div>
                <div className="grid grid-cols-2 gap-2 text-sm">
                  <div className="rounded-lg bg-slate-50 px-3 py-2">
                    <div className="text-xs font-bold text-slate-400">{copy.ean}</div>
                    <div className={`mt-1 font-extrabold break-all ${selectedBarcode ? 'text-slate-900' : 'text-amber-700'}`}>
                      {selectedBarcode || copy.missingEan}
                    </div>
                  </div>
                  <div className="rounded-lg bg-slate-50 px-3 py-2">
                    <div className="text-xs font-bold text-slate-400">{copy.price}</div>
                    <div className={`mt-1 font-extrabold ${selectedPriceText ? 'text-slate-900' : 'text-amber-700'}`}>
                      {selectedPriceText || copy.noPrice}
                    </div>
                  </div>
                  <div className="rounded-lg bg-slate-50 px-3 py-2">
                    <div className="text-xs font-bold text-slate-400">{copy.category}</div>
                    <div className="mt-1 font-extrabold text-slate-900 truncate">
                      {selectedCategory ? resolveName(selectedCategory, labelLanguage) : '-'}
                    </div>
                  </div>
                  <div className="rounded-lg bg-slate-50 px-3 py-2">
                    <div className="text-xs font-bold text-slate-400">{copy.unit}</div>
                    <div className="mt-1 font-extrabold text-slate-900">{selectedUnit}</div>
                  </div>
                  <div className="col-span-2 rounded-lg bg-slate-50 px-3 py-2">
                    <div className="text-xs font-bold text-slate-400">{copy.sku}</div>
                    <div className="mt-1 font-extrabold text-slate-900 break-all">{selectedProduct.sku || '-'}</div>
                  </div>
                </div>
              </section>
            )}

            <section className="space-y-2">
              <div className="text-xs font-extrabold uppercase tracking-wide text-slate-400">{copy.recent}</div>
              {recentPrints.length === 0 ? (
                <div className="rounded-lg border border-dashed border-slate-200 px-3 py-3 text-sm font-semibold text-slate-400">
                  {copy.noRecent}
                </div>
              ) : (
                <div className="flex gap-2 overflow-x-auto pb-1">
                  {recentPrints.map((entry) => {
                    const product = products.find((row) => row.id === entry.productId);
                    const displayName = product
                      ? (resolveName(product, labelLanguage) || product.name || entry.productName)
                      : entry.productName;

                    return (
                      <div key={entry.id} className="w-44 shrink-0 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2">
                        <div className="text-xs font-extrabold text-slate-900 truncate">{displayName}</div>
                        <div className="mt-1 flex items-center gap-2 text-[11px] font-bold text-slate-500">
                          <Clock size={12} />
                          <span>{formatRecentTime(entry.printedAt, labelLanguage)}</span>
                          <span>x{entry.copies}</span>
                        </div>
                        <button
                          type="button"
                          onClick={() => handleQuickReprint(entry)}
                          className="mt-2 h-8 w-full rounded-md border border-slate-200 bg-white px-2 text-[11px] font-extrabold text-slate-700 hover:bg-slate-100 inline-flex items-center justify-center gap-1"
                        >
                          <RotateCw size={12} />
                          {copy.reprint}
                        </button>
                      </div>
                    );
                  })}
                </div>
              )}
            </section>
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
                <span className="ml-2 tabular-nums">{labelProducts.length}</span>
              </button>
              {filterCategories.map((category) => {
                const count = labelProducts.filter((product) => product.category_id === category.id).length;
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
              ) : visibleProducts.length === 0 ? (
                <div className="h-full min-h-[360px] flex items-center justify-center text-sm font-semibold text-slate-500">
                  {copy.noMatch}
                </div>
              ) : (
                <div className="grid grid-cols-[repeat(auto-fill,minmax(150px,1fr))] 2xl:grid-cols-[repeat(auto-fill,minmax(168px,1fr))] gap-3 pb-2">
                  {visibleProducts.map((product) => {
                    const displayName = resolveName(product, labelLanguage) || product.name;
                    const barcode = resolveLabelCode(product);
                    const priceText = formatProductLabelPriceText(product, 'zl');
                    const category = product.category_id ? categoryById.get(product.category_id) : null;
                    const img = productImage(product);
                    const selected = selectedProduct?.id === product.id;
                    const showImage = img && !imageErrors[product.id];

                    return (
                      <button
                        key={product.id}
                        type="button"
                        onClick={() => selectProduct(product)}
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
                              onError={() => setImageErrors((prev) => ({ ...prev, [product.id]: true }))}
                            />
                          ) : (
                            <Tag size={28} className="text-slate-300" />
                          )}
                        </div>
                        <div className="p-2.5 space-y-1.5">
                          <div className="min-h-[36px] text-sm font-extrabold leading-tight text-slate-950 line-clamp-2">
                            {displayName}
                          </div>
                          <div className="flex items-center justify-between gap-2 text-xs">
                            <span className="truncate font-semibold text-slate-500">{category ? resolveName(category, labelLanguage) : '-'}</span>
                            <span className={`shrink-0 font-extrabold ${priceText ? 'text-slate-950' : 'text-amber-700'}`}>
                              {priceText || copy.noPrice}
                            </span>
                          </div>
                          <div className={`max-w-full text-[11px] font-bold rounded-md px-2 py-1 truncate ${
                            barcode ? 'bg-emerald-100 text-emerald-800' : 'bg-amber-50 text-amber-700'
                          }`}>
                            {barcode || copy.missingEan}
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
    {pendingHighCopyPrint && (
      <ConfirmActionDialog
        open
        tier="light"
        title={tOr('common.confirmTitle', 'Please confirm')}
        body={copy.highCopyConfirm(clampCopies(pendingHighCopyPrint.requestedCopies))}
        confirmLabel={tOr('common.confirm', 'Confirm')}
        cancelLabel={tOr('common.cancel', 'Cancel')}
        busy={confirmingHighCopyPrint}
        onConfirm={handleConfirmHighCopyPrint}
        onCancel={handleCancelHighCopyPrint}
      />
    )}
    </>
  );
}
