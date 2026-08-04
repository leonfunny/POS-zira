/**
 * PARITY GUARD 3/3 — the ORDER DTO the tablet sends to the backend.
 *
 * Guards 1/2 (preload surface) and 2/2 (shell props) compare the two shells.
 * Neither can see the third seam: Windows and Android each build their OWN
 * order DTO for the same backend endpoint, from the same `orders` row. When
 * Windows learns to send a new field, Android silently keeps sending the old
 * shape — and the backend, which cannot tell a tablet from a desktop, applies
 * whatever the payload says.
 *
 * That is exactly how the first real device settle failed on 2026-08-04:
 * Android's DTO omitted `billiardOrigin` + `clientAttemptId`, so the backend
 * created a plain POS order (POS260804-0001) instead of settling the frozen
 * checkout. The cashier saw the cart clear and the drawer open; the server kept
 * session ce99bb35 at paymentStatus=UNPAID with posOrderId=null. Money taken,
 * table still "running". No test could see it, because both DTOs typecheck as
 * Record<string, any>.
 *
 * So the guard is structural, not field-by-field: read the field names both
 * files actually assign, and require Android to cover Windows. Like the other
 * two guards the registry is two-way — a waiver for a field Android now sends
 * fails the build, so an entry cannot outlive the gap it documents.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '..');
const WINDOWS_SRC = join(ROOT, 'src/main/sync/order-sync.ts');
const ANDROID_SRC = join(ROOT, 'src/renderer/android-pos/shim/real-transport.ts');

/**
 * Fields Android is allowed not to send, each with the reason. NOT "ignore" —
 * an entry is a debt with a name on it.
 *
 * Empty: after the billiard identity landed, the tablet sends everything the
 * desktop does. The stale-waiver test below is what forces this back to empty
 * whenever a gap is closed.
 */
const KNOWN_DTO_GAPS: Record<string, string> = {};

/** Keys of the `const dto = { ... }` object literal, at literal top level only. */
function literalKeys(source: string): string[] {
  const start = source.search(/const dto(?::\s*Record<string,\s*any>)?\s*=\s*\{/);
  if (start === -1) return [];
  const open = source.indexOf('{', start);
  const keys: string[] = [];
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    const ch = source[i];
    if (ch === '{' || ch === '[' || ch === '(') depth++;
    else if (ch === '}' || ch === ']' || ch === ')') {
      depth--;
      if (depth === 0) break;
    } else if (depth === 1 && /[a-zA-Z]/.test(ch)) {
      const rest = source.slice(i);
      const m = /^([a-zA-Z][a-zA-Z0-9]*)\s*:/.exec(rest);
      if (m) {
        keys.push(m[1]);
        i += m[0].length - 1;
      }
    }
  }
  return keys;
}

/** Every field name the file assigns onto the DTO, from both syntaxes. */
function dtoFields(path: string): Set<string> {
  const source = readFileSync(path, 'utf8');
  const assigned = Array.from(source.matchAll(/\bdto\.([a-zA-Z][a-zA-Z0-9]*)\s*=/g)).map((m) => m[1]);
  return new Set([...literalKeys(source), ...assigned]);
}

describe('order DTO parity: Android tablet ↔ Windows desktop', () => {
  const windows = dtoFields(WINDOWS_SRC);
  const android = dtoFields(ANDROID_SRC);

  it('reads both DTOs (a rename that breaks extraction must fail loudly, not silently pass)', () => {
    // Without this, moving/renaming `dto` turns every assertion below into
    // "empty ⊆ empty" and the guard evaporates exactly when it is needed.
    expect(windows.size, `no DTO fields found in ${WINDOWS_SRC}`).toBeGreaterThan(10);
    expect(android.size, `no DTO fields found in ${ANDROID_SRC}`).toBeGreaterThan(10);
    for (const anchor of ['id', 'items', 'paymentMethod']) {
      expect(windows.has(anchor), `extractor missed ${anchor} on Windows`).toBe(true);
      expect(android.has(anchor), `extractor missed ${anchor} on Android`).toBe(true);
    }
  });

  it('sends every field the desktop sends, or has it waived with a reason', () => {
    const missing = [...windows].filter((f) => !android.has(f) && !KNOWN_DTO_GAPS[f]).sort();
    expect(
      missing,
      `The tablet omits these from its order DTO:\n  ${missing.join('\n  ')}\n` +
        'Add them in real-transport.ts buildOrderDto, or waive them in KNOWN_DTO_GAPS.',
    ).toEqual([]);
  });

  it('has no stale waivers (a gap that is now closed must be deleted)', () => {
    const closed = Object.keys(KNOWN_DTO_GAPS).filter((f) => android.has(f));
    expect(
      closed,
      `These are sent now — delete their KNOWN_DTO_GAPS entries:\n  ${closed.join('\n  ')}`,
    ).toEqual([]);
  });

  it('carries the billiard identity, the field pair whose absence took money without settling', () => {
    // Named explicitly and not just covered by the set comparison: this pair is
    // the difference between "session SETTLED" and "cashier paid, table still
    // running". A future waiver of these two must be a deliberate, visible act.
    expect(android.has('billiardOrigin')).toBe(true);
    expect(android.has('clientAttemptId')).toBe(true);
    expect(KNOWN_DTO_GAPS.billiardOrigin, 'billiard identity must never be waived').toBeUndefined();
    expect(KNOWN_DTO_GAPS.clientAttemptId, 'billiard identity must never be waived').toBeUndefined();
  });

  it('skips finishOrder for billiard orders on both platforms (double-finish is a false failure)', () => {
    // The billiard create endpoint atomically creates a DELIVERED order AND
    // settles the checkout (order-sync.ts:241-256). Calling finish again
    // returns "already finished", which a naive reader logs as a sync failure.
    const androidSrc = readFileSync(ANDROID_SRC, 'utf8');
    const windowsSrc = readFileSync(WINDOWS_SRC, 'utf8');
    for (const [name, src] of [['Android', androidSrc], ['Windows', windowsSrc]] as const) {
      const finishAt = src.indexOf('finishOrder(');
      expect(finishAt, `${name} no longer calls finishOrder`).toBeGreaterThan(-1);
      const guard = src.lastIndexOf('!order.billiard_origin_json', finishAt);
      expect(
        guard > -1 && finishAt - guard < 700,
        `${name} calls finishOrder without the billiard guard directly above it`,
      ).toBe(true);
    }
  });
});

describe('order LINE contract: one implementation, not two copies', () => {
  it('the shim re-exports the shared builder instead of defining its own', async () => {
    // Identity, not equivalence. A second implementation that merely looks the
    // same is how the `billiard` block went missing: the copy typechecked and
    // passed every local test, and only a real backend rejected it.
    const shared = await import('../src/shared/pos/order-line-contract');
    const shim = await import('../src/renderer/android-pos/shim/db/order-repo');
    const windows = await import('../src/main/pos/order-line-contract');
    expect(shim.buildBackendOrderItem).toBe(shared.buildBackendOrderItem);
    expect(windows.buildBackendOrderItem).toBe(shared.buildBackendOrderItem);
  });

  it('carries per-line billiard metadata, without which the backend refuses the whole settle', async () => {
    const { buildBackendOrderItem } = await import('../src/renderer/android-pos/shim/db/order-repo');
    const payload = buildBackendOrderItem({
      id: 'variant-1', variant_id: 'variant-1', price: 241, quantity: 1,
      billiard_json: JSON.stringify({
        lineKey: 'session-1:TIME', kind: 'TIME', sessionItemId: 'item-1',
        durationMinutes: 2, displayName: 'Bàn #2',
      }),
    } as any);
    // The exact rejection seen on device: "Every Billiard POS item requires
    // billiard metadata".
    expect(payload.billiard).toMatchObject({ lineKey: 'session-1:TIME', kind: 'TIME' });
  });

  it('refuses to ship a line whose persisted billiard metadata is corrupt', async () => {
    const { buildBackendOrderItem } = await import('../src/renderer/android-pos/shim/db/order-repo');
    expect(() => buildBackendOrderItem({ id: 'v', billiard_json: '{not json' } as any))
      .toThrow(/billiard order-line metadata/i);
  });
});
