import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  Archive,
  CheckCircle2,
  Eye,
  FileImage,
  FolderOpen,
  ImagePlus,
  Loader2,
  Printer,
  RefreshCw,
  Search,
} from 'lucide-react';

import {
  FABRIC_TAG_ARTWORK_LIMITS,
  FABRIC_TAG_CONFIRM_THRESHOLD,
  type FabricTagArtwork,
  type FabricTagArtworkPrintRequest,
} from '../../../shared/types';
import type { FabricTagArtworksBridge } from '../../../shared/fabric-tag-artwork-ipc';
import type { Language } from '../../i18n/translations';
import rlog from '../../utils/logger';
import ConfirmActionDialog from '../pos/ConfirmActionDialog';

type LibraryFilter = 'all' | 'ready' | 'needs-conversion';
const PRINT_CHUNK_SIZE = 50;

interface PrintPlanRow {
  artwork: FabricTagArtwork;
  quantity: number;
}

interface PrintProgress {
  type: 'printing' | 'waiting' | 'success' | 'stopped' | 'error';
  completedChunks: number;
  totalChunks: number;
  completedCopies: number;
  totalCopies: number;
  message: string;
}

interface Copy {
  title: string;
  subtitle: string;
  fixedMedia: string;
  fixedMediaHint: string;
  productionPngContract: string;
  unavailableTitle: string;
  unavailableBody: string;
  importTitle: string;
  importHint: string;
  customer: string;
  customerPlaceholder: string;
  orderCode: string;
  orderCodePlaceholder: string;
  variant: string;
  variantPlaceholder: string;
  revision: string;
  chooseFile: string;
  importing: string;
  requiredFields: string;
  libraryTitle: string;
  search: string;
  all: string;
  ready: string;
  needsPng: string;
  loading: string;
  loadError: string;
  retry: string;
  empty: string;
  emptySearch: string;
  source: string;
  production: string;
  noProduction: string;
  geometry: string;
  copies: string;
  selectForPrint: string;
  preview: string;
  attachPng: string;
  attaching: string;
  retire: string;
  retireTitle: string;
  retireBody: string;
  retireConfirm: string;
  cancel: string;
  needsConversionHint: string;
  readyHint: string;
  previewTitle: string;
  noPreviewSelection: string;
  previewLoading: string;
  previewUnavailable: string;
  reviewTitle: string;
  selectedCount: (count: number) => string;
  nothingSelected: string;
  total: string;
  quantityInvalid: string;
  printSelected: string;
  printing: string;
  stopAfterCurrent: string;
  continueNextChunk: string;
  stopNow: string;
  awaitingNextChunk: (done: number, chunks: number) => string;
  progress: (done: number, chunks: number, copies: number, total: number) => string;
  highTitle: string;
  highBody: (count: number) => string;
  confirmPrint: string;
  printed: (count: number) => string;
  stopped: (done: number, total: number) => string;
  printFailed: string;
  noDurableResume: string;
  imported: string;
  productionAttached: string;
  retired: string;
  unknownCustomer: string;
}

const COPY: Partial<Record<Language, Copy>> & { en: Copy; vi: Copy; pl: Copy } = {
  vi: {
    title: 'Mác vải từ file khách',
    subtitle: 'Lưu file gốc, gắn PNG đã chuyển đổi, nhập số lượng rồi in',
    fixedMedia: 'Khổ cố định 20 mm · 203 dpi · không tự co giãn',
    fixedMediaHint: 'Ảnh chỉ được đánh dấu Sẵn sàng khi đúng khổ in. App không kéo giãn hoặc thu nhỏ để vừa mác.',
    productionPngContract: 'PNG sản xuất bắt buộc: rộng đúng 160 px, cao 80–480 px, mỗi mép trái/phải trắng 9 px; vùng in giữa 142 px. Khổ 20 mm ở 203 dpi, không co giãn.',
    unavailableTitle: 'Chưa có kết nối quản lý file mác vải',
    unavailableBody: 'Phần mác vải đang tạm khóa an toàn. Tem mã sản phẩm / EAN vẫn dùng được ở nút phía trên.',
    importTitle: 'Nhận file cho đơn in',
    importHint: 'Nhập thông tin trước, sau đó chọn .btw hoặc .png. Đường dẫn file không được nhập tay.',
    customer: 'Khách hàng',
    customerPlaceholder: 'Ví dụ: MOON',
    orderCode: 'Mã đơn / mã mẫu',
    orderCodePlaceholder: 'Không bắt buộc',
    variant: 'Size / biến thể ghi trên mác',
    variantPlaceholder: 'M, S/M, 44/46, L/XL…',
    revision: 'Phiên bản',
    chooseFile: 'Chọn file .btw hoặc .png',
    importing: 'Đang nhận file…',
    requiredFields: 'Cần nhập khách hàng, size/biến thể và phiên bản hợp lệ.',
    libraryTitle: 'Thư viện file đã nhận',
    search: 'Tìm khách, mã đơn, size hoặc tên file',
    all: 'Tất cả',
    ready: 'Sẵn sàng',
    needsPng: 'Cần PNG in',
    loading: 'Đang tải thư viện…',
    loadError: 'Không tải được thư viện file mác vải.',
    retry: 'Thử lại',
    empty: 'Chưa có file nào. Hãy nhận file đầu tiên ở phía trên.',
    emptySearch: 'Không có file phù hợp bộ lọc.',
    source: 'File gốc',
    production: 'File in',
    noProduction: 'Chưa gắn PNG',
    geometry: 'Kích thước sản xuất',
    copies: 'Số bản',
    selectForPrint: 'Chọn để in',
    preview: 'Xem trước',
    attachPng: 'Gắn PNG in 20 mm',
    attaching: 'Đang gắn…',
    retire: 'Ngừng dùng',
    retireTitle: 'Ngừng dùng file này?',
    retireBody: 'File sẽ biến mất khỏi danh sách in mới. Lịch sử file vẫn được giữ lại.',
    retireConfirm: 'Ngừng dùng',
    cancel: 'Hủy',
    needsConversionHint: '.btw đã được lưu an toàn nhưng chưa thể in. Hãy xuất PNG 20 mm / 203 dpi từ BarTender rồi gắn vào.',
    readyHint: 'PNG sản xuất đã qua kiểm tra khổ và có thể chọn để in.',
    previewTitle: 'Xem trước file sản xuất',
    noPreviewSelection: 'Chọn “Xem trước” ở một dòng để kiểm tra đúng khách, đúng size và đúng phiên bản.',
    previewLoading: 'Đang tải ảnh xem trước…',
    previewUnavailable: 'File này chưa có PNG sản xuất để xem trước.',
    reviewTitle: 'Kiểm tra lệnh in',
    selectedCount: (count) => `${count} dòng đã chọn`,
    nothingSelected: 'Chọn ít nhất một dòng Sẵn sàng và nhập số bản.',
    total: 'Tổng số mác',
    quantityInvalid: 'Mỗi dòng phải có số bản nguyên từ 1 đến 999.',
    printSelected: 'In các dòng đã chọn',
    printing: 'Đang in lần lượt…',
    stopAfterCurrent: 'Dừng sau đợt hiện tại',
    continueNextChunk: 'Tiếp tục đợt kế tiếp',
    stopNow: 'Dừng tại đây',
    awaitingNextChunk: (done, chunks) => `Đã gửi ${done}/${chunks} đợt. Kiểm tra mác vừa in rồi chọn Tiếp tục hoặc Dừng.`,
    progress: (done, chunks, copies, total) => `${done}/${chunks} đợt · ${copies}/${total} mác đã gửi`,
    highTitle: 'Xác nhận số lượng lớn',
    highBody: (count) => `Bạn sắp gửi ${count} mác đến máy in. Hãy kiểm tra lại file, size và số lượng.`,
    confirmPrint: 'Xác nhận in',
    printed: (count) => `Đã gửi đủ ${count} mác đến máy in.`,
    stopped: (done, total) => `Đã dừng sau ${done}/${total} đợt.`,
    printFailed: 'Dừng do lỗi in.',
    noDurableResume: 'Chưa có resume bền vững: nếu app đóng hoặc máy in kẹt, phải kiểm đếm mác thực tế trước khi in lại.',
    imported: 'Đã lưu file gốc vào thư viện.',
    productionAttached: 'Đã gắn PNG sản xuất.',
    retired: 'Đã ngừng dùng file.',
    unknownCustomer: 'Không rõ khách',
  },
  pl: {
    title: 'Metki z pliku klienta',
    subtitle: 'Zapisz plik źródłowy, dołącz gotowy PNG, podaj ilości i drukuj',
    fixedMedia: 'Stała szerokość 20 mm · 203 dpi · bez autoskalowania',
    fixedMediaHint: 'Plik uzyskuje status Gotowy tylko przy poprawnym formacie. Aplikacja nie dopasowuje obrazu do metki.',
    productionPngContract: 'Wymagany PNG produkcyjny: dokładnie 160 px szerokości, 80–480 px wysokości, po 9 px białego marginesu z lewej i prawej; środkowy obszar druku ma 142 px. Format 20 mm przy 203 dpi, bez skalowania.',
    unavailableTitle: 'Brak połączenia z biblioteką metek',
    unavailableBody: 'Druk metek jest bezpiecznie wyłączony. Etykiety produktu / EAN nadal są dostępne powyżej.',
    importTitle: 'Przyjmij plik do zlecenia',
    importHint: 'Najpierw wpisz dane, następnie wybierz .btw lub .png. Nie wpisuj ścieżki ręcznie.',
    customer: 'Klient',
    customerPlaceholder: 'Np. MOON',
    orderCode: 'Numer zlecenia / model',
    orderCodePlaceholder: 'Opcjonalnie',
    variant: 'Rozmiar / wariant na metce',
    variantPlaceholder: 'M, S/M, 44/46, L/XL…',
    revision: 'Wersja',
    chooseFile: 'Wybierz .btw lub .png',
    importing: 'Importowanie…',
    requiredFields: 'Podaj klienta, rozmiar/wariant i prawidłową wersję.',
    libraryTitle: 'Biblioteka plików',
    search: 'Szukaj klienta, zlecenia, rozmiaru lub pliku',
    all: 'Wszystkie',
    ready: 'Gotowe',
    needsPng: 'Wymaga PNG',
    loading: 'Ładowanie biblioteki…',
    loadError: 'Nie udało się wczytać biblioteki metek.',
    retry: 'Spróbuj ponownie',
    empty: 'Brak plików. Dodaj pierwszy plik powyżej.',
    emptySearch: 'Brak plików pasujących do filtra.',
    source: 'Plik źródłowy',
    production: 'Plik do druku',
    noProduction: 'Brak PNG',
    geometry: 'Format produkcyjny',
    copies: 'Kopie',
    selectForPrint: 'Wybierz do druku',
    preview: 'Podgląd',
    attachPng: 'Dołącz PNG 20 mm',
    attaching: 'Dołączanie…',
    retire: 'Wycofaj',
    retireTitle: 'Wycofać ten plik?',
    retireBody: 'Plik zniknie z nowych zleceń druku, ale jego historia zostanie zachowana.',
    retireConfirm: 'Wycofaj',
    cancel: 'Anuluj',
    needsConversionHint: 'Plik .btw jest zapisany, ale nie można go jeszcze drukować. Wyeksportuj PNG 20 mm / 203 dpi w BarTender i dołącz go.',
    readyHint: 'Produkcyjny PNG przeszedł kontrolę formatu i można go wybrać do druku.',
    previewTitle: 'Podgląd pliku produkcyjnego',
    noPreviewSelection: 'Wybierz Podgląd, aby sprawdzić klienta, rozmiar i wersję.',
    previewLoading: 'Ładowanie podglądu…',
    previewUnavailable: 'Ten wpis nie ma jeszcze produkcyjnego PNG.',
    reviewTitle: 'Sprawdź zlecenie druku',
    selectedCount: (count) => `Wybrano ${count} pozycji`,
    nothingSelected: 'Wybierz co najmniej jedną gotową pozycję i podaj liczbę kopii.',
    total: 'Łączna liczba metek',
    quantityInvalid: 'Każda pozycja musi mieć od 1 do 999 kopii.',
    printSelected: 'Drukuj wybrane',
    printing: 'Drukowanie po kolei…',
    stopAfterCurrent: 'Zatrzymaj po bieżącej partii',
    continueNextChunk: 'Kontynuuj następną partię',
    stopNow: 'Zatrzymaj tutaj',
    awaitingNextChunk: (done, chunks) => `Wysłano ${done}/${chunks} partii. Sprawdź ostatnie metki, następnie wybierz Kontynuuj albo Zatrzymaj.`,
    progress: (done, chunks, copies, total) => `${done}/${chunks} partii · ${copies}/${total} metek wysłano`,
    highTitle: 'Potwierdź dużą liczbę',
    highBody: (count) => `Do drukarki zostanie wysłanych ${count} metek. Sprawdź pliki, rozmiary i ilości.`,
    confirmPrint: 'Potwierdź druk',
    printed: (count) => `Wysłano wszystkie ${count} metek do drukarki.`,
    stopped: (done, total) => `Zatrzymano po ${done}/${total} partiach.`,
    printFailed: 'Zatrzymano z powodu błędu druku.',
    noDurableResume: 'Brak trwałego wznawiania: po zamknięciu aplikacji lub zacięciu policz fizyczne metki przed ponownym drukiem.',
    imported: 'Plik źródłowy zapisano w bibliotece.',
    productionAttached: 'Dołączono produkcyjny PNG.',
    retired: 'Plik został wycofany.',
    unknownCustomer: 'Nieznany klient',
  },
  en: {
    title: 'Fabric labels from customer files',
    subtitle: 'Store the source, attach a production PNG, enter copies, then print',
    fixedMedia: 'Fixed 20 mm width · 203 dpi · no automatic scaling',
    fixedMediaHint: 'An image is Ready only after media validation. The app never stretches or shrinks artwork to fit.',
    productionPngContract: 'Required production PNG: exactly 160 px wide, 80–480 px high, with 9 px of white margin on both the left and right; the printable center is 142 px. 20 mm at 203 dpi, with no scaling.',
    unavailableTitle: 'Fabric artwork library is unavailable',
    unavailableBody: 'Fabric printing is safely disabled. Product code / EAN labels remain available above.',
    importTitle: 'Receive a file for a print order',
    importHint: 'Enter the metadata first, then choose a .btw or .png file. File paths are never typed manually.',
    customer: 'Customer',
    customerPlaceholder: 'For example: MOON',
    orderCode: 'Order / style code',
    orderCodePlaceholder: 'Optional',
    variant: 'Size / variant printed on label',
    variantPlaceholder: 'M, S/M, 44/46, L/XL…',
    revision: 'Revision',
    chooseFile: 'Choose .btw or .png',
    importing: 'Importing…',
    requiredFields: 'Customer, size/variant, and a valid revision are required.',
    libraryTitle: 'Received file library',
    search: 'Search customer, order, size, or filename',
    all: 'All',
    ready: 'Ready',
    needsPng: 'Needs print PNG',
    loading: 'Loading library…',
    loadError: 'Could not load the fabric artwork library.',
    retry: 'Try again',
    empty: 'No files yet. Receive the first file above.',
    emptySearch: 'No files match the current filter.',
    source: 'Source',
    production: 'Production file',
    noProduction: 'No PNG attached',
    geometry: 'Production geometry',
    copies: 'Copies',
    selectForPrint: 'Select to print',
    preview: 'Preview',
    attachPng: 'Attach 20 mm PNG',
    attaching: 'Attaching…',
    retire: 'Retire',
    retireTitle: 'Retire this file?',
    retireBody: 'The file will disappear from new print selections. Its history will be preserved.',
    retireConfirm: 'Retire',
    cancel: 'Cancel',
    needsConversionHint: 'The .btw source is stored but cannot print yet. Export a 20 mm / 203 dpi PNG from BarTender and attach it.',
    readyHint: 'The production PNG passed media validation and can be selected for printing.',
    previewTitle: 'Production artwork preview',
    noPreviewSelection: 'Choose Preview on a row to verify the customer, size, and revision.',
    previewLoading: 'Loading preview…',
    previewUnavailable: 'This record does not have a production PNG yet.',
    reviewTitle: 'Review print run',
    selectedCount: (count) => `${count} line(s) selected`,
    nothingSelected: 'Select at least one Ready row and enter its copy count.',
    total: 'Total labels',
    quantityInvalid: 'Each row must have an integer copy count from 1 to 999.',
    printSelected: 'Print selected rows',
    printing: 'Printing sequentially…',
    stopAfterCurrent: 'Stop after current chunk',
    continueNextChunk: 'Continue next chunk',
    stopNow: 'Stop here',
    awaitingNextChunk: (done, chunks) => `${done}/${chunks} chunks submitted. Check the latest labels, then choose Continue or Stop.`,
    progress: (done, chunks, copies, total) => `${done}/${chunks} chunks · ${copies}/${total} labels submitted`,
    highTitle: 'Confirm large print run',
    highBody: (count) => `You are about to submit ${count} fabric labels. Recheck the files, sizes, and quantities.`,
    confirmPrint: 'Confirm print',
    printed: (count) => `All ${count} labels were submitted to the printer.`,
    stopped: (done, total) => `Stopped after ${done}/${total} chunks.`,
    printFailed: 'Stopped because printing failed.',
    noDurableResume: 'There is no durable resume yet: after an app close or printer jam, count the physical labels before printing again.',
    imported: 'Source file saved to the library.',
    productionAttached: 'Production PNG attached.',
    retired: 'File retired.',
    unknownCustomer: 'Unknown customer',
  },
};

function resolveArtworkApi(): FabricTagArtworksBridge | null {
  const candidate = window.electronAPI?.pos?.fabricTagArtworks;
  if (
    !candidate
    || typeof candidate.list !== 'function'
    || typeof candidate.importSource !== 'function'
    || typeof candidate.attachProduction !== 'function'
    || typeof candidate.getPreview !== 'function'
    || typeof candidate.retire !== 'function'
    || typeof candidate.print !== 'function'
  ) return null;
  return candidate;
}

function asRecord(value: unknown): Record<string, any> | null {
  return value && typeof value === 'object' ? value as Record<string, any> : null;
}

function unwrapResult(value: unknown): unknown {
  const row = asRecord(value);
  if (!row || typeof row.success !== 'boolean') return value;
  if (!row.success) throw new Error(String(row.error || 'Operation failed'));
  if (Object.prototype.hasOwnProperty.call(row, 'data')) return row.data;
  if (Object.prototype.hasOwnProperty.call(row, 'artwork')) return row.artwork;
  if (Object.prototype.hasOwnProperty.call(row, 'artworks')) return row.artworks;
  return value;
}

function normalizeArtwork(value: unknown): FabricTagArtwork | null {
  const row = asRecord(value) as Partial<FabricTagArtwork> | null;
  if (!row) return null;
  const id = String(row.id || '').trim();
  if (!id) return null;
  if (!['READY', 'NEEDS_CONVERSION', 'RETIRED'].includes(String(row.status || ''))) return null;
  if (!String(row.customerName || '').trim() || !String(row.variant || '').trim() || !String(row.revision || '').trim()) return null;
  return row as FabricTagArtwork;
}

function normalizeSearch(value: string): string {
  return value
    .replace(/[Đđ]/g, (char) => (char === 'Đ' ? 'D' : 'd'))
    .replace(/[Łł]/g, (char) => (char === 'Ł' ? 'L' : 'l'))
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();
}

function parseQuantity(value: string | undefined): number | null {
  if (!value || !/^\d+$/.test(value.trim())) return null;
  const quantity = Number(value);
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > FABRIC_TAG_ARTWORK_LIMITS.quantity) return null;
  return quantity;
}

function fileLabel(filename: string): string {
  return filename || '—';
}

function formatGeometry(artwork: FabricTagArtwork): string {
  const formatNumber = (value: number | null) => (
    typeof value === 'number' && Number.isFinite(value)
      ? String(Number(value.toFixed(2)))
      : '—'
  );
  return `${formatNumber(artwork.physicalWidthMm)} × ${formatNumber(artwork.physicalLengthMm)} mm · ${formatNumber(artwork.widthPx)} × ${formatNumber(artwork.heightPx)} px`;
}

interface FabricArtworkPanelProps {
  language: Language;
  active?: boolean;
  onPrintingChange?: (printing: boolean) => void;
}

export default function FabricArtworkPanel({ language, active = true, onPrintingChange }: FabricArtworkPanelProps) {
  const copy = COPY[language] || COPY.en;
  const api = useMemo(resolveArtworkApi, []);
  const [artworks, setArtworks] = useState<FabricTagArtwork[]>([]);
  const [loading, setLoading] = useState(!!api);
  const [loadError, setLoadError] = useState('');
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<LibraryFilter>('all');
  const [customer, setCustomer] = useState('');
  const [orderCode, setOrderCode] = useState('');
  const [variant, setVariant] = useState('');
  const [revision, setRevision] = useState('1');
  const [formError, setFormError] = useState('');
  const [notice, setNotice] = useState<{ type: 'success' | 'error'; message: string } | null>(null);
  const [busyAction, setBusyAction] = useState('');
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  const [quantities, setQuantities] = useState<Record<string, string>>({});
  const [previewId, setPreviewId] = useState('');
  const [previewDataUrl, setPreviewDataUrl] = useState('');
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState('');
  const [retireCandidate, setRetireCandidate] = useState<FabricTagArtwork | null>(null);
  const [pendingPrintPlan, setPendingPrintPlan] = useState<PrintPlanRow[] | null>(null);
  const [printProgress, setPrintProgress] = useState<PrintProgress | null>(null);
  const listRequestRef = useRef(0);
  const previewRequestRef = useRef(0);
  const printInFlightRef = useRef(false);
  const stopRequestedRef = useRef(false);
  const chunkDecisionRef = useRef<((decision: 'continue' | 'stop') => void) | null>(null);

  const loadArtworks = useCallback(async (showSpinner = true) => {
    if (!api) return;
    const request = ++listRequestRef.current;
    if (showSpinner) setLoading(true);
    setLoadError('');
    try {
      const unwrapped = unwrapResult(await api.list());
      const unwrappedRecord = asRecord(unwrapped);
      const rawRows: unknown[] = Array.isArray(unwrapped)
        ? unwrapped
        : Array.isArray(unwrappedRecord?.artworks)
          ? unwrappedRecord.artworks as unknown[]
          : [];
      const rows: FabricTagArtwork[] = rawRows
        .map(normalizeArtwork)
        .filter((row): row is FabricTagArtwork => !!row && row.status !== 'RETIRED');
      if (request !== listRequestRef.current) return;
      setArtworks(rows);
      const readyIds = new Set(rows.filter((row) => row.status === 'READY').map((row) => row.id));
      setSelectedIds((current) => new Set(Array.from(current).filter((id) => readyIds.has(id))));
    } catch (err: any) {
      if (request !== listRequestRef.current) return;
      rlog.error('[FabricArtworkPanel] Failed to load artwork library:', err);
      setLoadError(err?.message || copy.loadError);
    } finally {
      if (request === listRequestRef.current) setLoading(false);
    }
  }, [api, copy.loadError]);

  const resolveChunkDecision = useCallback((decision: 'continue' | 'stop') => {
    const resolve = chunkDecisionRef.current;
    if (!resolve) return;
    // Clear before resolving so two physical clicks in the same React frame
    // cannot release both this pause and the next one.
    chunkDecisionRef.current = null;
    resolve(decision);
  }, []);

  useEffect(() => {
    void loadArtworks();
    return () => {
      listRequestRef.current += 1;
      previewRequestRef.current += 1;
      stopRequestedRef.current = true;
      resolveChunkDecision('stop');
    };
  }, [loadArtworks, resolveChunkDecision]);

  useEffect(() => {
    if (active) return;
    // Confirmation overlays must not remain actionable behind the EAN panel.
    setPendingPrintPlan(null);
    setRetireCandidate(null);
  }, [active]);

  const visibleArtworks = useMemo(() => {
    const normalized = normalizeSearch(query);
    return artworks.filter((row) => {
      if (filter === 'ready' && row.status !== 'READY') return false;
      if (filter === 'needs-conversion' && row.status !== 'NEEDS_CONVERSION') return false;
      if (!normalized) return true;
      return normalizeSearch([
        row.customerName,
        row.orderCode,
        row.variant,
        row.originalFilename,
        row.productionFilename,
        row.revision,
      ].join(' ')).includes(normalized);
    });
  }, [artworks, filter, query]);

  const groupedArtworks = useMemo(() => {
    const groups = new Map<string, FabricTagArtwork[]>();
    for (const row of visibleArtworks) {
      const key = row.customerName || copy.unknownCustomer;
      groups.set(key, [...(groups.get(key) || []), row]);
    }
    return Array.from(groups.entries()).sort(([left], [right]) => left.localeCompare(right));
  }, [copy.unknownCustomer, visibleArtworks]);

  const selectedArtwork = useMemo(
    () => artworks.find((row) => row.id === previewId) || null,
    [artworks, previewId],
  );

  const selectedRows = useMemo(
    () => artworks.filter((row) => row.status === 'READY' && selectedIds.has(row.id)),
    [artworks, selectedIds],
  );

  const currentPrintPlan = useMemo(() => selectedRows
    .map((artwork) => ({ artwork, quantity: parseQuantity(quantities[artwork.id]) }))
    .filter((row): row is PrintPlanRow => row.quantity !== null), [quantities, selectedRows]);
  const hasInvalidQuantity = currentPrintPlan.length !== selectedRows.length;
  const selectedTotal = currentPrintPlan.reduce((sum, row) => sum + row.quantity, 0);

  const handleImport = async () => {
    if (!active || !api || busyAction || printInFlightRef.current) return;
    if (!customer.trim() || !variant.trim() || !revision.trim()) {
      setFormError(copy.requiredFields);
      return;
    }
    setFormError('');
    setNotice(null);
    setBusyAction('import');
    try {
      const result = unwrapResult(await api.importSource({
        customerName: customer.trim(),
        orderCode: orderCode.trim() || null,
        variant: variant.trim(),
        revision: revision.trim(),
      }));
      if (result === null || result === undefined) return;
      setVariant('');
      setRevision('1');
      setNotice({ type: 'success', message: copy.imported });
      await loadArtworks(false);
    } catch (err: any) {
      rlog.error('[FabricArtworkPanel] Failed to import artwork:', err);
      setNotice({ type: 'error', message: err?.message || copy.loadError });
    } finally {
      setBusyAction('');
    }
  };

  const handleAttachProduction = async (artwork: FabricTagArtwork) => {
    if (!active || !api || busyAction || printInFlightRef.current) return;
    setNotice(null);
    setBusyAction(`attach:${artwork.id}`);
    try {
      const result = unwrapResult(await api.attachProduction(artwork.id));
      if (result === null || result === undefined) return;
      setNotice({ type: 'success', message: copy.productionAttached });
      await loadArtworks(false);
      void handlePreview(artwork.id);
    } catch (err: any) {
      rlog.error('[FabricArtworkPanel] Failed to attach production PNG:', err);
      setNotice({ type: 'error', message: err?.message || copy.loadError });
    } finally {
      setBusyAction('');
    }
  };

  const handlePreview = async (assetId: string) => {
    if (!active || !api) return;
    const request = ++previewRequestRef.current;
    setPreviewId(assetId);
    setPreviewDataUrl('');
    setPreviewError('');
    setPreviewLoading(true);
    try {
      const unwrapped = unwrapResult(await api.getPreview(assetId));
      const row = asRecord(unwrapped);
      const dataUrl = typeof unwrapped === 'string'
        ? unwrapped
        : String(row?.dataUrl ?? row?.previewDataUrl ?? '');
      if (request !== previewRequestRef.current) return;
      if (!dataUrl.startsWith('data:image/png;base64,')) {
        setPreviewError(copy.previewUnavailable);
        return;
      }
      setPreviewDataUrl(dataUrl);
    } catch (err: any) {
      if (request !== previewRequestRef.current) return;
      rlog.error('[FabricArtworkPanel] Failed to load artwork preview:', err);
      setPreviewError(err?.message || copy.previewUnavailable);
    } finally {
      if (request === previewRequestRef.current) setPreviewLoading(false);
    }
  };

  const toggleSelected = (artwork: FabricTagArtwork) => {
    if (!active || artwork.status !== 'READY' || printInFlightRef.current) return;
    setSelectedIds((current) => {
      const next = new Set(current);
      if (next.has(artwork.id)) next.delete(artwork.id);
      else next.add(artwork.id);
      return next;
    });
    setQuantities((current) => (
      Object.prototype.hasOwnProperty.call(current, artwork.id)
        ? current
        : { ...current, [artwork.id]: '1' }
    ));
  };

  const handleRetire = async () => {
    const artwork = retireCandidate;
    if (!active || !api || !artwork || busyAction || printInFlightRef.current) return;
    setBusyAction(`retire:${artwork.id}`);
    setNotice(null);
    try {
      unwrapResult(await api.retire(artwork.id));
      setRetireCandidate(null);
      setNotice({ type: 'success', message: copy.retired });
      await loadArtworks(false);
    } catch (err: any) {
      rlog.error('[FabricArtworkPanel] Failed to retire artwork:', err);
      setNotice({ type: 'error', message: err?.message || copy.loadError });
    } finally {
      setBusyAction('');
    }
  };

  const executePrintPlan = async (plan: PrintPlanRow[]) => {
    if (!active || !api || printInFlightRef.current || plan.length === 0) return;
    printInFlightRef.current = true;
    onPrintingChange?.(true);
    stopRequestedRef.current = false;
    setPendingPrintPlan(null);
    setNotice(null);
    const totalCopies = plan.reduce((sum, row) => sum + row.quantity, 0);
    const chunks = plan.flatMap((row) => {
      const rowChunks: FabricTagArtworkPrintRequest[] = [];
      let remaining = row.quantity;
      while (remaining > 0) {
        const quantity = Math.min(remaining, PRINT_CHUNK_SIZE);
        rowChunks.push({ assetId: row.artwork.id, quantity });
        remaining -= quantity;
      }
      return rowChunks;
    });
    let completedChunks = 0;
    let completedCopies = 0;
    setPrintProgress({
      type: 'printing',
      completedChunks,
      totalChunks: chunks.length,
      completedCopies,
      totalCopies,
      message: copy.printing,
    });

    try {
      for (const chunk of chunks) {
        if (stopRequestedRef.current) {
          setPrintProgress({
            type: 'stopped',
            completedChunks,
            totalChunks: chunks.length,
            completedCopies,
            totalCopies,
            message: copy.stopped(completedChunks, chunks.length),
          });
          return;
        }
        const result = asRecord(await api.print(chunk));
        if (!result || result.success !== true) {
          throw new Error(String(result?.error || copy.printFailed));
        }
        completedChunks += 1;
        completedCopies += chunk.quantity;
        setPrintProgress({
          type: 'printing',
          completedChunks,
          totalChunks: chunks.length,
          completedCopies,
          totalCopies,
          message: copy.progress(completedChunks, chunks.length, completedCopies, totalCopies),
        });
        if (completedChunks < chunks.length) {
          if (stopRequestedRef.current) {
            setPrintProgress({
              type: 'stopped',
              completedChunks,
              totalChunks: chunks.length,
              completedCopies,
              totalCopies,
              message: copy.stopped(completedChunks, chunks.length),
            });
            return;
          }
          setPrintProgress({
            type: 'waiting',
            completedChunks,
            totalChunks: chunks.length,
            completedCopies,
            totalCopies,
            message: copy.awaitingNextChunk(completedChunks, chunks.length),
          });
          const decision = await new Promise<'continue' | 'stop'>((resolve) => {
            chunkDecisionRef.current = resolve;
          });
          if (decision === 'stop' || stopRequestedRef.current) {
            setPrintProgress({
              type: 'stopped',
              completedChunks,
              totalChunks: chunks.length,
              completedCopies,
              totalCopies,
              message: copy.stopped(completedChunks, chunks.length),
            });
            return;
          }
          setPrintProgress({
            type: 'printing',
            completedChunks,
            totalChunks: chunks.length,
            completedCopies,
            totalCopies,
            message: copy.printing,
          });
        }
      }
      setPrintProgress({
        type: 'success',
        completedChunks,
        totalChunks: chunks.length,
        completedCopies,
        totalCopies,
        message: copy.printed(totalCopies),
      });
    } catch (err: any) {
      rlog.error('[FabricArtworkPanel] Print run stopped:', err);
      setPrintProgress({
        type: 'error',
        completedChunks,
        totalChunks: chunks.length,
        completedCopies,
        totalCopies,
        message: `${err?.message || copy.printFailed} ${copy.progress(completedChunks, chunks.length, completedCopies, totalCopies)}`,
      });
    } finally {
      chunkDecisionRef.current = null;
      printInFlightRef.current = false;
      onPrintingChange?.(false);
    }
  };

  const requestPrint = () => {
    if (!active || printInFlightRef.current || selectedRows.length === 0 || hasInvalidQuantity) return;
    if (selectedTotal > FABRIC_TAG_CONFIRM_THRESHOLD) {
      setPendingPrintPlan(currentPrintPlan);
      return;
    }
    void executePrintPlan(currentPrintPlan);
  };

  if (!api) {
    return (
      <section className="h-full min-h-0 rounded-lg border border-slate-200 bg-white p-5" aria-label={copy.title}>
        <div className="mx-auto flex h-full max-w-xl items-center justify-center">
          <div role="alert" className="w-full rounded-lg border border-amber-200 bg-amber-50 p-5 text-amber-950">
            <AlertTriangle size={28} className="mb-3 text-amber-700" aria-hidden="true" />
            <h1 className="text-lg font-extrabold">{copy.unavailableTitle}</h1>
            <p className="mt-2 text-sm font-semibold leading-6 text-amber-900">{copy.unavailableBody}</p>
          </div>
        </div>
      </section>
    );
  }

  const isPrinting = printInFlightRef.current;
  const isWaitingForChunk = isPrinting && printProgress?.type === 'waiting';

  return (
    <section className="grid h-full min-h-0 gap-3 overflow-y-auto xl:grid-cols-[minmax(0,1fr),380px] xl:overflow-hidden" aria-label={copy.title}>
      <div className="min-h-[680px] rounded-lg border border-slate-200 bg-white flex flex-col overflow-hidden xl:min-h-0">
        <header className="shrink-0 border-b border-slate-200 px-4 py-3">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="flex min-w-0 items-start gap-3">
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-emerald-50 text-emerald-700">
                <FileImage size={21} aria-hidden="true" />
              </div>
              <div className="min-w-0">
                <h1 className="text-lg font-extrabold leading-tight text-slate-950">{copy.title}</h1>
                <p className="mt-0.5 text-xs font-semibold text-slate-500">{copy.subtitle}</p>
              </div>
            </div>
            <div className="max-w-sm rounded-md border border-sky-200 bg-sky-50 px-3 py-2 text-xs font-bold text-sky-900">
              <div>{copy.fixedMedia}</div>
              <div className="mt-0.5 font-semibold text-sky-800">{copy.fixedMediaHint}</div>
            </div>
          </div>
        </header>

        <div className="shrink-0 border-b border-slate-200 bg-slate-50 p-3">
          <div className="mb-2">
            <h2 className="text-sm font-extrabold text-slate-900">{copy.importTitle}</h2>
            <p className="mt-0.5 text-xs font-semibold text-slate-500">{copy.importHint}</p>
            <p className="mt-2 rounded-md border border-sky-200 bg-sky-50 px-3 py-2 text-xs font-bold leading-5 text-sky-900">
              {copy.productionPngContract}
            </p>
          </div>
          <div className="grid gap-2 md:grid-cols-[minmax(150px,1.2fr),minmax(140px,1fr),minmax(150px,1fr),90px,auto]">
            <label className="space-y-1">
              <span className="text-[11px] font-extrabold uppercase tracking-wide text-slate-500">{copy.customer} *</span>
              <input
                value={customer}
                onChange={(event) => setCustomer(event.target.value)}
                disabled={!active}
                maxLength={FABRIC_TAG_ARTWORK_LIMITS.customerName}
                placeholder={copy.customerPlaceholder}
                className="h-11 w-full rounded-md border border-slate-300 bg-white px-3 text-sm font-bold outline-none focus:ring-2 focus:ring-emerald-200"
              />
            </label>
            <label className="space-y-1">
              <span className="text-[11px] font-extrabold uppercase tracking-wide text-slate-500">{copy.orderCode}</span>
              <input
                value={orderCode}
                onChange={(event) => setOrderCode(event.target.value)}
                disabled={!active}
                maxLength={FABRIC_TAG_ARTWORK_LIMITS.orderCode}
                placeholder={copy.orderCodePlaceholder}
                className="h-11 w-full rounded-md border border-slate-300 bg-white px-3 text-sm font-bold outline-none focus:ring-2 focus:ring-emerald-200"
              />
            </label>
            <label className="space-y-1">
              <span className="text-[11px] font-extrabold uppercase tracking-wide text-slate-500">{copy.variant} *</span>
              <input
                value={variant}
                onChange={(event) => setVariant(event.target.value)}
                disabled={!active}
                maxLength={FABRIC_TAG_ARTWORK_LIMITS.variant}
                placeholder={copy.variantPlaceholder}
                className="h-11 w-full rounded-md border border-slate-300 bg-white px-3 text-sm font-bold outline-none focus:ring-2 focus:ring-emerald-200"
              />
            </label>
            <label className="space-y-1">
              <span className="text-[11px] font-extrabold uppercase tracking-wide text-slate-500">{copy.revision}</span>
              <input
                type="text"
                maxLength={FABRIC_TAG_ARTWORK_LIMITS.revision}
                value={revision}
                onChange={(event) => setRevision(event.target.value)}
                disabled={!active}
                className="h-11 w-full rounded-md border border-slate-300 bg-white px-2 text-center text-sm font-extrabold outline-none focus:ring-2 focus:ring-emerald-200"
              />
            </label>
            <button
              type="button"
              onClick={() => void handleImport()}
              disabled={!active || !!busyAction || isPrinting}
              className="min-h-11 self-end rounded-md bg-slate-950 px-4 text-sm font-extrabold text-white hover:bg-black disabled:cursor-not-allowed disabled:bg-slate-300 inline-flex items-center justify-center gap-2"
            >
              {busyAction === 'import' ? <Loader2 size={17} className="animate-spin" /> : <FolderOpen size={17} />}
              {busyAction === 'import' ? copy.importing : copy.chooseFile}
            </button>
          </div>
          {formError && <p role="alert" className="mt-2 text-xs font-bold text-red-700">{formError}</p>}
          {notice && (
            <div
              role={notice.type === 'error' ? 'alert' : 'status'}
              className={`mt-2 rounded-md border px-3 py-2 text-xs font-bold ${
                notice.type === 'error'
                  ? 'border-red-200 bg-red-50 text-red-800'
                  : 'border-emerald-200 bg-emerald-50 text-emerald-800'
              }`}
            >
              {notice.message}
            </div>
          )}
        </div>

        <div className="shrink-0 border-b border-slate-200 px-3 py-2.5">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="mr-auto text-sm font-extrabold text-slate-900">{copy.libraryTitle}</h2>
            <div className="relative min-w-[220px] flex-1 md:max-w-sm">
              <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" aria-hidden="true" />
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                disabled={!active}
                placeholder={copy.search}
                className="h-11 w-full rounded-md border border-slate-300 bg-white pl-9 pr-3 text-sm font-semibold outline-none focus:ring-2 focus:ring-emerald-200"
              />
            </div>
            <button
              type="button"
              onClick={() => void loadArtworks()}
              disabled={!active || loading || !!busyAction || isPrinting}
              className="h-11 w-11 rounded-md border border-slate-300 bg-white text-slate-600 hover:bg-slate-50 disabled:opacity-50 inline-flex items-center justify-center"
              aria-label={copy.retry}
              title={copy.retry}
            >
              <RefreshCw size={17} className={loading ? 'animate-spin' : ''} />
            </button>
          </div>
          <div className="mt-2 flex gap-2 overflow-x-auto">
            {([
              ['all', copy.all],
              ['ready', copy.ready],
              ['needs-conversion', copy.needsPng],
            ] as const).map(([value, label]) => (
              <button
                key={value}
                type="button"
                onClick={() => setFilter(value)}
                disabled={!active}
                aria-pressed={filter === value}
                className={`min-h-10 whitespace-nowrap rounded-md border px-3 text-xs font-extrabold ${
                  filter === value
                    ? 'border-emerald-500 bg-emerald-50 text-emerald-800'
                    : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50'
                }`}
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-3">
          {loading ? (
            <div className="flex min-h-48 items-center justify-center gap-2 text-sm font-bold text-slate-500">
              <Loader2 size={18} className="animate-spin" /> {copy.loading}
            </div>
          ) : loadError ? (
            <div role="alert" className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm font-bold text-red-800">
              <p>{loadError || copy.loadError}</p>
              <button
                type="button"
                onClick={() => void loadArtworks()}
                className="mt-3 min-h-11 rounded-md border border-red-300 bg-white px-4 text-xs font-extrabold hover:bg-red-100"
              >
                {copy.retry}
              </button>
            </div>
          ) : groupedArtworks.length === 0 ? (
            <div className="flex min-h-48 items-center justify-center rounded-lg border border-dashed border-slate-300 bg-slate-50 p-5 text-center text-sm font-semibold text-slate-500">
              {artworks.length === 0 ? copy.empty : copy.emptySearch}
            </div>
          ) : (
            <div className="space-y-4 pb-2">
              {groupedArtworks.map(([groupCustomer, rows]) => (
                <section key={groupCustomer} className="space-y-2" aria-label={groupCustomer}>
                  <div className="sticky top-0 z-[1] flex items-center justify-between gap-2 bg-white/95 py-1 backdrop-blur-sm">
                    <h3 className="text-xs font-extrabold uppercase tracking-wide text-slate-500">{groupCustomer}</h3>
                    <span className="text-[11px] font-bold tabular-nums text-slate-400">{rows.length}</span>
                  </div>
                  {rows.map((artwork) => {
                    const selected = selectedIds.has(artwork.id);
                    const ready = artwork.status === 'READY';
                    const attaching = busyAction === `attach:${artwork.id}`;
                    return (
                      <article
                        key={artwork.id}
                        className={`rounded-lg border p-3 ${
                          selected
                            ? 'border-emerald-400 bg-emerald-50/50'
                            : 'border-slate-200 bg-white'
                        }`}
                      >
                        <div className="flex flex-wrap items-start gap-3">
                          <label
                            className={`flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded-md border ${
                              ready
                                ? 'cursor-pointer border-slate-300 bg-white hover:bg-slate-50'
                                : 'cursor-not-allowed border-slate-200 bg-slate-100 opacity-60'
                            }`}
                            title={copy.selectForPrint}
                          >
                            <input
                              type="checkbox"
                              checked={selected}
                              disabled={!active || !ready || isPrinting}
                              onChange={() => toggleSelected(artwork)}
                              aria-label={`${copy.selectForPrint}: ${artwork.variant}`}
                              className="h-5 w-5 rounded border-slate-300 text-emerald-600 focus:ring-emerald-300"
                            />
                          </label>
                          <div className="min-w-[180px] flex-1">
                            <div className="flex flex-wrap items-center gap-2">
                              <span className="text-base font-black text-slate-950">{artwork.variant || '—'}</span>
                              <span className="rounded bg-slate-100 px-2 py-1 text-xs font-extrabold uppercase text-slate-600">{copy.revision}: {artwork.revision}</span>
                              <span className={`rounded px-2 py-1 text-xs font-extrabold uppercase ${
                                ready
                                  ? 'bg-emerald-100 text-emerald-800'
                                  : artwork.status === 'NEEDS_CONVERSION'
                                    ? 'bg-amber-100 text-amber-800'
                                    : 'bg-red-100 text-red-800'
                              }`}>
                                {ready ? copy.ready : artwork.status === 'NEEDS_CONVERSION' ? copy.needsPng : artwork.status}
                              </span>
                            </div>
                            <div className="mt-1 text-xs font-bold text-slate-500">
                              {artwork.orderCode || '—'}
                            </div>
                            <dl className="mt-2 grid gap-x-3 gap-y-1 text-xs sm:grid-cols-2">
                              <div className="min-w-0">
                                <dt className="font-semibold text-slate-400">{copy.source}</dt>
                                <dd className="truncate font-bold text-slate-700" title={artwork.originalFilename}>{fileLabel(artwork.originalFilename)}</dd>
                              </div>
                              <div className="min-w-0">
                                <dt className="font-semibold text-slate-400">{copy.production}</dt>
                                <dd className={`truncate font-bold ${artwork.productionFilename ? 'text-slate-700' : 'text-amber-700'}`} title={artwork.productionFilename || undefined}>
                                  {artwork.productionFilename || copy.noProduction}
                                </dd>
                              </div>
                            </dl>
                            {ready && (
                              <div className="mt-2 rounded bg-sky-50 px-2 py-1.5 text-[11px] font-bold text-sky-900">
                                <span className="text-sky-700">{copy.geometry}: </span>{formatGeometry(artwork)}
                              </div>
                            )}
                            <p className={`mt-2 text-[11px] font-semibold leading-4 ${ready ? 'text-emerald-700' : 'text-amber-700'}`}>
                              {ready ? copy.readyHint : copy.needsConversionHint}
                            </p>
                          </div>
                          <div className="flex min-w-[136px] flex-col gap-2">
                            <label className="space-y-1">
                              <span className="text-xs font-extrabold uppercase tracking-wide text-slate-500">{copy.copies}</span>
                              <input
                                type="number"
                                min={1}
                                max={FABRIC_TAG_ARTWORK_LIMITS.quantity}
                                value={quantities[artwork.id] ?? '1'}
                                onChange={(event) => setQuantities((current) => ({ ...current, [artwork.id]: event.target.value }))}
                                disabled={!active || !ready || !selected || isPrinting}
                                className="h-11 w-full rounded-md border border-slate-300 bg-white px-2 text-center text-base font-extrabold tabular-nums outline-none focus:ring-2 focus:ring-emerald-200 disabled:bg-slate-100 disabled:text-slate-400"
                              />
                            </label>
                            <button
                              type="button"
                              onClick={() => void handlePreview(artwork.id)}
                              disabled={!active || (previewLoading && previewId === artwork.id)}
                              className="min-h-11 rounded-md border border-slate-300 bg-white px-3 text-xs font-extrabold text-slate-700 hover:bg-slate-50 disabled:opacity-50 inline-flex items-center justify-center gap-1.5"
                            >
                              {previewLoading && previewId === artwork.id ? <Loader2 size={15} className="animate-spin" /> : <Eye size={15} />}
                              {copy.preview}
                            </button>
                          </div>
                        </div>
                        <div className="mt-3 flex flex-wrap justify-end gap-2 border-t border-slate-100 pt-2">
                          {artwork.status === 'NEEDS_CONVERSION' && (
                            <button
                              type="button"
                              onClick={() => void handleAttachProduction(artwork)}
                              disabled={!active || !!busyAction || isPrinting}
                              className="min-h-11 rounded-md border border-sky-300 bg-sky-50 px-3 text-xs font-extrabold text-sky-800 hover:bg-sky-100 disabled:opacity-50 inline-flex items-center gap-1.5"
                            >
                              {attaching ? <Loader2 size={15} className="animate-spin" /> : <ImagePlus size={15} />}
                              {attaching ? copy.attaching : copy.attachPng}
                            </button>
                          )}
                          <button
                            type="button"
                            onClick={() => setRetireCandidate(artwork)}
                            disabled={!active || !!busyAction || isPrinting}
                            className="min-h-11 rounded-md border border-slate-300 bg-white px-3 text-xs font-extrabold text-slate-600 hover:border-red-200 hover:bg-red-50 hover:text-red-700 disabled:opacity-50 inline-flex items-center gap-1.5"
                          >
                            <Archive size={15} /> {copy.retire}
                          </button>
                        </div>
                      </article>
                    );
                  })}
                </section>
              ))}
            </div>
          )}
        </div>
      </div>

      <aside className="min-h-[620px] rounded-lg border border-slate-200 bg-white flex flex-col overflow-hidden xl:min-h-0">
        <section className="min-h-0 flex-1 overflow-y-auto border-b border-slate-200 p-3">
          <h2 className="text-sm font-extrabold text-slate-900">{copy.previewTitle}</h2>
          {selectedArtwork ? (
            <div className="mt-3 space-y-3">
              <div className="rounded-lg border border-slate-200 bg-slate-50 p-3">
                <div className="flex items-center justify-between gap-2">
                  <div className="min-w-0">
                    <div className="truncate text-sm font-extrabold text-slate-950">{selectedArtwork.customerName}</div>
                    <div className="mt-0.5 text-xs font-bold text-slate-500">
                      {selectedArtwork.orderCode || '—'} · {selectedArtwork.variant} · {copy.revision}: {selectedArtwork.revision}
                    </div>
                  </div>
                  <span className={`shrink-0 rounded px-2 py-1 text-xs font-extrabold uppercase ${
                    selectedArtwork.status === 'READY'
                      ? 'bg-emerald-100 text-emerald-800'
                      : 'bg-amber-100 text-amber-800'
                  }`}>
                    {selectedArtwork.status === 'READY' ? copy.ready : copy.needsPng}
                  </span>
                </div>
              </div>
              <div className="flex min-h-[260px] items-center justify-center overflow-hidden rounded-lg border border-slate-300 bg-slate-100 p-3">
                {previewLoading ? (
                  <div className="text-center text-sm font-bold text-slate-500">
                    <Loader2 size={24} className="mx-auto mb-2 animate-spin" />
                    {copy.previewLoading}
                  </div>
                ) : previewDataUrl ? (
                  <img
                    src={previewDataUrl}
                    alt={`${selectedArtwork.customerName} ${selectedArtwork.variant}`}
                    className="max-h-[420px] max-w-full border border-slate-200 bg-white object-contain shadow-sm"
                  />
                ) : (
                  <div className="max-w-xs text-center text-sm font-semibold leading-6 text-slate-500">
                    <FileImage size={32} className="mx-auto mb-2 text-slate-300" />
                    {previewError || copy.previewUnavailable}
                  </div>
                )}
              </div>
              <div className="rounded-md border border-sky-200 bg-sky-50 px-3 py-2 text-xs font-bold text-sky-900">
                <div>{copy.fixedMedia}</div>
                {selectedArtwork.status === 'READY' && (
                  <div className="mt-1 border-t border-sky-200 pt-1">
                    <span className="text-sky-700">{copy.geometry}: </span>{formatGeometry(selectedArtwork)}
                  </div>
                )}
              </div>
            </div>
          ) : (
            <div className="mt-3 flex min-h-[260px] items-center justify-center rounded-lg border border-dashed border-slate-300 bg-slate-50 p-5 text-center text-sm font-semibold leading-6 text-slate-500">
              {copy.noPreviewSelection}
            </div>
          )}
        </section>

        <section className="shrink-0 p-3 space-y-3">
          <div className="flex items-start justify-between gap-3">
            <div>
              <h2 className="text-sm font-extrabold text-slate-900">{copy.reviewTitle}</h2>
              <p className="mt-0.5 text-xs font-bold text-slate-500">{copy.selectedCount(selectedRows.length)}</p>
            </div>
            <div className="text-right">
              <div className="text-xs font-extrabold uppercase tracking-wide text-slate-400">{copy.total}</div>
              <div className="text-2xl font-black tabular-nums text-slate-950">{selectedTotal}</div>
            </div>
          </div>

          {selectedRows.length === 0 ? (
            <div className="rounded-md border border-dashed border-slate-300 bg-slate-50 px-3 py-3 text-xs font-semibold text-slate-500">
              {copy.nothingSelected}
            </div>
          ) : (
            <div className="max-h-32 space-y-1 overflow-y-auto pr-1">
              {selectedRows.map((row) => (
                <div key={row.id} className="flex items-center justify-between gap-2 rounded-md bg-slate-50 px-2.5 py-2 text-xs">
                  <span className="min-w-0 truncate font-bold text-slate-700">{row.customerName} · {row.variant} · {copy.revision}: {row.revision}</span>
                  <span className="shrink-0 font-black tabular-nums text-slate-950">× {quantities[row.id] ?? '1'}</span>
                </div>
              ))}
            </div>
          )}

          {hasInvalidQuantity && (
            <p role="alert" className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs font-bold text-red-800">
              {copy.quantityInvalid}
            </p>
          )}

          {printProgress && (
            <div
              role="status"
              aria-live="polite"
              className={`rounded-md border px-3 py-2 text-xs font-bold ${
                printProgress.type === 'success'
                  ? 'border-emerald-200 bg-emerald-50 text-emerald-800'
                  : printProgress.type === 'printing'
                    ? 'border-sky-200 bg-sky-50 text-sky-800'
                    : printProgress.type === 'waiting' || printProgress.type === 'stopped'
                      ? 'border-amber-200 bg-amber-50 text-amber-800'
                      : 'border-red-200 bg-red-50 text-red-800'
              }`}
            >
              <div>{printProgress.message}</div>
              <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-white/80">
                <div
                  className="h-full rounded-full bg-current transition-[width]"
                  style={{ width: `${printProgress.totalChunks > 0 ? (printProgress.completedChunks / printProgress.totalChunks) * 100 : 0}%` }}
                />
              </div>
            </div>
          )}

          <p className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-[11px] font-semibold leading-4 text-amber-900">
            {copy.noDurableResume}
          </p>

          {isWaitingForChunk ? (
            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={() => resolveChunkDecision('stop')}
                disabled={!active}
                className="min-h-12 rounded-md border border-amber-400 bg-amber-50 px-3 text-sm font-extrabold text-amber-900 hover:bg-amber-100"
              >
                {copy.stopNow}
              </button>
              <button
                type="button"
                onClick={() => resolveChunkDecision('continue')}
                disabled={!active}
                className="min-h-12 rounded-md bg-slate-950 px-3 text-sm font-extrabold text-white hover:bg-black"
              >
                {copy.continueNextChunk}
              </button>
            </div>
          ) : isPrinting ? (
            <button
              type="button"
              onClick={() => { stopRequestedRef.current = true; }}
              disabled={!active}
              className="min-h-12 w-full rounded-md border border-amber-400 bg-amber-50 px-3 text-sm font-extrabold text-amber-900 hover:bg-amber-100"
            >
              {copy.stopAfterCurrent}
            </button>
          ) : (
            <button
              type="button"
              onClick={requestPrint}
              disabled={!active || selectedRows.length === 0 || hasInvalidQuantity || !!busyAction}
              className="min-h-12 w-full rounded-md bg-slate-950 px-3 text-sm font-extrabold text-white shadow-sm hover:bg-black disabled:cursor-not-allowed disabled:bg-slate-300 inline-flex items-center justify-center gap-2"
            >
              <Printer size={18} />
              {copy.printSelected}{selectedTotal > 0 ? ` (${selectedTotal})` : ''}
            </button>
          )}
        </section>
      </aside>

      <ConfirmActionDialog
        open={active && !!retireCandidate}
        tier="light"
        title={copy.retireTitle}
        body={copy.retireBody}
        itemName={retireCandidate ? `${retireCandidate.customerName} · ${retireCandidate.variant} · ${copy.revision}: ${retireCandidate.revision}` : undefined}
        confirmLabel={copy.retireConfirm}
        cancelLabel={copy.cancel}
        danger
        busy={!!retireCandidate && busyAction === `retire:${retireCandidate.id}`}
        onConfirm={() => { if (active) void handleRetire(); }}
        onCancel={() => { if (!busyAction) setRetireCandidate(null); }}
      />

      <ConfirmActionDialog
        open={active && !!pendingPrintPlan}
        tier="light"
        title={copy.highTitle}
        body={copy.highBody((pendingPrintPlan || []).reduce((sum, row) => sum + row.quantity, 0))}
        itemName={pendingPrintPlan ? `${pendingPrintPlan.length} · ${copy.total.toLowerCase()}: ${pendingPrintPlan.reduce((sum, row) => sum + row.quantity, 0)}` : undefined}
        confirmLabel={copy.confirmPrint}
        cancelLabel={copy.cancel}
        busy={isPrinting}
        onConfirm={() => { if (active && pendingPrintPlan) void executePrintPlan(pendingPrintPlan); }}
        onCancel={() => { if (!isPrinting) setPendingPrintPlan(null); }}
      />
    </section>
  );
}
