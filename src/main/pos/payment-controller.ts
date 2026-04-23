import { ReceiptData, PrinterType } from '../../shared/types';
import { orderRepo } from '../database/repos/order-repo';
import { productRepo } from '../database/repos/product-repo';
import logger from '../logger';

export interface PaymentResult {
  success: boolean;
  receiptPrinted: boolean;
  drawerOpened?: boolean;
  error?: string;
}

type PrinterDriver = {
  isConnected(): boolean;
  printReceipt(data: ReceiptData): Promise<void>;
  openDrawer(): Promise<void>;
};

type GetPrinter = (type: string) => PrinterDriver | null;

export class PaymentController {
  constructor(
    private getPrinter: GetPrinter,
    private isOnline: () => boolean,
    private getSalonName?: () => string | undefined,
    private getSellerName?: () => string | undefined,
    private getSellerAddress?: () => string | undefined,
    private getSellerNip?: () => string | undefined,
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
   * Print a receipt for a completed order.
   * Returns whether the receipt was actually printed.
   */
  async printReceipt(orderId: string): Promise<boolean> {
    const order = orderRepo.getById(orderId);
    if (!order) {
      logger.warn(`[Payment] Cannot print receipt: order ${orderId} not found`);
      return false;
    }

    const items = orderRepo.getItemsByOrderId(orderId);
    const printer = this.getPrinter(PrinterType.RECEIPT);

    if (!printer || !printer.isConnected()) {
      logger.warn('[Payment] No receipt printer connected, skipping print');
      return false;
    }

    const receiptData: ReceiptData = {
      orderNumber: order.order_number || orderId.substring(0, 8),
      salonName: this.getSalonName?.(),
      sellerName: this.getSellerName?.(),
      sellerAddress: this.getSellerAddress?.(),
      sellerNip: this.getSellerNip?.(),
      items: items.map((i) => {
        // Look up sale_unit from product catalog
        const product = i.variant_id ? productRepo.getById(i.variant_id) : null;
        return {
          name: i.name,
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

    try {
      await printer.printReceipt(receiptData);
      logger.info(`[Payment] Receipt printed for order ${order.order_number}`);
      return true;
    } catch (err) {
      logger.error(`[Payment] Receipt print failed: ${err}`);
      return false;
    }
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
    const printer = this.getPrinter(PrinterType.RECEIPT);

    if (!printer || !printer.isConnected()) {
      logger.warn('[Payment] No receipt printer connected, cannot reprint');
      return false;
    }

    const receiptData: ReceiptData = {
      orderNumber: order.order_number || orderId.substring(0, 8),
      salonName: this.getSalonName?.(),
      sellerName: this.getSellerName?.(),
      sellerAddress: this.getSellerAddress?.(),
      sellerNip: this.getSellerNip?.(),
      items: items.map((i) => {
        const product = i.variant_id ? productRepo.getById(i.variant_id) : null;
        return {
          name: i.name,
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

    try {
      await printer.printReceipt(receiptData);
      logger.info(`[Payment] Receipt REPRINTED for order ${order.order_number}`);
      return true;
    } catch (err) {
      logger.error(`[Payment] Receipt reprint failed: ${err}`);
      return false;
    }
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

    const [receiptPrinted, drawerOpened] = await Promise.all([
      this.printReceipt(orderId),
      this.openCashDrawer(),
    ]);
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
   * Print a refund receipt — shows "ZWROT / REFUND" banner.
   * Uses stored refund_lines for accurate per-item data; falls back to all items for older orders.
   */
  async printRefundReceipt(orderId: string): Promise<boolean> {
    const order = orderRepo.getById(orderId);
    if (!order) {
      logger.warn(`[Payment] Cannot print refund receipt: order ${orderId} not found`);
      return false;
    }

    const printer = this.getPrinter(PrinterType.RECEIPT);
    if (!printer || !printer.isConnected()) {
      logger.warn('[Payment] No receipt printer connected, cannot print refund receipt');
      return false;
    }

    const refundAmount = order.refund_amount ?? order.total;

    let receiptItems: ReceiptData['items'];
    let refundSubtotal: number;

    let storedLines: Array<{name: string; quantity: number; unitPrice: number; refundAmount: number; vatRate?: number; sku?: string}> | null = null;
    if (order.refund_lines) {
      try { storedLines = JSON.parse(order.refund_lines); } catch {}
    }

    if (storedLines && storedLines.length > 0) {
      receiptItems = storedLines.map(l => ({
        name: l.name,
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
          name: i.name,
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
      refundReason: order.refund_reason || undefined,
      originalOrderNumber: order.order_number || orderId.substring(0, 8),
    };

    try {
      await printer.printReceipt(receiptData);
      logger.info(`[Payment] Refund receipt printed for order ${order.order_number}`);
      return true;
    } catch (err) {
      logger.error(`[Payment] Refund receipt print failed: ${err}`);
      return false;
    }
  }
}
