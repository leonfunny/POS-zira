export type ParsedRange = { start: number; end: number } | 'unsatisfiable' | null;

export function parseRangeHeader(header: string | undefined, size: number): ParsedRange {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m) return null;
  const [, rawStart, rawEnd] = m;

  if (rawStart === '' && rawEnd === '') return null;

  // suffix: bytes=-N (last N bytes)
  if (rawStart === '') {
    const n = Number(rawEnd);
    if (!Number.isFinite(n) || n <= 0) return null;
    const start = Math.max(0, size - n);
    return { start, end: size - 1 };
  }

  const start = Number(rawStart);
  if (!Number.isInteger(start) || start < 0) return null;
  if (start >= size) return 'unsatisfiable';

  const end = rawEnd === '' ? size - 1 : Math.min(Number(rawEnd), size - 1);
  if (!Number.isInteger(end) || end < start) return null;
  return { start, end };
}
