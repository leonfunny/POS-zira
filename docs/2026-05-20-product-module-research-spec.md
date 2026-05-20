# Product module research and specification

Date: 2026-05-20

Scope: nghien cuu va dac ta module "San pham" cho Zira AI POS desktop app. Tai lieu nay chua trien khai code. Muc tieu la xac dinh module can co gi de phu hop voi chu cua hang nho, nhan vien ban hang, nguoi khong thong thao may tinh.

## Ket luan ngan

Module "San pham" khong nen la mot trang quan tri phuc tap kieu ERP. No nen la mot cong cu lam viec tai quay: tim san pham that nhanh, quet ma vach, them san pham moi, sua gia, sua ton kho, an/ngung ban, va in tem neu co may in nhan. Cac truong nang cao nhu SKU, variant, gia von, nha cung cap, don vi tinh, VAT dac biet nen co nhung khong duoc lam che mat 4 thao tac chinh: ten, gia ban, ma vach, so luong.

Trong app hien tai, POS catalog da co `product_variants`, `categories`, barcode search, draft product import, quick-add bang camera, local SQLite mirror va server sync. Vi vay module moi phai quan ly cung mot catalog do. Khong nen tao mot kho san pham rieng trong local SQLite, vi se gay lech so voi ban hang, self-checkout, hoa don, ton kho va sync server.

## Nghien cuu POS tuong tu

Square xem Item Library la trung tam de tao, sua, sap xep, track inventory, quan ly variants va locations/channels. Square cho tao/sua item voi cac thong tin co ban nhu ten, gia, mo ta; dong thoi co the quan ly bien the va ton kho tu cung mot hub [1]. Square Retail cung co flow tao san pham bang cach quet UPC/GTIN, canh bao de tranh trung lap neu ma da co trong Item Library, va cho them variation/stock trong qua trinh tao [2].

Shopify POS uu tien search va scan. Nguoi dung co the tim theo barcode, variant name, product title, SKU, tag, vendor, description; search khong can khop tuyet doi va van giu cart hien tren man hinh trong luc tim [3]. Shopify cung tach logic product/variant: khi co variants, gia va inventory duoc chinh o tung variant rieng [4].

Lightspeed nhan manh matrix product/variant: moi bien the can SKU va barcode rieng, dac biet voi quan ao, size, mau, goi hang khac nhau. Lightspeed cung cho sua UPC, EAN, custom SKU, manufacturer SKU, va tu dong sinh barcode/system ID cho item, ke ca non-inventory item nhu coupon/promotion [5].

Loyverse gom cac tac vu item thuc dung cho cua hang nho: them items/categories, lam viec voi item list trong POS, low stock notification, barcode, variants, composite item, export/import [6]. Dac biet, flow quet barcode bang camera rat phu hop voi nguoi khong gioi may tinh: o man hinh edit item, bam icon scan de dien Barcode; o item list, scan ma moi thi mo card san pham moi voi barcode da dien san, scan ma cu thi mo san pham de sua [7].

Ve UX, nhom nguoi dung it thong thao may tinh can man hinh noi dung theo ngon ngu doi thuc, trang thai ro rang, loi co cach sua ngay, va it bat nho. Nielsen Norman Group khuyen giao dien noi bang ngon ngu cua nguoi dung, lam cac hanh dong/lua chon hien ro thay vi bat nguoi dung nho, va phong loi truoc khi submit [8]. Voi POS cam ung hoac man hinh ban hang, W3C khuyen target cham/toa do toi thieu 44 x 44 CSS px de de bam, nhat la voi tac vu lap lai hoac kho undo [9].

## Hien trang trong Zira POS

Source of truth hien tai la backend catalog, local app mirror vao SQLite de ban hang offline/nhanh. Cac diem lien quan:

- `src/main/database/repos/product-repo.ts`: doc `product_variants`, `categories`, search by barcode/SKU/name, hide template parents khi da co sellable variants.
- `src/main/database/migrations.ts`: bang `product_variants` co `name`, `sku`, `barcode`, `retail_price`, `category_id`, `in_stock`, `vat_rate`, `available_qty`, `price_gross`, `sale_unit`, `name_translations`; bang `draft_products`; bang `local_variant_imports`.
- `src/main/sync/product-sync.ts` va `src/main/sync/draft-product-sync.ts`: sync product/draft tu server ve local.
- `src/main/network/api-client.ts`: doc `/api/v1/warehouse/public/products`, lookup EAN, scan-create, quick-add image analyze/create.
- `src/main/modules/pos.module.ts`: IPC read products/categories, import draft offline-first, scan-create online.
- `src/renderer/components/pos/templates/retail/RetailTemplate.tsx`: search retail dang uu tien EAN/SKU; unknown barcode route sang scan-import/quick-add.
- `src/renderer/components/pos/QuickAddCameraModal.tsx`: da co flow chup anh, AI doc thong tin, nhap gia va stock.
- `src/renderer/components/pos/ScanImportModal.tsx`: da co flow import san pham draft khi quet ma chua co trong POS catalog.

Rang buoc quan trong: tien trong app dung minor units/grosze, khong dung float cho logic. Ten canonical `name` dung cho order/fiscal payload; `name_translations` chi de hien thi. Module san pham phai ton trong quy uoc nay.

## Muc tieu nguoi dung

Nguoi dung chinh la chu shop nho hoac nhan vien ban hang. Ho thuong can lam nhanh cac viec sau:

1. Quet ma de xem san pham nay da co chua.
2. Them san pham moi khi nhap hang hoac khi khach mang len quay ma chua co trong may.
3. Sua gia ban va ten san pham khi bi sai.
4. Tang/giam ton kho sau khi nhap hang, dem lai, hong, mat, tra hang.
5. An san pham khong ban nua ma khong lam mat lich su hoa don.
6. Tim san pham bang ten, ma vach, SKU hoac danh muc.
7. In tem ma vach/tem thong tin neu cua hang co may in nhan.

Module phai cho phep lam cac viec nay bang tu ngu don gian: "Gia ban", "So luong con", "Ma vach", "Danh muc", "Ngung ban", "Nhap them hang". SKU co the hien la "Ma noi bo (SKU)" de nguoi dung khong bi jargon.

## MVP de trien khai truoc

MVP nen gom 6 man hinh/flow nho, khong nen lam mot admin lon ngay tu dau.

### 1. Danh sach san pham

Danh sach can co search lon o tren cung, auto-focus, ho tro go/quet barcode. Ket qua can hien ten, gia ban, ton kho, danh muc, barcode/SKU, trang thai dang ban/ngung ban. Nen co filter nhanh: "Tat ca", "Sap het", "Het hang", "Chua co gia", "Ngung ban", va danh muc.

Danh sach nen uu tien layout table compact tren desktop, nhung row phai de bam. Moi row click mo edit sheet. Cac action nhanh khong nen nho qua: "Sua", "Nhap hang", "In tem", "Ngung ban".

### 2. Them san pham nhanh

Flow mac dinh nen bat dau tu barcode:

1. Quet/nhap barcode.
2. Neu da co san pham: mo man hinh sua san pham do, khong tao trung.
3. Neu co draft/master catalog: hien preview va nut "Dung san pham nay".
4. Neu chua co gi: mo form moi voi barcode da dien san.

Form them nhanh chi bat buoc: ten san pham, gia ban, so luong ban dau, VAT mac dinh, danh muc tuy chon. SKU nen tu sinh neu de trong. Barcode co the scan lai bang nut icon camera/scanner.

### 3. Sua san pham

Man hinh sua nen la right-side drawer hoac modal rong, khong phai form dai nhieu tab. Tren dau hien ten + barcode + trang thai sync. Truong chinh:

- Ten san pham.
- Gia ban gross.
- VAT.
- So luong con, nhung thay doi ton kho phai mo dialog "Nhap hang / Kiem lai / Hong / Mat / Tra hang" thay vi sua so am tham.
- Barcode va SKU.
- Danh muc.
- Anh san pham.
- Don vi ban: cai, kg, g, lit, goi, chai, hop.
- Dang ban/ngung ban.

Luu phai co validate ro: gia ban lon hon 0 neu muon ban, barcode khong trung, stock khong am, VAT trong tap hop hop le. Nut huy/thoat phai ro va khong lam mat thay doi ma khong hoi.

### 4. Dieu chinh ton kho

Khong nen cho nguoi dung sua truc tiep `in_stock` bang mot o input duy nhat. Nen co flow rieng:

- "Nhap them hang": cong them so luong.
- "Kiem lai ton": dat lai so luong thuc te sau khi dem.
- "Hong / mat": tru so luong va luu ly do.
- "Tra hang": cong/tru theo chinh sach.

Moi adjustment can co reason, idempotency key, thoi gian, nguoi thao tac. Sau khi luu, module goi sync va cap nhat POS grid/cart display.

### 5. Danh muc

Danh muc can don gian: ten, mau/icon tuy chon, thu tu hien thi. Cho tao danh muc ngay trong form san pham bang "Tao danh muc moi" neu nguoi dung khong thay danh muc phu hop. Khong bat nguoi dung roi form dang them san pham.

### 6. Ngung ban thay vi xoa that

Voi san pham da tung ban, chi cho "Ngung ban" hoac "An khoi POS". Khong hard delete local, vi order history, refund, receipt va sync can variant id cu. Neu server cho delete, client van nen goi soft delete/isActive false va giu local row inactive.

## Nen co sau MVP

Variants nen co sau khi MVP on dinh. Variant dung cho san pham cung mot template nhung khac size/mau/vi/goi. Moi variant can barcode/SKU/gia/stock rieng. UI nen co nut "Them bien the" va bang nho, khong day nguoi dung vao matrix phuc tap neu ho chi ban tap hoa don gian.

CSV import/export nen la phase sau, vi hay tao loi ma vach/gia/encoding. Khi lam, can template mau, preview truoc khi import, canh bao duplicate, va rollback neu loi.

In tem ma vach/tem gia nen tan dung printer LABEL hien co. MVP co the in mot tem tu man hinh san pham; sau do moi lam batch print.

Lich su thay doi nen co cho manager: ai sua gia, ai chinh ton, truoc/sau la gi. Day la tinh nang quan trong khi nhieu nhan vien dung chung may.

## Khong nen lam

Khong nen tao module chi sua truc tiep bang local SQLite roi hy vong sync sau, vi backend dang la source of truth. Neu server chua co endpoint sua/tang ton/xoa danh muc, can viet server change request truoc.

Khong nen tron `accounting_products` cua invoice voi POS `product_variants`. Hai bang co muc dich khac nhau; tron chung se gay sai fiscal/order/catalog.

Khong nen bat nguoi dung hieu template/variant ngay tu dau. UI co the dung chu "San pham" va "Loai/size" thay vi noi thuat ngu noi bo.

Khong nen xoa that san pham da ban. Nen an/ngung ban.

Khong nen dat qua nhieu truong bat buoc. Voi shop nho, them san pham phai xong trong duoi mot phut neu da co barcode va gia.

## De xuat kien truc

Module moi nen la tab rieng trong main app sidebar, vi day la cong viec quan tri chu shop lam ngoai luc tinh tien. POS window nen co nut shortcut "San pham" hoac "Them nhanh" de mo dung module/edit flow khi dang o quay.

Renderer nen tao khu vuc rieng, vi du:

- `src/renderer/components/products/ProductModule.tsx`
- `src/renderer/components/products/ProductList.tsx`
- `src/renderer/components/products/ProductEditor.tsx`
- `src/renderer/components/products/StockAdjustmentDialog.tsx`
- `src/renderer/components/products/CategoryPicker.tsx`
- `src/renderer/hooks/useProducts.ts`

Main/preload nen them IPC wrapper co ten ro rang, nhung IPC nay phai goi backend mutation khi co thay doi:

- `products:list`
- `products:get`
- `products:create`
- `products:update`
- `products:deactivate`
- `products:adjust-stock`
- `categories:create`
- `categories:update`

Sau moi mutation thanh cong, main process nen chay product sync/delta sync hoac upsert response vao local mirror roi phat `pos:products-synced`. POS grid, self-checkout va customer display phai nhan cung data moi.

## Server contract can co

Hien app da doc `/api/v1/warehouse/public/products`, lookup EAN, scan-create va quick-add. De module sua san pham day du, backend can endpoint mutation ro rang. Neu cac endpoint nay chua co, phai lam server change request thay vi client workaround.

Can toi thieu:

- Create product/variant voi idempotency key.
- Update product/variant: name, barcode, SKU, category, VAT, price gross, sale unit, image, active.
- Check duplicate barcode/SKU theo salon/location.
- Adjust stock voi reason: receive, recount, damage, theft/loss, return.
- Create/update category.
- Emit `catalog:updated`, `stock:updated` hoac support delta `nextSince` de local mirror cap nhat.
- Return payload cung shape voi `ProductVariantRow` hoac du du lieu de `toQuickAddVariantRow`/normalizer map chinh xac.

## UX rules cho nguoi khong thong thao may tinh

Nut chinh phai to va ro: "Luu", "Nhap hang", "Ngung ban", "In tem". Cac target hay bam nen dat toi thieu 44 x 44 px.

Thong bao loi phai noi cach sua: "Ma vach nay da dung cho Nuoc Coca 500ml. Mo san pham do?" tot hon "duplicate barcode".

Lua chon nguy hiem phai co confirm va undo neu co the: ngung ban, giam ton kho lon, doi barcode, doi VAT.

Khong bat nguoi dung nho quy trinh. Moi man hinh nen co hanh dong tiep theo ngay tai cho: scan ma, chon danh muc, luu, in tem.

Trang thai sync/offline phai ro. Neu dang offline, cho luu local draft neu kien truc ho tro, nhung phai hien "Dang cho dong bo" va khong gia vo da len server.

Mac dinh tot hon cau hinh: VAT lay theo config/country, quantity mac dinh 1, category co the bo trong, SKU auto-generate, price format theo PLN.

## Success criteria

Module duoc coi la dat MVP khi:

1. Chu shop co the quet barcode moi, tao san pham co ten/gia/stock, va san pham xuat hien trong POS grid ma khong restart app.
2. Sua gia/ten/barcode cua san pham da co cap nhat dung tren POS sale flow sau sync.
3. Dieu chinh ton kho khong lam mat lich su va khong cho stock am ngoai y muon.
4. Barcode/SKU duplicate duoc chan bang thong bao de hieu.
5. Ngung ban san pham khong lam hong order history/refund/receipt cu.
6. UI dung duoc voi chu shop it kinh nghiem: khong yeu cau hieu template id, variant id, minor units, backend sync.
7. `npm run typecheck:renderer` pass sau khi trien khai renderer.

## Nguon

[1] Square Support Center, Create and edit items: https://squareup.com/help/us/en/article/8335-create-and-edit-items

[2] Square Support Center, Create items by scanning barcodes: https://squareup.com/help/us/en/article/7992-automate-item-creation-with-square-for-retail

[3] Shopify Help Center, Searching for products in Shopify POS: https://help.shopify.com/en/manual/sell-in-person/shopify-pos/inventory-management/searching-for-products

[4] Shopify Help Center, Managing your Shopify POS variants: https://help.shopify.com/en/manual/sell-in-person/shopify-pos/inventory-management/products/variants

[5] Lightspeed Retail, Adding and editing scannable barcodes: https://retail-support.lightspeedhq.com/hc/en-us/articles/30950332908699-Adding-and-editing-scannable-barcodes

[6] Loyverse Support Center, Items: https://help.loyverse.com/help/items

[7] Loyverse Support Center, Barcodes Scanning by Built-in Device Camera: https://help.loyverse.com/help/barcodes-scanning-built-device

[8] Nielsen Norman Group, 10 Usability Heuristics for User Interface Design: https://www.nngroup.com/articles/ten-usability-heuristics/

[9] W3C, Understanding Success Criterion 2.5.5 Target Size: https://w3c.github.io/wcag21/understanding/target-size.html
