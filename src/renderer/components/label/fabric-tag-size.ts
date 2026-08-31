/**
 * Working out which size a variant is.
 *
 * A style's sizes are ordinary variant rows sharing a `template_id`, and the
 * size lives in the variant's name because there is no size column to read.
 * The names are written by whoever created the products, so this is a guess --
 * which is why the caller shows the result in an editable field instead of
 * printing it unseen. A wrong guess is then a visible typo, not a garment
 * labelled XL that is actually S.
 */

/**
 * Separators a size is usually hung off: "Polo shirt - M", "Polo / XL".
 *
 * A slash only separates when it has space around it. Bare, it belongs to the
 * size itself -- S/M and 38/40 are single sizes, and splitting them printed
 * "M" onto garments that are S/M.
 */
const SEPARATORS = /[-–—|·,]|\s\/\s/;

/** A size is short. Anything longer is a description that got split badly. */
const MAX_SIZE_LENGTH = 6;

/**
 * Sizes that are worth recognising even when the name has no separator, so
 * "Polo XL" still resolves. Deliberately not exhaustive: an unknown token is
 * better left to the operator than guessed at.
 */
const KNOWN_SIZES = new Set([
  'XXS', 'XS', 'S', 'M', 'L', 'XL', 'XXL', 'XXXL', '2XL', '3XL', '4XL',
  'S/M', 'M/L', 'L/XL', 'ONE', 'OS',
]);

function isPlausibleSize(token: string): boolean {
  const upper = token.toUpperCase();
  if (KNOWN_SIZES.has(upper)) return true;
  // Numeric sizes: 38, 40, 42 ... and paired ones like 38/40.
  return /^\d{1,3}(\/\d{1,3})?$/.test(token);
}

/**
 * Best guess at the size encoded in `variantName`.
 *
 * Returns an empty string rather than a wrong answer when nothing looks like a
 * size: an empty field asks the operator to fill it in, whereas a confident
 * wrong guess gets printed.
 */
export function deriveSizeFromVariantName(variantName: string, styleName?: string): string {
  const name = String(variantName ?? '').trim();
  if (!name) return '';

  // When the style name is known and prefixes the variant, what remains is the
  // distinguishing part -- usually exactly the size.
  const style = String(styleName ?? '').trim();
  let candidate = name;
  if (style && name.toLowerCase().startsWith(style.toLowerCase())) {
    candidate = name.slice(style.length).trim();
  }

  const parts = candidate.split(SEPARATORS).map((part) => part.trim()).filter(Boolean);
  const tail = parts.length > 1 ? parts[parts.length - 1] : candidate;

  if (tail && tail.length <= MAX_SIZE_LENGTH && isPlausibleSize(tail)) return tail.toUpperCase();

  // No separator to lean on: look for a size-shaped word anywhere in the name.
  const words = candidate.split(/\s+/).filter(Boolean);
  for (let i = words.length - 1; i >= 0; i--) {
    if (isPlausibleSize(words[i])) return words[i].toUpperCase();
  }

  return '';
}

/**
 * Total tags a print run will produce. Kept separate so the button can say the
 * number before anything is committed to cloth.
 */
export function totalTagsToPrint(quantities: Record<string, number>): number {
  return Object.values(quantities).reduce((sum, value) => {
    const n = Number(value);
    return sum + (Number.isFinite(n) && n > 0 ? Math.floor(n) : 0);
  }, 0);
}
