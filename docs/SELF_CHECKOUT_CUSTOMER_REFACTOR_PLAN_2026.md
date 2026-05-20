# Plan Refactor Màn Hình Khách Hàng Self-Checkout 2026

Trạng thái: implementation plan
Ngày: 2026-05-20
Phạm vi chính: `src/renderer/windows/self-checkout/`
Nguồn đầu vào: `docs/SELF_CHECKOUT_FRONTEND_UX_RESEARCH_2026.md`, `docs/SELF_CHECKOUT_DESIGN_BRIEF.md`, wiki troubleshooting self-checkout scanner/layout

## 1. Mục Tiêu

Refactor màn hình khách hàng self-checkout thành kiosk hiện đại theo hướng hybrid: scan-first cho sản phẩm có barcode, menu-first cho sản phẩm bếp/restaurant, cart và total luôn nhìn thấy, payment ngắn và rõ, receipt/finalizing có progress thật.

Không làm autonomous checkout, không làm landing page, không thêm design system mới. UI phải dùng pattern hiện có của repo: React, TypeScript, Tailwind utility classes, `lucide-react`, CSS token `--sc-*`.

## 2. Kết Luận Từ Code Hiện Tại

### Code map

- `SelfCheckoutApp.tsx`: state machine chính, load config, refresh catalog, scan/add product, help lock, idle warning, payment success, order create/sync/print.
- `WelcomeScreen.tsx`: màn hình bắt đầu, có `Grocery/Kitchen`, scanner capture và language switch.
- `ScanScreen.tsx`: màn hình lớn nhất; đang chứa scan prompt, scanner capture, search modal, department/category filtering, product grid, cart panel và checkout CTA trong một file.
- `PaymentScreen.tsx`: payment overlay hiện đang là assisted/manual flow: chọn cash/card/BLIK, phát voice announcement, đợi staff bấm "Money received".
- `ReceiptScreen.tsx`: có progress/fiscal printing, receipt pickup prompt và countdown.
- `ThankYouScreen.tsx`: success screen, auto reset.
- `UnavailableScreen.tsx`: closed state và localized reasons.
- `useScCart.ts`: cart localStorage, tiền dùng integer grosze.
- `build-sale.ts`: build payload `source: 'SELF_CHECKOUT'`, VAT included, canonical item names.
- `index.css`: đã có token, animation, compact-height CSS, payment responsive CSS.
- `tests/e2e/self-checkout-prd-smoke.mjs`: smoke test flow chính và compact viewport.

### Điểm mạnh đang có

- Scanner hoạt động ở welcome và shopping, có duplicate guard.
- Scan success có flash/beep/cart row animation/total tick.
- Cart lưu localStorage, tránh mất cart nếu Electron crash.
- Money đang đúng hướng: integer grosze, format ở UI.
- Localized display name không phá canonical receipt/order name.
- Help request lock kiosk.
- Receipt/finalizing đã có progress và staff call fallback.
- Compact POS2 đã có smoke test bảo vệ cart/payment/receipt clipping.

### Vấn đề cần sửa trước khi làm UI

1. `preload-display.ts` chưa expose đủ API mà kiosk đang gọi. `SelfCheckoutApp.tsx` dùng `pos.products.getAll`, `pos.products.search`, `pos.products.searchByCode`, `pos.sync.onProductsSynced`, và `selfCheckout.cancelHelp`, nhưng preload self-checkout hiện chỉ expose `getByBarcode`, `getByCategory`, `categories.getAll`, `orders.create`, `payment.printReceipt`, `payment.cardPayment`, `payment.onElavonStatus`, `sync.orders`, `helpRequest`, `checkStatus`, `close`. Vì self-checkout window dùng `preload-display`, menu/search/catalog refresh có thể rỗng ở runtime thật dù smoke test mock có đủ API.

2. `ScanScreen.tsx` comment nói scanner-only, nhưng code hiện có menu/category/product tiles/search. Đây là drift giữa quyết định sản phẩm và implementation. Plan phải chốt lại: customer kiosk là scan + menu.

3. `ScanScreen.tsx` quá lớn và ôm quá nhiều trách nhiệm. Refactor visual trực tiếp trong file này sẽ dễ gây regression scanner/search/cart.

4. `PaymentScreen.tsx` đang là assisted/manual payment, không phải unattended self-checkout hiện đại. Cash và manual BLIK phone transfer nên chỉ thuộc assisted mode.

5. `SELF_CHECKOUT_PRODUCTION_BLOCKERS` đang rỗng, trong khi operator tab vẫn hiển thị readiness. Nếu production chưa có terminal/fiscal/order readiness thật, UI đang dễ tạo cảm giác production-ready quá sớm.

6. `selfCheckoutFakePaymentEnabled` được operator tab lưu nhưng customer runtime chưa đọc/áp dụng rõ trong `SelfCheckoutApp.tsx`.

7. `Grocery` vẫn là text English trong PL và VI translations. Với kiosk ở Poland, PL nên dùng `Sklep` hoặc nhãn shop-specific.

8. Department `grocery/kitchen` đang phân loại category bằng heuristic text trong `ScanScreen.tsx`. Đây chỉ là fallback tạm, không phải model bền.

9. Smoke test hiện đang codify assisted BLIK/manual payment và production welcome vẫn có CTA. Khi chuyển sang terminal-driven/production-gated flow, test phải đổi theo PRD mới.

## 3. Quyết Định Sản Phẩm Cho Refactor

Chốt hướng V1 mới:

- Kiosk là hybrid theo department.
- `Grocery/Sklep`: scan-first, menu/search là fallback.
- `Kitchen/Kuchnia`: menu-first, scan vẫn hoạt động nếu sản phẩm có barcode.
- Cart và total luôn visible khi shopping.
- Payment overlay nằm trên shopping screen, không thêm summary route.
- Production unattended chỉ hiển thị card/BLIK terminal-driven.
- Cash và manual BLIK phone transfer chỉ nằm trong assisted/demo mode.
- Nếu readiness production chưa biết chắc, production mode phải fail closed hoặc bị label rõ là assisted/manual.
- Không client-side hack category metadata nếu backend/catalog chưa có field rõ. Dùng heuristic tạm nhưng đặt trong helper/test riêng và ghi rõ debt.

## 4. Kế Hoạch Triển Khai Theo Phase

### Phase 0 - Sửa contract và test guard trước

Mục tiêu: trước khi refactor UI, đảm bảo customer window thật có đúng API như code đang gọi.

Tasks:

- Update `src/preload/preload-display.ts` để expose:
  - `pos.products.getAll`
  - `pos.products.search`
  - `pos.products.searchByCode`
  - `pos.sync.onProductsSynced`
  - `selfCheckout.cancelHelp` chỉ nếu main process có handler tương ứng; nếu chưa có handler thì bỏ UI cancel hoặc tạo handler rõ.
- Update `src/shared/electron.d.ts` cho contract mới.
- Thêm/đổi test contract để self-checkout preload không thiếu API mà renderer dùng.
- Nếu không muốn expose `getAll/search/searchByCode`, đổi renderer dùng API đã expose (`getByCategory`) nhưng khi đó phải thiết kế lại data-loading theo category. Cách này lớn hơn, nên đề xuất expose API trước.

Acceptance:

- Runtime kiosk thật có menu product tiles và search hoạt động, không chỉ smoke mock.
- `cancelHelp` không còn optional ghost API: hoặc thật sự cancel backend/local request, hoặc UI không hiển thị cancel.
- Test fail nếu renderer dùng API không có trong `preload-display`.

Verification:

- `npm test -- --run tests/self-checkout-model.test.ts tests/ipc-contracts.test.ts`
- `node tests/e2e/self-checkout-prd-smoke.mjs`
- `npm run build`

### Phase 1 - Đồng bộ product decision, copy và trạng thái

Mục tiêu: UI/copy/code không còn tự mâu thuẫn.

Tasks:

- Sửa comment đầu `ScanScreen.tsx`: từ scanner-only thành scan + menu kiosk.
- Cập nhật `docs/SELF_CHECKOUT_DESIGN_BRIEF.md` hoặc thêm note rằng V1 mới hỗ trợ menu fallback/menu-first Kitchen.
- Đổi translations:
  - PL: `grocery` từ `Grocery` thành `Sklep` hoặc tên shop muốn dùng.
  - VI: `grocery` từ `Grocery` thành `Cửa hàng` hoặc `Tạp hóa`.
  - `paymentNotice` phải khớp mode. Nếu assisted mode có cash, không nói "chỉ terminal".
- Tách text cho assisted payment và unattended payment.
- Đưa `selfCheckoutFakePaymentEnabled` vào runtime model rõ ràng nếu vẫn cần.

Acceptance:

- Không còn copy nói terminal-only trong khi màn hình có Cash.
- Không còn scanner-only wording trong code/docs cho screen có menu.
- PL/VI không còn English `Grocery`.

Verification:

- `npm test -- --run tests/self-checkout-tab-i18n.test.ts tests/self-checkout-model.test.ts`
- Manual read-through PL/EN/VI screen copy.

### Phase 2 - Tách component để refactor an toàn

Mục tiêu: giảm blast radius của `ScanScreen.tsx`.

Tách theo write scope nhỏ:

- `src/renderer/windows/self-checkout/types.ts`
  - `SearchProduct`
  - `CatalogCategory`
  - `CatalogDepartment`
- `src/renderer/windows/self-checkout/catalog-model.ts`
  - `normalizeCatalogText`
  - `getCategoryDepartment`
  - `getProductPriceGrosze`
  - `getProductStock`
  - `buildVisibleCategories`
  - `buildVisibleProducts`
- `src/renderer/windows/self-checkout/useScannerCapture.ts`
  - shared scanner capture for welcome + shopping
  - keep duplicate guard and IPC/keyboard-wedge paths
- `src/renderer/windows/self-checkout/components/ScanPrompt.tsx`
- `src/renderer/windows/self-checkout/components/KioskMenuPanel.tsx`
- `src/renderer/windows/self-checkout/components/DepartmentTabs.tsx`
- `src/renderer/windows/self-checkout/components/CategoryChips.tsx`
- `src/renderer/windows/self-checkout/components/ProductTile.tsx`
- `src/renderer/windows/self-checkout/components/CartPanel.tsx`
- `src/renderer/windows/self-checkout/components/SearchDialog.tsx`

Keep `ScanScreen.tsx` as orchestration only:

- scanner input binding
- active department/category state
- pass callbacks to components
- render layout

Acceptance:

- No behavior change yet except better boundaries.
- Scanner still starts/adds from welcome and shopping.
- Search modal still closes after successful add.
- Cart quantity/remove/total behavior unchanged.

Verification:

- `npm test -- --run tests/self-checkout-model.test.ts tests/self-checkout-build-sale.test.ts tests/scanner-routing-prd.test.ts`
- `node tests/e2e/self-checkout-prd-smoke.mjs`
- `npm run build`

### Phase 3 - Làm shopping/menu hiện đại hơn

Mục tiêu: màn hình chính giống kiosk thật, không phải product grid tạm.

Tasks:

- Giữ top scan prompt ngắn hơn để nhường chỗ cho menu và cart.
- Thêm tab/segment `Popular` nếu data có thể sort được. Nếu chưa có data popularity, dùng "All" nhưng không giả vờ có popular.
- Product grid:
  - tile height ổn định
  - image ratio ổn định
  - missing image placeholder sạch
  - sold-out/no-price badge
  - disabled reason rõ
  - product name wrap 2 dòng
  - price nổi bật
- Category:
  - chips scroll ngang, không wrap phá layout
  - empty category state nói rõ scan/search/call staff
- Cart:
  - extract thành `CartPanel`
  - giữ total lớn/sticky
  - giữ at least 3 rows visible ở compact height
  - nếu cart dài, chỉ cart list scroll, footer không scroll
- Toast:
  - giữ gần scan/menu area
  - error recovery text ngắn
- Search:
  - product result rows dùng same product price/stock logic
  - no result có actions: scan again, call staff, close

Acceptance:

- Khách có thể add barcode product bằng scan.
- Khách có thể add menu product không cần barcode.
- Product sold-out/no-price không add vào cart.
- Total luôn visible.
- Pay disabled khi cart rỗng.
- Compact 1280x720 giữ 3 cart rows + pay button.
- Không horizontal overflow.

Verification:

- Extend `tests/e2e/self-checkout-prd-smoke.mjs` mock categories/products và click product tile từ Kitchen.
- `node tests/e2e/self-checkout-prd-smoke.mjs`
- Browser/manual screenshot ở 1280x800 và 1280x720.

### Phase 4 - Tách assisted payment khỏi unattended production

Mục tiêu: payment flow không đánh lừa khách về mức tự động hóa.

Tasks:

- Định nghĩa `SelfCheckoutPaymentProfile`:
  - `assistedDemo`: cash/card/manual BLIK with staff confirm.
  - `terminalProduction`: card/BLIK terminal-driven, no cash, no staff "money received" button.
  - `unavailable`: payment blocked, call staff.
- Trong `SelfCheckoutApp.tsx`, resolve profile từ config/runtime:
  - `selfCheckoutMode`
  - `selfCheckoutFakePaymentEnabled`
  - terminal readiness
  - fiscal readiness
  - order creation readiness
- Trong `PaymentScreen.tsx`:
  - render methods theo profile
  - cash chỉ visible trong `assistedDemo`
  - manual BLIK phone number chỉ visible trong `assistedDemo`
  - production terminal flow dùng terminal status, processing, approved/failed
  - cancel disabled sau khi processing bắt đầu
- Update tests đang codify manual BLIK:
  - demo assisted vẫn test được nếu mode demo.
  - production test phải assert không có cash/manual BLIK/staff confirm.

Acceptance:

- Demo/assisted vẫn dùng được cho shop đang vận hành thủ công.
- Production customer không thấy cash/manual BLIK phone transfer.
- Production không cho checkout nếu terminal/fiscal/order readiness thiếu.
- Không có visible card/BLIK input trong app.

Verification:

- `npm test -- --run tests/self-checkout-model.test.ts tests/self-checkout-build-sale.test.ts`
- `node tests/e2e/self-checkout-prd-smoke.mjs`
- Manual mode switch trong operator tab.

### Phase 5 - Production readiness và server-change boundary

Mục tiêu: tránh brittle client workaround cho những thứ phải do server/hardware cung cấp.

Frontend có thể làm ngay:

- `self-checkout-model.ts` trả về reasons thật khi config/runtime thiếu thông tin bắt buộc.
- Operator tab hiển thị readiness theo cùng runtime model customer dùng.
- `UnavailableScreen` dùng localized reason rõ.

Cần server/backend hoặc main-process contract rõ trước khi production unattended:

- Readiness endpoint hoặc IPC snapshot cho:
  - backend online
  - shift open
  - terminal connected/ready
  - fiscal/receipt printer ready
  - scanner route ready
  - order create path ready
- Payment terminal result contract:
  - payment attempt id
  - amount
  - method
  - approved/failed/canceled/unknown
  - idempotency behavior
- Catalog metadata:
  - self-checkout department/category
  - display order
  - active/visible on kiosk
  - sold-out/unavailable reason
  - product image/thumbnail
- Help cancel endpoint if customer can cancel acknowledged help request.

Nếu các contract trên chưa có, không hardcode client workaround. Tạo SCR trong `docs/server-change-requests/` trước khi implement production unattended behavior.

Acceptance:

- Demo can open.
- Production fail-closed nếu thiếu readiness.
- Operator và customer screen không disagree về readiness.

Verification:

- `npm test -- --run tests/self-checkout-model.test.ts tests/self-checkout-tab-i18n.test.ts`
- `npm run build`

### Phase 6 - Receipt/finalizing polish

Mục tiêu: receipt state cho khách biết chính xác đang xảy ra gì.

Tasks:

- Receipt progress list nên tách rõ:
  - payment confirmed
  - order saved
  - receipt/fiscal print
  - collect receipt
- Trong production, nếu print fail sau payment:
  - không auto thank-you
  - show error
  - lock/call staff
- Demo receipt copy phải rõ là demo/assisted, không giả production.
- Countdown reset chỉ chạy khi receipt state safe.

Acceptance:

- Không auto-complete khi `receiptPrinted=false`.
- Fiscal printing state không bị clipped ở compact height.
- Staff call visible khi receipt failure.

Verification:

- Existing compact receipt smoke.
- Add test path for `receiptPrinted=false` if not already covered.

### Phase 7 - Visual QA cuối

Mục tiêu: màn hình nhìn và hoạt động như kiosk thật trên màn hình lớn và POS2.

Checklist:

- 1280x800 no overflow.
- 1280x720 no overflow.
- PL/EN/VI text fit.
- Customer controls mostly 56 px+.
- Header không quá cao.
- Cart total là element nổi bật nhất khi shopping.
- Payment total là element nổi bật nhất khi payment.
- Help button consistent.
- No hover-only affordance.
- No nested card overload.
- No decorative hero/promo.
- Reduced motion vẫn ổn.

Verification:

- `node tests/e2e/self-checkout-prd-smoke.mjs`
- `npm run build`
- Browser/manual screenshots desktop + compact POS2.

## 5. Thứ Tự PR Đề Xuất

PR 1: API contract and docs alignment

- Fix `preload-display` missing APIs or align renderer to available API.
- Fix `cancelHelp` ghost call.
- Update comments/copy for scan + menu.
- Update tests for preload contract.

PR 2: Component extraction without behavior change

- Extract types/model/hooks/components from `ScanScreen.tsx`.
- Preserve smoke behavior.

PR 3: Shopping/menu UX upgrade

- Polish menu/category/product tiles/cart/search.
- Add product tile click smoke.
- Compact layout checks remain passing.

PR 4: Payment profile split

- Assisted demo vs terminal production.
- Cash/manual BLIK only assisted.
- Production readiness fail-closed.

PR 5: Receipt/finalizing and visual QA

- Receipt failure lock.
- Final responsive polish.
- Screenshots/manual POS2 validation.

## 6. Test Plan Tổng

Run sau mỗi PR UI:

```powershell
npm test -- --run tests/self-checkout-model.test.ts tests/self-checkout-build-sale.test.ts tests/scanner-routing-prd.test.ts
node tests/e2e/self-checkout-prd-smoke.mjs
npm run build
git diff --check
```

Manual smoke:

- Open kiosk from POS > Self-Checkout tab.
- Start by barcode scan from welcome.
- Start by `Sklep/Grocery`.
- Start by `Kuchnia/Kitchen`.
- Add menu product.
- Unknown barcode.
- Search product.
- Quantity +/- and remove.
- Empty cart pay disabled.
- Payment cancel returns to cart.
- Assisted demo payment reaches receipt.
- Staff help locks kiosk.
- Abandon clears cart.
- Receipt print fail path locks/calls staff.
- POS2 compact display visual check.

## 7. Out Of Scope Cho Refactor Frontend Này

- Autonomous no-checkout store.
- Computer vision / camera recognition.
- Customer app/mobile scan-and-go.
- Loyalty system.
- Deep promotion engine.
- Backend catalog redesign without SCR.
- Real unattended terminal payment without a clear terminal/result contract.
- Fiscal behavior changes outside existing print/order contracts.

## 8. Rủi Ro Chính

- Nếu không sửa preload contract trước, menu/search có thể chỉ chạy trong smoke mock chứ không chạy ở Electron window thật.
- Nếu production blockers vẫn rỗng, UI có thể mở production trong khi payment/fiscal readiness chưa thật.
- Nếu payment refactor làm trước component extraction, file `ScanScreen.tsx` quá lớn sẽ làm review khó và dễ phá scanner.
- Nếu category department tiếp tục dựa vào regex, Kitchen/Grocery sẽ sai với catalog thật nhiều ngôn ngữ.
- Nếu compact smoke không được mở rộng sau menu refactor, POS2 dễ bị clipping lại.
