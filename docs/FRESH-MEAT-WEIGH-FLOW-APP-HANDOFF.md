# Fresh-Meat Weigh & Label Flow — POS-zira App Handoff Spec

**Date:** 2026-06-02
**Audience:** POS-zira app dev bot (codex) — phần APP (Electron/React). Backend đã do Claude làm.
**Salon:** chesaigon (id `1500feea-6178-496f-bd8e-8874ee5c9510`, salon_code `6535`)

---

## 1. Mục tiêu & flow (Model B — đã chốt)

Bán **thịt tươi theo cân (kg)**. Hai trạm:

- **POS3 = trạm cắt thịt (label station).** Chưa có cân. Staff cắt xong → chọn loại thịt trên POS → **giữ (hold) sản phẩm để in 1 nhãn EAN 50×30** → dán lên túi nilon bọc thịt.
- **POS1 = quầy thu ngân.** CÓ cân Dibal (COM5). Khách mang túi ra → staff **đặt túi lên cân + quét mã EAN trên nhãn** → POS nhận diện sản phẩm WEIGHT → đọc cân → `khối lượng × giá/kg` → vào giỏ → thanh toán + in paragon fiskal.

**Model B nghĩa là:** nhãn EAN chỉ ĐỊNH DANH sản phẩm (mỗi loại thịt = 1 mã EAN cố định) + in giá/kg. Nhãn KHÔNG nhúng giá/khối lượng. Cân tại quầy mới là nguồn khối lượng. (KHÔNG phải barcode nhúng giá kiểu cân-nhãn siêu thị.)

---

## 2. Phần cứng / topology

- POS1 checkout: cân **Dibal**, cổng **COM5** (Prolific PL2303, protocol DIBAL_GDPOS). Driver đã có sẵn trong app (xem mục 4). Máy in fiscal ELZAB = COM3.
- POS3: máy POS đặt chỗ cắt, in nhãn 50×30 (Zebra/Xprinter label printer). Chưa cài xong.
- Catalog/data đồng bộ từ backend `api.enail.pro` (Contabo) qua sync → local SQLite của app (`product_variants` có `barcode/ean/sell_by/sale_unit/retail_price`).

---

## 3. ĐÃ XONG ở BACKEND (ĐỪNG làm lại)

1. **Hạ tầng cân (kg):** `product_variants.sell_by='WEIGHT'`, `sale_unit='kg'`, `retail_price` = **giá/kg (gross, zł/kg)**. Order item lưu `sale_quantity numeric(12,3)` + `sale_unit`. Đã deploy.
2. **Trừ kho theo lot (FEFO):** bug "hàng lot-tracked không trừ kho" ĐÃ FIX + deploy (`smartStockOut` dùng `getSourceableQuantsWithLock`, trừ qua cả lot & lot-less).
3. **Mã EAN nội bộ cho 21 món thịt/hải sản cân ĐÃ SINH (2026-06-02):** dạng `26535XXXXXXXC` (prefix 2 + salon_code 6535 + 7 số + check digit), unique, `barcode_source='INTERNAL'`. Backend `find-by-ean` quét ra đúng + feed `GET /warehouse/public/products` có `barcode/ean` → app sync về là quét được.
   - ⚠️ 2 món **Cánh gà, Tim lợn** có mã nhưng CHƯA có giá/kg (`retail_price` NULL) → tạm bỏ qua tới khi user cho giá.
   - Các sản phẩm cân khác (rau/củ/trái cây ~49 món) CHƯA có mã — flow thịt chưa cần.
4. Feed/endpoint quét: `POST /api/v1/warehouse/quick-add/find-by-ean` (header `X-Salon-Slug`,`X-Salon-Code`), và feed `GET /warehouse/public/products` trả `sellBy/saleUnit/priceGross/barcode`.

→ App chỉ cần **sync lại** để kéo 21 mã mới về local.

---

## 4. ĐÃ CÓ SẴN trong APP (ĐỪNG build lại — chỉ test/hoàn thiện)

Phần lớn luồng cân-khi-quét ĐÃ ĐƯỢC VIẾT:

- **Phân loại sản phẩm:** `src/shared/product-sale-classifier.ts` → `classifyProductSale(product)` trả `{sellBy, saleUnit, isWeighted, requiresScale, quantityInputMode:'decimal', priceSuffix:'/kg'}`. `requiresScale = isWeighted = (sell_by==='WEIGHT' || sale_unit==='kg')`. **priceSuffix `/kg` đã có sẵn để hiển thị giá/kg.**
- **Luồng thêm-vào-giỏ có cân:** `src/renderer/components/pos/retail-sale-flow.ts` → `resolveRetailCartItem(product, {scaleEnabled, scalePort, readWeight})`: nếu `requiresScale` → đọc cân → kiểm `result.stable && weightKg>0` → `quantity = weightKg`; trả lỗi `SCALE_DISABLED | SCALE_UNAVAILABLE | SCALE_FAILED | SCALE_UNSTABLE`.
- **Quét mã ĐÃ đi qua luồng cân:** `src/renderer/components/pos/POSLayout.tsx` `handleBarcodeKeyDown` (~dòng 380-410): quét → `getByBarcode(code)` → `resolveRetailCartItem(...)` → nếu `!ok` show toast lỗi + return; nếu ok → `cart/addItem`. **Tức là quét 1 mã WEIGHT là TỰ ĐỘNG đọc cân + tính kg × giá/kg.** (Điều kiện: `config.scale.enabled===true`, `config.scale.port=COM5`.)
- **Driver cân Dibal:** `src/main/hardware/scale/dibal-gdpos-scale-driver.ts` (`readWeight()`), `scale-reader-service.ts` (auto-detect VID 067B / `KNOWN_SCALE_PORTS=['COM5']`), IPC `scale:read-weight` (`hardware.module.ts:229`), preload `pos.scale.readWeight()` / `scale.readWeight()`.
- **Đọc cân thủ công per-line:** `Cart.tsx:200`, `CartItem.tsx:138` (nút "Read scale" trên từng dòng giỏ).
- **In nhãn:** `src/main/hardware/zebra/zpl-formatter.ts` (nhãn sản phẩm 50×30, có barcode + text), `src/main/hardware/pdf/pdf-printer.ts` (`buildLabelHtml`).
- **Tính tiền dòng:** `src/shared/pos-sale.ts` `calculateLineTotalGrosze(price, qty, sellBy)`.

---

## 5. VIỆC CẦN LÀM (APP) — gaps

### T1 — Test luồng quét-cân (chủ yếu là BẬT cân + test, không phải build)
- Bật cân trong Settings POS1: `config.scale.enabled = true`, `port = COM5`.
- Sync để kéo 21 mã EAN mới.
- Test: quét nhãn "Thịt ba chỉ" (`2653581698166`) khi túi trên cân → giỏ phải có dòng `0.xxx kg × 25 zł/kg = ...`.
- **Acceptance:** quét mã WEIGHT + túi trên cân → 1 dòng giỏ đúng kg × giá/kg; quét mã PIECE → vẫn +1 như cũ (không đụng).

### T2 — Hold-to-print nhãn: WEIGHT in giá/kg (50×30)
- Feature "giữ sản phẩm để in mã EAN" hiện in **giá cố định**. Với sản phẩm **WEIGHT** phải in **tên + giá/kg** (dùng `classifyProductSale().priceSuffix` = `/kg`); PIECE giữ nguyên (giá).
- Sửa ở chỗ build dữ liệu nhãn (label data → `zpl-formatter.ts` / `pdf-printer.ts buildLabelHtml`): nếu `isWeighted` → dòng giá = `${retail_price} zł/kg`, ngược lại `${price} zł`.
- Nhãn vẫn in **barcode = EAN của sản phẩm** (mã `265...` đã có sẵn).
- **Acceptance:** giữ-in 1 món thịt → nhãn 50×30 hiện tên + "giá/kg", barcode quét được; món thường → nhãn như cũ.

### T3 — Fallback nhập kg tay khi cân lỗi/treo (#5) — user nói ĐỂ SAU, nhưng PHẢI làm vì hiện app TREO CỨNG
- Hiện tại nếu cân không phản hồi, `readWeight()` (IPC serial) có thể **treo (await không resolve)** → UI kẹt "Reading scale". 2 việc:
  1. **Timeout** cho `scale:read-weight` (vd 3–5s) → reject `SCALE_FAILED` thay vì treo.
  2. Khi lỗi (`SCALE_DISABLED/UNAVAILABLE/FAILED/UNSTABLE`) → thay vì chỉ toast-rồi-bỏ, mở **ô nhập kg tay** (có quyền/cảnh báo) để thu ngân vẫn bán được → tạo dòng giỏ với `quantity = kg nhập tay`, `sellBy=WEIGHT`.
- **Acceptance:** rút cân ra/cân lỗi → quầy KHÔNG treo, hiện ô nhập kg tay, nhập 0.350 → dòng giỏ `0.350 kg × giá/kg`.

### T4 — POS3 = chế độ "trạm dán nhãn" giới hạn
- POS3 chỉ cần: xem danh mục **thịt**, chọn món, **giữ để in nhãn**. KHÔNG thanh toán, KHÔNG mở ngăn kéo tiền, KHÔNG cần cân.
- Thêm 1 chế độ/role "label station" (vd flag trong config thiết bị) ẩn nút thanh toán + giới hạn category. Tránh bán nhầm + cài đặt gọn.
- In **offline-safe**: mã EAN tất định đã nằm local sau sync → in được dù rớt mạng tạm.
- **Acceptance:** POS3 mở ra chỉ thấy thịt + nút in nhãn; không có thanh toán.

---

## 6. Quyết định đã CHỐT (đừng hỏi lại)

- **Model B** (nhãn định danh + giá/kg, cân tại quầy). KHÔNG dùng barcode nhúng giá.
- **Giá lấy theo lúc QUÉT làm chuẩn** (POS dùng `retail_price` hiện tại). Nhãn cũ in giá/kg cũ vẫn quét được, tính tiền theo giá hiện tại. Khi đổi giá trên /add thì nhãn in ra sau sẽ tự là giá mới.
- **Không tính bì (tare)** — bỏ qua.
- **Nhãn nội bộ:** chỉ **tên + giá/kg** (không cần nhãn thực phẩm đầy đủ xuất xứ/hạn dùng). In trên nhãn 50×30.
- Cân đã hợp chuẩn (legalizacja) — ok.
- **1 túi = 1 loại thịt = 1 nhãn.** Trộn nhiều loại → in nhiều nhãn.

---

## 7. Edge cases

- Nhãn rách/mất → cho in lại (giữ-in lại món đó).
- Hoàn trả dòng hàng cân → đã theo dòng (backend refund nhận `sale_quantity` thập phân) → ok.
- Quét mã chưa sync về local → "không tìm thấy" → sync lại.
- 2 món Cánh gà / Tim lợn chưa có giá → quét ra giá 0; tạm thời đừng bán tới khi có giá.

---

## 8. Kiểm tra fiscal (do user/Claude verify riêng — #3)

Dòng paragon fiskal hàng cân phải in **kg (3 số lẻ) × giá/kg = thành tiền** + đơn vị (ELZAB). Backend `ReceiptItemDto` đã có `unit`; payload fiscal do APP build → đảm bảo gửi `quantity` thập phân (kg) + `unit='kg'`. Cần 1 lần in thật để xác nhận ELZAB in đúng "0,354 kg × 49,90 = 17,67".

---

## 9. File map (POS-zira)

| Vai trò | File |
|---|---|
| Phân loại WEIGHT/PIECE | `src/shared/product-sale-classifier.ts` |
| Luồng thêm-giỏ-có-cân | `src/renderer/components/pos/retail-sale-flow.ts` |
| Quét mã → giỏ (đã wire cân) | `src/renderer/components/pos/POSLayout.tsx` (`handleBarcodeKeyDown`) |
| Driver cân Dibal | `src/main/hardware/scale/dibal-gdpos-scale-driver.ts`, `scale-reader-service.ts` |
| IPC đọc cân | `hardware.module.ts:229` (`scale:read-weight`), preload `pos.scale.readWeight` |
| Nút đọc cân/giỏ | `src/renderer/components/pos/Cart.tsx`, `CartItem.tsx` |
| In nhãn 50×30 | `src/main/hardware/zebra/zpl-formatter.ts`, `src/main/hardware/pdf/pdf-printer.ts` |
| Tính tiền dòng | `src/shared/pos-sale.ts` |
| Reprint (local, gross) | `src/main/pos/payment-controller.ts` (`reprintReceipt`) |

**Tóm tắt cho bot:** Luồng quét→cân→giỏ và driver cân ĐÃ CÓ. Trọng tâm còn lại = (T2) nhãn in giá/kg cho WEIGHT, (T3) chống treo khi cân lỗi + nhập kg tay, (T4) chế độ POS3 label-station. T1 chủ yếu là bật cân COM5 + sync + test.
