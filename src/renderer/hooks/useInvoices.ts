/** useInvoices – wraps electronAPI invoice operations */

import { useState, useEffect, useCallback } from 'react';
import rlog from '../utils/logger';
import type {
  InvoiceRow,
  InvoiceCreateDTO,
  InvoiceListFilter,
} from '../../shared/types';

export function useInvoices(filter?: InvoiceListFilter) {
  const [invoices, setInvoices] = useState<InvoiceRow[]>([]);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const result = await window.electronAPI.invoice.list(filter);
      if (result.success) {
        setInvoices(result.data ?? []);
      } else {
        setInvoices([]);
        rlog.error('[useInvoices] Failed to load:', result.error);
      }
    } catch (err) {
      setInvoices([]);
      rlog.error('[useInvoices] Failed to load:', err);
    } finally {
      setLoading(false);
    }
  }, [filter]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const create = useCallback(async (data: InvoiceCreateDTO) => {
    const result = await window.electronAPI.invoice.create(data);
    await refresh();
    return result;
  }, [refresh]);

  const update = useCallback(async (id: string, data: Partial<InvoiceCreateDTO>) => {
    const result = await window.electronAPI.invoice.update(id, data);
    await refresh();
    return result;
  }, [refresh]);

  const remove = useCallback(async (id: string) => {
    const result = await window.electronAPI.invoice.delete(id);
    await refresh();
    return result;
  }, [refresh]);

  const issue = useCallback(async (id: string) => {
    await window.electronAPI.invoice.issue(id);
    await refresh();
  }, [refresh]);

  const cancel = useCallback(async (id: string, reason: string) => {
    await window.electronAPI.invoice.cancel(id, reason);
    await refresh();
  }, [refresh]);

  const print = useCallback(async (id: string) => {
    await window.electronAPI.invoice.print(id);
  }, []);

  const markPaid = useCallback(async (id: string) => {
    await window.electronAPI.invoice.markPaid(id);
    await refresh();
  }, [refresh]);

  const duplicate = useCallback(async (id: string) => {
    await window.electronAPI.invoice.duplicate(id);
    await refresh();
  }, [refresh]);

  return {
    invoices,
    loading,
    create,
    update,
    remove,
    issue,
    cancel,
    print,
    markPaid,
    duplicate,
    refresh,
  };
}
