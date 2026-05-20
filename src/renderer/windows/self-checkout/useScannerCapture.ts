import {
  type KeyboardEvent as ReactKeyboardEvent,
  useCallback,
  useEffect,
  useRef,
} from 'react';

interface UseScannerCaptureOptions {
  onScan: (code: string) => Promise<unknown> | unknown;
  suspendCapture?: () => boolean;
}

export function useScannerCapture({
  onScan,
  suspendCapture,
}: UseScannerCaptureOptions) {
  const scannerInputRef = useRef<HTMLInputElement>(null);
  const scannerBuffer = useRef<string>('');
  const scannerLastKey = useRef<number>(0);
  const lastScanRef = useRef<{ code: string; at: number } | null>(null);

  const handleScannedCode = useCallback(
    (rawCode: string) => {
      const code = rawCode.trim();
      if (code.length < 4) return;
      const now = Date.now();
      if (lastScanRef.current?.code === code && now - lastScanRef.current.at < 600) return;
      lastScanRef.current = { code, at: now };
      void onScan(code);
    },
    [onScan],
  );

  const captureSuspended = useCallback(() => {
    return Boolean(suspendCapture?.());
  }, [suspendCapture]);

  const focusScannerInput = useCallback(() => {
    if (captureSuspended()) return;
    scannerInputRef.current?.focus();
  }, [captureSuspended]);

  const handleScannerInputKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLInputElement>) => {
      if (event.key !== 'Enter') return;
      event.preventDefault();
      const code = event.currentTarget.value;
      event.currentTarget.value = '';
      handleScannedCode(code);
    },
    [handleScannedCode],
  );

  useEffect(() => {
    focusScannerInput();
    const handler = () => setTimeout(focusScannerInput, 50);
    document.addEventListener('pointerdown', handler);
    const interval = setInterval(focusScannerInput, 1000);
    return () => {
      document.removeEventListener('pointerdown', handler);
      clearInterval(interval);
    };
  }, [focusScannerInput]);

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (captureSuspended()) return;
      if ((event.target as HTMLElement | null)?.dataset?.scannerCapture === 'true') return;
      const target = event.target as HTMLElement | null;
      if (
        target?.tagName === 'INPUT'
        || target?.tagName === 'TEXTAREA'
        || target?.tagName === 'SELECT'
        || target?.isContentEditable
      ) return;

      const now = Date.now();
      if (now - scannerLastKey.current > 150) {
        scannerBuffer.current = '';
      }
      scannerLastKey.current = now;
      if (event.key === 'Enter') {
        const code = scannerBuffer.current.trim();
        scannerBuffer.current = '';
        handleScannedCode(code);
        return;
      }
      if (event.key.length === 1 && /[0-9A-Za-z\-_]/.test(event.key)) {
        scannerBuffer.current += event.key;
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [captureSuspended, handleScannedCode]);

  useEffect(() => {
    const unsubscribe = window.electronAPI?.onBarcodeScanned?.((barcode: string) => {
      if (!captureSuspended()) handleScannedCode(barcode);
    });
    return () => {
      if (typeof unsubscribe === 'function') unsubscribe();
    };
  }, [captureSuspended, handleScannedCode]);

  return {
    scannerInputRef,
    handleScannerInputKeyDown,
  };
}
