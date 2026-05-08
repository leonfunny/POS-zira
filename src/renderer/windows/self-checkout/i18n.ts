// Self-checkout terminal translations. Three languages: Polish (default
// — Polish shop), English (international tourists), Vietnamese (large
// Vietnamese-expat customer base at chesaigon).
export type ScLanguage = 'pl' | 'en' | 'vi';

interface ScStrings {
  // Welcome
  welcomeTitle: string;
  welcomeSubtitle: string;
  startButton: string;
  paymentNotice: string;
  // Generic
  back: string;
  cancel: string;
  pay: string;
  total: string;
  // Cart / scan
  scanPrompt: string;
  scanHint: string;
  manualEntry: string;
  emptyCart: string;
  remove: string;
  // Operator help
  callStaff: string;
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
  // Payment
  paymentTitle: string;
  blik: string;
  card: string;
  paymentSuccess: string;
  // Thank-you
  thankYouTitle: string;
  thankYouSub: string;
}

const PL: ScStrings = {
  welcomeTitle: 'Witamy w sklepie',
  welcomeSubtitle: 'Self-checkout — skanuj i zapłać samodzielnie',
  startButton: 'Rozpocznij zakupy',
  paymentNotice: 'Płatność tylko kartą lub BLIK',
  back: 'Wstecz',
  cancel: 'Anuluj',
  pay: 'Zapłać',
  total: 'Razem',
  scanPrompt: 'Zeskanuj produkt',
  scanHint: 'lub wprowadź kod ręcznie',
  manualEntry: 'Wprowadź kod',
  emptyCart: 'Koszyk pusty — zacznij skanować',
  remove: 'Usuń',
  callStaff: 'Wezwij obsługę',
  abandon: 'Porzuć',
  abandonConfirmTitle: 'Porzucić zakupy?',
  abandonConfirmBody: 'Cały koszyk zostanie usunięty.',
  abandonConfirm: 'Tak, porzuć',
  bagQuestion: 'Czy potrzebujesz torby?',
  bagYes: 'Tak (+0,20 zł)',
  bagNo: 'Nie, dziękuję',
  addNipButton: 'Dodaj NIP do faktury',
  nipTitle: 'Wprowadź NIP (10 cyfr)',
  nipPlaceholder: '0000000000',
  paymentTitle: 'Wybierz formę płatności',
  blik: 'BLIK',
  card: 'Karta płatnicza',
  paymentSuccess: 'Płatność potwierdzona',
  thankYouTitle: 'Dziękujemy!',
  thankYouSub: 'Paragon jest drukowany — odbierz go z drukarki',
};

const EN: ScStrings = {
  welcomeTitle: 'Welcome',
  welcomeSubtitle: 'Self-checkout — scan and pay yourself',
  startButton: 'Start shopping',
  paymentNotice: 'Card or BLIK payment only',
  back: 'Back',
  cancel: 'Cancel',
  pay: 'Pay',
  total: 'Total',
  scanPrompt: 'Scan a product',
  scanHint: 'or type the barcode manually',
  manualEntry: 'Enter code',
  emptyCart: 'Cart is empty — start scanning',
  remove: 'Remove',
  callStaff: 'Call staff',
  abandon: 'Abandon',
  abandonConfirmTitle: 'Abandon shopping?',
  abandonConfirmBody: 'The entire cart will be cleared.',
  abandonConfirm: 'Yes, abandon',
  bagQuestion: 'Do you need a bag?',
  bagYes: 'Yes (+0.20 zł)',
  bagNo: 'No, thanks',
  addNipButton: 'Add NIP for VAT invoice',
  nipTitle: 'Enter NIP (10 digits)',
  nipPlaceholder: '0000000000',
  paymentTitle: 'Choose payment method',
  blik: 'BLIK',
  card: 'Card',
  paymentSuccess: 'Payment confirmed',
  thankYouTitle: 'Thank you!',
  thankYouSub: 'Receipt is printing — please collect it',
};

const VI: ScStrings = {
  welcomeTitle: 'Chào mừng',
  welcomeSubtitle: 'Tự thanh toán — quét và trả tiền',
  startButton: 'Bắt đầu mua sắm',
  paymentNotice: 'Chỉ thanh toán bằng thẻ hoặc BLIK',
  back: 'Quay lại',
  cancel: 'Huỷ',
  pay: 'Thanh toán',
  total: 'Tổng',
  scanPrompt: 'Quét sản phẩm',
  scanHint: 'hoặc nhập mã thủ công',
  manualEntry: 'Nhập mã',
  emptyCart: 'Giỏ hàng trống — bắt đầu quét',
  remove: 'Xoá',
  callStaff: 'Gọi nhân viên',
  abandon: 'Huỷ giao dịch',
  abandonConfirmTitle: 'Huỷ giao dịch?',
  abandonConfirmBody: 'Toàn bộ giỏ hàng sẽ bị xoá.',
  abandonConfirm: 'Có, huỷ',
  bagQuestion: 'Bạn có cần túi không?',
  bagYes: 'Có (+0,20 zł)',
  bagNo: 'Không, cảm ơn',
  addNipButton: 'Thêm NIP cho hoá đơn VAT',
  nipTitle: 'Nhập NIP (10 chữ số)',
  nipPlaceholder: '0000000000',
  paymentTitle: 'Chọn phương thức thanh toán',
  blik: 'BLIK',
  card: 'Thẻ',
  paymentSuccess: 'Thanh toán thành công',
  thankYouTitle: 'Cảm ơn quý khách!',
  thankYouSub: 'Đang in hoá đơn — vui lòng nhận từ máy in',
};

const TABLE: Record<ScLanguage, ScStrings> = { pl: PL, en: EN, vi: VI };

export function getScStrings(lang: ScLanguage): ScStrings {
  return TABLE[lang] ?? TABLE.pl;
}

export const SC_LANGUAGES: Array<{ code: ScLanguage; label: string; flag: string }> = [
  { code: 'pl', label: 'Polski', flag: '🇵🇱' },
  { code: 'en', label: 'English', flag: '🇬🇧' },
  { code: 'vi', label: 'Tiếng Việt', flag: '🇻🇳' },
];
