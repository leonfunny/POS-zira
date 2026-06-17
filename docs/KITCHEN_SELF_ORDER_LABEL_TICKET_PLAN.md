# Kitchen Self-Order Label & Ticket Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the 50x30 customer label print in the customer's language with a scannable recall QR, and make the kitchen ticket show modifiers per line + an item count — without backend/schema/routing changes.

**Architecture:** Two pure ESC-POS builders (`kitchen-ticket.ts`) and one ZPL builder (`zpl-formatter.ts`) consume a shared `KitchenTicketData`. We split modifiers out of `notes` at the adapter (`pos.module.ts`), render them per-line, add an item-count helper, give the label a dedicated no-notes `labelQrPayload`, deterministically ASCII-fold the label, and size its QR from the real payload via the `qrcode` dep.

**Tech Stack:** TypeScript, Electron main, ZPL (Zebra), ESC/POS thermal, `qrcode` lib, Vitest.

**Spec:** `docs/KITCHEN_SELF_ORDER_LABEL_TICKET_DESIGN.md` (v4).

**Execution environment:** Run tests/typecheck where `node_modules` exists (winpc `C:\POS-zira`, or any clone after `npm install`). Edits may be authored on the Netcup clone and pulled to winpc to run. Commands below use `npx vitest run <file>`.

---

## File Structure

| File | Responsibility | Change |
|------|----------------|--------|
| `src/shared/types.ts` | Shared print payload types | Add `KitchenTicketItem.modifiers?`, `KitchenTicketData.labelQrPayload?` |
| `src/main/printing/kitchen-ticket.ts` | ESC-POS builders for kitchen ticket + customer slips; `kitchenItemCount` helper | New helper; per-line modifiers + `!!` note + header count in two builders |
| `src/main/hardware/zebra/zpl-formatter.ts` | ZPL builder for the 50x30 label | i18n copy, deterministic ASCII fold, payload-aware adaptive QR |
| `src/main/modules/pos.module.ts` | Self-order adapter + QR payload builder + slip wiring | Split modifiers/notes; `includeNotes` option; attach `labelQrPayload` |
| `tests/kitchen-ticket.test.ts` | Builder unit tests | Update 2 assertions; add modifier/count tests |
| `tests/kitchen-payment-label.test.ts` (new) | ZPL label unit tests | i18n, ASCII fold, QR fit |
| `tests/kitchen-self-order-contract.test.ts` | Source-contract tests for `pos.module.ts` | Add adapter/payload-wiring assertions |

---

## Task 1: Shared types

**Files:**
- Modify: `src/shared/types.ts` (interfaces `KitchenTicketItem`, `KitchenTicketData`)

- [ ] **Step 1: Add `modifiers` to `KitchenTicketItem`**

In `src/shared/types.ts`, change the `KitchenTicketItem` interface so it reads:

```typescript
export interface KitchenTicketItem {
  name: string;
  quantity: number;
  /** kg for weighted items; null/'szt' renders as a plain count. */
  unit?: string | null;
  /** Readable modifier labels (e.g. "Đường: 50%"). Rendered one per line. */
  modifiers?: string[];
  /** Free-text customer note only (modifiers live in `modifiers`). */
  notes?: string | null;
  /** Customer payment slip only. Kitchen tickets must not render prices. */
  unitPriceGrosze?: number | null;
  lineTotalGrosze?: number | null;
}
```

- [ ] **Step 2: Add `labelQrPayload` to `KitchenTicketData`**

In the same file, inside `KitchenTicketData`, add the field right after the existing `qrPayload` line:

```typescript
  /** Optional customer-slip QR payload used by cashier POS to recall the cart. */
  qrPayload?: string | null;
  /** Compact (no-notes) QR for the LABEL printer only; smaller so it always
   *  fits/scan on a 50x30 label. Local-only — never sent over the shared route. */
  labelQrPayload?: string | null;
```

- [ ] **Step 3: Typecheck**

Run: `npx tsc -p tsconfig.main.json --noEmit`
Expected: no NEW errors referencing `types.ts` (adding optional fields is backward-compatible).

- [ ] **Step 4: Commit**

```bash
git add src/shared/types.ts
git commit -m "feat(types): add KitchenTicketItem.modifiers and KitchenTicketData.labelQrPayload"
```

---

## Task 2: `kitchenItemCount` helper

**Files:**
- Modify: `src/main/printing/kitchen-ticket.ts`
- Test: `tests/kitchen-ticket.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `tests/kitchen-ticket.test.ts` (and add `kitchenItemCount` to the existing import from `../src/main/printing/kitchen-ticket`):

```typescript
describe('kitchenItemCount', () => {
  it('sums piece quantities and counts weighted items as one', () => {
    expect(kitchenItemCount([{ name: 'a', quantity: 2 }, { name: 'b', quantity: 1 }])).toBe(3);
    expect(kitchenItemCount([{ name: 'a', quantity: 0.5, unit: 'kg' }])).toBe(1);
    expect(kitchenItemCount([
      { name: 'a', quantity: 2, unit: 'szt' },
      { name: 'b', quantity: 0.75, unit: 'kg' },
    ])).toBe(3);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/kitchen-ticket.test.ts -t kitchenItemCount`
Expected: FAIL — `kitchenItemCount is not a function` / import error.

- [ ] **Step 3: Implement the helper**

In `src/main/printing/kitchen-ticket.ts`, add this exported function just below the existing `formatQuantity` function:

```typescript
export function kitchenItemCount(items: KitchenTicketItem[]): number {
  return items.reduce((sum, item) => {
    const unit = (item.unit || '').trim().toLowerCase();
    const weighted = unit !== '' && unit !== 'szt' && unit !== 'pcs';
    return sum + (weighted ? 1 : Math.max(1, Math.round(Number(item.quantity) || 1)));
  }, 0);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/kitchen-ticket.test.ts -t kitchenItemCount`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/main/printing/kitchen-ticket.ts tests/kitchen-ticket.test.ts
git commit -m "feat(kitchen-ticket): add kitchenItemCount helper (weighted = 1)"
```

---

## Task 3: Kitchen ticket — per-line modifiers, `!!` note, header count

**Files:**
- Modify: `src/main/printing/kitchen-ticket.ts` (`buildKitchenTicketLines`)
- Test: `tests/kitchen-ticket.test.ts`

- [ ] **Step 1: Update existing assertions + add new test**

In `tests/kitchen-ticket.test.ts`:

1. Change the assertion on the base ticket note from:
   `expect(text).toContain('>> không hành');`
   to:
   `expect(text).toContain('!! không hành');`

2. Change the Vietnamese self-order note assertion from:
   `expect(text).toContain('Ghi chu: it cay');`
   to:
   `expect(text).toContain('!! it cay');`

3. Add this new test:

```typescript
it('renders each modifier on its own » line, the note on a !! line, and a header count', () => {
  const lines = buildKitchenTicketLines({
    ...baseTicket,
    kitchenLanguage: 'vi',
    items: [
      { name: 'Trà sữa', quantity: 2, modifiers: ['Đường: 50%', 'Đá: ít'], notes: 'ít đá giùm em' },
      { name: 'Chè thái', quantity: 1, modifiers: ['+ trân châu'] },
    ],
  });
  const text = lines.map((l) => l.text).join('\n');

  expect(text).toContain('» Đường: 50%');
  expect(text).toContain('» Đá: ít');
  expect(text).toContain('» + trân châu');
  expect(text).toContain('!! ít đá giùm em');
  expect(text).toContain('· 3 món'); // 2 + 1
});
```

- [ ] **Step 2: Run tests to verify failure**

Run: `npx vitest run tests/kitchen-ticket.test.ts`
Expected: FAIL — new `»`/`!!`/`· 3 món` assertions fail; updated `!!` assertions fail (still old `>>`/`Ghi chu:`).

- [ ] **Step 3: Implement the render change**

In `src/main/printing/kitchen-ticket.ts`, inside `buildKitchenTicketLines`, replace the time/source line and the item loop. Find:

```typescript
  lines.push({
    text: `${formatTimeHHMM(data.createdAt)}  ·  ${sourceLabel(data.source)}`,
    center: true,
  });
  lines.push({ text: '', separator: true });

  for (const item of data.items) {
    lines.push({
      text: `${formatQuantity(item)} ${item.name}`,
      bold: true,
      textSize: 'double-height',
    });
    const notes = (item.notes || '').trim();
    if (notes) {
      lines.push({ text: lang === 'vi' ? `   Ghi chu: ${notes}` : `   >> ${notes}` });
    }
  }
```

Replace with:

```typescript
  const count = kitchenItemCount(data.items);
  const itemWord = lang === 'vi' ? 'món' : lang === 'en' ? 'items' : 'poz.';
  lines.push({
    text: `${formatTimeHHMM(data.createdAt)}  ·  ${sourceLabel(data.source)}  ·  ${count} ${itemWord}`,
    center: true,
  });
  lines.push({ text: '', separator: true });

  for (const item of data.items) {
    lines.push({
      text: `${formatQuantity(item)} ${item.name}`,
      bold: true,
      textSize: 'double-height',
    });
    for (const modifier of item.modifiers || []) {
      const text = String(modifier || '').trim();
      if (text) lines.push({ text: `   » ${text}`, bold: true });
    }
    const notes = (item.notes || '').trim();
    if (notes) {
      lines.push({ text: `   !! ${notes}`, bold: true });
    }
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/kitchen-ticket.test.ts`
Expected: PASS (all kitchen-ticket tests).

- [ ] **Step 5: Commit**

```bash
git add src/main/printing/kitchen-ticket.ts tests/kitchen-ticket.test.ts
git commit -m "feat(kitchen-ticket): per-line modifiers, !! note, header item count"
```

---

## Task 4: Customer payment slip — render modifiers (avoid regression) + count

**Files:**
- Modify: `src/main/printing/kitchen-ticket.ts` (`buildKitchenPaymentSlipLines`)
- Test: `tests/kitchen-ticket.test.ts`

> Why: after Task 6 the adapter moves modifiers out of `notes`. The RECEIPT-mode slip
> (`buildKitchenPaymentSlipLines`) only renders `notes`, so it would lose modifiers unless updated.

- [ ] **Step 1: Write the failing test**

Append to `tests/kitchen-ticket.test.ts`:

```typescript
it('payment slip renders modifiers and note and shows an item count', () => {
  const lines = buildKitchenPaymentSlipLines({
    ...baseTicket,
    customerLanguage: 'vi',
    totalGrosze: 3400,
    items: [
      { name: 'Trà sữa', quantity: 2, unitPriceGrosze: 1200, modifiers: ['Đường: 50%'], notes: 'ít đá' },
    ],
  });
  const text = lines.map((l) => l.text).join('\n');

  expect(text).toContain('» Đường: 50%');
  expect(text).toContain('!! ít đá');
  expect(text).toContain('· 2 món');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/kitchen-ticket.test.ts -t "payment slip renders modifiers"`
Expected: FAIL — `»`/count not present (and note still uses `Ghi chu:`).

- [ ] **Step 3: Implement**

In `buildKitchenPaymentSlipLines`:

1. Add the count to the order-number/time line. Find:

```typescript
  lines.push({ text: `${orderNumberLabel(data.orderNumber)}  ·  ${formatTimeHHMM(data.createdAt)}`, center: true });
  lines.push({ text: '', separator: true });
```

Replace with:

```typescript
  const slipCount = kitchenItemCount(data.items);
  const slipItemWord = lang === 'vi' ? 'món' : lang === 'en' ? 'items' : 'poz.';
  lines.push({ text: `${orderNumberLabel(data.orderNumber)}  ·  ${formatTimeHHMM(data.createdAt)}  ·  ${slipCount} ${slipItemWord}`, center: true });
  lines.push({ text: '', separator: true });
```

2. Render modifiers + the `!!` note in the item loop. Find (inside `buildKitchenPaymentSlipLines`):

```typescript
    if (unitPrice > 0 && quantity > 1) {
      lines.push({ text: `   ${formatMoney(unitPrice)} / szt` });
    }
    const notes = (item.notes || '').trim();
    if (notes) {
      lines.push({ text: lang === 'vi' ? `   Ghi chu: ${notes}` : `   >> ${notes}` });
    }
```

Replace with:

```typescript
    if (unitPrice > 0 && quantity > 1) {
      lines.push({ text: `   ${formatMoney(unitPrice)} / szt` });
    }
    for (const modifier of item.modifiers || []) {
      const modifierText = String(modifier || '').trim();
      if (modifierText) lines.push({ text: `   » ${modifierText}` });
    }
    const notes = (item.notes || '').trim();
    if (notes) {
      lines.push({ text: `   !! ${notes}` });
    }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/kitchen-ticket.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/main/printing/kitchen-ticket.ts tests/kitchen-ticket.test.ts
git commit -m "feat(kitchen-ticket): payment slip renders modifiers + note + count"
```

---

## Task 5: 50x30 label — i18n, deterministic ASCII fold, adaptive QR

**Files:**
- Modify: `src/main/hardware/zebra/zpl-formatter.ts` (`formatKitchenPaymentLabel`, new helpers, import)
- Test: `tests/kitchen-payment-label.test.ts` (new)

- [ ] **Step 1: Write the failing tests**

Create `tests/kitchen-payment-label.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import QRCode from 'qrcode';
import { ZplFormatter } from '../src/main/hardware/zebra/zpl-formatter';
import type { KitchenTicketData } from '../src/shared/types';

const labelData: KitchenTicketData = {
  orderId: 'o-1',
  orderNumber: 'K-042',
  createdAt: '2026-06-17T12:23:00.000Z',
  source: 'KITCHEN_SELF_ORDER',
  fulfillmentType: 'TAKEAWAY',
  customerLanguage: 'vi',
  pickupNumber: 'K-042',
  brandName: 'Chè Sài Gòn',
  totalGrosze: 3400,
  qrPayload: 'KSO1:withnotes',
  labelQrPayload: 'KSO1:compact',
  items: [{ name: 'Chè', quantity: 3 }],
};

describe('formatKitchenPaymentLabel', () => {
  it('renders order number, count, total and fulfillment in the customer language', () => {
    const zpl = new ZplFormatter(50, 30).formatKitchenPaymentLabel(labelData);
    expect(zpl).toContain('K-042');
    expect(zpl).toContain('SO DON');   // vi order label, ASCII-folded
    expect(zpl).toContain('MANG DI');  // vi takeaway, ASCII
    expect(zpl).toContain('3 mon');    // count + vi word
    expect(zpl).toContain('34,00 zl');
  });

  it('uses labelQrPayload (compact), not qrPayload', () => {
    const zpl = new ZplFormatter(50, 30).formatKitchenPaymentLabel(labelData);
    expect(zpl).toContain('KSO1:compact');
    expect(zpl).not.toContain('KSO1:withnotes');
  });

  it('ASCII-folds Vietnamese deterministically regardless of textProfile', () => {
    for (const profile of ['zebra', 'ascii'] as const) {
      const zpl = new ZplFormatter(50, 30, 203, profile).formatKitchenPaymentLabel(labelData);
      expect(zpl).toContain('Che Sai Gon');     // brand folded
      expect(/[^\x00-\x7F]/.test(zpl)).toBe(false); // no non-ASCII byte anywhere
    }
  });

  it('keeps the QR within the label width for representative payloads', () => {
    const dotsPerMm = 203 / 25.4;
    const labelDots = Math.round(50 * dotsPerMm);
    for (const len of [120, 250, 400]) {
      const payload = 'KSO1:' + 'a'.repeat(len);
      const zpl = new ZplFormatter(50, 30).formatKitchenPaymentLabel({ ...labelData, labelQrPayload: payload });
      const m = zpl.match(/\^FO(\d+),\d+\n\^BQN,2,(\d)/);
      expect(m).toBeTruthy();
      const x = Number(m![1]);
      const mag = Number(m![2]);
      const modules = QRCode.create(payload, { errorCorrectionLevel: 'Q' }).modules.size;
      expect(x + modules * mag).toBeLessThanOrEqual(labelDots);
    }
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/kitchen-payment-label.test.ts`
Expected: FAIL — Polish-only output; no `SO DON`/`MANG DI`/`3 mon`; uses `qrPayload`; Vietnamese brand not folded in `'zebra'` profile.

- [ ] **Step 3: Add imports + module-level helpers**

At the top of `src/main/hardware/zebra/zpl-formatter.ts`, add the import (after the existing imports):

```typescript
import QRCode from 'qrcode';
import { kitchenItemCount } from '../../printing/kitchen-ticket';
```

Below the existing `ASCII_TRANSLITERATION` constant (module scope), add:

```typescript
type KitchenLabelLang = 'pl' | 'vi' | 'en';

const KITCHEN_LABEL_COPY: Record<KitchenLabelLang, {
  order: string; count: string; pay: string; takeaway: string; dineIn: string;
}> = {
  pl: { order: 'NR ZAMOWIENIA', count: 'poz.', pay: 'Zeskanuj / zaplac przy kasie', takeaway: 'NA WYNOS', dineIn: 'NA MIEJSCU' },
  vi: { order: 'SO DON', count: 'mon', pay: 'Quet / ra quay tra tien', takeaway: 'MANG DI', dineIn: 'AN TAI QUAN' },
  en: { order: 'ORDER NO', count: 'items', pay: 'Scan / pay at counter', takeaway: 'TAKEAWAY', dineIn: 'DINE IN' },
};

function kitchenLabelLang(value: unknown): KitchenLabelLang {
  const lang = String(value || '').toLowerCase();
  return lang === 'vi' || lang === 'en' ? lang : 'pl';
}

function kitchenLabelFulfillment(value: unknown, lang: KitchenLabelLang): string | null {
  const normalized = String(value || '').toUpperCase();
  if (normalized === 'TAKEAWAY') return KITCHEN_LABEL_COPY[lang].takeaway;
  if (normalized === 'DINE_IN') return KITCHEN_LABEL_COPY[lang].dineIn;
  return null;
}

function kitchenLabelTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}
```

- [ ] **Step 4: Add the deterministic ASCII sanitizer + QR layout methods**

Inside the `ZplFormatter` class, add these two private methods (next to `sanitizeText`):

```typescript
  /** Like sanitizeText but ALWAYS folds Latin/Vietnamese to ASCII, independent
   *  of textProfile — the Zebra device font cannot render diacritics. */
  private sanitizeAscii(text: string, maxLength: number = 50): string {
    return this.transliterateLatinToAscii(text)
      .replace(/[\x00-\x1F\x7F]/g, '')
      .replace(/[\^~]/g, '')
      .trim()
      .substring(0, maxLength);
  }

  /** Pick a QR magnification + right-aligned x so the QR fits the label width
   *  for the given payload (module count from the qrcode lib at ECC Q). */
  private kitchenLabelQrLayout(payload: string): { magnification: number; x: number } {
    const marginMm = 2;
    const leftColMm = 24;
    const maxQrMm = Math.max(10, this.labelWidth - leftColMm - marginMm);
    let modules = 25;
    try {
      modules = QRCode.create(payload, { errorCorrectionLevel: 'Q' }).modules.size;
    } catch {
      modules = 25;
    }
    let magnification = 2;
    for (const m of [4, 3, 2]) {
      if ((modules * m) / this.dotsPerMm <= maxQrMm) { magnification = m; break; }
    }
    const widthDots = modules * magnification;
    const x = Math.max(
      this.mmToDots(leftColMm),
      this.mmToDots(this.labelWidth) - widthDots - this.mmToDots(marginMm),
    );
    return { magnification, x };
  }
```

- [ ] **Step 5: Replace `formatKitchenPaymentLabel`**

Replace the entire existing `formatKitchenPaymentLabel(data: KitchenTicketData): string { … }` method with:

```typescript
  /**
   * Dedicated 50x30 payment label for kitchen self-order kiosks: big human
   * order number, item count + total, fulfillment, and the recall QR — in the
   * customer's language, ASCII-folded for the Zebra device font.
   */
  formatKitchenPaymentLabel(data: KitchenTicketData): string {
    const lang = kitchenLabelLang(data.customerLanguage);
    const copy = KITCHEN_LABEL_COPY[lang];
    const total = Math.max(
      0,
      Math.round(Number(data.totalGrosze) || data.items.reduce((sum, item) => {
        const explicit = Math.round(Number(item.lineTotalGrosze) || 0);
        if (explicit > 0) return sum + explicit;
        const quantity = Math.max(1, Math.round(Number(item.quantity) || 1));
        return sum + Math.max(0, Math.round(Number(item.unitPriceGrosze) || 0)) * quantity;
      }, 0)),
    );
    const orderNumber = this.sanitizeAscii(data.pickupNumber || data.orderNumber || '----', 24);
    const brand = this.sanitizeAscii(data.brandName || 'Zira POS', 28);
    const fulfillment = kitchenLabelFulfillment(data.fulfillmentType, lang);
    const headerText = fulfillment ? `${brand}  ·  ${fulfillment}` : brand;
    const totalText = this.sanitizeAscii(
      `${kitchenItemCount(data.items)} ${copy.count}  ·  ${(total / 100).toFixed(2).replace('.', ',')} zl`,
      40,
    );
    const time = kitchenLabelTime(data.createdAt);
    const payload = this.sanitizeText(data.labelQrPayload || data.qrPayload || '', 1200);
    const left = this.mmToDots(3);

    const lines: string[] = [
      '^XA',
      '^CI28',
      `^PW${this.mmToDots(this.labelWidth)}`,
      `^FO${left},${this.mmToDots(2)}^A0,${this.mmToDots(2.6)},${this.mmToDots(2.6)}^FD${this.sanitizeAscii(headerText, 40)}^FS`,
      `^FO${left},${this.mmToDots(6)}^A0,${this.mmToDots(2.6)},${this.mmToDots(2.6)}^FD${this.sanitizeAscii(copy.order, 24)}^FS`,
      `^FO${left},${this.mmToDots(9)}^A0,${this.mmToDots(7)},${this.mmToDots(7)}^FD${orderNumber}^FS`,
      `^FO${left},${this.mmToDots(18)}^A0,${this.mmToDots(2.8)},${this.mmToDots(2.8)}^FD${totalText}^FS`,
      `^FO${left},${this.mmToDots(22)}^A0,${this.mmToDots(2.3)},${this.mmToDots(2.3)}^FD${this.sanitizeAscii(copy.pay, 40)}^FS`,
      `^FO${left},${this.mmToDots(26)}^A0,${this.mmToDots(2.1)},${this.mmToDots(2.1)}^FD${this.sanitizeAscii(time, 8)}^FS`,
    ];

    if (payload) {
      const qr = this.kitchenLabelQrLayout(payload);
      lines.push(`^FO${qr.x},${this.mmToDots(4)}`);
      lines.push(`^BQN,2,${qr.magnification}`);
      lines.push(`^FDQA,${payload}^FS`);
    }

    lines.push('^XZ');
    return lines.join('\n');
  }
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx vitest run tests/kitchen-payment-label.test.ts`
Expected: PASS (all 4).

- [ ] **Step 7: Typecheck**

Run: `npx tsc -p tsconfig.main.json --noEmit`
Expected: no new errors (`qrcode` + `@types/qrcode` are installed; `esModuleInterop` is on).

- [ ] **Step 8: Commit**

```bash
git add src/main/hardware/zebra/zpl-formatter.ts tests/kitchen-payment-label.test.ts
git commit -m "feat(zpl): i18n + deterministic ASCII fold + adaptive QR for kitchen payment label"
```

---

## Task 6: Self-order adapter, `includeNotes`, and `labelQrPayload` wiring

**Files:**
- Modify: `src/main/modules/pos.module.ts`
- Test: `tests/kitchen-self-order-contract.test.ts` (source-contract — `pos.module.ts` is not unit-importable)

- [ ] **Step 1: Write the failing source-contract test**

Append to `tests/kitchen-self-order-contract.test.ts`:

```typescript
describe('kitchen self-order label/ticket wiring (pos.module source)', () => {
  const src = readSource('src/main/modules/pos.module.ts');

  it('adapter passes modifiers separately and a free-text-only note', () => {
    expect(src).toContain('modifiers: parseKitchenSelfOrderOptions(item.options_json)');
    expect(src).toContain('notes: item.note || null,');
  });

  it('buildKitchenSelfOrderQrPayload accepts an includeNotes option', () => {
    expect(src).toMatch(/includeNotes\?: boolean/);
  });

  it('attaches a no-notes labelQrPayload at submit and reprint', () => {
    const matches = src.match(/ticket\.labelQrPayload = buildKitchenSelfOrderQrPayload\([^)]*includeNotes: false/gs);
    expect(matches && matches.length).toBeGreaterThanOrEqual(2);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/kitchen-self-order-contract.test.ts -t "label/ticket wiring"`
Expected: FAIL — none of the strings present yet.

- [ ] **Step 3: Update the adapter `buildKitchenSelfOrderTicket`**

In `src/main/modules/pos.module.ts`, in the `items: order.items.map(...)` of `buildKitchenSelfOrderTicket`, replace:

```typescript
      notes: [
        parseKitchenSelfOrderOptions(item.options_json).join(', '),
        item.note || '',
      ].filter(Boolean).join(' | ') || null,
```

with:

```typescript
      modifiers: parseKitchenSelfOrderOptions(item.options_json),
      notes: item.note || null,
```

- [ ] **Step 4: Add `includeNotes` to `buildKitchenSelfOrderQrPayload`**

Replace the whole `buildKitchenSelfOrderQrPayload` function with:

```typescript
function buildKitchenSelfOrderQrPayload(
  order: KitchenSelfOrderWithItems,
  options: { kitchenAlreadyReleased?: boolean; includeNotes?: boolean } = {},
): string {
  const kitchenAlreadyReleased = options.kitchenAlreadyReleased !== false;
  if (options.includeNotes === false) {
    return `${KITCHEN_SELF_ORDER_QR_PREFIX}${base64UrlEncodeUtf8(JSON.stringify(
      buildKitchenSelfOrderCompactQrPayload(order, false, kitchenAlreadyReleased),
    ))}`;
  }
  const withNotes = `${KITCHEN_SELF_ORDER_QR_PREFIX}${base64UrlEncodeUtf8(JSON.stringify(
    buildKitchenSelfOrderCompactQrPayload(order, true, kitchenAlreadyReleased),
  ))}`;
  if (withNotes.length <= KITCHEN_SELF_ORDER_QR_WITH_NOTES_MAX_LENGTH) return withNotes;

  return `${KITCHEN_SELF_ORDER_QR_PREFIX}${base64UrlEncodeUtf8(JSON.stringify(
    buildKitchenSelfOrderCompactQrPayload(order, false, kitchenAlreadyReleased),
  ))}`;
}
```

- [ ] **Step 5: Attach `labelQrPayload` at the submit call site**

In the `'kitchen-self-order:submit'` handler, find:

```typescript
        const ticket = buildKitchenSelfOrderTicket(created, brandName, qrPayload, sourceLabel);
```

and insert immediately after it:

```typescript
        ticket.labelQrPayload = buildKitchenSelfOrderQrPayload(created, {
          kitchenAlreadyReleased: kitchenPrint.printed,
          includeNotes: false,
        });
```

- [ ] **Step 6: Attach `labelQrPayload` at the reprint call site**

In the `'kitchen-self-order:reprintSlip'` handler, find:

```typescript
        const ticket = buildKitchenSelfOrderTicket(order, resolveKitchenSelfOrderBrandName(cfg), qrPayload, sourceLabel);
```

and insert immediately after it:

```typescript
        ticket.labelQrPayload = buildKitchenSelfOrderQrPayload(order, {
          kitchenAlreadyReleased: true,
          includeNotes: false,
        });
```

- [ ] **Step 7: Set `modifiers: []` on the POS-order kitchen ticket**

In `printKitchenTicketForOrder`, in the `items: kitchenItems.map(...)`, change:

```typescript
        items: kitchenItems.map((item) => ({
          name: item.name,
          quantity: Number(item.sale_quantity ?? item.quantity) || 1,
          unit: item.sale_unit ?? null,
          notes: item.notes ?? null,
        })),
```

to:

```typescript
        items: kitchenItems.map((item) => ({
          name: item.name,
          quantity: Number(item.sale_quantity ?? item.quantity) || 1,
          unit: item.sale_unit ?? null,
          modifiers: [],
          notes: item.notes ?? null,
        })),
```

- [ ] **Step 8: Run tests + typecheck**

Run: `npx vitest run tests/kitchen-self-order-contract.test.ts`
Expected: PASS.
Run: `npx tsc -p tsconfig.main.json --noEmit`
Expected: no new errors.

- [ ] **Step 9: Commit**

```bash
git add src/main/modules/pos.module.ts tests/kitchen-self-order-contract.test.ts
git commit -m "feat(pos): split self-order modifiers/notes; no-notes labelQrPayload for slip/label"
```

---

## Task 7: Full regression + typecheck

**Files:** none (verification only)

- [ ] **Step 1: Run the full unit suite**

Run: `npx vitest run`
Expected: PASS — baseline (per app-bot: 4 files / 53 tests) plus the new tests; no regressions.

- [ ] **Step 2: Typecheck both projects**

Run: `npx tsc -p tsconfig.main.json --noEmit && npm run typecheck:renderer`
Expected: clean.

- [ ] **Step 3: Commit (only if any fixups were needed)**

```bash
git add -A
git commit -m "test(kitchen-self-order): green suite + typecheck after label/ticket changes"
```

---

## Task 8: Manual print-smoke acceptance (pre go-live, real hardware)

**Files:** none (manual acceptance on winpc + the kiosk Zebra)

> This is the authoritative backstop for QR scan + ASCII rendering (spec §8). Not automatable.

- [ ] **Step 1: Build & run the app on the kiosk machine** (per the POS-zira deploy flow).

- [ ] **Step 2: Place a kitchen self-order with ≥4 items and several modifiers** (e.g. sugar/ice/topping) from the kiosk; choose Vietnamese.

- [ ] **Step 3: Inspect the 50x30 label:** order number large and centered/left; `SO DON`, `MANG DI`/`AN TAI QUAN`, count + total, instruction, time — all readable ASCII; brand not garbled; **QR not clipped** at the right edge.

- [ ] **Step 4: Scan the label QR at the POS:** the order recalls with correct item, quantity, and snapshot price; metadata (order number / fulfillment) correct. Modifiers/notes intentionally absent from the recalled cart (spec §4.6).

- [ ] **Step 5: Inspect the kitchen ticket:** each modifier on its own `»` line, the free note on a `!!` line, header shows the item count. (Reminder: the kitchen-printer POS must run the new version — spec §6.)

- [ ] **Step 6: Record the result** in the PR/issue (pass/fail + photo).

---

## Self-Review Notes

- **Spec coverage:** §3 → Task 3; §4.1/4.2 → Task 5; §4.3 (canonical modifiers) → adapter passes the snapshot label as-is (Task 6), no localization; §4.4 → Task 2; §4.5a (labelQrPayload + includeNotes) → Task 6; §4.5b (payload-aware QR) → Task 5; §4.6 (recall tradeoff) → Task 8 step 4; §5 → Tasks 1+6; §6 (rollout) → Task 8 step 5 note; §8 tests → Tasks 2-7 + manual Task 8.
- **Regression guard:** the receipt slip (Task 4) is updated to render modifiers because the adapter (Task 6) stops merging them into `notes`.
- **Type consistency:** `kitchenItemCount`, `labelQrPayload`, `modifiers`, `kitchenLabelQrLayout`, `sanitizeAscii` are named identically across all tasks.
