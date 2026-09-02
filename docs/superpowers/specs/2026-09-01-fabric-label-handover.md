# In mác vải (fabric care label) trong POS-zira — bàn giao

**Ngày:** 2026-09-01 · **Nhánh:** `feat/fabric-label-tspl-20260828` · **Máy:** `tnh` (DESKTOP-LOEP8FC, xưởng may)

Tài liệu này để một phiên khác đọc rồi brainstorm/kiểm tra/lên plan tiếp. Phần
"đã đo" là số liệu thật lấy từ máy; phần "giả định" là chưa kiểm chứng.

---

## 1. Mục tiêu

Xưởng may in **mác vải do khách đặt** lên dải vải liên tục 20 mm bằng máy
**TSC MB241**. Thiết kế có thể dùng bất kỳ cách ghi size nào (`M`, `S/M`,
`44/46`, `L/XL`, ...), và thường được nhận từ khách/bên thiết kế dưới dạng
`.btw`; app không tự tái tạo nội dung, ký hiệu hay bố cục của khách.

**Tem EAN** trên giấy bằng máy **Honeywell PC42E-D** vẫn nằm trong tab Label,
nhưng được tách thành lane thứ hai và để sau. Màu tạm thời không in trên mác
vải.

**Máy này chỉ để in và khai thông tin — không bán hàng.** Đây là ràng buộc chi
phối mọi quyết định thiết kế bên dưới.

---

## 2. Trạng thái: cái gì chạy được

### Luồng chính mới: thư viện file khách (đã build, chưa in vật lý)

Luồng theo catalog/template bên dưới vẫn được giữ làm công cụ kỹ thuật khẩn
cấp, nhưng **không còn là workflow chính của nhân viên**. Workflow mới là:

```text
Nhập khách + mã đơn + size/biến thể + revision
  → file picker của main process nhận .btw hoặc PNG
  → lưu file bất biến trong vùng riêng của salon
  → .btw = NEEDS_CONVERSION (chỉ lưu nguồn, tuyệt đối không in trực tiếp)
  → gắn PNG production đã xuất đúng chuẩn = READY
  → preview, chọn nhiều dòng và nhập số lượng
  → chia lô tối đa 50 tem (ví dụ 120 = 50 + 50 + 20)
  → main đọc lại file, kiểm hash/kích thước/salon
  → TSPL BITMAP byte-exact → Win32 RAW spooler → TSC MB241
```

Hợp đồng production hiện tại:

| Thuộc tính | Giá trị |
|---|---|
| Vật liệu | **20 mm**, 203 dpi, continuous media |
| File để in | **PNG**, không dùng PDF và không tự co giãn |
| Canvas đầu vào | rộng đúng **160 px**, cao **80–480 px** |
| Lề an toàn | **9 px trắng mỗi bên**; app giữ đúng dải giữa 142 px |
| Tọa độ in | 1 pixel nguồn = 1 dot đầu in; giữ nguyên chiều cao |
| Số lượng | 1–999 mỗi dòng; UI gửi từng chunk tối đa 50 |

PDF bị loại khỏi MVP vì thêm một tầng page size/DPI/driver có thể scale ngầm.
PNG là artifact production đã raster ở đúng 203 dpi, nên main có thể kiểm tra
chính xác trước khi phát byte 1-bit. `.btw` vẫn là nguồn thiết kế có giá trị và
được lưu nguyên bản; app hiện **không decode hoặc convert `.btw`**.

### Đã in thật lên vải, có ảnh xác nhận

Đường in hoạt động end-to-end và đã được chứng minh bằng bản in vật lý:

```
FabricTagComposer / FabricTagPrintPanel
  → IPC PRINT_FABRIC_TAG
  → hardware.module.printFabricTag
  → TscDriver.printFabricTag
  → renderFabricTagBitmap   [BrowserWindow ẩn → bitmap 1-bit]
  → TSPL: SIZE/GAP/DIRECTION/REFERENCE/SPEED/DENSITY/CLS/BITMAP/PRINT
  → sendRawToPrinter        [Win32 spooler RAW, cố tình bypass driver]
  → TSC MB241 / USB001
```

Chữ Ba Lan (`Ł`) và dấu tiếng Việt (`ặ`, `ẹ`) đều lên nét rõ trên vải.

### Thông số máy in đã chốt (đo thật, không phải tra datasheet)

| | |
|---|---|
| Khổ vải | **20 mm chính xác** (đo bằng thước in ra: 19.95 mm) |
| Loại | dải liên tục, **không có khe** → `sensor = none` |
| Phương pháp | thermal transfer, ribbon resin đen |
| Density / Speed | **12 / 2** — cho độ đậm tốt, không lem |
| **Lệch mép** | **1.1 mm** — xem mục 5 |
| Dao cắt | **KHÔNG CÓ**. Đã bắn lệnh `CUT`, máy không phản ứng. Header có sẵn `SET TEAR ON` nên vải đẩy ra thanh xé, xé tay |

### Luồng template nội bộ đã dựng trước đó (nay là công cụ kỹ thuật dự phòng)

| Thành phần | File |
|---|---|
| Bảng lưu mác theo mã hàng | `migrations.ts` v67 `fabric_tag_templates` |
| Repo | `src/main/database/repos/fabric-tag-template-repo.ts` |
| 5 handler IPC | `pos.module.ts` — `pos:fabric-tag-templates:*` |
| Bridge | `preload.ts` **và** `preload-pos.ts` (cả hai, xem mục 6) |
| Tương thích cấu hình cũ | Đọc `garment` rồi chuẩn hoá một lần về `retail`; không còn dùng nó làm cổng in |
| Chọn mẫu theo dữ liệu | Tab Label chỉ hiện mẫu có `template_id` khớp catalog; không phụ thuộc EAN/POS mode |
| Panel in theo size | Có sẵn nhưng cố ý nhận danh sách rỗng cho đến khi duyệt dữ liệu size thật |
| Trust boundary | Main process giới hạn text/quantity/logo, chặn SVG/ảnh bom và serialize raster + RAW spool |
| Bench in headless | `scripts/fabric-tag-bench.cjs` |
| Kiểm tra mã mẫu read-only | `scripts/seed-fabric-tag.cjs`; chế độ ghi `--seed` đã bị vô hiệu hoá |

Kết quả kiểm chứng cuối của nhánh hardening được ghi ở mục 7; chưa có lệnh in
vật lý nào được gửi trong đợt này.

---

## 3. Quyết định đã chốt (và lý do)

1. **Không biến size chỉ-dùng-để-in thành sản phẩm bán hàng.** Ép mỗi size thành
   sản phẩm sẽ làm nó hiện trên lưới bán, dính tồn kho và báo cáo doanh thu.

2. **KHÔNG dùng `sell_by = 'SIZE'`.** `sell_by` chỉ chứa một giá trị
   (`PIECE`/`WEIGHT`), **không lưu được danh sách S/M/L**. Nó là lá cờ, không
   phải mô hình — vẫn phải có bảng chứa size ở đâu đó.

3. **Không suy ra mác từ catalog.** Thành phần sợi, ký hiệu giặt, cách ghi size
   và bố cục thuộc file khách của đúng đơn/revision. Màu hiện không in; các biến
   thể màu trong catalog tuyệt đối không được coi là size.

4. **Không tự động hoá BarTender UltraLite hiện tại.** `.btw` được app nhận và
   lưu làm nguồn, nhưng chỉ PNG production đã được xuất đúng chuẩn mới có thể
   chuyển trạng thái sang `READY`. Xem mục 5.

5. **Không đi qua PDF/driver Windows và không tự scale.** Đường in gửi bitmap
   byte-exact qua TSPL để tránh driver render lại. File 25.1 mm không được app
   âm thầm bóp xuống 20 mm.

---

## 4. Quyết định mới và vấn đề còn mở

### 4.1 Cổng chặn bằng `posMode` là sai (Paul nêu, tôi đồng ý)

Trước đợt hardening, panel chỉ hiện khi `posMode === 'garment'`. Nhưng **salon
này không bán hàng**, nên bắt vào Cài đặt đổi "chế độ POS" mới dùng được tab
Label là vô lý.

**Đã chốt 2026-09-01:** bỏ `posMode` khỏi luồng in mác. Module Manager hiện có
là công tắc bật/ẩn tab Label; dữ liệu quyết định empty state hay panel mẫu mác;
cấu hình/sẵn sàng của `FABRIC_TAG` chỉ quyết định nút Print có được bấm hay
không. Không thêm một toggle mới.

`garment` cũng không còn là một POS mode công khai. Bản sửa phải chấp nhận giá
trị legacy đủ lâu để đổi cấu hình đã lưu về `retail`, nếu không cả bản mới lẫn
bản rollback 1.0.26 có thể fail validation lúc khởi động.

### 4.2 Size không tồn tại trong catalog — không còn chặn workflow file khách

Đây là phát hiện quan trọng nhất, và nó **lật một lập luận tôi đưa ra hôm qua**.

Tôi đã lập luận "S/M/L là các biến thể chung `template_id`, app có sẵn". Cơ chế
thì có, nhưng dữ liệu thật thì không. Đo trên máy:

```
template_id 0d4a3c38-... có 7 biến thể:
  Komplet 3-częściowy LOTUS                    MOON-VE114-KOMPLET
  Komplet soft warm ... LOTUS - beżowy   (be)  MOON-VE114-BEZ
  ...                        - czarny  (đen)   MOON-VE114-CZA
  ...                        - czekoladowy     MOON-VE114-CZEK
  ...                        - niebieski       MOON-VE114-NIE
  ...                        - pudrowy         MOON-VE114-PUD
  ...                        - żółty  (vàng)   MOON-VE114-ZOL
```

**Toàn là MÀU.** `template_id` trong catalog này gom **màu**, không gom size.
Tra khắp dữ liệu: size không có ở dạng biến thể, không có cột, không có thuộc
tính. **Paul đúng khi nói "phải thêm size"** — tôi chỉ đúng ở chỗ `sell_by`
không phải nơi đặt nó.

Hệ quả vẫn giữ nguyên: không đưa 7 dòng màu vào panel size và không tạo 30 dòng
catalog chỉ để in. Tuy nhiên đây không còn là điểm chặn: thư viện artwork lưu
`variant` dưới dạng text tùy ý theo file khách (`M`, `S/M`, `44/46`, ...), độc
lập hoàn toàn với tồn kho, giá, barcode và product variant.

### 4.3 Thông tin chủ xưởng đang chuẩn bị

1. **Màu tạm thời không in lên mác.** Không dựng ma trận màu × size.
2. **Khổ vải đã chốt là 20 mm.** Bản in thử với inset 1.1 mm đã đẹp và nằm giữa
   khung vải.
3. **Thiết kế phụ thuộc khách/đơn**, không phải template sản phẩm do xưởng tự
   dựng. File `.btw` có thể có rất nhiều cách ghi size và nội dung khác nhau.
4. `Document2.btw` chỉ là nguồn thử workflow; nó khai 25.1 × 40 mm nên không
   được coi là production 20 mm và không được in cho tới khi có PNG đúng chuẩn.
5. Chủ xưởng sẽ gửi file/mẫu thật để review cách xuất production và in thử.
6. EAN tạm hoãn cho tới khi lane mác vải hoàn tất.

### 4.4 Không sản phẩm nào có EAN

Cả 7 biến thể đều `barcode = (none)`, nên nút in tem EAN đang khoá ("Thiếu
EAN"). Điều này chỉ chặn lane EAN cũ; thư viện mác vải theo file khách không
đọc barcode/catalog và vẫn chạy batch theo các row artwork READY. Composer kỹ
thuật trong Settings vẫn có thể in thủ công.

### 4.5 Đã có thư viện file; Composer cũ chỉ còn là công cụ khẩn cấp

Tab Label hiện có thư viện file bền vững theo salon: import, tìm/lọc theo khách,
preview PNG, gắn file production, retire, chọn nhiều dòng và nhập số lượng.
`FabricTagComposer` trong Settings vẫn tồn tại để chẩn đoán/in nội bộ khẩn cấp,
nhưng không phải đường nhân viên dùng cho file khách. Script
`seed-fabric-tag.cjs --seed` tiếp tục bị fail-closed.

### 4.6 Đồng bộ server chưa làm

Paul đã chốt đích đến là đồng bộ lên eNail. Bảng đã có sẵn `backend_id` /
`synced` / `synced_at`, nhưng **chưa có gì đọc/ghi chúng**. Backend eNail hiện
cũng chưa có `PrinterType.FABRIC_TAG`, `PrinterProtocol.TSPL` và
`PrintJobType.FABRIC_TAG`; DTO dùng enum nên đăng ký máy/remote job loại này sẽ
HTTP 400. Máy `tnh` hiện `serverPrinterId = null` và đi đường in local trực tiếp,
nên thiếu hụt backend không chặn lane hiện tại.

### 4.7 Scoping của artwork mới đã sửa; rollback của bảng template cũ vẫn mở

Migration v68 `fabric_tag_artworks` có `salon_id`; mọi repo query đều scope theo
salon, đường dẫn binary nằm trong thư mục có khóa salon đã hash, và đổi tenant
xóa metadata live. Main còn kiểm tenant generation sau các bước `await` và
đọc lại row ngay trước in. Migration v67 `fabric_tag_templates` cũ vẫn không có
`salon_id`, nên rủi ro rollback của workflow template cũ bên dưới vẫn tồn tại.

Một preflight rollback khác: schema 1.0.26 không nhận `LABEL.protocol=TSPL`.
`FABRIC_TAG` là property lạ nên bản cũ bỏ qua được, nhưng nếu từng cấu hình TSC
ở ô LABEL thì downgrade có thể fail ngay lúc đọc config. Trước khi release phải
có sanitizer/rollback contract đổi hoặc xoá đúng ô LABEL+TSPL; không được coi
việc chạy lại installer cũ là rollback an toàn.

---

## 5. Sự thật đã đo — đừng phải tìm lại

### `.btw` / BarTender: có thiết kế của xưởng, dùng làm nguồn tham khảo sau khi xác nhận

**Đính chính:** bản đầu của tài liệu này viết "không có file `.btw` nào của
xưởng". Sai — do bộ lọc tìm kiếm loại trừ cả thư mục `BarTender Documents`, mà
hai file thật lại nằm ngay thư mục gốc của nó.

- **Có đúng 2 file do xưởng tạo**, trong
  `C:\Users\X-Strike\Documents\BarTender\BarTender Documents\`:
  `Document2.btw` (94.257 B) và `sm.btw` (94.258 B), đều tạo/sửa **12-08-2026**.
  `sm.btw` là bản Save As của file kia — **ảnh xem trước nhúng bên trong giống
  hệt nhau**.
- Header trong file cho biết: `Edition=UltraLite`, và
  **`Printer: Name=TSC MB241; Port=USB001`** — thiết kế nhắm đúng máy in mác
  vải, `Author=X-Strike`, khổ `25.1 × 40 mm`, `DataEntryForms=1`. Khổ vải thật
  nay đã chốt là 20 mm, vì vậy file này chỉ dùng thử bước import/lưu nguồn và
  phải được xuất lại thành production 20 mm; app sẽ từ chối scale 25.1 → 20.
- **Nội dung mác** (rút từ PNG nhúng trong file):

  ```
  S/M
  70% LEN
  30% wiskoza
  [5 ký hiệu giặt]
  NATURALNY LEN
  Zalecany płyn do płukania dla miękkości
  ```

  Đây **chính là tem thứ ba** trong ảnh dải vải đầu tiên — tức bản in đó ra từ
  **BarTender**, không phải từ app. (Lỗi `.care-text` font-weight 400 trong
  renderer của ta là lỗi thật và đã sửa, nhưng quy tem trong ảnh đó cho nó là
  quy sai địa chỉ.)
- Tất cả 99 file `.btw` còn lại là **mẫu kèm bản cài** (AIAG, Caterpillar, DoD,
  EU Energy, GHS, Oracle, GM... — cùng ngày sửa 2018-03-22).
- Bản cài là **BarTender 2016 R7 UltraLite**. Thư mục
  `C:\Program Files (x86)\Seagull\BarTender UltraLite\` chỉ có `BarTend.exe`,
  `BtwConv.exe`, `Register.exe`, `SupportCollector.exe`, `SysInfo.exe`.
  **Không có `Commander.exe`, không có Integration, không có
  `Seagull.BarTender.Print.dll`** → **không điều khiển được từ chương trình
  khác, không nối được CSDL**.
- `C:\Program Files\Seagull` chỉ chứa gói **driver máy in**, không phải app.

### Lệch mép 1.1 mm là đặc tính cứng của máy

Gốc in `x=0` nằm **sâu vào trong mép vải ~9 dots ≈ 1.1 mm**. Đã thử chỉnh thanh
dẫn giấy hai lần, gần như không đổi. **TSPL không in được ở toạ độ âm**, nên mép
xa là không thể chạm tới.

Cách xử lý đang dùng: nhường đúng lề đó ở **cả hai bên** (`labelOriginInsetMm`),
tem còn 142 dots = 17.75 mm nhưng **nằm cân giữa**. Đã in xác nhận đẹp.

### Chiều dài tem là động

Bộ rasterise dàn tem ở chiều cao tự nhiên, đo lại, rồi driver khai đúng số đó;
chiều cao trong config là **trần**. Đo thật: 32 mm → 22 mm, tiết kiệm ~31% vải.
Driver **tự chặn trần** thay vì tin bộ rasterise.

### Chữ nhỏ phải in đậm

`.care-text` từng ghi đè `font-weight: 400`, trái với ghi chú ngay trên nó rằng
chỉ chữ đậm sống sót qua threshold 1-bit ở 203 dpi. Hậu quả trên vải:
`NATURALNY LEN` in ra thành `ATURALNY LE` — chữ `N` mất nét chéo. Đã bỏ ghi đè
và đặt sàn cỡ chữ 11 dots.

---

## 6. Bẫy đã sập — đừng sập lại

| Bẫy | Chi tiết |
|---|---|
| **Hai preload khác nhau** | Cửa sổ chính dùng `preload.ts`, cửa sổ POS dùng `preload-pos.ts`. Khai kênh IPC chỉ ở một file → `undefined` ở cửa sổ kia và **trắng màn hình cả app**. Đã có test chặn |
| **Substring trong test** | `'...:list'` là tiền tố của `'...:listIds'` — `toContain` khớp nhầm dòng, test pass oan trong khi binding đã mất. Ghim cả dấu nháy |
| **Electron tự thoát** | Trên Windows, đóng cửa sổ cuối là app thoát. Bộ rasterise huỷ cửa sổ offscreen → tiến trình chết giữa lúc in, mà **vẫn exit 0**. Cần `window-all-closed` |
| **Union bị nhân bản** | `PrinterProtocol` mất `TSPL` ở bản sao trong `classifyPrinterCategory` → máy TSC **không bao giờ** vào được ô `FABRIC_TAG`. `POS_MODES` từng bị chép tay ở **9 chỗ**. Luôn dùng nguồn chung |
| **Quét PnP timeout nuốt cả danh sách** | `getPosnetDriverStatus` dựng danh sách máy in từ một lệnh PowerShell nặng; timeout 20 s trên máy này → trả về rỗng, dropdown trống, lỗi chỉ ghi WARN rồi bị `.catch(()=>{})` nuốt. Đã thêm fallback hỏi thẳng spooler |
| **Giao thức mặc định sai loại ô** | Mặc định chung là `THERMAL`, mà `FABRIC_TAG` chỉ nhận `TSPL`. Ô `<select>` chỉ liệt kê loại hợp lệ nên **hiển thị TSPL trong khi giá trị thật là THERMAL** — mọi lần lưu bị backend từ chối, màn hình trông vẫn đúng |
| **`sql.js` ghi đè cả file** | Nạp cả CSDL vào RAM rồi ghi lại; crash/mất điện có thể truncate toàn bộ POS DB, còn process-check vẫn có TOCTOU. `seed-fabric-tag.cjs --seed` giờ bị từ chối vô điều kiện; chỉ được ghi qua app/repository |
| **CRLF trên Windows** | Checkout Windows làm 2 suite chết vì vite không nhận shebang kết thúc `\r\n`. Đã ghim LF bằng `.gitattributes` |
| **Server merge làm rơi tuning local** | `local_printers` không chứa gap/speed/density/sensor/inset; recreate driver từ mirror từng làm mất đúng thông số satin đã đo. Merge hiện giữ cả kích thước, target Windows và TSPL tuning từ `electron-store` |
| **Fresh pairing thành 50×30** | AJV dùng default chung cho mọi ô; server bỏ kích thước từng materialize mác vải thành khổ giấy 50×30. FABRIC_TAG giờ có schema/default riêng 20×60 và mapper chốt cùng giá trị trước reinit |
| **Refresh hoàn tác queue đã recovery** | Windows đổi `TSC MB241` thành `Copy 1`, recovery từng lưu đúng local nhưng lần refresh kế tiếp lại chép tên server cũ vào mirror. Config giờ giữ provenance theo đúng `serverPrinterId`: tên stale bị bỏ qua, còn một target server thật sự mới vẫn thắng |
| **Chọn queue mới nhưng provenance còn target cũ** | Sau auto-recovery, operator chọn queue B phải retarget provenance từ A sang B cho tới khi PUT backend được nhìn thấy. Chỉ xoá provenance sẽ tạo cửa sổ để response stale kéo cấu hình về tên cũ |
| **Nhận nhầm Canon là TSC** | Fragment model `mb2` khớp cả `Canon MAXIFY MB2750`. Recovery giờ dùng brand classifier có ưu tiên thay vì substring rồi mới dám persist queue mới |
| **Payload IPC/socket là dữ liệu không tin cậy** | TypeScript không bảo vệ runtime. Text điều khiển, số `NaN`/`Infinity`, quantity quá lớn, SVG và ảnh khai canvas khổng lồ đều bị chặn ở main trước renderer/spooler |
| **Header ảnh hợp lệ chưa đủ** | PNG có header/IDAT vẫn có thể hỏng. Chromium phải resolve `image.decode()` và trả đúng kích thước khai báo trước capture; reject là lỗi FINAL, không gửi RAW |
| **List mẫu kéo toàn bộ logo** | Logo hợp lệ tới 512 KiB; vài trăm mẫu có thể nhân thành hàng trăm MiB qua SQL.js/structured clone. Label chỉ lấy `listIds()`, rồi `get(id)` đúng một mẫu; endpoint list legacy không còn SELECT blob |
| **Mẫu lưu được nhưng không in được** | Print boundary yêu cầu tên thương hiệu hoặc logo; save trước đây lại nhận mẫu không có cả hai. IPC save giờ chặn từ đầu, và `listIds()` không quảng bá row legacy vô danh |
| **Hai tên cho cùng một khổ** | Local formatter dùng `labelWidth`, backend dùng `paperWidth`. Một giá trị cũ 20 có thể ghi đè edit mới 25 sau refresh. Persistence và payload server giờ đồng bộ hai alias theo `labelWidth` |
| **Enter từ panel mác chạy in EAN** | Global shortcut từng bắt event từ button/dialog. Giờ bỏ qua input, contenteditable, button/link/role dialog nên confirm mác không thể kích hoạt nhầm luồng EAN |
| **Chiều cao động từng cắt đáy** | Trước đây nội dung cao hơn trần bị `Math.min` cắt im lặng. Bây giờ renderer fail-closed trước RAW và báo phải tăng chiều cao/rút nội dung |
| **Chữ dài bị cắt ngang** | `overflow:hidden` từng che phần chữ vượt chiều rộng và edge-check chỉ WARN. Các block text giờ wrap trong bề rộng in; nếu raster vẫn có mực chạm mép trái/phải thì dừng trước RAW |
| **Hai click cùng event loop** | `setState(printing)` không khoá đồng bộ; hai click cực nhanh từng có thể enqueue hai run. Cả panel và Composer giờ có ref latch; main process còn có single-flight gate |
| **Reinit cắt ngang raster/RAW** | Save cấu hình có thể disconnect driver trong lúc BrowserWindow đang render, rồi instance cũ vẫn gửi bitmap với khổ cũ. Print FABRIC và thay driver giờ dùng cùng lifecycle lock, resolve lại driver sau lock; TSC kiểm tra connected ngay trước RAW |
| **Queue cũ sống lại và in trùng** | Windows có thể báo đã thử xoá job Offline/PaperOut nhưng job vẫn còn. FABRIC preflight giờ kiểm lại queue sau flush và dừng `SAFE_BEFORE_PRINT`; không gửi job mới cho tới khi queue cũ thật sự sạch |
| **`printerId` miss rơi sang máy cùng loại** | ID do server chỉ định là route vật lý chính xác, không phải gợi ý. Nếu driver ID đó không tồn tại thì job fail trước `PRINTING`; không được rơi sang một máy FABRIC_TAG/LABEL/receipt khác cùng type |
| **Hai dòng size dùng cùng ID** | State quantity theo ID làm hai row alias nhau, trong khi vòng in vẫn đi cả hai và có thể vượt trần run. ID rỗng/trùng giờ khoá toàn bộ run trước IPC |
| **Logo A/B về sai thứ tự** | Hai `FileReader` có thể hoàn tất ngược thứ tự, hoặc callback cũ sống sau Remove/unmount. Composer dùng generation token + abort, và khoá Print trong toàn bộ thời gian đọc ảnh |
| **Giá chỉ parse tiền tố** | `parseFloat('12abc')` từng thành 12 và `12.999` bị làm tròn. Composer dùng parser tiền tệ toàn chuỗi, nhận dấu phẩy/chấm thập phân hợp lệ và chặn dữ liệu mơ hồ/quá giới hạn |
| **Ký hiệu chăm sóc mâu thuẫn** | UI từng cho chọn `WASH_30` cùng `WASH_NO`. Shared policy dùng radio semantics theo wash/bleach/tumble/iron/dry-clean và main kiểm lại; `DRY_LINE`/`DRY_FLAT` để mở chờ xưởng duyệt |
| **QR mặc định Model 1** | Lệnh TSPL giờ ghi rõ `M2` và tính kích thước theo payload. Quiet zone vẫn cần scan smoke trên MB241 thật trước go-live |

---

## 7. Công cụ để kiểm chứng

**Bench in headless** — chạy đúng code thật, không cần giao diện (quan trọng vì
SSH không mở được cửa sổ GUI). Xuất ra **PNG chính là bitmap gửi tới đầu in**,
kèm số đo lề mực. Có `--print` mới in thật:

```powershell
npx electron scripts\fabric-tag-bench.cjs --tag scripts\fabric-tag-sample.json `
  --width 20 --height 60 --inset 1.1 --sensor none --density 12 --speed 2 `
  --out preview.png [--print]

# thước căn để đo lệch mép trên máy khác:
npx electron scripts\fabric-tag-bench.cjs --align --width 20 --height 30 --print
```

**Kiểm tra mã mẫu read-only:**

```powershell
node scripts\seed-fabric-tag.cjs          # xem có mã hàng nào
node scripts\seed-fabric-tag.cjs --seed   # cố ý bị từ chối; không ghi pos.db ngoài app
```

**Luật kiểm chứng đang áp dụng:** mọi assertion mới phải **mutation-test** —
phá đúng hành vi nó mô tả thì nó phải đỏ. Nhiều lần trong đợt này mutation bắt
được lỗi thật, kể cả lỗi nằm trong chính test.

**Hardening 2026-09-01 trên máy build Linux:** 236/236 test tập trung xanh;
typecheck main + renderer sạch; production build xanh. Full-suite checkpoint
đạt 3173 test xanh, 14 đỏ và 14 skip; toàn bộ 14 đỏ là giới hạn môi trường đã
tái hiện được (`electron-store` không có Electron userData, đường dẫn Windows
chạy trên Linux, và E2E thiếu X display), không nằm trong feature mác. Ba
regression TSC/routing cuối được thêm sau checkpoint này và đều nằm trong bộ
236 test xanh.

**Kiểm chứng cuối trên Windows `tnh`:** 236/236 test tập trung xanh; typecheck
main + renderer sạch; production build xanh; Electron E2E smoke 13/13 xanh.
Full suite đạt 353/354 file, 3300 test xanh, 1 skip. Test duy nhất đỏ là
`ssh-tunnel-startup.test.ts` hết timeout 5 giây khi chạy song song dưới tải;
chạy riêng ngay sau đó xanh trong 1,188 giây. Đây là flaky theo tải đã được cô
lập, không phải regression của feature mác.

**Artwork-library MVP 2026-09-01 trên checkout tích hợp Linux:** 15 file / 267
test tập trung xanh; typecheck main + renderer sạch; production build xanh.
Các test mới bao phủ `.btw` archive-only, PNG full decode/hash/crop/no-scale,
salon fence, file picker main-only, TSPL binary, hai preload, UI thiếu bridge,
chunk `120 → 50/50/20`, điểm dừng Continue/Stop thật giữa các chunk và latch
chống double-confirm. Audit cuối còn ghim revalidation ngay sát RAW, attach
một lần theo revision, bounded handle read và default inset 1.1 mm. Full suite
đạt 347 file /
3258 test xanh, 14 test đỏ và 14 skip; các lỗi đỏ đã tái hiện khi chạy riêng và
đều thuộc giới hạn môi trường Linux đã biết (đường dẫn Windows,
`electron-store` ngoài Electron, E2E thiếu X display), không chạm file feature.

**Artwork-library MVP kiểm chứng và package trên Windows `tnh`:** commit code
`6ff88bb89e4e88acf3bbb08de0c964ae40f6c203`; 15/15 file và 267/267 test tập
trung xanh. Full suite xanh hoàn toàn: 360/360 file, 3382 test pass và 1 skip;
Electron E2E cũng chạy thật trong suite, không có uncaught renderer error.
`npm run build` xanh (renderer typecheck, main compile, renderer production
bundle). Preview Windows x64/NSIS được tạo riêng tại:

```text
C:\Users\X-Strike\POS-zira\release\fabric-preview-20260901-141307-6ff88bb89e4e\Zira Setup 1.0.26.exe
```

Kích thước installer: 118.615.594 byte. SHA-256:
`79B7963D78FE8AB377AA66CC82A839FE878CE656656817B50606D2056C2CF276`.
Package còn đủ `.blockmap`, `latest.yml` và `win-unpacked\Zira.exe`. Build này
không ký số; chưa chạy installer, chưa mở/restart app cài sẵn và chưa gửi lệnh
in hay RAW tới máy in.

---

## 8. Việc tồn đọng / thứ tự làm tiếp

- **Build trước, chưa in — đã xong:** commit đã review ở `tnh`, focused + full
  suite Windows, production build và package preview đều xanh. Installer chưa
  được chạy; app cài sẵn và máy in không bị chạm tới.
- `Document2.btw` có thể dùng để smoke bước import: kết quả đúng phải là
  `NEEDS_CONVERSION`. Không dùng nó để smoke print vì nguồn khai rộng 25.1 mm.
- Khi nhận file thật, yêu cầu bên thiết kế/BarTender xuất một PNG production
  **160 px rộng ở 203 dpi**, cao 80–480 px, với 9 px trắng hai bên. Gắn PNG vào
  đúng row, xem preview và đối chiếu khách + đơn + size + revision.
- Trước lần in vật lý đầu: lấy xác nhận riêng, kiểm máy rảnh/queue sạch, chỉ in
  1 bản, đo lại tâm và chiều dài; sau đó mới thử lô nhỏ. Không coi build xanh là
  bằng chứng bản in vật lý.
- Durable batch ledger/resume chưa nằm trong MVP. Sau mỗi chunk không phải cuối,
  app dừng và yêu cầu nhân viên chọn **Tiếp tục** hoặc **Dừng**; sau crash/kẹt
  giấy vẫn phải kiểm đếm tem thật trước khi in lại.
- Workflow template/catalog cũ chỉ là kỹ thuật dự phòng; không thêm size JSON,
  không mở rộng editor template và không đồng bộ server trước khi file-based
  workflow được chứng minh bằng mẫu thật.
- **EAN làm sau mác vải.** Khi quay lại cần chốt EAN đại diện cho style, size
  hay tổ hợp nào và nguồn barcode; không trộn quyết định đó vào bản build này.
- Lane remote là dự án riêng: thêm enum/DTO/backend API/job routing rồi mới bật
  remote print. MVP hiện tại chỉ in local qua TSC đã cấu hình.
- Lane remote là dự án riêng: thêm enum/DTO/backend API/job routing và trả đủ
  `paperHeight`, rồi mới dùng các cột sync đã dự phòng.
- Các commit vẫn **chưa push GitHub**. Máy Windows không push được (GCM cần TTY,
  `wincredman` không dùng được trong phiên đăng nhập mạng). Đường vòng đã dùng:
  `git bundle` từ `tnh` → scp sang Netcup → push từ đó (Netcup xác thực GitHub
  bằng SSH với tư cách `leonfunny`). Chỉ push khi chủ repo yêu cầu rõ.
- Bundle bảo toàn trước đợt hardening:
  `C:\Users\X-Strike\fabric-label-efcb726-20260901.bundle`, SHA-256
  `0461A8B3116487214B26BE0EFF4A641F7BC4EA1E3A00CB94121A08FBFE65E03D`.
- `tests/hardware-posnet-config.test.ts` **flaky dưới tải song song** trên CPU
  này (AMD A8). Chạy riêng thì xanh. Không liên quan tới thay đổi nào ở đây.

## Đợt 02/09 — tab "Đơn in" và lần in Honeywell đầu tiên

- Máy in `Honeywell PC42E-D 203dpi` trên `tnh` đang trỏ **cổng USB002 không còn
  tồn tại**; thiết bị thật nằm ở `USB003` (`Get-PrinterPort` ghi
  `USB003 → Honeywell PC42E-D-203`). Hậu quả: job spool xong, `PRINT_TEST_OK`,
  hàng đợi vẫn còn 1 job và **không có tem nào ra**. Đã sửa bằng
  `Set-Printer -Name "Honeywell PC42E-D 203dpi" -PortName "USB003"`. Nếu sau này
  im lặng không in, kiểm cổng trước khi nghi code — Electron trả về thành công
  ngay khi spooler nhận, không đợi máy in.
- Đường in tem đóng gói đi qua **driver Windows** (`printPackagingStickerToDevice`
  → `printHtmlToDevice`), không phải ZPL. Driver cài là
  `Honeywell PC42E-T (203 dpi) - DP` (Direct Protocol) — nó tự dựng lệnh từ
  trang GDI, nên không cần app sinh DP. Đã chứng minh 02/09: một tem 50×30
  `New Fashion / KURTKA 114 / CZEKOLADA · M / SP006290` in ra thật, hàng đợi về 0.
- Trên `tnh`, `npm run build` xanh; 137 test của 10 file mới/đụng tới đều xanh.
