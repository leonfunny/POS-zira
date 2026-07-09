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

### 2.1. Cái bẫy: ô mang nhãn "tên hoá đơn" KHÔNG phải tên hoá đơn

`resolveName(row, lang)` (`src/shared/catalog-names.ts`) trả `name_translations[lang]` nếu không rỗng, **rồi mới** tới `name` canonical. `getReceiptItemName` gọi nó với `'pl'`.

Nhưng trong `ProductEditForm.tsx:358-366`, ô bind vào canonical `name` lại đeo nhãn key `products.drawer.canonicalName`:

| dòng | locale | nội dung nhãn |
|---|---|---|
| `translations.ts:972` | en | `Receipt / fiscal name` |
| `translations.ts:2494` | vi | `Tên trên hóa đơn / fiscal` |
| `translations.ts:8918` | pl | `Nazwa na paragonie / fiskalna` |

**Nhãn nói dối.** Ô thật sự điều khiển tờ giấy là "Tên hiển thị tiếng Ba Lan" (`displayNames.pl`) — và nó bị giấu sau nút `Advanced`, lại còn gate thêm bằng `canEditDisplayName`.

Git blame kể trọn câu chuyện:

- `4f6f514` (2026-05-16) *"fix: print localized polish product names on receipts"* — đẻ ra `getReceiptItemName`, hoá đơn bắt đầu ưu tiên tên PL.
- `aea2538` (2026-06-30) *"feat(products): add display name editor"* — đẻ ra ô display name **và** dán nhãn `Receipt / fiscal name` lên ô canonical.

Nhãn được viết sáu tuần sau khi đường in đã đổi, và sai ngay từ lúc sinh ra. **Không có test nào khoá hành vi tên-hoá-đơn**, nên không gì chặn cú trôi này.

### 2.2. Bằng chứng dữ liệu (mirror local trên winpc, đọc read-only 2026-07-09)

Sản phẩm mẫu người dùng báo:

```
id                = a5e5618e-2004-431d-825c-d6eb0d026326
name              = "Cật (thận lợn)"     ← canonical, thực chất là tên tiếng Việt
name_translations = {"pl":"Nerka"}       ← KHÔNG có key "vi"
→ getReceiptItemName() = "Nerka"
```

Ô "Tên hiển thị tiếng Việt" trống; chữ xám trong đó là **placeholder** = canonical (`ProductEditForm.tsx:397`). Vì `resolveName(_, 'vi')` không thấy `vi` nên mọi bề mặt UI tiếng Việt rơi về canonical.

Độ phủ trên 1.706 variant của `pos.db`:

| ô | có giá trị | vai trò thật |
|---|---|---|
| canonical `name` | 1.706 (bắt buộc) | khoá đối soát backend + `order_items.name` + fallback |
| `pl` | 1.646 (96%) | **tên in ra hoá đơn giấy & fiscal** |
| `en` | 1.270 | chỉ hiển thị |
| `vi` | 89 (5%) | chỉ hiển thị |
| không có bản dịch nào | 40 | hoá đơn in thẳng canonical tiếng Việt |

**770 / 1.646 tên PL chứa token cân nặng** (`\d+\s?(g|kg|ml|l)`), ví dụ `"Asian Pearl Małże Venus Gotowane 400g"`. Đây chính là nơi lỗi "tên ghi 250g nhưng hàng 400g" sống — trong ô bị giấu sau `Advanced`.

Với 40 sản phẩm không có `pl`: POSNET `sanitizeName()` chỉ cắt 40 ký tự và bỏ ký tự điều khiển, **không bỏ dấu** → đẩy nguyên `"Cật (thận lợn)"` xuống máy in fiscal. ELZAB thì `toFiscalSafeItemName()` fold về ASCII → `"Cat (than lon)"`.

Catalog hiện **1 template = 1 variant** (0 template có >1 variant), nên overlay cấp template chưa gây lây chéo — nhưng backend `product-admin.service.ts:269-292` ghi `name_translations` vào bảng `products` (template) bằng JSONB merge và bump mọi sibling, nên ràng buộc đó vẫn có thật. `splitTranslations()` coi chuỗi rỗng là **lệnh xoá locale**: xoá trắng ô PL ⇒ hoá đơn rơi về canonical tiếng Việt.

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

### 3.5. Sửa sự thật của cụm ô tên

**Không đụng một dòng logic in nào.** Chỉ đổi nhãn, đổi thứ tự, và bày sự thật ra.

**(a) Hằng số dùng chung.** Export từ `src/shared/catalog-names.ts`:

```ts
/** Locale the customer-facing receipt renders item names in. Both the print path
 *  (PaymentController.getReceiptItemName) and the editor preview MUST use this. */
export const RECEIPT_NAME_LOCALE = 'pl';
```

`payment-controller.ts:145` đổi `resolveName(product, 'pl')` → `resolveName(product, RECEIPT_NAME_LOCALE)`. Máy in và form từ đó dùng chung một hàm và một hằng, không thể trôi khỏi nhau.

**(b) Đổi nhãn cho đúng sự thật** (`translations.ts`, cả 8 locale, luôn đọc qua `tOr` nên thiếu locale không vỡ):

| key | nhãn cũ (sai) | nhãn mới |
|---|---|---|
| `products.drawer.canonicalName` | "Tên trên hóa đơn / fiscal" | "Tên gốc (nội bộ, đồng bộ backend)" |
| `products.edit.displayNamePl` | "Tên hiển thị tiếng Ba Lan" | "Tên trên hoá đơn / fiscal (Ba Lan)" |

`products.edit.displayNameVi` / `displayNameEn` giữ nguyên — chúng đúng là tên hiển thị.

**(c) Kéo ô PL ra khỏi `Advanced`.** Đặt ngay dưới ô canonical, luôn thấy. `vi`/`en` ở lại trong `Advanced`. Layout:

```
Tên gốc (nội bộ, đồng bộ backend)  *
[ Cật (thận lợn)                  ]

Tên trên hoá đơn / fiscal (Ba Lan)
[ Nerka                           ]
↳ In ra: Nerka

[ Advanced ▾ ]
   Tên hiển thị tiếng Việt  [      ]
   Tên hiển thị tiếng Anh   [      ]
```

**(d) Dòng preview "In ra:"** tính live từ state hiện tại của form bằng `resolveName({ name, name_translations: displayNames }, RECEIPT_NAME_LOCALE)`.

Khi `displayNames.pl` **rỗng**, preview chuyển sang cảnh báo vàng, hiển thị đúng chuỗi sẽ xuống máy in:

```
⚠ Bỏ trống → in tên gốc "Cật (thận lợn)"
   POSNET in nguyên dấu; ELZAB bỏ dấu thành "Cat (than lon)"
```

Đây là cách xử lý 40 sản phẩm chưa có tên PL: **cảnh báo, không ép**. Không đụng dữ liệu, không thêm ràng buộc bắt buộc ở `ProductCreateDialog`.

**(e) Cảnh báo khi xoá trắng ô PL.** Backend `splitTranslations()` coi chuỗi rỗng là lệnh **xoá locale**, nên xoá ô PL là hành động phá huỷ tên đang in. Preview ở (d) đã nói đúng hậu quả; không cần dialog xác nhận.

**(f) Giữ cảnh báo `displayNameAffectsMultipleVariants`** ngay cạnh ô PL vừa được đề bạt. Overlay nằm ở template (`product-admin.service.ts:269-292`), nên sửa nó đổi tên hoá đơn của **mọi variant cùng template**. Catalog hiện 1:1 nên chưa nổ, nhưng ràng buộc là thật.

**(g) Khi `canEditDisplayName` false** (backend `capabilities.version < 2`): ô PL **không được biến mất** — render read-only kèm ghi chú "backend chưa hỗ trợ sửa tên hiển thị". Nếu để nó ẩn như hiện nay, người vận hành chỉ còn thấy đúng ô canonical, và ô đó không điều khiển tờ giấy → quay lại đúng cái bẫy ta đang gỡ.

Hằng số `RECEIPT_NAME_LOCALE` **không** phải chỗ để cấu hình ngôn ngữ hoá đơn. Bỏ hardcode `'pl'` thành config là thay đổi riêng, đụng thẳng đường in fiscal, nằm ngoài phạm vi tài liệu này.

### 3.5.1. Thứ tự ship

Mục 3.5 **độc lập** với deep-link và nên ship trước: nó là thay đổi copy + layout, không có state mới, và nó tự mình dập tắt cả một lớp bug "sửa rồi mà vẫn sai". Deep-link (3.1–3.4, 3.6, 3.7) đi sau, và khi đó nó dẫn người dùng tới một cái form đã nói thật.

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
- `tests/receipt-name-locale-contract.test.ts` — **test này lẽ ra phải tồn tại từ 2026-05-16; không có nó nên nhãn trôi 6 tuần mà không ai biết.**
  - với cùng một input `{ name, name_translations }`, preview của form và `resolveName(product, RECEIPT_NAME_LOCALE)` trả **cùng một chuỗi**, cho cả ba trường hợp: chỉ có canonical; có `pl`; có `vi` nhưng không có `pl`;
  - `resolveName({name:'Cật (thận lợn)', name_translations:{pl:'Nerka'}}, RECEIPT_NAME_LOCALE) === 'Nerka'` — khoá đúng hành vi người dùng đã báo;
  - `PaymentController.getReceiptItemName` dùng `RECEIPT_NAME_LOCALE`, không phải literal `'pl'` (grep-level assertion hoặc export hàm để test trực tiếp).

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
| `src/renderer/components/products/ProductEditForm.tsx` | kéo ô PL ra khỏi `Advanced`; dòng preview "In ra:"; cảnh báo khi PL rỗng; PL read-only khi `canEditDisplayName` false |
| `src/renderer/i18n/translations.ts` | đổi nhãn `products.drawer.canonicalName` + `products.edit.displayNamePl` (8 locale) |
| `src/renderer/components/pos/CartItem.tsx` | prop `onEditProduct?`, nút bút chì 44×44 |
| `src/renderer/components/pos/Cart.tsx` | prop `onEditProduct?` truyền xuống |
| `src/renderer/components/pos/POSLayout.tsx` | prop `onEditProduct?` → `RetailTemplate` |
| `src/renderer/components/pos/templates/retail/RetailTemplate.tsx` | truyền `onEditProduct` xuống `Cart` |
| `src/renderer/components/OrdersTab.tsx` | `variant_id` vào `OrderItemRow`; nút bút chì; prop `onEditProduct?` |

Mọi key i18n mới đọc qua `tOr(...)` để locale thiếu không làm vỡ UI.

---

## 7. Rủi ro

- **Bẫy dòng 419** (mục 3.3b) — sản phẩm biến mất giữa lúc đang sửa từ giỏ. Có regression test.
- **Module-scope cache của capabilities** sống ngoài cây React nên `key={sessionKey}` không xoá được nó; phải reset thủ công trong `clearRendererState()` (`App.tsx:252`), nếu không đổi tài khoản sẽ thấy capabilities của tài khoản cũ.
- **`ProductEditView` mở tiếp modal** (`StockAdjustmentDialog`, `DeactivateProductDialog`, `CategoryManagerDialog`). Vì ta đổi tab thật chứ không lồng sheet, không có modal chồng modal. Đây là lý do chính chọn deep-link thay vì sheet.
- **`consumedRef`** chặn mở lại cùng một `variantId` hai lần liên tiếp. Vì `App` xoá `productEditRequest` mỗi khi rời tab `products`, `openVariantId` chuyển về `undefined` giữa hai lần, nên lần sau ref phải được reset khi `openVariantId` rỗng.
- **Đổi nhãn ô canonical là thay đổi ngữ nghĩa với người dùng cũ**, không chỉ là chữ. Ai từng sửa ô "Tên trên hóa đơn / fiscal" và tưởng mình đổi được tờ giấy thì nay biết là không. Nên thông báo cho người vận hành khi ship, kèm danh sách 40 sản phẩm chưa có tên PL.
- **Preview trong form đọc `displayNames` state, còn máy in đọc mirror local.** Hai nguồn khớp nhau sau khi lưu (vì `mirrorProductAdminVariant` ghi xuống local ngay), nhưng **trước** khi lưu preview hiển thị giá trị chưa lưu. Đó là ý đồ — preview trả lời "nếu tôi lưu cái này thì in ra gì".
