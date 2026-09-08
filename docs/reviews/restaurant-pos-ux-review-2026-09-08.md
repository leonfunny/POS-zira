# Review POS nhà hàng — 08/09/2026

Phạm vi: ảnh người dùng gửi lúc 01:12, frontend Electron ở nhánh `codex/pos-ui-release-foundation`, thư mục `C:/Users/maxis/enail/POS-zira-release-foundation`. Áp dụng quy trình `code-design-review` cho màn chọn món và chỉnh giỏ; đây là báo cáo, không phải bản sửa giao diện.

Kết luận: bố cục bán hàng đã dùng được, nhưng cần sửa các lỗi xử lý đơn và phân bổ lại không gian trước khi tối ưu hình thức. Đánh giá thiết kế chủ quan: **C — chức năng cơ bản rõ, nhưng giao diện nhà hàng chưa được điều chỉnh đủ từ bộ POS dùng chung**. Tông đất ấm và nút thanh toán nổi bật là những điểm nên giữ.

## Bằng chứng và giới hạn

- Đã xem ảnh, đọc 12 component gồm các hộp thoại chỉnh giỏ, đối chiếu kiểu dữ liệu sản phẩm local, chỗ gắn template và reducer giỏ hàng.
- Tái hiện lỗi gộp ghi chú bằng `PosStore` đã build, với Electron/config/logger được mock. Không dùng giỏ hoặc database của app đang mở.
- Các nhận xét cuộn, trạng thái tìm kiếm, lưu đơn và bàn dựa trên đường đi trong mã nguồn; chưa thao tác E2E các trường hợp này trong app.
- Chưa kiểm tra thanh toán thực, in bếp, máy in hóa đơn, phân quyền backend, mạng hoặc toàn bộ màn hình thanh toán. Không thể kết luận tổng tiền/VAT sai từ ảnh có giỏ đang cuộn.
- Graph project `C-Users-maxis-enail-POS-zira-release-foundation`, generation `2026-09-07T22:42:16Z`, Tier 2. Coverage được kiểm tra theo đường dẫn; metadata thay đổi và i18n bị loại khỏi index, nên bằng chứng quyết định lấy từ source hiện tại. Không tuyên bố đã tìm hết mọi lỗi.

## Các vấn đề về hành vi

### R1 — P1: Hai ly khác yêu cầu bị gộp vào một dòng

Thao tác tái hiện: thêm Bubble tea → lưu ghi chú `Khong duong` → thêm lại Bubble tea bình thường. Kết quả thực tế là một dòng `quantity: 2, notes: "Khong duong"`. Nhân viên không thể thể hiện chính xác một ly không đường và một ly bình thường bằng cách này.

Nguyên nhân: phép gộp chỉ so `variantId`, nhân viên và course; không xét ghi chú. Khi gộp, giữ ghi chú của dòng có sẵn. [pos-store.ts](../../src/main/pos/pos-store.ts#L363)

Đề xuất: chỉ gộp các dòng thực sự cùng cấu hình; tối thiểu tách dòng khác ghi chú. Với đồ uống tùy chọn, nên có dữ liệu size/đường/đá/topping rõ ràng và đưa cấu hình đó vào điều kiện gộp. Chưa xác minh backend đã hỗ trợ các tùy chọn này hay chưa.

### R2 — P1: Hướng dẫn lưu đơn nhưng màn nhà hàng chưa có thao tác lưu

Thông báo chặn đổi bàn/loại đơn yêu cầu thanh toán hoặc lưu đơn. Tuy nhiên `RestaurantTemplate` không truyền `onHold` cho `Cart`, còn nút lưu chỉ hiện khi có callback này. Luồng nhà hàng đang thiếu cách tạm giữ đơn để phục vụ khách tiếp theo. Chốt chống chuyển nhầm món vừa thêm giải quyết việc gán sai bàn, nhưng chưa hoàn thiện luồng phục vụ nhiều đơn.

Bằng chứng: [RestaurantTemplate.tsx](../../src/renderer/components/pos/templates/restaurant/RestaurantTemplate.tsx#L138), [chỗ dùng Cart](../../src/renderer/components/pos/templates/restaurant/RestaurantTemplate.tsx#L355), [điều kiện hiện Hold](../../src/renderer/components/pos/Cart.tsx#L1004).

Đề xuất: có `Lưu đơn` và `Đơn đang mở`, lưu cả bàn, loại đơn và nội dung giỏ. Sau khi lưu thành công mới cho đổi sang đơn khác. Không bỏ chốt chống đổi nhầm bàn. Với quán bán tại quầy, cân nhắc cho đổi tại chỗ/mang đi/giao hàng trong cùng đơn nếu thao tác cập nhật được kiểm soát và chưa bắt đầu thanh toán.

### R3 — P2: Sửa số lượng một món làm giỏ nhảy xuống cuối

Effect phụ thuộc cả danh sách ID và số lượng, nhưng luôn cuộn đến `scrollHeight`. Với giỏ dài như ảnh, cuộn lên sửa món đầu sẽ bị kéo về cuối. Khi thêm lại một món đã ở trên, dòng tăng số lượng cũng có thể nằm ngoài vùng nhìn dù có highlight.

Bằng chứng: [Cart.tsx](../../src/renderer/components/pos/Cart.tsx#L775).

Đề xuất: giữ vị trí khi sửa hoặc xóa dòng; khi thêm món, đưa chính dòng vừa thay đổi vào vùng nhìn nếu cần. Không tự cuộn khi nhân viên đang kiểm tra một vùng khác trong đơn.

### R4 — P2: Tìm kiếm không có kết quả dễ bị hiểu nhầm là chưa có sản phẩm

`ProductGrid` đã hỗ trợ `loading`, `emptySearchQuery`, `onClearSearch`, `resetScrollKey`, nhưng màn nhà hàng không truyền chúng. Tìm chuỗi không khớp rơi vào thông báo catalog rỗng và hướng dẫn thêm sản phẩm. Lỗi đọc sản phẩm/danh mục không có catch + trạng thái lỗi tương ứng; có thể giữ danh sách cũ hoặc hiện trạng thái rỗng gây hiểu nhầm. Đổi danh mục cũng không chủ động đưa cuộn về đầu.

Bằng chứng: [RestaurantTemplate.tsx](../../src/renderer/components/pos/templates/restaurant/RestaurantTemplate.tsx#L97), [chỗ gắn ProductGrid](../../src/renderer/components/pos/templates/restaurant/RestaurantTemplate.tsx#L325), [ProductGrid.tsx](../../src/renderer/components/pos/ProductGrid.tsx#L46).

Đề xuất: tách rõ đang tải, không có kết quả, salon chưa có menu và lỗi tải; có nút thử lại/xóa bộ lọc phù hợp. Reset vị trí khi đổi danh mục.

### R5 — P2: Chọn thử bàn cũng đánh dấu bàn đang dùng

Khi có cấu hình bàn, chỉ chọn một bàn trống đã gọi `updateStatus(..., 'occupied')`, chưa cần món hay đơn. Chọn A rồi B khi giỏ trống không trả A về trống trong luồng này. Đây là vấn đề của chế độ có bàn, chưa thể quan sát từ ảnh hiện tại.

Bằng chứng: [RestaurantTemplate.tsx](../../src/renderer/components/pos/templates/restaurant/RestaurantTemplate.tsx#L153).

Đề xuất: phân biệt bàn đang chọn với bàn có đơn đang phục vụ; trạng thái bận nên gắn với việc mở/lưu đơn hợp lệ, có xử lý khi hủy đơn.

### R6 — P2: Ghi chú đang gõ chưa được bảo vệ khi thanh toán

Textarea giữ nội dung trong state riêng của từng dòng; chỉ nút OK mới đưa ghi chú vào giỏ. Màn thanh toán không nhận trạng thái đang sửa ghi chú. Nếu gõ yêu cầu rồi bấm thanh toán mà chưa bấm OK, nội dung vừa gõ chưa thuộc đơn gửi đi.

Bằng chứng: [CartItem.tsx](../../src/renderer/components/pos/CartItem.tsx#L82), [editor](../../src/renderer/components/pos/CartItem.tsx#L327), [mở thanh toán](../../src/renderer/components/pos/templates/restaurant/RestaurantTemplate.tsx#L218). Đây là suy luận từ source, chưa tái hiện bằng giao diện.

Đề xuất: lưu rõ ràng khi rời editor, hoặc yêu cầu hoàn tất ghi chú trước khi mở thanh toán. Cần bảo đảm kết quả lưu được xác nhận.

## Thẩm mỹ và thao tác trên ảnh

| Vấn đề | Ảnh hưởng | Đề xuất |
|---|---|---|
| Khoảng 11 cột món, giỏ chỉ chiếm khoảng 15% chiều rộng ảnh | Nhiều món cùng kiểu ly khó phân biệt; đơn dài khó kiểm tra | Chế độ cảm ứng ưu tiên 6–8 cột tùy màn, cột đơn rộng hơn; giữ chế độ dày cho thu ngân quen |
| Dòng giỏ cao, lặp tên/thành tiền, đơn giá, một hàng nút | 11 dòng món đã cần cuộn nhiều | Hàng chính tên + thành tiền; thông tin phụ nhỏ hơn; chỉ dòng đang chọn mở đủ công cụ sửa |
| Thanh loại đơn kéo hết chiều ngang nhưng rất thấp | Tốn ngang, ít diện tích bấm theo chiều dọc | Nhóm chọn gọn ở đầu vùng đơn hoặc cạnh tìm kiếm, cao khoảng 44–48 CSS px, có trạng thái chọn rõ |
| Danh mục tên dài, một hàng trượt ngang và ẩn thanh cuộn | Khó biết còn danh mục bên phải, khó tìm nhóm hay dùng | Tên hiển thị ngắn, mũi tên/dấu hiệu cuộn, danh mục yêu thích; cho xem toàn bộ nhóm |
| Tên món bị cắt ở phần phân biệt hương vị | Nhiều ly trông giống nhau; dễ chọn nhầm | Rút gọn tiền tố chung trên nhãn POS, ưu tiên hương vị/size; giữ tên đầy đủ trong chi tiết và dữ liệu đơn |
| Ảnh món có nền và tỉ lệ không thống nhất; nhiều ô chỉ có chữ L/C | Khó quét thị giác, cảm giác menu chưa hoàn thiện | Chuẩn hóa thumbnail, dùng `contain` phù hợp cho ly/chai nền trắng; fallback tên món rõ hơn, rà các ảnh thiếu |
| Nhiều nút cam + các dải danh mục đen cùng hút mắt | Mức quan trọng giữa chọn món và thanh toán chưa rõ | Giữ tông cam đất; giảm độ nặng của tab chưa chọn; giữ thanh toán là điểm nhấn chính |
| Tên món mở giảm giá khi bấm | Người mới dễ tưởng sẽ mở chi tiết/tùy chọn món | Cho dòng đang chọn có thao tác rõ `Ghi chú`, `Tùy chọn`, `Giảm giá`; tránh chức năng ẩn chỉ có tooltip |
| Nút Xóa lặp ở mọi dòng, xóa ngay | Bấm nhầm mất dòng cùng ghi chú, khó phục hồi | Có hoàn tác xóa dòng; giữ xác nhận khi xóa toàn bộ giỏ, không thêm hộp thoại cho mọi lần bấm |
| Giao diện tiếng Việt nhưng còn Note và đơn vị szt | Thiếu nhất quán | Dịch nhãn UI; tên menu Ba Lan có thể giữ theo nhu cầu nhân viên, không tự động dịch dữ liệu bán hàng |

Các giá trị 6–8 cột, chiều rộng giỏ và kích thước chữ là hướng thiết kế cần đối chiếu độ phân giải/DPI của màn bán hàng. Không suy ra kích thước vùng bấm thật chỉ từ ảnh đã thu nhỏ. Source của nút cộng/trừ đã có chiều cao 44–48 CSS px; điểm quá nhỏ rõ nhất là `DiningOptions` (`text-xs py-1`, khoảng 24 CSS px với cỡ chữ gốc thông thường).

Các ô chữ L/C cho thấy fallback đang hoạt động; ảnh chưa đủ xác định là file ảnh không có, URL hỏng hay tải thất bại. `object-cover` có thể cắt ảnh khi khác tỉ lệ, nên cần kiểm tra thumbnail gốc trước khi áp dụng một kiểu hiển thị cho mọi món.

`Note` xuất hiện do `pos.note`, `pos.addNote`, `pos.addNoteShort` không có trong file dịch đã kiểm tra; `CartItemRow` dùng fallback tiếng Anh. `szt` có thể là đơn vị lấy từ dữ liệu món. Việc tên món còn tiếng Ba Lan không tự nó chứng minh lỗi i18n: resolver cố ý dùng tên gốc nếu thiếu bản dịch.

## Bản đồ component và trạng thái

| Component | Tải/rỗng/lỗi | Phản hồi và điểm thiếu |
|---|---|---|
| RestaurantTemplate | Bàn có tải + lỗi + retry; catalog thiếu loading/error riêng | Chặn đổi ngữ cảnh; thiếu lưu đơn; trạng thái bàn bị đổi ngay khi chọn |
| DiningOptions | Không tải dữ liệu riêng | Có màu chọn; thiếu disabled/busy và thông tin chọn cho trình đọc màn hình |
| TableMap | Dữ liệu do parent cấp | Có màu trạng thái; cần tránh chỉ dùng màu để phân biệt bận/đặt trước/chờ tính tiền |
| CourseSelector | Không tải dữ liệu riêng | Màu chọn; điều khiển nhỏ, thiếu ngữ nghĩa trạng thái chọn |
| SearchBar | Có hỗ trợ pending, nút xóa và scanner | Parent không truyền pending; vài nhãn hỗ trợ vẫn tiếng Anh |
| CategoryTabs | Dữ liệu do parent cấp | Trượt ngang; thiếu dấu hiệu còn nhóm khác, thiếu trạng thái chọn qua ARIA |
| ProductGrid | Có skeleton, rỗng catalog và rỗng tìm kiếm | Template chưa nối đủ props; đoạn hướng dẫn rỗng hardcode tiếng Việt |
| ProductCard | Ảnh có fallback, lazy-load; có hết hàng | Toàn card bấm được bằng chuột/phím; tên/ảnh cần rõ hơn, chưa có số lượng trong giỏ trên card |
| Cart | Giỏ rỗng, giỏ có món, chặn thanh toán khi chưa mở ca | Có highlight dòng mới, tổng tiền và thanh toán cố định; cuộn sai khi sửa |
| CartItemRow | Ghi chú local; in nhãn/cân có busy/error nếu được gắn | Chưa có undo xóa, ghi chú chưa lưu dễ bị bỏ sót; chức năng giảm giá ẩn trong tên |
| DiscountPopup | Kiểm tra giá trị nhập, đóng/hủy | Có dialog semantics + hook tương tác; chưa chạy thử focus trên thiết bị |
| PricePopup | Có kiểm tra, busy, lỗi khi cập nhật giá | Có đường render ở cả hai chế độ hiển thị action; không kết luận nút sửa giá bị hỏng |

## Luồng thao tác đề xuất

```text
Mở POS / xác định quán có bàn hay bán tại quầy
  → Chọn loại đơn [và bàn nếu cần]
  → Menu: đang tải / lỗi + thử lại / không có menu / có món
  → Tìm hoặc chọn danh mục: không khớp → xóa bộ lọc
  → Chọn món → tùy chọn bắt buộc nếu món có cấu hình
  → Giỏ: kiểm tra, sửa số lượng, lưu ghi chú; giữ nguyên vị trí đang sửa
       ├─ Lưu đơn → xác nhận lưu thành công → đơn mới / đơn đang mở
       └─ Thanh toán → hoàn tất dữ liệu còn đang sửa → kiểm tra ca → màn thanh toán
```

Màn thanh toán và sau thanh toán cần một đợt kiểm tra riêng; sơ đồ trên chỉ xác định điểm bàn giao dữ liệu.

## Việc nhỏ nên làm trước

1. Nối trạng thái tìm kiếm rỗng, loading và reset cuộn đã được ProductGrid hỗ trợ.
2. Dịch nhãn Note và các nhãn thao tác của dòng giỏ.
3. Tăng chiều cao DiningOptions; bổ sung `aria-pressed` và biểu hiện đang xử lý.
4. Thêm dấu hiệu cuộn/mở toàn bộ danh mục.
5. Sửa quy tắc tự cuộn giỏ khi chỉ sửa số lượng. Đo lại trên giỏ 15–20 dòng.

Đây là các thay đổi tương đối nhỏ; lỗi gộp yêu cầu món và lưu/khôi phục đơn cần xử lý theo luồng dữ liệu, không nên coi là chỉnh CSS.

## Tổng kết phạm vi

- 12 component được đọc; 6 nhóm vấn đề hành vi, trong đó lỗi gộp ghi chú đã tái hiện cô lập.
- 10 nhóm đề xuất thị giác/thao tác; một số liên quan chất lượng dữ liệu menu.
- Khoảng trống trạng thái chính: tải/lỗi/tìm kiếm của catalog; trạng thái lưu đơn; bảo vệ ghi chú chưa lưu.
- Trọng tâm accessibility: điều khiển nhỏ, biểu diễn trạng thái chọn, nhãn thao tác còn thiếu dịch; chưa audit toàn bộ bàn phím hay đo contrast.
- Không auto-fix trong lượt review. Các quyết định về mật độ lưới, quy trình tùy chọn món và lưu đơn là đề xuất để đưa vào đợt sửa tiếp theo.
