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
  staffRequestFailed: string;
  staffConnectionError: string;
  staffUnlocked: string;
  helpReasonOther: string;
  abandon: string;
  abandonConfirmTitle: string;
  abandonConfirmBody: string;
  abandonConfirm: string;
  // Bag fee
  bagQuestion: string;
  bagUnit: string;
  bagFeeProductionBlocked: string;
  // Receipt
  receiptTitle: string;
  receiptDemoBody: string;
  receiptProductionBlocked: string;
  receiptPrintFailed: string;
  receiptContinue: string;
  // Payment
  paymentTitle: string;
  cash: string;
  card: string;
  blik: string;
  payWithCard: string;
  payWithCash: string;
  payWithBlik: string;
  paymentTerminalHint: string;
  cardTerminalHint: string;
  cashHint: string;
  blikHint: string;
  blikInstructionTitle: string;
  blikInstructionBody: string;
  blikPhoneLabel: string;
  blikAmountLabel: string;
  terminalReadyTitle: string;
  terminalReadyBody: string;
  waitForTerminal: string;
  paymentProcessing: string;
  paymentSuccess: string;
  fakePaymentActive: string;
  // Invoice (NIP / Faktura)
  invoiceToggleLabel: string;
  invoiceToggleHint: string;
  invoiceNipPlaceholder: string;
  invoiceNipInvalid: string;
  // Idle warning
  idleWarningTitle: string;
  idleWarningBody: string;
  idleWarningStay: string;
  // Receipt extras
  receiptFiscalPrinting: string;
  receiptCountdown: string;
  receiptCollectArrow: string;
  // Help (extended)
  helpCancel: string;
  // Unavailable reasons (codes → text)
  reasonOffline: string;
  reasonPrinterOffline: string;
  reasonTerminalOffline: string;
  reasonShiftClosed: string;
  reasonUnknown: string;
  // Manual staff-collect flow
  staffConfirmTitle: string;
  staffConfirmBody: string;
  staffConfirmButton: string;
  replayVoice: string;
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
  paymentNotice: 'Płatność tylko przez terminal',
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
  staffRequestFailed: 'Nie udało się wezwać obsługi. Spróbuj ponownie.',
  staffConnectionError: 'Brak połączenia - obsługa nie została powiadomiona.',
  staffUnlocked: 'Odblokowano przez obsługę',
  helpReasonOther: 'Pomoc pracownika',
  abandon: 'Porzuć',
  abandonConfirmTitle: 'Porzucić zakupy?',
  abandonConfirmBody: 'Cały koszyk zostanie usunięty.',
  abandonConfirm: 'Tak, porzuć',
  bagQuestion: 'Torby foliowe',
  bagUnit: 'szt.',
  bagFeeProductionBlocked: 'Opłata za torbę wymaga produktu z backendu przed sprzedażą produkcyjną.',
  receiptTitle: 'Finalizacja sprzedaży',
  receiptDemoBody: 'Demo: płatność, zamówienie i wydruk fiskalny są pominięte.',
  receiptProductionBlocked: 'Sprzedaż produkcyjna wymaga realnej płatności, zamówienia i drukarki fiskalnej.',
  receiptPrintFailed: 'Płatność przyjęta, ale paragon nie został wydrukowany. Wezwij obsługę.',
  receiptContinue: 'Kontynuuj',
  paymentTitle: 'Wybierz formę płatności',
  cash: 'Gotówka',
  card: 'Karta płatnicza',
  blik: 'BLIK',
  payWithCard: 'Karta',
  payWithCash: 'Gotówka',
  payWithBlik: 'BLIK',
  paymentTerminalHint: 'Wybierz metodę. Obsługa zostanie poinformowana głosowo o kwocie i odbierze płatność.',
  cardTerminalHint: 'Zapłać kartą lub telefonem - obsługa obsłuży terminal.',
  cashHint: 'Zapłać gotówką - obsługa odbierze pieniądze i wyda resztę.',
  blikHint: 'Wyślij BLIK-iem na numer telefonu sklepu.',
  blikInstructionTitle: 'Wyślij BLIK-iem',
  blikInstructionBody: 'Otwórz aplikację bankową, wybierz BLIK → "Przelew na telefon" i wyślij kwotę na numer poniżej. Obsługa potwierdzi otrzymanie.',
  blikPhoneLabel: 'Numer telefonu',
  blikAmountLabel: 'Kwota',
  terminalReadyTitle: 'Wybierz metodę',
  terminalReadyBody: 'Po wyborze obsługa zostanie wezwana głosowo.',
  waitForTerminal: 'Obsługa finalizuje sprzedaż.',
  paymentProcessing: 'Zapisywanie zamówienia',
  paymentSuccess: 'Płatność potwierdzona',
  fakePaymentActive: 'Płatność testowa zatwierdzona',
  staffConfirmTitle: 'Czekam na obsługę',
  staffConfirmBody: 'Obsługa odbierze płatność i potwierdzi przyjęcie pieniędzy.',
  staffConfirmButton: 'Pieniądze przyjęte',
  replayVoice: 'Odtwórz komunikat',
  invoiceToggleLabel: 'Faktura na firmę?',
  invoiceToggleHint: 'Podaj NIP przed potwierdzeniem płatności.',
  invoiceNipPlaceholder: 'NIP (10 cyfr)',
  invoiceNipInvalid: 'NIP musi mieć 10 cyfr.',
  idleWarningTitle: 'Czy jesteś tam?',
  idleWarningBody: 'Sesja zostanie zakończona za 15 sekund.',
  idleWarningStay: 'Tak, jestem',
  receiptFiscalPrinting: 'Drukowanie paragonu fiskalnego...',
  receiptCountdown: 'Powrót do startu za {seconds}s',
  receiptCollectArrow: 'Odbierz paragon z drukarki',
  helpCancel: 'Anuluj wezwanie',
  reasonOffline: 'Kasa jest offline — brak połączenia z serwerem.',
  reasonPrinterOffline: 'Drukarka fiskalna jest niedostępna.',
  reasonTerminalOffline: 'Terminal płatniczy jest niedostępny.',
  reasonShiftClosed: 'Zmiana nie została otwarta przez obsługę.',
  reasonUnknown: 'Kasa chwilowo niedostępna.',
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
  paymentNotice: 'Payment by terminal only',
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
  staffRequestFailed: 'Could not call staff. Please try again.',
  staffConnectionError: 'Connection error - staff not notified.',
  staffUnlocked: 'Unlocked by staff',
  helpReasonOther: 'Staff assistance',
  abandon: 'Abandon',
  abandonConfirmTitle: 'Abandon shopping?',
  abandonConfirmBody: 'The entire cart will be cleared.',
  abandonConfirm: 'Yes, abandon',
  bagQuestion: 'Plastic bags',
  bagUnit: 'each',
  bagFeeProductionBlocked: 'Bag fee needs a real backend product before production checkout.',
  receiptTitle: 'Finalizing sale',
  receiptDemoBody: 'Demo: payment, order creation, and fiscal print are skipped.',
  receiptProductionBlocked: 'Production sale requires real payment, order creation, and fiscal printer integration.',
  receiptPrintFailed: 'Payment was accepted, but the receipt did not print. Please call staff.',
  receiptContinue: 'Continue',
  paymentTitle: 'Choose payment method',
  cash: 'Cash',
  card: 'Card',
  blik: 'BLIK',
  payWithCard: 'Card',
  payWithCash: 'Cash',
  payWithBlik: 'BLIK',
  paymentTerminalHint: 'Choose a method. Staff will be alerted by voice and will collect payment.',
  cardTerminalHint: 'Pay by card or phone - staff will operate the terminal.',
  cashHint: 'Pay in cash - staff will collect the money and give change.',
  blikHint: 'Send via BLIK to the shop phone number.',
  blikInstructionTitle: 'Send via BLIK',
  blikInstructionBody: 'Open your banking app, choose BLIK → "Transfer to phone" and send the amount to the number below. Staff will confirm receipt.',
  blikPhoneLabel: 'Phone number',
  blikAmountLabel: 'Amount',
  terminalReadyTitle: 'Choose a method',
  terminalReadyBody: 'Staff will be called by voice after you choose.',
  waitForTerminal: 'Staff is finalizing the sale.',
  paymentProcessing: 'Saving order',
  paymentSuccess: 'Payment confirmed',
  fakePaymentActive: 'Test payment approved',
  staffConfirmTitle: 'Waiting for staff',
  staffConfirmBody: 'Staff will collect payment and confirm money received.',
  staffConfirmButton: 'Money received',
  replayVoice: 'Replay announcement',
  invoiceToggleLabel: 'Invoice for company?',
  invoiceToggleHint: 'Enter NIP before confirming payment.',
  invoiceNipPlaceholder: 'NIP (10 digits)',
  invoiceNipInvalid: 'NIP must be 10 digits.',
  idleWarningTitle: 'Are you still there?',
  idleWarningBody: 'Session will end in 15 seconds.',
  idleWarningStay: 'Yes, I am',
  receiptFiscalPrinting: 'Printing fiscal receipt...',
  receiptCountdown: 'Returning in {seconds}s',
  receiptCollectArrow: 'Please take your receipt',
  helpCancel: 'Cancel request',
  reasonOffline: 'Checkout is offline — backend unreachable.',
  reasonPrinterOffline: 'Fiscal printer is unavailable.',
  reasonTerminalOffline: 'Payment terminal is unavailable.',
  reasonShiftClosed: 'Staff has not opened the shift.',
  reasonUnknown: 'Checkout temporarily unavailable.',
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
  paymentNotice: 'Chỉ thanh toán qua máy POS',
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
  staffRequestFailed: 'Không gọi được nhân viên. Vui lòng thử lại.',
  staffConnectionError: 'Mất kết nối - chưa báo được cho nhân viên.',
  staffUnlocked: 'Đã được nhân viên mở khóa',
  helpReasonOther: 'Cần nhân viên hỗ trợ',
  abandon: 'Hủy giao dịch',
  abandonConfirmTitle: 'Hủy giao dịch?',
  abandonConfirmBody: 'Toàn bộ giỏ hàng sẽ bị xóa.',
  abandonConfirm: 'Có, hủy',
  bagQuestion: 'Túi nhựa',
  bagUnit: 'cái',
  bagFeeProductionBlocked: 'Phí túi cần có sản phẩm thật trên backend trước khi bán production.',
  receiptTitle: 'Hoàn tất giao dịch',
  receiptDemoBody: 'Demo: thanh toán, tạo đơn và in fiskal được bỏ qua.',
  receiptProductionBlocked: 'Giao dịch thật cần tích hợp thanh toán, tạo đơn và máy in fiskal.',
  receiptPrintFailed: 'Đã nhận thanh toán, nhưng chưa in được hóa đơn. Vui lòng gọi nhân viên.',
  receiptContinue: 'Tiếp tục',
  paymentTitle: 'Chọn phương thức thanh toán',
  cash: 'Tiền mặt',
  card: 'Thẻ',
  blik: 'BLIK',
  payWithCard: 'Thẻ',
  payWithCash: 'Tiền mặt',
  payWithBlik: 'BLIK',
  paymentTerminalHint: 'Chọn phương thức. Nhân viên sẽ được báo bằng giọng nói và thu tiền.',
  cardTerminalHint: 'Trả bằng thẻ hoặc điện thoại - nhân viên sẽ vận hành máy POS.',
  cashHint: 'Trả tiền mặt - nhân viên sẽ thu tiền và trả lại.',
  blikHint: 'Chuyển BLIK đến số điện thoại của cửa hàng.',
  blikInstructionTitle: 'Chuyển bằng BLIK',
  blikInstructionBody: 'Mở app ngân hàng, chọn BLIK → "Chuyển đến số điện thoại" và gửi số tiền đến số dưới đây. Nhân viên sẽ xác nhận khi nhận được.',
  blikPhoneLabel: 'Số điện thoại',
  blikAmountLabel: 'Số tiền',
  terminalReadyTitle: 'Chọn phương thức',
  terminalReadyBody: 'Sau khi chọn, nhân viên sẽ được gọi bằng giọng nói.',
  waitForTerminal: 'Nhân viên đang hoàn tất giao dịch.',
  paymentProcessing: 'Đang lưu đơn',
  paymentSuccess: 'Thanh toán thành công',
  fakePaymentActive: 'Đã duyệt thanh toán test',
  staffConfirmTitle: 'Chờ nhân viên',
  staffConfirmBody: 'Nhân viên sẽ thu tiền và xác nhận đã nhận.',
  staffConfirmButton: 'Đã thu tiền',
  replayVoice: 'Phát lại',
  invoiceToggleLabel: 'Hóa đơn cho công ty?',
  invoiceToggleHint: 'Nhập mã NIP trước khi xác nhận thanh toán.',
  invoiceNipPlaceholder: 'NIP (10 chữ số)',
  invoiceNipInvalid: 'NIP phải có 10 chữ số.',
  idleWarningTitle: 'Bạn còn ở đây không?',
  idleWarningBody: 'Phiên sẽ kết thúc sau 15 giây.',
  idleWarningStay: 'Có, tôi vẫn ở đây',
  receiptFiscalPrinting: 'Đang in hóa đơn fiskal...',
  receiptCountdown: 'Quay về sau {seconds}s',
  receiptCollectArrow: 'Vui lòng nhận hóa đơn',
  helpCancel: 'Hủy yêu cầu',
  reasonOffline: 'Quầy đang offline — mất kết nối server.',
  reasonPrinterOffline: 'Máy in hóa đơn không khả dụng.',
  reasonTerminalOffline: 'Máy POS không khả dụng.',
  reasonShiftClosed: 'Nhân viên chưa mở ca.',
  reasonUnknown: 'Quầy tạm thời không khả dụng.',
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
