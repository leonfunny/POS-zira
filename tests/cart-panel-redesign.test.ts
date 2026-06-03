import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { translations, type Language } from '../src/renderer/i18n/translations';

const ROOT = path.resolve(__dirname, '..');
const APP = fs.readFileSync(path.join(ROOT, 'src/renderer/App.tsx'), 'utf8');
const CART = fs.readFileSync(path.join(ROOT, 'src/renderer/components/pos/Cart.tsx'), 'utf8');
const CART_ITEM = fs.readFileSync(path.join(ROOT, 'src/renderer/components/pos/CartItem.tsx'), 'utf8');
const TOUCH_KEYBOARD = fs.readFileSync(path.join(ROOT, 'src/renderer/components/shared/TouchKeyboard.tsx'), 'utf8');
const QUICK_ACTIONS = fs.readFileSync(path.join(ROOT, 'src/renderer/components/pos/templates/retail/QuickActions.tsx'), 'utf8');
const RETAIL_TEMPLATE = fs.readFileSync(path.join(ROOT, 'src/renderer/components/pos/templates/retail/RetailTemplate.tsx'), 'utf8');

const SUPPORTED_LANGUAGES: Language[] = ['en', 'vi', 'tr', 'zh', 'uk', 'ru', 'pl'];
const DISCOUNT_AND_KEYBOARD_KEYS = [
  'pos.numpad.discount',
  'pos.apply',
  'pos.cancel',
  'pos.discount.customValue',
  'pos.discount.roundDown',
  'pos.discount.clear',
  'keyboard.done',
  'keyboard.space',
];

describe('POS cart panel redesign', () => {
  it('shows unique item count and total quantity in the cart header', () => {
    expect(CART).toContain('totalQuantityStr');
    expect(CART).toContain("tOr('pos.cart.qty', 'Qty')");
    expect(CART).toContain('aria-hidden="true">–</span>');
  });

  it('puts product identity and line total before row actions', () => {
    const rendered = CART_ITEM.slice(CART_ITEM.indexOf('return ('));
    expect(rendered.indexOf('resolveName(item, lang)')).toBeLessThan(rendered.indexOf("tOr('pos.cart.printLabelShort', 'Print')"));
    expect(rendered.indexOf('{lineTotalText}')).toBeLessThan(rendered.indexOf("tOr('pos.cart.printLabelShort', 'Print')"));
  });

  it('shows unit price times quantity without repeating the line total calculation', () => {
    expect(CART_ITEM).toContain('unitPriceQtyText');
    expect(CART_ITEM).toContain('unitPriceText');
    expect(CART_ITEM).toContain('lineTotalText');
    expect(CART_ITEM).toContain('×');
    expect(CART_ITEM).not.toContain('= ${lineTotalText}');
  });

  it('keeps print and delete as explicit secondary actions', () => {
    expect(CART_ITEM).toContain("tOr('pos.cart.printLabelShort', 'Print')");
    expect(CART_ITEM).toContain("tOr('pos.cart.remove', 'Remove')");
    expect(CART_ITEM).not.toContain("tOr('pos.cart.editPriceShort', 'Price')");
  });

  it('keeps the primary checkout action as a high-priority PAY button', () => {
    expect(CART).toContain("tOr('pos.payCta', 'PAY')");
    expect(CART).toContain('bg-slate-950');
  });

  it('keeps retail quick actions operational and restores discount to the cart panel', () => {
    expect(QUICK_ACTIONS).toContain('overflow-x-auto whitespace-nowrap scrollbar-hide');
    expect(QUICK_ACTIONS).not.toContain('flex-wrap');
    expect(QUICK_ACTIONS).toContain("label={tOr('pos.holdCart', 'Hold')}");
    expect(QUICK_ACTIONS).toContain("label={tOr('pos.recallCart', 'Recall')}");
    expect(QUICK_ACTIONS).toContain("label={tOr('pos.history', 'History')}");
    expect(QUICK_ACTIONS).toContain("label={tOr('pos.quickAdd.camera', 'Camera')}");
    expect(QUICK_ACTIONS).toContain('pos.quickAdd.createProduct');
    expect(QUICK_ACTIONS).toContain('isCustomerDisplayOpen ? t(\'pos.displayOff\') : t(\'pos.displayOn\')');
    expect(QUICK_ACTIONS).not.toContain("label={tOr('pos.quickDiscount', 'Discount')}");
    expect(QUICK_ACTIONS).not.toContain('showDiscount');
    expect(QUICK_ACTIONS).not.toContain('cart/applyDiscount');
    expect(CART).toContain("tOr('pos.numpad.discount', 'Discount')");
    expect(CART).toContain('<DiscountPopup');
    expect(CART).toContain("const [customMode, setCustomMode] = useState<'fixed' | 'percentage'>('fixed')");
    expect(CART).toContain("const [customValue, setCustomValue] = useState('')");
    expect(CART).toContain('const customInputRef = useRef<HTMLInputElement | null>(null)');
    expect(CART).toContain('inputMode="decimal"');
    expect(CART).toContain('Math.max(0, Math.min(parseBufferGrosze(normalizedCustomValue), subtotal))');
    expect(CART).toContain('Math.max(0, Math.min(parsedCustomValue, 100))');
    expect(CART).toContain("if (customMode === 'percentage') onApplyPercent(customPercent)");
    expect(CART).toContain('else onApplyFixed(customFixedGrosze)');
    expect(CART).toContain("e.key === 'Enter' && canApplyCustom");
    expect(CART).toContain("tOr('pos.apply', 'Apply')");
    expect(CART).toContain('const TOUCH_KEYBOARD_HEIGHT_PX = 300');
    expect(CART).toContain('const [customInputFocused, setCustomInputFocused] = useState(false)');
    expect(CART).toContain('onFocus={handleCustomInputFocus}');
    expect(CART).toContain('onBlur={handleCustomInputBlur}');
    expect(CART).toContain('onPointerDown={(e) => handleCustomModePointerDown(e, \'fixed\')}');
    expect(CART).toContain('onPointerDown={(e) => handleCustomModePointerDown(e, \'percentage\')}');
    expect(CART).toContain('customInputRef.current?.focus()');
    expect(CART).toContain('style={{ top: dialogTop, maxHeight: dialogMaxHeight }}');
    expect(CART).toContain('calc((100vh - ${TOUCH_KEYBOARD_HEIGHT_PX}px) / 2)');
    expect(CART).toContain('calc(100vh - ${TOUCH_KEYBOARD_HEIGHT_PX}px - 24px)');
    expect(CART).toContain('overflow-y-auto p-4');
    expect(RETAIL_TEMPLATE).toContain('showOrderActionChips');
    expect(RETAIL_TEMPLATE).not.toContain('showOrderActionChips={false}');

    const cartCall = RETAIL_TEMPLATE.slice(
      RETAIL_TEMPLATE.indexOf('<Cart'),
      RETAIL_TEMPLATE.indexOf('/>', RETAIL_TEMPLATE.indexOf('<Cart')),
    );
    expect(cartCall).not.toContain('onHold=');
  });

  it('defines localized discount popup and touch keyboard labels', () => {
    for (const lang of SUPPORTED_LANGUAGES) {
      for (const key of DISCOUNT_AND_KEYBOARD_KEYS) {
        expect(translations[lang][key], `${lang}.${key}`).toBeTruthy();
      }
    }

    expect(TOUCH_KEYBOARD).toContain('doneLabel =');
    expect(TOUCH_KEYBOARD).toContain('spaceLabel =');
    expect(TOUCH_KEYBOARD).toContain('{doneLabel}');
    expect(TOUCH_KEYBOARD).toContain('{spaceLabel}');
    expect(APP).toContain('const keyboardLanguage = (activeTab === \'pos\' || activeTab === \'label\') ? posUiLanguage : appLanguage');
    expect(APP).toContain("doneLabel={keyboardT('keyboard.done')}");
    expect(APP).toContain("spaceLabel={keyboardT('keyboard.space')}");
  });
});
