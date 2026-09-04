/**
 * Reprinting the labels of one style that is already in the catalogue.
 *
 * The print order sheet makes a style; this prints it again — a bag label that
 * tore, a bundle re-tagged, ten more of the size that sold. The operator picks
 * the style on the left, types a number next to the colours and sizes that need
 * printing, and the run goes out through the same plan builder and runner the
 * order sheet uses. Nothing here formats a label itself: a second renderer that
 * agrees today drifts by next month, and the drift ships on a garment.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, CheckCircle2, Printer, RefreshCw, Square } from 'lucide-react';
import {
  LabelPrintOrder,
  SIZE_SUGGESTIONS,
  buildPrintPlan,
  compositionText,
  parseCompositionText,
  stickerGarmentType,
} from '../../../shared/label-print-order';
import {
  buildAddedVariant,
  validateAddedCell,
  type AddedCellProblem,
  type CategoryChoice,
} from '../../../shared/order-to-product';
import {
  SelectionInput,
  SelectionProblem,
  buildSelectionOrder,
  selectionColours,
  selectionProblems,
  selectionQuantity,
  selectionTotals,
} from '../../../shared/product-print-selection';
import type { FabricTagTemplate } from '../../../shared/types';
import { PrintProgress, runPrintPlan } from './print-order-runner';
import FabricTagFields, { type FabricTagContent } from './FabricTagFields';
import rlog from '../../utils/logger';
import {
  CATALOG_IMAGE_MAX_PX,
  IMAGE_ACCEPT,
  readImageFile,
  uploadImageToVariants,
} from './image-file';
import { groszeToText, textToGrosze } from '../../../shared/order-to-product';

/** One catalogue row of the style, as the label tab holds it. */
export interface StyleVariant {
  id: string;
  name: string;
  sku?: string | null;
  color_name?: string | null;
  size_name?: string | null;
  /** Grosze, as the local catalogue stores it. A new row of the style copies it. */
  retail_price?: number | null;
  image_url?: string | null;
  thumbnail_url?: string | null;
}

interface Props {
  language: string;
  /** Catalogue template the rows belong to; the care content is keyed by it. */
  templateId: string;
  styleName: string;
  styleCode: string;
  variants: readonly StyleVariant[];
  /** The category the style sits in, as the catalogue holds it. */
  categoryId?: string | null;
  /** The salon's categories, for moving the style to another one. */
  categories?: readonly CategoryChoice[];
  onPrintingChange?: (printing: boolean) => void;
  /**
   * Pull the catalogue again after this panel wrote to it — a colour added, a
   * row hidden, the category moved. The rows on screen come from the local
   * mirror, and a change written on the server is not in them until the next
   * sync.
   */
  onCatalogChanged?: () => void | Promise<unknown>;
}

interface Copy {
  variants: string;
  color: string;
  size: string;
  quantity: string;
  lanes: string;
  stickers: string;
  stickerCounts: string;
  fabricTags: string;
  noTagContent: string;
  totals: (stickers: number, fabricTags: number) => string;
  print: (labels: number) => string;
  confirm: (labels: number) => string;
  printing: string;
  stop: string;
  stopping: string;
  done: (labels: number) => string;
  stopped: (done: number, total: number) => string;
  failed: (reason: string) => string;
  clear: string;
  tagEdit: string;
  tagEditOpen: string;
  tagEditClose: string;
  tagBrand: string;
  tagSave: string;
  tagSaving: string;
  tagSaved: string;
  tagSaveFailed: string;
  tagCompositionKept: (line: string) => string;
  addTitle: string;
  profileTitle: string;
  image: string;
  imagePick: string;
  imageChange: string;
  imageBadType: string;
  imageUploading: (done: number, total: number) => string;
  imageDone: (done: number, total: number) => string;
  imageFailed: string;
  profileName: string;
  profileNameHint: string;
  rename: string;
  renameSave: string;
  renameCancel: string;
  renaming: string;
  renamed: (name: string) => string;
  renameFailed: (reason: string) => string;
  renameUnsupported: string;
  profileCode: string;
  profileCategory: string;
  profileCategoryNone: string;
  categoryMoved: (name: string) => string;
  categoryMoveFailed: (reason: string) => string;
  profilePrice: string;
  priceMixed: string;
  priceApply: string;
  priceApplying: string;
  priceApplied: (rows: number) => string;
  priceFailed: (reason: string) => string;
  hide: string;
  hideConfirm: string;
  hideCancel: string;
  hideDone: (colorName: string, sizeName: string) => string;
  hideFailed: (reason: string) => string;
  addColor: string;
  addSize: string;
  addButton: string;
  addSaving: string;
  addDone: (colorName: string, sizeName: string) => string;
  addFailed: (reason: string) => string;
  addProblem: Record<AddedCellProblem, string>;
  problem: Record<SelectionProblem, string>;
}

const COPY: Record<string, Copy> = {
  vi: {
    variants: 'Màu và size đã có',
    color: 'Màu',
    size: 'Size',
    quantity: 'Số lượng',
    lanes: 'In gì',
    stickers: 'Tem đóng gói',
    stickerCounts: 'Số tem đóng gói theo màu (theo chồng đóng túi)',
    fabricTags: 'Tem vải',
    noTagContent:
      'Mẫu này chưa có nội dung tem vải trên máy — chỉ in được tem đóng gói. Bấm “Sửa nội dung tem” ở dưới để điền.',
    totals: (stickers, fabricTags) => `${stickers} tem đóng gói · ${fabricTags} tem vải`,
    print: (labels) => (labels > 0 ? `In ${labels} tem` : 'In'),
    confirm: (labels) => `Bấm lần nữa để in ${labels} tem`,
    printing: 'Đang in…',
    stop: 'Dừng',
    stopping: 'Đang dừng…',
    done: (labels) => `Đã in ${labels} tem`,
    stopped: (done, total) => `Đã dừng — in ${done}/${total} tem`,
    failed: (reason) => `Máy in báo lỗi: ${reason}`,
    clear: 'Xoá số đã gõ',
    tagEdit: 'Nội dung tem vải',
    tagEditOpen: 'Sửa nội dung tem',
    tagEditClose: 'Đóng',
    tagBrand: 'Tên thương hiệu in trên tem',
    tagSave: 'Lưu nội dung tem',
    tagSaving: 'Đang lưu…',
    tagSaved: 'Đã lưu nội dung tem vải',
    tagSaveFailed: 'Không lưu được nội dung tem vải',
    tagCompositionKept: (line) => `Giữ nguyên dòng chất liệu đã lưu: ${line}`,
    addTitle: 'Thêm màu / size',
    profileTitle: 'Hồ sơ kiểu',
    image: 'Ảnh',
    imagePick: 'Đặt ảnh',
    imageChange: 'Đổi ảnh',
    imageBadType: 'Chỉ nhận ảnh JPG, PNG hoặc WEBP',
    imageUploading: (done, total) => `Đang gắn ảnh… ${done}/${total}`,
    imageDone: (done, total) => (done === total ? 'Đã gắn ảnh cho kiểu' : `Ảnh gắn được ${done}/${total} dòng`),
    imageFailed: 'Không gắn được ảnh',
    profileName: 'Tên hàng',
    profileNameHint: 'Đổi tên ở đây là đổi cả tên các dòng màu/size',
    rename: 'Đổi tên',
    renameSave: 'Lưu tên',
    renameCancel: 'Huỷ',
    renaming: 'Đang đổi tên…',
    renamed: (name) => `Đã đổi tên kiểu thành “${name}” — mọi dòng màu/size đi theo`,
    renameFailed: (reason) => `Không đổi được tên: ${reason}`,
    renameUnsupported: 'Máy chủ chưa hỗ trợ đổi tên kiểu từ máy này — đổi trên bảng điều khiển web',
    profileCode: 'Mã hàng',
    profileCategory: 'Nhóm',
    profileCategoryNone: '— Chưa có nhóm —',
    categoryMoved: (name) => `Đã chuyển sang nhóm ${name}`,
    categoryMoveFailed: (reason) => `Không chuyển được nhóm: ${reason}`,
    profilePrice: 'Giá bán (zł)',
    priceMixed: 'các dòng đang khác giá',
    priceApply: 'Áp cho cả kiểu',
    priceApplying: 'Đang đổi giá…',
    priceApplied: (rows) => `Đã đổi giá ${rows} dòng`,
    priceFailed: (reason) => `Không đổi được giá: ${reason}`,
    hide: 'Ẩn',
    hideConfirm: 'Ẩn dòng này?',
    hideCancel: 'Thôi',
    hideDone: (colorName, sizeName) => `Đã ẩn ${[colorName, sizeName].filter(Boolean).join(' / ')}`,
    hideFailed: (reason) => `Không ẩn được: ${reason}`,
    addColor: 'Màu',
    addSize: 'Size',
    addButton: 'Thêm vào mẫu này',
    addSaving: 'Đang thêm…',
    addDone: (colorName, sizeName) =>
      `Đã thêm ${[colorName, sizeName].filter(Boolean).join(' / ')}`,
    addFailed: (reason) => `Không thêm được: ${reason}`,
    addProblem: {
      NO_COLOR_OR_SIZE: 'Gõ màu hoặc size trước đã',
      ALREADY_EXISTS: 'Mẫu này đã có màu và size đó',
    },
    problem: {
      NOTHING_SELECTED: 'Chưa gõ số lượng cho dòng nào',
      NO_LANE: 'Chưa chọn in tem đóng gói hay tem vải',
      NO_STICKER_QTY: 'Chưa nhập số tem đóng gói cho màu đã chọn',
      TOO_MANY: 'Quá nhiều tem cho một lần in',
    },
  },
  pl: {
    variants: 'Dostępne kolory i rozmiary',
    color: 'Kolor',
    size: 'Rozmiar',
    quantity: 'Ilość',
    lanes: 'Co drukować',
    stickers: 'Etykiety na worek',
    stickerCounts: 'Etykiety na worek wg koloru (po jednej na paczkę)',
    fabricTags: 'Metki',
    noTagContent:
      'Ten model nie ma zapisanej treści metki — można wydrukować tylko etykietę na worek. Kliknij „Edytuj treść metki” poniżej.',
    totals: (stickers, fabricTags) => `${stickers} etykiet · ${fabricTags} metek`,
    print: (labels) => (labels > 0 ? `Drukuj ${labels} szt.` : 'Drukuj'),
    confirm: (labels) => `Naciśnij ponownie, aby wydrukować ${labels} szt.`,
    printing: 'Drukowanie…',
    stop: 'Stop',
    stopping: 'Zatrzymywanie…',
    done: (labels) => `Wydrukowano ${labels} szt.`,
    stopped: (done, total) => `Zatrzymano — ${done}/${total} szt.`,
    failed: (reason) => `Błąd drukarki: ${reason}`,
    clear: 'Wyczyść ilości',
    tagEdit: 'Treść metki',
    tagEditOpen: 'Edytuj treść metki',
    tagEditClose: 'Zamknij',
    tagBrand: 'Marka drukowana na metce',
    tagSave: 'Zapisz treść metki',
    tagSaving: 'Zapisywanie…',
    tagSaved: 'Treść metki zapisana',
    tagSaveFailed: 'Nie udało się zapisać treści metki',
    tagCompositionKept: (line) => `Zapisany skład pozostaje bez zmian: ${line}`,
    addTitle: 'Dodaj kolor / rozmiar',
    profileTitle: 'Karta modelu',
    image: 'Zdjęcie',
    imagePick: 'Dodaj zdjęcie',
    imageChange: 'Zmień zdjęcie',
    imageBadType: 'Tylko JPG, PNG lub WEBP',
    imageUploading: (done, total) => `Wysyłanie zdjęcia… ${done}/${total}`,
    imageDone: (done, total) => (done === total ? 'Zdjęcie dodane do modelu' : `Zdjęcie dodano do ${done}/${total} wierszy`),
    imageFailed: 'Nie udało się dodać zdjęcia',
    profileName: 'Nazwa modelu',
    profileNameHint: 'Zmiana nazwy tutaj zmienia też nazwy wierszy kolor/rozmiar',
    rename: 'Zmień nazwę',
    renameSave: 'Zapisz nazwę',
    renameCancel: 'Anuluj',
    renaming: 'Zmiana nazwy…',
    renamed: (name) => `Zmieniono nazwę fasonu na „${name}” — wiersze kolor/rozmiar idą za nią`,
    renameFailed: (reason) => `Nie udało się zmienić nazwy: ${reason}`,
    renameUnsupported: 'Serwer nie obsługuje jeszcze zmiany nazwy fasonu z tej kasy — zmień w panelu web',
    profileCode: 'Kod modelu',
    profileCategory: 'Kategoria',
    profileCategoryNone: '— Brak kategorii —',
    categoryMoved: (name) => `Przeniesiono do kategorii ${name}`,
    categoryMoveFailed: (reason) => `Nie udało się zmienić kategorii: ${reason}`,
    profilePrice: 'Cena brutto (zł)',
    priceMixed: 'wiersze mają różne ceny',
    priceApply: 'Zastosuj do całego fasonu',
    priceApplying: 'Zmiana ceny…',
    priceApplied: (rows) => `Zmieniono cenę ${rows} wierszy`,
    priceFailed: (reason) => `Nie udało się zmienić ceny: ${reason}`,
    hide: 'Ukryj',
    hideConfirm: 'Ukryć ten wiersz?',
    hideCancel: 'Anuluj',
    hideDone: (colorName, sizeName) => `Ukryto ${[colorName, sizeName].filter(Boolean).join(' / ')}`,
    hideFailed: (reason) => `Nie udało się ukryć: ${reason}`,
    addColor: 'Kolor',
    addSize: 'Rozmiar',
    addButton: 'Dodaj do tego modelu',
    addSaving: 'Dodawanie…',
    addDone: (colorName, sizeName) =>
      `Dodano ${[colorName, sizeName].filter(Boolean).join(' / ')}`,
    addFailed: (reason) => `Nie udało się dodać: ${reason}`,
    addProblem: {
      NO_COLOR_OR_SIZE: 'Najpierw wpisz kolor albo rozmiar',
      ALREADY_EXISTS: 'Ten model ma już taki kolor i rozmiar',
    },
    problem: {
      NOTHING_SELECTED: 'Żaden wiersz nie ma ilości',
      NO_LANE: 'Nie wybrano etykiet ani metek',
      NO_STICKER_QTY: 'Brak liczby etykiet na worek dla wybranego koloru',
      TOO_MANY: 'Za dużo sztuk na jeden druk',
    },
  },
  en: {
    variants: 'Colours and sizes on file',
    color: 'Colour',
    size: 'Size',
    quantity: 'Quantity',
    lanes: 'What to print',
    stickers: 'Bag labels',
    stickerCounts: 'Bag labels per colour (one per stack packed)',
    fabricTags: 'Fabric tags',
    noTagContent:
      'This style has no care content on the machine — only bag labels can print. Use “Edit tag content” below to fill it in.',
    totals: (stickers, fabricTags) => `${stickers} bag labels · ${fabricTags} fabric tags`,
    print: (labels) => (labels > 0 ? `Print ${labels} labels` : 'Print'),
    confirm: (labels) => `Press again to print ${labels} labels`,
    printing: 'Printing…',
    stop: 'Stop',
    stopping: 'Stopping…',
    done: (labels) => `Printed ${labels} labels`,
    stopped: (done, total) => `Stopped — ${done}/${total} printed`,
    failed: (reason) => `Printer error: ${reason}`,
    clear: 'Clear quantities',
    tagEdit: 'Fabric tag content',
    tagEditOpen: 'Edit tag content',
    tagEditClose: 'Close',
    tagBrand: 'Brand printed on the tag',
    tagSave: 'Save tag content',
    tagSaving: 'Saving…',
    tagSaved: 'Fabric tag content saved',
    tagSaveFailed: 'Could not save the fabric tag content',
    tagCompositionKept: (line) => `Keeping the stored composition line: ${line}`,
    addTitle: 'Add a colour or size',
    profileTitle: 'Style profile',
    image: 'Photo',
    imagePick: 'Set photo',
    imageChange: 'Change photo',
    imageBadType: 'JPG, PNG or WEBP only',
    imageUploading: (done, total) => `Attaching photo… ${done}/${total}`,
    imageDone: (done, total) => (done === total ? 'Photo set on the style' : `Photo attached to ${done}/${total} rows`),
    imageFailed: 'Could not attach the photo',
    profileName: 'Style name',
    profileNameHint: 'Renaming here renames every colour/size row too',
    rename: 'Rename',
    renameSave: 'Save name',
    renameCancel: 'Cancel',
    renaming: 'Renaming…',
    renamed: (name) => `Style renamed to “${name}” — every colour/size row follows`,
    renameFailed: (reason) => `Could not rename: ${reason}`,
    renameUnsupported: 'The server does not support renaming a style from this till yet — rename on the web dashboard',
    profileCode: 'Style code',
    profileCategory: 'Category',
    profileCategoryNone: '— No category —',
    categoryMoved: (name) => `Moved to ${name}`,
    categoryMoveFailed: (reason) => `Could not move the category: ${reason}`,
    profilePrice: 'Gross price (zł)',
    priceMixed: 'rows differ',
    priceApply: 'Apply to the whole style',
    priceApplying: 'Changing the price…',
    priceApplied: (rows) => `Price changed on ${rows} rows`,
    priceFailed: (reason) => `Could not change the price: ${reason}`,
    hide: 'Hide',
    hideConfirm: 'Hide this row?',
    hideCancel: 'Keep',
    hideDone: (colorName, sizeName) => `Hidden ${[colorName, sizeName].filter(Boolean).join(' / ')}`,
    hideFailed: (reason) => `Could not hide: ${reason}`,
    addColor: 'Colour',
    addSize: 'Size',
    addButton: 'Add to this style',
    addSaving: 'Adding…',
    addDone: (colorName, sizeName) =>
      `Added ${[colorName, sizeName].filter(Boolean).join(' / ')}`,
    addFailed: (reason) => `Could not add it: ${reason}`,
    addProblem: {
      NO_COLOR_OR_SIZE: 'Type a colour or a size first',
      ALREADY_EXISTS: 'This style already has that colour and size',
    },
    problem: {
      NOTHING_SELECTED: 'No row has a quantity',
      NO_LANE: 'Neither bag labels nor fabric tags are selected',
      NO_STICKER_QTY: 'A chosen colour has no bag label count',
      TOO_MANY: 'Too many labels for one run',
    },
  },
};

/**
 * Past this many labels the button asks a second time.
 *
 * The quantities are typed by hand beside a printer that obeys them, and a
 * reprint is normally a handful. A run in the hundreds is the order sheet's
 * job; here it is more likely a stray keystroke.
 */
const CONFIRM_THRESHOLD = 50;

const INPUT =
  'h-10 w-20 rounded-md border border-slate-200 text-center text-base font-extrabold outline-none focus:ring-2 focus:ring-emerald-200';

/**
 * One idempotency key per cell per attempt.
 *
 * Held across retries of the same cell so an answer lost on the way back adds
 * the colour once, and rebuilt for a different cell so two adds never look like
 * one replay to the server.
 */
function nextAddKey(templateId: string, cell: { colorName: string; sizeName: string }): string {
  return `add-${templateId}-${cell.colorName}-${cell.sizeName}-${Date.now().toString(36)}`.slice(
    0,
    100,
  );
}

/** Sizes in the order the shop says them, not the order the alphabet does. */
function sizeRank(label: string): number {
  const index = SIZE_SUGGESTIONS.indexOf(label.trim().toUpperCase() as never);
  return index === -1 ? SIZE_SUGGESTIONS.length : index;
}

export function sortStyleVariants(variants: readonly StyleVariant[]): StyleVariant[] {
  return [...variants].sort((a, b) => {
    const colorA = (a.color_name || '').trim();
    const colorB = (b.color_name || '').trim();
    if (colorA !== colorB) return colorA.localeCompare(colorB, 'pl');
    const sizeA = (a.size_name || '').trim();
    const sizeB = (b.size_name || '').trim();
    const rank = sizeRank(sizeA) - sizeRank(sizeB);
    if (rank !== 0) return rank;
    return sizeA.localeCompare(sizeB, 'pl');
  });
}

type Status =
  | { type: 'idle' }
  | { type: 'printing'; message: string }
  | { type: 'success'; message: string }
  | { type: 'warning'; message: string }
  | { type: 'error'; message: string };

export default function StyleReprintPanel({
  language,
  templateId,
  styleName,
  styleCode,
  variants,
  categoryId = null,
  categories = [],
  onPrintingChange,
  onCatalogChanged,
}: Props) {
  const copy = COPY[language] || COPY.vi;
  const [quantities, setQuantities] = useState<Record<string, number>>({});
  const [printStickers, setPrintStickers] = useState(true);
  const [printFabricTags, setPrintFabricTags] = useState(true);
  const [stickerQuantities, setStickerQuantities] = useState<Record<string, number>>({});
  const clearQuantities = () => {
    setQuantities({});
    setStickerQuantities({});
  };
  const [tag, setTag] = useState<FabricTagTemplate | null>(null);
  const [tagLoaded, setTagLoaded] = useState(false);
  const [status, setStatus] = useState<Status>({ type: 'idle' });
  const [running, setRunning] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const stopRef = useRef(false);
  const [stopping, setStopping] = useState(false);

  const rows = useMemo(() => sortStyleVariants(variants), [variants]);

  // A style change must not carry the previous one's numbers: the boxes are the
  // only record of what is about to come out of the printer.
  useEffect(() => {
    clearQuantities();
    setStatus({ type: 'idle' });
    setConfirming(false);
  }, [templateId]);

  useEffect(() => {
    let cancelled = false;
    setTag(null);
    setTagLoaded(false);
    const bridge = (window as any).electronAPI?.pos?.fabricTagTemplates;
    if (!bridge?.get || !templateId) {
      setTagLoaded(true);
      return () => {
        cancelled = true;
      };
    }
    // Wrapped rather than chained directly: an older preload — or a harness
    // standing in for one — returns undefined here, and calling `.then` on that
    // throws inside a mount effect, which takes the whole tab down instead of
    // costing one fabric tag.
    Promise.resolve()
      .then(() => bridge.get(templateId))
      .then((row: FabricTagTemplate | null | undefined) => {
        if (cancelled) return;
        setTag(row ?? null);
        setTagLoaded(true);
      })
      .catch((err: unknown) => {
        rlog.error('[StyleReprintPanel] Failed to read fabric tag content:', err);
        if (cancelled) return;
        setTag(null);
        setTagLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, [templateId]);

  // Editing the tag in place. The draft is seeded from the saved row so a
  // correction starts from what the machine would print, not from blank.
  const [editing, setEditing] = useState(false);
  const [brandDraft, setBrandDraft] = useState('');
  const [contentDraft, setContentDraft] = useState<FabricTagContent>({
    materials: [],
    careSymbols: [],
    careText: '',
  });
  const [saving, setSaving] = useState(false);

  // Adding a colour or size to this style.
  const [colorDraft, setColorDraft] = useState('');
  const [sizeDraft, setSizeDraft] = useState('');
  const [adding, setAdding] = useState(false);
  const [movingCategory, setMovingCategory] = useState(false);
  const [priceText, setPriceText] = useState('');
  const [renameText, setRenameText] = useState<string | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [applyingPrice, setApplyingPrice] = useState(false);
  /** The row whose Hide button was pressed once; the second press is the act. */
  const [hideArmedId, setHideArmedId] = useState<string | null>(null);
  const [hiding, setHiding] = useState(false);
  const [uploadingImage, setUploadingImage] = useState(false);
  const imageInputRef = useRef<HTMLInputElement | null>(null);
  /** The picture the tab shows for this style: whichever row carries one. */
  const styleImage = rows.map((row) => row.thumbnail_url || row.image_url).find(Boolean) ?? null;

  /**
   * One picture for the whole style, put on every row, because the tab reads
   * the picture off the row it happens to be showing.
   */
  const handlePickImage = async (file: File | undefined) => {
    if (!file || uploadingImage) return;
    const picked = await readImageFile(file, CATALOG_IMAGE_MAX_PX);
    if (!picked) {
      setStatus({ type: 'error', message: copy.imageBadType });
      return;
    }
    setUploadingImage(true);
    setStatus({ type: 'printing', message: copy.imageUploading(0, rows.length) });
    try {
      const outcome = await uploadImageToVariants(rows.map((row) => row.id), picked);
      if (outcome.uploaded.length === 0) {
        setStatus({ type: 'error', message: copy.imageFailed });
        return;
      }
      setStatus({
        type: outcome.failed.length === 0 ? 'success' : 'warning',
        message: copy.imageDone(outcome.uploaded.length, rows.length),
      });
      await onCatalogChanged?.();
    } finally {
      setUploadingImage(false);
    }
  };

  useEffect(() => {
    setHideArmedId(null);
  }, [templateId]);

  /**
   * Move the whole style to another category. Written through one of its rows
   * because that is the endpoint there is; the server keeps the category on
   * the template, so every row follows.
   */
  const handleMoveCategory = async (nextId: string) => {
    const target = categories.find((category) => category.id === nextId);
    const anchor = rows[0];
    if (!target || !anchor || movingCategory || target.id === categoryId) return;
    setMovingCategory(true);
    try {
      const bridge = (window as any).electronAPI?.pos?.productAdmin;
      const result = await Promise.resolve().then(() =>
        bridge?.updateVariant?.(anchor.id, { categoryId: target.id }),
      );
      if (!result?.ok) {
        setStatus({
          type: 'error',
          message: copy.categoryMoveFailed(result?.error || result?.code || '?'),
        });
        return;
      }
      setStatus({ type: 'success', message: copy.categoryMoved(target.name) });
      await onCatalogChanged?.();
    } catch (err) {
      rlog.error('[StyleReprintPanel] Failed to move the style to a category:', err);
      setStatus({ type: 'error', message: copy.categoryMoveFailed(String(err)) });
    } finally {
      setMovingCategory(false);
    }
  };

  useEffect(() => {
    setRenameText(null);
  }, [templateId]);

  /**
   * Open the rename box, once the server says it can rename a style. Asked at
   * the press rather than on mount: the tab must open offline, and an old
   * server would rename one row alone and leave the style split in two.
   */
  const handleStartRename = async () => {
    if (renaming || running || rows.length === 0) return;
    setRenaming(true);
    try {
      const bridge = (window as any).electronAPI?.pos?.productAdmin;
      const response = await Promise.resolve().then(() => bridge?.getCapabilities?.());
      if (!response?.ok || response.capabilities?.supportsStyleRename !== true) {
        setStatus({ type: 'error', message: copy.renameUnsupported });
        return;
      }
      setRenameText(styleName);
    } catch (err) {
      rlog.error('[StyleReprintPanel] Could not read product-admin capabilities:', err);
      setStatus({ type: 'error', message: copy.renameUnsupported });
    } finally {
      setRenaming(false);
    }
  };

  /**
   * Rename the style: the template and every colour/size row, in one server
   * write through any one of its rows. `styleName`, not `name` — `name` would
   * rename that single row and nothing else.
   */
  const handleRename = async () => {
    const next = (renameText ?? '').trim();
    const anchor = rows[0];
    if (!next || !anchor || renaming || running || next === styleName.trim()) return;
    setRenaming(true);
    try {
      const bridge = (window as any).electronAPI?.pos?.productAdmin;
      const result = await Promise.resolve().then(() =>
        bridge?.updateVariant?.(anchor.id, { styleName: next }),
      );
      if (!result?.ok) {
        setStatus({ type: 'error', message: copy.renameFailed(result?.error || result?.code || '?') });
        return;
      }
      setRenameText(null);
      setStatus({ type: 'success', message: copy.renamed(next) });
      await onCatalogChanged?.();
    } catch (err) {
      rlog.error('[StyleReprintPanel] Failed to rename the style:', err);
      setStatus({ type: 'error', message: copy.renameFailed(String(err)) });
    } finally {
      setRenaming(false);
    }
  };

  /** The one price the style sells at, or null when its rows disagree. */
  const stylePriceGrosze = useMemo(() => {
    const prices = new Set(rows.map((row) => Math.max(0, Math.floor(Number(row.retail_price) || 0))));
    return prices.size === 1 ? [...prices][0] : null;
  }, [rows]);
  useEffect(() => {
    setPriceText(stylePriceGrosze === null ? '' : groszeToText(stylePriceGrosze));
  }, [stylePriceGrosze, templateId]);

  /**
   * One price for every row of the style. The server keeps the price on the
   * row, so this is one PATCH per row that does not already carry it; a row
   * that fails stops the run and is named, and the rows before it keep the
   * new price — the catalogue pull afterwards shows exactly what happened.
   */
  const handleApplyPrice = async () => {
    const grosze = textToGrosze(priceText);
    if (grosze < 1 || applyingPrice || running) return;
    const targets = rows.filter((row) => Math.floor(Number(row.retail_price) || 0) !== grosze);
    if (targets.length === 0) return;
    setApplyingPrice(true);
    let changed = 0;
    try {
      const bridge = (window as any).electronAPI?.pos?.productAdmin;
      for (const row of targets) {
        const result = await Promise.resolve().then(() =>
          bridge?.updateVariant?.(row.id, { priceGrossGrosze: grosze }),
        );
        if (!result?.ok) {
          setStatus({
            type: 'error',
            message: copy.priceFailed(`${row.name}: ${result?.error || result?.code || '?'}`),
          });
          return;
        }
        changed += 1;
      }
      setStatus({ type: 'success', message: copy.priceApplied(changed) });
    } catch (err) {
      rlog.error('[StyleReprintPanel] Failed to change the price of a style:', err);
      setStatus({ type: 'error', message: copy.priceFailed(String(err)) });
    } finally {
      setApplyingPrice(false);
      if (changed > 0) await onCatalogChanged?.();
    }
  };

  /**
   * Hide one colour/size row. Deactivated on the server rather than deleted:
   * tags may already have been printed for it, and a sale may reference it.
   * Two presses, because the row sits next to a quantity box and a slip here
   * would take a colour off the till.
   */
  const handleHide = async (variant: StyleVariant) => {
    if (hiding) return;
    setHiding(true);
    try {
      const bridge = (window as any).electronAPI?.pos?.productAdmin;
      const result = await Promise.resolve().then(() =>
        bridge?.deactivateVariant?.(variant.id, { reason: 'Hidden from the label tab' }),
      );
      if (!result?.ok) {
        setStatus({ type: 'error', message: copy.hideFailed(result?.error || result?.code || '?') });
        return;
      }
      setHideArmedId(null);
      setStatus({
        type: 'success',
        message: copy.hideDone((variant.color_name || '').trim(), (variant.size_name || '').trim()),
      });
      await onCatalogChanged?.();
    } catch (err) {
      rlog.error('[StyleReprintPanel] Failed to hide a row:', err);
      setStatus({ type: 'error', message: copy.hideFailed(String(err)) });
    } finally {
      setHiding(false);
    }
  };
  const addKeyRef = useRef<string | null>(null);

  /**
   * The price a new row takes. Sibling rows of one style cost the same, and the
   * workshop's styles all sit at 0, so reading it off the rows on screen is
   * both correct for a shop that sells and correct for one that does not.
   */
  const siblingPriceGrosze = useMemo(
    () => Math.max(0, Math.floor(Number(rows[0]?.retail_price) || 0)),
    [rows],
  );

  /**
   * The composition line a row was saved with, when its parts could not be
   * recovered from it. Shown as-is and kept on save: a line someone wrote by
   * hand outranks anything this could infer.
   */
  const keptComposition = useMemo(() => {
    const line = (tag?.composition ?? '').trim();
    if (!line) return '';
    if (tag?.materials?.length) return '';
    return parseCompositionText(line).length > 0 ? '' : line;
  }, [tag]);

  const seedDraft = useCallback(() => {
    setBrandDraft(tag?.brandName ?? '');
    setContentDraft({
      // Rows written before the parts were stored carry only the finished line;
      // reading it back is exact for lines this app produced and gives up
      // rather than guessing at anything else.
      materials: tag?.materials?.length
        ? tag.materials.map((material) => ({ ...material }))
        : parseCompositionText(tag?.composition ?? ''),
      careSymbols: [...(tag?.careSymbols ?? [])],
      careText: tag?.careText ?? '',
    });
  }, [tag]);

  // A style change closes the editor: a half-typed correction belongs to the
  // style it was typed against, and carrying it across would save it onto
  // another garment.
  useEffect(() => {
    setEditing(false);
    setSaving(false);
    setColorDraft('');
    setSizeDraft('');
    addKeyRef.current = null;
  }, [templateId]);

  const hasTagContent = !!tag;
  // Without saved care content there is nothing to put on a fabric tag, so the
  // lane is switched off rather than printing a blank one.
  const fabricLaneOn = printFabricTags && hasTagContent;

  const selection: SelectionInput = useMemo(
    () => ({
      styleName,
      styleCode,
      customerName: tag?.brandName ?? '',
      careSymbols: tag?.careSymbols ?? [],
      careText: tag?.careText ?? '',
      composition: tag?.composition ?? '',
      // The catalogue row spells these `color_name`/`size_name`; the selection
      // speaks the order sheet's language. Handing the rows over untranslated
      // prints a bag label with no colour on it.
      variants: rows.map((variant) => ({
        id: variant.id,
        colorName: variant.color_name ?? null,
        sizeName: variant.size_name ?? null,
      })),
      quantities,
      stickerQuantities,
      printStickers,
      printFabricTags: fabricLaneOn,
    }),
    [fabricLaneOn, printStickers, quantities, rows, stickerQuantities, styleCode, styleName, tag],
  );

  const totals = selectionTotals(selection);
  const problems = selectionProblems(selection);
  const canPrint = problems.length === 0 && !running;

  useEffect(() => {
    // A number typed after the confirm prompt changes what would print, so the
    // second press must mean the new total, not the one already asked about.
    setConfirming(false);
  }, [totals.total]);

  const setStickerQuantity = (colour: string, raw: string) => {
    const next = selectionQuantity(raw);
    setStickerQuantities((current) => {
      if (next <= 0) {
        if (!(colour in current)) return current;
        const { [colour]: _dropped, ...rest } = current;
        return rest;
      }
      return { ...current, [colour]: next };
    });
  };

  const setQuantity = (variantId: string, raw: string) => {
    const next = selectionQuantity(raw);
    setQuantities((current) => {
      if (next <= 0) {
        if (!(variantId in current)) return current;
        const { [variantId]: _dropped, ...rest } = current;
        return rest;
      }
      return { ...current, [variantId]: next };
    });
  };

  const report = useCallback(
    (printing: boolean) => {
      onPrintingChange?.(printing);
    },
    [onPrintingChange],
  );

  const run = async (order: LabelPrintOrder) => {
    const api = (window as any).electronAPI;
    if (!api?.printPackagingSticker || !api?.printFabricTag) {
      setStatus({ type: 'error', message: copy.failed('printer bridge missing') });
      return;
    }
    const plan = buildPrintPlan(order, { composition: tag?.composition ?? '' });
    stopRef.current = false;
    setStopping(false);
    setRunning(true);
    report(true);
    try {
      const result = await runPrintPlan(
        plan,
        {
          customerName: order.customerName,
          styleName: stickerGarmentType(
            categories.find((category) => category.id === categoryId)?.name,
            order.styleName,
          ),
          styleCode: order.styleCode,
        },
        {
          printSticker: (request) => api.printPackagingSticker(request),
          printFabricTag: (request) => api.printFabricTag(request),
        },
        {
          onProgress: (progress: PrintProgress) => {
            if (progress.type !== 'printing') return;
            setStatus({
              type: 'printing',
              message: `${copy.printing} ${progress.printedCopies}/${progress.totalCopies}`,
            });
          },
          shouldStop: () => stopRef.current,
        },
      );
      if (result.type === 'success') {
        setStatus({ type: 'success', message: copy.done(result.printedCopies) });
        // The numbers are cleared only on a clean finish: after a stop or a jam
        // the operator needs to see what was asked for to work out what is left.
        clearQuantities();
        return;
      }
      if (result.type === 'stopped') {
        setStatus({
          type: 'warning',
          message: copy.stopped(result.printedCopies, totals.total),
        });
        return;
      }
      setStatus({ type: 'error', message: copy.failed(result.message || '?') });
    } catch (err) {
      setStatus({
        type: 'error',
        message: copy.failed(err instanceof Error ? err.message : String(err)),
      });
    } finally {
      setRunning(false);
      setStopping(false);
      stopRef.current = false;
      report(false);
    }
  };

  const handlePrint = () => {
    if (!canPrint) return;
    if (totals.total > CONFIRM_THRESHOLD && !confirming) {
      setConfirming(true);
      return;
    }
    setConfirming(false);
    void run(buildSelectionOrder(selection));
  };

  const handleStop = () => {
    if (!running) return;
    stopRef.current = true;
    setStopping(true);
  };

  const addProblems = validateAddedCell(
    { colorName: colorDraft, sizeName: sizeDraft },
    rows.map((row) => ({ colorName: row.color_name, sizeName: row.size_name })),
  );
  const canAdd = addProblems.length === 0 && !adding && !running;

  const handleAddCell = async () => {
    if (!canAdd) return;
    setAdding(true);
    const cell = { colorName: colorDraft.trim(), sizeName: sizeDraft.trim() };
    const variant = buildAddedVariant(styleCode, cell, rows.map((row) => row.sku));
    try {
      const bridge = (window as any).electronAPI?.pos?.productAdmin;
      const result = await Promise.resolve().then(() =>
        bridge?.createProduct?.({
          productId: templateId,
          name: styleName,
          sku: styleCode || null,
          // The rows the style already has set the price; a new colour of a
          // style the till sells must not ring up at a different number.
          priceGrossGrosze: siblingPriceGrosze,
          // Sewn to order: no count is kept for any row of a workshop style.
          trackInventory: false,
          vatRate: 23,
          // One key per attempt, kept across retries of the same cell: a
          // network answer lost on the way back must not add the colour twice.
          idempotencyKey: (addKeyRef.current ??= nextAddKey(templateId, cell)),
          variants: [
            {
              colorName: variant.colorName,
              sizeName: variant.sizeName,
              sku: variant.sku,
              // Same rule the sheet uses: the SKU reads as the goods and is
              // already unique per cell, so it is the barcode too.
              barcode: variant.sku,
              initialStockQty: 0,
            },
          ],
        }),
      );
      if (!result?.ok) {
        setStatus({
          type: 'error',
          message: copy.addFailed(result?.error || result?.code || '?'),
        });
        return;
      }
      addKeyRef.current = null;
      setColorDraft('');
      setSizeDraft('');
      setStatus({ type: 'success', message: copy.addDone(cell.colorName, cell.sizeName) });
      // The row exists on the server now; it reaches this list through a sync.
      await onCatalogChanged?.();
    } catch (err) {
      rlog.error('[StyleReprintPanel] Failed to add a colour or size:', err);
      setStatus({ type: 'error', message: copy.addFailed(String(err)) });
    } finally {
      setAdding(false);
    }
  };

  const openEditor = () => {
    seedDraft();
    setEditing(true);
  };

  const handleSaveTag = async () => {
    if (saving) return;
    setSaving(true);
    const line = compositionText(contentDraft.materials);
    const next: FabricTagTemplate = {
      templateId,
      brandName: brandDraft.trim() || null,
      logoDataUrl: tag?.logoDataUrl ?? null,
      // A composition typed here wins. With nothing typed, a line that could
      // not be taken apart is kept exactly as saved rather than cleared by an
      // edit that was never about the composition.
      composition: line || keptComposition || null,
      careSymbols: [...contentDraft.careSymbols],
      careText: contentDraft.careText.trim() || null,
      materials: contentDraft.materials.map((material) => ({ ...material })),
      fabric: tag?.fabric ?? null,
      layout: tag?.layout ?? 'default',
    };
    try {
      const bridge = (window as any).electronAPI?.pos?.fabricTagTemplates;
      const saved = await Promise.resolve().then(() => bridge?.save?.(next));
      if (!saved) throw new Error('fabric tag template save returned nothing');
      setTag(saved as FabricTagTemplate);
      setEditing(false);
      setStatus({ type: 'success', message: copy.tagSaved });
    } catch (err) {
      rlog.error('[StyleReprintPanel] Failed to save fabric tag content:', err);
      // The editor stays open with the typed content: a correction the operator
      // has just typed must not vanish because a write failed.
      setStatus({ type: 'error', message: copy.tagSaveFailed });
    } finally {
      setSaving(false);
    }
  };

  const statusText =
    status.type === 'idle'
      ? problems.length > 0
        ? copy.problem[problems[0]]
        : copy.totals(totals.stickers, totals.fabricTags)
      : status.message;

  return (
    <div className="space-y-3" data-testid="style-reprint">
      <div
        className={`inline-flex w-full items-center gap-2 rounded-lg border px-3 py-2 text-sm font-bold ${
          status.type === 'success'
            ? 'border-emerald-200 bg-emerald-50 text-emerald-800'
            : status.type === 'printing'
              ? 'border-sky-200 bg-sky-50 text-sky-800'
              : status.type === 'warning' || status.type === 'error'
                ? 'border-amber-200 bg-amber-50 text-amber-800'
                : 'border-slate-200 bg-slate-50 text-slate-700'
        }`}
        data-testid="reprint-status"
      >
        {status.type === 'success' ? (
          <CheckCircle2 size={17} />
        ) : status.type === 'printing' ? (
          <RefreshCw size={17} className="animate-spin" />
        ) : status.type === 'warning' || status.type === 'error' ? (
          <AlertTriangle size={17} />
        ) : (
          <Printer size={17} />
        )}
        <span>{statusText}</span>
      </div>

      {tagLoaded && !hasTagContent && (
        <div
          className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs font-bold text-amber-800"
          data-testid="reprint-no-tag"
        >
          {copy.noTagContent}
        </div>
      )}

      <section className="rounded-lg border border-slate-200 px-3 py-2" data-testid="style-profile">
        <div className="mb-2 text-xs font-extrabold uppercase tracking-wide text-slate-400">
          {copy.profileTitle}
        </div>
        <dl className="grid gap-x-4 gap-y-1 text-sm sm:grid-cols-[auto_1fr]">
          <dt className="self-center font-bold text-slate-500">{copy.image}</dt>
          <dd className="flex items-center gap-2">
            {styleImage && (
              <img
                src={styleImage}
                alt=""
                data-testid="style-image-preview"
                className="h-12 w-12 rounded-md border border-slate-200 object-cover"
              />
            )}
            <input
              ref={imageInputRef}
              type="file"
              accept={IMAGE_ACCEPT}
              data-testid="style-image"
              className="hidden"
              onChange={(e) => {
                void handlePickImage(e.target.files?.[0]);
                e.target.value = '';
              }}
            />
            <button
              type="button"
              data-testid="style-image-pick"
              disabled={uploadingImage || running || rows.length === 0}
              onClick={() => imageInputRef.current?.click()}
              className="rounded-md border border-slate-200 px-2 py-1 text-[11px] font-extrabold text-slate-600 hover:bg-slate-50 disabled:opacity-40"
            >
              {styleImage ? copy.imageChange : copy.imagePick}
            </button>
          </dd>
          <dt className="font-bold text-slate-500">{copy.profileName}</dt>
          <dd className="font-bold text-slate-800">
            {renameText === null ? (
              <>
                <span data-testid="profile-name">{styleName}</span>
                <button
                  type="button"
                  data-testid="style-rename"
                  disabled={renaming || running || rows.length === 0}
                  onClick={() => void handleStartRename()}
                  className="ml-2 rounded-md border border-slate-200 px-2 py-1 text-[11px] font-extrabold text-slate-600 hover:bg-slate-50 disabled:opacity-40"
                >
                  {copy.rename}
                </button>
              </>
            ) : (
              <form
                className="flex flex-wrap items-center gap-2"
                onSubmit={(e) => { e.preventDefault(); void handleRename(); }}
              >
                <input
                  className="h-9 min-w-[16rem] flex-1 rounded-md border border-slate-300 px-2 text-sm font-bold text-slate-800"
                  data-testid="style-rename-input"
                  aria-label={copy.profileName}
                  value={renameText}
                  autoFocus
                  disabled={renaming}
                  onChange={(e) => setRenameText(e.target.value)}
                />
                <button
                  type="submit"
                  data-testid="style-rename-save"
                  disabled={renaming || !renameText.trim() || renameText.trim() === styleName.trim()}
                  className="rounded-md bg-emerald-600 px-2 py-1 text-[11px] font-extrabold text-white hover:bg-emerald-700 disabled:opacity-40"
                >
                  {renaming ? copy.renaming : copy.renameSave}
                </button>
                <button
                  type="button"
                  data-testid="style-rename-cancel"
                  disabled={renaming}
                  onClick={() => setRenameText(null)}
                  className="rounded-md border border-slate-200 px-2 py-1 text-[11px] font-extrabold text-slate-600 hover:bg-slate-50"
                >
                  {copy.renameCancel}
                </button>
                <span className="basis-full text-[11px] font-semibold text-slate-400">{copy.profileNameHint}</span>
              </form>
            )}
          </dd>
          <dt className="font-bold text-slate-500">{copy.profileCode}</dt>
          <dd className="font-bold text-slate-800" data-testid="profile-code">{styleCode || '—'}</dd>
          <dt className="self-center font-bold text-slate-500">{copy.profileCategory}</dt>
          <dd>
            <select
              className="h-9 w-full rounded-md border border-slate-300 bg-white px-2 text-sm font-bold text-slate-700"
              data-testid="style-category"
              aria-label={copy.profileCategory}
              value={categoryId ?? ''}
              disabled={movingCategory || running || rows.length === 0}
              onChange={(e) => void handleMoveCategory(e.target.value)}
            >
              <option value="">{copy.profileCategoryNone}</option>
              {categories.map((category) => (
                <option key={category.id} value={category.id}>{category.name}</option>
              ))}
            </select>
          </dd>
          <dt className="self-center font-bold text-slate-500">{copy.profilePrice}</dt>
          <dd className="flex flex-wrap items-center gap-2">
            <input
              className="h-9 w-28 rounded-md border border-slate-300 px-2 text-sm font-bold text-slate-800"
              data-testid="style-price"
              aria-label={copy.profilePrice}
              inputMode="decimal"
              value={priceText}
              placeholder={stylePriceGrosze === null ? copy.priceMixed : '129,00'}
              disabled={applyingPrice || running || rows.length === 0}
              onChange={(e) => setPriceText(e.target.value)}
              onBlur={() => { if (textToGrosze(priceText) > 0) setPriceText(groszeToText(textToGrosze(priceText))); }}
            />
            {stylePriceGrosze === null && (
              <span className="text-[11px] font-semibold text-amber-700" data-testid="style-price-mixed">
                {copy.priceMixed}
              </span>
            )}
            <button
              type="button"
              data-testid="style-price-apply"
              disabled={
                applyingPrice || running || rows.length === 0
                || textToGrosze(priceText) < 1
                || textToGrosze(priceText) === stylePriceGrosze
              }
              onClick={() => void handleApplyPrice()}
              className="rounded-md border border-slate-200 px-2 py-1 text-[11px] font-extrabold text-slate-600 hover:bg-slate-50 disabled:opacity-40"
            >
              {applyingPrice ? copy.priceApplying : copy.priceApply}
            </button>
          </dd>
        </dl>
      </section>

      <section className="rounded-lg border border-slate-200" data-testid="tag-editor">
        <div className="flex items-center justify-between gap-2 px-3 py-2">
          <div className="text-xs font-extrabold uppercase tracking-wide text-slate-400">
            {copy.tagEdit}
          </div>
          <button
            type="button"
            data-testid="tag-edit-toggle"
            disabled={running}
            onClick={() => (editing ? setEditing(false) : openEditor())}
            className="rounded-md border border-slate-200 px-2 py-1 text-[11px] font-extrabold text-slate-600 hover:bg-slate-50 disabled:opacity-40"
          >
            {editing ? copy.tagEditClose : copy.tagEditOpen}
          </button>
        </div>
        {editing && (
          <div className="border-t border-slate-200 px-3 pt-3">
            <label className="mb-3 block">
              <span className="mb-1 block text-xs font-bold uppercase tracking-wide text-slate-500">
                {copy.tagBrand}
              </span>
              <input
                className="h-10 w-full rounded-md border border-slate-300 px-2.5 text-sm"
                data-testid="tag-brand"
                value={brandDraft}
                disabled={saving}
                onChange={(e) => setBrandDraft(e.target.value)}
              />
            </label>

            <FabricTagFields
              language={language}
              value={contentDraft}
              onChange={(changes) => setContentDraft((current) => ({ ...current, ...changes }))}
              disabled={saving}
            />

            {keptComposition && contentDraft.materials.length === 0 && (
              <p
                className="mb-3 text-xs font-bold text-slate-500"
                data-testid="tag-kept-composition"
              >
                {copy.tagCompositionKept(keptComposition)}
              </p>
            )}

            <button
              type="button"
              data-testid="tag-save"
              onClick={handleSaveTag}
              disabled={saving}
              className="mb-3 h-11 w-full rounded-lg bg-slate-800 text-sm font-black text-white hover:bg-slate-700 disabled:opacity-60"
            >
              {saving ? copy.tagSaving : copy.tagSave}
            </button>
          </div>
        )}
      </section>

      <section className="space-y-2">
        <div className="text-xs font-extrabold uppercase tracking-wide text-slate-400">
          {copy.lanes}
        </div>
        <div className="flex flex-wrap gap-2">
          <label className="inline-flex items-center gap-2 rounded-md border border-slate-200 px-3 py-2 text-sm font-bold text-slate-700">
            <input
              type="checkbox"
              checked={printStickers}
              onChange={(e) => setPrintStickers(e.target.checked)}
              data-testid="lane-stickers"
            />
            {copy.stickers}
          </label>
          <label
            className={`inline-flex items-center gap-2 rounded-md border border-slate-200 px-3 py-2 text-sm font-bold ${
              hasTagContent ? 'text-slate-700' : 'text-slate-400'
            }`}
          >
            <input
              type="checkbox"
              checked={fabricLaneOn}
              disabled={!hasTagContent}
              onChange={(e) => setPrintFabricTags(e.target.checked)}
              data-testid="lane-fabric"
            />
            {copy.fabricTags}
          </label>
        </div>
      </section>

      <section className="space-y-2">
        <div className="flex items-center justify-between gap-2">
          <div className="text-xs font-extrabold uppercase tracking-wide text-slate-400">
            {copy.variants}
          </div>
          {totals.total > 0 && !running && (
            <button
              type="button"
              onClick={() => clearQuantities()}
              className="rounded-md border border-slate-200 px-2 py-1 text-[11px] font-extrabold text-slate-600 hover:bg-slate-50"
            >
              {copy.clear}
            </button>
          )}
        </div>
        <div className="overflow-hidden rounded-lg border border-slate-200">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-[11px] font-extrabold uppercase tracking-wide text-slate-400">
              <tr>
                <th className="px-3 py-2 text-left">{copy.color}</th>
                <th className="px-3 py-2 text-left">{copy.size}</th>
                <th className="px-3 py-2 text-right">{copy.quantity}</th>
                <th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody>
              {rows.map((variant) => (
                <tr key={variant.id} className="border-t border-slate-100">
                  <td className="px-3 py-2 font-bold text-slate-800">
                    {(variant.color_name || '').trim() || '—'}
                  </td>
                  <td className="px-3 py-2 font-bold text-slate-600">
                    {(variant.size_name || '').trim() || '—'}
                  </td>
                  <td className="px-3 py-2 text-right">
                    <input
                      className={INPUT}
                      inputMode="numeric"
                      aria-label={`${(variant.color_name || '').trim()} ${(variant.size_name || '').trim()}`.trim() || variant.name}
                      value={quantities[variant.id] ?? ''}
                      onChange={(e) => setQuantity(variant.id, e.target.value)}
                      disabled={running}
                      placeholder="0"
                    />
                  </td>
                  <td className="px-2 py-2 text-right whitespace-nowrap">
                    {hideArmedId === variant.id ? (
                      <span className="inline-flex items-center gap-1">
                        <span className="text-[11px] font-bold text-red-700">{copy.hideConfirm}</span>
                        <button
                          type="button"
                          data-testid="hide-confirm"
                          disabled={hiding}
                          onClick={() => void handleHide(variant)}
                          className="rounded-md bg-red-600 px-2 py-1 text-[11px] font-extrabold text-white hover:bg-red-700 disabled:opacity-50"
                        >
                          {copy.hide}
                        </button>
                        <button
                          type="button"
                          data-testid="hide-cancel"
                          disabled={hiding}
                          onClick={() => setHideArmedId(null)}
                          className="rounded-md border border-slate-200 px-2 py-1 text-[11px] font-extrabold text-slate-600 hover:bg-slate-50"
                        >
                          {copy.hideCancel}
                        </button>
                      </span>
                    ) : (
                      <button
                        type="button"
                        data-testid="hide-variant"
                        data-variant-id={variant.id}
                        disabled={running || hiding}
                        onClick={() => setHideArmedId(variant.id)}
                        className="rounded-md border border-slate-200 px-2 py-1 text-[11px] font-extrabold text-slate-400 hover:bg-slate-50 hover:text-red-700 disabled:opacity-40"
                      >
                        {copy.hide}
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div
          className="rounded-lg border border-dashed border-slate-300 p-3"
          data-testid="add-variant"
        >
          <div className="mb-2 text-xs font-extrabold uppercase tracking-wide text-slate-400">
            {copy.addTitle}
          </div>
          <div className="flex flex-wrap items-end gap-2">
            <label className="min-w-0 flex-1">
              <span className="mb-1 block text-[11px] font-bold uppercase text-slate-500">
                {copy.addColor}
              </span>
              <input
                className="h-10 w-full rounded-md border border-slate-300 px-2.5 text-sm"
                data-testid="add-color"
                aria-label={copy.addColor}
                value={colorDraft}
                disabled={adding || running}
                onChange={(e) => setColorDraft(e.target.value.toUpperCase())}
              />
            </label>
            <label className="w-28">
              <span className="mb-1 block text-[11px] font-bold uppercase text-slate-500">
                {copy.addSize}
              </span>
              <input
                className="h-10 w-full rounded-md border border-slate-300 px-2.5 text-sm"
                data-testid="add-size"
                aria-label={copy.addSize}
                value={sizeDraft}
                disabled={adding || running}
                onChange={(e) => setSizeDraft(e.target.value.toUpperCase())}
              />
            </label>
            <button
              type="button"
              data-testid="add-submit"
              onClick={handleAddCell}
              disabled={!canAdd}
              title={addProblems.length > 0 ? copy.addProblem[addProblems[0]] : undefined}
              className="h-10 rounded-md border border-slate-300 px-3 text-sm font-extrabold text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {adding ? copy.addSaving : copy.addButton}
            </button>
          </div>
          {addProblems.length > 0 && (colorDraft || sizeDraft) && (
            <p className="mt-1.5 text-xs font-bold text-amber-700" data-testid="add-problem">
              {copy.addProblem[addProblems[0]]}
            </p>
          )}
        </div>
      </section>

      {printStickers && selectionColours(selection).length > 0 && (
        <section className="space-y-2" data-testid="sticker-counts">
          <div className="text-xs font-extrabold uppercase tracking-wide text-slate-400">
            {copy.stickerCounts}
          </div>
          <div className="flex flex-wrap gap-3">
            {selectionColours(selection).map((colour) => (
              <label
                key={colour || '-'}
                className="inline-flex items-center gap-2 rounded-md border border-sky-200 px-3 py-2 text-sm font-bold text-slate-700"
              >
                {colour || '—'}
                <input
                  className={`${INPUT} w-20 text-center`}
                  inputMode="numeric"
                  aria-label={`${copy.stickers} ${colour}`.trim()}
                  value={stickerQuantities[colour] ?? ''}
                  onChange={(e) => setStickerQuantity(colour, e.target.value)}
                  disabled={running}
                  placeholder="0"
                />
              </label>
            ))}
          </div>
        </section>
      )}

      <div className="flex gap-2">
        <button
          type="button"
          onClick={handlePrint}
          disabled={!canPrint}
          data-testid="reprint-print"
          title={problems.length > 0 ? copy.problem[problems[0]] : undefined}
          className={`h-14 flex-1 rounded-lg text-base font-black inline-flex items-center justify-center gap-2 ${
            !canPrint
              ? 'cursor-not-allowed bg-slate-200 text-slate-500'
              : confirming
                ? 'bg-amber-500 text-white hover:bg-amber-600'
                : 'bg-slate-950 text-white hover:bg-black'
          }`}
        >
          {running ? <RefreshCw size={20} className="animate-spin" /> : <Printer size={20} />}
          {running
            ? copy.printing
            : confirming
              ? copy.confirm(totals.total)
              : copy.print(totals.total)}
        </button>
        {running && (
          <button
            type="button"
            onClick={handleStop}
            disabled={stopping}
            data-testid="reprint-stop"
            className="h-14 rounded-lg border border-slate-300 bg-white px-4 text-base font-black text-slate-700 hover:bg-slate-50 disabled:opacity-60 inline-flex items-center gap-2"
          >
            <Square size={18} />
            {stopping ? copy.stopping : copy.stop}
          </button>
        )}
      </div>
    </div>
  );
}
