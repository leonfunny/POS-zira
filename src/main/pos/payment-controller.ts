import { ReceiptData, PrinterType } from '../../shared/types';
import { orderRepo } from '../database/repos/order-repo';
import { productRepo } from '../database/repos/product-repo';
import { resolveName } from '../../shared/catalog-names';
import logger from '../logger';

export interface PaymentResult {
  success: boolean;
  receiptPrinted: boolean;
  drawerOpened?: boolean;
  error?: string;
}

export interface ReceiptWithDrawerResult {
  receiptPrinted: boolean;
  drawerOpened: boolean;
  error?: string;
}

export interface RefundReceiptOverride {
  amount: number;
  reason?: string;
  lines?: Array<{name: string; quantity: number; unitPrice: number; refundAmount: number; vatRate?: number; sku?: string}>;
}

type PrinterDriver = {
  isConnected(): boolean;
  printReceipt(data: ReceiptData): Promise<void>;
  printReceiptWithDrawer?(data: ReceiptData): Promise<void>;
  openDrawer(): Promise<void>;
};

type GetPrinter = (type: string) => PrinterDriver | null;
type SharedReceiptPrinter = (
  data: ReceiptData,
  meta: { referenceType?: string; referenceId?: string; source?: string; openDrawer?: boolean },
) => Promise<{ handled: boolean; printed: boolean; printerId?: string; drawerOpenRequested?: boolean; error?: string }>;
type SharedFiscalPrinter = (
  data: ReceiptData,
  meta: { referenceType?: string; referenceId?: string; source?: string },
) => Promise<{ handled: boolean; printed: boolean; printerId?: string; jobId?: string; error?: string }>;
type SharedFiscalStatusProvider = () => Promise<{ configured: boolean; connected: boolean; printerId?: string; error?: string }>;

type PrintReceiptOptions = {
  throwOnFailure?: boolean;
};

export class PaymentController {
  constructor(
    private getPrinter: GetPrinter,
    private isOnline: () => boolean,
    private getSalonName?: () => string | undefined,
    private getSellerName?: () => string | undefined,
    private getSellerAddress?: () => string | undefined,
    private getSellerNip?: () => string | undefined,
    private sharedReceiptPrinter?: SharedReceiptPrinter,
    private sharedFiscalPrinter?: SharedFiscalPrinter,
    private sharedFiscalStatus?: SharedFiscalStatusProvider,
  ) {}

  /**
   * Parse tenders JSON from order row (if split payment).
   */
  private parseTenders(order: any): Array<{ method: string; amount: number }> | undefined {
    if (!order.payment_tenders) return undefined;
    try {
      const tenders = JSON.parse(order.payment_tenders);
      return Array.isArray(tenders) && tenders.length > 1 ? tenders : undefined;
    } catch { return undefined; }
  }

  /**
   * Customer-facing receipt lines should be Polish for this shop, while the
   * persisted order row stays canonical for backend/fiscal reconciliation.
   * Prefer the current catalog's PL translation when we can still identify the
   * product, and fall back to the stored order/refund name for legacy or removed
   * products.
   */
  private getReceiptItemName(item: { name: string; variant_id?: string | null; sku?: string | null }): string {
    const product = item.variant_id
      ? productRepo.getById(item.variant_id)
      : item.sku
        ? productRepo.getBySku(item.sku)
        : null;
    return resolveName(product, 'pl') || item.name;
  }

  private describePrintFailure(err: unknown, fallback: string): string {
    const raw = err instanceof Error ? err.message : String(err || '');
    if (/TRYB MENU LOKALNEGO/i.test(raw)) {
      return 'ELZAB is in local menu mode (TRYB MENU LOKALNEGO). Exit the menu on the fiscal printer, wait for the ready screen, then retry fiscal print from Order History.';
    }
    if (/REAL_FISCAL_PRINT_DISABLED/i.test(raw)) {
      return 'Real ELZAB fiscal printing is disabled. Enable allowRealFiscalPrint only during controlled production go-live.';
    }
    return raw ? `${fallback}: ${raw}` : fallback;
  }

  private async routeSharedReceipt(
    receiptData: ReceiptData,
    meta: { referenceType?: string; referenceId?: string; source?: string; openDrawer?: boolean },
    successMessage: string,
    failureMessage: string,
  ): Promise<{ handled: boolean; printed: boolean; printerId?: string; drawerOpenRequested?: boolean; error?: string } | null> {
    if (!this.sharedReceiptPrinter) return null;

    try {
      const shared = await this.sharedReceiptPrinter(receiptData, meta);
      if (!shared.handled) return null;
      if (shared.printed) {
        logger.info(`${successMessage} via shared printer${shared.printerId ? ` ${shared.printerId}` : ''}`);
      } else {
        logger.error(`${failureMessage}: ${shared.error || 'shared printer did not accept the job'}`);
      }
      return shared;
    } catch (err: any) {
      logger.warn(`[Payment] Shared receipt route failed before assignment; falling back to local printer: ${err?.message || err}`);
      return null;
    }
  }

  private async printReceiptData(
    receiptData: ReceiptData,
    meta: { referenceType?: string; referenceId?: string; source?: string },
    successMessage: string,
    failureMessage: string,
    missingPrinterMessage: string,
    printerType: PrinterType = PrinterType.RECEIPT,
    options: PrintReceiptOptions = {},
  ): Promise<boolean> {
    // Shared (network) printer route is only valid for the RECEIPT/order copy.
    // FISCAL printing must always be local — fiscal idempotency, legal liability
    // and the elzabdr/POSNET drivers live on the POS that owns the device.
    if (printerType === PrinterType.RECEIPT) {
      const shared = await this.routeSharedReceipt(receiptData, meta, successMessage, failureMessage);
      if (shared) return shared.printed;
    }

    const printer = this.getPrinter(printerType);
    if (!printer || !printer.isConnected()) {
      logger.warn(missingPrinterMessage);
      if (options.throwOnFailure) throw new Error(missingPrinterMessage);
      return false;
    }

    try {
      await printer.printReceipt(receiptData);
      logger.info(successMessage);
      return true;
    } catch (err) {
      logger.error(`${failureMessage}: ${err}`);
      if (options.throwOnFailure) throw new Error(this.describePrintFailure(err, failureMessage));
      return false;
    }
  }

  async hasFiscalPrinter(): Promise<{ configured: boolean; connected: boolean }> {
    const printer = this.getPrinter(PrinterType.FISCAL);
    if (printer) return { configured: true, connected: !!printer.isConnected?.() };

    if (!this.sharedFiscalStatus) return { configured: false, connected: false };
    try {
      const remote = await this.sharedFiscalStatus();
      if (remote.configured) {
        logger.info(`[Payment] Remote fiscal route ready${remote.printerId ? ` via ${remote.printerId}` : ''}`);
      } else if (remote.error) {
        logger.warn(`[Payment] Remote fiscal route unavailable: ${remote.error}`);
      }
      return { configured: !!remote.configured, connected: !!remote.connected };
    } catch (err: any) {
      logger.warn(`[Payment] Remote fiscal availability check failed; fiscal route disabled: ${err?.message || err}`);
      return { configured: false, connected: false };
    }
  }

  private buildSaleReceiptData(orderId: string): ReceiptData | null {
    const order = orderRepo.getById(orderId);
    if (!order) return null;
    const items = orderRepo.getItemsByOrderId(orderId);
    return {
      orderId,
      orderNumber: order.order_number || orderId.substring(0, 8),
      salonName: this.getSalonName?.(),
      sellerName: this.getSellerName?.(),
      sellerAddress: this.getSellerAddress?.(),
      sellerNip: this.getSellerNip?.(),
      items: items.map((i) => {
        const product = i.variant_id ? productRepo.getById(i.variant_id) : null;
        return {
          name: this.getReceiptItemName(i),
          quantity: i.quantity,
          unitPrice: i.price,
          totalPrice: i.total,
          vatRate: i.vat_rate,
          sku: i.sku || undefined,
          unit: product?.sale_unit || undefined,
        };
      }),
      payment: {
        method: order.payment_method || 'CASH',
        amount: order.payment_amount,
      },
      subtotal: order.subtotal,
      discount: order.discount > 0 ? order.discount : undefined,
      total: order.total,
      cashierName: order.staff_name || undefined,
      customerName: order.customer_name || undefined,
      customerNip: order.customer_nip || undefined,
      tenders: this.parseTenders(order),
    };
  }

  /**
   * Validate payment amount before processing
   */
  private validatePayment(orderId: string, amount?: number): { order: ReturnType<typeof orderRepo.getById>; error?: string } {
    const order = orderRepo.getById(orderId);
    if (!order) {
      return { order: null, error: `Order ${orderId} not found` };
    }

    if (order.total <= 0) {
      return { order, error: `Order total must be positive (got ${order.total})` };
    }

    if (amount !== undefined && amount <= 0) {
      return { order, error: `Payment amount must be positive (got ${amount})` };
    }

    return { order };
  }

  /**
   * Print an order (non-fiscal customer copy) for a completed order on the
   * RECEIPT/thermal printer.
   */
  async printReceipt(orderId: string): Promise<boolean> {
    const receiptData = this.buildSaleReceiptData(orderId);
    if (!receiptData) {
      logger.warn(`[Payment] Cannot print receipt: order ${orderId} not found`);
      return false;
    }
    const orderNumberLabel = receiptData.orderNumber;
    return this.printReceiptData(
      receiptData,
      { referenceType: 'POS_RECEIPT', referenceId: orderId, source: 'pos' },
      `[Payment] Receipt printed for order ${orderNumberLabel}`,
      '[Payment] Receipt print failed',
      '[Payment] No receipt printer connected, skipping print',
      PrinterType.RECEIPT,
    );
  }

  /**
   * Print the cash-payment order copy and open the cash drawer.
   *
   * This is only for the initial POS flow where the tender includes CASH. It
   * intentionally does not replace reprint/refund/remote receipt paths.
   */
  async printReceiptAndOpenDrawer(orderId: string): Promise<ReceiptWithDrawerResult> {
    const receiptData = this.buildSaleReceiptData(orderId);
    if (!receiptData) {
      const error = `Order ${orderId} not found`;
      logger.warn(`[Payment] Cannot print receipt/open drawer: ${error}`);
      return { receiptPrinted: false, drawerOpened: false, error };
    }

    const orderNumberLabel = receiptData.orderNumber;
    const successMessage = `[Payment] Receipt printed for order ${orderNumberLabel}`;
    const failureMessage = '[Payment] Receipt print failed';

    const shared = await this.routeSharedReceipt(
      receiptData,
      { referenceType: 'POS_RECEIPT', referenceId: orderId, source: 'pos', openDrawer: true },
      successMessage,
      failureMessage,
    );
    if (shared) {
      const drawerOpened = shared.printed
        ? (shared.drawerOpenRequested ? true : await this.openCashDrawer())
        : false;
      return {
        receiptPrinted: shared.printed,
        drawerOpened,
        error: shared.printed ? undefined : shared.error,
      };
    }

    const printer = this.getPrinter(PrinterType.RECEIPT);
    if (!printer || !printer.isConnected()) {
      const error = '[Payment] No receipt printer connected, skipping print and drawer';
      logger.warn(error);
      return { receiptPrinted: false, drawerOpened: false, error };
    }

    if (printer.printReceiptWithDrawer) {
      try {
        await printer.printReceiptWithDrawer(receiptData);
        logger.info(`${successMessage}; cash drawer pulse sent`);
        return { receiptPrinted: true, drawerOpened: true };
      } catch (err) {
        logger.error(`${failureMessage}: ${err}`);
        const drawerOpened = await this.openCashDrawer();
        return {
          receiptPrinted: false,
          drawerOpened,
          error: this.describePrintFailure(err, failureMessage),
        };
      }
    }

    const [receiptPrinted, drawerOpened] = await Promise.all([
      printer.printReceipt(receiptData)
        .then(() => {
          logger.info(successMessage);
          return true;
        })
        .catch((err) => {
          logger.error(`${failureMessage}: ${err}`);
          return false;
        }),
      printer.openDrawer()
        .then(() => {
          logger.info('[Payment] Cash drawer opened');
          return true;
        })
        .catch((err) => {
          logger.error(`[Payment] Cash drawer open failed: ${err}`);
          return false;
        }),
    ]);

    return { receiptPrinted, drawerOpened };
  }

  /**
   * Print the fiscal receipt for a completed order on the FISCAL printer
   * (POSNET or ELZAB). Local fiscal hardware wins; POS instances without
   * fiscal hardware may route only through the dedicated blocking fiscal
   * backend job. Never fall back to the thermal receipt route.
   */
  async printFiscalReceipt(orderId: string): Promise<boolean> {
    const receiptData = this.buildSaleReceiptData(orderId);
    if (!receiptData) {
      logger.warn(`[Payment] Cannot print fiscal receipt: order ${orderId} not found`);
      return false;
    }
    const orderNumberLabel = receiptData.orderNumber;
    const successMessage = `[Payment] Fiscal receipt printed for order ${orderNumberLabel}`;
    const failureMessage = '[Payment] Fiscal receipt print failed';
    const missingPrinterMessage = '[Payment] No fiscal printer connected or remote fiscal route configured';
    const meta = { referenceType: 'POS_FISCAL_RECEIPT', referenceId: orderId, source: 'pos' };

    const printer = this.getPrinter(PrinterType.FISCAL);
    if (printer) {
      if (!printer.isConnected()) {
        logger.warn(missingPrinterMessage);
        throw new Error(missingPrinterMessage);
      }

      try {
        await printer.printReceipt(receiptData);
        logger.info(successMessage);
        return true;
      } catch (err) {
        logger.error(`${failureMessage}: ${err}`);
        throw new Error(this.describePrintFailure(err, failureMessage));
      }
    }

    if (this.sharedFiscalPrinter) {
      const shared = await this.sharedFiscalPrinter(receiptData, meta);
      if (shared.handled) {
        if (shared.printed) {
          logger.info(`${successMessage} via shared fiscal printer${shared.printerId ? ` ${shared.printerId}` : ''}`);
          return true;
        }
        const error = shared.error || 'Remote fiscal printer did not confirm final print completion';
        logger.error(`${failureMessage}: ${error}`);
        throw new Error(error);
      }
    }

    logger.warn(missingPrinterMessage);
    throw new Error(missingPrinterMessage);
  }

  /**
   * Reprint receipt for an existing order — marks as KOPIA/REPRINT
   */
  async reprintReceipt(orderId: string): Promise<boolean> {
    const order = orderRepo.getById(orderId);
    if (!order) {
      logger.warn(`[Payment] Cannot reprint: order ${orderId} not found`);
      return false;
    }

    const items = orderRepo.getItemsByOrderId(orderId);
    const receiptData: ReceiptData = {
      orderId,
      orderNumber: order.order_number || orderId.substring(0, 8),
      salonName: this.getSalonName?.(),
      sellerName: this.getSellerName?.(),
      sellerAddress: this.getSellerAddress?.(),
      sellerNip: this.getSellerNip?.(),
      items: items.map((i) => {
        const product = i.variant_id ? productRepo.getById(i.variant_id) : null;
        return {
          name: this.getReceiptItemName(i),
          quantity: i.quantity,
          unitPrice: i.price,
          totalPrice: i.total,
          vatRate: i.vat_rate,
          sku: i.sku || undefined,
          unit: product?.sale_unit || undefined,
        };
      }),
      payment: {
        method: order.payment_method || 'CASH',
        amount: order.payment_amount,
      },
      subtotal: order.subtotal,
      discount: order.discount > 0 ? order.discount : undefined,
      total: order.total,
      cashierName: order.staff_name || undefined,
      customerName: order.customer_name || undefined,
      customerNip: order.customer_nip || undefined,
      tenders: this.parseTenders(order),
      isReprint: true,
      originalDate: order.created_at,
    };

    return this.printReceiptData(
      receiptData,
      { referenceType: 'POS_RECEIPT_REPRINT', referenceId: orderId, source: 'pos-reprint' },
      `[Payment] Receipt REPRINTED for order ${order.order_number}`,
      '[Payment] Receipt reprint failed',
      '[Payment] No receipt printer connected, cannot reprint',
    );
  }

  /**
   * Open cash drawer
   */
  async openCashDrawer(): Promise<boolean> {
    const printer = this.getPrinter(PrinterType.RECEIPT);
    if (!printer || !printer.isConnected()) {
      logger.warn('[Payment] No receipt printer connected, cannot open drawer');
      return false;
    }

    try {
      await printer.openDrawer();
      logger.info('[Payment] Cash drawer opened');
      return true;
    } catch (err) {
      logger.error(`[Payment] Cash drawer open failed: ${err}`);
      return false;
    }
  }

  /**
   * Complete a cash payment: validate, print receipt + open drawer.
   * Returns structured result so UI can show "Reprint?" if receipt failed.
   */
  async completeCashPayment(orderId: string): Promise<PaymentResult> {
    const { order, error } = this.validatePayment(orderId);
    if (error || !order) {
      return { success: false, receiptPrinted: false, error: error || 'Order not found' };
    }

    const { receiptPrinted, drawerOpened } = await this.printReceiptAndOpenDrawer(orderId);
    return { success: true, receiptPrinted, drawerOpened };
  }

  /**
   * Complete a card payment: validate, print receipt only (no drawer).
   * Returns structured result so UI can show "Reprint?" if receipt failed.
   */
  async completeCardPayment(orderId: string): Promise<PaymentResult> {
    const { order, error } = this.validatePayment(orderId);
    if (error || !order) {
      return { success: false, receiptPrinted: false, error: error || 'Order not found' };
    }

    const receiptPrinted = await this.printReceipt(orderId);
    return { success: true, receiptPrinted };
  }

  /**
   * Print a refund receipt — shows "ZWROT" banner.
   * Uses stored refund_lines for accurate per-item data; falls back to all items for older orders.
   */
  async printRefundReceipt(orderId: string, refundOverride?: RefundReceiptOverride): Promise<boolean> {
    const order = orderRepo.getById(orderId);
    if (!order) {
      logger.warn(`[Payment] Cannot print refund receipt: order ${orderId} not found`);
      return false;
    }

    const refundAmount = refundOverride?.amount ?? order.refund_amount ?? order.total;

    let receiptItems: ReceiptData['items'];
    let refundSubtotal: number;

    let storedLines: Array<{name: string; quantity: number; unitPrice: number; refundAmount: number; vatRate?: number; sku?: string}> | null = null;
    if (refundOverride?.lines) {
      storedLines = refundOverride.lines;
    } else if (order.refund_lines) {
      try { storedLines = JSON.parse(order.refund_lines); } catch {}
    }

    if (storedLines && storedLines.length > 0) {
      receiptItems = storedLines.map(l => ({
        name: this.getReceiptItemName(l),
        quantity: l.quantity,
        unitPrice: l.unitPrice,
        totalPrice: l.refundAmount,
        vatRate: l.vatRate ?? 23,
        sku: l.sku || undefined,
      }));
      refundSubtotal = storedLines.reduce((s, l) => s + l.refundAmount, 0);
    } else {
      const items = orderRepo.getItemsByOrderId(orderId);
      receiptItems = items.map(i => {
        const product = i.variant_id ? productRepo.getById(i.variant_id) : null;
        return {
          name: this.getReceiptItemName(i),
          quantity: i.quantity,
          unitPrice: i.price,
          totalPrice: i.total,
          vatRate: i.vat_rate,
          sku: i.sku || undefined,
          unit: product?.sale_unit || undefined,
        };
      });
      refundSubtotal = refundAmount;
    }

    const receiptData: ReceiptData = {
      orderId,
      orderNumber: `R-${order.order_number || orderId.substring(0, 8)}`,
      salonName: this.getSalonName?.(),
      sellerName: this.getSellerName?.(),
      sellerAddress: this.getSellerAddress?.(),
      sellerNip: this.getSellerNip?.(),
      items: receiptItems,
      payment: {
        method: order.payment_method || 'CASH',
        amount: refundAmount,
      },
      subtotal: refundSubtotal,
      total: refundAmount,
      cashierName: order.staff_name || undefined,
      isRefund: true,
      refundReason: refundOverride?.reason || order.refund_reason || undefined,
      originalOrderNumber: order.order_number || orderId.substring(0, 8),
      // Wiki: refund receipt MUST cite "Oryginał: POS-… z dnia
      // DD.MM.YYYY". order.created_at is the original sale timestamp;
      // formatOriginalRef in the thermal formatter renders the date.
      originalDate: order.created_at || undefined,
    };

    return this.printReceiptData(
      receiptData,
      { referenceType: 'POS_REFUND_RECEIPT', referenceId: orderId, source: 'pos-refund' },
      `[Payment] Refund receipt printed for order ${order.order_number}`,
      '[Payment] Refund receipt print failed',
      '[Payment] No receipt printer connected, cannot print refund receipt',
    );
  }
}
