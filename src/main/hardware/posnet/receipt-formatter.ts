import { ReceiptData, ReceiptItem } from '../../../shared/types';

/**
 * VAT rate mapping for Posnet
 * A = 23% (standard)
 * B = 8% (reduced)
 * C = 5% (reduced)
 * D = 0% (zero rate)
 * E = exempt
 */
const VAT_MAPPING: Map<number, string> = new Map([
  [23, 'A'],
  [8, 'B'],
  [5, 'C'],
  [0, 'D'],
  [-1, 'E'], // Exempt
]);

/**
 * Payment method mapping
 * 0 = Gotówka (cash)
 * 1 = Czek
 * 2 = Karta (card)
 * 3 = Bon
 * 4 = Kredyt
 */
const PAYMENT_MAPPING: Record<string, number> = {
  CASH: 0,
  CARD: 2,
  BLIK: 2,
  BANK_TRANSFER: 2,
};

/**
 * Formatted receipt data for Posnet
 */
interface PosnetReceiptData {
  items: PosnetLineItem[];
  payment: {
    type: number;
    amount: number;
  };
  cashier?: string;
  customer?: {
    name?: string;
    nip?: string;
  };
}

interface PosnetLineItem {
  name: string;      // Max 40 chars
  quantity: number;  // Decimal (3 places)
  price: number;     // In grosze (1/100 PLN)
  total: number;     // In grosze (1/100 PLN)
  vat: string;       // A, B, C, D, E
}

/**
 * Receipt formatter for Posnet printers
 * Converts order data to Posnet-compatible format
 */
export class ReceiptFormatter {
  /**
   * Format order data for Posnet
   */
  formatOrder(order: ReceiptData): PosnetReceiptData {
    return {
      items: order.items.map((item) => this.formatItem(item)),
      payment: {
        type: this.mapPaymentMethod(order.payment.method),
        amount: order.payment.amount, // Already in grosze
      },
      cashier: order.cashierName,
      customer: order.customerNip
        ? {
            name: order.customerName,
            nip: order.customerNip,
          }
        : undefined,
    };
  }

  /**
   * Format single line item
   */
  private formatItem(item: ReceiptItem): PosnetLineItem {
    return {
      name: this.sanitizeName(item.name, 40),
      quantity: item.quantity,
      price: item.unitPrice, // Already in grosze
      total: item.totalPrice, // Already in grosze
      vat: this.mapVatRate(item.vatRate),
    };
  }

  /**
   * Sanitize product name for printer
   * - Limit length
   * - Keep Polish characters (WINDOWS-1250 encoding supported)
   * - Remove special characters that might cause issues
   */
  private sanitizeName(name: string, maxLength: number): string {
    // Remove problematic characters
    let sanitized = name
      .replace(/[\x00-\x1F\x7F]/g, '') // Control characters
      .replace(/[\\\"]/g, '') // Escape chars
      .trim();

    // Truncate to max length
    if (sanitized.length > maxLength) {
      sanitized = sanitized.substring(0, maxLength - 1) + '.';
    }

    return sanitized;
  }

  /**
   * Map VAT rate percentage to Posnet code
   */
  private mapVatRate(rate: number): string {
    return VAT_MAPPING.get(rate) || 'A'; // Default to standard rate
  }

  /**
   * Map payment method to Posnet code
   */
  private mapPaymentMethod(method: string): number {
    return PAYMENT_MAPPING[method.toUpperCase()] ?? 0; // Default to cash
  }

  /**
   * Format currency value for display
   */
  formatCurrency(grosze: number): string {
    const zl = grosze / 100;
    return zl.toFixed(2).replace('.', ',') + ' zł';
  }

  /**
   * Calculate VAT summary for receipt
   */
  calculateVatSummary(items: ReceiptItem[]): Map<string, { net: number; vat: number; gross: number }> {
    const summary = new Map<string, { net: number; vat: number; gross: number }>();

    for (const item of items) {
      const vatCode = this.mapVatRate(item.vatRate);
      const gross = item.totalPrice;
      const net = Math.round(gross / (1 + item.vatRate / 100));
      const vat = gross - net;

      const existing = summary.get(vatCode) || { net: 0, vat: 0, gross: 0 };
      summary.set(vatCode, {
        net: existing.net + net,
        vat: existing.vat + vat,
        gross: existing.gross + gross,
      });
    }

    return summary;
  }
}
