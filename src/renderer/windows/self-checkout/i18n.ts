// Self-checkout terminal translations. Three languages: Polish (default
// Polish shop), English, and Vietnamese.
export type ScLanguage = 'pl' | 'en' | 'vi';

interface ScStrings {
  // Welcome / unavailable
  welcomeTitle: string;
  welcomeSubtitle: string;
  startButton: string;
  paymentNotice: string;
  closedTitle: string;
  closedSubtitle: string;
  // Generic
  back: string;
  cancel: string;
  pay: string;
  total: string;
  demoMode: string;
  productionMode: string;
  // Cart / scan
  scanPrompt: string;
  scanHint: string;
  manualEntry: string;
  scanQuantity: string;
  scanQuantityHint: string;
  noCategories: string;
  productNotFound: string;
  productOutOfStock: string;
  productInsufficientStock: string;
  productNoPrice: string;
  scanFailed: string;
  emptyCart: string;
  remove: string;
  // Operator help
  callStaff: string;
  staffCalledTitle: string;
  staffComingTitle: string;
  staffLockedBody: string;
  staffComingBody: string;
  helpReasonOther: string;
  abandon: string;
  abandonConfirmTitle: string;
  abandonConfirmBody: string;
  abandonConfirm: string;
  // Bag fee
  bagQuestion: string;
  bagYes: string;
  bagNo: string;
  // NIP
  addNipButton: string;
  nipTitle: string;
  nipPlaceholder: string;
  noNip: string;
  nipInvalid: string;
  // Summary / receipt
  summaryTitle: string;
  receiptTitle: string;
  receiptDemoBody: string;
  receiptProductionBlocked: string;
  // Payment
  paymentTitle: string;
  blik: string;
  card: string;
  paymentSuccess: string;
  popularCategories: string;
  productsInCategory: string;
  addProduct: string;
  close: string;
  items: string;
  scanAgain: string;
  // Thank-you
  thankYouTitle: string;
  thankYouSub: string;
}

const PL: ScStrings = {
  welcomeTitle: 'KASA OTWARTA',
  welcomeSubtitle: 'Zeskanuj produkt lub rozpocznij zakupy',
  startButton: 'Rozpocznij zakupy',
  paymentNotice: 'Płatność tylko kartą lub BLIK',
  closedTitle: 'Ta kasa jest zamknięta',
  closedSubtitle: 'Poproś obsługę lub skorzystaj z innej kasy.',
  back: 'Wstecz',
  cancel: 'Anuluj',
  pay: 'Zapłać',
  total: 'Razem',
  demoMode: 'Tryb demo',
  productionMode: 'Tryb produkcyjny',
  scanPrompt: 'Zeskanuj produkt',
  scanHint: 'Skaner doda produkt do koszyka automatycznie',
  manualEntry: 'Wprowadź kod',
  scanQuantity: 'Ilość',
  scanQuantityHint: 'Wybierz ilość przed skanowaniem',
  noCategories: 'Kategorie nie są jeszcze dostępne. Skanuj produkty kodem kreskowym.',
  productNotFound: 'Nie znaleziono produktu: {code}. Zeskanuj ponownie albo wezwij obsługę.',
  productOutOfStock: '{name} - brak na stanie. Wezwij obsługę.',
  productInsufficientStock: '{name} - dostępna ilość: {stock}. Zmień ilość albo wezwij obsługę.',
  productNoPrice: '{name} - brak ceny. Wezwij obsługę.',
  scanFailed: 'Skanowanie nie powiodło się. Spróbuj ponownie albo wezwij obsługę.',
  emptyCart: 'Koszyk pusty - zacznij skanować',
  remove: 'Usuń',
  callStaff: 'Wezwij obsługę',
  staffCalledTitle: 'Wezwano obsługę',
  staffComingTitle: 'Obsługa idzie',
  staffLockedBody: 'Kasa jest zablokowana. Poczekaj na pracownika.',
  staffComingBody: 'Pracownik jest w drodze do kasy.',
  helpReasonOther: 'Pomoc pracownika',
  abandon: 'Porzuć',
  abandonConfirmTitle: 'Porzucić zakupy?',
  abandonConfirmBody: 'Cały koszyk zostanie usunięty.',
  abandonConfirm: 'Tak, porzuć',
  bagQuestion: 'Czy potrzebujesz torby?',
  bagYes: 'Tak (+0,20 zł)',
  bagNo: 'Nie, dziękuję',
  addNipButton: 'Dodaj NIP',
  nipTitle: 'NIP do faktury',
  nipPlaceholder: '0000000000',
  noNip: 'Bez NIP',
  nipInvalid: 'Nieprawidłowy NIP',
  summaryTitle: 'Podsumowanie zakupów',
  receiptTitle: 'Finalizacja sprzedaży',
  receiptDemoBody: 'Demo: płatność, zamówienie i wydruk fiskalny są pominięte.',
  receiptProductionBlocked: 'Sprzedaż produkcyjna wymaga realnej płatności, zamówienia i drukarki fiskalnej.',
  paymentTitle: 'Wybierz formę płatności',
  blik: 'BLIK',
  card: 'Karta płatnicza',
  paymentSuccess: 'Płatność potwierdzona',
  popularCategories: 'Kategorie',
  productsInCategory: 'Produkty w kategorii',
  addProduct: 'Dodaj',
  close: 'Zamknij',
  items: 'Produkty',
  scanAgain: 'Skanuj dalej',
  thankYouTitle: 'Dziękujemy!',
  thankYouSub: 'Odbierz paragon z drukarki',
};

const EN: ScStrings = {
  welcomeTitle: 'CHECKOUT OPEN',
  welcomeSubtitle: 'Scan a product or start shopping',
  startButton: 'Start shopping',
  paymentNotice: 'Card or BLIK payment only',
  closedTitle: 'This checkout is closed',
  closedSubtitle: 'Please ask staff or use another checkout.',
  back: 'Back',
  cancel: 'Cancel',
  pay: 'Pay',
  total: 'Total',
  demoMode: 'Demo mode',
  productionMode: 'Production mode',
  scanPrompt: 'Scan a product',
  scanHint: 'The scanner adds the product automatically',
  manualEntry: 'Enter code',
  scanQuantity: 'Quantity',
  scanQuantityHint: 'Choose quantity before scanning',
  noCategories: 'Categories are not available yet. Scan products by barcode.',
  productNotFound: 'Product not found: {code}. Scan again or call staff.',
  productOutOfStock: '{name} is out of stock. Call staff.',
  productInsufficientStock: '{name} has only {stock} available. Change quantity or call staff.',
  productNoPrice: '{name} has no price. Call staff.',
  scanFailed: 'Scan failed. Try again or call staff.',
  emptyCart: 'Cart is empty - start scanning',
  remove: 'Remove',
  callStaff: 'Call staff',
  staffCalledTitle: 'Staff called',
  staffComingTitle: 'Staff is coming',
  staffLockedBody: 'This checkout is locked. Please wait for staff.',
  staffComingBody: 'A staff member is on the way to this checkout.',
  helpReasonOther: 'Staff assistance',
  abandon: 'Abandon',
  abandonConfirmTitle: 'Abandon shopping?',
  abandonConfirmBody: 'The entire cart will be cleared.',
  abandonConfirm: 'Yes, abandon',
  bagQuestion: 'Do you need a bag?',
  bagYes: 'Yes (+0.20 zł)',
  bagNo: 'No, thanks',
  addNipButton: 'Add NIP',
  nipTitle: 'NIP for invoice',
  nipPlaceholder: '0000000000',
  noNip: 'No NIP',
  nipInvalid: 'Invalid NIP',
  summaryTitle: 'Shopping summary',
  receiptTitle: 'Finalizing sale',
  receiptDemoBody: 'Demo: payment, order creation, and fiscal print are skipped.',
  receiptProductionBlocked: 'Production sale requires real payment, order creation, and fiscal printer integration.',
  paymentTitle: 'Choose payment method',
  blik: 'BLIK',
  card: 'Card',
  paymentSuccess: 'Payment confirmed',
  popularCategories: 'Categories',
  productsInCategory: 'Products in category',
  addProduct: 'Add',
  close: 'Close',
  items: 'Items',
  scanAgain: 'Keep scanning',
  thankYouTitle: 'Thank you!',
  thankYouSub: 'Please collect your receipt',
};

const VI: ScStrings = {
  welcomeTitle: 'QUẦY ĐANG MỞ',
  welcomeSubtitle: 'Quét sản phẩm hoặc bắt đầu mua sắm',
  startButton: 'Bắt đầu mua sắm',
  paymentNotice: 'Chỉ thanh toán bằng thẻ hoặc BLIK',
  closedTitle: 'Quầy này đang đóng',
  closedSubtitle: 'Vui lòng hỏi nhân viên hoặc dùng quầy khác.',
  back: 'Quay lại',
  cancel: 'Hủy',
  pay: 'Thanh toán',
  total: 'Tổng',
  demoMode: 'Chế độ demo',
  productionMode: 'Chế độ thật',
  scanPrompt: 'Quét sản phẩm',
  scanHint: 'Máy quét sẽ tự thêm sản phẩm vào giỏ',
  manualEntry: 'Nhập mã',
  scanQuantity: 'Số lượng',
  scanQuantityHint: 'Chọn số lượng trước khi quét',
  noCategories: 'Danh mục chưa sẵn sàng. Hãy quét sản phẩm bằng mã vạch.',
  productNotFound: 'Không tìm thấy sản phẩm: {code}. Quét lại hoặc gọi nhân viên.',
  productOutOfStock: '{name} đã hết hàng. Gọi nhân viên.',
  productInsufficientStock: '{name} chỉ còn {stock}. Đổi số lượng hoặc gọi nhân viên.',
  productNoPrice: '{name} chưa có giá. Gọi nhân viên.',
  scanFailed: 'Quét không thành công. Thử lại hoặc gọi nhân viên.',
  emptyCart: 'Giỏ hàng trống - hãy quét sản phẩm',
  remove: 'Xóa',
  callStaff: 'Gọi nhân viên',
  staffCalledTitle: 'Đã gọi nhân viên',
  staffComingTitle: 'Nhân viên đang tới',
  staffLockedBody: 'Quầy đang bị khóa. Vui lòng chờ nhân viên.',
  staffComingBody: 'Nhân viên đang tới quầy này.',
  helpReasonOther: 'Cần nhân viên hỗ trợ',
  abandon: 'Hủy giao dịch',
  abandonConfirmTitle: 'Hủy giao dịch?',
  abandonConfirmBody: 'Toàn bộ giỏ hàng sẽ bị xóa.',
  abandonConfirm: 'Có, hủy',
  bagQuestion: 'Bạn có cần túi không?',
  bagYes: 'Có (+0,20 zł)',
  bagNo: 'Không, cảm ơn',
  addNipButton: 'Thêm NIP',
  nipTitle: 'NIP cho hóa đơn',
  nipPlaceholder: '0000000000',
  noNip: 'Không có NIP',
  nipInvalid: 'NIP không hợp lệ',
  summaryTitle: 'Tóm tắt giỏ hàng',
  receiptTitle: 'Hoàn tất giao dịch',
  receiptDemoBody: 'Demo: thanh toán, tạo đơn và in fiskal được bỏ qua.',
  receiptProductionBlocked: 'Giao dịch thật cần tích hợp thanh toán, tạo đơn và máy in fiskal.',
  paymentTitle: 'Chọn phương thức thanh toán',
  blik: 'BLIK',
  card: 'Thẻ',
  paymentSuccess: 'Thanh toán thành công',
  popularCategories: 'Danh mục',
  productsInCategory: 'Sản phẩm trong danh mục',
  addProduct: 'Thêm',
  close: 'Đóng',
  items: 'Sản phẩm',
  scanAgain: 'Tiếp tục quét',
  thankYouTitle: 'Cảm ơn quý khách!',
  thankYouSub: 'Vui lòng nhận hóa đơn từ máy in',
};

const TABLE: Record<ScLanguage, ScStrings> = { pl: PL, en: EN, vi: VI };

export function getScStrings(lang: ScLanguage): ScStrings {
  return TABLE[lang] ?? TABLE.pl;
}

export const SC_LANGUAGES: Array<{ code: ScLanguage; label: string; flag: string }> = [
  { code: 'pl', label: 'Polski', flag: 'PL' },
  { code: 'en', label: 'English', flag: 'EN' },
  { code: 'vi', label: 'Tiếng Việt', flag: 'VI' },
];
