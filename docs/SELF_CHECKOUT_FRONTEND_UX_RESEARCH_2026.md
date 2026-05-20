# Research UX/UI Self-Checkout Khách Hàng 2026

Trạng thái: tài liệu research để refactor frontend
Bề mặt: màn hình kiosk khách hàng tại `src/renderer/windows/self-checkout/`
Khách hàng mục tiêu: nhóm trẻ đến trung tuổi, khoảng 18-44 tuổi, dùng PL/EN/VI
Ngày: 2026-05-20

## 1. Kết Luận Chính

Không nên refactor Zira theo hướng "cửa hàng tự động hoàn toàn, không cần checkout". Kiểu đó cần camera, cảm biến, cổng vào/ra, định danh thanh toán, xử lý receipt tự động, quyền riêng tư và đối soát backend. Đây không phải là việc chỉ sửa frontend trong repo này.

Hướng phù hợp nhất cho Zira là kiosk hybrid: scan-first cho sản phẩm có barcode, menu-first cho món bếp/restaurant, luôn có giỏ hàng bên cạnh, tổng tiền lớn, và thanh toán ngắn gọn.

Flow đề xuất:

`Welcome -> Shopping/Menu + Cart -> Payment Overlay -> Receipt Progress -> Thank You`

Không làm landing page quảng cáo, không làm carousel hướng dẫn dài, không đưa setting/operator vào màn hình khách hàng.

Code hiện tại đã đi một phần đúng hướng:

- `WelcomeScreen.tsx` có lựa chọn `Grocery` và `Kitchen`.
- `ScanScreen.tsx` có department tabs, category chips, product tiles, search, cart và nút pay.
- `PaymentScreen.tsx` có chọn phương thức thanh toán.

Vấn đề là comment đầu `ScanScreen.tsx` vẫn nói màn hình là scanner-only, trong khi code đã có menu/category/product tiles. Refactor nên chốt lại quyết định sản phẩm: self-checkout của Zira không còn là scanner-only; nó là scan + menu kiosk.

## 2. Các Loại Self-Checkout Hiện Đại

| Loại | Ví dụ | Ý nghĩa cho Zira |
| --- | --- | --- |
| Kiosk scan truyền thống | NCR Voyix, Diebold Nixdorf EASY ONE, Toshiba System 7 | Đây là baseline an toàn: scan barcode, giỏ hàng, total, payment terminal, receipt, staff assist, trạng thái lỗi rõ ràng. |
| Kiosk order/menu | Toast Kiosk, Oracle Simphony Kiosk, Square Kiosk | Phù hợp nhất cho món bếp: menu trực quan, category, ảnh món, modifiers, out-of-stock, payment và order routing. |
| AI tray checkout | Mashgin | Khách đặt nhiều món lên tray, AI nhận diện. Ý tưởng UX tốt là phản hồi cực nhanh, nhưng cần hardware vision. |
| Smart cart | Instacart Caper Cart, Amazon Dash Cart | Chạy total trong lúc mua, hiển thị saving/deal, thanh toán ngay tại cart. Zira có thể học cách giữ tổng tiền luôn nổi bật. |
| Mobile scan-and-go | Walmart, Sam's Club | Khách tự scan bằng app rồi trả tiền. Không nên bắt khách Zira cài app cho V1. |
| Autonomous checkout-free store | Amazon Just Walk Out, Żabka Nano | Trải nghiệm nhanh nhất, nhưng là kiến trúc cửa hàng tự động, không phải refactor màn hình kiosk. |

NCR Voyix công bố survey 2025 cho thấy lý do mạnh nhất khiến khách chọn self-checkout là tốc độ; nhóm Gen Z và Millennials dùng self-checkout nhiều nhất. Forrester cũng ghi nhận người trẻ muốn thấy self-checkout trong nhiều loại cửa hàng hơn. Vì vậy UI của Zira nên ưu tiên: nhanh, riêng tư, tự chủ, ít chữ, ít bước.

## 3. Nên Học Gì Từ Các Sản Phẩm Này

Từ kiosk retail truyền thống, Zira nên học cấu trúc vận hành: vùng scan rõ, cart rõ, total rõ, thanh toán thật, receipt progress, và đường gọi nhân viên. NCR và Diebold đều nhấn mạnh phần cứng linh hoạt: touchscreen, scanner, printer, payment terminal, security features. UI phải giả định khách đang đứng trước màn hình, cầm sản phẩm, thao tác bằng một tay.

Từ kiosk restaurant/menu, Zira nên học cách trình bày menu. Toast nhấn mạnh menu presentation, navigation mượt hơn, loyalty/promo, out-of-stock và upsell. Oracle nhấn mạnh menu trực quan và một nguồn cấu hình chung giữa POS và kiosk để tránh sai giá/sai tồn kho. Với Zira, `Grocery/Kitchen` nên hoạt động như kiosk order thật: category rõ, tile sản phẩm rõ, món hết hàng disabled, add nhanh.

Từ smart cart, Zira nên học "budget awareness". Caper Cart và Dash Cart đều cho khách biết tổng tiền trong lúc mua. Zira cần giữ total lớn và sticky từ màn hình shopping trở đi.

Từ AI checkout, Zira nên học phản hồi tức thì. Mashgin hấp dẫn vì khách đặt sản phẩm xuống và được nhận diện nhanh. Zira chưa có hardware đó, nhưng có thể làm scan feedback rất tốt: flash xanh, beep, highlight item mới, total tick, lỗi scan có recovery.

Từ autonomous store, Zira chỉ nên học độ ít friction, không học kiến trúc. Żabka Nano và Amazon Just Walk Out giảm queue và giảm ritual thanh toán, nhưng phụ thuộc vào camera, gate, payment identity và receipt tự động. Nếu frontend Zira giả vờ là autonomous, đó sẽ là workaround giòn.

## 4. UX Đề Xuất Cho Màn Hình Khách Hàng

### 4.1 Welcome Screen

Mục tiêu: khách hiểu máy trong dưới 3 giây.

Cấu trúc đề xuất:

- Góc trái: logo/store identity.
- Góc phải: language switch `PL / EN / VI`.
- Trung tâm: hai nút rất lớn `Sklep / Grocery` và `Kuchnia / Kitchen`.
- Cạnh bên: icon scan lớn và câu ngắn "scan product".
- Secondary: `Wezwij obsługę / Call staff`.

Scan barcode phải tự bắt đầu phiên mua hàng. Khách không cần bấm Start nếu họ đã scan sản phẩm.

Không nên có promo media trong V1. Khách đang ở checkout, không phải đang đọc quảng cáo.

### 4.2 Shopping + Menu Screen

Đây là màn hình quan trọng nhất.

Cấu trúc đề xuất:

- Header: logo, language, call staff, abandon cart.
- Cột trái/main: scan prompt ở trên, menu/category ở dưới.
- Cột phải: cart, item count, total sticky, nút pay.
- Pay disabled nếu cart rỗng.

Menu:

- Tab cấp 1: `Popular`, `Grocery`, `Kitchen`, có thể thêm `Drinks`, `Snacks`, `Cafe`.
- Category chips nằm ngay dưới tab, không làm menu nhiều tầng.
- Product tiles có ảnh, tên theo ngôn ngữ, giá, trạng thái sold-out/no-price.
- Không hiển thị 48 sản phẩm ngẫu nhiên như UI chính. Con số này ổn cho smoke test, nhưng UX thật cần `Popular`, `Recently sold`, hoặc sort theo category/order.

Product tile:

- Kích thước ổn định, không nhảy layout khi ảnh lỗi.
- Tên sản phẩm wrap tối đa 2 dòng.
- Giá dùng tabular numbers.
- Product hết hàng/no price phải disabled rõ.
- Touch target tối thiểu 56 px; tile chính nên cao 140-180 px.

Scanner:

- Barcode scan hoạt động kể cả khi không thấy input.
- Feedback thành công dưới 150 ms: flash, beep, highlight cart row, total animation.
- Giữ duplicate-scan guard.
- Unknown barcode không được làm mất cart. Recovery: scan lại, search, chọn từ menu, hoặc gọi staff.

Search/manual fallback:

- Search là modal, không phải route mới.
- Tìm theo EAN, SKU, tên sản phẩm.
- Input và result row phải lớn.
- Không bắt khách gõ tên dài nếu category/menu giải quyết được.

### 4.3 Cart

Cart không nên giống bảng POS nhỏ. Nó là vùng giúp khách tin rằng máy tính tiền đúng.

Bắt buộc:

- Luôn visible trong shopping.
- Có item count và total.
- Quantity dùng nút minus/plus lớn.
- Ở quantity 1, nếu minus sẽ xóa item thì icon phải chuyển thành trash.
- Tên item wrap được; giá căn phải; số dùng tabular.
- Ở POS2 compact height, ít nhất 3 dòng cart và nút pay phải nhìn thấy hoặc có scroll an toàn.

### 4.4 Payment

Thanh toán phải ngắn và đáng tin.

V1 hiện đại cho unattended kiosk:

- Phương thức chính: `Card` và `BLIK` qua terminal.
- Cash chỉ dùng nếu kiosk đang là assisted mode, không phải unattended production.
- Tổng tiền là phần lớn nhất trong dialog.
- Terminal vật lý xử lý card/BLIK. Zira chỉ hiển thị status và instruction, không nhập credential thanh toán trên màn hình.
- Customer chỉ cancel trước khi terminal/payment processing bắt đầu.
- Nếu có NIP/faktura, phải nhập và confirm trước fiscal print.

Rủi ro hiện tại: `PaymentScreen.tsx` có Cash và manual BLIK phone-transfer với staff confirm. Cách này có thể là workaround cho shop có nhân viên, nhưng không giống self-checkout hiện đại. Nên tách mode:

- `Assisted demo`: cho phép cash/manual BLIK và label rõ.
- `Production unattended`: chỉ card/BLIK terminal, không có nút staff "money received" trong customer path.

### 4.5 Receipt / Finalizing

Receipt screen nên là progress, không chỉ là success.

Progress đề xuất:

- Payment approved.
- Order saved.
- Fiscal receipt printed.
- Receipt ready / collect receipt.

Không chuyển sang thank-you trước khi production-critical work xong. Nếu fiscal print fail sau payment, lock flow và gọi staff.

### 4.6 Thank You / Reset

Giữ ngắn:

- Icon success lớn.
- "Thank you" và nhắc lấy receipt.
- Countdown reset.
- Không upsell trong V1.

## 5. Visual UI Direction

Dùng token hiện có trong `src/renderer/index.css`:

- Canvas: `--sc-canvas`
- Surface: `--sc-surface`
- Text: `--sc-ink`
- Brand action: `--sc-primary`
- Pay/success action: `--sc-success`
- Help/info: `--sc-info`
- Error/closed: `--sc-danger`

Phong cách:

- Operational, không phải landing page.
- Light background, panel rõ, contrast cao.
- Typography lớn cho command và total.
- Icon dùng `lucide-react`; không dùng emoji làm icon chính.
- Không gradient hero, không blob decoration, không card lồng card.
- Góc bo có thể giữ, nhưng đừng biến toàn bộ UI thành marketing cards.

Typography target:

- Welcome headline: 48-72 px trên kiosk lớn.
- Scan command: 40-56 px.
- Cart item: 18-22 px.
- Total: 48-72 px.
- Button: 20-28 px.

Motion:

- Scan success: 150-320 ms.
- Button press: dưới 120 ms.
- Không animation trang trí trong payment.
- Giữ hỗ trợ `prefers-reduced-motion`.

## 6. Accessibility Và Touch

WCAG 2.2 yêu cầu target pointer tối thiểu 24 x 24 CSS px ở AA; mức enhanced là 44 x 44. Với kiosk công cộng, nên dùng chuẩn thực tế cao hơn:

- Customer primary buttons: 64-80 px cao.
- Secondary customer buttons: tối thiểu 56 px.
- Icon-only buttons: touch box 48-56 px.
- Khoảng cách giữa controls: 8-16 px.

Checklist:

- Mọi status/error phải có text, không chỉ màu.
- Error quan trọng dùng `role="alert"` hoặc status semantics.
- Help button nằm cùng vị trí giữa các screen.
- Language switch luôn reachable.
- Financial submission có review/confirm/correct.
- Không action quan trọng nào phụ thuộc hover.
- Text phải fit tiếng Ba Lan và tiếng Việt, không chỉ tiếng Anh.

## 7. Quyết Định Sản Phẩm Cần Chốt Trước Khi Refactor

1. Kiosk là "scan-first with menu fallback" hay "menu-first cho Kitchen, scan-first cho Grocery"? Đề xuất: hybrid theo department.
2. Cash có được phép trên self-checkout không? Đề xuất: chỉ assisted mode, không unattended production.
3. Manual BLIK phone transfer có phải hướng dài hạn không? Đề xuất: không; production dùng terminal-driven BLIK.
4. NIP/faktura có customer-facing không? Đề xuất: chỉ nếu fiscal/order contract hỗ trợ an toàn trước khi in.
5. Grocery/Kitchen category phân loại bằng gì? Regex trong `ScanScreen.tsx` chỉ nên là tạm thời. Dài hạn nên có metadata rõ từ catalog/backend.
6. Production readiness gate nào là thật? `SELF_CHECKOUT_PRODUCTION_BLOCKERS` hiện đang rỗng. Nếu payment/fiscal/order chưa thật sự production-ready, kiosk phải fail-closed.

## 8. Plan Refactor Frontend

Phase 1: làm behavior hiện tại coherent.

- Sửa comment/docs từ scanner-only thành scan + menu.
- Đổi copy `Grocery` nếu kiosk Ba Lan nên dùng `Sklep`.
- Giữ screen components hiện có: `WelcomeScreen`, `ScanScreen`, `PaymentScreen`, `ReceiptScreen`, `ThankYouScreen`.
- Không thêm design system mới.

Phase 2: làm shopping/menu chắc hơn.

- Tách menu area thành `KioskMenuPanel`.
- Tách `ProductTile`, `CategoryChip`, `CartPanel`, `ScanPrompt`.
- Giữ scanner capture behavior riêng và có test.
- Thêm empty/category/loading/sold-out states tử tế.

Phase 3: làm payment rõ production.

- Tách assisted/manual payment khỏi unattended production payment.
- Production payment đi qua terminal.
- Receipt/fiscal failure lock và gọi staff.

Phase 4: QA visual.

- Kiểm tra kiosk rộng và POS2 compact height.
- Kiểm tra không overflow.
- Kiểm tra ít nhất 3 cart rows visible ở compact height.
- Kiểm tra payment modal không clip controls.
- Kiểm tra PL/EN/VI text fit.

## 9. Acceptance Criteria

Customer:

- Khách có thể bắt đầu bằng scan hoặc tap Grocery/Kitchen.
- Khách add barcode product bằng 1 lần scan.
- Khách add kitchen/menu product không cần barcode.
- Total luôn visible trong shopping.
- Pay disabled khi cart rỗng.
- Unknown product giữ cart intact và có recovery.
- Help request lock kiosk cho đến khi staff xử lý.
- Thank-you auto-reset.

Layout:

- Không overflow ở `1280x800`.
- Compact height giữ cart rows, total, pay, receipt progress và payment controls visible hoặc scroll được.
- Customer controls tối thiểu 56 px trừ text link phụ; tốt nhất tránh text link phụ.

Technical:

- Scanner event route tới một active sales surface duy nhất.
- Self-checkout preload expose đủ API kiosk dùng.
- Money vẫn dùng integer grosze và chỉ format ở UI edge.
- Localized display names chỉ dùng để hiển thị; receipt/fiscal payload dùng canonical name.

Verification sau implementation:

- `node tests/e2e/self-checkout-prd-smoke.mjs`
- `npm run build`
- Manual visual check trên POS2 compact display.

## 10. Anti-Patterns Cần Tránh

- Mở đầu bằng marketing hero.
- Product browsing che mất scanner.
- Cart như bảng POS desktop nhỏ.
- Menu category quá sâu.
- Payment nhìn như thật nhưng production lại cần staff confirm thủ công.
- Bắt khách cài app để mua.
- Dùng ngôn ngữ AI/vision khi không có hardware hỗ trợ.
- Cash flow trên unattended kiosk.
- Silent failure khi payment/receipt lỗi.
- Normal operation mà vẫn cần nhân viên giải thích.

## Sources

- NCR Voyix self-checkout overview: https://www.ncr.com/retail/self-checkout
- NCR Voyix 2025 Commerce Experience Report summary: https://www.ncrvoyix.com/en-gb/newsroom/77-of-shoppers-choose-self-checkout-for-faster-service-according-to-new-consumer-survey-from-ncr-voyix
- NCR Voyix 2025 report article: https://www.ncr.com/resource/what-retailers-and-restaurants-can-learn-from-the-2025-commerce-experience-report
- Diebold Nixdorf DN Series EASY ONE: https://www.dieboldnixdorf.com/en-us/retail/portfolio/systems/easy/easy-one/
- Toast self-ordering kiosk setup: https://support.toasttab.com/en/article/Setting-Up-Your-Kiosk
- Oracle Simphony self-service kiosks: https://www.oracle.com/food-beverage/restaurant-pos-systems/pos-hardware/self-service-kiosks/
- Mashgin touchless checkout: https://www.mashgin.com/solution/mashgin-kiosk
- Instacart Caper Cart: https://www.instacart.com/connected-stores/caper-cart
- Amazon Just Walk Out how it works: https://www.justwalkout.com/how-it-works
- Amazon update on Just Walk Out and Dash Cart: https://www.aboutamazon.com/news/retail/amazon-just-walk-out-dash-cart-grocery-shopping-checkout-stores
- Żabka Nano: https://nano.zabka.pl/en/
- Forrester 2025 self-checkout data snapshot: https://www.forrester.com/report/most-us-consumers-want-self-checkout-in-more-store-formats/RES186405
- W3C WCAG 2.2: https://www.w3.org/TR/wcag/
- NielsenIQ kiosk usability tips: https://nielseniq.com/global/en/insights/commentary/2013/six-tips-to-improve-kiosk-usability-and-adoption/
