import { ReceiptData, PrinterType } from '../../shared/types';
import { orderRepo } from '../database/repos/order-repo';
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
  ) {}

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
      items: items.map((i) => ({
        name: i.name,
        quantity: i.quantity,
        unitPrice: i.price,
        totalPrice: i.total,
        vatRate: i.vat_rate,
        sku: i.sku || undefined,
      })),
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

    const receiptPrinted = await this.printReceipt(orderId);
    const drawerOpened = await this.openCashDrawer();
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
}
