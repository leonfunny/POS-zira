# Deep-link từ dòng bán hàng tới màn sửa sản phẩm

**Ngày:** 2026-07-09
**Trạng thái:** Design — đã chốt với chủ sở hữu, chờ implementation plan
**Phạm vi:** `POS-zira` renderer + một hằng số dùng chung với main

---

## 1. Vấn đề

Tab Products cho phép sửa mọi thông tin sản phẩm, nhưng để **tìm** đúng sản phẩm cần sửa thì phải đi qua category grid hoặc gõ search. Trong lúc đang bán, sản phẩm cần sửa đang nằm ngay trước mắt — trong giỏ hàng — nhưng không có đường nào từ đó tới màn sửa.

Nhu cầu thật, theo lời chủ cửa hàng: tên sản phẩm hay bị sai (ví dụ tên ghi `250g` nhưng hàng là gói `400g`), do nhân viên gõ nhầm hoặc do AI điền sai lúc import. Khách đọc hoá đơn rồi thắc mắc. Thỉnh thoảng cần sửa VAT hoặc category. **Giá thì không**, vì giỏ hàng đã có sẵn popup sửa giá nhanh (`Cart.handleOpenPricePopup`).

Bối cảnh: sửa xong mới bán tiếp, không gấp tới mức vài giây. Giỏ hàng phải còn nguyên sau khi sửa.

---

## 2. Phát hiện quyết định: hoá đơn không in tên từ giỏ hàng

Đây là dữ kiện đảo ngược giả định ban đầu và quyết định phạm vi của feature.

`PaymentController.getReceiptItemName()` (`src/main/pos/payment-controller.ts:139`) **đọc lại sản phẩm từ SQLite local** theo `variant_id` tại thời điểm in, rồi trả `resolveName(product, 'pl')`. Nó chỉ fallback về tên đã lưu trong `order_items` khi không còn nhận ra sản phẩm:

```ts
private getReceiptItemName(item: { name: string; variant_id?: string | null; sku?: string | null }): string {
  const product = item.variant_id ? productRepo.getById(item.variant_id) : ...;
  return resolveName(product, 'pl') || item.name;
}
```

Hàm này nuôi `buildReceiptItems()` (dòng 195, 226) → `buildSaleReceiptData()` → `printFiscalReceipt()` (dòng 561). Nghĩa là **cả hoá đơn giấy lẫn hoá đơn tài chính POSNET/ELZAB đều in tên hiện tại của catalog**, không phải snapshot trong giỏ.

Cộng với `mirrorProductAdminVariant()` (`src/main/modules/pos.module.ts:1585`) ghi bản sửa xuống SQLite local ngay khi `updateVariant` thành công, hệ quả là:

> Sửa tên trong tab Products xong, **mọi hoá đơn in sau đó đều ra tên mới**, kể cả in lại một đơn cũ. Không cần đồng bộ gì với giỏ hàng.

Vậy feature này **thuần tuý là bài toán điều hướng**, không phải bài toán đồng bộ dữ liệu.

### 2.1. Cái bẫy đi kèm

`resolveName(product, 'pl')` hardcode locale `'pl'`. Theo contract ghi ở đầu `src/shared/catalog-names.ts`, thứ tự ưu tiên là `name_translations.pl` **trước**, rồi mới tới `name` canonical.

`ProductEditForm` (`src/renderer/components/products/ProductEditForm.tsx:38`) cho sửa ba ô display name — `vi`, `pl`, `en` — cộng một ô "Canonical name" riêng.

Nên với một sản phẩm đã có `name_translations.pl` (đúng nguồn sai do AI import), **sửa ô Canonical name sẽ không đổi được tên trên hoá đơn** — ô `pl` vẫn thắng. Nhân viên chạy UI POS tiếng Việt lại có xu hướng sửa ô Vietnamese, cũng không ăn. Đây là chỗ "sửa rồi mà vẫn sai" nguy hiểm nhất, và thiết kế phải xử lý nó (mục 3.5).

---

## 3. Thiết kế

### 3.1. Kênh điều hướng — `App` làm trạm trung chuyển

`src/renderer/App.tsx` không có router; `activeTab` là `useState` (dòng 58) và mỗi tab là một conditional render. Chỉ `Sidebar` đổi được tab. Thêm đúng một mẩu state:

```ts
type ProductEditRequest = { variantId: string; returnTo: Tab };
const [productEditRequest, setProductEditRequest] = useState<ProductEditRequest | null>(null);
```

- `requestProductEdit(variantId, returnTo)` — no-op nếu `variantId` rỗng hoặc `products` không nằm trong `visibleTabs`; ngược lại set request rồi `setActiveTab('products')`.
- `exitProductEdit()` — `setActiveTab(productEditRequest.returnTo)` rồi xoá request. Đọc `returnTo` từ state hiện tại, **không** đặt side effect trong updater của `setState`.
- Effect dọn rác: khi `activeTab !== 'products'` thì `setProductEditRequest(null)`, để request không treo lơ lửng khi người dùng tự bấm Sidebar đi chỗ khác.

Nhánh render **kiosk fullscreen** (`App.tsx:356`) đơn giản **không truyền** `onEditProduct` xuống `POSLayout`. Nút tự biến mất; kiosk là màn hướng ra khách, không phải chỗ sửa catalog. Không cần thêm điều kiện nào khác.

Giỏ hàng sống sót qua lần unmount này vì `PosState` nằm ở main process (`pos.getState` / `pos.dispatch` qua IPC), không phải renderer. Mất: buffer numpad, ô đang active, focus ô quét — chấp nhận được, và `POSLayout` đã có sẵn cơ chế `document.dispatchEvent(new CustomEvent('pos:focus-search'))` để lấy lại focus khi mount.

### 3.2. `ProductModule` nhận deep-link

Props mới: `openVariantId?: string` và `onExitExternal?: () => void`.

Union view (`ProductModule.tsx:29`) mở rộng đúng một nhánh:

```ts
type ProductView =
  | BrowseView
  | { name: 'edit'; productId: string; returnTo: BrowseView | { name: 'external' } };
```

Effect resolve deep-link, chống chạy lại bằng `useRef`:

```ts
const consumedRef = useRef<string | null>(null);
useEffect(() => {
  // Reset khi rời deep-link, nếu không thì mở lại CÙNG một variantId lần thứ hai
  // sẽ bị chặn im lặng — App xoá request mỗi lần rời tab, nên openVariantId
  // luôn đi qua undefined giữa hai lần mở.
  if (!openVariantId) { consumedRef.current = null; return; }
  if (loading) return;
  if (consumedRef.current === openVariantId) return;
  consumedRef.current = openVariantId;
  const product = allProducts.find((p) => p.id === openVariantId);
  if (!product) {
    setToast({ kind: 'error', text: tOr(t, 'products.deepLink.notFound', 'Product is no longer in the catalog') });
    onExitExternal?.();
    return;
  }
  setSelectedProduct(product);
  setView({ name: 'edit', productId: product.id, returnTo: { name: 'external' } });
}, [openVariantId, loading, allProducts, onExitExternal, t]);
```

`useProducts` gọi `pos.products.getAllIncludingInactive()` (`useProducts.ts:142`), nên sản phẩm **đã ngừng bán vẫn resolve được**. Chỉ sản phẩm bị xoá hẳn khỏi catalog mới rơi vào nhánh not-found.

### 3.3. Hai chỗ phải sửa cẩn thận trong `ProductModule`

**(a) `returnFromEdit` (dòng 511).** Nhánh external phải gọi `onExitExternal()` **ngoài** updater của `setView` — updater phải thuần, React StrictMode gọi nó hai lần:

```ts
const returnFromEdit = useCallback(() => {
  const external = view.name === 'edit' && view.returnTo.name === 'external';
  setSelectedProduct(null);
  setView(view.name === 'edit' && !external ? (view.returnTo as BrowseView) : { name: 'categories' });
  if (external) onExitExternal?.();
}, [view, onExitExternal]);
```

**(b) Effect sản phẩm biến mất (dòng 419).** Effect này chạy khi sản phẩm đang mở bị deactivate ở máy khác rồi sync về. Hiện nó làm `setView((current) => current.name === 'edit' ? current.returnTo : current)`. Với `returnTo = { name: 'external' }` nó sẽ set view thành một giá trị **không phải `BrowseView`** → vỡ render. Nhánh external phải gọi `onExitExternal()` thay vì set view.

Đây là chỗ dễ sót nhất trong cả feature. Cả hai đều có unit test bắt buộc (mục 5).

### 3.4. Nút bút chì trên dòng giỏ hàng

`Cart` có sẵn prop `renderItemExtra` (`Cart.tsx:16`), nhưng nó render **dưới** dòng (`Cart.tsx:871`) — thêm một hàng nữa cho mọi item, nặng mắt trên lưới bán lẻ và `RestaurantTemplate` đang chiếm chỗ đó cho chip staff/course.

Thay vào đó thêm prop tuỳ chọn cho `CartItemRow`:

```ts
onEditProduct?: (item: CartItemType) => void;
```

Vẽ một nút icon-only 44×44 (`Pencil`, lucide) nằm trong hàng nút sẵn có, cạnh Print/Remove (`CartItem.tsx:196-239`). `Cart` nhận `onEditProduct?: (item: CartItem) => void` và truyền thẳng xuống. Template nào không truyền thì không có nút → `RestaurantTemplate` và `B2BTemplate` giữ nguyên ở v1.

Nút chỉ render khi hội đủ ba điều kiện:

1. `item.variantId` khác null — bỏ qua dòng dịch vụ / nhập tay;
2. `capabilities.canUpdateProduct === true`;
3. `products` nằm trong `visibleTabs`.

`App` chỉ truyền `onEditProduct` khi thoả cả 2 và 3; `Cart`/`CartItem` do đó chỉ cần biết prop có được truyền hay không, và tự kiểm điều kiện 1 trên từng dòng. `requestProductEdit` vẫn tự kiểm `visibleTabs` lần nữa như một chốt chặn.

Chuỗi prop: `App` → `POSLayout` (prop mới `onEditProduct?`) → `RetailTemplate` (`POSLayout.tsx:1618`) → `Cart` → `CartItemRow`.

### 3.5. Preview "Tên in trên hoá đơn" — chống bẫy bằng hằng số dùng chung

Export từ `src/shared/catalog-names.ts`:

```ts
/** Locale the customer-facing receipt renders item names in. Both the print path
 *  (PaymentController.getReceiptItemName) and the editor preview MUST use this. */
export const RECEIPT_NAME_LOCALE = 'pl';
```

`payment-controller.ts:145` đổi `resolveName(product, 'pl')` → `resolveName(product, RECEIPT_NAME_LOCALE)`.

`ProductEditForm` thêm một dòng read-only, tính live từ state hiện tại của form (`name` + `displayNames`), chạy đúng `resolveName` và đúng hằng số đó:

```
Tên in trên hoá đơn:  Đậu bắp 400g
                      (đang lấy từ ô Ba Lan)
```

Chú thích nguồn đổi giữa `(đang lấy từ ô Ba Lan)` và `(đang lấy từ ô Canonical name)` tuỳ theo `displayNames.pl` có rỗng hay không.

Vì máy in và ô preview dùng **chung một hàm và chung một hằng**, hai đầu không thể trôi khỏi nhau. Đây là toàn bộ nội dung của việc "xử lý cái bẫy": không đụng logic in, chỉ khiến sự thật hiện lên trước mắt người đang sửa.

Preview vẫn hiện **kể cả khi `canEditDisplayName` false** (lúc đó các ô display name bị ẩn): `displayNamesFromProduct(product)` khởi tạo state từ `product.name_translations` bất kể capability, nên preview đọc đúng giá trị đang có trong DB và người sửa biết ngay tại sao ô Canonical name của mình không ăn.

Hằng số này **không** phải chỗ để cấu hình ngôn ngữ hoá đơn. Bỏ hardcode `'pl'` thành config là một thay đổi riêng, đụng thẳng đường in fiscal, nằm ngoài phạm vi tài liệu này.

### 3.6. Capabilities nhấc lên `App`

Hiện `pos.productAdmin.getCapabilities()` được gọi trong một effect **mỗi lần `ProductModule` mount** (`ProductModule.tsx:465-488`) — một round-trip mạng tới backend mỗi lần vào tab. POS lại cần biết `canUpdateProduct` để quyết định có vẽ nút hay không.

Tách thành `src/renderer/hooks/useProductAdminCapabilities.ts`:

```ts
export function useProductAdminCapabilities(): {
  capabilities: ProductAdminCapabilities | null;
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
};
```

Cache ở module scope (một in-flight promise dùng chung), `App` gọi một lần sau đăng nhập, truyền `canUpdateProduct` xuống POS và Orders. `ProductModule` đọc từ cùng hook đó thay cho effect riêng, **giữ nguyên** ngữ nghĩa `adminCapabilitiesLoading` / `adminCapabilityError` / `adminBackendReady`.

Cache phải bị xoá khi đổi user (`App` đã remount cả cây bằng `key={sessionKey}` — hook cần một `resetProductAdminCapabilitiesCache()` gọi trong `clearRendererState()`, vì module-scope cache sống ngoài cây React).

### 3.7. Nút bút chì trong tab Orders

`OrdersTab.tsx:39` khai báo `OrderItemRow` **thiếu `variant_id`**, dù `pos:orders:getDetail` (`pos.module.ts:2477`) trả thẳng `orderRepo.getItemsByOrderId()` và `OrderItem` trong repo **có** `variant_id` (`order-repo.ts:56`). Chỉ cần bổ sung khai báo:

```ts
interface OrderItemRow {
  ...
  variant_id?: string | null;
}
```

Thêm nút bút chì vào dòng của bảng chi tiết (`OrdersTab.tsx:611`), gọi `onEditProduct(item.variant_id)` với `returnTo: 'orders'`. Đơn kéo từ server về (`orders.getServerList` / `orders.mirrorFromServer`) có thể thiếu `variant_id` → nút tự ẩn, không cần code thêm.

`OrderHistoryModal` trong tab POS **không** nằm trong phạm vi v1: nhảy tab sẽ đóng modal và unmount POS, muốn mượt thì phải lưu và khôi phục trạng thái modal.

---

## 4. Những gì cố ý không làm

**Dòng trong giỏ không được refresh sau khi sửa.** Tên trên màn hình cashier vẫn là snapshot cũ cho tới khi xoá và thêm lại. Chấp nhận được vì hoá đơn — thứ khách cầm — đã lấy tên sống từ catalog (mục 2). Thêm một action `cart/refreshItem` sẽ mở cửa cho việc ghi đè mất giá đã sửa tay qua `cart/setItemPrice` (`usePosStore.ts:121`, không có cờ phân biệt giá tay với giá catalog), mà chẳng đổi được tờ giấy in ra.

**Ngoại lệ cần cảnh báo:** nếu đổi VAT trong lúc sản phẩm đang nằm trong giỏ, đơn hiện tại vẫn tính VAT cũ, vì `buildReceiptItems` đọc `order_items.vat_rate` (snapshot) chứ không đọc catalog. `ProductModule` đã có sẵn `selectedProductInCart` (dòng 409) để biết điều đó. Khi lưu thành công mà `vatRate` đã đổi **và** `selectedProductInCart`, bắn toast:

> "VAT đã đổi. Dòng trong giỏ vẫn giữ VAT cũ — xoá và thêm lại nếu muốn áp mức mới."

Trung thực, không cần thêm máy móc gì.

**Giá không đụng tới.** Giỏ đã có popup sửa giá nhanh.

**`RestaurantTemplate` / `B2BTemplate` / `SalonTemplate` không có nút** ở v1. Hai template đầu render `Cart` nên chỉ cần truyền thêm prop khi cần; `SalonTemplate` không dùng `Cart`.

---

## 5. Kiểm thử

Unit test mới, đặt trong `tests/` phẳng theo convention repo:

- `tests/product-module-deeplink.test.ts`
  - resolve `openVariantId` khi sản phẩm còn active → vào view `edit` với `returnTo.name === 'external'`;
  - sản phẩm đã deactivate → vẫn resolve được (vì `getAllIncludingInactive`);
  - sản phẩm đã xoá hẳn → toast not-found + gọi `onExitExternal` đúng một lần;
  - `openVariantId` không đổi → effect không chạy lại (`consumedRef`).
- `tests/product-module-external-return.test.ts`
  - `returnFromEdit` ở nhánh external gọi `onExitExternal`, **không** set view thành `{name:'external'}`;
  - effect "sản phẩm biến mất" (dòng 419) ở nhánh external gọi `onExitExternal` thay vì `setView(returnTo)` — đây là regression test cho cái bẫy ở mục 3.3(b).
- `tests/receipt-name-locale-contract.test.ts`
  - với cùng một input `{ name, name_translations }`, giá trị preview của form và `resolveName(product, RECEIPT_NAME_LOCALE)` trả **cùng một chuỗi**, cho cả ba trường hợp: chỉ có canonical; có `pl`; có `vi` nhưng không có `pl`. Đây là lý do tồn tại của hằng số.

Smoke tay trên máy:

1. POS retail → thêm sản phẩm có `name_translations.pl` vào giỏ;
2. bấm bút chì → tab Products mở thẳng màn edit đúng sản phẩm;
3. sửa ô Ba Lan → preview "Tên in trên hoá đơn" đổi theo ngay;
4. Lưu → Back ("← Về giỏ hàng") → về tab POS, **giỏ còn nguyên**;
5. thanh toán → hoá đơn giấy in tên mới;
6. lặp lại từ tab Orders với một đơn cũ → in lại hoá đơn → cũng ra tên mới.

Kiểm tra âm tính: đăng nhập bằng tài khoản không có `canUpdateProduct` → nút không xuất hiện ở cả hai chỗ. Bật POS fullscreen kiosk → nút không xuất hiện.

---

## 6. Danh sách file

| File | Thay đổi |
|---|---|
| `src/shared/catalog-names.ts` | export `RECEIPT_NAME_LOCALE` |
| `src/main/pos/payment-controller.ts` | dòng 145 dùng hằng số thay vì `'pl'` |
| `src/renderer/App.tsx` | `productEditRequest` state, `requestProductEdit`/`exitProductEdit`, effect dọn rác, truyền prop xuống POSLayout (chỉ nhánh không-kiosk) / OrdersTab / ProductModule |
| `src/renderer/hooks/useProductAdminCapabilities.ts` | **mới** — hook + module-scope cache + `resetProductAdminCapabilitiesCache()` |
| `src/renderer/components/products/ProductModule.tsx` | props `openVariantId` / `onExitExternal`; union `returnTo`; effect deep-link; hai chỗ sửa ở mục 3.3; đọc capabilities từ hook; toast cảnh báo VAT |
| `src/renderer/components/products/ProductEditView.tsx` | prop `backLabel?: string` cho nút `ChevronLeft` |
| `src/renderer/components/products/ProductEditForm.tsx` | dòng preview "Tên in trên hoá đơn" |
| `src/renderer/components/pos/CartItem.tsx` | prop `onEditProduct?`, nút bút chì 44×44 |
| `src/renderer/components/pos/Cart.tsx` | prop `onEditProduct?` truyền xuống |
| `src/renderer/components/pos/POSLayout.tsx` | prop `onEditProduct?` → `RetailTemplate` |
| `src/renderer/components/pos/templates/retail/RetailTemplate.tsx` | truyền `onEditProduct` xuống `Cart` |
| `src/renderer/components/OrdersTab.tsx` | `variant_id` vào `OrderItemRow`; nút bút chì; prop `onEditProduct?` |
| `src/renderer/i18n/translations.ts` | key mới, luôn dùng qua `tOr(...)` để thiếu locale không vỡ |

---

## 7. Rủi ro

- **Bẫy dòng 419** (mục 3.3b) — sản phẩm biến mất giữa lúc đang sửa từ giỏ. Có regression test.
- **Module-scope cache của capabilities** sống ngoài cây React nên `key={sessionKey}` không xoá được nó; phải reset thủ công trong `clearRendererState()` (`App.tsx:252`), nếu không đổi tài khoản sẽ thấy capabilities của tài khoản cũ.
- **`ProductEditView` mở tiếp modal** (`StockAdjustmentDialog`, `DeactivateProductDialog`, `CategoryManagerDialog`). Vì ta đổi tab thật chứ không lồng sheet, không có modal chồng modal. Đây là lý do chính chọn deep-link thay vì sheet.
- **`consumedRef`** chặn mở lại cùng một `variantId` hai lần liên tiếp. Vì `App` xoá `productEditRequest` mỗi khi rời tab `products`, `openVariantId` chuyển về `undefined` giữa hai lần, nên lần sau ref phải được reset khi `openVariantId` rỗng.
