export function containsProtectedCheckoutLine(value: unknown): boolean {
  return Array.isArray(value) && value.some((item: any) => Boolean(item?.billiard || item?.locked === true));
}

export function shouldPersistLegacyActiveCart(args: {
  items: unknown;
  hasDurableCheckout: boolean;
}): boolean {
  return Array.isArray(args.items)
    && args.items.length > 0
    && !args.hasDurableCheckout
    && !containsProtectedCheckoutLine(args.items);
}
