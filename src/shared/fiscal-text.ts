export const ELZAB_FISCAL_ITEM_NAME_MAX = 40;

const FISCAL_TEXT_REPLACEMENTS: Record<string, string> = {
  '\u0105': 'a',
  '\u0107': 'c',
  '\u0119': 'e',
  '\u0142': 'l',
  '\u0144': 'n',
  '\u00f3': 'o',
  '\u015b': 's',
  '\u017a': 'z',
  '\u017c': 'z',
  '\u0104': 'A',
  '\u0106': 'C',
  '\u0118': 'E',
  '\u0141': 'L',
  '\u0143': 'N',
  '\u00d3': 'O',
  '\u015a': 'S',
  '\u0179': 'Z',
  '\u017b': 'Z',
  'đ': 'd',
  'Đ': 'D',
  'ß': 'ss',
};

function isAsciiPrintable(ch: string): boolean {
  const code = ch.charCodeAt(0);
  return code >= 0x20 && code <= 0x7e;
}

export function toFiscalSafeText(value: string): string {
  const out: string[] = [];

  for (const ch of String(value ?? '')) {
    if (/\s/.test(ch)) {
      out.push(' ');
      continue;
    }
    const replacement = FISCAL_TEXT_REPLACEMENTS[ch];
    if (replacement !== undefined) {
      out.push(replacement);
      continue;
    }
    if (isAsciiPrintable(ch)) {
      out.push(ch);
      continue;
    }

    const stripped = ch.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    for (const candidate of stripped) {
      const candidateReplacement = FISCAL_TEXT_REPLACEMENTS[candidate];
      if (candidateReplacement !== undefined) {
        out.push(candidateReplacement);
      } else if (isAsciiPrintable(candidate)) {
        out.push(candidate);
      }
    }
  }

  return out.join('').replace(/\s+/g, ' ').trim();
}

export function toFiscalSafeItemName(value: string): string {
  // Temporary ELZAB Zeta print-layout guard to avoid observed Opis: continuation.
  return toFiscalSafeText(value).slice(0, ELZAB_FISCAL_ITEM_NAME_MAX).trim();
}
