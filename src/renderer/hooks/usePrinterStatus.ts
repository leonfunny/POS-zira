/**
 * usePrinterStatus – wraps electronAPI printer operations
 *
 * Lists available printers and provides test print functionality.
 */

import { useState, useEffect, useCallback } from 'react';

export function usePrinterStatus() {
  const [printers, setPrinters] = useState<Array<{name: string; port: string}>>([]);
  const [loading, setLoading] = useState(true);
  const [testing, setTesting] = useState(false);
  const [lastTestResult, setLastTestResult] = useState<{
    success: boolean;
    error?: string;
    results?: Record<string, boolean>;
  } | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const list = await window.electronAPI.listWindowsPrinters();
      setPrinters(list);
    } catch {
      setPrinters([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const testPrint = useCallback(async () => {
    setTesting(true);
    try {
      const result = await window.electronAPI.testPrint();
      setLastTestResult(result);
      return result;
    } finally {
      setTesting(false);
    }
  }, []);

  const testPrinterByType = useCallback(async (printerType: string) => {
    setTesting(true);
    try {
      const result = await window.electronAPI.testPrinterByType(printerType);
      setLastTestResult(result);
      return result;
    } finally {
      setTesting(false);
    }
  }, []);

  return {
    printers,
    loading,
    testing,
    lastTestResult,
    refresh,
    testPrint,
    testPrinterByType,
  };
}
