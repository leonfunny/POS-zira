import { InvoiceRow, KsefStatus } from '../../shared/types';
import { invoiceRepo } from '../database/repos/invoice-repo';
import { sellerSettingsRepo } from '../database/repos/seller-settings-repo';
import logger from '../logger';

/**
 * KSeF Sync Service
 * Syncs invoices to backend for KSeF submission
 * Print-agent doesn't call KSeF directly - backend handles KSeF API
 */

interface KsefSendResult {
  success: boolean;
  ksefNumber?: string;
  error?: string;
}

interface BackendConfig {
  apiUrl: string;
  apiKey: string;
}

let backendConfig: BackendConfig | null = null;

/**
 * Set backend configuration
 */
export function setBackendConfig(config: BackendConfig): void {
  backendConfig = config;
  logger.info('[KsefSync] Backend config set');
}

/**
 * Send invoice to backend for KSeF submission
 */
export async function sendToKsef(invoiceId: string): Promise<KsefSendResult> {
  const result = invoiceRepo.getById(invoiceId);
  if (!result) {
    return { success: false, error: 'Invoice not found' };
  }

  const { invoice, items } = result;

  // Validate invoice can be sent
  if (invoice.status === 'DRAFT') {
    return { success: false, error: 'Cannot send draft invoice to KSeF' };
  }

  if (invoice.type === 'PROFORMA') {
    return { success: false, error: 'Proforma invoices are not sent to KSeF' };
  }

  if (invoice.ksef_number) {
    return {
      success: true,
      ksefNumber: invoice.ksef_number,
      error: 'Invoice already sent to KSeF',
    };
  }

  // Mark as sending
  invoiceRepo.updateKsefStatus(invoiceId, 'SENDING', null, null);

  try {
    // If no backend config, simulate local success (for offline mode)
    if (!backendConfig) {
      logger.warn('[KsefSync] No backend config - operating in offline mode');
      // In offline mode, mark as pending sync
      invoiceRepo.updateKsefStatus(invoiceId, 'PENDING', null, 'Offline - will sync when connected');
      return {
        success: false,
        error: 'Backend not configured - invoice queued for sync',
      };
    }

    // Send to backend
    const response = await fetch(`${backendConfig.apiUrl}/accounting/ksef/send/${invoice.backend_id || invoiceId}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${backendConfig.apiKey}`,
      },
      body: JSON.stringify({
        // Send invoice data in case backend doesn't have it yet
        invoice: {
          ...invoice,
          items,
        },
      }),
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({ message: response.statusText }));
      throw new Error(errorData.message || `HTTP ${response.status}`);
    }

    const data = await response.json();

    if (data.success && data.data?.ksefNumber) {
      // Success - update invoice
      invoiceRepo.updateKsefStatus(
        invoiceId,
        'ACCEPTED',
        data.data.ksefNumber,
        null,
      );

      sellerSettingsRepo.updateKsefStatus(null);

      logger.info(`[KsefSync] Invoice ${invoice.invoice_number} sent to KSeF: ${data.data.ksefNumber}`);

      return {
        success: true,
        ksefNumber: data.data.ksefNumber,
      };
    } else {
      throw new Error(data.message || 'Unknown error');
    }
  } catch (error: any) {
    const errorMessage = error.message || 'Unknown error';

    // Update invoice with error
    invoiceRepo.updateKsefStatus(invoiceId, 'ERROR', null, errorMessage);
    sellerSettingsRepo.updateKsefStatus(errorMessage);

    logger.error(`[KsefSync] Failed to send invoice ${invoice.invoice_number}: ${errorMessage}`);

    return {
      success: false,
      error: errorMessage,
    };
  }
}

/**
 * Send multiple invoices to KSeF (batch)
 */
export async function sendBatchToKsef(invoiceIds: string[]): Promise<{
  sent: number;
  failed: number;
  results: Array<{ invoiceId: string; success: boolean; ksefNumber?: string; error?: string }>;
}> {
  const results: Array<{ invoiceId: string; success: boolean; ksefNumber?: string; error?: string }> = [];
  let sent = 0;
  let failed = 0;

  for (const invoiceId of invoiceIds) {
    const result = await sendToKsef(invoiceId);
    results.push({
      invoiceId,
      ...result,
    });

    if (result.success) {
      sent++;
    } else {
      failed++;
    }
  }

  return { sent, failed, results };
}

/**
 * Retry failed KSeF submissions
 */
export async function retryFailedInvoices(): Promise<number> {
  const failedInvoices = invoiceRepo.getKsefPending();
  let retried = 0;

  for (const invoice of failedInvoices) {
    // Skip if too many retries
    if (invoice.ksef_retry_count >= 3) {
      continue;
    }

    const result = await sendToKsef(invoice.id);
    if (result.success) {
      retried++;
    }
  }

  return retried;
}

/**
 * Get KSeF statistics
 */
export function getKsefStats(): {
  pending: number;
  sending: number;
  sent: number;
  accepted: number;
  rejected: number;
  error: number;
} {
  return invoiceRepo.getKsefStats();
}
