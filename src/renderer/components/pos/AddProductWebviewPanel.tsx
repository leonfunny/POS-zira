import { useEffect, useRef, useState } from 'react';
import { buildCartLineFromCreated, CreatedProductPayload } from '../../lib/add-embed-bridge';

interface Props {
  open: boolean;
  salonCode?: string;
  onProductCreated: (line: ReturnType<typeof buildCartLineFromCreated>) => void;
  onClose: () => void;
}

const ADD_BASE = 'https://chesaigon.eshoper.pro/add';

export default function AddProductWebviewPanel({ open, salonCode, onProductCreated, onClose }: Props) {
  const webviewRef = useRef<any>(null);
  const [preloadPath, setPreloadPath] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  // Resolve the absolute file:// preload path from main (sandboxed renderer
  // cannot compute it). Only render the <webview> once we have it.
  useEffect(() => {
    if (!open) return;
    setFailed(false);
    (window as any).electronAPI
      ?.getAddbridgePreloadPath?.()
      .then((p: string) => setPreloadPath(p || ''))
      .catch(() => setPreloadPath(''));
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const wv = webviewRef.current;
    if (!wv) return;
    const onIpc = (e: any) => {
      if (e.channel === 'enail:product-created') {
        const payload = e.args?.[0] as CreatedProductPayload;
        if (payload?.variantId) onProductCreated(buildCartLineFromCreated(payload));
      }
    };
    const onFail = () => setFailed(true);
    wv.addEventListener('ipc-message', onIpc);
    wv.addEventListener('did-fail-load', onFail);
    return () => {
      wv.removeEventListener('ipc-message', onIpc);
      wv.removeEventListener('did-fail-load', onFail);
    };
  }, [open, preloadPath, onProductCreated]);

  if (!open) return null;
  const src = `${ADD_BASE}?embed=1${salonCode ? `&salonCode=${encodeURIComponent(salonCode)}` : ''}`;

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-white">
      <div className="flex items-center justify-between border-b border-gray-200 px-4 py-2">
        <span className="font-bold text-brand-600">Tạo sản phẩm</span>
        <div className="flex items-center gap-2">
          {failed && (
            <button
              onClick={() => (window as any).electronAPI?.openExternal?.(src)}
              className="rounded-lg bg-amber-100 px-3 py-2 text-sm font-medium text-amber-800 hover:bg-amber-200"
            >
              Mở trình duyệt ngoài
            </button>
          )}
          <button onClick={onClose} className="rounded-lg bg-gray-100 px-4 py-2 font-medium hover:bg-gray-200">
            Đóng
          </button>
        </div>
      </div>
      {failed ? (
        <div className="flex flex-1 items-center justify-center p-8 text-center text-gray-500">
          Không tải được trang tạo sản phẩm. Kiểm tra mạng rồi thử lại, hoặc mở trình duyệt ngoài.
        </div>
      ) : preloadPath === null ? (
        <div className="flex flex-1 items-center justify-center text-gray-400">Đang mở…</div>
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
