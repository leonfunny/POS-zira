# POS Scan Import Keyboard-Aware Modal Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Giữ toàn bộ field và nút hành động của modal nhập hàng nháp trong POS nhìn thấy hoặc cuộn tới được khi bàn phím cảm ứng mở, kể cả ở viewport thấp.

**Architecture:** Giữ nguyên bàn phím dùng chung, giao diện tối của `ScanImportModal`, state và luồng import hiện tại. Áp lại contract keyboard-aware đã có ở Products: lấy `--touch-keyboard-inset` do `App.tsx` đo từ bàn phím, thu chiều cao overlay/panel theo `100dvh`, để phần nội dung làm scroll owner, giữ footer ngoài vùng scroll và dùng `useKeyboardAwareFocus` để đưa field đang focus vào vùng nhìn thấy sau khi viewport ổn định.

**Tech Stack:** Electron 33, React 18, TypeScript 5.7, Tailwind CSS 3, Vitest 4.

---

## Kết quả kiểm tra trước khi lập plan

- `ProductCreateDialog.tsx` đã dùng keyboard-aware layout; `ScanImportModal.tsx` vẫn là overlay `fixed inset-0` căn giữa toàn viewport và không trừ chiều cao bàn phím.
- Bàn phím POS và Products thực tế là cùng `src/renderer/components/shared/TouchKeyboard.tsx`; lỗi nằm ở modal POS, không nằm ở kích thước hay layout phím.
- `App.tsx` đã đo đúng chiều cao render của bàn phím và xuất `--touch-keyboard-inset`; không cần thêm state, event hoặc magic number.
- Baseline ngày 2026-07-17: 33 focused tests pass và `npm run typecheck:renderer` pass.
- Test hình ảnh bắt buộc phải bao gồm `1280x720`; màn rộng chỉ là control case, không chứng minh được lỗi đã hết.

## Phạm vi file

- Modify: `src/renderer/components/pos/ScanImportModal.tsx` — làm overlay/panel keyboard-aware, tạo vùng body có scroll và giữ footer luôn khả dụng.
- Modify: `tests/pos-touch-keyboard-inset.test.ts` — khóa contract responsive của modal nhập hàng nháp.
- Không sửa: `src/renderer/components/shared/TouchKeyboard.tsx`, `src/renderer/App.tsx`, `src/renderer/components/pos/POSLayout.tsx`, preload, IPC, database hoặc backend.

## Tiêu chí hoàn thành

- Khi field giá tự focus và numeric keyboard mở, modal nằm hoàn toàn trong phần viewport còn lại phía trên bàn phím.
- Ở `1280x720`, người dùng luôn thấy footer Hủy/Thêm sản phẩm; body cuộn được đến giá, tồn kho, danh mục và lỗi.
- Khi focus đổi giữa giá và tồn kho, field đang focus được scroll vào giữa vùng body sau resize/animation của bàn phím.
- Ở viewport rộng, modal giữ nguyên chiều rộng tối đa, visual tối và hành vi import hiện tại.
- Giá vẫn dùng keypad thập phân; tồn kho vẫn dùng keypad số nguyên; category, validation, loading và submit payload không đổi.

### Task 1: Thêm regression test rồi áp keyboard-aware contract vào ScanImportModal

**Files:**
- Modify: `tests/pos-touch-keyboard-inset.test.ts:8-10,45-52`
- Modify: `src/renderer/components/pos/ScanImportModal.tsx:1-2,90-94,124-132,140-231`

- [ ] **Step 1: Viết test thất bại cho modal nhập hàng nháp**

Trong `tests/pos-touch-keyboard-inset.test.ts`, thêm source fixture ngay sau các hằng số source hiện tại:

```ts
const SCAN_IMPORT_MODAL = fs.readFileSync(
  path.join(ROOT, 'src/renderer/components/pos/ScanImportModal.tsx'),
  'utf8',
);
```

Thêm test này trong `describe('POS touch keyboard inset', ...)`:

```ts
it('keeps the scan-import modal and focused fields above the measured keyboard inset', () => {
  expect(SCAN_IMPORT_MODAL).toContain('useKeyboardAwareFocus');
  expect(SCAN_IMPORT_MODAL).toContain('const panelRef = useRef<HTMLDivElement | null>(null)');
  expect(SCAN_IMPORT_MODAL).toContain("bottom: 'var(--touch-keyboard-inset, 0px)'");
  expect(SCAN_IMPORT_MODAL).toContain("maxHeight: 'calc(100dvh - var(--touch-keyboard-inset, 0px) - 2rem)'");
  expect(SCAN_IMPORT_MODAL).toContain('onFocusCapture={handleKeyboardAwareFocus}');
  expect(SCAN_IMPORT_MODAL).toContain('className="min-h-0 overflow-y-auto"');
  expect(SCAN_IMPORT_MODAL).toContain('className="flex shrink-0 gap-3 border-t');
});
```

- [ ] **Step 2: Chạy test để chứng minh regression chưa được bảo vệ**

Run:

```powershell
npx vitest run tests/pos-touch-keyboard-inset.test.ts --reporter=verbose
```

Expected: FAIL tại test mới vì `ScanImportModal.tsx` chưa dùng `useKeyboardAwareFocus` và chưa đọc `--touch-keyboard-inset`.

- [ ] **Step 3: Kết nối modal với focus-rescroll hook hiện có**

Đổi import React đầu file và thêm hook import:

```ts
import React, { useEffect, useRef, useState } from 'react';
import { useKeyboardAwareFocus } from '../../hooks/useKeyboardAwareFocus';
```

Ngay sau ba `useState` của `ScanImportModal`, thêm:

```ts
const panelRef = useRef<HTMLDivElement | null>(null);
const handleKeyboardAwareFocus = useKeyboardAwareFocus(panelRef, open);
```

- [ ] **Step 4: Thu overlay và panel theo chiều cao bàn phím thực tế**

Thay hai opening tag ngoài cùng của modal bằng đoạn sau; giữ nguyên `handleCancel` và toàn bộ nội dung con:

```tsx
<div
  className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 px-3 py-4"
  style={{ bottom: 'var(--touch-keyboard-inset, 0px)' }}
  onClick={handleCancel}
>
  <div
    ref={panelRef}
    className="flex w-full max-w-md flex-col overflow-hidden rounded-2xl border border-brand-500/40 bg-slate-800 shadow-2xl"
    style={{ maxHeight: 'calc(100dvh - var(--touch-keyboard-inset, 0px) - 2rem)' }}
    onClick={(event) => event.stopPropagation()}
    onFocusCapture={handleKeyboardAwareFocus}
  >
```

Điểm bắt buộc của đoạn này:

- Outer overlay dùng inline `bottom` để `inset-0` không tiếp tục chiếm vùng bàn phím.
- Panel dùng `flex-col` + `overflow-hidden`; không đặt `overflow-y-auto` lên toàn panel vì header/footer không được cuộn khỏi màn hình.
- Bỏ `mx-4` khỏi panel và dùng `px-3` ở overlay để chiều rộng không vượt viewport hẹp.

- [ ] **Step 5: Biến phần giữa thành scroll owner và giữ footer cố định trong panel**

Trong `ScanImportModal.tsx`:

1. Chèn opening tag sau ngay trước `{preview ? (` ở phần render:

```tsx
<div className="min-h-0 overflow-y-auto">
```

2. Chèn closing tag ngay sau conditional `error ? (...) : null` và trước footer:

```tsx
</div>
```

3. Đổi opening tag footer thành:

```tsx
<div className="flex shrink-0 gap-3 border-t border-slate-700 bg-slate-900/40 p-4">
```

Không chuyển nút Hủy/Thêm sản phẩm vào body scroll. Footer phải còn nhìn thấy ngay cả khi body chỉ còn một phần chiều cao nhỏ.

- [ ] **Step 6: Chạy test keyboard inset và scan-import regression**

Run:

```powershell
npx vitest run tests/pos-touch-keyboard-inset.test.ts tests/scan-import-price-override.test.ts tests/scan-import-category-selection.test.ts --reporter=verbose
```

Expected: 3 test files pass; test mới pass; các contract giá, tồn kho, danh mục và payload vẫn pass.

- [ ] **Step 7: Chạy typecheck**

Run:

```powershell
npm run typecheck:renderer
```

Expected: exit code 0, không có TypeScript error.

- [ ] **Step 8: Commit thay đổi code và regression test**

```powershell
git add src/renderer/components/pos/ScanImportModal.tsx tests/pos-touch-keyboard-inset.test.ts
git commit -m "fix(pos): keep scan import above touch keyboard"
```

### Task 2: Xác minh responsive behavior trong Electron thật

**Files:**
- Verify: `src/renderer/components/pos/ScanImportModal.tsx`
- Verify: `src/renderer/components/shared/TouchKeyboard.tsx`

- [ ] **Step 1: Build renderer/main trước khi smoke**

Run:

```powershell
npm run build
```

Expected: typecheck, main build và renderer build đều exit code 0.

- [ ] **Step 2: Smoke viewport thấp `1280x720` với draft đầy đủ field**

Mở app Electron ở cửa sổ `1280x720`, vào POS, mở một hàng nháp có danh mục local, để field giá auto-focus và bàn phím số hiện ra. Xác nhận bằng mắt và thao tác:

- Đỉnh bàn phím không đè lên panel.
- Header modal và footer Hủy/Thêm sản phẩm vẫn nhìn thấy.
- Body cuộn được từ preview qua Giá bán, Tồn kho cửa hàng, Danh mục và lỗi validation.
- Focus Giá bán đưa field giá vào vùng nhìn thấy và có phím `.`.
- Focus Tồn kho đưa field tồn kho vào vùng nhìn thấy và không có phím `.`.
- Nhấn `Xong` chỉ đóng bàn phím; dữ liệu modal không mất.

Expected: không có field hoặc CTA bị bàn phím che; không xuất hiện scroll ngang.

- [ ] **Step 3: Smoke viewport rộng `1600x900`**

Lặp lại cùng flow ở `1600x900`.

Expected: modal vẫn căn giữa phần viewport khả dụng, rộng tối đa như trước, không bị kéo giãn và không rung khi keyboard animation hoàn tất.

- [ ] **Step 4: Smoke Windows display scale**

Trên máy mục tiêu, lặp lại flow `1280x720` ở display scale 125% nếu thiết bị hỗ trợ. Focus lần lượt giá và tồn kho, cuộn đến danh mục, rồi submit một import hợp lệ.

Expected: field focus, footer và thông báo lỗi luôn nằm trên mép bàn phím; submit vẫn tạo đúng sản phẩm và thêm đúng cart line.

- [ ] **Step 5: Chạy regression gate cuối**

Run:

```powershell
npx vitest run tests/pos-touch-keyboard-inset.test.ts tests/modal-primitive.test.ts tests/scan-import-price-override.test.ts tests/scan-import-category-selection.test.ts tests/product-modal-accessibility.test.ts --reporter=verbose
npm run build
```

Expected: 5 focused test files pass và build exit code 0.

## Rủi ro và giới hạn

- Source-contract test khóa đúng cấu trúc đã dùng trong repo nhưng không thay thế Electron visual smoke; viewport `1280x720` và DPI thật là gate bắt buộc.
- Không dùng một số pixel cố định cho chiều cao bàn phím. `TouchKeyboard` có nhiều mode và chiều cao có thể đổi theo DPI/viewport.
- Không sửa shared `Modal` hoặc shared keyboard cho lỗi cục bộ này; thay đổi global sẽ làm tăng vùng regression không cần thiết.
- Không thay đổi theme tối của scan-import modal trong task này. Chuẩn hóa visual sang shared light modal là một yêu cầu riêng, không cần để giải quyết clipping.
