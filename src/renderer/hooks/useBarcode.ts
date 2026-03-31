/** useBarcode – wraps electronAPI barcode scanner events */

import { useEffect } from 'react';

export function useBarcode(onScan: (barcode: string) => void) {
  useEffect(() => {
    const unsub = window.electronAPI.onBarcodeScanned(onScan);
    return unsub;
  }, [onScan]);
}
