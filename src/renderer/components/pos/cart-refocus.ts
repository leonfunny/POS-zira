/**
 * Decides when a cart change may pull keyboard focus back to the POS search
 * bar (`pos:focus-search`).
 *
 * Every main-process state broadcast arrives through structured clone, so
 * `state.cart.items` is a NEW array on every dispatch — including ones that
 * never touched the cart (typing a NIP in the payment modal dispatches
 * `checkoutDraft/update` per keystroke). Refocusing on array identity alone
 * therefore stole focus from the NIP field after each hardware keystroke
 * (2026-08-27). Compare by content and never yank focus from another field
 * or from an open payment modal.
 */

export interface CartItemLike {
  id: string;
  quantity: number;
  price: number;
}

export function cartItemsSignature(items: readonly CartItemLike[]): string {
  return items.map((item) => `${item.id}:${item.quantity}:${item.price}`).join('|');
}

export interface RefocusContext {
  previousSignature: string;
  nextSignature: string;
  paymentOpen: boolean;
  activeTag: string | null;
  activeId: string | null;
}

export function shouldRefocusSearchAfterCartChange(ctx: RefocusContext): boolean {
  if (ctx.previousSignature === ctx.nextSignature) return false;
  if (ctx.paymentOpen) return false;
  const typingElsewhere = (ctx.activeTag === 'INPUT' || ctx.activeTag === 'TEXTAREA')
    && ctx.activeId !== 'pos-product-search';
  return !typingElsewhere;
}
