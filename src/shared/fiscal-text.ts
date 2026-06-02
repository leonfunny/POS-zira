const POLISH_FISCAL_CHARS = new Set([
  'ą', 'ć', 'ę', 'ł', 'ń', 'ó', 'ś', 'ź', 'ż',
  'Ą', 'Ć', 'Ę', 'Ł', 'Ń', 'Ó', 'Ś', 'Ź', 'Ż',
]);

const FISCAL_TEXT_REPLACEMENTS: Record<string, string> = {
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
    if (isAsciiPrintable(ch) || POLISH_FISCAL_CHARS.has(ch)) {
      out.push(ch);
      continue;
    }

    const replacement = FISCAL_TEXT_REPLACEMENTS[ch];
    if (replacement !== undefined) {
      out.push(replacement);
      continue;
    }

    const stripped = ch.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    for (const candidate of stripped) {
      if (isAsciiPrintable(candidate) || POLISH_FISCAL_CHARS.has(candidate)) {
        out.push(candidate);
      }
    }
  }

  return out.join('').replace(/\s+/g, ' ').trim();
}
