// Display-name localization for catalog rows (products + categories).
//
// Contract ([[zira-catalog-localization-canonical-display-split]]):
// - `name` is canonical: receipts, fiscal payloads, and order lines MUST keep this exact string.
// - `name_translations` is display-only: drives in-app rendering for category pills,
//   product cards, search/scan toasts, and cart rows in the operator's chosen language.
// - Missing/empty translations fall back to canonical `name`, so a fully un-translated
//   catalog still renders correctly in any UI language.
//
// Storage: SQLite columns are TEXT (JSON-encoded). Use `parseTranslations` once
// when reading rows out of the DB or off the wire, then pass the parsed object
// to `resolveName` everywhere display is needed.

export type NameTranslations = Record<string, string>;

interface NamedRow {
  name?: string | null;
  name_translations?: NameTranslations | string | null;
  nameTranslations?: NameTranslations | string | null;
}

/**
 * Parse a `name_translations` value into a plain `{ lang: name }` map.
 * Accepts a pre-parsed object (pass-through), a JSON string, null, or undefined.
 * Returns `{}` for anything malformed so callers can safely spread/key it.
 */
export function parseTranslations(
  raw: NameTranslations | string | null | undefined,
): NameTranslations {
  if (!raw) return {};
  if (typeof raw === 'object') {
    const out: NameTranslations = {};
    for (const [k, v] of Object.entries(raw)) {
      if (typeof k === 'string' && typeof v === 'string' && v.trim() !== '') {
        out[k.toLowerCase()] = v;
      }
    }
    return out;
  }
  if (typeof raw !== 'string') return {};
  const trimmed = raw.trim();
  if (!trimmed || trimmed === '{}') return {};
  try {
    const parsed = JSON.parse(trimmed);
    return parsed && typeof parsed === 'object' ? parseTranslations(parsed) : {};
  } catch {
    return {};
  }
}

/**
 * Resolve a row's display name for a given UI language.
 * Looks up the row's translations map (parsing on demand if still raw) and
 * falls back to canonical `name` when no usable translation exists.
 *
 * Never returns an empty string when canonical `name` is non-empty — the
 * fallback is intentional so a missing PL/VI value still surfaces something
 * readable on receipts/screens during a partial rollout.
 */
export function resolveName(row: NamedRow | null | undefined, lang: string | null | undefined): string {
  if (!row) return '';
  const canonical = (row.name ?? '').trim();
  if (!lang) return canonical;
  const code = lang.toLowerCase();
  const raw = row.name_translations ?? row.nameTranslations ?? null;
  const translations = raw && typeof raw === 'object' && !Array.isArray(raw)
    ? raw as NameTranslations
    : parseTranslations(raw);
  const translated = translations[code];
  if (typeof translated === 'string' && translated.trim() !== '') return translated;
  return canonical;
}
