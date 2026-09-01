# In mác vải (fabric care label) trong POS-zira — bàn giao

**Ngày:** 2026-09-01 · **Nhánh:** `feat/fabric-label-tspl-20260828` · **Máy:** `tnh` (DESKTOP-LOEP8FC, xưởng may)

Tài liệu này để một phiên khác đọc rồi brainstorm/kiểm tra/lên plan tiếp. Phần
"đã đo" là số liệu thật lấy từ máy; phần "giả định" là chưa kiểm chứng.

---

## 1. Mục tiêu

Xưởng may in **mác vải** (care label: tên/logo, size, thành phần sợi, ký hiệu
giặt ISO 3758, made in) lên dải vải liên tục 20 mm bằng máy **TSC MB241**, và in
**tem EAN** trên giấy bằng máy **Honeywell PC42E-D**. Cả hai nằm trong **tab
Label** của app POS-zira.

**Máy này chỉ để in và khai thông tin — không bán hàng.** Đây là ràng buộc chi
phối mọi quyết định thiết kế bên dưới.

---

## 2. Trạng thái: cái gì chạy được

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

### Đã dựng trong code

| Thành phần | File |
|---|---|
| Bảng lưu mác theo mã hàng | `migrations.ts` v67 `fabric_tag_templates` |
| Repo | `src/main/database/repos/fabric-tag-template-repo.ts` |
| 5 handler IPC | `pos.module.ts` — `pos:fabric-tag-templates:*` |
| Bridge | `preload.ts` **và** `preload-pos.ts` (cả hai, xem mục 6) |
| Chế độ `garment` | `POS_MODES` trong `shared/types.ts` |
| Panel in theo size | `src/renderer/components/label/FabricTagPrintPanel.tsx` |
| Đoán size từ tên biến thể | `src/renderer/components/label/fabric-tag-size.ts` |
| Bench in headless | `scripts/fabric-tag-bench.cjs` |
| Nạp dữ liệu thử | `scripts/seed-fabric-tag.cjs` |

**Kiểm chứng:** 340 file / 3113 test xanh · typecheck main + renderer = 0 ·
mọi assertion mới đều mutation-test (phá hành vi thì test phải đỏ).

---

## 3. Quyết định đã chốt (và lý do)

1. **Cụm riêng, không nhét mã hàng may vào catalog bán hàng.** Ép mã hàng thành
   sản phẩm sẽ làm nó hiện trên lưới bán, dính tồn kho và báo cáo doanh thu.

2. **KHÔNG dùng `sell_by = 'SIZE'`.** `sell_by` chỉ chứa một giá trị
   (`PIECE`/`WEIGHT`), **không lưu được danh sách S/M/L**. Nó là lá cờ, không
   phải mô hình — vẫn phải có bảng chứa size ở đâu đó.

3. **Chia đôi dữ liệu:** thành phần sợi / ký hiệu giặt / made in thuộc **mã
   hàng**; size (và màu) thuộc **biến thể**. Sửa một lần ăn cả mã hàng.

4. **KHÔNG xây trên file `.btw` (BarTender).** Xem mục 5.

5. **Không đi qua PDF/driver Windows.** Đường in hiện tại gửi bitmap byte-exact
   qua TSPL chính là để tránh driver render lại. Chữ nhỏ 11 dots rất mong manh.

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

### 4.2 🚨 Size KHÔNG TỒN TẠI trong catalog — điểm chặn lớn nhất

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

Hệ quả: panel hiện tại sẽ hiện **7 dòng màu**, ô size trống hết (hàm đoán trả
rỗng vì `beżowy` không phải size — đúng thiết kế).

**Hướng đang ưu tiên nhưng chưa triển khai:** vì máy chỉ in, size có thể không
cần mã vạch / tồn kho / giá.
Biến size thành sản phẩm là thừa (6 màu × 5 size = 30 dòng catalog cho thứ
không bao giờ bán). Một phương án là **lưu danh sách size ngay trên mẫu mác**
dưới dạng mảng JSON, ví dụ `["S", "M", "L", "XL"]`. Chưa tạo migration/editor
cho đến khi xem bảng A4 và mẫu mác thật; tuyệt đối không đoán từ các dòng màu
trong catalog.

### 4.3 Thông tin chủ xưởng đang chuẩn bị

1. **Màu tạm thời không in lên mác.** Luồng đầu tiên chỉ có một trục size, không
   dựng ma trận màu × size.
2. Chủ xưởng sẽ gửi mẫu mác vải, mẫu tem EAN và một bảng A4 ghi rõ mã áo, nội
   dung, size, số lượng và cách in để cùng review bố cục/luồng thao tác.
3. Cần xác nhận hai file `.btw` mới tìm thấy ở mục 5 có phải thiết kế thật đã
   duyệt không, và khổ vật liệu chính xác là 20 mm hay 25.1 mm.
4. Cần chốt mác là thiết kế cố định hay đổi theo mã hàng/khách hàng.
5. Nếu Honeywell/EAN nằm trong scope, cần chốt nguồn EAN và EAN đại diện cho
   style, màu, size hay tổ hợp của chúng.

### 4.4 Không sản phẩm nào có EAN

Cả 7 biến thể đều `barcode = (none)`, nên nút in tem EAN đang khoá ("Thiếu
EAN"). Tức tab Label hiện **chưa in được cả hai loại tem** cho nhóm hàng này.

### 4.5 Chưa có form nhập liệu

Dữ liệu mác hiện nạp bằng `scripts/seed-fabric-tag.cjs`. Form nhập là việc kế
tiếp, và **bản dịch của panel đi kèm form đó** (panel đang dùng chuỗi tiếng Anh
làm fallback).

### 4.6 Đồng bộ server chưa làm

Paul đã chốt đích đến là đồng bộ lên eNail. Bảng đã có sẵn `backend_id` /
`synced` / `synced_at` để không phải migrate lại, nhưng **chưa có gì đọc/ghi
chúng**. Đây là cụm lớn, cần backend + API + hàng đợi offline.

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
  vải, `Author=X-Strike`, khổ `25.1 × 40 mm`, `DataEntryForms=1`. Tên file chưa
  chứng minh đây là bản đã duyệt; khổ này cũng mâu thuẫn với cuộn 20 mm đã đo.
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
| **`sql.js` ghi đè cả file** | Nạp cả CSDL vào RAM rồi ghi lại. Ghi từ ngoài trong lúc app chạy → bên lưu sau nuốt bên kia. `seed-fabric-tag.cjs` từ chối chạy khi app đang mở |
| **CRLF trên Windows** | Checkout Windows làm 2 suite chết vì vite không nhận shebang kết thúc `\r\n`. Đã ghim LF bằng `.gitattributes` |

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

**Nạp dữ liệu thử** (app phải đóng):

```powershell
node scripts\seed-fabric-tag.cjs          # xem có mã hàng nào
node scripts\seed-fabric-tag.cjs --seed   # nạp mác mẫu
```

**Luật kiểm chứng đang áp dụng:** mọi assertion mới phải **mutation-test** —
phá đúng hành vi nó mô tả thì nó phải đỏ. Nhiều lần trong đợt này mutation bắt
được lỗi thật, kể cả lỗi nằm trong chính test.

---

## 8. Việc tồn đọng

- Tại mốc `efcb726` có **12 commit chưa push lên GitHub**. Máy Windows không push được (GCM cần
  TTY, `wincredman` không dùng được trong phiên đăng nhập mạng). Đường vòng đã
  dùng: `git bundle` từ `tnh` → scp sang Netcup → push từ đó (Netcup xác thực
  GitHub bằng SSH với tư cách `leonfunny`).
- Bundle bảo toàn trước đợt hardening:
  `C:\Users\X-Strike\fabric-label-efcb726-20260901.bundle`, SHA-256
  `0461A8B3116487214B26BE0EFF4A641F7BC4EA1E3A00CB94121A08FBFE65E03D`.
- `tests/hardware-posnet-config.test.ts` **flaky dưới tải song song** trên CPU
  này (AMD A8). Chạy riêng thì xanh. Không liên quan tới thay đổi nào ở đây.
