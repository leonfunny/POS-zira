import { ipcMain, BrowserWindow } from 'electron';
import {
  IPC_CHANNELS,
  InvoiceType,
  InvoiceCreateDTO,
  InvoiceListFilter,
  InvoiceCustomerCreateDTO,
  AccountingProductCreateDTO,
  SellerSettingsUpdateDTO,
  InvoicePrintOptions,
  VatSummaryEntry,
} from '../../shared/types';
import { invoiceRepo } from '../database/repos/invoice-repo';
import { invoiceCustomerRepo } from '../database/repos/invoice-customer-repo';
import { invoiceProductRepo } from '../database/repos/invoice-product-repo';
import { invoicePaymentRepo } from '../database/repos/invoice-payment-repo';
import { sellerSettingsRepo } from '../database/repos/seller-settings-repo';
import { InvoiceFormatter } from './invoice-formatter';
import { InvoiceA4Formatter } from './invoice-a4-formatter';
import { nipLookupService } from './nip-lookup';
import { sendToKsef, sendBatchToKsef, getKsefStats } from './ksef-sync';
import logger from '../logger';

// Formatters
const thermalFormatter = new InvoiceFormatter(80, 48);
const a4Formatter = new InvoiceA4Formatter();

/**
 * Register all invoice-related IPC handlers
 */
export function registerInvoiceHandlers(
  getThermalDriver: () => any,
  getA4Printer: () => string | null,
): void {
  // ==========================================
  // Invoice CRUD
  // ==========================================

  ipcMain.handle(IPC_CHANNELS.INVOICE_LIST, async (_, filter: InvoiceListFilter) => {
    try {
      const invoices = invoiceRepo.list(filter);
      return { success: true, data: invoices };
    } catch (error: any) {
      logger.error('[InvoiceController] List failed:', error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle(IPC_CHANNELS.INVOICE_GET, async (_, id: string) => {
    try {
      const result = invoiceRepo.getById(id);
      if (!result) {
        return { success: false, error: 'Invoice not found' };
      }
      // Parse VAT summary
      const vatSummary: VatSummaryEntry[] = result.invoice.vat_summary
        ? JSON.parse(result.invoice.vat_summary)
        : [];
      return { success: true, data: { ...result, vatSummary } };
    } catch (error: any) {
      logger.error('[InvoiceController] Get failed:', error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle(IPC_CHANNELS.INVOICE_CREATE, async (_, data: InvoiceCreateDTO) => {
    try {
      const result = invoiceRepo.create(data);
      const vatSummary: VatSummaryEntry[] = result.invoice.vat_summary
        ? JSON.parse(result.invoice.vat_summary)
        : [];
      return { success: true, data: { ...result, vatSummary } };
    } catch (error: any) {
      logger.error('[InvoiceController] Create failed:', error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle(IPC_CHANNELS.INVOICE_UPDATE, async (_, id: string, data: Partial<InvoiceCreateDTO>) => {
    try {
      const result = invoiceRepo.update(id, data);
      const vatSummary: VatSummaryEntry[] = result.invoice.vat_summary
        ? JSON.parse(result.invoice.vat_summary)
        : [];
      return { success: true, data: { ...result, vatSummary } };
    } catch (error: any) {
      logger.error('[InvoiceController] Update failed:', error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle(IPC_CHANNELS.INVOICE_DELETE, async (_, id: string) => {
    try {
      invoiceRepo.delete(id);
      return { success: true };
    } catch (error: any) {
      logger.error('[InvoiceController] Delete failed:', error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle(IPC_CHANNELS.INVOICE_ISSUE, async (_, id: string) => {
    try {
      const invoice = invoiceRepo.issue(id);

      // Auto-send to KSeF if enabled
      if (sellerSettingsRepo.isKsefAutoSendEnabled()) {
        if (invoiceRepo.shouldSendToKsef(invoice)) {
          logger.info(`[InvoiceController] Auto-sending invoice ${invoice.invoice_number} to KSeF`);
          // Don't await - send in background
          sendToKsef(id).catch((err) => {
            logger.error(`[InvoiceController] KSeF auto-send failed: ${err.message}`);
          });
        }
      }

      return { success: true, data: invoice };
    } catch (error: any) {
      logger.error('[InvoiceController] Issue failed:', error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle(IPC_CHANNELS.INVOICE_CANCEL, async (_, id: string, reason: string) => {
    try {
      const invoice = invoiceRepo.cancel(id, reason);
      return { success: true, data: invoice };
    } catch (error: any) {
      logger.error('[InvoiceController] Cancel failed:', error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle(IPC_CHANNELS.INVOICE_DUPLICATE, async (_, id: string) => {
    try {
      const result = invoiceRepo.duplicate(id);
      const vatSummary: VatSummaryEntry[] = result.invoice.vat_summary
        ? JSON.parse(result.invoice.vat_summary)
        : [];
      return { success: true, data: { ...result, vatSummary } };
    } catch (error: any) {
      logger.error('[InvoiceController] Duplicate failed:', error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle(IPC_CHANNELS.INVOICE_MARK_PAID, async (_, id: string) => {
    try {
      const invoice = invoiceRepo.markPaid(id);
      return { success: true, data: invoice };
    } catch (error: any) {
      logger.error('[InvoiceController] Mark paid failed:', error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle(IPC_CHANNELS.INVOICE_ADD_PAYMENT, async (_, invoiceId: string, amount: number, method?: string, reference?: string) => {
    try {
      const invoice = invoiceRepo.addPayment(invoiceId, amount, method, reference);
      return { success: true, data: invoice };
    } catch (error: any) {
      logger.error('[InvoiceController] Add payment failed:', error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle(IPC_CHANNELS.INVOICE_GET_NEXT_NUMBER, async (_, type: InvoiceType) => {
    try {
      const number = invoiceRepo.getNextNumber(type);
      return { success: true, data: number };
    } catch (error: any) {
      logger.error('[InvoiceController] Get next number failed:', error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle(IPC_CHANNELS.INVOICE_CREATE_CORRECTION, async (_, originalId: string, reason: string, newItems: any[]) => {
    try {
      const result = invoiceRepo.createCorrection(originalId, reason, newItems);
      const vatSummary: VatSummaryEntry[] = result.invoice.vat_summary
        ? JSON.parse(result.invoice.vat_summary)
        : [];
      return { success: true, data: { ...result, vatSummary } };
    } catch (error: any) {
      logger.error('[InvoiceController] Create correction failed:', error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle(IPC_CHANNELS.INVOICE_CONVERT_PROFORMA, async (_, proformaId: string) => {
    try {
      const result = invoiceRepo.convertProforma(proformaId);
      const vatSummary: VatSummaryEntry[] = result.invoice.vat_summary
        ? JSON.parse(result.invoice.vat_summary)
        : [];
      return { success: true, data: { ...result, vatSummary } };
    } catch (error: any) {
      logger.error('[InvoiceController] Convert proforma failed:', error);
      return { success: false, error: error.message };
    }
  });

  // ==========================================
  // Printing
  // ==========================================

  ipcMain.handle(IPC_CHANNELS.INVOICE_PRINT, async (_, id: string, options?: InvoicePrintOptions) => {
    try {
      const result = invoiceRepo.getById(id);
      if (!result) {
        return { success: false, error: 'Invoice not found' };
      }

      const vatSummary: VatSummaryEntry[] = result.invoice.vat_summary
        ? JSON.parse(result.invoice.vat_summary)
        : [];

      const thermalDriver = getThermalDriver();
      if (!thermalDriver || !thermalDriver.isConnected()) {
        return { success: false, error: 'Thermal printer not connected' };
      }

      // Format based on invoice type
      let buffer: Buffer;
      if (result.invoice.type === 'RECEIPT') {
        buffer = thermalFormatter.formatReceipt(result.invoice, result.items, vatSummary);
      } else {
        buffer = thermalFormatter.formatInvoice(result.invoice, result.items, vatSummary);
      }

      // Print
      await thermalDriver.printRaw(buffer);

      // Mark as printed
      invoiceRepo.markPrinted(id);

      logger.info(`[InvoiceController] Printed invoice: ${result.invoice.invoice_number}`);
      return { success: true };
    } catch (error: any) {
      logger.error('[InvoiceController] Print failed:', error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle(IPC_CHANNELS.INVOICE_PRINT_A4, async (_, id: string) => {
    try {
      const result = invoiceRepo.getById(id);
      if (!result) {
        return { success: false, error: 'Invoice not found' };
      }

      const vatSummary: VatSummaryEntry[] = result.invoice.vat_summary
        ? JSON.parse(result.invoice.vat_summary)
        : [];

      // Generate HTML
      const html = a4Formatter.formatInvoice(result.invoice, result.items, vatSummary);

      // Create hidden window for printing
      const printWindow = new BrowserWindow({
        show: false,
        width: 794,  // A4 at 96 DPI
        height: 1123,
        webPreferences: {
          nodeIntegration: false,
          contextIsolation: true,
        },
      });

      // SECURITY: Navigation guards — print window should never navigate away
      printWindow.webContents.on('will-navigate', (event) => { event.preventDefault(); });
      printWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' as const }));

      // Load HTML
      await printWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);

      // Get A4 printer
      const a4Printer = getA4Printer();

      // Print
      await new Promise<void>((resolve, reject) => {
        printWindow.webContents.print(
          {
            silent: true,
            printBackground: true,
            deviceName: a4Printer || undefined,
            margins: { marginType: 'custom', top: 0, bottom: 0, left: 0, right: 0 },
          },
          (success, failureReason) => {
            printWindow.close();
            if (success) {
              resolve();
            } else {
              reject(new Error(failureReason || 'Print failed'));
            }
          },
        );
      });

      // Mark as printed
      invoiceRepo.markPrinted(id);

      logger.info(`[InvoiceController] Printed A4 invoice: ${result.invoice.invoice_number}`);
      return { success: true };
    } catch (error: any) {
      logger.error('[InvoiceController] Print A4 failed:', error);
      return { success: false, error: error.message };
    }
  });

  // ==========================================
  // Customers
  // ==========================================

  ipcMain.handle(IPC_CHANNELS.INVOICE_CUSTOMER_LIST, async () => {
    try {
      const customers = invoiceCustomerRepo.getAll();
      return { success: true, data: customers };
    } catch (error: any) {
      logger.error('[InvoiceController] Customer list failed:', error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle(IPC_CHANNELS.INVOICE_CUSTOMER_SEARCH, async (_, query: string) => {
    try {
      const customers = invoiceCustomerRepo.search(query);
      return { success: true, data: customers };
    } catch (error: any) {
      logger.error('[InvoiceController] Customer search failed:', error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle(IPC_CHANNELS.INVOICE_CUSTOMER_GET, async (_, id: string) => {
    try {
      const customer = invoiceCustomerRepo.getById(id);
      if (!customer) {
        return { success: false, error: 'Customer not found' };
      }
      return { success: true, data: customer };
    } catch (error: any) {
      logger.error('[InvoiceController] Customer get failed:', error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle(IPC_CHANNELS.INVOICE_CUSTOMER_CREATE, async (_, data: InvoiceCustomerCreateDTO) => {
    try {
      const customer = invoiceCustomerRepo.create(data);
      return { success: true, data: customer };
    } catch (error: any) {
      logger.error('[InvoiceController] Customer create failed:', error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle(IPC_CHANNELS.INVOICE_CUSTOMER_UPDATE, async (_, id: string, data: Partial<InvoiceCustomerCreateDTO>) => {
    try {
      const customer = invoiceCustomerRepo.update(id, data);
      return { success: true, data: customer };
    } catch (error: any) {
      logger.error('[InvoiceController] Customer update failed:', error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle(IPC_CHANNELS.INVOICE_CUSTOMER_DELETE, async (_, id: string) => {
    try {
      invoiceCustomerRepo.delete(id);
      return { success: true };
    } catch (error: any) {
      logger.error('[InvoiceController] Customer delete failed:', error);
      return { success: false, error: error.message };
    }
  });

  // ==========================================
  // Products
  // ==========================================

  ipcMain.handle(IPC_CHANNELS.INVOICE_PRODUCT_LIST, async () => {
    try {
      const products = invoiceProductRepo.getAll();
      return { success: true, data: products };
    } catch (error: any) {
      logger.error('[InvoiceController] Product list failed:', error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle(IPC_CHANNELS.INVOICE_PRODUCT_SEARCH, async (_, query: string) => {
    try {
      const products = invoiceProductRepo.search(query);
      return { success: true, data: products };
    } catch (error: any) {
      logger.error('[InvoiceController] Product search failed:', error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle(IPC_CHANNELS.INVOICE_PRODUCT_GET, async (_, id: string) => {
    try {
      const product = invoiceProductRepo.getById(id);
      if (!product) {
        return { success: false, error: 'Product not found' };
      }
      return { success: true, data: product };
    } catch (error: any) {
      logger.error('[InvoiceController] Product get failed:', error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle(IPC_CHANNELS.INVOICE_PRODUCT_CREATE, async (_, data: AccountingProductCreateDTO) => {
    try {
      const product = invoiceProductRepo.create(data);
      return { success: true, data: product };
    } catch (error: any) {
      logger.error('[InvoiceController] Product create failed:', error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle(IPC_CHANNELS.INVOICE_PRODUCT_UPDATE, async (_, id: string, data: Partial<AccountingProductCreateDTO>) => {
    try {
      const product = invoiceProductRepo.update(id, data);
      return { success: true, data: product };
    } catch (error: any) {
      logger.error('[InvoiceController] Product update failed:', error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle(IPC_CHANNELS.INVOICE_PRODUCT_DELETE, async (_, id: string) => {
    try {
      invoiceProductRepo.delete(id);
      return { success: true };
    } catch (error: any) {
      logger.error('[InvoiceController] Product delete failed:', error);
      return { success: false, error: error.message };
    }
  });

  // ==========================================
  // Settings
  // ==========================================

  ipcMain.handle(IPC_CHANNELS.INVOICE_SELLER_GET, async () => {
    try {
      const settings = sellerSettingsRepo.get();
      return { success: true, data: settings };
    } catch (error: any) {
      logger.error('[InvoiceController] Seller get failed:', error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle(IPC_CHANNELS.INVOICE_SELLER_UPDATE, async (_, data: SellerSettingsUpdateDTO) => {
    try {
      const settings = sellerSettingsRepo.upsert(data);
      return { success: true, data: settings };
    } catch (error: any) {
      logger.error('[InvoiceController] Seller update failed:', error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle(IPC_CHANNELS.INVOICE_VAT_RATES_GET, async () => {
    try {
      const rates = invoiceRepo.getVatRates();
      return { success: true, data: rates };
    } catch (error: any) {
      logger.error('[InvoiceController] VAT rates get failed:', error);
      return { success: false, error: error.message };
    }
  });

  // ==========================================
  // NIP/VAT Lookup
  // ==========================================

  ipcMain.handle(IPC_CHANNELS.INVOICE_LOOKUP_NIP, async (_, nip: string) => {
    try {
      const result = await nipLookupService.lookupPolishNip(nip);
      return { success: true, data: result };
    } catch (error: any) {
      logger.error('[InvoiceController] NIP lookup failed:', error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle(IPC_CHANNELS.INVOICE_LOOKUP_EU_VAT, async (_, vatId: string) => {
    try {
      const result = await nipLookupService.lookupEuVat(vatId);
      return { success: true, data: result };
    } catch (error: any) {
      logger.error('[InvoiceController] EU VAT lookup failed:', error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle(IPC_CHANNELS.INVOICE_LOOKUP_AUTO, async (_, identifier: string) => {
    try {
      const result = await nipLookupService.lookup(identifier);
      return { success: true, data: result };
    } catch (error: any) {
      logger.error('[InvoiceController] Auto lookup failed:', error);
      return { success: false, error: error.message };
    }
  });

  // ==========================================
  // KSeF
  // ==========================================

  ipcMain.handle(IPC_CHANNELS.KSEF_SEND, async (_, invoiceId: string) => {
    try {
      const result = await sendToKsef(invoiceId);
      return {
        success: result.success,
        data: { ksefNumber: result.ksefNumber },
        error: result.error,
      };
    } catch (error: any) {
      logger.error('[InvoiceController] KSeF send failed:', error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle(IPC_CHANNELS.KSEF_SEND_BATCH, async (_, invoiceIds: string[]) => {
    try {
      const result = await sendBatchToKsef(invoiceIds);
      return {
        success: result.failed === 0,
        data: result,
      };
    } catch (error: any) {
      logger.error('[InvoiceController] KSeF batch send failed:', error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle(IPC_CHANNELS.KSEF_GET_STATUS, async () => {
    try {
      const stats = getKsefStats();
      const settings = sellerSettingsRepo.get();
      return {
        success: true,
        data: {
          enabled: settings?.ksef_enabled === 1,
          autoSend: settings?.ksef_auto_send === 1,
          environment: settings?.ksef_environment || 'TEST',
          lastSyncAt: settings?.ksef_last_sync_at,
          lastError: settings?.ksef_last_error,
          stats,
        },
      };
    } catch (error: any) {
      logger.error('[InvoiceController] KSeF get status failed:', error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle(IPC_CHANNELS.KSEF_RETRY, async (_, invoiceId: string) => {
    try {
      // Reset retry count first
      invoiceRepo.updateKsefStatus(invoiceId, 'PENDING', null, null);
      const result = await sendToKsef(invoiceId);
      return {
        success: result.success,
        data: { ksefNumber: result.ksefNumber },
        error: result.error,
      };
    } catch (error: any) {
      logger.error('[InvoiceController] KSeF retry failed:', error);
      return { success: false, error: error.message };
    }
  });

  logger.info('[InvoiceController] Handlers registered');
}
