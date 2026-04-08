export const CUSTOMER_TOUCH_KEYBOARD_INSET_PX = 264;
export const CUSTOMER_TOUCH_KEYBOARD_SELECTOR = '[data-customer-display-touch-keyboard="true"]';
export const CUSTOMER_TOUCH_INPUT_SELECTOR = '[data-customer-display-text-input="true"]';

export function shouldDismissCustomerTouchKeyboard(target: Element | null): boolean {
  if (!target) return true;
  if (target.closest(CUSTOMER_TOUCH_KEYBOARD_SELECTOR)) return false;
  if (target.closest(CUSTOMER_TOUCH_INPUT_SELECTOR)) return false;
  return true;
}

export function getCustomerTouchKeyboardInset(target: string | null): number {
  return target ? CUSTOMER_TOUCH_KEYBOARD_INSET_PX : 0;
}
