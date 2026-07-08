/**
 * Internal EAN-13 minting for products without a manufacturer barcode
 * (homemade goods, services). Mirrors the backend generators
 * (MasterCatalogService.buildInternalEan / ProductQuickAddService) exactly:
 *
 *   "2" + <4-digit salon code> + <7 random digits> + <EAN-13 check digit>
 *
 * The GS1 "2x" prefix marks in-store codes; sharing the salon-code prefix
 * keeps POS-minted and /add-minted codes in one per-salon namespace.
 * The salon code arrives via product-admin capabilities (`salonCode`).
 */

export function ean13CheckDigit(twelveDigits: string): string {
  if (!/^\d{12}$/.test(twelveDigits)) {
    throw new Error('ean13CheckDigit expects exactly 12 digits');
  }
  let sum = 0;
  for (let i = 0; i < 12; i++) {
    const digit = parseInt(twelveDigits[i], 10);
    sum += i % 2 === 0 ? digit : digit * 3;
  }
  return ((10 - (sum % 10)) % 10).toString();
}

export function buildInternalEan(salonCode: string): string {
  if (!/^\d{4}$/.test(salonCode)) {
    throw new Error('buildInternalEan expects a 4-digit salon code');
  }
  let body = `2${salonCode}`;
  for (let i = 0; i < 7; i++) {
    body += Math.floor(Math.random() * 10).toString();
  }
  return body + ean13CheckDigit(body);
}

/**
 * Mint a code that is unique against the caller's catalog view. `isTaken`
 * must cover every code-bearing field the salon scans (barcode, ean, sku).
 * Collisions regenerate automatically; with 10^7 codes per salon the retry
 * budget is effectively never exhausted (returns null instead of looping
 * forever if it somehow is — callers surface an error).
 */
export function generateUniqueInternalEan(
  salonCode: string,
  isTaken: (ean: string) => boolean,
  maxAttempts = 50,
): string | null {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const candidate = buildInternalEan(salonCode);
    if (!isTaken(candidate)) return candidate;
  }
  return null;
}
