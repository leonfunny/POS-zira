/**
 * Money/decimal fields must NOT be <input type="number">: the POS touch
 * keyboard appends via the native value setter, and the HTML number-input
 * sanitizer rejects intermediate states like "21." (the value silently
 * becomes "" and the decimal key looks dead at the till). Text +
 * inputMode="decimal" + this sanitizer keeps both physical and virtual
 * keyboards working; parsing stays in parseMoneyToGrosze (accepts ',' and '.').
 */
export function sanitizeDecimalText(raw: string): string {
  let out = '';
  let separatorSeen = false;
  for (const ch of raw) {
    if (ch >= '0' && ch <= '9') {
      out += ch;
      continue;
    }
    if ((ch === '.' || ch === ',') && !separatorSeen) {
      out += ch;
      separatorSeen = true;
    }
  }
  return out;
}
