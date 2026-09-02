# Đơn in mác — 5 việc tiếp theo (kế hoạch)

**Ngày:** 2026-09-02 · **Nhánh:** `feat/label-print-order-20260902` · **Máy:** `tnh` (xưởng may New Fashion)

Paul chốt làm tiếp 5 việc, xếp theo thứ tự đề xuất bên dưới. Hai việc bị loại
khỏi danh sách, ghi lại để phiên sau không đào lại:

- **Đưa đơn vào DB thay vì localStorage — HOÃN.** Hiện chỉ chạy trên đúng một
  máy nên chưa cần. Rủi ro vẫn còn nguyên (cài lại Windows là mất 50 đơn), ghi
  ở đây để lúc thêm máy thứ hai thì làm trước tiên.
- **Mác in chồng lệch ~6 mm — ĐÓNG, không phải lỗi phần mềm.** Paul kiểm lại:
  dải vải bị dính vào nhau nên kéo lệch. In liên tục vài lần nữa không tái hiện.

Mỗi việc dưới đây: làm gì, đụng file nào, quyết định thiết kế cần chốt, và test
sẽ viết. Chưa việc nào được code.

---

## Thứ tự đề xuất

| # | Việc | Vì sao xếp ở đây | Ước lượng |
|---|---|---|---|
| 1 | **In thử 1 cái** (mục 4) | Rẻ nhất, chặn được lỗi đắt nhất (sai chính tả trên cả cuộn) | nhỏ |
| 2 | **Nhân bản đơn** (mục 3) | Hệ quả trực tiếp của thay đổi "lưu đè" hôm nay, đang là lỗ hổng | nhỏ |
| 3 | **Bắt tổng % = 100** (mục 6) | Tem sai thành phần là sai với khách và sai luật nhãn dệt may | nhỏ |
| 4 | **In tiếp sau khi kẹt** (mục 2) | Đau nhất khi xảy ra, nhưng cần quyết định cẩn thận (xem dưới) | vừa |
| 5 | **Dán bảng từ Excel** (mục 7) | Lợi nhất về thời gian gõ, nhưng phụ thuộc dạng file khách gửi | vừa |

---

## 1. In thử 1 cái trước khi chạy cả đơn

**Vấn đề.** Gõ sai chính tả, chọn nhầm ký hiệu giặt, hay sai thành phần thì chỉ
biết sau khi cả cuộn đã ra. Không có cách nào in đúng 1 cái để soi.

**Làm gì.** Thêm nút **"In thử"** cạnh nút "In". Nó dựng một kế hoạch 1 bản cho
mỗi loại đang tick — 1 mác vải và/hoặc 1 tem dán — lấy ô đầu tiên có số lượng
làm mẫu, rồi chạy qua đúng `runPrintPlan` như bình thường.

**Đụng file.**
- `src/shared/label-print-order.ts`: thêm `buildSamplePlan(order): PrintStep[]` —
  dùng lại `buildPrintPlan` rồi lấy bước đầu của mỗi loại và ép `quantity: 1`.
  Viết riêng chứ không thêm cờ vào `buildPrintPlan`: kế hoạch thật và bản in thử
  khác nhau về ý nghĩa, trộn vào một hàm là chỗ dễ ship nhầm cả đơn 680 tem.
- `src/renderer/components/label/PrintOrderPanel.tsx`: nút + copy 3 thứ tiếng.

**Quyết định cần chốt.**
- In thử có bị chặn bởi `validateOrder` không? **Đề xuất: có**, trừ lỗi
  `EMPTY_ORDER` — in thử khi chưa nhập số lượng vẫn hợp lý, nhưng in thử với mã
  tem sai ký tự thì vô nghĩa vì máy sẽ từ chối.
- In thử có được chạy khi đang in đơn thật không? **Không** — cùng `printInFlight`.

**Test.** Kế hoạch mẫu đúng 1 bản mỗi loại; tôn trọng ô tick "in gì"; không đụng
tới `completedIds` của đơn thật; nút tắt khi đang in.

---

## 2. Nhân bản đơn

**Vấn đề.** Từ 02/09 sửa đơn cũ là **ghi đè** lên chính đơn đó. Đơn tuần sau
giống hệt chỉ khác màu thì mở đơn cũ ra sửa là mất đơn cũ.

**Làm gì.** Nút **"Nhân bản"** cạnh "Lưu đơn": giữ nguyên nội dung đang mở, cấp
một `orderId` mới, và **chưa lưu gì cả** — nhãn nút Lưu quay về "Lưu đơn".

**Vì sao không lưu ngay.** Lưu ngay thì danh sách có hai dòng tên y hệt, đúng
cái phiền mà hôm nay vừa bỏ đi. Người dùng gần như luôn đổi màu/tên trước khi
lưu, nên để họ lưu khi đã sửa xong.

**Đụng file.** `PrintOrderPanel.tsx` (nút + copy). Không đụng storage.

**Test.** Nhân bản rồi Lưu ⇒ hai đơn trong danh sách, đơn gốc giữ nguyên nội
dung cũ; nhân bản mà không Lưu ⇒ danh sách không đổi; sau nhân bản, đơn đang mở
không còn được tô xanh ở dòng nào.

---

## 3. Bắt tổng phần trăm bằng 100

**Vấn đề.** Hiện chỉ **cảnh báo** `Tổng phần trăm đang là 70%` rồi vẫn cho in.
Tem ghi "70% POLIESTER" mà thiếu 30% còn lại là sai với khách, và nhãn thành
phần dệt may ở EU yêu cầu ghi đủ 100% theo khối lượng.

**Làm gì.**
- Thêm `PERCENT_NOT_100` vào `OrderProblem` — **chặn in**, như `BAD_CODE`.
- Cạnh cảnh báo, thêm nút **"gán phần còn thiếu"**: thiếu 30% và chất liệu cuối
  đang để 0 thì một cú bấm điền 30 vào đó.
- Chỉ chặn khi **có ít nhất một chất liệu**. Đơn không ghi thành phần vẫn in
  được (mác chỉ có size + ký hiệu giặt là hợp lệ, đã có khách đặt như vậy).

**Đụng file.** `src/shared/label-print-order.ts` (`validateOrder`, hàm gán phần
thiếu), `PrintOrderPanel.tsx` (nút + copy 3 thứ tiếng).

**Quyết định cần chốt.** Có cần đường vòng để in đè khi tổng ≠ 100 không?
**Đề xuất: không.** Nếu sau này gặp ca thật cần in đè thì thêm, chứ mở sẵn cửa
thì cái chặn thành vô nghĩa.

**Test.** 100% qua; 70% chặn; 0 chất liệu qua; 3 chất liệu 33+33+34 qua; nút gán
phần thiếu điền đúng số và chỉ hiện khi có chỗ để điền.

---

## 4. In tiếp sau khi kẹt giấy

**Vấn đề.** Kẹt giấy hay tắt app giữa đơn 680 tem thì phải đếm tay rồi gõ lại số
lượng. Phần chạy in **đã** trả `completedIds` và **đã** nhận
`options.completedIds`, nhưng màn hình chưa dùng tới.

**Điểm cốt lõi phải giữ.** `completedIds` nghĩa là **"đã gửi cho máy in"**, không
phải "đã in ra giấy". Máy nhận lô rồi kẹt thì lô đó vẫn tính là xong. Vì vậy màn
hình **không được tự động in tiếp**; nó phải nói rõ đã gửi bao nhiêu và để người
đứng máy chọn. Đúng như dòng chữ đang có trong app: *"Máy kẹt hay tắt app giữa
chừng thì phải đếm tem thật trước khi in lại."*

**Làm gì.**
- `print-order-storage.ts`: lưu tiến độ `{ orderId, completedIds, at }` dưới một
  khoá riêng. Ghi sau **mỗi lô xong**, không phải cuối đơn — kẹt xong tắt app thì
  cuối đơn không bao giờ tới.
- `PrintOrderPanel.tsx`: mở đơn có tiến độ dở thì hiện một khối:
  *"Lần trước đã gửi 7/14 lô (350/680 tem). Đếm tem thật rồi chọn:"*
  → **"In tiếp từ lô 8"** · **"In lại từ đầu"** · **"Bỏ tiến độ"**.
- Xoá tiến độ khi đơn chạy xong, khi bấm "In lại từ đầu", và khi "Đơn mới".

**Quyết định cần chốt.** Tiến độ gắn theo `orderId`. Đơn chưa lưu bao giờ vẫn có
`orderId` (cấp lúc mở panel) nên vẫn theo dõi được — cần test đúng ca này.

**Test.** Ghi tiến độ sau mỗi lô; dừng giữa chừng rồi mở lại thấy đúng số lô;
"In tiếp" bỏ qua đúng các lô đã gửi; "In lại từ đầu" in đủ; chạy xong thì tiến
độ biến mất; "Đơn mới" xoá tiến độ; đơn khác không thấy tiến độ của đơn này.

---

## 5. Dán bảng từ Excel

**Vấn đề.** Đang gõ tay từ tờ A4 của khách: size ngang, màu dọc, số lượng trong
ô. Đơn 8 màu × 6 size là 48 ô gõ tay, sai một ô là in sai cả lô.

**Ba cách, đề xuất cách (b).**

| | Cách làm | Ưu | Nhược |
|---|---|---|---|
| a | Đọc file `.csv` | Không cần thư viện | Bắt staff "Save As CSV" mỗi lần |
| **b** | **Dán từ Excel (Ctrl+C → Ctrl+V vào ô dán)** | **Không cần thư viện, không cần đụng file, staff bôi đen đúng vùng cần** | Phải bôi đen đúng vùng |
| c | Đọc thẳng `.xlsx` | Không phải thao tác gì thêm | Thêm dependency nặng; bố cục file khách mỗi nơi một kiểu (ô gộp, tiêu đề lung tung) nên **vẫn** phải làm màn ánh xạ cột |

Cách (b): clipboard từ Excel là văn bản phân cách bằng **tab**, nên bộ đọc chỉ
là tách dòng + tách tab. Cách (a) dùng chung bộ đọc đó, chỉ khác dấu phân cách —
làm (b) trước, (a) là phần thêm vài dòng nếu cần.

**Làm gì.**
- `src/shared/label-print-order.ts` (hoặc file mới `order-paste.ts`):
  `parsePastedGrid(text): { sizes, rows, problems }`. Luật đọc: dòng đầu là
  header size (bỏ qua 1–2 ô đầu trống hoặc ghi "màu"/"kolor"); mỗi dòng sau là
  một màu; ô rỗng hoặc không phải số = 0. Nhận cả tab lẫn dấu phẩy.
- Màn hình: nút "Dán từ Excel" mở một ô `textarea`, dán vào, **xem trước** bảng
  đọc được (bao nhiêu màu, bao nhiêu size, tổng bao nhiêu tem) rồi mới bấm
  "Nhận". Không bao giờ đè thẳng vào bảng đang có mà không cho xem trước.

**Quyết định cần chốt.**
- Dán vào thì **đè** bảng hiện có hay **thêm vào**? Đề xuất: **đè**, và nói rõ
  trong màn xem trước ("sẽ thay 3 màu × 2 size đang có").
- Cột **mã tem** có trong bảng dán không? Tờ A4 của khách thường có. Đề xuất:
  nếu một cột header khớp `KOD`/`CODE`/`MÃ` thì đọc làm mã tem, không thì để
  trống và staff điền sau (đơn vẫn in được mác vải, chỉ thiếu tem dán).

**Test.** Bảng chuẩn 3×2; ô trống; số có dấu phẩy thập phân; dòng thừa ở cuối;
header có ô đầu trống; dán một ô duy nhất; dán chữ không phải bảng (báo lỗi rõ
chứ không dựng bảng rỗng); cột mã tem nhận đúng; chữ dán vào cũng lên in hoa như
mọi thứ khác trong tab này.

---

## Luật chung khi làm 5 việc này

- Giữ nguyên trong nhánh `feat/label-print-order-20260902`, không đụng `main`.
- Mỗi việc một commit, có mutation test chứng minh, chạy suite đầy đủ, rồi mới
  bundle sang `tnh` chạy test + `npm run build` ở đó.
- 13 file test đỏ sẵn trên Linux (SSH, mạng, sqlite, Electron) không liên quan —
  đối chiếu với con số đó, đừng coi là hồi quy.
