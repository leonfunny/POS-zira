import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ArrowLeft,
  Check,
  ChevronRight,
  CircleAlert,
  Home,
  Image as ImageIcon,
  Minus,
  Pencil,
  Plus,
  Search,
  ShoppingCart,
  X,
} from 'lucide-react';
import { resolveName } from '../../../shared/catalog-names';
import {
  formatKitchenSelfOrderModifierLabels,
  normalizeKitchenSelfOrderFulfillment,
  normalizeKitchenSelfOrderLanguage,
  normalizeKitchenSelfOrderQuantity,
  resolveKitchenSelfOrderCheckoutAction,
  sanitizeKitchenSelfOrderNote,
  validateKitchenSelfOrderModifierSelections,
  type KitchenSelfOrderFulfillment,
  type KitchenSelfOrderLanguage,
  type KitchenSelfOrderMenu,
  type KitchenSelfOrderMenuCategory,
  type KitchenSelfOrderMenuProduct,
  type KitchenSelfOrderModifierGroup,
  type KitchenSelfOrderModifierSnapshot,
} from '../../../shared/kitchen-self-order';
import { normalizeCatalogText } from '../self-checkout/catalog-model';

declare global {
  interface Window {
    electronAPI: any;
  }
}

type Step = 'menu' | 'review' | 'terminal' | 'done';

interface CartItem {
  lineId: string;
  product: KitchenSelfOrderMenuProduct;
  quantity: number;
  note: string;
  modifiers: KitchenSelfOrderModifierSnapshot[];
}

interface ConfiguratorState {
  product: KitchenSelfOrderMenuProduct;
  lineId: string | null;
}

interface SubmitResult {
  success?: boolean;
  orderNumber?: string;
  error?: string | null;
}

const COPY = {
  pl: {
    menu: 'Menu',
    all: 'Wszystko',
    search: 'Szukaj w menu',
    cart: 'Koszyk',
    emptyCart: 'Wybierz pozycje z menu.',
    reviewOrder: 'Sprawdź zamówienie',
    reviewTitle: 'Twoje zamówienie',
    placeOrder: 'Złóż zamówienie',
    submitting: 'Wysyłanie...',
    dineIn: 'Na miejscu',
    takeaway: 'Na wynos',
    note: 'Uwagi do przygotowania',
    edit: 'Zmień',
    add: 'Dodaj do koszyka',
    save: 'Zapisz zmiany',
    cancel: 'Anuluj',
    back: 'Wstecz',
    required: 'Wymagane',
    optional: 'Opcjonalne',
    chooseUpTo: 'Wybierz maksymalnie',
    subtotal: 'Razem',
    noProducts: 'Brak pozycji w tej kategorii.',
    loading: 'Ładowanie menu...',
    submitError: 'Nie udało się złożyć zamówienia. Spróbuj ponownie lub poproś obsługę.',
    terminalTitle: 'Płatność przy tym kiosku jest chwilowo niedostępna',
    terminalBody: 'Wróć do zamówienia lub poproś obsługę o pomoc.',
    returnReview: 'Wróć do zamówienia',
    doneTitle: 'Numer zamówienia',
    keepNumber: 'Zachowaj ten numer do odbioru.',
    payAtCounter: 'Zapłać przy kasie i pokaż ten numer.',
    newOrder: 'Nowe zamówienie',
    autoReset: 'Nowe zamówienie rozpocznie się za',
    seconds: 's',
  },
  vi: {
    menu: 'Thực đơn',
    all: 'Tất cả',
    search: 'Tìm trong thực đơn',
    cart: 'Giỏ món',
    emptyCart: 'Chọn món từ thực đơn.',
    reviewOrder: 'Kiểm tra đơn',
    reviewTitle: 'Đơn của bạn',
    placeOrder: 'Đặt món',
    submitting: 'Đang gửi...',
    dineIn: 'Ăn tại quán',
    takeaway: 'Mang đi',
    note: 'Ghi chú chuẩn bị',
    edit: 'Sửa',
    add: 'Thêm vào giỏ',
    save: 'Lưu thay đổi',
    cancel: 'Hủy',
    back: 'Quay lại',
    required: 'Bắt buộc',
    optional: 'Không bắt buộc',
    chooseUpTo: 'Chọn tối đa',
    subtotal: 'Tổng cộng',
    noProducts: 'Không có món trong danh mục này.',
    loading: 'Đang tải thực đơn...',
    submitError: 'Không thể gửi đơn. Vui lòng thử lại hoặc nhờ nhân viên hỗ trợ.',
    terminalTitle: 'Thanh toán tại kiosk hiện chưa khả dụng',
    terminalBody: 'Quay lại đơn hàng hoặc nhờ nhân viên hỗ trợ.',
    returnReview: 'Quay lại đơn',
    doneTitle: 'Số đơn',
    keepNumber: 'Giữ số này để nhận món.',
    payAtCounter: 'Thanh toán tại quầy và đưa số này cho nhân viên.',
    newOrder: 'Đơn mới',
    autoReset: 'Đơn mới sẽ bắt đầu sau',
    seconds: 'giây',
  },
  en: {
    menu: 'Menu',
    all: 'All',
    search: 'Search menu',
    cart: 'Cart',
    emptyCart: 'Choose items from the menu.',
    reviewOrder: 'Review order',
    reviewTitle: 'Your order',
    placeOrder: 'Place order',
    submitting: 'Sending...',
    dineIn: 'Dine in',
    takeaway: 'Takeaway',
    note: 'Preparation note',
    edit: 'Edit',
    add: 'Add to cart',
    save: 'Save changes',
    cancel: 'Cancel',
    back: 'Back',
    required: 'Required',
    optional: 'Optional',
    chooseUpTo: 'Choose up to',
    subtotal: 'Total',
    noProducts: 'No items in this category.',
    loading: 'Loading menu...',
    submitError: 'We could not place the order. Try again or ask a staff member for help.',
    terminalTitle: 'Kiosk payment is temporarily unavailable',
    terminalBody: 'Return to your order or ask a staff member for help.',
    returnReview: 'Return to order',
    doneTitle: 'Order number',
    keepNumber: 'Keep this number for pickup.',
    payAtCounter: 'Pay at the counter and show this number.',
    newOrder: 'New order',
    autoReset: 'A new order will start in',
    seconds: 's',
  },
};

type CopyText = (typeof COPY)[KitchenSelfOrderLanguage];

function formatPLN(grosze: number): string {
  return `${(Math.round(grosze) / 100).toFixed(2).replace('.', ',')} zł`;
}

function makeLineId(productId: string): string {
  return `${productId}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function localizedName(
  entity: { name: string; nameTranslations?: string | null },
  language: KitchenSelfOrderLanguage,
): string {
  return resolveName({
    name: entity.name,
    name_translations: entity.nameTranslations,
  }, language);
}

function modifierTotal(item: Pick<CartItem, 'modifiers'>): number {
  return item.modifiers.reduce(
    (sum, modifier) => sum + modifier.priceDeltaGrosze * modifier.quantity,
    0,
  );
}

function lineTotal(item: CartItem): number {
  return (item.product.priceGrosze + modifierTotal(item)) * item.quantity;
}

function cartTotal(cart: CartItem[]): number {
  return cart.reduce((sum, item) => sum + lineTotal(item), 0);
}

function defaultModifiers(groups: KitchenSelfOrderModifierGroup[]): KitchenSelfOrderModifierSnapshot[] {
  return groups.flatMap((group) =>
    group.options
      .filter((option) => option.isDefault && option.isAvailable)
      .slice(0, group.maxSelections)
      .map((option) => ({
        groupId: group.id,
        groupName: group.name,
        optionId: option.id,
        optionName: option.name,
        quantity: 1,
        priceDeltaGrosze: option.priceDeltaGrosze,
      })));
}

export default function KitchenSelfOrderApp() {
  const [step, setStep] = useState<Step>('menu');
  const [language, setLanguage] = useState<KitchenSelfOrderLanguage>('pl');
  const [fulfillment, setFulfillment] = useState<KitchenSelfOrderFulfillment>('DINE_IN');
  const [menu, setMenu] = useState<KitchenSelfOrderMenu | null>(null);
  const [activeCategoryId, setActiveCategoryId] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [cart, setCart] = useState<CartItem[]>([]);
  const [configurator, setConfigurator] = useState<ConfiguratorState | null>(null);
  const [loadingMenu, setLoadingMenu] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [submitResult, setSubmitResult] = useState<SubmitResult | null>(null);
  const [customerError, setCustomerError] = useState<string | null>(null);
  const [resetCountdown, setResetCountdown] = useState(20);
  const t = COPY[language];

  const refreshMenu = useCallback(async () => {
    setLoadingMenu(true);
    try {
      const nextMenu = await window.electronAPI?.kitchenSelfOrder?.getMenu?.();
      if (nextMenu) {
        setMenu(nextMenu);
        setActiveCategoryId((current) =>
          current && nextMenu.categories.some((category: KitchenSelfOrderMenuCategory) =>
            category.id === current)
            ? current
            : null);
      }
    } finally {
      setLoadingMenu(false);
    }
  }, []);

  useEffect(() => {
    void refreshMenu();
    const unsubscribe = window.electronAPI?.kitchenSelfOrder?.onMenuChanged?.(() => {
      void refreshMenu();
    });
    return () => {
      if (typeof unsubscribe === 'function') unsubscribe();
    };
  }, [refreshMenu]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const config = await window.electronAPI?.getConfig?.();
        if (cancelled || !config) return;
        setLanguage(normalizeKitchenSelfOrderLanguage(config.kitchenSelfOrderLanguage));
        setFulfillment(normalizeKitchenSelfOrderFulfillment(
          config.kitchenSelfOrderDefaultFulfillment,
        ));
      } catch {
        /* keep safe defaults */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const resetSession = useCallback(() => {
    setCart([]);
    setQuery('');
    setActiveCategoryId(null);
    setConfigurator(null);
    setSubmitResult(null);
    setCustomerError(null);
    setSubmitting(false);
    setResetCountdown(20);
    setStep('menu');
  }, []);

  useEffect(() => {
    if (step !== 'done') return undefined;
    setResetCountdown(20);
    const interval = window.setInterval(() => {
      setResetCountdown((current) => {
        if (current <= 1) {
          window.clearInterval(interval);
          resetSession();
          return 20;
        }
        return current - 1;
      });
    }, 1000);
    return () => window.clearInterval(interval);
  }, [resetSession, step]);

  useEffect(() => {
    if (!menu || menu.policies.fulfillmentOptions.includes(fulfillment)) return;
    setFulfillment(menu.policies.fulfillmentOptions[0]);
  }, [fulfillment, menu]);

  const visibleProducts = useMemo(() => {
    if (!menu) return [];
    const normalized = normalizeCatalogText(query);
    return menu.products
      .filter((product) => !activeCategoryId || product.categoryId === activeCategoryId)
      .filter((product) =>
        !normalized || normalizeCatalogText(
          `${product.name} ${product.nameTranslations || ''}`,
        ).includes(normalized))
      .slice(0, 120);
  }, [activeCategoryId, menu, query]);

  const groupsForProduct = useCallback((product: KitchenSelfOrderMenuProduct) => {
    if (!menu) return [];
    return product.modifierGroupAttachmentIds
      .map((attachmentId) => menu.modifierGroups.find((group) =>
        group.attachmentId === attachmentId))
      .filter((group): group is KitchenSelfOrderModifierGroup => !!group);
  }, [menu]);

  const openProduct = (product: KitchenSelfOrderMenuProduct) => {
    const groups = groupsForProduct(product);
    if (groups.length > 0) {
      setConfigurator({ product, lineId: null });
      return;
    }
    setCart((current) => {
      const existing = current.find((item) =>
        item.product.id === product.id && item.modifiers.length === 0 && item.note === '');
      if (existing) {
        return current.map((item) => item.lineId === existing.lineId
          ? { ...item, quantity: normalizeKitchenSelfOrderQuantity(item.quantity + 1) }
          : item);
      }
      return [
        ...current,
        {
          lineId: makeLineId(product.id),
          product,
          quantity: 1,
          note: '',
          modifiers: [],
        },
      ];
    });
  };

  const saveConfiguredItem = (
    product: KitchenSelfOrderMenuProduct,
    modifiers: KitchenSelfOrderModifierSnapshot[],
    note: string,
    lineId: string | null,
  ) => {
    setCart((current) => {
      if (lineId) {
        return current.map((item) => item.lineId === lineId
          ? { ...item, modifiers, note }
          : item);
      }
      return [
        ...current,
        {
          lineId: makeLineId(product.id),
          product,
          quantity: 1,
          note,
          modifiers,
        },
      ];
    });
    setConfigurator(null);
  };

  const updateQuantity = (lineId: string, quantity: number) => {
    setCart((current) => current
      .map((item) => item.lineId === lineId ? { ...item, quantity } : item)
      .filter((item) => item.quantity > 0));
  };

  const editLine = (lineId: string) => {
    const item = cart.find((candidate) => candidate.lineId === lineId);
    if (item) setConfigurator({ product: item.product, lineId });
  };

  const submitOrder = async () => {
    if (!menu || cart.length === 0 || submitting) return;
    const checkoutAction = resolveKitchenSelfOrderCheckoutAction(
      menu.policies.checkoutMode,
      menu.policies.kitchenReleasePolicy,
    );
    if (checkoutAction === 'REQUIRE_TERMINAL') {
      setStep('terminal');
      return;
    }

    setSubmitting(true);
    setCustomerError(null);
    try {
      const result = await window.electronAPI?.kitchenSelfOrder?.submit?.({
        customerLanguage: language,
        fulfillmentType: fulfillment,
        items: cart.map((item) => ({
          variantId: item.product.id,
          productId: item.product.templateId,
          name: item.product.name,
          quantity: item.quantity,
          unitPriceGrosze: item.product.priceGrosze + modifierTotal(item),
          note: sanitizeKitchenSelfOrderNote(item.note),
          modifiers: item.modifiers,
        })),
      });
      setSubmitResult(result || { success: false, error: 'no_response' });
      if (result?.success) {
        setCart([]);
        setStep('done');
      } else {
        setCustomerError(t.submitError);
      }
    } catch {
      setCustomerError(t.submitError);
    } finally {
      setSubmitting(false);
    }
  };

  const themeStyle = {
    '--kso-accent': menu?.brand.accentColor || '#DA7756',
  } as React.CSSProperties;

  if (step === 'review') {
    return (
      <KioskShell style={themeStyle}>
        <ReviewScreen
          cart={cart}
          fulfillment={fulfillment}
          fulfillmentOptions={menu?.policies.fulfillmentOptions || ['DINE_IN', 'TAKEAWAY']}
          language={language}
          t={t}
          total={cartTotal(cart)}
          submitting={submitting}
          error={customerError}
          onBack={() => setStep('menu')}
          onEdit={editLine}
          onQuantity={updateQuantity}
          onSubmit={submitOrder}
          onFulfillment={setFulfillment}
          onLanguage={setLanguage}
        />
        {configurator && menu && (
          <ProductConfigurator
            key={`${configurator.product.id}:${configurator.lineId || 'new'}`}
            product={configurator.product}
            groups={groupsForProduct(configurator.product)}
            initialItem={configurator.lineId
              ? cart.find((item) => item.lineId === configurator.lineId) || null
              : null}
            language={language}
            t={t}
            onCancel={() => setConfigurator(null)}
            onSave={(modifiers, note) => saveConfiguredItem(
              configurator.product,
              modifiers,
              note,
              configurator.lineId,
            )}
          />
        )}
      </KioskShell>
    );
  }

  if (step === 'terminal') {
    return (
      <KioskShell style={themeStyle}>
        <div className="flex h-full items-center justify-center p-8">
          <div className="w-full max-w-2xl text-center">
            <div className="mx-auto flex h-24 w-24 items-center justify-center rounded-3xl bg-amber-50 text-amber-800">
              <CircleAlert size={50} />
            </div>
            <h1 className="mt-7 text-4xl font-black text-[var(--sc-ink)]">{t.terminalTitle}</h1>
            <p className="mx-auto mt-4 max-w-xl text-xl font-semibold leading-8 text-[var(--sc-muted)]">
              {t.terminalBody}
            </p>
            <button
              type="button"
              onClick={() => setStep('review')}
              className="kso-primary-button mt-8 min-w-[320px]"
            >
              <ArrowLeft size={24} />
              {t.returnReview}
            </button>
          </div>
        </div>
      </KioskShell>
    );
  }

  if (step === 'done') {
    const orderNumber = submitResult?.orderNumber || 'K----';
    const completionText = menu?.policies.checkoutMode === 'PAY_AT_COUNTER'
      ? t.payAtCounter
      : t.keepNumber;
    return (
      <KioskShell style={themeStyle}>
        <div className="mx-auto flex h-full max-w-4xl flex-col items-center justify-center gap-6 px-8 text-center">
          <div className="flex h-20 w-20 items-center justify-center rounded-3xl bg-emerald-50 text-[var(--sc-success)]">
            <Check size={46} strokeWidth={3} />
          </div>
          <div>
            <div className="text-2xl font-black text-[var(--sc-muted)]">{t.doneTitle}</div>
            <div className="mt-3 rounded-3xl bg-[var(--sc-ink)] px-14 py-7 text-7xl font-black text-white">
              {orderNumber}
            </div>
            <p className="mx-auto mt-5 max-w-2xl text-2xl font-bold text-[var(--sc-ink)]">
              {completionText}
            </p>
          </div>
          <button type="button" onClick={resetSession} className="kso-primary-button min-w-[280px]">
            <Home size={24} />
            {t.newOrder}
          </button>
          <div className="text-base font-bold text-[var(--sc-muted)]">
            {t.autoReset} {resetCountdown} {t.seconds}
          </div>
        </div>
      </KioskShell>
    );
  }

  return (
    <KioskShell style={themeStyle}>
      <div className="grid h-full grid-cols-[minmax(0,1fr)_320px] gap-3 p-3">
        <main className="grid min-h-0 grid-rows-[64px_52px_1fr] gap-3">
          <header className="flex min-w-0 items-center justify-between gap-4">
            <BrandHeader menu={menu} menuLabel={t.menu} />
            <div className="flex shrink-0 items-center gap-2">
              <FulfillmentToggle
                t={t}
                fulfillment={fulfillment}
                options={menu?.policies.fulfillmentOptions || ['DINE_IN', 'TAKEAWAY']}
                onChange={setFulfillment}
              />
              <LanguageToggle language={language} onChange={setLanguage} />
            </div>
          </header>

          <div className="flex min-w-0 gap-3">
            <div className="flex min-w-0 flex-1 gap-2 overflow-x-auto">
              <CategoryButton
                label={t.all}
                active={!activeCategoryId}
                onClick={() => setActiveCategoryId(null)}
              />
              {(menu?.categories || []).map((category) => (
                <CategoryButton
                  key={category.id}
                  label={localizedName(category, language)}
                  active={activeCategoryId === category.id}
                  onClick={() => setActiveCategoryId(category.id)}
                />
              ))}
            </div>
            <label className="flex h-[52px] w-[270px] shrink-0 items-center gap-3 rounded-lg border border-[var(--sc-border)] bg-white px-4">
              <Search size={21} className="text-[var(--sc-muted)]" />
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder={t.search}
                className="h-full min-w-0 flex-1 bg-transparent text-base font-bold text-[var(--sc-ink)] outline-none placeholder:text-[var(--sc-muted)]"
              />
            </label>
          </div>

          <div className="min-h-0 overflow-y-auto pr-1">
            {loadingMenu ? (
              <EmptyState label={t.loading} />
            ) : visibleProducts.length === 0 ? (
              <EmptyState label={t.noProducts} />
            ) : (
              <div className="kso-product-grid">
                {visibleProducts.map((product) => (
                  <ProductCard
                    key={product.id}
                    product={product}
                    language={language}
                    onOpen={openProduct}
                  />
                ))}
              </div>
            )}
          </div>
        </main>

        <CartPanel
          cart={cart}
          language={language}
          t={t}
          onEdit={editLine}
          onQuantity={updateQuantity}
          onReview={() => setStep('review')}
        />
      </div>

      {configurator && menu && (
        <ProductConfigurator
          key={`${configurator.product.id}:${configurator.lineId || 'new'}`}
          product={configurator.product}
          groups={groupsForProduct(configurator.product)}
          initialItem={configurator.lineId
            ? cart.find((item) => item.lineId === configurator.lineId) || null
            : null}
          language={language}
          t={t}
          onCancel={() => setConfigurator(null)}
          onSave={(modifiers, note) => saveConfiguredItem(
            configurator.product,
            modifiers,
            note,
            configurator.lineId,
          )}
        />
      )}
    </KioskShell>
  );
}

function KioskShell({
  children,
  style,
}: {
  children: React.ReactNode;
  style: React.CSSProperties;
}) {
  return (
    <div className="sc-shell kso-shell h-full overflow-hidden" style={style}>
      {children}
    </div>
  );
}

function BrandHeader({
  menu,
  menuLabel,
}: {
  menu: KitchenSelfOrderMenu | null;
  menuLabel: string;
}) {
  return (
    <div className="flex min-w-0 items-center gap-3">
      {menu?.brand.logoUrl ? (
        <img
          src={menu.brand.logoUrl}
          alt=""
          className="h-12 w-12 shrink-0 rounded-lg object-contain"
          onError={(event) => { event.currentTarget.style.display = 'none'; }}
        />
      ) : (
        <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-lg bg-[var(--kso-accent)] text-lg font-black text-white">
          {(menu?.brand.name || 'Z').slice(0, 1).toUpperCase()}
        </div>
      )}
      <div className="min-w-0">
        <div className="truncate text-xs font-black uppercase tracking-[0.14em] text-[var(--sc-muted)]">
          {menu?.brand.name || 'Zira POS'}
        </div>
        <h1 className="truncate text-3xl font-black leading-tight text-[var(--sc-ink)]">
          {menuLabel}
        </h1>
      </div>
    </div>
  );
}

function EmptyState({ label }: { label: string }) {
  return (
    <div className="flex h-full min-h-[240px] items-center justify-center rounded-lg border border-[var(--sc-border)] bg-white text-xl font-bold text-[var(--sc-muted)]">
      {label}
    </div>
  );
}

function FulfillmentToggle({
  t,
  fulfillment,
  options,
  onChange,
}: {
  t: CopyText;
  fulfillment: KitchenSelfOrderFulfillment;
  options: KitchenSelfOrderFulfillment[];
  onChange: (value: KitchenSelfOrderFulfillment) => void;
}) {
  const labels: Record<KitchenSelfOrderFulfillment, string> = {
    DINE_IN: t.dineIn,
    TAKEAWAY: t.takeaway,
  };
  return (
    <div className="flex rounded-lg border border-[var(--sc-border)] bg-white p-1">
      {options.map((value) => (
        <button
          key={value}
          type="button"
          onClick={() => onChange(value)}
          className={`min-h-[48px] rounded-md px-4 text-sm font-black ${
            fulfillment === value
              ? 'bg-[var(--sc-ink)] text-white'
              : 'text-[var(--sc-muted)]'
          }`}
        >
          {labels[value]}
        </button>
      ))}
    </div>
  );
}

function LanguageToggle({
  language,
  onChange,
}: {
  language: KitchenSelfOrderLanguage;
  onChange: (value: KitchenSelfOrderLanguage) => void;
}) {
  return (
    <div className="flex rounded-lg border border-[var(--sc-border)] bg-white p-1">
      {([
        ['pl', 'PL'],
        ['vi', 'VI'],
        ['en', 'EN'],
      ] as const).map(([value, label]) => (
        <button
          key={value}
          type="button"
          onClick={() => onChange(value)}
          className={`min-h-[48px] min-w-[48px] rounded-md px-2 text-sm font-black ${
            language === value
              ? 'bg-[var(--kso-accent)] text-white'
              : 'text-[var(--sc-muted)]'
          }`}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

function CategoryButton({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`h-[52px] shrink-0 rounded-lg border px-5 text-base font-black ${
        active
          ? 'border-[var(--sc-ink)] bg-[var(--sc-ink)] text-white'
          : 'border-[var(--sc-border)] bg-white text-[var(--sc-ink)]'
      }`}
    >
      {label}
    </button>
  );
}

function ProductCard({
  product,
  language,
  onOpen,
}: {
  product: KitchenSelfOrderMenuProduct;
  language: KitchenSelfOrderLanguage;
  onOpen: (product: KitchenSelfOrderMenuProduct) => void;
}) {
  const name = localizedName(product, language);
  return (
    <button
      type="button"
      onClick={() => onOpen(product)}
      className="kso-product-card sc-focusable group"
    >
      <ProductImage product={product} name={name} className="kso-product-media" />
      <div className="grid min-h-0 flex-1 grid-rows-[44px_48px] px-4 pb-3 pt-3">
        <div className="line-clamp-2 text-base font-black leading-[1.35] text-[var(--sc-ink)]">
          {name}
        </div>
        <div className="flex items-end justify-between gap-3">
          <div className="text-lg font-black text-[var(--sc-ink)]">
            {formatPLN(product.priceGrosze)}
          </div>
          <span
            aria-hidden="true"
            className="flex h-12 w-12 shrink-0 items-center justify-center rounded-lg bg-[var(--kso-accent)] text-white transition-transform group-active:scale-95"
          >
            <Plus size={23} strokeWidth={3} />
          </span>
        </div>
      </div>
    </button>
  );
}

function ProductImage({
  product,
  name,
  className,
}: {
  product: KitchenSelfOrderMenuProduct;
  name: string;
  className: string;
}) {
  const [failed, setFailed] = useState(false);
  if (!product.media.url || failed) {
    return (
      <div className={`${className} flex items-center justify-center bg-[var(--sc-surface-muted)] text-[var(--sc-muted)]`}>
        <ImageIcon size={42} />
      </div>
    );
  }
  const focal = product.media.focalPoint || { x: 0.5, y: 0.5 };
  return (
    <div className={`${className} overflow-hidden bg-[var(--sc-surface-muted)]`}>
      <img
        src={product.media.url}
        alt={name}
        loading="lazy"
        decoding="async"
        onError={() => setFailed(true)}
        className="h-full w-full"
        style={{
          objectFit: product.media.fit === 'COVER' ? 'cover' : 'contain',
          objectPosition: `${focal.x * 100}% ${focal.y * 100}%`,
          transform: `scale(${product.media.zoom})`,
        }}
      />
    </div>
  );
}

function CartPanel({
  cart,
  language,
  t,
  onEdit,
  onQuantity,
  onReview,
}: {
  cart: CartItem[];
  language: KitchenSelfOrderLanguage;
  t: CopyText;
  onEdit: (lineId: string) => void;
  onQuantity: (lineId: string, quantity: number) => void;
  onReview: () => void;
}) {
  const count = cart.reduce((sum, item) => sum + item.quantity, 0);
  return (
    <aside className="grid min-h-0 grid-rows-[64px_1fr_auto] rounded-lg border border-[var(--sc-border)] bg-white">
      <div className="flex items-center justify-between border-b border-[var(--sc-border)] px-4">
        <h2 className="flex items-center gap-2 text-xl font-black text-[var(--sc-ink)]">
          <ShoppingCart size={23} />
          {t.cart}
        </h2>
        <span className="flex h-8 min-w-8 items-center justify-center rounded-full bg-[var(--sc-primary-soft)] px-2 text-sm font-black text-[var(--sc-primary-deep)]">
          {count}
        </span>
      </div>
      <div className="min-h-0 overflow-y-auto p-3">
        {cart.length === 0 ? (
          <div className="flex min-h-[180px] items-center justify-center rounded-lg bg-[var(--sc-surface-muted)] px-4 text-center text-base font-bold text-[var(--sc-muted)]">
            {t.emptyCart}
          </div>
        ) : (
          <div className="space-y-3">
            {cart.map((item) => (
              <CartLine
                key={item.lineId}
                item={item}
                language={language}
                t={t}
                onEdit={onEdit}
                onQuantity={onQuantity}
              />
            ))}
          </div>
        )}
      </div>
      <div className="border-t border-[var(--sc-border)] p-3">
        <div className="mb-3 flex items-end justify-between">
          <span className="text-sm font-black uppercase tracking-wide text-[var(--sc-muted)]">
            {t.subtotal}
          </span>
          <span className="text-2xl font-black text-[var(--sc-ink)]">
            {formatPLN(cartTotal(cart))}
          </span>
        </div>
        <button
          type="button"
          disabled={cart.length === 0}
          onClick={onReview}
          className="kso-primary-button w-full"
        >
          <Check size={22} />
          {t.reviewOrder}
        </button>
      </div>
    </aside>
  );
}

function CartLine({
  item,
  language,
  t,
  onEdit,
  onQuantity,
}: {
  item: CartItem;
  language: KitchenSelfOrderLanguage;
  t: CopyText;
  onEdit: (lineId: string) => void;
  onQuantity: (lineId: string, quantity: number) => void;
}) {
  const labels = formatKitchenSelfOrderModifierLabels(item.modifiers);
  const editable = item.product.noteEnabled || item.product.modifierGroupAttachmentIds.length > 0;
  return (
    <div className="rounded-lg border border-[var(--sc-border)] p-3">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="text-base font-black leading-snug text-[var(--sc-ink)]">
            {localizedName(item.product, language)}
          </div>
          {labels.length > 0 && (
            <div className="mt-1 text-sm font-semibold leading-5 text-[var(--sc-muted)]">
              {labels.join(' · ')}
            </div>
          )}
        </div>
        {editable && (
          <button
            type="button"
            onClick={() => onEdit(item.lineId)}
            aria-label={t.edit}
            className="flex h-12 w-12 shrink-0 items-center justify-center rounded-lg text-[var(--sc-muted)] hover:bg-[var(--sc-surface-muted)]"
          >
            <Pencil size={18} />
          </button>
        )}
      </div>
      <div className="mt-3 flex items-center justify-between gap-3">
        <QuantityControl
          quantity={item.quantity}
          onChange={(quantity) => onQuantity(item.lineId, quantity)}
        />
        <div className="text-base font-black text-[var(--sc-ink)]">
          {formatPLN(lineTotal(item))}
        </div>
      </div>
    </div>
  );
}

function QuantityControl({
  quantity,
  onChange,
}: {
  quantity: number;
  onChange: (quantity: number) => void;
}) {
  return (
    <div className="flex items-center gap-1">
      <button
        type="button"
        onClick={() => onChange(quantity - 1)}
        className="flex h-12 w-12 items-center justify-center rounded-lg border border-[var(--sc-border)] bg-[var(--sc-surface-muted)]"
      >
        <Minus size={18} />
      </button>
      <div className="w-9 text-center text-lg font-black">{quantity}</div>
      <button
        type="button"
        onClick={() => onChange(normalizeKitchenSelfOrderQuantity(quantity + 1))}
        className="flex h-12 w-12 items-center justify-center rounded-lg border border-[var(--sc-border)] bg-[var(--sc-surface-muted)]"
      >
        <Plus size={18} />
      </button>
    </div>
  );
}

function ProductConfigurator({
  product,
  groups,
  initialItem,
  language,
  t,
  onCancel,
  onSave,
}: {
  product: KitchenSelfOrderMenuProduct;
  groups: KitchenSelfOrderModifierGroup[];
  initialItem: CartItem | null;
  language: KitchenSelfOrderLanguage;
  t: CopyText;
  onCancel: () => void;
  onSave: (modifiers: KitchenSelfOrderModifierSnapshot[], note: string) => void;
}) {
  const [modifiers, setModifiers] = useState<KitchenSelfOrderModifierSnapshot[]>(
    initialItem?.modifiers || defaultModifiers(groups),
  );
  const [note, setNote] = useState(initialItem?.note || '');
  const validation = validateKitchenSelfOrderModifierSelections(groups, modifiers);

  const toggleOption = (
    group: KitchenSelfOrderModifierGroup,
    optionId: string,
  ) => {
    const option = group.options.find((candidate) => candidate.id === optionId);
    if (!option || !option.isAvailable) return;
    const existing = modifiers.find((modifier) =>
      modifier.groupId === group.id && modifier.optionId === option.id);
    const snapshot: KitchenSelfOrderModifierSnapshot = {
      groupId: group.id,
      groupName: group.name,
      optionId: option.id,
      optionName: option.name,
      quantity: 1,
      priceDeltaGrosze: option.priceDeltaGrosze,
    };

    if (group.selectionMode === 'SINGLE') {
      setModifiers((current) => [
        ...current.filter((modifier) => modifier.groupId !== group.id),
        snapshot,
      ]);
      return;
    }
    if (existing) {
      setModifiers((current) => current.filter((modifier) =>
        !(modifier.groupId === group.id && modifier.optionId === option.id)));
      return;
    }
    const selectedCount = modifiers.filter((modifier) => modifier.groupId === group.id).length;
    if (selectedCount >= group.maxSelections) return;
    setModifiers((current) => [...current, snapshot]);
  };

  const setOptionQuantity = (
    group: KitchenSelfOrderModifierGroup,
    optionId: string,
    quantity: number,
  ) => {
    const option = group.options.find((candidate) => candidate.id === optionId);
    const max = Math.max(1, Number(option?.maxQuantity) || 9);
    setModifiers((current) => current.map((modifier) =>
      modifier.groupId === group.id && modifier.optionId === optionId
        ? { ...modifier, quantity: Math.min(max, Math.max(1, quantity)) }
        : modifier));
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/55 p-5">
      <div
        role="dialog"
        aria-modal="true"
        className="grid max-h-[94vh] w-full max-w-6xl grid-cols-[340px_minmax(0,1fr)] overflow-hidden rounded-xl bg-white shadow-2xl"
      >
        <div className="border-r border-[var(--sc-border)] bg-[var(--sc-surface-muted)] p-5">
          <ProductImage
            product={product}
            name={localizedName(product, language)}
            className="aspect-[4/3] w-full rounded-lg"
          />
          <h2 className="mt-5 text-2xl font-black leading-tight text-[var(--sc-ink)]">
            {localizedName(product, language)}
          </h2>
          <div className="mt-2 text-2xl font-black text-[var(--sc-primary-deep)]">
            {formatPLN(product.priceGrosze + validation.modifierTotalGrosze)}
          </div>
        </div>

        <div className="grid min-h-0 grid-rows-[64px_1fr_auto]">
          <div className="flex items-center justify-between border-b border-[var(--sc-border)] px-5">
            <div className="text-lg font-black text-[var(--sc-ink)]">
              {initialItem ? t.edit : t.add}
            </div>
            <button
              type="button"
              onClick={onCancel}
              aria-label={t.cancel}
              className="flex h-12 w-12 items-center justify-center rounded-lg border border-[var(--sc-border)]"
            >
              <X size={22} />
            </button>
          </div>

          <div className="min-h-0 overflow-y-auto p-5">
            <div className="space-y-6">
              {groups.map((group) => {
                const selected = modifiers.filter((modifier) => modifier.groupId === group.id);
                const hasError = selected.length < group.minSelections;
                return (
                  <section key={group.id}>
                    <div className="mb-3 flex items-end justify-between gap-4">
                      <div>
                        <h3 className="text-xl font-black text-[var(--sc-ink)]">
                          {localizedName(group, language)}
                        </h3>
                        <div className={`mt-1 text-sm font-bold ${hasError ? 'text-[var(--sc-danger)]' : 'text-[var(--sc-muted)]'}`}>
                          {group.minSelections > 0 ? t.required : t.optional}
                          {group.maxSelections > 1 ? ` · ${t.chooseUpTo} ${group.maxSelections}` : ''}
                        </div>
                      </div>
                    </div>
                    <div className="grid grid-cols-2 gap-3">
                      {group.options.filter((option) => option.isAvailable).map((option) => {
                        const selection = selected.find((modifier) => modifier.optionId === option.id);
                        return (
                          <div
                            key={option.id}
                            className={`min-h-[64px] rounded-lg border-2 p-3 ${
                              selection
                                ? 'border-[var(--kso-accent)] bg-[var(--sc-primary-soft)]'
                                : 'border-[var(--sc-border)] bg-white'
                            }`}
                          >
                            <button
                              type="button"
                              onClick={() => toggleOption(group, option.id)}
                              className="flex w-full items-center justify-between gap-3 text-left"
                            >
                              <span className="font-black text-[var(--sc-ink)]">
                                {localizedName(option, language)}
                              </span>
                              <span className="shrink-0 font-black text-[var(--sc-primary-deep)]">
                                {option.priceDeltaGrosze > 0
                                  ? `+${formatPLN(option.priceDeltaGrosze)}`
                                  : ''}
                              </span>
                            </button>
                            {selection && group.allowOptionQuantity && (
                              <div className="mt-3 flex justify-end">
                                <QuantityControl
                                  quantity={selection.quantity}
                                  onChange={(quantity) =>
                                    setOptionQuantity(group, option.id, quantity)}
                                />
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </section>
                );
              })}

              {product.noteEnabled && (
                <label className="block">
                  <span className="text-lg font-black text-[var(--sc-ink)]">{t.note}</span>
                  <textarea
                    value={note}
                    maxLength={180}
                    onChange={(event) => setNote(event.target.value)}
                    className="mt-3 min-h-[96px] w-full resize-none rounded-lg border border-[var(--sc-border)] bg-[var(--sc-surface-muted)] p-4 text-base font-semibold outline-none focus:border-[var(--kso-accent)]"
                  />
                </label>
              )}
            </div>
          </div>

          <div className="flex items-center justify-end gap-3 border-t border-[var(--sc-border)] p-4">
            <button type="button" onClick={onCancel} className="kso-secondary-button">
              {t.cancel}
            </button>
            <button
              type="button"
              disabled={!validation.valid}
              onClick={() => onSave(validation.modifiers, note)}
              className="kso-primary-button min-w-[240px]"
            >
              <Check size={22} />
              {initialItem ? t.save : t.add}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function ReviewScreen({
  cart,
  fulfillment,
  fulfillmentOptions,
  language,
  t,
  total,
  submitting,
  error,
  onBack,
  onEdit,
  onQuantity,
  onSubmit,
  onFulfillment,
  onLanguage,
}: {
  cart: CartItem[];
  fulfillment: KitchenSelfOrderFulfillment;
  fulfillmentOptions: KitchenSelfOrderFulfillment[];
  language: KitchenSelfOrderLanguage;
  t: CopyText;
  total: number;
  submitting: boolean;
  error: string | null;
  onBack: () => void;
  onEdit: (lineId: string) => void;
  onQuantity: (lineId: string, quantity: number) => void;
  onSubmit: () => void;
  onFulfillment: (value: KitchenSelfOrderFulfillment) => void;
  onLanguage: (value: KitchenSelfOrderLanguage) => void;
}) {
  return (
    <div className="grid h-full grid-rows-[68px_1fr] gap-4 p-4">
      <header className="flex items-center justify-between gap-4">
        <button type="button" onClick={onBack} className="kso-secondary-button">
          <ArrowLeft size={22} />
          {t.back}
        </button>
        <h1 className="text-3xl font-black text-[var(--sc-ink)]">{t.reviewTitle}</h1>
        <div className="flex items-center gap-2">
          <FulfillmentToggle
            t={t}
            fulfillment={fulfillment}
            options={fulfillmentOptions}
            onChange={onFulfillment}
          />
          <LanguageToggle language={language} onChange={onLanguage} />
        </div>
      </header>

      <div className="grid min-h-0 grid-cols-[minmax(0,1fr)_360px] gap-4">
        <div className="min-h-0 overflow-y-auto rounded-lg border border-[var(--sc-border)] bg-white p-4">
          <div className="space-y-3">
            {cart.map((item) => {
              const labels = formatKitchenSelfOrderModifierLabels(item.modifiers);
              return (
                <div
                  key={item.lineId}
                  className="grid grid-cols-[112px_minmax(0,1fr)_auto] items-center gap-4 rounded-lg border border-[var(--sc-border)] p-3"
                >
                  <ProductImage
                    product={item.product}
                    name={localizedName(item.product, language)}
                    className="h-24 w-28 rounded-lg"
                  />
                  <div className="min-w-0">
                    <div className="text-xl font-black leading-snug text-[var(--sc-ink)]">
                      {localizedName(item.product, language)}
                    </div>
                    {labels.length > 0 && (
                      <div className="mt-1 text-base font-semibold text-[var(--sc-muted)]">
                        {labels.join(' · ')}
                      </div>
                    )}
                    {item.note && (
                      <div className="mt-1 text-sm font-semibold text-[var(--sc-muted)]">
                        {item.note}
                      </div>
                    )}
                    <button
                      type="button"
                      onClick={() => onEdit(item.lineId)}
                      className="mt-2 inline-flex min-h-[48px] items-center gap-2 font-black text-[var(--sc-primary-deep)]"
                    >
                      <Pencil size={17} />
                      {t.edit}
                    </button>
                  </div>
                  <div className="flex flex-col items-end gap-3">
                    <div className="text-xl font-black text-[var(--sc-ink)]">
                      {formatPLN(lineTotal(item))}
                    </div>
                    <QuantityControl
                      quantity={item.quantity}
                      onChange={(quantity) => onQuantity(item.lineId, quantity)}
                    />
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        <aside className="flex flex-col rounded-lg border border-[var(--sc-border)] bg-white p-5">
          <div className="text-sm font-black uppercase tracking-wide text-[var(--sc-muted)]">
            {fulfillment === 'TAKEAWAY' ? t.takeaway : t.dineIn}
          </div>
          <div className="mt-5 flex items-end justify-between border-t border-[var(--sc-border)] pt-5">
            <span className="text-lg font-black text-[var(--sc-muted)]">{t.subtotal}</span>
            <span className="text-4xl font-black text-[var(--sc-ink)]">{formatPLN(total)}</span>
          </div>
          {error && (
            <div role="alert" className="mt-5 rounded-lg border border-red-200 bg-red-50 p-4 text-base font-bold text-[var(--sc-danger)]">
              {error}
            </div>
          )}
          <div className="mt-auto">
            <button
              type="button"
              disabled={cart.length === 0 || submitting}
              onClick={onSubmit}
              className="kso-primary-button w-full"
            >
              {submitting ? t.submitting : t.placeOrder}
              {!submitting && <ChevronRight size={24} />}
            </button>
          </div>
        </aside>
      </div>
    </div>
  );
}
