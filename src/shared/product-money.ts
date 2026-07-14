/** PostgreSQL numeric(12,2): at most 9,999,999,999.99 PLN. */
export const PRODUCT_MONEY_MAX_GROSZE = 999_999_999_999;

export function isValidProductMoneyGrosze(
  value: unknown,
  options: { allowZero?: boolean } = {},
): value is number {
  return typeof value === 'number'
    && Number.isSafeInteger(value)
    && value <= PRODUCT_MONEY_MAX_GROSZE
    && (options.allowZero === false ? value > 0 : value >= 0);
}

export function parseProductMoneyInputToGrosze(
  value: string,
  options: { allowBlank?: boolean; allowZero?: boolean } = {},
): number | null | undefined {
  const normalized = String(value ?? '').trim().replace(',', '.');
  if (!normalized) return options.allowBlank ? null : undefined;
  if (!/^\d+(?:\.\d{0,2})?$/.test(normalized)) return undefined;
  const [wholeText, fractionText = ''] = normalized.split('.');
  const whole = Number(wholeText);
  const fraction = Number(fractionText.padEnd(2, '0') || '0');
  const grosze = whole * 100 + fraction;
  return isValidProductMoneyGrosze(grosze, { allowZero: options.allowZero })
    ? grosze
    : undefined;
}
