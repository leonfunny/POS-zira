import { useEffect, useRef, useState } from 'react';
import { buildCartLineFromCreated, CreatedProductPayload } from '../../lib/add-embed-bridge';

interface Props {
  open: boolean;
  salonCode?: string;
  onProductCreated: (line: ReturnType<typeof buildCartLineFromCreated>) => void;
  onExistingProductScanned?: (ean: string) => Promise<boolean> | boolean;
  onClose: () => void;
}

const ADD_BASE = 'https://chesaigon.eshoper.pro/add';
const PRODUCT_INTENT_MESSAGE = 'enail:add-product-intent';
const PRODUCT_INTENT_UPDATED_MESSAGE = 'enail:add-product-intent-updated';
type AddProductSellBy = 'PIECE' | 'WEIGHT';

function getAddBridgePreloadPath(): Promise<string> {
  const api = (window as any).electronAPI;
  const resolver = api?.pos?.getAddbridgePreloadPath || api?.getAddbridgePreloadPath;
  return typeof resolver === 'function' ? resolver() : Promise.resolve('');
}

function openExternalUrl(url: string): void {
  const api = (window as any).electronAPI;
  const opener = api?.shell?.openExternal || api?.openExternal;
  if (typeof opener === 'function') void opener(url);
}

export default function AddProductWebviewPanel({ open, salonCode, onProductCreated, onExistingProductScanned, onClose }: Props) {
  const webviewRef = useRef<any>(null);
  const lastCreatedRef = useRef<{ key: string; at: number } | null>(null);
  const [preloadPath, setPreloadPath] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [scannedEan, setScannedEan] = useState('');
  const [sellBy, setSellBy] = useState<AddProductSellBy>('PIECE');
  const [autoEanBusy, setAutoEanBusy] = useState(false);
  const [autoEanError, setAutoEanError] = useState<string | null>(null);
  const autoEanTimeoutRef = useRef<number | null>(null);

  const sendIntentToWebview = (nextEan = scannedEan, nextSellBy = sellBy, options?: { autoGenerateEan?: boolean }) => {
    const wv = webviewRef.current;
    if (!wv?.send) return;
    wv.send(PRODUCT_INTENT_MESSAGE, {
      ean: nextEan.trim(),
      sellBy: nextSellBy,
      saleUnit: nextSellBy === 'WEIGHT' ? 'kg' : 'szt',
      autoGenerateEan: options?.autoGenerateEan === true,
    });
  };

  const requestAutoEan = () => {
    const wv = webviewRef.current;
    setAutoEanError(null);
    if (!wv?.send) {
      setAutoEanError('Chưa mở xong trang tạo sản phẩm');
      return;
    }
    setAutoEanBusy(true);
    if (autoEanTimeoutRef.current) window.clearTimeout(autoEanTimeoutRef.current);
    autoEanTimeoutRef.current = window.setTimeout(() => setAutoEanBusy(false), 8000);
    sendIntentToWebview(scannedEan, sellBy, { autoGenerateEan: true });
  };

  // Resolve the absolute file:// preload path from main (sandboxed renderer
  // cannot compute it). Only render the <webview> once we have it.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setFailed(false);
    setPreloadPath(null);
    getAddBridgePreloadPath()
      .then((p: string) => {
        if (!cancelled) setPreloadPath(p || '');
      })
      .catch(() => {
        if (!cancelled) {
          setPreloadPath('');
          setFailed(true);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    document.body.dataset.posAddProductOpen = 'true';
    return () => {
      if (document.body.dataset.posAddProductOpen === 'true') {
        delete document.body.dataset.posAddProductOpen;
      }
      if (autoEanTimeoutRef.current) window.clearTimeout(autoEanTimeoutRef.current);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const unsubscribe = (window as any).electronAPI?.onBarcodeScanned?.(async (barcode: string) => {
      const ean = String(barcode || '').trim();
      if (!ean) return;
      if (await onExistingProductScanned?.(ean)) return;
      setScannedEan(ean);
      sendIntentToWebview(ean, sellBy);
    });
    return () => unsubscribe?.();
  }, [open, sellBy, onExistingProductScanned]);

  useEffect(() => {
    if (!open) return;
    const wv = webviewRef.current;
    if (!wv) return;
    const onIpc = (e: any) => {
      if (e.channel === 'enail:product-created') {
        const payload = e.args?.[0] as CreatedProductPayload;
        if (!payload?.variantId) return;
        const key = `${payload.variantId}:${payload.ean || payload.sku || ''}`;
        const now = Date.now();
        if (lastCreatedRef.current?.key === key && now - lastCreatedRef.current.at < 3000) return;
        lastCreatedRef.current = { key, at: now };
        onProductCreated(buildCartLineFromCreated(payload));
      } else if (e.channel === PRODUCT_INTENT_UPDATED_MESSAGE) {
        const payload = e.args?.[0] as { ean?: string; error?: string };
        if (autoEanTimeoutRef.current) window.clearTimeout(autoEanTimeoutRef.current);
        setAutoEanBusy(false);
        if (payload?.ean) {
          setScannedEan(payload.ean);
          setAutoEanError(null);
        } else if (payload?.error) {
          setAutoEanError('Không tạo được EAN tự động');
        }
      }
    };
    const onFail = (event: any) => {
      if (event?.isMainFrame === false || event?.errorCode === -3) return;
      setFailed(true);
    };
    const onReady = () => {
      setFailed(false);
      sendIntentToWebview();
    };
    wv.addEventListener('ipc-message', onIpc);
    wv.addEventListener('did-fail-load', onFail);
    wv.addEventListener('dom-ready', onReady);
    return () => {
      wv.removeEventListener('ipc-message', onIpc);
      wv.removeEventListener('did-fail-load', onFail);
      wv.removeEventListener('dom-ready', onReady);
    };
  }, [open, preloadPath, onProductCreated, scannedEan, sellBy]);

  useEffect(() => {
    if (!open || preloadPath === null) return;
    sendIntentToWebview();
  }, [open, preloadPath, scannedEan, sellBy]);

  if (!open) return null;
  const src = `${ADD_BASE}?embed=1${salonCode ? `&salonCode=${encodeURIComponent(salonCode)}` : ''}`;

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-white">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 px-4 py-2">
        <div className="min-w-0">
          <span className="font-bold text-brand-600">Tạo sản phẩm</span>
          <div className="mt-1 text-xs text-slate-500">
            {scannedEan ? `EAN: ${scannedEan}` : 'Quét EAN để tự điền vào sản phẩm mới'}
          </div>
        </div>
        <div className="flex items-center gap-2 rounded-lg bg-slate-100 p-1">
          <button
            type="button"
            onClick={() => {
              setSellBy('PIECE');
              sendIntentToWebview(scannedEan, 'PIECE');
            }}
            className={`rounded-md px-3 py-1.5 text-sm font-semibold ${sellBy === 'PIECE' ? 'bg-white text-brand-700 shadow-sm' : 'text-slate-600 hover:text-slate-900'}`}
          >
            Giá / szt
          </button>
          <button
            type="button"
            onClick={() => {
              setSellBy('WEIGHT');
              sendIntentToWebview(scannedEan, 'WEIGHT');
            }}
            className={`rounded-md px-3 py-1.5 text-sm font-semibold ${sellBy === 'WEIGHT' ? 'bg-white text-brand-700 shadow-sm' : 'text-slate-600 hover:text-slate-900'}`}
          >
            Giá / kg
          </button>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={requestAutoEan}
            disabled={autoEanBusy || failed || preloadPath === null}
            className="rounded-lg bg-brand-600 px-3 py-2 text-sm font-semibold text-white hover:bg-brand-700 disabled:cursor-not-allowed disabled:opacity-60"
            title={autoEanError || 'Tự tạo EAN'}
          >
            {autoEanBusy ? 'Đang tạo EAN...' : 'Tự tạo EAN'}
          </button>
          {autoEanError ? <span className="text-xs font-semibold text-red-600">{autoEanError}</span> : null}
          {failed && (
            <button
              onClick={() => openExternalUrl(src)}
              className="rounded-lg bg-amber-100 px-3 py-2 text-sm font-medium text-amber-800 hover:bg-amber-200"
            >
              Mở trình duyệt ngoài
            </button>
          )}
          <button onClick={onClose} className="rounded-lg bg-slate-100 px-4 py-2 font-medium hover:bg-slate-200">
            Đóng
          </button>
        </div>
      </div>
      {failed ? (
        <div className="flex flex-1 items-center justify-center p-8 text-center text-slate-500">
          Không tải được trang tạo sản phẩm. Kiểm tra mạng rồi thử lại, hoặc mở trình duyệt ngoài.
        </div>
      ) : preloadPath === null ? (
        <div className="flex flex-1 items-center justify-center text-slate-400">Đang mở…</div>
      ) : (
        <webview
          ref={webviewRef as any}
          src={src}
          preload={preloadPath || undefined}
          partition="persist:enail-add"
          style={{ width: '100%', height: '100%', flex: 1 }}
        />
      )}
    </div>
  );
}
