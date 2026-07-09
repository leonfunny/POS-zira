# Deep-link từ dòng bán hàng tới màn sửa sản phẩm — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `subagent-driven-development` (recommended) or `executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cho phép mở thẳng màn sửa sản phẩm từ một dòng trong giỏ hàng POS hoặc một dòng trong chi tiết đơn ở tab Orders — và sửa lại cụm ô tên sản phẩm để nó nói đúng ô nào thật sự in lên hoá đơn.

**Architecture:** `App` giữ một mẩu state `productEditRequest` làm trạm trung chuyển giữa POS/Orders và `ProductModule` (repo không có router; `activeTab` là `useState`). `ProductModule` nhận `openVariantId`, resolve từ mirror local rồi mở đúng `ProductEditView` đang có. Logic điều hướng dễ vỡ được bóc ra module thuần `product-view-nav.ts` để test không cần React. Song song, `ProductEditForm` đề bạt ô tên Ba Lan ra khỏi accordion `Advanced` và hiển thị preview tên sẽ in, tính qua đúng hằng số mà đường in dùng.

**Tech Stack:** Electron 33 + React 18 + TypeScript + Vite + Tailwind. Test: Vitest 4 (`environment: 'node'`, không jsdom). SQLite local qua `better-sqlite3`.

## Global Constraints

- **Repo duy nhất: `C:\POS-zira` trên máy `winpc`** (`ssh winpc`), branch `main`. **Không** đụng `/var/www/www/enail`. Không migration, không deploy Contabo.
- **Backend không cần sửa gì.** `product-admin.service.ts:96-107` đã trả `version: 2`, `canUpdateProduct` và `canEditDisplayName` (cùng bằng `canAdminProducts`), và `UpdateProductAdminVariantDto` đã nhận `nameTranslations`. Tất cả đã LIVE trên Contabo.
- **`winpc` không `git push` được qua SSH headless.** Commit tại chỗ; đừng thử push.
- **Vitest environment là `node`** (`vitest.config.ts`). Không có `@testing-library/react`. Test hoặc import module thuần, hoặc assert trên source text đọc bằng `readFileSync` — đúng idiom đang có (`tests/product-admin-display-name.test.ts`, `tests/cart-panel-redesign.test.ts`).
- **Mọi chuỗi i18n đọc qua `tOr(...)`.** `translations.ts` chỉ có 3 locale mang các key này (`en`, `vi`, `pl`); 4 locale còn lại (`tr`, `zh`, `uk`, `ru`) rơi về chuỗi fallback truyền cho `tOr` trong component. **Sửa nhãn nghĩa là sửa cả chuỗi trong `translations.ts` LẪN chuỗi fallback trong component.**
- **Chuỗi Ba Lan trong `translations.ts` viết không dấu** (`'Nazwa wyswietlana po polsku'`). Giữ quy ước đó.
- **Không bao giờ ghi vào `%APPDATA%\zira-ai\pos.db`.** App có thể đang chạy.
- Lệnh: test `npx vitest run tests/<file>`; toàn bộ `npx vitest run`; typecheck renderer `npm run typecheck:renderer`; build main `npm run build:main`.

## Baseline (đo 2026-07-09, trước khi bắt đầu)

```
Test Files  1 failed | 210 passed (211)
      Tests  2 failed | 1752 passed | 13 skipped (1767)
```

Hai test fail **có sẵn từ trước**, cả hai trong `tests/product-admin-create-contract.test.ts`:
- `blocks locally known duplicate barcodes before backend create submit`
- `uses backend priceGrossGrosze only for create requests`

Chúng là source-assertion đã cũ sau đợt refactor internal-EAN. **Không phải lỗi của bạn. Đừng sửa chúng trong plan này.** Bộ test thỉnh thoảng flaky (một lần chạy báo 2 file fail); nếu thấy file thứ hai fail, chạy lại file đó riêng để xác nhận.

## File Structure

**Tạo mới**

| File | Trách nhiệm |
|---|---|
| `src/renderer/components/products/receipt-name-preview.ts` | Hàm thuần: cho `name` + `displayNames` đang gõ, trả đúng chuỗi hoá đơn sẽ in, nguồn của nó, và dạng ELZAB fold. |
| `src/renderer/components/products/product-view-nav.ts` | Kiểu `ProductView`/`BrowseView`/`EditReturn` + hai hàm thuần `isExternalEdit`, `viewAfterEditExit`. Đây là nơi hai cái bẫy điều hướng bị khoá bằng test. |
| `src/renderer/hooks/useProductAdminCapabilities.ts` | Hook + cache module-scope cho `pos.productAdmin.getCapabilities()`, kèm `resetProductAdminCapabilitiesCache()`. |
| `tests/product-admin-capabilities-hook.test.ts` | Khoá bẫy App render trước login: hook không được cache `no-auth`, và App phải bật hook bằng `isAuthenticated`. |
| `tests/receipt-name-locale-contract.test.ts` | Khoá hợp đồng: đường in resolve qua `RECEIPT_NAME_LOCALE`. |
| `tests/receipt-name-preview.test.ts` | Hàm preview khớp resolver của đường in. |
| `tests/product-name-fields-truthful.test.ts` | Nhãn ô canonical không được nhận là tên hoá đơn; nhãn ô PL phải nhận. |
| `tests/product-edit-receipt-name-field.test.ts` | Ô PL nằm ngoài `Advanced`, read-only khi thiếu capability. |
| `tests/product-view-nav.test.ts` | Hai hàm thuần điều hướng. |
| `tests/product-edit-deeplink-wiring.test.ts` | Chuỗi prop `App → POSLayout → RetailTemplate → Cart → CartItem` và `App → OrdersTab`. |

**Sửa**

`src/shared/catalog-names.ts` · `src/main/pos/payment-controller.ts` · `src/renderer/i18n/translations.ts` · `src/renderer/components/products/ProductEditForm.tsx` · `ProductCreateDialog.tsx` · `ProductDetailDrawer.tsx` · `ProductEditView.tsx` · `ProductModule.tsx` · `src/renderer/App.tsx` · `src/renderer/components/pos/CartItem.tsx` · `Cart.tsx` · `POSLayout.tsx` · `templates/retail/RetailTemplate.tsx` · `src/renderer/components/OrdersTab.tsx`

---

# PHASE 1 — Cụm ô tên nói thật

Phase này **độc lập** với deep-link và ship được một mình. Nó dập tắt lớp bug "sửa rồi mà vẫn sai".

## Task 1: Hằng số locale của tên hoá đơn

**Files:**
- Modify: `src/shared/catalog-names.ts` (sửa comment contract cũ + thêm export sau `export type NameTranslations`)
- Modify: `src/main/pos/payment-controller.ts:5` và `:145`
- Test: `tests/receipt-name-locale-contract.test.ts`

**Interfaces:**
- Produces: `RECEIPT_NAME_LOCALE: 'pl'` export từ `src/shared/catalog-names.ts`. Task 2 và Task 4 đều import nó.

- [ ] **Step 1: Viết test fail**

Tạo `tests/receipt-name-locale-contract.test.ts`:

```ts
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { RECEIPT_NAME_LOCALE, resolveName } from '../src/shared/catalog-names';

const root = resolve(__dirname, '..');
const source = (path: string): string =>
  readFileSync(resolve(root, path), 'utf8').replace(/\r\n/g, '\n');

describe('receipt name locale contract', () => {
  it('exports the locale the receipt renders item names in', () => {
    expect(RECEIPT_NAME_LOCALE).toBe('pl');
  });

  it('prefers the Polish translation over the canonical name', () => {
    expect(
      resolveName({ name: 'Cật (thận lợn)', name_translations: { pl: 'Nerka' } }, RECEIPT_NAME_LOCALE),
    ).toBe('Nerka');
  });

  it('falls back to the canonical name when Polish is missing or blank', () => {
    expect(resolveName({ name: 'Cật (thận lợn)', name_translations: { vi: 'Cật heo' } }, RECEIPT_NAME_LOCALE))
      .toBe('Cật (thận lợn)');
    expect(resolveName({ name: 'Cật (thận lợn)', name_translations: { pl: '   ' } }, RECEIPT_NAME_LOCALE))
      .toBe('Cật (thận lợn)');
    expect(resolveName({ name: 'Cật (thận lợn)', name_translations: null }, RECEIPT_NAME_LOCALE))
      .toBe('Cật (thận lợn)');
  });

  it('the print path resolves through the shared constant, not a literal', () => {
    const printPath = source('src/main/pos/payment-controller.ts');
    expect(printPath).toContain('RECEIPT_NAME_LOCALE');
    expect(printPath).not.toMatch(/resolveName\(\s*product\s*,\s*['"]pl['"]\s*\)/);
  });
});
```

- [ ] **Step 2: Chạy để xác nhận nó fail**

```bash
ssh winpc "cd C:\POS-zira && npx vitest run tests/receipt-name-locale-contract.test.ts"
```

Expected: FAIL. `expect(RECEIPT_NAME_LOCALE).toBe('pl')` nhận `undefined`, và assertion cuối thấy literal `resolveName(product, 'pl')`.

- [ ] **Step 3: Export hằng số**

Trong `src/shared/catalog-names.ts`, sửa block comment đầu file trước. Dòng hiện tại nói `order lines and fiscal payloads MUST keep this exact string` là sai với đường in hiện tại. Thay bằng nghĩa thật:

```ts
// - `name` is canonical: persisted order lines keep this exact string for
//   backend reconciliation and fallback display.
// - `name_translations` is localized display data: drives in-app rendering for
//   category pills, product cards, search/scan toasts, cart rows, and the
//   receipt/fiscal item name when `RECEIPT_NAME_LOCALE` has a usable value.
```

Rồi ngay dưới `export type NameTranslations = Record<string, string>;`:

```ts
/**
 * Locale the customer-facing receipt renders item names in — paper AND fiscal.
 * `PaymentController.getReceiptItemName` resolves through this; any editor
 * preview MUST use the same constant so the two can never drift.
 *
 * This is NOT a UI language setting. Changing it changes what prints.
 */
export const RECEIPT_NAME_LOCALE = 'pl';
```

- [ ] **Step 4: Đường in dùng hằng số**

`src/main/pos/payment-controller.ts` dòng 5, đổi import:

```ts
import { RECEIPT_NAME_LOCALE, resolveName } from '../../shared/catalog-names';
```

Dòng 145, trong `getReceiptItemName`:

```ts
    return resolveName(product, RECEIPT_NAME_LOCALE) || item.name;
```

- [ ] **Step 5: Chạy test — phải PASS**

```bash
ssh winpc "cd C:\POS-zira && npx vitest run tests/receipt-name-locale-contract.test.ts"
```

Expected: PASS, 4 tests.

- [ ] **Step 6: Typecheck main**

```bash
ssh winpc "cd C:\POS-zira && npm run build:main"
```

Expected: exit 0, không có lỗi TS.

- [ ] **Step 7: Commit**

```bash
ssh winpc "cd C:\POS-zira && git add src/shared/catalog-names.ts src/main/pos/payment-controller.ts tests/receipt-name-locale-contract.test.ts && git commit -m \"feat(receipt): share RECEIPT_NAME_LOCALE between print path and editor\""
```

---

## Task 2: Hàm thuần `receiptNamePreview`

**Files:**
- Create: `src/renderer/components/products/receipt-name-preview.ts`
- Test: `tests/receipt-name-preview.test.ts`

**Interfaces:**
- Consumes: `RECEIPT_NAME_LOCALE`, `resolveName` từ `src/shared/catalog-names` (Task 1); `toFiscalSafeItemName` từ `src/shared/fiscal-text`.
- Produces:
  ```ts
  interface ReceiptNamePreview { value: string; source: 'pl' | 'canonical'; fiscalSafe: string }
  function receiptNamePreview(canonicalName: string, displayNames: Record<string, string>): ReceiptNamePreview
  ```
  Task 4 và Task 5 gọi hàm này.

- [ ] **Step 1: Viết test fail**

Tạo `tests/receipt-name-preview.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { receiptNamePreview } from '../src/renderer/components/products/receipt-name-preview';
import { RECEIPT_NAME_LOCALE, resolveName } from '../src/shared/catalog-names';

describe('receiptNamePreview', () => {
  it('reports the Polish name when present', () => {
    expect(receiptNamePreview('Cật (thận lợn)', { pl: 'Nerka', vi: '', en: '' }))
      .toMatchObject({ value: 'Nerka', source: 'pl' });
  });

  it('falls back to the canonical name when the Polish field is blank', () => {
    expect(receiptNamePreview('Cật (thận lợn)', { pl: '   ', vi: '', en: '' }))
      .toMatchObject({ value: 'Cật (thận lợn)', source: 'canonical' });
  });

  it('a Vietnamese display name never reaches the receipt', () => {
    expect(receiptNamePreview('Cật (thận lợn)', { pl: '', vi: 'Cật heo', en: '' }))
      .toMatchObject({ value: 'Cật (thận lợn)', source: 'canonical' });
  });

  it('shows how an ELZAB printer folds the name to ASCII', () => {
    expect(receiptNamePreview('Cật (thận lợn)', { pl: '', vi: '', en: '' }).fiscalSafe)
      .toBe('Cat (than lon)');
  });

  it('agrees with the print-path resolver for the same input', () => {
    const canonical = 'Cật (thận lợn)';
    const displayNames = { pl: 'Nerka', vi: '', en: '' };
    expect(receiptNamePreview(canonical, displayNames).value).toBe(
      resolveName({ name: canonical, name_translations: displayNames }, RECEIPT_NAME_LOCALE),
    );
  });
});
```

- [ ] **Step 2: Chạy để xác nhận nó fail**

```bash
ssh winpc "cd C:\POS-zira && npx vitest run tests/receipt-name-preview.test.ts"
```

Expected: FAIL — `Failed to load url .../receipt-name-preview`.

- [ ] **Step 3: Viết module**

Tạo `src/renderer/components/products/receipt-name-preview.ts`:

```ts
import { RECEIPT_NAME_LOCALE, resolveName } from '../../../shared/catalog-names';
import { toFiscalSafeItemName } from '../../../shared/fiscal-text';

export interface ReceiptNamePreview {
  /** Exact string the paper and fiscal receipt lines will carry. */
  value: string;
  /** Which editor field the value came from. */
  source: 'pl' | 'canonical';
  /** How an ELZAB fiscal printer renders it: ASCII-folded, 40 chars. */
  fiscalSafe: string;
}

/**
 * Mirrors `PaymentController.getReceiptItemName()` for the values currently
 * typed into the editor. Same resolver, same locale constant — the preview and
 * the printer cannot drift apart.
 */
export function receiptNamePreview(
  canonicalName: string,
  displayNames: Record<string, string>,
): ReceiptNamePreview {
  const value = resolveName(
    { name: canonicalName, name_translations: displayNames },
    RECEIPT_NAME_LOCALE,
  );
  const polish = (displayNames[RECEIPT_NAME_LOCALE] ?? '').trim();
  return {
    value,
    source: polish ? 'pl' : 'canonical',
    fiscalSafe: toFiscalSafeItemName(value),
  };
}
```

- [ ] **Step 4: Chạy test — phải PASS**

```bash
ssh winpc "cd C:\POS-zira && npx vitest run tests/receipt-name-preview.test.ts"
```

Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
ssh winpc "cd C:\POS-zira && git add src/renderer/components/products/receipt-name-preview.ts tests/receipt-name-preview.test.ts && git commit -m \"feat(products): pure helper for the name a receipt will print\""
```

---

## Task 3: Đổi nhãn hai ô tên

Key `products.drawer.canonicalName` được **bốn** component dùng (`ProductCreateDialog:386`, `ProductDetailDrawer:332`, `ProductEditForm:360`, `ProductEditView:368`). Cả bốn đều trỏ canonical, nên đổi một lần là đúng cho cả bốn.

**Files:**
- Modify: `src/renderer/i18n/translations.ts` (6 dòng, tìm theo key chứ đừng theo số dòng — chúng dịch chuyển khi bạn sửa)
- Modify: `src/renderer/components/products/ProductCreateDialog.tsx:386`
- Modify: `src/renderer/components/products/ProductDetailDrawer.tsx:332`
- Modify: `src/renderer/components/products/ProductEditForm.tsx:360` và `:405`
- Modify: `src/renderer/components/products/ProductEditView.tsx:368`
- Test: `tests/product-name-fields-truthful.test.ts`
- Update existing test: `tests/product-admin-display-name.test.ts`

**Interfaces:**
- Produces: fallback chuẩn `'Internal name (backend sync)'` cho canonical và `'Receipt / fiscal name (Polish)'` cho PL. Task 4 và Task 5 dùng lại đúng hai chuỗi này.

- [ ] **Step 1: Viết test fail**

Tạo `tests/product-name-fields-truthful.test.ts`:

```ts
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { translations, type Language } from '../src/renderer/i18n/translations';

const root = resolve(__dirname, '..');
const source = (path: string): string =>
  readFileSync(resolve(root, path), 'utf8').replace(/\r\n/g, '\n');

/** Only these locales carry the two keys; the rest fall back to the literal
 *  passed to tOr() in the component, asserted separately below. */
const LOCALES_WITH_KEY: Language[] = ['en', 'vi', 'pl'];

/** Any word that claims a field controls the printed receipt. */
const CLAIMS_RECEIPT = /receipt|fiscal|fiskal|paragon|hóa đơn/i;

const CANONICAL_LABEL_FILES = [
  'src/renderer/components/products/ProductCreateDialog.tsx',
  'src/renderer/components/products/ProductDetailDrawer.tsx',
  'src/renderer/components/products/ProductEditForm.tsx',
  'src/renderer/components/products/ProductEditView.tsx',
];

describe('product name field labels tell the truth', () => {
  it('the canonical name is never labelled as the receipt/fiscal name', () => {
    for (const lang of LOCALES_WITH_KEY) {
      const label = translations[lang]['products.drawer.canonicalName'];
      expect(label, `${lang}: key missing`).toBeTruthy();
      expect(CLAIMS_RECEIPT.test(label), `${lang}: "${label}"`).toBe(false);
    }
  });

  it('the Polish display name IS labelled as the receipt/fiscal name', () => {
    for (const lang of LOCALES_WITH_KEY) {
      const label = translations[lang]['products.edit.displayNamePl'];
      expect(label, `${lang}: key missing`).toBeTruthy();
      expect(CLAIMS_RECEIPT.test(label), `${lang}: "${label}"`).toBe(true);
    }
  });

  it('every component fallback for the canonical label is receipt-free', () => {
    for (const file of CANONICAL_LABEL_FILES) {
      const matches = source(file).match(/'products\.drawer\.canonicalName',\s*'[^']+'/g) ?? [];
      expect(matches.length, `${file}: no tOr fallback found`).toBeGreaterThan(0);
      for (const match of matches) {
        expect(CLAIMS_RECEIPT.test(match), `${file}: ${match}`).toBe(false);
      }
    }
  });

  it('the Polish field fallback claims the receipt', () => {
    const matches = source('src/renderer/components/products/ProductEditForm.tsx')
      .match(/'products\.edit\.displayNamePl',\s*'[^']+'/g) ?? [];
    expect(matches.length).toBe(1);
    expect(CLAIMS_RECEIPT.test(matches[0])).toBe(true);
  });
});
```

- [ ] **Step 2: Chạy để xác nhận nó fail**

```bash
ssh winpc "cd C:\POS-zira && npx vitest run tests/product-name-fields-truthful.test.ts"
```

Expected: FAIL ở test 1 (`en: "Receipt / fiscal name"`), test 2 (`en: "Polish display name"`), test 3, test 4.

- [ ] **Step 3: Sửa `translations.ts`**

Trong block `en` (quanh dòng 972 và 1066):

```ts
    'products.drawer.canonicalName': 'Internal name (backend sync)',
```
```ts
    'products.edit.displayNamePl': 'Receipt / fiscal name (Polish)',
```

Trong block `vi` (quanh dòng 2494 và 2588):

```ts
    'products.drawer.canonicalName': 'Tên gốc (nội bộ, đồng bộ backend)',
```
```ts
    'products.edit.displayNamePl': 'Tên trên hóa đơn / fiscal (Ba Lan)',
```

Trong block `pl` (quanh dòng 8918 và 9012) — **không dấu**, theo quy ước file:

```ts
    'products.drawer.canonicalName': 'Nazwa wewnetrzna (synchronizacja)',
```
```ts
    'products.edit.displayNamePl': 'Nazwa na paragonie / fiskalna',
```

- [ ] **Step 4: Sửa 4 fallback canonical + 1 fallback PL**

Trong **cả bốn** file `ProductCreateDialog.tsx`, `ProductDetailDrawer.tsx`, `ProductEditForm.tsx`, `ProductEditView.tsx`, thay mọi lần xuất hiện:

```ts
tOr(t, 'products.drawer.canonicalName', 'Canonical name')
```
thành
```ts
tOr(t, 'products.drawer.canonicalName', 'Internal name (backend sync)')
```

Trong `ProductEditForm.tsx` dòng 405, thay:

```ts
tOr(t, 'products.edit.displayNamePl', 'Polish')
```
thành
```ts
tOr(t, 'products.edit.displayNamePl', 'Receipt / fiscal name (Polish)')
```

- [ ] **Step 5: Chạy test — phải PASS**

```bash
ssh winpc "cd C:\POS-zira && npx vitest run tests/product-name-fields-truthful.test.ts tests/product-admin-display-name.test.ts"
```

Expected: PASS. `product-name-fields-truthful` có 4 test. `product-admin-display-name.test.ts` cũng phải được cập nhật: assertion cuối không được còn kỳ vọng chuỗi cũ `'Tên hiển thị tiếng Ba Lan'`; đổi nó sang label mới của `products.edit.displayNamePl`.

- [ ] **Step 6: Commit**

```bash
ssh winpc "cd C:\POS-zira && git add src/renderer/i18n/translations.ts src/renderer/components/products/ tests/product-name-fields-truthful.test.ts tests/product-admin-display-name.test.ts && git commit -m \"fix(products): stop labelling the canonical name as the receipt name\""
```

---

## Task 4: Đề bạt ô Ba Lan ra khỏi `Advanced` + preview

**Files:**
- Modify: `src/renderer/components/products/ProductEditForm.tsx` (import, `useMemo`, khối JSX 356-431)
- Modify: `src/renderer/i18n/translations.ts` (4 key mới × 3 locale)
- Test: `tests/product-edit-receipt-name-field.test.ts`

**Interfaces:**
- Consumes: `receiptNamePreview` (Task 2); fallback chuỗi từ Task 3.
- Produces: không có export mới. Khối `Advanced` từ nay chỉ còn `vi` + `en`.

- [ ] **Step 1: Thêm 4 key i18n**

Trong `translations.ts`, cạnh các key `products.edit.*` sẵn có của từng locale:

Block `en`:
```ts
    'products.edit.receiptPrints': 'Prints as',
    'products.edit.receiptFallbackWarning': 'Empty → the receipt prints the internal name',
    'products.edit.receiptFiscalFold': 'ELZAB folds it to',
    'products.edit.displayNameUnavailable': 'This server cannot edit display names yet',
```

Block `vi`:
```ts
    'products.edit.receiptPrints': 'In ra',
    'products.edit.receiptFallbackWarning': 'Bỏ trống → hoá đơn in tên gốc',
    'products.edit.receiptFiscalFold': 'ELZAB bỏ dấu thành',
    'products.edit.displayNameUnavailable': 'Máy chủ chưa hỗ trợ sửa tên hiển thị',
```

Block `pl`:
```ts
    'products.edit.receiptPrints': 'Drukuje sie jako',
    'products.edit.receiptFallbackWarning': 'Puste → paragon drukuje nazwe wewnetrzna',
    'products.edit.receiptFiscalFold': 'ELZAB zamieni na',
    'products.edit.displayNameUnavailable': 'Serwer nie obsluguje jeszcze edycji nazw',
```

- [ ] **Step 2: Viết test fail**

Tạo `tests/product-edit-receipt-name-field.test.ts`:

```ts
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(__dirname, '..');
const FORM = readFileSync(
  resolve(root, 'src/renderer/components/products/ProductEditForm.tsx'),
  'utf8',
).replace(/\r\n/g, '\n');

const ADVANCED_GUARD = '{advancedOpen && canEditDisplayName ?';
const PL_INPUT = 'current, pl: event.target.value';

describe('the field that prints is always visible', () => {
  it('the Polish input sits above the Advanced accordion', () => {
    const advancedIndex = FORM.indexOf(ADVANCED_GUARD);
    const polishIndex = FORM.indexOf(PL_INPUT);
    expect(advancedIndex, 'Advanced guard not found').toBeGreaterThanOrEqual(0);
    expect(polishIndex, 'Polish input not found').toBeGreaterThanOrEqual(0);
    expect(polishIndex).toBeLessThan(advancedIndex);
  });

  it('the Advanced accordion no longer owns the Polish input', () => {
    const advancedBlock = FORM.slice(FORM.indexOf(ADVANCED_GUARD));
    expect(advancedBlock).not.toContain(PL_INPUT);
  });

  it('a server without display-name support gets a read-only field, never a hidden one', () => {
    expect(FORM).toContain('readOnly={!canEditDisplayName}');
    expect(FORM).toContain("'products.edit.displayNameUnavailable'");
  });

  it('the form previews what the receipt will print', () => {
    expect(FORM).toContain("import { receiptNamePreview } from './receipt-name-preview'");
    expect(FORM).toContain('receiptNamePreview(name, displayNames)');
    expect(FORM).toContain("'products.edit.receiptFallbackWarning'");
    expect(FORM).toContain("'products.edit.receiptFiscalFold'");
  });

  it('the multi-variant warning travels with the Polish field', () => {
    const advancedIndex = FORM.indexOf(ADVANCED_GUARD);
    const warningIndex = FORM.indexOf("'products.edit.displayNameAllVariants'");
    expect(warningIndex).toBeGreaterThanOrEqual(0);
    expect(warningIndex).toBeLessThan(advancedIndex);
  });
});
```

- [ ] **Step 3: Chạy để xác nhận nó fail**

```bash
ssh winpc "cd C:\POS-zira && npx vitest run tests/product-edit-receipt-name-field.test.ts"
```

Expected: FAIL cả 5 test.

- [ ] **Step 4: Thêm import + memo vào `ProductEditForm.tsx`**

Sau dòng `import { grossFromNet, netFromGross, parsePriceNumber } from './price-vat';` (dòng 11):

```ts
import { receiptNamePreview } from './receipt-name-preview';
```

Ngay sau `const itemPolicy = getProductItemTypePolicy(itemType, sellBy);` (dòng 188):

```ts
  // What the paper + fiscal receipt will carry if this form is saved as typed.
  // Resolved by the same function and constant the print path uses.
  const receiptPreview = useMemo(() => receiptNamePreview(name, displayNames), [name, displayNames]);
```

- [ ] **Step 5: Thay khối JSX**

Trong `ProductEditForm.tsx`, thay toàn bộ đoạn từ `<label className="block">` (ô canonical, dòng ~357) tới hết khối `{advancedOpen && canEditDisplayName ? (...) : null}` (dòng ~430) bằng:

```tsx
        <label className="block">
          <span className="mb-2 block text-xs font-semibold uppercase text-slate-500">
            {tOr(t, 'products.drawer.canonicalName', 'Internal name (backend sync)')}
          </span>
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
            className="h-11 w-full rounded-md border border-slate-300 px-3 text-sm outline-none focus:border-brand-500"
          />
        </label>

        {/* The field that actually reaches the paper. Never hide it: when the
            backend cannot accept display-name edits we render it read-only,
            because an invisible receipt-name field is exactly the bug this
            layout replaces. See docs/2026-07-09-cart-product-edit-deeplink-design.md */}
        <label className="block">
          <span className="mb-2 block text-xs font-semibold uppercase text-slate-500">
            {tOr(t, 'products.edit.displayNamePl', 'Receipt / fiscal name (Polish)')}
          </span>
          <input
            value={displayNames.pl}
            onChange={(event) => setDisplayNames((current) => ({ ...current, pl: event.target.value }))}
            placeholder={name.trim() || product.name}
            maxLength={255}
            readOnly={!canEditDisplayName}
            className={`h-11 w-full rounded-md border px-3 text-sm outline-none focus:border-brand-500 ${
              canEditDisplayName ? 'border-slate-300' : 'border-slate-200 bg-slate-50 text-slate-500'
            }`}
          />
          {!canEditDisplayName ? (
            <span className="mt-1 block text-xs text-slate-500">
              {tOr(t, 'products.edit.displayNameUnavailable', 'This server cannot edit display names yet')}
            </span>
          ) : null}
          {canEditDisplayName && displayNameAffectsMultipleVariants ? (
            <span className="mt-1 block text-xs font-medium text-amber-700">
              {tOr(t, 'products.edit.displayNameAllVariants', 'Applies to all variants of this product')}
            </span>
          ) : null}
          {receiptPreview.source === 'pl' ? (
            <span className="mt-1 block text-xs text-slate-600">
              {tOr(t, 'products.edit.receiptPrints', 'Prints as')}:{' '}
              <strong className="font-semibold text-slate-900">{receiptPreview.value}</strong>
            </span>
          ) : (
            <span className="mt-1 block rounded-md border border-amber-200 bg-amber-50 px-2 py-1 text-xs text-amber-800">
              {tOr(t, 'products.edit.receiptFallbackWarning', 'Empty → the receipt prints the internal name')}:{' '}
              <strong className="font-semibold">{receiptPreview.value}</strong>
              <span className="mt-0.5 block text-amber-700">
                {tOr(t, 'products.edit.receiptFiscalFold', 'ELZAB folds it to')}: {receiptPreview.fiscalSafe}
              </span>
            </span>
          )}
        </label>

        <button
          type="button"
          onClick={() => setAdvancedOpen((value) => !value)}
          aria-expanded={advancedOpen}
          className="inline-flex h-11 items-center rounded-md border border-slate-300 bg-white px-4 text-sm font-semibold text-slate-700 hover:bg-slate-100"
        >
          {tOr(t, 'products.advanced', 'Advanced')}
        </button>

        {advancedOpen && canEditDisplayName ? (
          <div className="border-t border-slate-200 pt-4">
            <h4 className="mb-3 text-xs font-semibold uppercase text-slate-500">
              {tOr(t, 'products.edit.displayNames', 'Display names')}
            </h4>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <label className="block">
                <span className="mb-2 block text-xs font-semibold text-slate-600">
                  {tOr(t, 'products.edit.displayNameVi', 'Vietnamese')}
                </span>
                <input
                  value={displayNames.vi}
                  onChange={(event) => setDisplayNames((current) => ({ ...current, vi: event.target.value }))}
                  placeholder={name.trim() || product.name}
                  maxLength={255}
                  className="h-11 w-full rounded-md border border-slate-300 px-3 text-sm outline-none focus:border-brand-500"
                />
              </label>
              <label className="block">
                <span className="mb-2 block text-xs font-semibold text-slate-600">
                  {tOr(t, 'products.edit.displayNameEn', 'English (optional)')}
                </span>
                <input
                  value={displayNames.en}
                  onChange={(event) => setDisplayNames((current) => ({ ...current, en: event.target.value }))}
                  placeholder={name.trim() || product.name}
                  maxLength={255}
                  className="h-11 w-full rounded-md border border-slate-300 px-3 text-sm outline-none focus:border-brand-500"
                />
              </label>
            </div>
          </div>
        ) : null}
```

- [ ] **Step 6: Chạy test + typecheck**

```bash
ssh winpc "cd C:\POS-zira && npx vitest run tests/product-edit-receipt-name-field.test.ts && npm run typecheck:renderer"
```

Expected: 5 tests PASS; typecheck exit 0.

- [ ] **Step 7: Commit**

```bash
ssh winpc "cd C:\POS-zira && git add src/renderer/components/products/ProductEditForm.tsx src/renderer/i18n/translations.ts tests/product-edit-receipt-name-field.test.ts && git commit -m \"feat(products): surface the receipt name field and preview what prints\""
```

---

## Task 5: Cảnh báo tên hoá đơn trong dialog tạo sản phẩm

`CreateProductAdminProductDto` phía backend **không nhận `nameTranslations`** (chỉ `UpdateProductAdminVariantDto` có). Nên mọi sản phẩm tạo tại quầy đều chưa có tên Ba Lan, và hoá đơn sẽ in tên canonical cho tới khi ai đó vào sửa. Không thêm ô PL ở đây được — chỉ nói thật.

**Files:**
- Modify: `src/renderer/components/products/ProductCreateDialog.tsx` (import + JSX dưới ô tên, dòng ~386-395)
- Modify: `src/renderer/i18n/translations.ts` (1 key × 3 locale)
- Test: mở rộng `tests/product-edit-receipt-name-field.test.ts`

**Interfaces:**
- Consumes: `receiptNamePreview` (Task 2).

- [ ] **Step 1: Thêm key i18n**

Block `en`:
```ts
    'products.create.receiptNameHint': 'The receipt will print this name until a Polish name is added',
```
Block `vi`:
```ts
    'products.create.receiptNameHint': 'Hoá đơn sẽ in tên này cho tới khi bạn thêm tên Ba Lan',
```
Block `pl`:
```ts
    'products.create.receiptNameHint': 'Paragon wydrukuje te nazwe do czasu dodania nazwy polskiej',
```

- [ ] **Step 2: Thêm test fail**

Nối vào cuối `tests/product-edit-receipt-name-field.test.ts`:

```ts
const CREATE_DIALOG = readFileSync(
  resolve(root, 'src/renderer/components/products/ProductCreateDialog.tsx'),
  'utf8',
).replace(/\r\n/g, '\n');

describe('the create dialog admits the new product has no Polish name', () => {
  it('warns that the canonical name is what will print', () => {
    expect(CREATE_DIALOG).toContain("'products.create.receiptNameHint'");
  });

  it('shows the ELZAB-folded string so diacritics are not a surprise', () => {
    expect(CREATE_DIALOG).toContain("import { receiptNamePreview } from './receipt-name-preview'");
    expect(CREATE_DIALOG).toContain('receiptNamePreview(name, {})');
  });
});
```

- [ ] **Step 3: Chạy để xác nhận 2 test mới fail**

```bash
ssh winpc "cd C:\POS-zira && npx vitest run tests/product-edit-receipt-name-field.test.ts"
```

Expected: 5 PASS + 2 FAIL.

- [ ] **Step 4: Sửa `ProductCreateDialog.tsx`**

Thêm import cạnh các import `./`:

```ts
import { receiptNamePreview } from './receipt-name-preview';
```

Ngay dưới `</label>` bọc ô tên (kết thúc quanh dòng 395), chèn:

```tsx
        <p className="mt-1 rounded-md border border-amber-200 bg-amber-50 px-2 py-1 text-xs text-amber-800">
          {tOr(t, 'products.create.receiptNameHint', 'The receipt will print this name until a Polish name is added')}
          {name.trim() ? (
            <span className="mt-0.5 block text-amber-700">
              {tOr(t, 'products.edit.receiptFiscalFold', 'ELZAB folds it to')}:{' '}
              {receiptNamePreview(name, {}).fiscalSafe}
            </span>
          ) : null}
        </p>
```

- [ ] **Step 5: Chạy test + typecheck**

```bash
ssh winpc "cd C:\POS-zira && npx vitest run tests/product-edit-receipt-name-field.test.ts && npm run typecheck:renderer"
```

Expected: 7 tests PASS; typecheck exit 0.

- [ ] **Step 6: Commit**

```bash
ssh winpc "cd C:\POS-zira && git add src/renderer/components/products/ProductCreateDialog.tsx src/renderer/i18n/translations.ts tests/product-edit-receipt-name-field.test.ts && git commit -m \"feat(products): warn that a new product prints its internal name\""
```

**→ Phase 1 xong. Ship được ngay tại đây.** Chạy `npx vitest run` và `npm run typecheck:renderer` để chốt trước khi sang Phase 2.

---

# PHASE 2 — Deep-link từ dòng bán hàng

## Task 6: Module thuần điều hướng `product-view-nav.ts`

Đây là nơi khoá hai cái bẫy: nhánh `external` không được lọt vào `setView`, và effect "sản phẩm biến mất" không được đẩy `{name:'external'}` vào cây render.

**Files:**
- Create: `src/renderer/components/products/product-view-nav.ts`
- Test: `tests/product-view-nav.test.ts`

**Interfaces:**
- Consumes: `ProductCategorySelection` từ `./CategoryGrid`.
- Produces:
  ```ts
  type BrowseView = { name: 'categories' } | { name: 'products'; categoryId: ProductCategorySelection }
  type EditReturn = BrowseView | { name: 'external' }
  type ProductView = BrowseView | { name: 'edit'; productId: string; returnTo: EditReturn }
  function isExternalEdit(view: ProductView): boolean
  function viewAfterEditExit(view: ProductView): BrowseView
  type DeepLinkOutcome = { kind: 'idle' } | { kind: 'reset' } | { kind: 'open'; productId: string } | { kind: 'missing' }
  function deepLinkOutcome(openVariantId: string | undefined, loading: boolean, consumed: string | null, isKnown: (id: string) => boolean): DeepLinkOutcome
  ```
  Task 8 import tất cả.

- [ ] **Step 1: Viết test fail**

Tạo `tests/product-view-nav.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  isExternalEdit,
  viewAfterEditExit,
  type ProductView,
} from '../src/renderer/components/products/product-view-nav';

const categories: ProductView = { name: 'categories' };
const productsInCategory: ProductView = { name: 'products', categoryId: 'cat-1' };

describe('isExternalEdit', () => {
  it('is true only for an edit view opened from another tab', () => {
    expect(isExternalEdit({ name: 'edit', productId: 'v1', returnTo: { name: 'external' } })).toBe(true);
  });

  it('is false for an edit view opened from the catalog', () => {
    expect(isExternalEdit({ name: 'edit', productId: 'v1', returnTo: { name: 'categories' } })).toBe(false);
  });

  it('is false for any browse view', () => {
    expect(isExternalEdit(categories)).toBe(false);
    expect(isExternalEdit(productsInCategory)).toBe(false);
  });
});

describe('viewAfterEditExit', () => {
  it('returns to the browse view the edit was opened from', () => {
    expect(viewAfterEditExit({ name: 'edit', productId: 'v1', returnTo: { name: 'products', categoryId: 'cat-1' } }))
      .toEqual({ name: 'products', categoryId: 'cat-1' });
  });

  it('NEVER returns the external sentinel — it is not a renderable browse view', () => {
    const result = viewAfterEditExit({ name: 'edit', productId: 'v1', returnTo: { name: 'external' } });
    expect(result).toEqual({ name: 'categories' });
    expect(result.name).not.toBe('external');
  });

  it('leaves a browse view untouched', () => {
    expect(viewAfterEditExit(categories)).toEqual(categories);
    expect(viewAfterEditExit(productsInCategory)).toEqual(productsInCategory);
  });
});

describe('deepLinkOutcome', () => {
  const known = (id: string) => id === 'v1' || id === 'deactivated-v2';

  it('does nothing without a request', () => {
    expect(deepLinkOutcome(undefined, false, null, known)).toEqual({ kind: 'idle' });
  });

  it('forgets the consumed id once the request is cleared, so the same product reopens', () => {
    expect(deepLinkOutcome(undefined, false, 'v1', known)).toEqual({ kind: 'reset' });
  });

  it('waits while the catalog is still loading', () => {
    expect(deepLinkOutcome('v1', true, null, known)).toEqual({ kind: 'idle' });
  });

  it('opens a product that exists', () => {
    expect(deepLinkOutcome('v1', false, null, known)).toEqual({ kind: 'open', productId: 'v1' });
  });

  it('opens a DEACTIVATED product too — useProducts reads getAllIncludingInactive()', () => {
    expect(deepLinkOutcome('deactivated-v2', false, null, known))
      .toEqual({ kind: 'open', productId: 'deactivated-v2' });
  });

  it('reports a product deleted from the catalog', () => {
    expect(deepLinkOutcome('gone', false, null, known)).toEqual({ kind: 'missing' });
  });

  it('never re-opens the id it already consumed', () => {
    expect(deepLinkOutcome('v1', false, 'v1', known)).toEqual({ kind: 'idle' });
  });
});
```

Sửa dòng import đầu file cho khớp:

```ts
import {
  deepLinkOutcome,
  isExternalEdit,
  viewAfterEditExit,
  type ProductView,
} from '../src/renderer/components/products/product-view-nav';
```

- [ ] **Step 2: Chạy để xác nhận nó fail**

```bash
ssh winpc "cd C:\POS-zira && npx vitest run tests/product-view-nav.test.ts"
```

Expected: FAIL — `Failed to load url .../product-view-nav`.

- [ ] **Step 3: Viết module**

Tạo `src/renderer/components/products/product-view-nav.ts`:

```ts
import type { ProductCategorySelection } from './CategoryGrid';

export type BrowseView =
  | { name: 'categories' }
  | { name: 'products'; categoryId: ProductCategorySelection };

/** Where the edit view returns to. `external` means another tab (cart, orders) opened it. */
export type EditReturn = BrowseView | { name: 'external' };

export type ProductView = BrowseView | { name: 'edit'; productId: string; returnTo: EditReturn };

export function isExternalEdit(view: ProductView): boolean {
  return view.name === 'edit' && view.returnTo.name === 'external';
}

/**
 * The browse view to show after leaving the edit view.
 *
 * NEVER returns `{ name: 'external' }` — that sentinel is not a renderable
 * browse view, and returning it from the "product disappeared mid-edit" effect
 * is what breaks the tree. Callers must pair this with `isExternalEdit()` and
 * call their `onExitExternal` handler themselves.
 */
export function viewAfterEditExit(view: ProductView): BrowseView {
  if (view.name !== 'edit') return view;
  if (view.returnTo.name === 'external') return { name: 'categories' };
  return view.returnTo;
}

export type DeepLinkOutcome =
  | { kind: 'idle' }
  | { kind: 'reset' }
  | { kind: 'open'; productId: string }
  | { kind: 'missing' };

/**
 * Decide what an `openVariantId` request should do this render.
 *
 * `reset` is the one that bites: without forgetting the consumed id when the
 * request clears, reopening the SAME product a second time is silently ignored.
 *
 * `isKnown` is backed by `useProducts().allProducts`, which reads
 * `getAllIncludingInactive()` — a deactivated product still opens; only one
 * deleted from the catalog is `missing`.
 */
export function deepLinkOutcome(
  openVariantId: string | undefined,
  loading: boolean,
  consumed: string | null,
  isKnown: (id: string) => boolean,
): DeepLinkOutcome {
  if (!openVariantId) return consumed === null ? { kind: 'idle' } : { kind: 'reset' };
  if (loading) return { kind: 'idle' };
  if (consumed === openVariantId) return { kind: 'idle' };
  return isKnown(openVariantId) ? { kind: 'open', productId: openVariantId } : { kind: 'missing' };
}
```

- [ ] **Step 4: Chạy test — phải PASS**

```bash
ssh winpc "cd C:\POS-zira && npx vitest run tests/product-view-nav.test.ts"
```

Expected: PASS, 13 tests.

- [ ] **Step 5: Commit**

```bash
ssh winpc "cd C:\POS-zira && git add src/renderer/components/products/product-view-nav.ts tests/product-view-nav.test.ts && git commit -m \"feat(products): pure navigation model for the product edit view\""
```

---

## Task 7: Hook capabilities dùng chung

Hiện `ProductModule` gọi `getCapabilities()` **mỗi lần mount** — một round-trip mạng mỗi lần vào tab. POS và Orders cũng cần biết `canUpdateProduct` để quyết định vẽ nút.

**Files:**
- Create: `src/renderer/hooks/useProductAdminCapabilities.ts`
- Test: `tests/product-admin-capabilities-hook.test.ts`

**Interfaces:**
- Produces:
  ```ts
  function useProductAdminCapabilities(enabled?: boolean): {
    capabilities: ProductAdminCapabilities | null;
    error: string | null;
    loading: boolean;
    refresh: () => Promise<void>;
  }
  function resetProductAdminCapabilitiesCache(): void
  ```
  Task 8 và Task 12 dùng.

- [ ] **Step 1: Viết hook**

**Bẫy không được bỏ qua:** `App` render trước khi đăng nhập. Nếu hook tự gọi IPC khi chưa auth, nó sẽ nhận `no-auth`, cache module-scope kết quả đó, rồi sau login vẫn giấu nút bút chì. Hook phải có `enabled` flag, default `true` cho `ProductModule`, và `App` phải gọi `useProductAdminCapabilities(isAuthenticated)`. Không cache error result.

Tạo `src/renderer/hooks/useProductAdminCapabilities.ts`:

```ts
import { useCallback, useEffect, useState } from 'react';
import type { ProductAdminCapabilities } from '../../shared/types';

interface CapabilitiesState {
  capabilities: ProductAdminCapabilities | null;
  error: string | null;
}

let cache: CapabilitiesState | null = null;
let inFlight: Promise<CapabilitiesState> | null = null;

/**
 * Drop the module-scope cache. MUST be called when the signed-in user changes:
 * the cache lives outside the React tree, so App's `key={sessionKey}` remount
 * does not clear it and the next user would inherit these capabilities.
 */
export function resetProductAdminCapabilitiesCache(): void {
  cache = null;
  inFlight = null;
}

async function load(): Promise<CapabilitiesState> {
  try {
    const response = await window.electronAPI.pos.productAdmin.getCapabilities();
    return {
      capabilities: response.capabilities,
      error: response.ok ? null : response.error || 'product-admin-unavailable',
    };
  } catch (caught) {
    return {
      capabilities: null,
      error: caught instanceof Error ? caught.message : 'product-admin-unavailable',
    };
  }
}

export function useProductAdminCapabilities(enabled = true) {
  const [state, setState] = useState<CapabilitiesState | null>(() => enabled ? cache : null);
  const [loading, setLoading] = useState(enabled && cache === null);

  useEffect(() => {
    let cancelled = false;
    if (!enabled) {
      setState(null);
      setLoading(false);
      return;
    }
    if (cache) {
      setState(cache);
      setLoading(false);
      return;
    }
    setLoading(true);
    const request = (inFlight ??= load());
    request.then((next) => {
      cache = next.error ? null : next;
      inFlight = null;
      if (cancelled) return;
      setState(next);
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [enabled]);

  const refresh = useCallback(async () => {
    if (!enabled) {
      resetProductAdminCapabilitiesCache();
      setState(null);
      setLoading(false);
      return;
    }
    resetProductAdminCapabilitiesCache();
    setLoading(true);
    const next = await (inFlight ??= load());
    cache = next.error ? null : next;
    inFlight = null;
    setState(next);
    setLoading(false);
  }, [enabled]);

  return {
    capabilities: state?.capabilities ?? null,
    error: state?.error ?? null,
    loading,
    refresh,
  };
}
```

- [ ] **Step 2: Viết source-assertion test cho bẫy pre-auth**

Tạo `tests/product-admin-capabilities-hook.test.ts`:

```ts
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(__dirname, '..');
const source = (path: string): string =>
  readFileSync(resolve(root, path), 'utf8').replace(/\r\n/g, '\n');

describe('product-admin capabilities hook', () => {
  it('does not run or cache capabilities before authentication', () => {
    const hook = source('src/renderer/hooks/useProductAdminCapabilities.ts');

    expect(hook).toContain('useProductAdminCapabilities(enabled = true)');
    expect(hook).toContain('if (!enabled)');
    expect(hook).toContain('cache = next.error ? null : next');
  });
});
```

- [ ] **Step 3: Typecheck + test**

```bash
ssh winpc "cd C:\POS-zira && npx vitest run tests/product-admin-capabilities-hook.test.ts && npm run typecheck:renderer"
```

Expected: 1 test PASS; typecheck exit 0.

- [ ] **Step 4: Commit**

```bash
ssh winpc "cd C:\POS-zira && git add src/renderer/hooks/useProductAdminCapabilities.ts tests/product-admin-capabilities-hook.test.ts && git commit -m \"feat(products): cache product-admin capabilities across tabs\""
```

---

## Task 8: `ProductModule` nhận deep-link

**Files:**
- Modify: `src/renderer/components/products/ProductModule.tsx`
- Update existing test: `tests/product-module-static.test.ts`

**Interfaces:**
- Consumes: `isExternalEdit`, `viewAfterEditExit`, `BrowseView`, `ProductView` (Task 6); `useProductAdminCapabilities` (Task 7).
- Produces: props mới `openVariantId?: string`, `onExitExternal?: () => void`, `externalBackLabel?: string`. Task 12 truyền vào.

- [ ] **Step 1: Import + xoá type cục bộ**

Thêm `useRef` vào import React dòng 1:

```ts
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
```

Thêm import (cạnh `import ProductTileGrid from './ProductTileGrid';`):

```ts
import { deepLinkOutcome, isExternalEdit, viewAfterEditExit, type BrowseView, type ProductView } from './product-view-nav';
```

Thêm import hook:

```ts
import { useProductAdminCapabilities } from '../../hooks/useProductAdminCapabilities';
```

**Xoá** ba dòng type cục bộ (dòng 25-29):

```ts
type BrowseView =
  | { name: 'categories' }
  | { name: 'products'; categoryId: ProductCategorySelection };

type ProductView = BrowseView | { name: 'edit'; productId: string; returnTo: BrowseView };
```

Sau khi xoá, `ProductCategorySelection` có thể trở thành import thừa trong `ProductModule.tsx`. Chạy `npm run typecheck:renderer`; nếu nó báo unused, đổi `import CategoryGrid, { type ProductCategorySelection } from './CategoryGrid';` thành `import CategoryGrid from './CategoryGrid';`.

- [ ] **Step 2: Props**

Đổi interface (dòng 21-23):

```ts
interface ProductModuleProps {
  language: Language;
  /** Variant id to open straight into the edit view, set by App when a sale line asked for it. */
  openVariantId?: string;
  /** Called when the edit view opened by `openVariantId` is left. */
  onExitExternal?: () => void;
  /** Back-button label while an external caller owns the edit view (e.g. "Back to cart"). */
  externalBackLabel?: string;
}
```

Đổi signature (dòng 332):

```ts
export default function ProductModule({ language, openVariantId, onExitExternal, externalBackLabel }: ProductModuleProps) {
```

- [ ] **Step 3: Dùng hook capabilities thay effect cũ**

Xoá ba state (dòng 362-364) và toàn bộ effect `loadAdminCapabilities` (dòng 465-488). Thay bằng, ngay dưới `const { state: posState } = usePosStore();`:

```ts
  const {
    capabilities: adminCapabilities,
    error: adminCapabilityError,
    loading: adminCapabilitiesLoading,
  } = useProductAdminCapabilities();
```

Mọi chỗ dùng `adminCapabilities`, `adminCapabilityError`, `adminCapabilitiesLoading` giữ nguyên tên nên không phải sửa gì thêm.

Trong `tests/product-module-static.test.ts`, test `keeps product mutations behind product-admin capabilities` hiện còn assert `ProductModule` gọi thẳng `window.electronAPI.pos.productAdmin.getCapabilities()`. Assertion đó phải đổi sang kiểm `ProductModule` import/dùng `useProductAdminCapabilities`; không được để full suite đỏ vì test cũ mô tả kiến trúc cũ.

- [ ] **Step 4: Sửa `returnFromEdit` (bẫy #1)**

Thay hàm ở dòng ~511:

```ts
  const returnFromEdit = useCallback(() => {
    // Read the external flag BEFORE mutating state, and call the handler OUTSIDE
    // the setView updater — updaters must stay pure (StrictMode invokes twice).
    const external = isExternalEdit(view);
    setSelectedProduct(null);
    setView(viewAfterEditExit(view));
    if (external) onExitExternal?.();
  }, [view, onExitExternal]);
```

- [ ] **Step 5: Sửa effect "sản phẩm biến mất" (bẫy #2)**

Thay effect ở dòng ~419:

```ts
  useEffect(() => {
    if (!selectedProduct || loading) return;
    const fresh = allProducts.find((product) => product.id === selectedProduct.id);
    if (fresh && fresh !== selectedProduct) {
      setSelectedProduct(fresh);
      return;
    }
    if (!fresh && !selectedProduct._isDraft) {
      // Product vanished mid-edit (deleted or absent from the local mirror).
      // Popping `returnTo` blindly would push `{name:'external'}` into the view
      // state, which is not a BrowseView and breaks render.
      const external = isExternalEdit(view);
      setSelectedProduct(null);
      setView((current) => viewAfterEditExit(current));
      if (external) onExitExternal?.();
    }
  }, [allProducts, loading, selectedProduct, view, onExitExternal]);
```

- [ ] **Step 6: Effect resolve deep-link**

Thêm ngay dưới `handleOpenProduct` (dòng ~497):

```ts
  const consumedRef = useRef<string | null>(null);
  useEffect(() => {
    const outcome = deepLinkOutcome(
      openVariantId,
      loading,
      consumedRef.current,
      (id) => allProducts.some((item) => item.id === id),
    );
    if (outcome.kind === 'idle') return;
    if (outcome.kind === 'reset') {
      consumedRef.current = null;
      return;
    }
    consumedRef.current = openVariantId ?? null;
    if (outcome.kind === 'missing') {
      // Do NOT call onExitExternal() here. setToast + onExitExternal batch into one
      // render: App switches tab, ProductModule unmounts, and the toast never paints.
      // Leave the operator on the products tab with the message. App clears the stale
      // request as soon as they navigate away, and consumedRef stops a reopen loop.
      consumedRef.current = openVariantId ?? null;
      setToast({ kind: 'error', text: tOr(t, 'products.deepLink.notFound', 'Product is no longer in the local catalog. Sync products and try again.') });
      return;
    }
    const product = allProducts.find((item) => item.id === outcome.productId)!;
    setSelectedProduct(product);
    setView({ name: 'edit', productId: product.id, returnTo: { name: 'external' } });
  }, [openVariantId, loading, allProducts, onExitExternal, t]);
```

- [ ] **Step 7: Truyền `backLabel` xuống `ProductEditView`**

Trong khối render `<ProductEditView ...>` (dòng ~791), thêm ngay trên `onBack={returnFromEdit}`:

```tsx
          backLabel={isExternalEdit(view) ? externalBackLabel : undefined}
```

- [ ] **Step 8: Thêm key i18n `products.deepLink.notFound`**

Block `en`:
```ts
    'products.deepLink.notFound': 'Product is no longer in the catalog',
```
Block `vi`:
```ts
    'products.deepLink.notFound': 'Sản phẩm không còn trong catalog',
```
Block `pl`:
```ts
    'products.deepLink.notFound': 'Produktu nie ma juz w katalogu',
```

- [ ] **Step 9: Typecheck**

```bash
ssh winpc "cd C:\POS-zira && npm run typecheck:renderer"
```

Expected: exit 0. Nếu TS báo `backLabel` không tồn tại trên `ProductEditView` — đúng, Task 9 thêm nó. Làm Task 9 rồi chạy lại.

- [ ] **Step 10: Commit** (sau khi Task 9 xong và typecheck sạch)

```bash
ssh winpc "cd C:\POS-zira && git add src/renderer/components/products/ProductModule.tsx src/renderer/i18n/translations.ts tests/product-module-static.test.ts && git commit -m \"feat(products): open the edit view from a deep link\""
```

---

## Task 9: `ProductEditView` nhận `backLabel`

**Files:**
- Modify: `src/renderer/components/products/ProductEditView.tsx` (props ~dòng 33, destructure ~94, render ~209-211)

**Interfaces:**
- Produces: prop `backLabel?: string`. Task 8 truyền vào.

- [ ] **Step 1: Thêm prop vào interface**

Ngay trên `onBack: () => void;` (dòng 33):

```ts
  /** Overrides the header back-button label — e.g. when a sale line opened this view. */
  backLabel?: string;
```

- [ ] **Step 2: Destructure**

Trong danh sách destructure, ngay trên `onBack,` (dòng 94):

```ts
  backLabel,
```

- [ ] **Step 3: Dùng nó trong header**

Dòng 210-211, đổi:

```tsx
          <ChevronLeft size={18} />
          {backLabel || tOr(t, 'products.back', 'Back')}
```

- [ ] **Step 4: Typecheck**

```bash
ssh winpc "cd C:\POS-zira && npm run typecheck:renderer"
```

Expected: exit 0.

- [ ] **Step 5: Commit** — gộp cùng Task 8 Step 10.

---

## Task 10: Nút bút chì trên dòng giỏ hàng

`Cart` có sẵn `renderItemExtra`, nhưng nó render **dưới** dòng và `RestaurantTemplate` đang chiếm chỗ đó. Dùng prop riêng để nút nằm trong hàng nút sẵn có.

**Files:**
- Modify: `src/renderer/components/pos/CartItem.tsx` (import icon, props, khối nút ~196-239)
- Modify: `src/renderer/components/pos/Cart.tsx` (props ~16, destructure ~558, render ~854)
- Modify: `src/renderer/i18n/translations.ts` (1 key × 3 locale)

**Interfaces:**
- Produces: `CartProps.onEditProduct?: (item: CartItem) => void` và `CartItemProps.onEditProduct?: (item: CartItemType) => void`. Task 11 truyền vào.

- [ ] **Step 1: Thêm key i18n**

Block `en`: `'pos.cart.editProduct': 'Edit product',`
Block `vi`: `'pos.cart.editProduct': 'Sửa sản phẩm',`
Block `pl`: `'pos.cart.editProduct': 'Edytuj produkt',`

- [ ] **Step 2: `CartItem.tsx` — import icon**

Dòng 2, thêm `Pencil` (khác `PencilLine` đang dùng cho ghi chú):

```ts
import { Pencil, PencilLine, Printer, Scale, StickyNote, Trash2 } from 'lucide-react';
```

- [ ] **Step 3: `CartItem.tsx` — prop**

Trong `interface CartItemProps`, dưới `onRemove`:

```ts
  /** Opens the Products tab on this line's variant. Omitted when the operator may not edit products. */
  onEditProduct?: (item: CartItemType) => void;
```

Thêm `onEditProduct,` vào destructure của `CartItemRow`.

- [ ] **Step 4: `CartItem.tsx` — vẽ nút**

Ngay trên nút Remove (dòng ~230, `<button ... onClick={() => onRemove(item.id)}`), chèn:

```tsx
          {onEditProduct && item.variantId ? (
            <button
              type="button"
              onClick={() => onEditProduct(item)}
              aria-label={tOr('pos.cart.editProduct', 'Edit product')}
              title={tOr('pos.cart.editProduct', 'Edit product')}
              className="h-11 w-11 flex items-center justify-center rounded-lg border border-slate-200 bg-white text-slate-600 hover:border-brand-300 hover:text-brand-800 hover:bg-brand-50 cursor-pointer touch-manipulation shrink-0 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-200"
            >
              <Pencil size={14} strokeWidth={2.4} aria-hidden="true" />
            </button>
          ) : null}
```

- [ ] **Step 5: `Cart.tsx` — prop + truyền xuống**

Trong `interface CartProps`, dưới `onPrintItemLabel`:

```ts
  /** Opens the Products tab on a cart line's variant. Absent = the pencil is not rendered. */
  onEditProduct?: (item: CartItem) => void;
```

Thêm `onEditProduct,` vào destructure (dòng ~558).

Trong `<CartItemRow ...>` (dòng ~854), thêm ngay dưới `onPrintLabel={onPrintItemLabel}`:

```tsx
                onEditProduct={onEditProduct}
```

- [ ] **Step 6: Typecheck**

```bash
ssh winpc "cd C:\POS-zira && npm run typecheck:renderer"
```

Expected: exit 0.

- [ ] **Step 7: Commit**

```bash
ssh winpc "cd C:\POS-zira && git add src/renderer/components/pos/CartItem.tsx src/renderer/components/pos/Cart.tsx src/renderer/i18n/translations.ts && git commit -m \"feat(pos): pencil on a cart line opens the product editor\""
```

---

## Task 11: `POSLayout` → `RetailTemplate` → `Cart`

`RetailTemplate` là template duy nhất được nối ở v1 (chế độ bán lẻ). `RestaurantTemplate` và `B2BTemplate` cũng render `Cart` nhưng không truyền prop nên không có nút.

**Files:**
- Modify: `src/renderer/components/pos/POSLayout.tsx` (props ~255-256, signature ~287, render `<RetailTemplate>` ~1618)
- Modify: `src/renderer/components/pos/templates/retail/RetailTemplate.tsx` (props ~207, signature ~217, render `<Cart>` ~1432)

**Interfaces:**
- Consumes: `CartProps.onEditProduct` (Task 10).
- Produces: `POSLayoutProps.onEditProduct?: (variantId: string) => void`. Task 12 truyền vào.

- [ ] **Step 1: `POSLayout.tsx` — prop**

Dòng 255-257:

```ts
interface POSLayoutProps {
  onFullscreen?: () => void;
  /** Opens the Products tab on a variant. App omits it in kiosk fullscreen and when the
   *  operator lacks canUpdateProduct — the pencil then never renders. */
  onEditProduct?: (variantId: string) => void;
}
```

Dòng 287:

```ts
export default function POSLayout({ onFullscreen, onEditProduct }: POSLayoutProps = {}) {
```

- [ ] **Step 2: `POSLayout.tsx` — truyền xuống `RetailTemplate`**

Trong `<RetailTemplate ...>` (dòng ~1618), thêm dưới `homeResetKey={homeResetKey}`:

```tsx
            onEditProduct={onEditProduct}
```

- [ ] **Step 3: `RetailTemplate.tsx` — prop**

Trong `interface RetailTemplateProps` (dòng ~214), thêm trên `homeResetKey?: number;`:

```ts
  onEditProduct?: (variantId: string) => void;
```

Thêm `onEditProduct` vào destructure ở dòng 217.

- [ ] **Step 4: `RetailTemplate.tsx` — adapter + truyền vào `Cart`**

`CartItem` đã được import sẵn ở dòng 4. Đảm bảo `useCallback` có trong import React đầu file (`import React, { useCallback, ... } from 'react';`) — nếu chưa, thêm vào. Rồi thêm callback gần các `useCallback` khác:

```ts
  const handleEditCartProduct = useCallback((item: CartItem) => {
    // Service / manual lines carry no variantId — nothing to open.
    if (item.variantId) onEditProduct?.(item.variantId);
  }, [onEditProduct]);
```

Trong `<Cart ...>` (dòng ~1432), thêm dưới `onPrintItemLabel={handlePrintCartItemCode}`:

```tsx
            onEditProduct={onEditProduct ? handleEditCartProduct : undefined}
```

- [ ] **Step 5: Typecheck**

```bash
ssh winpc "cd C:\POS-zira && npm run typecheck:renderer"
```

Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
ssh winpc "cd C:\POS-zira && git add src/renderer/components/pos/POSLayout.tsx src/renderer/components/pos/templates/retail/RetailTemplate.tsx && git commit -m \"feat(pos): thread the product-edit request through the retail template\""
```

---

## Task 12: `App` làm trạm trung chuyển

**Files:**
- Modify: `src/renderer/App.tsx`
- Modify: `src/renderer/i18n/translations.ts` (2 key × 3 locale)
- Test: `tests/product-edit-deeplink-wiring.test.ts`

**Interfaces:**
- Consumes: `useProductAdminCapabilities`, `resetProductAdminCapabilitiesCache` (Task 7); `POSLayoutProps.onEditProduct` (Task 11); `ProductModuleProps.openVariantId/onExitExternal/externalBackLabel` (Task 8); `OrdersTabProps.onEditProduct` (Task 13).

- [ ] **Step 1: Thêm key i18n**

Block `en`:
```ts
    'products.backToCart': 'Back to cart',
    'products.backToOrder': 'Back to order',
```
Block `vi`:
```ts
    'products.backToCart': 'Về giỏ hàng',
    'products.backToOrder': 'Về đơn hàng',
```
Block `pl`:
```ts
    'products.backToCart': 'Powrot do koszyka',
    'products.backToOrder': 'Powrot do zamowienia',
```

- [ ] **Step 2: Viết test fail**

Tạo `tests/product-edit-deeplink-wiring.test.ts`:

```ts
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(__dirname, '..');
const source = (path: string): string =>
  readFileSync(resolve(root, path), 'utf8').replace(/\r\n/g, '\n');

const APP = source('src/renderer/App.tsx');
const POS_LAYOUT = source('src/renderer/components/pos/POSLayout.tsx');
const RETAIL = source('src/renderer/components/pos/templates/retail/RetailTemplate.tsx');
const CART = source('src/renderer/components/pos/Cart.tsx');
const CART_ITEM = source('src/renderer/components/pos/CartItem.tsx');
const ORDERS = source('src/renderer/components/OrdersTab.tsx');
const PRODUCT_MODULE = source('src/renderer/components/products/ProductModule.tsx');
const CAPABILITIES_HOOK = source('src/renderer/hooks/useProductAdminCapabilities.ts');

describe('deep-link plumbing', () => {
  it('App owns the request and hands it to ProductModule', () => {
    expect(APP).toContain('productEditRequest');
    expect(APP).toContain('openVariantId={productEditRequest?.variantId}');
    expect(APP).toContain('onExitExternal={exitProductEdit}');
  });

  it('App clears a stale request when the user leaves the products tab', () => {
    expect(APP).toMatch(/activeTab !== 'products'/);
  });

  it('App drops the capabilities cache when the user changes', () => {
    expect(APP).toContain('resetProductAdminCapabilitiesCache()');
  });

  it('App does not cache a pre-login no-auth capabilities response', () => {
    expect(APP).toContain('useProductAdminCapabilities(isAuthenticated)');
    expect(CAPABILITIES_HOOK).toContain('if (!enabled)');
    expect(CAPABILITIES_HOOK).toContain('cache = next.error ? null : next');
  });

  it('the kiosk fullscreen POS branch never receives onEditProduct', () => {
    const kioskBranch = APP.slice(
      APP.indexOf('if (isPosFullscreen'),
      APP.indexOf('// Fullscreen check-in mode'),
    );
    expect(kioskBranch.length).toBeGreaterThan(0);
    expect(kioskBranch).not.toContain('onEditProduct');
  });

  it('the prop is threaded POSLayout -> RetailTemplate -> Cart -> CartItem', () => {
    expect(POS_LAYOUT).toContain('onEditProduct?: (variantId: string) => void');
    expect(POS_LAYOUT).toContain('onEditProduct={onEditProduct}');
    expect(RETAIL).toContain('handleEditCartProduct');
    expect(CART).toContain('onEditProduct?: (item: CartItem) => void');
    expect(CART).toContain('onEditProduct={onEditProduct}');
    expect(CART_ITEM).toContain('onEditProduct && item.variantId');
  });

  it('Orders lines expose variant_id and the pencil', () => {
    expect(ORDERS).toContain('variant_id?: string | null');
    expect(ORDERS).toContain("'orders.item.editProduct'");
  });

  it('ProductModule never calls getCapabilities directly any more', () => {
    expect(PRODUCT_MODULE).not.toContain('pos.productAdmin.getCapabilities');
    expect(PRODUCT_MODULE).toContain('useProductAdminCapabilities');
  });
});
```

- [ ] **Step 3: Chạy để xác nhận nó fail**

```bash
ssh winpc "cd C:\POS-zira && npx vitest run tests/product-edit-deeplink-wiring.test.ts"
```

Expected: FAIL (App chưa có gì; Orders chưa có `variant_id`).

- [ ] **Step 4: `App.tsx` — import**

Thêm cạnh các import hook:

```ts
import { resetProductAdminCapabilitiesCache, useProductAdminCapabilities } from './hooks/useProductAdminCapabilities';
```

- [ ] **Step 5: `App.tsx` — state + handlers**

Ngay dưới `const [touchKeyboardHeight, setTouchKeyboardHeight] = useState(0);` (dòng 67):

```ts
  /** A sale line (cart or order) asked to edit a product. Cleared on leaving the products tab. */
  const [productEditRequest, setProductEditRequest] = useState<{ variantId: string; returnTo: Tab } | null>(null);
```

Ngay dưới `const { entitlements, ... } = useEntitlements();` (dòng 73):

```ts
  const { capabilities: productAdminCapabilities } = useProductAdminCapabilities(isAuthenticated);
```

Ngay dưới `const isTabAvailable = useCallback(...)` (dòng 134):

```ts
  const canEditProductsFromSale = productAdminCapabilities?.canUpdateProduct === true
    && visibleTabs.includes('products');

  const requestProductEdit = useCallback((variantId: string, returnTo: Tab) => {
    if (!variantId || !visibleTabs.includes('products')) return;
    setProductEditRequest({ variantId, returnTo });
    setActiveTab('products');
  }, [visibleTabs]);

  const exitProductEdit = useCallback(() => {
    if (!productEditRequest) return;
    setActiveTab(productEditRequest.returnTo);
    setProductEditRequest(null);
  }, [productEditRequest]);

  // A request must not outlive the tab it targets: the user may leave via the sidebar.
  useEffect(() => {
    if (activeTab !== 'products' && productEditRequest) setProductEditRequest(null);
  }, [activeTab, productEditRequest]);
```

- [ ] **Step 6: `App.tsx` — nhãn nút Back**

Ngay dưới `const keyboardT = getTranslation(keyboardLanguage);` (dòng 309):

```ts
  const appT = getTranslation(appLanguage);
  const tOrApp = (key: string, fallback: string): string => {
    const value = appT(key);
    return value && value !== key ? value : fallback;
  };
  const productEditBackLabel = productEditRequest?.returnTo === 'orders'
    ? tOrApp('products.backToOrder', 'Back to order')
    : tOrApp('products.backToCart', 'Back to cart');
```

- [ ] **Step 7: `App.tsx` — xoá cache khi đổi user / login**

Trong `handleLoginSuccess`, thêm ngay đầu hàm trước `setAuthUser(user);`:

```ts
    resetProductAdminCapabilitiesCache();
```

Trong `clearRendererState` (dòng 252), thêm ngay dưới `try { window.localStorage.removeItem('pos.heldCarts'); } catch {}`:

```ts
    // The capabilities cache is module-scope; `key={sessionKey}` does not clear it.
    resetProductAdminCapabilitiesCache();
```

- [ ] **Step 8: `App.tsx` — nối 3 tab**

Dòng 466, đổi:

```tsx
              {activeTab === 'pos' && isTabAvailable('pos') && (
                <POSLayout
                  onFullscreen={() => { setIsPosFullscreen(true); window.electronAPI.window.setKiosk(true); }}
                  onEditProduct={canEditProductsFromSale ? (variantId) => requestProductEdit(variantId, 'pos') : undefined}
                />
              )}
```

Dòng 495-497, đổi:

```tsx
              {activeTab === 'orders' && isTabAvailable('orders') && (
                <OrdersTab
                  language={(config?.language as Language) || 'en'}
                  onEditProduct={canEditProductsFromSale ? (variantId) => requestProductEdit(variantId, 'orders') : undefined}
                />
              )}
```

Dòng 498-500, đổi:

```tsx
              {activeTab === 'products' && isTabAvailable('products') && (
                <ProductModule
                  language={(config?.language as Language) || 'en'}
                  openVariantId={productEditRequest?.variantId}
                  onExitExternal={exitProductEdit}
                  externalBackLabel={productEditBackLabel}
                />
              )}
```

**Không** đụng nhánh kiosk fullscreen (dòng 380, `<POSLayout />`). Nó phải tiếp tục không nhận `onEditProduct`.

- [ ] **Step 9: Chạy test (Orders vẫn fail) + typecheck**

```bash
ssh winpc "cd C:\POS-zira && npx vitest run tests/product-edit-deeplink-wiring.test.ts"
```

Expected: mọi test PASS trừ `Orders lines expose variant_id and the pencil` — Task 13 làm nốt.

- [ ] **Step 10: Commit** (sau Task 13)

---

## Task 13: `OrdersTab` — `variant_id` + nút bút chì

`pos:orders:getDetail` (`src/main/modules/pos.module.ts:2477`) trả thẳng `orderRepo.getItemsByOrderId()`, và `OrderItem` trong repo **đã có** `variant_id` (`src/main/database/repos/order-repo.ts:56`). Chỉ interface phía renderer khai thiếu.

**Files:**
- Modify: `src/renderer/components/OrdersTab.tsx` (import icon ~2, props ~10, `OrderItemRow` ~39, ô tên ~612)
- Modify: `src/renderer/i18n/translations.ts` (1 key × 3 locale)

**Interfaces:**
- Produces: `OrdersTabProps.onEditProduct?: (variantId: string) => void`. Task 12 truyền vào.

- [ ] **Step 1: Thêm key i18n**

Block `en`: `'orders.item.editProduct': 'Edit product',`
Block `vi`: `'orders.item.editProduct': 'Sửa sản phẩm',`
Block `pl`: `'orders.item.editProduct': 'Edytuj produkt',`

- [ ] **Step 2: Import icon**

Dòng 2:

```ts
import { ChevronDown, ChevronRight, Pencil, Printer, RefreshCw, Search } from 'lucide-react';
```

- [ ] **Step 3: Props**

Dòng 10-12:

```ts
interface OrdersTabProps {
  language: Language;
  /** Opens the Products tab on an order line's variant. Absent = no pencil. */
  onEditProduct?: (variantId: string) => void;
}
```

Thêm `onEditProduct` vào destructure của component.

- [ ] **Step 4: `OrderItemRow` khai `variant_id`**

Dòng 39-51, thêm sau `order_id: string;`:

```ts
  /** Present for catalog lines; null on manual lines and some server-mirrored orders. */
  variant_id?: string | null;
```

- [ ] **Step 5: Vẽ nút trong ô tên**

Dòng ~612, thay `<td>` đầu tiên:

```tsx
                                    <td className="py-1 pr-2 text-slate-800">
                                      {item.name}
                                      {item.sku ? <span className="ml-2 text-xs text-slate-400">{item.sku}</span> : null}
                                      {onEditProduct && item.variant_id ? (
                                        <button
                                          type="button"
                                          onClick={() => onEditProduct(item.variant_id as string)}
                                          aria-label={tOr(t, 'orders.item.editProduct', 'Edit product')}
                                          title={tOr(t, 'orders.item.editProduct', 'Edit product')}
                                          className="ml-2 inline-flex h-7 w-7 items-center justify-center rounded-md border border-slate-200 align-middle text-slate-500 hover:border-brand-300 hover:bg-brand-50 hover:text-brand-800"
                                        >
                                          <Pencil size={13} strokeWidth={2.4} aria-hidden="true" />
                                        </button>
                                      ) : null}
                                    </td>
```

- [ ] **Step 6: Chạy test + typecheck**

```bash
ssh winpc "cd C:\POS-zira && npx vitest run tests/product-edit-deeplink-wiring.test.ts && npm run typecheck:renderer"
```

Expected: 8 tests PASS; typecheck exit 0.

- [ ] **Step 7: Commit**

```bash
ssh winpc "cd C:\POS-zira && git add src/renderer/App.tsx src/renderer/components/OrdersTab.tsx src/renderer/i18n/translations.ts tests/product-edit-deeplink-wiring.test.ts && git commit -m \"feat(app): route cart and order lines into the product editor\""
```

---

## Task 14: Cảnh báo VAT khi sản phẩm đang trong giỏ

`buildReceiptItems` đọc `order_items.vat_rate` (snapshot), nên đổi VAT **không** áp cho dòng đang nằm trong giỏ. Nói thật thay vì im lặng.

**Files:**
- Modify: `src/renderer/components/products/ProductEditForm.tsx` (props ~34, `handleSave` ~309)
- Modify: `src/renderer/components/products/ProductEditView.tsx` (prop type ~37, `onSaved` ~360)
- Modify: `src/renderer/components/products/ProductModule.tsx` (`ProductSaveOutcome` ~32, `handleProductSaved` ~534)
- Modify: `src/renderer/i18n/translations.ts` (1 key × 3 locale)

**Interfaces:**
- Produces: `ProductSaveOutcome` mở rộng thành `{ stockBefore?: number; stockAfter?: number; vatChanged?: boolean }`, dùng ở cả ba file trên.

- [ ] **Step 1: Thêm key i18n**

Block `en`:
```ts
    'products.edit.vatChangedInCart': 'VAT changed. The cart line keeps the old VAT — remove and re-add it to apply the new rate.',
```
Block `vi`:
```ts
    'products.edit.vatChangedInCart': 'VAT đã đổi. Dòng trong giỏ vẫn giữ VAT cũ — xoá và thêm lại nếu muốn áp mức mới.',
```
Block `pl`:
```ts
    'products.edit.vatChangedInCart': 'Stawka VAT zmieniona. Pozycja w koszyku zachowuje stara stawke — usun i dodaj ponownie.',
```

- [ ] **Step 2: `ProductEditForm.tsx` — báo cáo `vatChanged`**

Đổi kiểu prop `onSaved` (dòng 34):

```ts
  onSaved: (outcome: { stockBefore?: number; stockAfter?: number; vatChanged?: boolean }) => Promise<void> | void;
```

Trong `handleSave` (dòng 309), đổi lời gọi:

```ts
      await onSaved({
        stockBefore: stockDirty ? currentStock(product) : undefined,
        stockAfter: stockDirty ? parsedStockQty ?? 0 : undefined,
        vatChanged: vatRate !== String(originalVatRate),
      });
```

- [ ] **Step 3: `ProductEditView.tsx` — chuyển tiếp**

Đổi kiểu prop (dòng 37):

```ts
  onProductSaved: (product: ProductListItem, outcome: { stockBefore?: number; stockAfter?: number; vatChanged?: boolean }) => Promise<void> | void;
```

Lời gọi ở dòng 360-363 giữ nguyên — nó đã truyền nguyên `outcome`.

- [ ] **Step 4: `ProductModule.tsx` — cảnh báo**

Đổi type (dòng 32):

```ts
type ProductSaveOutcome = { stockBefore?: number; stockAfter?: number; vatChanged?: boolean };
```

Đổi `handleProductSaved` (dòng 534):

```ts
  const handleProductSaved = useCallback((product: ProductListItem, outcome: ProductSaveOutcome) => {
    // The cart line carries a vat_rate snapshot and the receipt reads THAT, so a
    // VAT change never reaches a sale already in progress. Say so out loud.
    if (outcome.vatChanged && selectedProductInCart) {
      setToast({
        kind: 'error',
        text: tOr(t, 'products.edit.vatChangedInCart', 'VAT changed. The cart line keeps the old VAT — remove and re-add it to apply the new rate.'),
      });
      return;
    }
    if (typeof outcome.stockBefore === 'number' && typeof outcome.stockAfter === 'number') {
      setToast({ kind: 'success', text: stockToastText(t, outcome.stockBefore, outcome.stockAfter) });
      return;
    }
    setToast({
      kind: 'success',
      text: `${tOr(t, 'products.edit.success', 'Product saved')}: ${productDisplayName(product, language)}`,
    });
  }, [language, selectedProductInCart, t]);
```

- [ ] **Step 5: Typecheck**

```bash
ssh winpc "cd C:\POS-zira && npm run typecheck:renderer"
```

Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
ssh winpc "cd C:\POS-zira && git add src/renderer/components/products/ src/renderer/i18n/translations.ts && git commit -m \"feat(products): warn when a VAT change cannot reach the open cart line\""
```

---

## Task 15: Verify toàn bộ

- [ ] **Step 1: Toàn bộ test**

```bash
ssh winpc "cd C:\POS-zira && npx vitest run"
```

Expected: **chỉ còn 2 test fail có sẵn** trong `tests/product-admin-create-contract.test.ts`. Nếu baseline chưa đổi, số test pass phải là **1752 + 42 = 1794** (Task 1: 4 · Task 2: 5 · Task 3: 4 · Task 4: 5 · Task 5: 2 · Task 6: 13 · Task 7: 1 · Task 12+13: 8). Nếu số tổng lệch vì nhánh đã có thêm test khác, nguyên tắc là không được có file fail mới ngoài baseline đã ghi.

- [ ] **Step 2: Typecheck + build**

```bash
ssh winpc "cd C:\POS-zira && npm run typecheck:renderer && npm run build:main && npm run build:renderer"
```

Expected: cả ba exit 0.

- [ ] **Step 3: Smoke tay trên máy** (người dùng chạy, không phải agent)

1. Mở app, tab POS chế độ retail. Thêm một sản phẩm **có** `name_translations.pl` vào giỏ (ví dụ barcode `2653586095311` — `Cật (thận lợn)` / `Nerka`).
2. Bấm nút bút chì trên dòng đó → tab Products mở thẳng màn edit đúng sản phẩm, nút Back ghi **"Về giỏ hàng"**.
3. Ô **"Tên trên hoá đơn / fiscal (Ba Lan)"** hiện ngay dưới ô "Tên gốc", **không** phải mở `Advanced`. Dưới nó ghi `In ra: Nerka`.
4. Xoá trắng ô Ba Lan → cảnh báo vàng đổi thành `Bỏ trống → hoá đơn in tên gốc: Cật (thận lợn)` kèm `ELZAB bỏ dấu thành: Cat (than lon)`.
5. Gõ lại `Nerka`, Lưu, bấm Back → về tab POS, **giỏ hàng còn nguyên**.
6. Thanh toán → hoá đơn in `Nerka`.
7. Sang tab Orders, mở chi tiết đơn vừa bán → dòng có nút bút chì → bấm → mở đúng sản phẩm, Back ghi **"Về đơn hàng"**.
8. Bật POS fullscreen kiosk (nút toàn màn hình ở Sidebar) → **không có nút bút chì nào** trên dòng giỏ.
9. Đăng nhập bằng tài khoản không có `canUpdateProduct` → không có nút bút chì ở cả POS lẫn Orders.

- [ ] **Step 4: Commit cuối nếu có chỉnh sửa từ smoke**

---

## Ghi chú cho reviewer (bot app)

- **Không có thay đổi backend.** `product-admin.service.ts:96-107` đã trả `version: 2` + `canEditDisplayName`, `UpdateProductAdminVariantDto:154` đã nhận `nameTranslations`. Không migration, không deploy Contabo.
- **Hai chỗ dễ vỡ nhất** đã bị cô lập vào `product-view-nav.ts` và có test riêng: `returnFromEdit` gọi `onExitExternal` **ngoài** updater của `setView`; và effect "sản phẩm biến mất" (`ProductModule.tsx:419`) không được đẩy `{name:'external'}` vào view state.
- **`consumedRef` phải reset khi `openVariantId` rỗng**, nếu không mở lại cùng một sản phẩm lần thứ hai sẽ bị chặn im lặng.
- **`resetProductAdminCapabilitiesCache()` phải nằm trong `clearRendererState()`** — cache sống ngoài cây React nên `key={sessionKey}` không dọn nó.
- **Cố ý không refresh dòng giỏ sau khi sửa.** Hoá đơn đọc tên sống từ catalog local (`getReceiptItemName`), nên tờ giấy đã đúng. Thêm `cart/refreshItem` sẽ ghi đè mất giá đã sửa tay qua `cart/setItemPrice` (không có cờ phân biệt) mà chẳng đổi được gì trên giấy.

## Việc để lại (không nằm trong plan này)

1. **`CreateProductAdminProductDto` không nhận `nameTranslations`** → sản phẩm tạo từ POS không thể có tên Ba Lan ngay lúc tạo. Task 5 chỉ cảnh báo. Sửa tận gốc cần thêm field vào DTO backend + `createProductVariant` phía app.
2. **Docstring của `UpdateProductAdminVariantDto.nameTranslations`** (`backend/.../product-admin.dto.ts:147-149`) viết *"Does NOT change the canonical `name` used by receipts/invoices/orders"* — sai với hoá đơn: hoá đơn dùng `nameTranslations.pl`. Sửa comment, không đổi runtime.
3. **40 sản phẩm chưa có tên PL** trong catalog Chè Sài Gòn sẽ in tên tiếng Việt. Cảnh báo đã có; điền dần bằng tay.
4. `RestaurantTemplate` / `B2BTemplate` chưa có nút bút chì (cả hai đều render `Cart`, chỉ cần truyền prop).
5. `OrderHistoryModal` trong tab POS chưa có nút — nhảy tab sẽ đóng modal và unmount POS.
