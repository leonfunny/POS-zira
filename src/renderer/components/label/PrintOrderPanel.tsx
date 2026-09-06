import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Package, Play, Plus, Save, Trash2, X } from 'lucide-react';
import DateField from './DateField';
import {
  CARE_TEXT_MAX_CHARS,
  CARE_TEXT_MAX_LINES,
  CARE_TEXT_PRESETS,
  FABRIC_MATERIALS,
  LabelPrintOrder,
  MAX_SIZE_LABEL_CHARS,
  OrderProblem,
  OrderWarning,
  orderWarnings,
  stickerGarmentType,
  SIZE_SUGGESTIONS,
  STYLE_SUGGESTIONS,
  PrintStep,
  buildPrintPlan,
  buildSamplePlan,
  compositionText,
  createEmptyOrder,
  addCareTextLine,
  careTextHasPreset,
  careTextLines,
  careTextLinesFit,
  careTextPresetFits,
  removeCareTextLine,
  orderTotals,
  percentFix,
  toggleCareTextPreset,
  foldGridIntoSizes,
  upperCaseOrder,
  validateOrder,
} from '../../../shared/label-print-order';
import { PasteProblem, parsePastedGrid } from '../../../shared/order-paste';
import FabricTagFields from './FabricTagFields';
import { orderToFabricTagTemplate } from '../../../shared/product-print-selection';
import {
  CategoryChoice,
  ProductDraftProblem,
  buildProductDraft,
  resolveOrderCategory,
  styleCategoryKey,
  buildMissingVariants,
  type ExistingVariant,
  groszeToText,
  priceForColour,
  textToGrosze,
  validateProductDraft,
} from '../../../shared/order-to-product';
import { latestRevision } from './product-revision';
import {
  CARE_SYMBOLS,
  CARE_SYMBOL_FAMILIES,
  CareSymbol,
  CareSymbolFamilyKey,
  FABRIC_TAG_EXCLUSIVE_CARE_SYMBOL_GROUPS,
} from '../../../shared/types';
import { careSymbolLabel, careSymbolSvg } from '../../../shared/care-symbols';
import { formatIsoDate } from '../../../shared/calendar';
import { PrintProgress, runPrintPlan } from './print-order-runner';
import {
  IMAGE_ACCEPT,
  SHEET_IMAGE_MAX_PX,
  readImageFile,
  uploadImageToVariants,
} from './image-file';
import {
  PrintProgressRecord,
  SavedPrintOrder,
  clearDraft,
  clearProgress,
  deleteSavedOrder,
  describeOrder,
  forgetSize,
  forgetStyle,
  listSavedOrders,
  loadLearnedSizes,
  loadLearnedStyles,
  loadStyleCategories,
  loadDraft,
  loadDraftId,
  loadProgress,
  saveDraft,
  rememberSize,
  rememberStyle,
  rememberStyleCategory,
  saveDraftId,
  saveOrder,
  saveProgress,
} from './print-order-storage';

interface Copy {
  title: string;
  subtitle: string;
  customer: string;
  styleName: string;
  styleCode: string;
  materials: string;
  materialsHint: string;
  care: string;
  careGroup: Record<CareSymbolFamilyKey, string>;
  careText: string;
  careTextHint: string;
  careLineAdd: string;
  careLineEmpty: string;
  careLineRemove: string;
  careLineFull: string;
  careLineNumber: (index: number) => string;
  sizes: string;
  addSize: string;
  forgetSize: string;
  forgetStyle: string;
  learnedStyles: string;
  color: string;
  rowTotal: string;
  stickerQty: string;
  colourPrice: string;
  fabricRow: string;
  addRow: string;
  total: string;
  whatToPrint: string;
  printFabric: string;
  printSticker: string;
  print: string;
  printing: string;
  samplePrint: string;
  samplePrintHint: string;
  save: string;
  saved: string;
  savedOrders: string;
  noSavedOrders: string;
  open: string;
  remove: string;
  newOrder: string;
  pasteOpen: string;
  pasteHint: string;
  pasteRead: (colors: number, sizes: number, copies: number) => string;
  pasteReplace: (colors: number, sizes: number) => string;
  pasteAccept: string;
  pasteCancel: string;
  pasteProblem: Record<PasteProblem, string>;
  duplicate: string;
  duplicateHint: string;
  stopAfter: string;
  stopHint: string;
  noResume: string;
  resumeSent: (steps: number, totalSteps: number, copies: number, totalCopies: number) => string;
  resumeCount: string;
  resumeContinue: (batch: number) => string;
  resumeRestart: string;
  resumeForget: string;
  percentSum: (sum: number) => string;
  percentFix: (name: string, percent: number) => string;
  progress: (done: number, total: number, copies: number, all: number) => string;
  finished: (copies: number) => string;
  stopped: (done: number, total: number) => string;
  problem: Record<OrderProblem, string>;
  warning: Record<OrderWarning, string>;
  orderDate: string;
  category: string;
  price: string;
  categoryNone: string;
  image: string;
  imagePick: string;
  imageChange: string;
  imageClear: string;
  imageBadType: string;
  imageUploaded: (done: number, total: number) => string;
  priceSynced: (rows: number) => string;
  priceSyncFailed: (reason: string) => string;
  nameSynced: string;
  nameSyncUnsupported: string;
  nameSyncFailed: (reason: string) => string;
  categoryPick: string;
  createCategory: (name: string) => string;
  creatingCategory: string;
  categoryCreateFailed: (reason: string) => string;
  fileProduct: string;
  filing: string;
  filed: (variants: number) => string;
  fileHint: string;
  fileFailed: (reason: string) => string;
  fileProblem: Record<ProductDraftProblem, string>;
  updateProduct: string;
  updating: string;
  updated: (added: number) => string;
  filedHint: (name: string) => string;
  styleUnknown: string;
  attachProduct: (name: string) => string;
  attaching: string;
  attachHint: (name: string) => string;
  attached: (name: string, added: number) => string;
  filedWithoutTag: (variants: number) => string;
}

const COPY: Record<string, Copy> = {
  vi: {
    title: 'Đơn in',
    subtitle: 'Nhập theo tờ A4 của khách rồi in một lần',
    customer: 'Khách',
    styleName: 'Tên hàng',
    styleCode: 'Mã hàng',
    materials: 'Chất liệu',
    materialsHint: 'Bấm chọn rồi gõ số phần trăm',
    care: 'Ký hiệu giặt',
    careGroup: { wash: 'Giặt', bleach: 'Tẩy', tumble: 'Sấy máy', natural: 'Phơi', iron: 'Là', dryclean: 'Giặt khô', wetclean: 'Giặt ướt' },
    careText: 'Các dòng ghi thêm',
    careTextHint: 'Gõ một dòng rồi Enter',
    careLineAdd: 'Thêm dòng',
    careLineEmpty: 'Chưa có dòng nào',
    careLineRemove: 'Bỏ dòng',
    careLineFull: 'Hết chỗ — bỏ bớt một dòng trước đã.',
    careLineNumber: (index) => `Dòng ${index}`,
    sizes: 'Size',
    addSize: 'Thêm size',
    forgetSize: 'Bỏ nhớ size',
    forgetStyle: 'Bỏ nhớ tên hàng',
    learnedStyles: 'Đã nhớ',
    color: 'Màu',
    rowTotal: 'Tổng',
    stickerQty: 'Tem túi',
    colourPrice: 'Giá riêng (zł)',
    fabricRow: 'Mác vải',
    addRow: 'Thêm màu',
    total: 'Tổng cộng',
    whatToPrint: 'In gì',
    printFabric: 'Mác vải',
    printSticker: 'Tem dán bao bì',
    print: 'In',
    printing: 'Đang in…',
    samplePrint: 'In thử 1 cái',
    samplePrintHint: 'In đúng một mác vải và một tem dán để soi trước khi chạy cả đơn.',
    save: 'Lưu đơn',
    saved: 'Đã lưu',
    savedOrders: 'Đơn đã lưu',
    noSavedOrders: 'Chưa có đơn nào được lưu',
    open: 'Mở',
    remove: 'Xoá',
    newOrder: 'Đơn mới',
    pasteOpen: 'Dán từ Excel',
    pasteHint: 'Bôi đen vùng bảng trong Excel, Ctrl+C, rồi dán vào ô dưới.',
    pasteRead: (colors, sizes, copies) =>
      `Đọc được ${colors} màu × ${sizes} size, tổng ${copies} tem.`,
    pasteReplace: (colors, sizes) => `Sẽ thay ${colors} màu × ${sizes} size đang có.`,
    pasteAccept: 'Nhận bảng này',
    pasteCancel: 'Bỏ',
    pasteProblem: {
      NOT_A_GRID: 'Chỗ dán không phải bảng — dòng đầu là size, mỗi dòng sau là một màu.',
      NO_SIZES: 'Dòng đầu không có cột size nào.',
      NO_ROWS: 'Không có dòng màu nào.',
    },
    duplicate: 'Nhân bản',
    duplicateHint:
      'Tạo một đơn mới với đúng nội dung này. Chưa ghi gì cho tới khi bấm Lưu đơn.',
    stopAfter: 'Dừng in',
    stopHint: 'Bấm Dừng thì lô đang gửi vẫn in nốt rồi mới ngừng.',
    noResume: 'Máy kẹt hay tắt app giữa chừng thì phải đếm tem thật trước khi in lại.',
    resumeSent: (steps, totalSteps, copies, totalCopies) =>
      `Lần trước đã gửi ${steps}/${totalSteps} lô (${copies}/${totalCopies} tem).`,
    resumeCount: 'Đếm tem thật rồi chọn:',
    resumeContinue: (batch) => `In tiếp từ lô ${batch}`,
    resumeRestart: 'In lại từ đầu',
    resumeForget: 'Bỏ tiến độ',
    percentSum: (sum) => `Tổng phần trăm đang là ${sum}%`,
    percentFix: (name, percent) => `Đặt ${name} = ${percent}%`,
    progress: (done, total, copies, all) => `Đã in ${done}/${total} lô · ${copies}/${all} tem`,
    finished: (copies) => `Đã in xong ${copies} tem`,
    stopped: (done, total) => `Đã dừng sau ${done}/${total} lô`,
    problem: {
      EMPTY_ORDER: 'Chưa có số lượng nào',
      NOTHING_SELECTED: 'Chưa chọn in loại nhãn nào',
      NO_CUSTOMER: 'Chưa có tên khách',
      NO_STYLE_CODE: 'Chưa có mã hàng — tem túi cần mã',
      NO_STICKER_QTY: 'Chưa nhập số tem túi cho một màu — mỗi màu một số, tính theo chồng đóng túi',
      DUPLICATE_SIZE: 'Có hai cột size trùng tên',
      EMPTY_SIZE: 'Có cột size chưa đặt tên',
        PERCENT_NOT_100: 'Tổng phần trăm chất liệu phải bằng 100%',
      ORDER_TOO_LARGE: 'Số lượng quá lớn — kiểm tra lại',
    },
    warning: {
      NO_COMPOSITION: 'Mác vải chưa có thành phần — sẽ in mác trống chỗ đó',
    },
    orderDate: 'Ngày đơn',
    category: 'Danh mục',
    price: 'Giá bán (zł)',
    image: 'Ảnh hàng',
    imagePick: 'Chọn ảnh',
    imageChange: 'Đổi ảnh',
    imageClear: 'Bỏ ảnh',
    imageBadType: 'Chỉ nhận ảnh JPG, PNG hoặc WEBP',
    imageUploaded: (done, total) => (done === total ? ' · đã gắn ảnh' : ` · ảnh gắn được ${done}/${total} dòng`),
    priceSynced: (rows) => ` · đổi giá ${rows} dòng cũ theo tờ`,
    priceSyncFailed: (reason) => `Đã thêm dòng nhưng chưa đổi được giá dòng cũ: ${reason}`,
    nameSynced: ' · đã đổi tên kiểu',
    nameSyncUnsupported: ' · tên kiểu chưa đổi: máy chủ chưa hỗ trợ',
    nameSyncFailed: (reason) => `Chưa đổi được tên kiểu: ${reason}`,
    categoryNone: 'Chưa có nhóm — chọn ở trên hoặc tạo nhóm mới, không thì hàng sẽ không hiện ở tab tem',
    categoryPick: '— Chọn nhóm —',
    createCategory: (name) => `Tạo nhóm “${name}”`,
    creatingCategory: 'Đang tạo nhóm…',
    categoryCreateFailed: (reason) => `Không tạo được nhóm: ${reason}`,
    fileProduct: 'Lưu thành sản phẩm',
    filing: 'Đang lưu…',
    filed: (variants) => `Đã lưu — ${variants} biến thể`,
    filedWithoutTag: (variants) =>
      `Đã lưu ${variants} biến thể, nhưng chưa lưu được nội dung tem vải — tab tem sẽ không in được vải`,
    fileHint: 'Mỗi ô có số lượng thành một biến thể màu × size',
    updateProduct: 'Cập nhật sản phẩm',
    updating: 'Đang cập nhật…',
    updated: (added) => (added > 0 ? `Đã cập nhật — thêm ${added} màu/size mới` : 'Đã cập nhật sản phẩm'),
    filedHint: (name) => `Đã là sản phẩm “${name}” — mở ở tab Tem mã sản phẩm`,
    attachProduct: (name) => `Gắn vào kiểu “${name}” đã có`,
    attaching: 'Đang gắn…',
    attachHint: (name) => `Mã hàng này đã là kiểu “${name}” — bấm để thêm màu/size còn thiếu vào kiểu đó, không tạo kiểu mới`,
    attached: (name, added) =>
      added > 0 ? `Đã gắn vào “${name}” — thêm ${added} màu/size mới` : `Đã gắn vào “${name}”`,
    styleUnknown: 'Chưa thấy kiểu này trong catalogue của máy — bấm Sync ở tab Tem rồi thử lại',
    fileFailed: (reason) => `Không lưu được: ${reason}`,
    fileProblem: {
      NO_NAME: 'Chưa có tên hàng',
      NO_CUSTOMER: 'Chưa có tên khách',
      NO_CATEGORY: 'Chưa chọn nhóm hàng',
      NO_CELLS: 'Chưa có màu nào — mỗi màu × size thành một biến thể',
      ALREADY_FILED: 'Tờ này đã lưu thành sản phẩm rồi',
      NO_PRICE: 'Chưa nhập giá bán — một giá cho cả kiểu',
      TOO_MANY_VARIANTS: 'Quá 100 biến thể — tách làm nhiều đơn',
    },
  },
  pl: {
    title: 'Zlecenie druku',
    subtitle: 'Przepisz kartę A4 klienta i wydrukuj za jednym razem',
    customer: 'Klient',
    styleName: 'Nazwa modelu',
    styleCode: 'Kod modelu',
    materials: 'Skład',
    materialsHint: 'Kliknij materiał i wpisz procent',
    care: 'Symbole prania',
    careGroup: { wash: 'Pranie', bleach: 'Wybielanie', tumble: 'Suszarka', natural: 'Suszenie', iron: 'Prasowanie', dryclean: 'Czyszczenie', wetclean: 'Pranie wodne' },
    careText: 'Dodatkowe wiersze',
    careTextHint: 'Wpisz wiersz i naciśnij Enter',
    careLineAdd: 'Dodaj wiersz',
    careLineEmpty: 'Brak dodatkowych wierszy',
    careLineRemove: 'Usuń wiersz',
    careLineFull: 'Brak miejsca — najpierw usuń wiersz.',
    careLineNumber: (index) => `Wiersz ${index}`,
    sizes: 'Rozmiary',
    addSize: 'Dodaj rozmiar',
    forgetSize: 'Zapomnij rozmiar',
    forgetStyle: 'Zapomnij nazwę',
    learnedStyles: 'Zapamiętane',
    color: 'Kolor',
    rowTotal: 'Razem',
    stickerQty: 'Naklejki',
    colourPrice: 'Cena koloru (zł)',
    fabricRow: 'Metki',
    addRow: 'Dodaj kolor',
    total: 'Razem',
    whatToPrint: 'Co drukować',
    printFabric: 'Metki',
    printSticker: 'Naklejki na opakowanie',
    print: 'Drukuj',
    printing: 'Drukowanie…',
    samplePrint: 'Wydruk próbny',
    samplePrintHint: 'Jedna metka i jedna naklejka do sprawdzenia przed całym zleceniem.',
    save: 'Zapisz',
    saved: 'Zapisano',
    savedOrders: 'Zapisane zlecenia',
    noSavedOrders: 'Brak zapisanych zleceń',
    open: 'Otwórz',
    remove: 'Usuń',
    newOrder: 'Nowe zlecenie',
    pasteOpen: 'Wklej z Excela',
    pasteHint: 'Zaznacz zakres w Excelu, Ctrl+C, wklej poniżej.',
    pasteRead: (colors, sizes, copies) =>
      `Odczytano ${colors} kolorów × ${sizes} rozmiarów, razem ${copies} szt.`,
    pasteReplace: (colors, sizes) => `Zastąpi ${colors} kolorów × ${sizes} rozmiarów.`,
    pasteAccept: 'Wstaw tabelę',
    pasteCancel: 'Anuluj',
    pasteProblem: {
      NOT_A_GRID: 'To nie jest tabela — pierwszy wiersz to rozmiary, dalej po jednym kolorze.',
      NO_SIZES: 'W pierwszym wierszu nie ma rozmiarów.',
      NO_ROWS: 'Nie ma wierszy z kolorami.',
    },
    duplicate: 'Duplikuj',
    duplicateHint:
      'Nowe zlecenie z tą samą treścią. Nic nie zapisuje, dopóki nie klikniesz Zapisz zlecenie.',
    stopAfter: 'Zatrzymaj druk',
    stopHint: 'Po naciśnięciu Zatrzymaj bieżąca partia dokończy się i dopiero potem druk stanie.',
    noResume: 'Po zacięciu lub zamknięciu aplikacji policz metki, zanim wydrukujesz ponownie.',
    resumeSent: (steps, totalSteps, copies, totalCopies) =>
      `Poprzednio wysłano ${steps}/${totalSteps} partii (${copies}/${totalCopies} szt.).`,
    resumeCount: 'Policz metki i wybierz:',
    resumeContinue: (batch) => `Wznów od partii ${batch}`,
    resumeRestart: 'Drukuj od nowa',
    resumeForget: 'Odrzuć postęp',
    percentSum: (sum) => `Suma procentów: ${sum}%`,
    percentFix: (name, percent) => `Ustaw ${name} = ${percent}%`,
    progress: (done, total, copies, all) => `${done}/${total} partii · ${copies}/${all} sztuk`,
    finished: (copies) => `Wydrukowano ${copies} szt.`,
    stopped: (done, total) => `Zatrzymano po ${done}/${total} partii`,
    problem: {
      EMPTY_ORDER: 'Brak ilości',
      NOTHING_SELECTED: 'Nie wybrano rodzaju etykiety',
      NO_CUSTOMER: 'Brak nazwy klienta',
      NO_STYLE_CODE: 'Brak kodu modelu — naklejka go wymaga',
      NO_STICKER_QTY: 'Brak liczby naklejek na worek dla koloru — po jednej na kolor, według paczek',
      DUPLICATE_SIZE: 'Dwie kolumny mają ten sam rozmiar',
      EMPTY_SIZE: 'Kolumna rozmiaru bez nazwy',
        PERCENT_NOT_100: 'Skład musi sumować się do 100%',
      ORDER_TOO_LARGE: 'Zbyt duża ilość — sprawdź',
    },
    warning: {
      NO_COMPOSITION: 'Metka bez składu — to miejsce zostanie puste',
    },
    orderDate: 'Data zlecenia',
    category: 'Kategoria',
    price: 'Cena brutto (zł)',
    image: 'Zdjęcie',
    imagePick: 'Wybierz zdjęcie',
    imageChange: 'Zmień zdjęcie',
    imageClear: 'Usuń zdjęcie',
    imageBadType: 'Tylko JPG, PNG lub WEBP',
    imageUploaded: (done, total) => (done === total ? ' · zdjęcie dodane' : ` · zdjęcie dodano do ${done}/${total} wierszy`),
    priceSynced: (rows) => ` · cena ${rows} starych wierszy zmieniona wg arkusza`,
    priceSyncFailed: (reason) => `Wiersze dodane, ale cena starych nie zmieniona: ${reason}`,
    nameSynced: ' · nazwa fasonu zmieniona',
    nameSyncUnsupported: ' · nazwa fasonu bez zmian: serwer tego nie obsługuje',
    nameSyncFailed: (reason) => `Nie udało się zmienić nazwy fasonu: ${reason}`,
    categoryNone: 'Brak kategorii — wybierz powyżej lub utwórz nową, inaczej model nie pojawi się w zakładce etykiet',
    categoryPick: '— Wybierz kategorię —',
    createCategory: (name) => `Utwórz kategorię „${name}”`,
    creatingCategory: 'Tworzenie kategorii…',
    categoryCreateFailed: (reason) => `Nie udało się utworzyć kategorii: ${reason}`,
    fileProduct: 'Zapisz jako produkt',
    filing: 'Zapisywanie…',
    filed: (variants) => `Zapisano — ${variants} wariantów`,
    filedWithoutTag: (variants) =>
      `Zapisano ${variants} wariantów, ale treść metki nie zapisała się — zakładka etykiet nie wydrukuje metki`,
    fileHint: 'Każda wypełniona komórka to jeden wariant koloru i rozmiaru',
    updateProduct: 'Aktualizuj produkt',
    updating: 'Aktualizowanie…',
    updated: (added) => (added > 0 ? `Zaktualizowano — dodano ${added} nowych kolorów/rozmiarów` : 'Produkt zaktualizowany'),
    filedHint: (name) => `To już produkt „${name}” — otwórz w zakładce etykiet`,
    attachProduct: (name) => `Dołącz do modelu „${name}”`,
    attaching: 'Dołączanie…',
    attachHint: (name) => `Ten kod to już model „${name}” — kliknij, aby dodać brakujące kolory/rozmiary do niego zamiast tworzyć nowy`,
    attached: (name, added) =>
      added > 0 ? `Dołączono do „${name}” — dodano ${added} nowych kolorów/rozmiarów` : `Dołączono do „${name}”`,
    styleUnknown: 'Tego modelu nie ma jeszcze w katalogu na tej maszynie — kliknij Sync w zakładce etykiet i spróbuj ponownie',
    fileFailed: (reason) => `Nie zapisano: ${reason}`,
    fileProblem: {
      NO_NAME: 'Brak nazwy modelu',
      NO_CUSTOMER: 'Brak nazwy klienta',
      NO_CATEGORY: 'Nie wybrano kategorii',
      NO_CELLS: 'Brak kolorów — każdy kolor × rozmiar to jeden wariant',
      ALREADY_FILED: 'To zlecenie jest już zapisane jako produkt',
      NO_PRICE: 'Brak ceny — jedna cena dla całego fasonu',
      TOO_MANY_VARIANTS: 'Ponad 100 wariantów — podziel zlecenie',
    },
  },
  en: {
    title: 'Print order',
    subtitle: "Type in the customer's A4 sheet, then print once",
    customer: 'Customer',
    styleName: 'Style name',
    styleCode: 'Style code',
    materials: 'Composition',
    materialsHint: 'Tap a material and type the percentage',
    care: 'Care symbols',
    careGroup: { wash: 'Washing', bleach: 'Bleaching', tumble: 'Tumble drying', natural: 'Natural drying', iron: 'Ironing', dryclean: 'Dry cleaning', wetclean: 'Wet cleaning' },
    careText: 'Extra lines',
    careTextHint: 'Type a line and press Enter',
    careLineAdd: 'Add line',
    careLineEmpty: 'No extra lines yet',
    careLineRemove: 'Remove line',
    careLineFull: 'No room left — remove a line first.',
    careLineNumber: (index) => `Line ${index}`,
    sizes: 'Sizes',
    addSize: 'Add size',
    forgetSize: 'Forget size',
    forgetStyle: 'Forget',
    learnedStyles: 'Remembered',
    color: 'Colour',
    rowTotal: 'Total',
    stickerQty: 'Bag stickers',
    colourPrice: 'Colour price (zł)',
    fabricRow: 'Fabric tags',
    addRow: 'Add colour',
    total: 'Grand total',
    whatToPrint: 'What to print',
    printFabric: 'Fabric tags',
    printSticker: 'Packaging stickers',
    print: 'Print',
    printing: 'Printing…',
    samplePrint: 'Print one',
    samplePrintHint: 'One tag and one sticker to look at before the whole order runs.',
    save: 'Save order',
    saved: 'Saved',
    savedOrders: 'Saved orders',
    noSavedOrders: 'No saved orders yet',
    open: 'Open',
    remove: 'Delete',
    newOrder: 'New order',
    pasteOpen: 'Paste from Excel',
    pasteHint: 'Select the block in Excel, Ctrl+C, then paste it below.',
    pasteRead: (colors, sizes, copies) =>
      `Read ${colors} colours × ${sizes} sizes, ${copies} labels in total.`,
    pasteReplace: (colors, sizes) => `Replaces the ${colors} colours × ${sizes} sizes on screen.`,
    pasteAccept: 'Use this table',
    pasteCancel: 'Cancel',
    pasteProblem: {
      NOT_A_GRID: 'That is not a table — first row the sizes, then one row per colour.',
      NO_SIZES: 'The first row carries no sizes.',
      NO_ROWS: 'There are no colour rows.',
    },
    duplicate: 'Duplicate',
    duplicateHint:
      'A new order with the same contents. Nothing is filed until you press Save order.',
    stopAfter: 'Stop printing',
    stopHint: 'Stop takes effect after the batch already sent finishes.',
    noResume: 'After a jam or an app restart, count the printed labels before reprinting.',
    resumeSent: (steps, totalSteps, copies, totalCopies) =>
      `Last time ${steps}/${totalSteps} batches went out (${copies}/${totalCopies} labels).`,
    resumeCount: 'Count the labels, then choose:',
    resumeContinue: (batch) => `Carry on from batch ${batch}`,
    resumeRestart: 'Print from the start',
    resumeForget: 'Forget the progress',
    percentSum: (sum) => `Percentages add up to ${sum}%`,
    percentFix: (name, percent) => `Set ${name} to ${percent}%`,
    progress: (done, total, copies, all) => `${done}/${total} batches · ${copies}/${all} labels`,
    finished: (copies) => `Printed ${copies} labels`,
    stopped: (done, total) => `Stopped after ${done}/${total} batches`,
    problem: {
      EMPTY_ORDER: 'No quantities entered',
      NOTHING_SELECTED: 'No label kind selected',
      NO_CUSTOMER: 'No customer name',
      NO_STYLE_CODE: 'No style code — the bag sticker needs one',
      NO_STICKER_QTY: 'A colour has no bag sticker count — one per colour, by stacks packed',
      DUPLICATE_SIZE: 'Two size columns share a name',
      EMPTY_SIZE: 'A size column has no name',
        PERCENT_NOT_100: 'The composition must add up to 100%',
      ORDER_TOO_LARGE: 'Quantity is implausibly large — check the sheet',
    },
    warning: {
      NO_COMPOSITION: 'The fabric tag has no composition — that line will print empty',
    },
    orderDate: 'Order date',
    category: 'Category',
    price: 'Gross price (zł)',
    image: 'Photo',
    imagePick: 'Pick a photo',
    imageChange: 'Change photo',
    imageClear: 'Remove photo',
    imageBadType: 'JPG, PNG or WEBP only',
    imageUploaded: (done, total) => (done === total ? ' · photo attached' : ` · photo attached to ${done}/${total} rows`),
    priceSynced: (rows) => ` · price of ${rows} existing rows set from the sheet`,
    priceSyncFailed: (reason) => `Rows added, but the existing rows kept their price: ${reason}`,
    nameSynced: ' · style renamed',
    nameSyncUnsupported: ' · style name unchanged: the server cannot rename a style',
    nameSyncFailed: (reason) => `Could not rename the style: ${reason}`,
    categoryNone: 'No category — pick one above or create it, or the style will not show in the label tab',
    categoryPick: '— Pick a category —',
    createCategory: (name) => `Create category “${name}”`,
    creatingCategory: 'Creating category…',
    categoryCreateFailed: (reason) => `Could not create the category: ${reason}`,
    fileProduct: 'Save as product',
    filing: 'Saving…',
    filed: (variants) => `Saved — ${variants} variants`,
    filedWithoutTag: (variants) =>
      `Saved ${variants} variants, but the care content did not save — the label tab cannot print a fabric tag`,
    fileHint: 'Every filled cell becomes one colour and size variant',
    updateProduct: 'Update product',
    updating: 'Updating…',
    updated: (added) => (added > 0 ? `Updated — ${added} new colours/sizes added` : 'Product updated'),
    filedHint: (name) => `Already product “${name}” — open it on the product label tab`,
    attachProduct: (name) => `Attach to existing “${name}”`,
    attaching: 'Attaching…',
    attachHint: (name) => `This code is already style “${name}” — press to add the missing colours and sizes to it instead of making a new style`,
    attached: (name, added) =>
      added > 0 ? `Attached to “${name}” — ${added} new colours/sizes` : `Attached to “${name}”`,
    styleUnknown: 'This style is not in the catalogue on this machine yet — press Sync on the product tab and try again',
    fileFailed: (reason) => `Not saved: ${reason}`,
    fileProblem: {
      NO_NAME: 'The style has no name',
      NO_CUSTOMER: 'No customer name',
      NO_CATEGORY: 'No category picked',
      NO_CELLS: 'No colour yet — every colour × size becomes one variant',
      ALREADY_FILED: 'This sheet is already saved as a product',
      NO_PRICE: 'No price yet — one price for the whole style',
      TOO_MANY_VARIANTS: 'More than 100 variants — split the order',
    },
  },
};

interface Props {
  language: string;
  active: boolean;
  onPrintingChange?: (printing: boolean) => void;
  /**
   * The salon's categories, already loaded by the parent for the label list.
   * Passed in rather than fetched again so both tabs read the same rows.
   */
  categories?: readonly CategoryChoice[];
  /** A category was created from the sheet; the parent reloads its list. */
  onCategoriesChanged?: () => void | Promise<unknown>;
  /**
   * A product was filed into `categoryId`. The parent makes sure the label tab
   * shows that category, so the style appears there without a trip through
   * settings.
   */
  onProductFiled?: (info: { categoryId: string }) => void;
  /**
   * The style a filed sheet belongs to, as the product tab holds it, so an
   * edited sheet can be pushed back onto it. Null while the catalogue on this
   * machine has not caught up with the server.
   */
  styleById?: (templateId: string) => FiledStyle | null;
  /**
   * The style on the product tab whose code is the one typed on a fresh sheet,
   * so the sheet joins it instead of asking the server for a twin it would
   * refuse. Null when no style carries that code.
   */
  styleByCode?: (styleCode: string) => (FiledStyle & { id: string }) | null;
  /**
   * The sheet opened for a style already in the catalogue, from the label
   * tab, rather than for an order. Seeded from the style; nothing about it is
   * stored, so it opens fresh — quantities blank — every time, and the order
   * date, the saved-sheet list and the new/duplicate controls stay away. The
   * caller keys the panel by the style, so another style is another panel.
   */
  catalogue?: {
    templateId: string;
    seed: LabelPrintOrder;
    /** The photo the catalogue holds, shown until the sheet picks another. */
    imageUrl: string | null;
  };
}

export interface FiledStyle {
  name: string;
  categoryId: string | null;
  variants: readonly ExistingVariant[];
}

let idCounter = 0;
function nextId(prefix: string): string {
  idCounter += 1;
  return `${prefix}-${Date.now().toString(36)}-${idCounter}`;
}

/**
 * Copy the sheet's care content onto the machine, keyed to the style.
 *
 * Reported rather than thrown: the server has already created the product by
 * the time this runs, and an exception here would leave the operator staring at
 * a failure for something that succeeded.
 */
async function saveFabricTagContent(
  templateId: string,
  order: LabelPrintOrder,
): Promise<boolean> {
  try {
    const bridge = (window as any).electronAPI?.pos?.fabricTagTemplates;
    if (!bridge?.save) return false;
    return !!(await bridge.save(orderToFabricTagTemplate(templateId, order)));
  } catch {
    return false;
  }
}

export default function PrintOrderPanel({
  language,
  active,
  onPrintingChange,
  categories = [],
  onCategoriesChanged,
  onProductFiled,
  styleById,
  styleByCode,
  catalogue,
}: Props) {
  const copy = COPY[language] || COPY.vi;

  // Loading a draft goes through the same gate as typing, so an order saved
  // before this rule opens in capitals like every other one.
  const [order, setStoredOrder] = useState<LabelPrintOrder>(() =>
    upperCaseOrder(catalogue ? catalogue.seed : loadDraft()),
  );
  // What the price box shows while it is being typed: "12," must not snap to
  // "12,00" under the cursor. It follows the order whenever the order changes
  // underneath it (a saved sheet opened, a new one started).
  const [priceText, setPriceText] = useState(() => groszeToText(order.priceGrossGrosze));
  useEffect(() => {
    setPriceText((text) =>
      textToGrosze(text) === (Number(order.priceGrossGrosze) || 0) ? text : groszeToText(order.priceGrossGrosze),
    );
  }, [order.priceGrossGrosze]);
  // One gate for every write, so no field — including one added later — can
  // slip through in lower case.
  const setOrder = useCallback(
    (next: LabelPrintOrder | ((current: LabelPrintOrder) => LabelPrintOrder)) =>
      setStoredOrder((current) =>
        upperCaseOrder(typeof next === 'function' ? next(current) : next),
      ),
    [],
  );
  // Empty until the first read comes back: the sheets live on the server now
  // and reach the panel through the app database, which is a round trip.
  const [savedOrders, setSavedOrders] = useState<SavedPrintOrder[]>([]);
  const refreshSavedOrders = useCallback(() => {
    void listSavedOrders().then(setSavedOrders);
  }, []);
  useEffect(refreshSavedOrders, [refreshSavedOrders]);
  // Which saved order is on screen. Restored from storage so that editing an
  // order the next morning updates it instead of filing a twin beside it.
  const [orderId, setOrderId] = useState<string>(() =>
    catalogue ? `style-${catalogue.templateId}` : loadDraftId() ?? nextId('order'),
  );
  const [progress, setProgress] = useState<PrintProgress | null>(null);
  const [result, setResult] = useState<{ type: string; message: string } | null>(null);
  const [savedNotice, setSavedNotice] = useState(false);
  const [filing, setFiling] = useState(false);
  const [fileNotice, setFileNotice] = useState<string | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  /**
   * One key per attempt, held across retries. Regenerating it on every press is
   * exactly how a shaky connection turns one order into two products.
   */
  const fileKeyRef = useRef<string | null>(null);
  /**
   * How far the last run of this order got, when it did not finish. Read once on
   * open and only ever changed by the operator pressing one of the three
   * buttons: the panel must never carry on by itself, because "sent to the
   * printer" is not "came out on the ribbon".
   */
  const [resume, setResume] = useState<PrintProgressRecord | null>(() =>
    loadProgress(catalogue ? `style-${catalogue.templateId}` : loadDraftId() ?? ''),
  );
  /** The line being typed, before it is added. Not part of the order yet. */
  const [careLineDraft, setCareLineDraft] = useState('');
  /** Size columns this machine has been taught, on top of the built-in ones. */
  const [learnedSizes, setLearnedSizes] = useState<string[]>(() => loadLearnedSizes());
  /** Style names this machine has been taught, on top of the built-in ones. */
  const [learnedStyles, setLearnedStyles] = useState<string[]>(() => loadLearnedStyles());
  /** Which category each style name was last filed into, on this machine. */
  const [learnedCategories, setLearnedCategories] = useState<Record<string, string>>(() =>
    loadStyleCategories(),
  );
  /**
   * Categories created from this sheet, kept until the parent's list catches
   * up: the select must show the one just made, and the parent reloads on its
   * own clock.
   */
  const [createdCategories, setCreatedCategories] = useState<CategoryChoice[]>([]);
  const [creatingCategory, setCreatingCategory] = useState(false);
  const [imageError, setImageError] = useState<string | null>(null);
  const imageInputRef = useRef<HTMLInputElement | null>(null);

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const printInFlight = useRef(false);
  const stopRequested = useRef(false);

  useEffect(() => {
    // A style's sheet is not a draft: it is rebuilt from the catalogue each
    // time, and must not replace the order the other tab has open.
    if (!catalogue) saveDraft(order);
    // Any change to the sheet un-says "Saved". Hung off the order itself rather
    // than off each handler: typing in the grid, picking a symbol or adding a
    // size all went through setOrder directly, so the button kept claiming the
    // edit was filed when it was not. Saving does not touch `order`, so this
    // does not fight the notice it just set.
    setSavedNotice(false);
  }, [catalogue, order]);

  useEffect(() => {
    if (!catalogue) saveDraftId(orderId);
  }, [catalogue, orderId]);

  useEffect(
    () => () => {
      // Unmounting mid-run must not leave the loop feeding a printer nobody is
      // watching; it ends at the next step boundary.
      stopRequested.current = true;
    },
    [],
  );

  const totals = useMemo(() => orderTotals(order), [order]);
  const problems = useMemo(() => validateOrder(order), [order]);
  const warnings = useMemo(() => orderWarnings(order), [order]);
  const productDraft = useMemo(() => buildProductDraft(order), [order]);
  const allCategories = useMemo(() => {
    const known = new Set(categories.map((category) => category.id));
    return [...categories, ...createdCategories.filter((category) => !known.has(category.id))];
  }, [categories, createdCategories]);
  const filedStyle = order.productId ? styleById?.(order.productId) ?? null : null;
  // Filed without a category the product never reaches the label tab, so the
  // sheet resolves one up front — picked, learned or guessed — and refuses to
  // file until it has one. A sheet that is already a product falls back to
  // the category the style sits in: renaming the style must not lose it.
  const productCategory = useMemo(() => {
    const resolved = resolveOrderCategory(order, allCategories, learnedCategories);
    if (resolved || !filedStyle?.categoryId) return resolved;
    return allCategories.find((category) => category.id === filedStyle.categoryId) ?? null;
  }, [allCategories, filedStyle, learnedCategories, order]);
  const productProblems = useMemo(
    () => validateProductDraft(order, productDraft, productCategory),
    [order, productCategory, productDraft],
  );
  const plan = useMemo(() => buildPrintPlan(order), [order]);
  const composition = compositionText(order.materials);
  const percentSum = order.materials.reduce((sum, m) => sum + (Number(m.percent) || 0), 0);
  // One press that lands the composition on exactly 100, when one press can.
  const gapFix = percentFix(order.materials);

  const patch = useCallback((changes: Partial<LabelPrintOrder>) => {
    setOrder((current) => ({ ...current, ...changes }));
    setResult(null);
  }, [setOrder]);

  const lines = careTextLines(order.careText);
  const trimmedDraft = careLineDraft.trim();
  /** Rows still free, once the tag's overall length is taken into account. */
  const lineRoomLeft = careTextLinesFit([...lines, 'X']) ? CARE_TEXT_MAX_LINES - lines.length : 0;
  const canAddCareLine =
    !!trimmedDraft && !lines.includes(trimmedDraft) && careTextLinesFit([...lines, trimmedDraft]);

  const commitCareLine = () => {
    if (!canAddCareLine) return;
    patch({ careText: addCareTextLine(order.careText, trimmedDraft) });
    setCareLineDraft('');
  };

  const setStickerQuantity = (rowId: string, value: string) => {
    const quantity = value === '' ? undefined : Math.max(0, Math.floor(Number(value) || 0));
    setOrder((current) => ({
      ...current,
      rows: current.rows.map((row) => (row.id === rowId ? { ...row, stickerQuantity: quantity } : row)),
    }));
  };

  const setSizeQuantity = (sizeId: string, value: string) => {
    const quantity = value === '' ? undefined : Math.max(0, Math.floor(Number(value) || 0));
    setOrder((current) => ({
      ...current,
      sizes: current.sizes.map((size) => (size.id === sizeId ? { ...size, quantity } : size)),
    }));
  };

  const toggleMaterial = (name: string) => {
    setOrder((current) => {
      const existing = current.materials.find((m) => m.name === name);
      return {
        ...current,
        materials: existing
          ? current.materials.filter((m) => m.name !== name)
          : [...current.materials, { name, percent: 0 }],
      };
    });
  };

  const setMaterialPercent = (name: string, value: string) => {
    const percent = Math.max(0, Math.min(100, Math.floor(Number(value) || 0)));
    setOrder((current) => ({
      ...current,
      materials: current.materials.map((m) => (m.name === name ? { ...m, percent } : m)),
    }));
  };

  const toggleCareSymbol = (symbol: CareSymbol) => {
    setOrder((current) => {
      if (current.careSymbols.includes(symbol)) {
        return { ...current, careSymbols: current.careSymbols.filter((s) => s !== symbol) };
      }
      // Wash, bleach, tumble, iron and dry-clean each behave like a radio group:
      // a tag saying both "wash at 30" and "do not wash" is nonsense, and main
      // would refuse it at print time anyway.
      const exclusive = FABRIC_TAG_EXCLUSIVE_CARE_SYMBOL_GROUPS.find((group) =>
        group.includes(symbol),
      );
      const compatible = exclusive
        ? current.careSymbols.filter((selected) => !exclusive.includes(selected))
        : current.careSymbols;
      return {
        ...current,
        careSymbols: [...compatible, symbol].sort(
          (a, b) => CARE_SYMBOLS.indexOf(a) - CARE_SYMBOLS.indexOf(b),
        ),
      };
    });
  };

  const addSize = (label: string) => {
    const trimmed = label.trim().slice(0, MAX_SIZE_LABEL_CHARS);
    if (!trimmed) return;
    setOrder((current) =>
      current.sizes.some((s) => s.label === trimmed)
        ? current
        : { ...current, sizes: [...current.sizes, { id: nextId('size'), label: trimmed }] },
    );
  };

  /**
   * A size typed by hand becomes a button for next time. Remembered even when
   * the column is a duplicate and the add is a no-op: the operator has still
   * told the machine this is a size they work in.
   */
  const addTypedSize = (label: string) => {
    setLearnedSizes(rememberSize(label));
    addSize(label);
  };

  const removeSize = (sizeId: string) =>
    patch({ sizes: order.sizes.filter((size) => size.id !== sizeId) });

  const addRow = () =>
    patch({
      rows: [
        ...order.rows,
        { id: nextId('row'), colorName: '', quantities: {} },
      ],
    });

  const removeRow = (rowId: string) => patch({ rows: order.rows.filter((r) => r.id !== rowId) });

  /**
   * The customer's sheet, pasted rather than retyped. Held apart from the order
   * until the operator has seen what was read: eight colours by six sizes is 48
   * cells, and replacing the grid with a misread one silently would be worse
   * than typing them.
   */
  const [pasteText, setPasteText] = useState<string | null>(null);
  const pasted = useMemo(
    () => (pasteText && pasteText.trim() ? parsePastedGrid(pasteText, nextId) : null),
    [pasteText],
  );

  const acceptPaste = () => {
    // The button carries the "did it read?" test; this one is only here so the
    // types know there is a grid to take.
    if (!pasted) return;
    // Fresh ids all round, so nothing is inherited from the sheet being
    // replaced — including an interrupted run's batches.
    // Its colour × size cells become one garment count per size; the bag
    // counts per colour are the packer's to type.
    const folded = foldGridIntoSizes(pasted.sizes, pasted.rows);
    patch({ sizes: folded.sizes, rows: folded.rows });
    setPasteText(null);
  };

  /**
   * Every button runs this same loop; they differ in the plan they hand it and
   * in whether the run is worth writing down. A sample is not: it is one label
   * to look at, and recording it would tell the operator a real order had been
   * started.
   */
  const runPlan = async (
    steps: PrintStep[],
    options: { resumeFrom?: string[]; track?: boolean } = {},
  ) => {
    if (printInFlight.current || steps.length === 0) return;
    const api = (window as any).electronAPI;
    if (!api?.printPackagingSticker || !api?.printFabricTag) {
      setResult({ type: 'error', message: 'Print bridge unavailable' });
      return;
    }

    const track = options.track !== false;
    const already = options.resumeFrom ?? [];

    printInFlight.current = true;
    stopRequested.current = false;
    learnStyle();
    // A sheet that went to the printer is a real order, so it is filed without
    // being asked for — under the id the run is tracked by, before the first
    // batch. Staff press Print and walk off to the ribbon; the sheet nobody
    // pressed Save on was the one retyped when the customer ordered it again,
    // and filing it up front also survives the app being closed on a jam. A
    // sample is not an order and files nothing, same as it records no progress.
    if (track) {
      void saveOrder(orderId, order).then(setSavedOrders);
      setSavedNotice(true);
    }
    onPrintingChange?.(true);
    setResult(null);
    if (track) setResume(null);

    try {
      const outcome = await runPrintPlan(
        steps,
        {
          customerName: order.customerName,
          // The sticker names the kind of garment, not the style: see
          // `stickerGarmentType`.
          styleName: stickerGarmentType(productCategory?.name, order.styleName),
          styleCode: order.styleCode,
        },
        {
          printSticker: (request) => api.printPackagingSticker(request),
          printFabricTag: (request) => api.printFabricTag(request),
        },
        {
          onProgress: (update) => {
            setProgress(update);
            // After every batch, not at the end of the run: a jam the operator
            // walks away from never reaches the end of the run.
            if (track) saveProgress(orderId, [...already, ...update.completedIds]);
          },
          shouldStop: () => stopRequested.current,
        },
        { completedIds: already },
      );

      if (track) {
        if (outcome.type === 'success') {
          clearProgress();
          setResume(null);
        } else {
          setResume(loadProgress(orderId));
        }
      }

      setResult({
        type: outcome.type,
        message:
          outcome.type === 'success'
            ? copy.finished(outcome.printedCopies)
            : outcome.type === 'stopped'
              ? copy.stopped(outcome.completedSteps, steps.length)
              : outcome.message || 'Print failed',
      });
    } finally {
      printInFlight.current = false;
      onPrintingChange?.(false);
    }
  };

  const handlePrint = () => {
    if (problems.length > 0) return;
    return runPlan(plan);
  };

  /**
   * One label of each kind before the ribbon is committed. A misspelling or the
   * wrong wash symbol is only visible on the printed tag, and by then the whole
   * order is out.
   *
   * A quantity is not needed to look at a tag, so an empty order or a colour
   * without a bag count does not block it — but a code the printer would
   * refuse does, since that sample cannot print either.
   */
  const samplePlan = useMemo(() => buildSamplePlan(order), [order]);
  const blockingForSample = problems.filter(
    (problem) => problem !== 'EMPTY_ORDER' && problem !== 'NO_STICKER_QTY',
  );
  const canPrintSample =
    progress?.type !== 'printing' && blockingForSample.length === 0 && samplePlan.length > 0;

  // No second guard in here: the button carries `disabled={!canPrintSample}`, and
  // `runPlan` refuses an empty plan or a run already in flight. A mutation run
  // showed a repeated check was unreachable — dead code that reads like safety.
  const handleSamplePrint = () => runPlan(samplePlan, { track: false });

  /** Everything but "already filed": those are the rules for pushing an edit. */
  const updateProblems = productProblems.filter((problem) => problem !== 'ALREADY_FILED');
  // A fresh sheet whose code is already a style on the tab: the server would
  // refuse a second style with that SKU, so the sheet joins the one there.
  const matchingStyle =
    !order.productId && order.styleCode.trim() ? styleByCode?.(order.styleCode.trim()) ?? null : null;
  // Joining needs no category of its own: the style already has one.
  const attachProblems = updateProblems.filter((problem) => problem !== 'NO_CATEGORY');

  /**
   * Push the sheet onto a style: the name, the colours and sizes it does not
   * have yet, the price, the tag content, the photo, and — for a sheet that
   * made the style — the category. Not the code, which is every row's SKU and
   * barcode, and not the quantities, which are what is printed, not stock.
   *
   * `attach` is a fresh sheet joining a style that carries its code. It takes
   * the style's category rather than moving the style to its own guess, and
   * it is stamped with the product id only once the server has taken the rows.
   */
  const pushOntoStyle = async (templateId: string, style: FiledStyle, mode: 'update' | 'attach') => {
    setFiling(true);
    setFileError(null);
    setFileNotice(null);
    try {
      // The sheet is the whole product: whatever differs from the style is
      // written back. The name goes first, so the rows added below carry it,
      // and through the server's style rename — `name` alone would rename one
      // row and leave the style split in two. Refused, it stops the run;
      // unsupported by an older server, it is said and the rest goes on.
      let nameNote = '';
      const anchor = style.variants[0];
      const nextName = order.styleName.trim();
      if (mode === 'update' && anchor && nextName && nextName !== style.name.trim()) {
        const caps = await window.electronAPI.pos.productAdmin.getCapabilities();
        if (caps?.ok && caps.capabilities?.supportsStyleRename === true) {
          const renamed = await window.electronAPI.pos.productAdmin.updateVariant(anchor.id, {
            styleName: nextName,
            expectedUpdatedAt: await latestRevision(anchor.id, anchor.updated_at),
          });
          if (!renamed?.ok) {
            setFileError(copy.nameSyncFailed(renamed?.error || renamed?.code || '?'));
            return;
          }
          nameNote = copy.nameSynced;
        } else {
          nameNote = copy.nameSyncUnsupported;
        }
      }
      const missing = buildMissingVariants(order, style.variants);
      let createdIds: string[] = [];
      if (missing.length > 0) {
        fileKeyRef.current ??= nextId('update');
        const result = await window.electronAPI.pos.productAdmin.createProduct({
          productId: templateId,
          name: productDraft.name,
          sku: productDraft.sku,
          priceGrossGrosze: productDraft.priceGrossGrosze,
          trackInventory: productDraft.trackInventory,
          vatRate: 23,
          idempotencyKey: fileKeyRef.current,
          variants: missing.map((variant) => ({
            colorName: variant.colorName,
            sizeName: variant.sizeName,
            sku: variant.sku,
            barcode: variant.sku,
            initialStockQty: variant.initialStockQty,
            ...(variant.priceGrossGrosze ? { priceGrossGrosze: variant.priceGrossGrosze } : {}),
          })),
        });
        const created = result?.data?.variants ?? (result?.data?.variant ? [result.data.variant] : []);
        if (!result?.ok) {
          setFileError(copy.fileFailed(result?.error || result?.code || '?'));
          return;
        }
        fileKeyRef.current = null;
        createdIds = created.map((variant: { id: string }) => variant.id);
      }
      if (mode === 'update' && productCategory && productCategory.id !== style.categoryId && anchor) {
        const moved = await window.electronAPI.pos.productAdmin.updateVariant(anchor.id, {
          categoryId: productCategory.id,
          expectedUpdatedAt: await latestRevision(anchor.id, anchor.updated_at),
        });
        if (!moved?.ok) {
          setFileError(copy.fileFailed(moved?.error || moved?.code || '?'));
          return;
        }
      }
      const categoryId = mode === 'attach' ? style.categoryId ?? productCategory?.id ?? null : productCategory?.id ?? null;
      if (mode === 'attach') {
        // The rows are on the style now; from here the sheet is that product,
        // and its stickers say what the style's category says.
        patch({ productId: templateId, categoryId });
      }
      // The sheet's tag content and photo go on before the price: a price the
      // server refuses must not leave the style without a tag to print from.
      const tagSaved = await saveFabricTagContent(templateId, order);
      let imageNote = '';
      if (order.imageDataUrl) {
        const targets = [...style.variants, ...createdIds];
        const outcome = await uploadImageToVariants(targets, {
          dataUrl: order.imageDataUrl,
          fileName: 'sheet.jpg',
          mimeType: 'image/jpeg',
        });
        imageNote = copy.imageUploaded(outcome.uploaded.length, targets.length);
      }
      if (categoryId) {
        setLearnedCategories(rememberStyleCategory(styleCategoryKey(order.styleName), categoryId));
        onProductFiled?.({ categoryId });
      }
      // Every row to the price on the sheet — the sheet's, or its colour's
      // own: rows the style already had are brought to it, so a colour added
      // today does not ring up at a different number from the colour filed
      // last week. Each write carries the row's current revision; the
      // category move above may have moved every row's.
      let priceNote = '';
      const sheetPrice = productDraft.priceGrossGrosze;
      if (sheetPrice >= 1) {
        const stale = style.variants
          .map((variant) => ({ variant, price: priceForColour(order, variant.color_name) }))
          .filter(({ variant, price }) => Math.floor(Number(variant.retail_price) || 0) !== price);
        for (const { variant, price } of stale) {
          const priced = await window.electronAPI.pos.productAdmin.updateVariant(variant.id, {
            priceGrossGrosze: price,
            expectedUpdatedAt: await latestRevision(variant.id, variant.updated_at),
          });
          if (!priced?.ok) {
            setFileError(copy.priceSyncFailed(priced?.error || priced?.code || '?'));
            return;
          }
        }
        if (stale.length > 0) priceNote = copy.priceSynced(stale.length);
      }
      const done = mode === 'attach' ? copy.attached(style.name, createdIds.length) : copy.updated(createdIds.length);
      setFileNotice((tagSaved ? done : copy.filedWithoutTag(createdIds.length)) + nameNote + priceNote + imageNote);
    } catch (err) {
      setFileError(copy.fileFailed(err instanceof Error ? err.message : String(err)));
    } finally {
      setFiling(false);
    }
  };

  const handleUpdateProduct = async () => {
    const templateId = order.productId;
    if (!templateId || updateProblems.length > 0 || filing) return;
    const style = styleById?.(templateId) ?? null;
    if (!style) {
      setFileError(copy.styleUnknown);
      return;
    }
    await pushOntoStyle(templateId, style, 'update');
  };

  const handleAttachProduct = async () => {
    if (!matchingStyle || attachProblems.length > 0 || filing) return;
    await pushOntoStyle(matchingStyle.id, matchingStyle, 'attach');
  };

  /**
   * A style name is learned when the order is filed or sent to the printer, not
   * while it is typed: a free-text field has no "done" moment, and learning on
   * every keystroke would fill the dropdown with "K", "KU", "KUR".
   */
  const learnStyle = () => setLearnedStyles(rememberStyle(order.styleName));

  /**
   * Make a category named after the style, on the server, and pick it. Named
   * like the ones the shop already has — "Spodnie", not "SPODNIE" — because the
   * sheet capitalises everything and the category list does not.
   */
  const handleCreateCategory = async () => {
    const styleName = order.styleName.trim();
    if (!styleName || creatingCategory) return;
    const name = styleName.charAt(0) + styleName.slice(1).toLocaleLowerCase('pl');
    setCreatingCategory(true);
    setFileError(null);
    try {
      const bridge = (window as any).electronAPI?.pos?.productAdmin;
      const result = await bridge?.createCategory?.({ name, idempotencyKey: nextId('category') });
      const category = result?.ok ? result.data?.category : null;
      if (!category?.id) {
        setFileError(copy.categoryCreateFailed(result?.error || result?.code || '?'));
        return;
      }
      setCreatedCategories((current) => [...current, { id: category.id, name: category.name || name }]);
      patch({ categoryId: category.id });
      await onCategoriesChanged?.();
    } catch (err) {
      setFileError(copy.categoryCreateFailed(err instanceof Error ? err.message : String(err)));
    } finally {
      setCreatingCategory(false);
    }
  };

  const handleSave = () => {
    void saveOrder(orderId, order).then(setSavedOrders);
    learnStyle();
    setSavedNotice(true);
  };

  const handlePickImage = async (file: File | undefined) => {
    if (!file) return;
    const picked = await readImageFile(file, SHEET_IMAGE_MAX_PX);
    if (!picked) {
      setImageError(copy.imageBadType);
      return;
    }
    setImageError(null);
    patch({ imageDataUrl: picked.dataUrl });
  };

  /**
   * File the sheet as a catalogue product: one template, one variant per filled
   * cell. The sheet keeps the product id afterwards so a second press cannot
   * make a twin — and a failed attempt keeps its idempotency key, so pressing
   * again after a dropped connection resumes the same create rather than
   * starting a second one.
   */
  const handleFileProduct = async () => {
    if (productProblems.length > 0 || filing) return;
    setFiling(true);
    setFileError(null);
    setFileNotice(null);
    try {
      fileKeyRef.current ??= nextId('product');
      const result = await window.electronAPI.pos.productAdmin.createProduct({
        name: productDraft.name,
        sku: productDraft.sku,
        priceGrossGrosze: productDraft.priceGrossGrosze,
        trackInventory: productDraft.trackInventory,
        vatRate: 23,
        categoryId: productCategory!.id,
        idempotencyKey: fileKeyRef.current,
        variants: productDraft.variants.map((variant) => ({
          colorName: variant.colorName,
          sizeName: variant.sizeName,
          sku: variant.sku,
          // The label tab prints whatever `barcode ?? ean` holds and refuses a
          // product with neither. The SKU is already unique per cell and reads
          // as the goods themselves - 115-CZARNY-S - so it is the barcode too
          // rather than a second, meaningless number to keep in step.
          barcode: variant.sku,
          initialStockQty: variant.initialStockQty,
          ...(variant.priceGrossGrosze ? { priceGrossGrosze: variant.priceGrossGrosze } : {}),
        })),
      });
      const created = result?.data?.variants ?? (result?.data?.variant ? [result.data.variant] : []);
      if (!result?.ok || created.length === 0) {
        setFileError(copy.fileFailed(result?.error || result?.code || '?'));
        return;
      }
      // Only a proven success may stamp the sheet; stamping on a timeout would
      // hide the product that was never created.
      const templateId = result.data!.product?.id ?? created[0].id;
      patch({ productId: templateId });
      fileKeyRef.current = null;
      // The filing is the decision: from now on a sheet with this style name
      // lands in the same category without asking, and the label tab shows it.
      setLearnedCategories(
        rememberStyleCategory(styleCategoryKey(order.styleName), productCategory!.id),
      );
      onProductFiled?.({ categoryId: productCategory!.id });
      // The care content lives on the sheet and nowhere else in the catalogue,
      // so it is copied to the machine now. Without it the product tab can
      // print a bag label but never a fabric tag, which is what happened to the
      // first style filed here. A failure to save it must not undo a product
      // that the server has already created, so it is reported, not thrown.
      const tagSaved = await saveFabricTagContent(templateId, order);
      // The photo goes on every row that was just made, so the product tab
      // shows it whichever colour it opens. Reported, not thrown, like the tag.
      let imageNote = '';
      if (order.imageDataUrl) {
        const outcome = await uploadImageToVariants(
          created.map((variant: { id: string }) => variant.id),
          { dataUrl: order.imageDataUrl, fileName: 'sheet.jpg', mimeType: 'image/jpeg' },
        );
        imageNote = copy.imageUploaded(outcome.uploaded.length, created.length);
      }
      setFileNotice(
        (tagSaved ? copy.filed(created.length) : copy.filedWithoutTag(created.length)) + imageNote,
      );
    } catch (err) {
      setFileError(copy.fileFailed(err instanceof Error ? err.message : String(err)));
    } finally {
      setFiling(false);
    }
  };

  /**
   * Filing an order now writes back into the one that is open, so next week's
   * order that differs only in colour would eat last week's if it were opened
   * and edited. Duplicate mints a new id and leaves the sheet exactly as it is.
   *
   * Nothing is filed on the spot on purpose: two rows with the same name is the
   * twin the write-back change just got rid of, and the operator is about to
   * change the colours anyway. So the Save button goes back to reading "Save
   * order", and the saved list stops marking any row as the one on screen.
   */
  const handleDuplicate = () => {
    setOrderId(nextId('order'));
    // The copy is a new sheet, so it may become a new product; the photo is
    // usually the same garment and stays.
    patch({ productId: null });
    setSavedNotice(false);
    // The interrupted run belongs to the order it was started from; the copy has
    // printed nothing. The record stays put, so reopening the original still
    // offers it.
    setResume(null);
  };

  // Switching sheets from the saved list at the bottom leaves the reader
  // looking at the list, not at the order that just replaced everything above.
  const scrollToTop = () => scrollRef.current?.scrollTo({ top: 0 });

  const handleOpen = (saved: SavedPrintOrder) => {
    setOrder(saved.order);
    setOrderId(saved.id);
    setProgress(null);
    setResult(null);
    setSavedNotice(false);
    setResume(loadProgress(saved.id));
    scrollToTop();
  };

  const handleNew = () => {
    clearDraft();
    clearProgress();
    setResume(null);
    setOrder(createEmptyOrder());
    setOrderId(nextId('order'));
    setProgress(null);
    setResult(null);
    setSavedNotice(false);
    scrollToTop();
  };

  /**
   * What the interrupted run got through, counted against the plan as it stands
   * now. Ids are stable per (colour, size) cell, so a sheet edited since the jam
   * simply matches fewer of them — which is the honest answer, not a stale one.
   */
  const resumeStats = useMemo(() => {
    if (!resume) return null;
    const sent = new Set(resume.completedIds);
    const done = plan.filter((step) => sent.has(step.id));
    if (done.length === 0) return null;
    return {
      sentSteps: done.length,
      totalSteps: plan.length,
      sentCopies: done.reduce((sum, step) => sum + step.quantity, 0),
      totalCopies: plan.reduce((sum, step) => sum + step.quantity, 0),
      remaining: plan.length - done.length,
    };
  }, [resume, plan]);

  const handleResumeContinue = () => runPlan(plan, { resumeFrom: resume?.completedIds ?? [] });

  const handleResumeRestart = () => {
    clearProgress();
    setResume(null);
    return runPlan(plan);
  };

  const handleResumeForget = () => {
    clearProgress();
    setResume(null);
  };

  const isPrinting = progress?.type === 'printing';
  const canPrint = problems.length === 0 && plan.length > 0 && !isPrinting;

  // Only offered for a sheet that came from the list: duplicating something
  // that was never filed writes nothing either way, so the button would sit
  // there doing nothing visible.
  const openOrderIsFiled = savedOrders.some((saved) => saved.id === orderId);

  return (
    <div
      ref={scrollRef}
      className="h-full min-h-0 overflow-y-auto rounded-lg border border-slate-200 bg-white p-4"
      data-testid="print-order-panel"
      aria-hidden={!active}
    >
      <header className="mb-4">
        <h2 className="text-lg font-extrabold text-slate-900">{copy.title}</h2>
        <p className="text-sm text-slate-500">{copy.subtitle}</p>
      </header>

      <section className="mb-4 grid gap-3 sm:grid-cols-3">
        <Field label={copy.customer}>
          <input
            className={INPUT}
            value={order.customerName}
            onChange={(e) => patch({ customerName: e.target.value })}
            placeholder="MoonCollection"
          />
        </Field>
        <Field label={copy.styleName}>
          <div className="flex gap-1.5">
            <input
              className={INPUT}
              value={order.styleName}
              onChange={(e) => patch({ styleName: e.target.value })}
              placeholder="KURTKA"
            />
            {/* Pick instead of type. The field stays free text — the shop makes
                things that are not on any list yet, and those are learned when
                the order is saved or printed. */}
            <select
              className="h-9 shrink-0 rounded-md border border-slate-300 bg-white px-1 text-sm font-bold text-slate-600"
              data-testid="style-picker"
              aria-label={copy.styleName}
              value=""
              onChange={(e) => {
                if (e.target.value) patch({ styleName: e.target.value });
              }}
            >
              <option value="">▾</option>
              {STYLE_SUGGESTIONS.map((style) => (
                <option key={style} value={style}>{style}</option>
              ))}
              {learnedStyles.length > 0 && (
                <optgroup label={copy.learnedStyles}>
                  {learnedStyles.map((style) => (
                    <option key={style} value={style}>{style}</option>
                  ))}
                </optgroup>
              )}
            </select>
          </div>
          {/* Only for a name this machine was taught, so a typo saved once has
              a way off the list. */}
          {learnedStyles.includes(order.styleName.trim()) && (
            <button
              type="button"
              data-testid="forget-style"
              onClick={() => setLearnedStyles(forgetStyle(order.styleName.trim()))}
              className="mt-1 text-[11px] font-bold text-slate-400 hover:text-red-600"
            >
              {copy.forgetStyle} {order.styleName.trim()}
            </button>
          )}
        </Field>
        <Field label={copy.styleCode}>
          <input
            className={INPUT}
            value={order.styleCode}
            onChange={(e) => patch({ styleCode: e.target.value })}
            placeholder="114"
          />
        </Field>
      </section>

      {/* Printing ignores these. They exist so the sheet can be filed as a
          product, which is why they sit apart from the label fields above.
          There is no supplier field: this workshop sews to order, so the
          customer on the sheet above IS the counterparty. One price for the
          whole style: the owner wants every colour and size at the same number
          for now, and a colour that costs more is changed on the style
          afterwards. */}
      <section className="mb-4 grid gap-3 sm:grid-cols-4">
        <Field label={copy.price}>
          <input
            className={INPUT}
            data-testid="order-price"
            inputMode="decimal"
            value={priceText}
            onChange={(e) => {
              setPriceText(e.target.value);
              patch({ priceGrossGrosze: textToGrosze(e.target.value) });
            }}
            onBlur={() => setPriceText(groszeToText(order.priceGrossGrosze))}
            placeholder="129,00"
          />
        </Field>
        <FieldGroup label={copy.image}>
          <div className="flex flex-wrap items-center gap-2">
            {(order.imageDataUrl || catalogue?.imageUrl) && (
              <img
                src={order.imageDataUrl || catalogue?.imageUrl || ''}
                alt=""
                data-testid="order-image-preview"
                className="h-10 w-10 rounded-md border border-slate-200 object-cover"
              />
            )}
            <input
              ref={imageInputRef}
              type="file"
              accept={IMAGE_ACCEPT}
              data-testid="order-image"
              className="hidden"
              onChange={(e) => {
                void handlePickImage(e.target.files?.[0]);
                e.target.value = '';
              }}
            />
            <button
              type="button"
              data-testid="order-image-pick"
              onClick={() => imageInputRef.current?.click()}
              className="min-h-9 rounded border border-slate-300 px-2 text-xs font-bold text-slate-700 hover:bg-slate-50"
            >
              {order.imageDataUrl ? copy.imageChange : copy.imagePick}
            </button>
            {order.imageDataUrl && (
              <button
                type="button"
                data-testid="order-image-clear"
                onClick={() => patch({ imageDataUrl: null })}
                className="min-h-9 rounded border border-slate-200 px-2 text-xs font-bold text-slate-500 hover:text-red-600"
              >
                {copy.imageClear}
              </button>
            )}
          </div>
          {imageError && (
            <p className="mt-1 text-[11px] font-bold text-red-700" data-testid="order-image-error">
              {imageError}
            </p>
          )}
        </FieldGroup>
        {!catalogue && (
          <Field label={copy.orderDate}>
            <DateField
              testId="order-date"
              label={copy.orderDate}
              language={language}
              value={order.orderDate}
              onChange={(orderDate) => patch({ orderDate })}
            />
          </Field>
        )}
        <Field label={copy.category}>
          <select
            className={INPUT}
            data-testid="order-category"
            aria-label={copy.category}
            value={productCategory?.id ?? ''}
            onChange={(e) => patch({ categoryId: e.target.value || null })}
          >
            <option value="">{copy.categoryPick}</option>
            {allCategories.map((category) => (
              <option key={category.id} value={category.id}>{category.name}</option>
            ))}
          </select>
          {!productCategory && (
            <div className="mt-1 flex flex-wrap items-center gap-2">
              <p className="text-[11px] font-bold text-amber-700" data-testid="order-category-none">
                {copy.categoryNone}
              </p>
              {order.styleName.trim() && (
                <button
                  type="button"
                  data-testid="create-category"
                  disabled={creatingCategory}
                  onClick={handleCreateCategory}
                  className="min-h-8 rounded border border-slate-300 px-2 text-xs font-bold text-slate-700 hover:bg-slate-50 disabled:opacity-50"
                >
                  {creatingCategory
                    ? copy.creatingCategory
                    : copy.createCategory(order.styleName.trim())}
                </button>
              )}
            </div>
          )}
        </Field>
      </section>

      {/* The fabric block only when a fabric tag is going to be printed: it is
          the longest part of the sheet, and a sticker-only order has nothing to
          say in it. What was typed there is kept, not cleared, so ticking the
          lane back on shows it again.
          No `disabled` here: the sheet has always stayed editable during a run,
          and the plan handed to the printer is a snapshot taken before it. */}
      {order.printFabricTags && (
        <FabricTagFields language={language} value={order} onChange={patch} />
      )}

      <section className="mb-4 rounded-md border border-slate-200 p-3">
        <div className="mb-2 flex flex-wrap items-center gap-2">
          <h3 className="text-sm font-bold text-slate-700">{copy.sizes}</h3>
          {SIZE_SUGGESTIONS.map((label) => (
            <button
              key={label}
              type="button"
              data-size-suggestion={label}
              onClick={() => addSize(label)}
              className="min-h-8 rounded border border-slate-200 px-2 text-xs font-bold text-slate-600 hover:bg-slate-50"
            >
              + {label}
            </button>
          ))}
          {/* Taught by this shop. Marked apart from the built-ins and removable,
              because a size typed with a typo would otherwise sit on the row
              for good. */}
          {learnedSizes.map((label) => (
            <span
              key={label}
              data-learned-size={label}
              className="inline-flex items-center rounded border border-emerald-200 bg-emerald-50"
            >
              <button
                type="button"
                data-size-suggestion={label}
                onClick={() => addSize(label)}
                className="min-h-8 px-2 text-xs font-bold text-emerald-800 hover:bg-emerald-100"
              >
                + {label}
              </button>
              <button
                type="button"
                aria-label={`${copy.forgetSize} ${label}`}
                onClick={() => setLearnedSizes(forgetSize(label))}
                className="min-h-8 px-1 text-emerald-500 hover:text-red-600"
              >
                <X size={12} aria-hidden="true" />
              </button>
            </span>
          ))}
          <SizeAdder onAdd={addTypedSize} placeholder={copy.addSize} />
          <button
            type="button"
            data-testid="paste-open"
            onClick={() => setPasteText(pasteText === null ? '' : null)}
            className="min-h-8 rounded border border-slate-300 px-2 text-xs font-bold text-slate-700 hover:bg-slate-50"
          >
            {copy.pasteOpen}
          </button>
        </div>

        {pasteText !== null && (
          <div className="mb-3 rounded-md border border-slate-300 bg-slate-50 p-3" data-testid="paste-box">
            <p className="mb-2 text-xs text-slate-600">{copy.pasteHint}</p>
            <textarea
              data-testid="paste-input"
              aria-label={copy.pasteOpen}
              value={pasteText}
              onChange={(e) => setPasteText(e.target.value)}
              rows={5}
              className="w-full rounded-md border border-slate-300 p-2 font-mono text-xs"
            />
            {pasted && pasted.problems.length > 0 && (
              <p className="mt-2 text-sm font-bold text-red-700" data-testid="paste-problem">
                {pasted.problems.map((problem) => copy.pasteProblem[problem]).join(' ')}
              </p>
            )}
            {pasted && pasted.problems.length === 0 && (
              <p className="mt-2 text-sm font-bold text-slate-800" data-testid="paste-preview">
                {copy.pasteRead(pasted.rows.length, pasted.sizes.length, pasted.totalCopies)}{' '}
                {(order.rows.length > 0 || order.sizes.length > 0) &&
                  copy.pasteReplace(order.rows.length, order.sizes.length)}
              </p>
            )}
            <div className="mt-2 flex flex-wrap gap-2">
              <button
                type="button"
                data-testid="paste-accept"
                onClick={acceptPaste}
                disabled={!pasted || pasted.problems.length > 0}
                className="min-h-10 rounded-md bg-slate-800 px-3 text-sm font-extrabold text-white disabled:cursor-not-allowed disabled:opacity-50"
              >
                {copy.pasteAccept}
              </button>
              <button
                type="button"
                data-testid="paste-cancel"
                onClick={() => setPasteText(null)}
                className="min-h-10 rounded-md border border-slate-300 px-3 text-sm font-bold text-slate-600"
              >
                {copy.pasteCancel}
              </button>
            </div>
          </div>
        )}

        <div className="overflow-x-auto">
          <table className="w-full min-w-[600px] border-collapse text-sm">
            <thead>
              <tr>
                {/* Widths pinned on every column but the last: with the sticker
                    code column gone, the colour input was the only flexible
                    thing left and grew to the whole row. The last column takes
                    what is left, which keeps the numbers under their headers. */}
                <th className="w-56 border-b border-slate-200 p-2 text-left font-bold">{copy.color}</th>
                {order.sizes.map((size) => (
                  <th key={size.id} className="w-24 border-b border-slate-200 p-2 text-center font-bold">
                    <span className="inline-flex items-center gap-1">
                      {size.label}
                      <button
                        type="button"
                        onClick={() => removeSize(size.id)}
                        aria-label={`${copy.remove} ${size.label}`}
                        className="text-slate-400 hover:text-red-600"
                      >
                        <X size={12} aria-hidden="true" />
                      </button>
                    </span>
                  </th>
                ))}
                <th className="w-20 border-b border-slate-200 p-2 text-center font-bold">{copy.rowTotal}</th>
                <th className="w-24 border-b border-slate-200 p-2 text-center font-bold text-sky-800">{copy.stickerQty}</th>
                <th className="w-28 border-b border-slate-200 p-2 text-center font-bold">{copy.colourPrice}</th>
                <th className="border-b border-slate-200 p-2" />
              </tr>
            </thead>
            <tbody>
              {/* The top row is the fabric lane: garments per size across every
                  colour, since a fabric tag names the size and not the colour.
                  The colour rows below carry only the bag sticker count. */}
              <tr data-testid="fabric-row" className="bg-emerald-50/60">
                <td className="border-b border-slate-100 p-2 font-bold text-emerald-900">{copy.fabricRow}</td>
                {order.sizes.map((size) => (
                  <td key={size.id} className="border-b border-slate-100 p-1 text-center">
                    <input
                      type="number"
                      min={0}
                      className="h-10 w-20 rounded-md border border-emerald-300 px-2 text-center text-sm"
                      value={size.quantity ?? ''}
                      onChange={(e) => setSizeQuantity(size.id, e.target.value)}
                      disabled={!order.printFabricTags}
                      aria-label={`${copy.fabricRow} ${size.label}`}
                    />
                  </td>
                ))}
                <td className="border-b border-slate-100 p-2 text-center font-extrabold" data-testid="fabric-total">
                  {totals.grandTotal}
                </td>
                <td className="border-b border-slate-100 p-2" />
                <td className="border-b border-slate-100 p-2" />
                <td className="border-b border-slate-100 p-2" />
              </tr>
              {order.rows.map((row) => (
                <tr key={row.id}>
                  <td className="border-b border-slate-100 p-1">
                    <input
                      className={INPUT}
                      value={row.colorName}
                      onChange={(e) =>
                        patch({
                          rows: order.rows.map((r) =>
                            r.id === row.id ? { ...r, colorName: e.target.value } : r,
                          ),
                        })
                      }
                      placeholder="CZEKOLADA"
                      aria-label={copy.color}
                    />
                  </td>
                  {order.sizes.map((size) => (
                    <td key={size.id} className="border-b border-slate-100 p-1" />
                  ))}
                  <td className="border-b border-slate-100 p-2" />
                  <td className="border-b border-slate-100 p-1 text-center">
                    <input
                      type="number"
                      min={0}
                      className="h-10 w-20 rounded-md border border-sky-300 px-2 text-center text-sm"
                      value={row.stickerQuantity ?? ''}
                      onChange={(e) => setStickerQuantity(row.id, e.target.value)}
                      disabled={!order.printStickers}
                      aria-label={`${copy.stickerQty} ${row.colorName || copy.color}`}
                    />
                  </td>
                  <td className="border-b border-slate-100 p-1 text-center">
                    <ColourPriceInput
                      value={row.priceGrossGrosze}
                      placeholder={order.priceGrossGrosze ? groszeToText(order.priceGrossGrosze) : ''}
                      ariaLabel={`${copy.colourPrice} ${row.colorName || copy.color}`}
                      onChange={(priceGrossGrosze) =>
                        patch({
                          rows: order.rows.map((r) => {
                            if (r.id !== row.id) return r;
                            const { priceGrossGrosze: _dropped, ...rest } = r;
                            return priceGrossGrosze === undefined ? rest : { ...rest, priceGrossGrosze };
                          }),
                        })
                      }
                    />
                  </td>
                  <td className="border-b border-slate-100 p-2">
                    <button
                      type="button"
                      onClick={() => removeRow(row.id)}
                      aria-label={`${copy.remove} ${row.colorName || row.id}`}
                      className="text-slate-400 hover:text-red-600"
                    >
                      <Trash2 size={16} aria-hidden="true" />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <td className="p-2 font-bold">{copy.total}</td>
                {order.sizes.map((size) => (
                  <td key={size.id} className="p-2" />
                ))}
                <td className="p-2 text-center text-base font-extrabold" data-testid="grand-total">
                  {totals.grandTotal}
                </td>
                <td className="p-2 text-center text-base font-extrabold text-sky-800" data-testid="sticker-total">
                  {totals.stickerTotal}
                </td>
                <td />
                <td />
              </tr>
            </tfoot>
          </table>
        </div>

        <button
          type="button"
          onClick={addRow}
          className="mt-2 inline-flex min-h-10 items-center gap-1 rounded-md border border-slate-300 px-3 text-sm font-bold text-slate-700 hover:bg-slate-50"
        >
          <Plus size={16} aria-hidden="true" />
          {copy.addRow}
        </button>
      </section>

      {problems.length > 0 && (
        <ul className="mb-3 space-y-1" data-testid="order-problems">
          {problems.map((problem) => (
            <li key={problem} className="text-sm font-bold text-red-700">
              {copy.problem[problem]}
            </li>
          ))}
        </ul>
      )}
      {warnings.length > 0 && (
        <ul className="mb-3 space-y-1" data-testid="order-warnings">
          {warnings.map((warning) => (
            <li key={warning} className="text-sm font-bold text-amber-700">
              {copy.warning[warning]}
            </li>
          ))}
        </ul>
      )}

      <p className="mb-2 text-xs text-slate-500">{copy.noResume}</p>

      {resumeStats && !isPrinting && (
        <div
          className="mb-2 rounded-md border border-amber-300 bg-amber-50 p-3"
          data-testid="resume-block"
        >
          <p className="text-sm font-bold text-amber-900" data-testid="resume-sent">
            {copy.resumeSent(
              resumeStats.sentSteps,
              resumeStats.totalSteps,
              resumeStats.sentCopies,
              resumeStats.totalCopies,
            )}
          </p>
          <p className="mb-2 text-xs text-amber-800">{copy.resumeCount}</p>
          <div className="flex flex-wrap gap-2">
            {resumeStats.remaining > 0 && (
              <button
                type="button"
                data-testid="resume-continue"
                onClick={handleResumeContinue}
                className="min-h-10 rounded-md bg-amber-600 px-3 text-sm font-extrabold text-white"
              >
                {copy.resumeContinue(resumeStats.sentSteps + 1)}
              </button>
            )}
            <button
              type="button"
              data-testid="resume-restart"
              onClick={handleResumeRestart}
              className="min-h-10 rounded-md border border-amber-400 px-3 text-sm font-bold text-amber-900"
            >
              {copy.resumeRestart}
            </button>
            <button
              type="button"
              data-testid="resume-forget"
              onClick={handleResumeForget}
              className="min-h-10 rounded-md border border-slate-300 px-3 text-sm font-bold text-slate-600"
            >
              {copy.resumeForget}
            </button>
          </div>
        </div>
      )}

      {/* The lanes sit here, against the Print button, rather than at the head
          of the sheet: they are the last thing decided, not the first. The
          fabric block still appears where it belongs — up with the tag it is
          about — so ticking that lane on grows the sheet above this box. */}
      <section className="mb-4 rounded-md border border-slate-200 p-3">
        <h3 className="mb-2 text-sm font-bold text-slate-700">{copy.whatToPrint}</h3>
        <div className="flex flex-wrap gap-4">
          <Check
            label={copy.printFabric}
            checked={order.printFabricTags}
            onChange={(v) => patch({ printFabricTags: v })}
          />
          <Check
            label={copy.printSticker}
            checked={order.printStickers}
            onChange={(v) => patch({ printStickers: v })}
          />
        </div>
      </section>

      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={handlePrint}
          disabled={!canPrint}
          className="inline-flex min-h-11 items-center gap-2 rounded-md bg-emerald-600 px-4 text-sm font-extrabold text-white disabled:cursor-not-allowed disabled:opacity-50"
        >
          <Play size={18} aria-hidden="true" />
          {isPrinting ? copy.printing : copy.print}
        </button>
        <button
          type="button"
          data-testid="print-sample"
          onClick={handleSamplePrint}
          disabled={!canPrintSample}
          title={copy.samplePrintHint}
          className="inline-flex min-h-11 items-center gap-2 rounded-md border border-emerald-300 px-4 text-sm font-bold text-emerald-800 hover:bg-emerald-50 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {copy.samplePrint}
        </button>
        {!catalogue && (
          <button
            type="button"
            onClick={handleSave}
            className="inline-flex min-h-11 items-center gap-2 rounded-md border border-slate-300 px-4 text-sm font-bold text-slate-700 hover:bg-slate-50"
          >
            <Save size={18} aria-hidden="true" />
            {savedNotice ? copy.saved : copy.save}
          </button>
        )}
        {order.productId ? (
          <button
            type="button"
            data-testid="update-product"
            onClick={handleUpdateProduct}
            disabled={updateProblems.length > 0 || filing}
            title={updateProblems.length > 0 ? copy.fileProblem[updateProblems[0]] : copy.fileHint}
            className="inline-flex min-h-11 items-center gap-2 rounded-md border border-sky-300 px-4 text-sm font-bold text-sky-800 hover:bg-sky-50 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <Package size={18} aria-hidden="true" />
            {filing ? copy.updating : copy.updateProduct}
          </button>
        ) : matchingStyle ? (
          <button
            type="button"
            data-testid="attach-product"
            onClick={handleAttachProduct}
            disabled={attachProblems.length > 0 || filing}
            title={attachProblems.length > 0 ? copy.fileProblem[attachProblems[0]] : copy.attachHint(matchingStyle.name)}
            className="inline-flex min-h-11 items-center gap-2 rounded-md border border-sky-300 px-4 text-sm font-bold text-sky-800 hover:bg-sky-50 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <Package size={18} aria-hidden="true" />
            {filing ? copy.attaching : copy.attachProduct(matchingStyle.name)}
          </button>
        ) : (
          <button
            type="button"
            data-testid="file-product"
            onClick={handleFileProduct}
            disabled={productProblems.length > 0 || filing}
            title={productProblems.length > 0
              ? copy.fileProblem[productProblems[0]]
              : copy.fileHint}
            className="inline-flex min-h-11 items-center gap-2 rounded-md border border-sky-300 px-4 text-sm font-bold text-sky-800 hover:bg-sky-50 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <Package size={18} aria-hidden="true" />
            {filing ? copy.filing : copy.fileProduct}
          </button>
        )}
        {!catalogue && openOrderIsFiled && (
          <button
            type="button"
            data-testid="duplicate-order"
            onClick={handleDuplicate}
            disabled={isPrinting}
            title={copy.duplicateHint}
            className="inline-flex min-h-11 items-center rounded-md border border-slate-300 px-4 text-sm font-bold text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {copy.duplicate}
          </button>
        )}
        {!catalogue && (
          <button
            type="button"
            onClick={handleNew}
            className="inline-flex min-h-11 items-center rounded-md border border-slate-300 px-4 text-sm font-bold text-slate-700 hover:bg-slate-50"
          >
            {copy.newOrder}
          </button>
        )}
        {isPrinting && (
          <button
            type="button"
            data-testid="stop-print"
            onClick={() => {
              stopRequested.current = true;
            }}
            className="inline-flex min-h-11 items-center rounded-md border border-red-300 px-4 text-sm font-bold text-red-700 hover:bg-red-50"
          >
            {copy.stopAfter}
          </button>
        )}
      </div>

      {progress && (
        <p className="mt-2 text-sm font-bold text-slate-700" data-testid="print-progress">
          {copy.progress(
            progress.completedSteps,
            progress.totalSteps,
            progress.printedCopies,
            progress.totalCopies,
          )}
        </p>
      )}

      {isPrinting && (
        <p className="text-xs text-slate-500" data-testid="stop-hint">
          {copy.stopHint}
        </p>
      )}

      {result && (
        <p
          className={`mt-1 text-sm font-bold ${
            result.type === 'error' ? 'text-red-700' : 'text-emerald-700'
          }`}
          data-testid="print-result"
        >
          {result.message}
        </p>
      )}

      {order.productId && (
        <p className="mt-1 text-xs font-bold text-slate-500" data-testid="filed-hint">
          {copy.filedHint(filedStyle?.name || order.styleName.trim() || '?')}
        </p>
      )}
      {(fileNotice || fileError) && (
        <p
          className={`mt-1 text-sm font-bold ${fileError ? 'text-red-700' : 'text-sky-700'}`}
          data-testid="file-result"
        >
          {fileError ?? fileNotice}
        </p>
      )}

      {!catalogue && (
      <section className="mt-6 border-t border-slate-200 pt-3">
        <h3 className="mb-2 text-sm font-bold text-slate-700">{copy.savedOrders}</h3>
        {savedOrders.length === 0 ? (
          <p className="text-sm text-slate-500">{copy.noSavedOrders}</p>
        ) : (
          <ul className="space-y-1">
            {savedOrders.map((saved) => (
              <li
                key={saved.id}
                data-saved-order={saved.id}
                data-open={saved.id === orderId ? 'true' : undefined}
                className={`flex items-center gap-2 rounded px-1 text-sm ${
                  saved.id === orderId ? 'bg-emerald-50 font-bold text-emerald-900' : ''
                }`}
              >
                {/* The date the sheet carries, not the moment it was filed:
                    two orders for the same customer differ by that date long
                    before they differ by name. Fixed width and always
                    rendered, so the names below each other still line up when
                    a sheet from an older build has no date at all. */}
                <span
                  data-saved-order-date=""
                  className="w-24 shrink-0 tabular-nums text-xs font-bold text-slate-500"
                >
                  {formatIsoDate(saved.order.orderDate, language)}
                </span>
                <span className="flex-1 truncate">{describeOrder(saved.order)}</span>
                <button
                  type="button"
                  onClick={() => handleOpen(saved)}
                  className="min-h-9 rounded border border-slate-300 px-2 text-xs font-bold hover:bg-slate-50"
                >
                  {copy.open}
                </button>
                <button
                  type="button"
                  onClick={() => void deleteSavedOrder(saved.id).then(setSavedOrders)}
                  className="min-h-9 rounded border border-slate-200 px-2 text-xs font-bold text-slate-500 hover:bg-red-50 hover:text-red-700"
                >
                  {copy.remove}
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
      )}
    </div>
  );
}

const INPUT =
  'h-10 w-full rounded-md border border-slate-300 px-2 text-sm focus:border-emerald-500 focus:outline-none';

/**
 * A colour's own price. Typed as text so "12," does not snap under the
 * cursor; blank means the sheet's price, which the box shows as its hint.
 */
function ColourPriceInput({
  value,
  placeholder,
  ariaLabel,
  onChange,
}: {
  value: number | undefined;
  placeholder: string;
  ariaLabel: string;
  onChange: (grosze: number | undefined) => void;
}) {
  const [text, setText] = useState(() => (value ? groszeToText(value) : ''));
  useEffect(() => {
    setText((current) => {
      const typed = textToGrosze(current);
      const shown = typed >= 1 ? typed : undefined;
      return shown === value ? current : value ? groszeToText(value) : '';
    });
  }, [value]);
  return (
    <input
      inputMode="decimal"
      className="h-10 w-24 rounded-md border border-slate-300 px-2 text-center text-sm"
      value={text}
      placeholder={placeholder}
      aria-label={ariaLabel}
      onChange={(e) => {
        setText(e.target.value);
        const grosze = textToGrosze(e.target.value);
        onChange(grosze >= 1 ? grosze : undefined);
      }}
      onBlur={() => setText(value ? groszeToText(value) : '')}
    />
  );
}

const FIELD_CAPTION = 'mb-1 block text-xs font-bold uppercase tracking-wide text-slate-500';

/**
 * One control with its caption. `min-w-0` because a grid cell defaults to
 * min-width:auto: without it a long control does not wrap, it widens the column
 * and lays itself over the field beside it.
 */
function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block min-w-0">
      <span className={FIELD_CAPTION}>{label}</span>
      {children}
    </label>
  );
}

/**
 * The same caption for a field whose control is a group of buttons.
 *
 * A click anywhere inside a <label> is handed to its first labelable
 * descendant, and for the photo field that is the hidden file input: tapping
 * the caption, the empty half of the cell, or the gap towards the field beside
 * it opened the file dialog without anyone touching the button. A group has no
 * single control to point at, so it is not a label.
 */
function FieldGroup({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <span className={FIELD_CAPTION}>{label}</span>
      {children}
    </div>
  );
}

function Check({
  label,
  checked,
  onChange,
  disabled,
}: {
  label: string;
  checked: boolean;
  onChange: (value: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <label className={`inline-flex items-center gap-2 text-sm font-bold ${disabled ? 'opacity-50' : ''}`}>
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
        className="h-5 w-5 rounded border-slate-300"
      />
      {label}
    </label>
  );
}

function SizeAdder({ onAdd, placeholder }: { onAdd: (label: string) => void; placeholder: string }) {
  const [value, setValue] = useState('');
  const commit = () => {
    onAdd(value);
    setValue('');
  };
  return (
    <span className="inline-flex items-center gap-1">
      <input
        className="h-9 w-24 rounded-md border border-slate-300 px-2 text-sm"
        value={value}
        maxLength={MAX_SIZE_LABEL_CHARS}
        placeholder={placeholder}
        aria-label={placeholder}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            commit();
          }
        }}
      />
      <button
        type="button"
        onClick={commit}
        className="min-h-9 rounded border border-slate-300 px-2 text-xs font-bold hover:bg-slate-50"
      >
        <Plus size={14} aria-hidden="true" />
      </button>
    </span>
  );
}
