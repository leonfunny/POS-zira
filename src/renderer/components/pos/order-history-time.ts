export interface OrderTimestampRow {
  id: string;
  created_at: string;
}

export function parseOrderTimestampMs(value: string): number {
  const raw = String(value || '').trim();
  if (!raw) return 0;

  let normalized = raw.includes('T') ? raw : raw.replace(' ', 'T');
  if (/^\d{4}-\d{2}-\d{2}$/.test(normalized)) {
    normalized = `${normalized}T00:00:00Z`;
  } else if (!/(?:Z|[+-]\d{2}:?\d{2})$/.test(normalized)) {
    normalized += 'Z';
  }

  const ms = Date.parse(normalized);
  return Number.isFinite(ms) ? ms : 0;
}

export function compareOrdersByDisplayTimeDesc<T extends OrderTimestampRow>(a: T, b: T): number {
  const timestampDelta = parseOrderTimestampMs(b.created_at) - parseOrderTimestampMs(a.created_at);
  if (timestampDelta !== 0) return timestampDelta;

  const createdAtDelta = b.created_at.localeCompare(a.created_at);
  if (createdAtDelta !== 0) return createdAtDelta;

  return b.id.localeCompare(a.id);
}
