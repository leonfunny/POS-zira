import { ReceiptData, PrinterType, type PrintJobFailureClass } from '../../shared/types';
import { orderRepo } from '../database/repos/order-repo';
import { fiscalAttemptRepo } from '../database/repos/fiscal-attempt-repo';
import { productRepo } from '../database/repos/product-repo';
import { RECEIPT_NAME_LOCALE, resolveName } from '../../shared/catalog-names';
import { calculateLineTotalGrosze, normalizeSellBy } from '../../shared/pos-sale';
import { getExplicitPrintFailureClass } from '../printing/print-failure-classifier';
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
  failureClass?: PrintJobFailureClass;
}

export interface RefundReceiptOverride {
  amount: number;
  reason?: string;
  lines?: Array<{name: string; quantity: number; unitPrice: number; refundAmount: number; vatRate?: number; sku?: string; unit?: string}>;
}

type PrinterDriver = {
  connect?(): Promise<boolean>;
  isConnected(): boolean;
  printReceipt(data: ReceiptData): Promise<void>;
  printReceiptWithDrawer?(data: ReceiptData): Promise<void>;
  openDrawer(): Promise<void>;
};

type GetPrinter = (type: string) => PrinterDriver | null;
type SharedReceiptPrinter = (
  data: ReceiptData,
  meta: { referenceType?: string; referenceId?: string; source?: string; openDrawer?: boolean },
) => Promise<{
  handled: boolean;
  printed: boolean;
  printerId?: string;
  jobId?: string;
  sent?: boolean;
  status?: string;
  failureClass?: PrintJobFailureClass | null;
  drawerOpenRequested?: boolean;
  stillPrinting?: boolean;
  error?: string;
}>;
type SharedFiscalPrinter = (
  data: ReceiptData,
  meta: { referenceType?: string; referenceId?: string; source?: string },
) => Promise<{ handled: boolean; printed: boolean; printerId?: string; jobId?: string; error?: string }>;
type SharedFiscalStatusProvider = () => Promise<{ configured: boolean; connected: boolean; printerId?: string; error?: string }>;

type PrintReceiptOptions = {
  throwOnFailure?: boolean;
  /**
   * The durable outbox has already selected the local route. If that route
   * disappears between readiness probing and dispatch, fail safely so the
   * next outbox attempt can capture a shared job identity itself.
   */
  localOnly?: boolean;
};

const PAYMENT_PRINTER_CONNECT_TIMEOUT_MS = 5_000;

/**
 * Raw outcome of a non-fiscal receipt print, reported to the host so it can
 * resolve the configured printer name/target and persist a `print_attempts`
 * row. The controller stays config-decoupled; the host owns persistence.
 */
export interface ReceiptPrintJournalInput {
  orderId: string;
  documentType: 'ORDER' | 'REPRINT' | 'REFUND';
  printerType: PrinterType;
  route: 'LOCAL' | 'SHARED_NETWORK' | null;
  status: 'PRINTED' | 'FAILED' | 'NO_PRINTER';
  printerId?: string | null;   // shared printerId when route = SHARED_NETWORK
  error?: string | null;
}

export interface FiscalReceiptJournalInput {
  orderId: string;
  status: 'PRINTED' | 'FAILED';
  route: 'LOCAL' | 'SHARED_NETWORK';
  paymentMethod?: string | null;
  grossTotal?: number | null;
  printerId?: string | null;
  printJobId?: string | null;
  error?: string | null;
}

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
    private recordPrintAttempt?: (input: ReceiptPrintJournalInput) => void,
    private recordFiscalReceipt?: (input: FiscalReceiptJournalInput) => void,
  ) {}

  /** Map the receipt meta.referenceType to a print_attempts document_type. */
  private docTypeFromMeta(referenceType?: string): 'ORDER' | 'REPRINT' | 'REFUND' {
    if (referenceType === 'POS_RECEIPT_REPRINT') return 'REPRINT';
    if (referenceType === 'POS_REFUND_RECEIPT') return 'REFUND';
    return 'ORDER';
  }

  /** Best-effort journal write — never let a logging failure break printing. */
  private journalReceiptPrint(input: ReceiptPrintJournalInput): void {
    if (!input.orderId) return;
    try {
      this.recordPrintAttempt?.(input);
    } catch (err) {
      logger.warn(`[Payment] print_attempts journal failed: ${err}`);
    }
  }

  /** Best-effort backend fiscal journal write; never let reporting telemetry break printing. */
  private journalFiscalReceipt(input: FiscalReceiptJournalInput): void {
    if (!input.orderId) return;
    try {
      this.recordFiscalReceipt?.(input);
    } catch (err) {
      logger.warn(`[Payment] fiscal receipt journal failed: ${err}`);
    }
  }

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
  private getReceiptItemName(item: {
    name: string;
    variant_id?: string | null;
    sku?: string | null;
    billiard_json?: string | null;
  }): string {
    // Billiard names are part of the server-authoritative frozen checkout.
    // In particular, TIME lines carry the table name and duration. Replacing
    // them with the hidden catalog variant would make the receipt ambiguous.
    if (String(item.billiard_json || '').trim()) return item.name;

    const product = item.variant_id
      ? productRepo.getById(item.variant_id)
      : item.sku
        ? productRepo.getBySku(item.sku)
        : null;
    return resolveName(product, RECEIPT_NAME_LOCALE) || item.name;
  }

  private getReceiptItemUnit(
    item: { sale_unit?: string | null; billiard_json?: string | null },
    product?: { sale_unit?: string | null } | null,
  ): string | undefined {
    const frozenMetadata = String(item.billiard_json || '').trim();
    if (frozenMetadata) {
      let kind = '';
      try {
        kind = String(JSON.parse(frozenMetadata)?.kind || '').toUpperCase();
      } catch {
        throw new Error('FISCAL_BILLIARD_LINE_METADATA_INVALID: Invalid frozen receipt metadata.');
      }
      if (kind === 'TIME') return 'usł.';
    }
    return item.sale_unit || product?.sale_unit || undefined;
  }

  private describePrintFailure(err: unknown, fallback: string): string {
    const raw = err instanceof Error ? err.message : String(err || '');
    if (/TRYB MENU LOKALNEGO/i.test(raw)) {
      return 'ELZAB is in local menu mode (TRYB MENU LOKALNEGO). Exit the menu on the fiscal printer, wait for the ready screen, then retry fiscal print from Order History.';
    }
    if (/REAL_FISCAL_PRINT_DISABLED/i.test(raw)) {
      return 'Real fiscal printing is disabled. Enable allowRealFiscalPrint only during controlled production go-live.';
    }
    return raw ? `${fallback}: ${raw}` : fallback;
  }

  private classifiedPrintError(
    message: string,
    failureClass: PrintJobFailureClass,
    cause?: unknown,
  ): Error & { failureClass: PrintJobFailureClass } {
    const error = new Error(message, cause === undefined ? undefined : { cause }) as Error & {
      failureClass: PrintJobFailureClass;
    };
    error.failureClass = failureClass;
    return error;
  }

  private grossFromNet(netGrosze: number, vatRate: number): number {
    if (netGrosze <= 0 || vatRate <= 0) return netGrosze;
    return Math.round(netGrosze * (100 + vatRate) / 100);
  }

  private orderItemsLookNetPriced(
    order: { subtotal: number; tax: number; total: number; discount: number },
    items: Array<{ total: number }>,
  ): boolean {
    const itemTotal = items.reduce((sum, item) => sum + (Number(item.total) || 0), 0);
    const grossSubtotal = (Number(order.total) || 0) + (Number(order.discount) || 0);
    return itemTotal > 0
      && (Number(order.tax) || 0) > 0
      && grossSubtotal > 0
      && Math.abs(itemTotal + (Number(order.tax) || 0) - grossSubtotal) <= 1;
  }

  private receiptTotalsMatch(left: number, right: number): boolean {
    return Math.abs(Math.round(left) - Math.round(right)) <= 1;
  }

  private sumReceiptItems(items: ReceiptData['items']): number {
    return items.reduce((sum, item) => sum + (Number(item.totalPrice) || 0), 0);
  }

  private sumReceiptPayable(items: ReceiptData['items']): number {
    return items.reduce(
      (sum, item) => sum + Number(item.totalPrice) - Number(item.allocatedDiscount ?? 0),
      0,
    );
  }

  private buildReceiptItems(
    order: { id?: string; order_number?: string | null; total: number; discount: number },
    orderItems: Array<any>,
    itemsLookNetPriced: boolean,
  ): ReceiptData['items'] {
    const expectedLineTotal = (Number(order.total) || 0) + (Number(order.discount) || 0);
    const isBilliardOrder = orderItems.some((item) => Boolean(String(item?.billiard_json || '').trim()));
    if (isBilliardOrder && orderItems.some((item) => !String(item?.billiard_json || '').trim())) {
      throw new Error('FISCAL_BILLIARD_LINE_METADATA_MISSING: Refusing a mixed frozen/non-frozen receipt.');
    }

    const buildFromOrderItems = (): ReceiptData['items'] => orderItems.map((i, index) => {
      const product = i.variant_id ? productRepo.getById(i.variant_id) : null;
      const unitPrice = itemsLookNetPriced ? this.grossFromNet(i.price, i.vat_rate) : i.price;
      const totalPrice = itemsLookNetPriced ? this.grossFromNet(i.total, i.vat_rate) : i.total;
      const allocatedDiscount = isBilliardOrder ? Number(i.allocated_discount) : undefined;
      if (
        isBilliardOrder
        && (!Number.isSafeInteger(allocatedDiscount) || allocatedDiscount! < 0 || allocatedDiscount! > totalPrice)
      ) {
        throw new Error(`FISCAL_BILLIARD_DISCOUNT_INVALID: Invalid frozen discount on line ${index + 1}.`);
      }
      if (
        isBilliardOrder
        && (!Number.isSafeInteger(Number(i.payable_total))
          || Number(i.payable_total) !== totalPrice - allocatedDiscount!)
      ) {
        throw new Error(`FISCAL_BILLIARD_PAYABLE_INVALID: Invalid frozen payable amount on line ${index + 1}.`);
      }
      // Manual cashier line discount (non-billiard): itemized on the paper
      // order copy only; its total already sits in the receipt-level rabat.
      const manualLineDiscount = !isBilliardOrder ? Math.max(0, Number(i.allocated_discount) || 0) : 0;
      return {
        name: this.getReceiptItemName(i),
        quantity: i.quantity,
        unitPrice,
        totalPrice,
        ...(isBilliardOrder ? { allocatedDiscount } : {}),
        ...(manualLineDiscount > 0 ? { displayLineDiscount: manualLineDiscount } : {}),
        vatRate: i.vat_rate,
        sku: i.sku || undefined,
        unit: this.getReceiptItemUnit(i, product),
      };
    });

    const receiptItems = buildFromOrderItems();
    const lineSum = this.sumReceiptItems(receiptItems);
    if (isBilliardOrder) {
      const payableSum = this.sumReceiptPayable(receiptItems);
      if (lineSum !== expectedLineTotal || payableSum !== Number(order.total)) {
        throw new Error(
          `FISCAL_BILLIARD_TOTAL_MISMATCH order=${order.order_number || order.id || 'unknown'} ` +
          `gross=${lineSum} discount=${lineSum - payableSum} payable=${payableSum} expectedGross=${expectedLineTotal} expectedPayable=${order.total}.`,
        );
      }
      return receiptItems;
    }
    if (expectedLineTotal <= 0 || this.receiptTotalsMatch(lineSum, expectedLineTotal)) {
      return receiptItems;
    }

    const catalogItems: ReceiptData['items'] = [];
    for (const i of orderItems) {
      const product = i.variant_id
        ? productRepo.getById(i.variant_id)
        : i.sku
          ? productRepo.getBySku(i.sku)
          : null;
      const catalogPrice = Number(product?.retail_price);
      if (!product || !Number.isFinite(catalogPrice) || catalogPrice < 0) {
        break;
      }
      const sellBy = normalizeSellBy(i.sell_by ?? product.sell_by);
      const quantity = Number(i.sale_quantity ?? i.quantity) || 1;
      const totalPrice = calculateLineTotalGrosze(catalogPrice, quantity, sellBy);
      catalogItems.push({
        name: this.getReceiptItemName(i),
        quantity,
        unitPrice: catalogPrice,
        totalPrice,
        vatRate: Number(i.vat_rate ?? product.vat_rate) || 23,
        sku: i.sku || product.sku || undefined,
        unit: i.sale_unit || product.sale_unit || undefined,
      });
    }

    if (catalogItems.length === orderItems.length) {
      const catalogSum = this.sumReceiptItems(catalogItems);
      if (this.receiptTotalsMatch(catalogSum, expectedLineTotal)) {
        logger.warn(
          `[Payment] Corrected receipt item prices from catalog for order ${order.order_number || order.id || 'unknown'}: ` +
          `local line sum=${lineSum}, expected=${expectedLineTotal}`,
        );
        return catalogItems;
      }
    }

    throw new Error(
      `FISCAL_LINE_TOTAL_MISMATCH order=${order.order_number || order.id || 'unknown'} ` +
      `lineSum=${lineSum} expected=${expectedLineTotal}. Refusing to print receipt with inconsistent local item prices.`,
    );
  }

  private async routeSharedReceipt(
    receiptData: ReceiptData,
    meta: { referenceType?: string; referenceId?: string; source?: string; openDrawer?: boolean },
    successMessage: string,
    failureMessage: string,
  ): Promise<{
    handled: boolean;
    printed: boolean;
    printerId?: string;
    jobId?: string;
    sent?: boolean;
    status?: string;
    failureClass?: PrintJobFailureClass | null;
    drawerOpenRequested?: boolean;
    stillPrinting?: boolean;
    error?: string;
  } | null> {
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

  private async ensurePrinterReady(printer: PrinterDriver | null, printerType: PrinterType): Promise<PrinterDriver | null> {
    if (!printer) return null;
    if (printer.isConnected()) return printer;
    if (typeof printer.connect !== 'function') return null;

    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      logger.warn(`[Payment] ${printerType} printer is disconnected; attempting reconnect before print`);
      const timedOut = new Promise<boolean>((resolve) => {
        timeout = setTimeout(() => resolve(false), PAYMENT_PRINTER_CONNECT_TIMEOUT_MS);
      });
      const connected = await Promise.race([printer.connect(), timedOut]);
      if (connected && printer.isConnected()) {
        logger.info(`[Payment] ${printerType} printer reconnected before print`);
        return printer;
      }
    } catch (err: any) {
      logger.warn(`[Payment] ${printerType} printer reconnect failed: ${err?.message || err}`);
    } finally {
      if (timeout) clearTimeout(timeout);
    }

    return null;
  }

  /**
   * Resolve the local receipt route before a durable outbox dispatch.
   *
   * A configured driver object is not enough: if its reconnect fails, the
   * outbox must take the rich shared route itself so it can persist the remote
   * printer/job identity instead of losing it through the legacy boolean API.
   */
  async isLocalReceiptPrinterReadyForOutbox(): Promise<boolean> {
    const printer = await this.ensurePrinterReady(
      this.getPrinter(PrinterType.RECEIPT),
      PrinterType.RECEIPT,
    );
    return !!printer?.isConnected();
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
    const orderId = meta.referenceId || '';
    const documentType = this.docTypeFromMeta(meta.referenceType);
    const printer = await this.ensurePrinterReady(this.getPrinter(printerType), printerType);

    if (printer && printer.isConnected()) {
      try {
        await printer.printReceipt(receiptData);
        logger.info(successMessage);
        this.journalReceiptPrint({ orderId, documentType, printerType, route: 'LOCAL', status: 'PRINTED' });
        return true;
      } catch (err) {
        logger.error(`${failureMessage}: ${err}`);
        const described = this.describePrintFailure(err, failureMessage);
        this.journalReceiptPrint({ orderId, documentType, printerType, route: 'LOCAL', status: 'FAILED', error: described });
        if (options.throwOnFailure) {
          throw this.classifiedPrintError(
            described,
            getExplicitPrintFailureClass(err) ?? 'UNCERTAIN_AFTER_PRINT',
            err,
          );
        }
        return false;
      }
    }

    if (printerType === PrinterType.RECEIPT && !options.localOnly) {
      const shared = await this.routeSharedReceipt(receiptData, meta, successMessage, failureMessage);
      if (shared?.printed) {
        this.journalReceiptPrint({ orderId, documentType, printerType, route: 'SHARED_NETWORK', status: 'PRINTED', printerId: shared.printerId });
        return true;
      }
      if (shared) {
        logger.warn(
          `[Payment] Shared receipt route did not print and no local receipt printer is ready: ` +
          `${shared.error || 'shared printer did not accept the job'}`,
        );
        this.journalReceiptPrint({ orderId, documentType, printerType, route: 'SHARED_NETWORK', status: 'FAILED', printerId: shared.printerId, error: shared.error || failureMessage });
        if (options.throwOnFailure) {
          throw this.classifiedPrintError(
            shared.error || failureMessage,
            shared.failureClass ?? 'UNCERTAIN_AFTER_PRINT',
          );
        }
        return false;
      }
    }

    logger.warn(missingPrinterMessage);
    this.journalReceiptPrint({ orderId, documentType, printerType, route: null, status: 'NO_PRINTER' });
    if (options.throwOnFailure) {
      throw this.classifiedPrintError(missingPrinterMessage, 'SAFE_BEFORE_PRINT');
    }
    return false;
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

  public buildSaleReceiptData(orderId: string): ReceiptData | null {
    const order = orderRepo.getById(orderId);
    if (!order) {
      const snap = fiscalAttemptRepo.getReceiptSnapshot(orderId);
      if (!snap) return null;
      return {
        orderId,
        orderNumber: snap.orderNumber || orderId.substring(0, 8),
        salonName: this.getSalonName?.(),
        sellerName: this.getSellerName?.(),
        sellerAddress: this.getSellerAddress?.(),
        sellerNip: this.getSellerNip?.(),
        items: Array.isArray(snap.items) ? snap.items : [],
        payment: snap.payment || { method: 'CASH', amount: snap.total || 0 },
        subtotal: typeof snap.subtotal === 'number' ? snap.subtotal : (snap.total || 0),
        discount: snap.discount && snap.discount > 0 ? snap.discount : undefined,
        total: snap.total || 0,
        cashierName: snap.cashierName || undefined,
        customerName: snap.customerName || undefined,
        customerNip: snap.customerNip || undefined,
        tenders: Array.isArray(snap.tenders) && snap.tenders.length > 1 ? snap.tenders : undefined,
        isReprint: true,
      };
    }
    const items = orderRepo.getItemsByOrderId(orderId);
    const itemsLookNetPriced = this.orderItemsLookNetPriced(order, items);
    const subtotal = itemsLookNetPriced
      ? order.total + (order.discount ?? 0)
      : order.subtotal;
    const receiptItems = this.buildReceiptItems(order, items, itemsLookNetPriced);
    return {
      orderId,
      orderNumber: order.order_number || orderId.substring(0, 8),
      salonName: this.getSalonName?.(),
      sellerName: this.getSellerName?.(),
      sellerAddress: this.getSellerAddress?.(),
      sellerNip: this.getSellerNip?.(),
      items: receiptItems,
      payment: {
        method: order.payment_method || 'CASH',
        amount: order.payment_amount,
      },
      subtotal,
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
  async printReceipt(
    orderId: string,
    receiptDataOverride?: ReceiptData,
    options: PrintReceiptOptions = {},
  ): Promise<boolean> {
    const receiptData = receiptDataOverride ?? this.buildSaleReceiptData(orderId);
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
      options,
    );
  }

  /**
   * Print the cash-payment order copy and open the cash drawer.
   *
   * This is only for the initial POS flow where the tender includes CASH. It
   * intentionally does not replace reprint/refund/remote receipt paths.
   */
  async printReceiptAndOpenDrawer(
    orderId: string,
    receiptDataOverride?: ReceiptData,
    options: PrintReceiptOptions = {},
  ): Promise<ReceiptWithDrawerResult> {
    const receiptData = receiptDataOverride ?? this.buildSaleReceiptData(orderId);
    if (!receiptData) {
      const error = `Order ${orderId} not found`;
      logger.warn(`[Payment] Cannot print receipt/open drawer: ${error}`);
      return { receiptPrinted: false, drawerOpened: false, error };
    }

    const orderNumberLabel = receiptData.orderNumber;
    const successMessage = `[Payment] Receipt printed for order ${orderNumberLabel}`;
    const failureMessage = '[Payment] Receipt print failed';
    const printer = await this.ensurePrinterReady(this.getPrinter(PrinterType.RECEIPT), PrinterType.RECEIPT);

    if (printer && printer.isConnected()) {
      if (printer.printReceiptWithDrawer) {
        try {
          await printer.printReceiptWithDrawer(receiptData);
          logger.info(`${successMessage}; cash drawer pulse sent`);
          this.journalReceiptPrint({ orderId, documentType: 'ORDER', printerType: PrinterType.RECEIPT, route: 'LOCAL', status: 'PRINTED' });
          return { receiptPrinted: true, drawerOpened: true };
        } catch (err) {
          logger.error(`${failureMessage}: ${err}`);
          const describedError = this.describePrintFailure(err, failureMessage);
          this.journalReceiptPrint({ orderId, documentType: 'ORDER', printerType: PrinterType.RECEIPT, route: 'LOCAL', status: 'FAILED', error: describedError });
          const failureClass = getExplicitPrintFailureClass(err);
          let drawerOpened = false;
          let effectiveError = describedError;
          let effectiveFailureClass = failureClass ?? 'UNCERTAIN_AFTER_PRINT';
          if (failureClass === 'SAFE_BEFORE_PRINT') {
            try {
              drawerOpened = await this.openCashDrawerStrict();
            } catch (drawerError) {
              const describedDrawerError = this.describePrintFailure(
                drawerError,
                '[Payment] Standalone cash drawer fallback failed',
              );
              effectiveError = `${describedError}; ${describedDrawerError}`;
              effectiveFailureClass =
                getExplicitPrintFailureClass(drawerError) ?? 'UNCERTAIN_AFTER_PRINT';
              logger.error(describedDrawerError);
            }
          }
          if (failureClass !== 'SAFE_BEFORE_PRINT') {
            logger.warn(
              '[Payment] Skipping standalone cash drawer pulse because the combined receipt/drawer outcome is not explicitly safe before print',
            );
          }
          return {
            receiptPrinted: false,
            drawerOpened,
            error: effectiveError,
            failureClass: effectiveFailureClass,
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

      this.journalReceiptPrint({ orderId, documentType: 'ORDER', printerType: PrinterType.RECEIPT, route: 'LOCAL', status: receiptPrinted ? 'PRINTED' : 'FAILED' });
      return { receiptPrinted, drawerOpened };
    }

    if (options.localOnly) {
      const error = '[Payment] Local receipt printer became unavailable before print';
      logger.warn(error);
      this.journalReceiptPrint({
        orderId,
        documentType: 'ORDER',
        printerType: PrinterType.RECEIPT,
        route: 'LOCAL',
        status: 'NO_PRINTER',
        error,
      });
      return {
        receiptPrinted: false,
        drawerOpened: false,
        error,
        failureClass: 'SAFE_BEFORE_PRINT',
      };
    }

    const shared = await this.routeSharedReceipt(
      receiptData,
      { referenceType: 'POS_RECEIPT', referenceId: orderId, source: 'pos', openDrawer: true },
      successMessage,
      failureMessage,
    );
    if (shared) {
      if (shared.printed) {
        const drawerOpened = shared.drawerOpenRequested ? true : await this.openCashDrawer();
        this.journalReceiptPrint({ orderId, documentType: 'ORDER', printerType: PrinterType.RECEIPT, route: 'SHARED_NETWORK', status: 'PRINTED', printerId: shared.printerId });
        return { receiptPrinted: true, drawerOpened, error: undefined };
      }
      logger.warn(
        `[Payment] Shared receipt route did not print and no local receipt printer is ready: ` +
        `${shared.error || 'shared printer did not accept the job'}`,
      );
      this.journalReceiptPrint({ orderId, documentType: 'ORDER', printerType: PrinterType.RECEIPT, route: 'SHARED_NETWORK', status: 'FAILED', printerId: shared.printerId, error: shared.error });
      return {
        receiptPrinted: false,
        drawerOpened: false,
        error: shared.error,
        failureClass: shared.failureClass ?? 'UNCERTAIN_AFTER_PRINT',
      };
    }

    const error = '[Payment] No receipt printer connected, skipping print and drawer';
    logger.warn(error);
    this.journalReceiptPrint({ orderId, documentType: 'ORDER', printerType: PrinterType.RECEIPT, route: null, status: 'NO_PRINTER' });
    return {
      receiptPrinted: false,
      drawerOpened: false,
      error,
      failureClass: 'SAFE_BEFORE_PRINT',
    };
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
        this.journalFiscalReceipt({
          orderId,
          status: 'PRINTED',
          route: 'LOCAL',
          paymentMethod: receiptData.payment.method,
          grossTotal: receiptData.total / 100,
        });
        return true;
      } catch (err) {
        const error = this.describePrintFailure(err, failureMessage);
        logger.error(`${failureMessage}: ${err}`);
        this.journalFiscalReceipt({
          orderId,
          status: 'FAILED',
          route: 'LOCAL',
          paymentMethod: receiptData.payment.method,
          grossTotal: receiptData.total / 100,
          error,
        });
        throw new Error(error);
      }
    }

    if (this.sharedFiscalPrinter) {
      const shared = await this.sharedFiscalPrinter(receiptData, meta);
      if (shared.handled) {
        if (shared.printed) {
          logger.info(`${successMessage} via shared fiscal printer${shared.printerId ? ` ${shared.printerId}` : ''}`);
          // Mirror the confirmation into the LOCAL fiscal journal: the
          // paragon physically printed on another POS, but history and the
          // fiscal-visibility filter on THIS terminal read local
          // fiscal_attempts. Best-effort — never fail a confirmed print.
          try {
            fiscalAttemptRepo.recordRemoteFiscalSuccess(
              orderId,
              shared.jobId,
              shared.printerId,
              receiptData,
            );
            const persisted = await fiscalAttemptRepo.flush();
            if (!persisted.success) {
              logger.warn(
                `[Payment] Remote fiscal journal/handoff flush failed for ${orderId}: `
                + `${persisted.error || 'database flush failed'}`,
              );
            }
          } catch (journalErr) {
            logger.warn(`[Payment] Remote fiscal journal mirror failed for ${orderId}: ${journalErr}`);
          }
          this.journalFiscalReceipt({
            orderId,
            status: 'PRINTED',
            route: 'SHARED_NETWORK',
            paymentMethod: receiptData.payment.method,
            grossTotal: receiptData.total / 100,
            printerId: shared.printerId,
            printJobId: shared.jobId,
          });
          return true;
        }
        const error = shared.error || 'Remote fiscal printer did not confirm final print completion';
        logger.error(`${failureMessage}: ${error}`);
        this.journalFiscalReceipt({
          orderId,
          status: 'FAILED',
          route: 'SHARED_NETWORK',
          paymentMethod: receiptData.payment.method,
          grossTotal: receiptData.total / 100,
          printerId: shared.printerId,
          printJobId: shared.jobId,
          error,
        });
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
    const receiptData = this.buildSaleReceiptData(orderId);
    if (!receiptData) {
      logger.warn(`[Payment] Cannot reprint: order ${orderId} not found`);
      return false;
    }
    const order = orderRepo.getById(orderId);
    receiptData.isReprint = true;
    receiptData.originalDate = order?.created_at;

    return this.printReceiptData(
      receiptData,
      { referenceType: 'POS_RECEIPT_REPRINT', referenceId: orderId, source: 'pos-reprint' },
      `[Payment] Receipt REPRINTED for order ${receiptData.orderNumber}`,
      '[Payment] Receipt reprint failed',
      '[Payment] No receipt printer connected, cannot reprint',
    );
  }

  /**
   * Open cash drawer
   */
  private async openCashDrawerStrict(): Promise<boolean> {
    let printer = await this.ensurePrinterReady(this.getPrinter(PrinterType.RECEIPT), PrinterType.RECEIPT);
    if (!printer || !printer.isConnected()) {
      // Drawer-only fallback is safe for POSNET and does not create fiscal
      // turnover. Receipt printing itself remains strictly role-isolated.
      printer = await this.ensurePrinterReady(this.getPrinter(PrinterType.FISCAL), PrinterType.FISCAL);
    }
    if (!printer || !printer.isConnected()) {
      logger.warn('[Payment] No receipt or fiscal drawer route connected, cannot open drawer');
      return false;
    }

    await printer.openDrawer();
    logger.info('[Payment] Cash drawer opened');
    return true;
  }

  async openCashDrawer(): Promise<boolean> {
    try {
      return await this.openCashDrawerStrict();
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

    let storedLines: Array<{name: string; quantity: number; unitPrice: number; refundAmount: number; vatRate?: number; sku?: string; unit?: string}> | null = null;
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
        unit: l.unit || undefined,
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
          unit: i.sale_unit || product?.sale_unit || undefined,
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
