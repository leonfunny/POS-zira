// Pure helpers for the net <-> VAT <-> gross price calculator used by the
// product create/edit forms. Gross (price incl. VAT) is the stored source of
// truth (salon prices are gross); net is a convenience input derived from it.

export function parsePriceNumber(value: string): number | null {
  const normalized = String(value ?? '').trim().replace(',', '.');
  if (!normalized) return null;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function round2(value: number): string {
  return (Math.round(value * 100) / 100).toFixed(2);
}

/** gross = net * (1 + vat/100). Returns '' when inputs are invalid. */
export function grossFromNet(net: string, vat: string): string {
  const n = parsePriceNumber(net);
  const v = parsePriceNumber(vat);
  if (n === null || v === null) return '';
  return round2(n * (1 + v / 100));
}

/** net = gross / (1 + vat/100). Returns '' when inputs are invalid. */
export function netFromGross(gross: string, vat: string): string {
  const g = parsePriceNumber(gross);
  const v = parsePriceNumber(vat);
  if (g === null || v === null) return '';
  return round2(g / (1 + v / 100));
}
