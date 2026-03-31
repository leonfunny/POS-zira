import { InvoiceRow, InvoiceItemRow, VatSummaryEntry } from '../../shared/types';

/**
 * A4 Invoice HTML Formatter for Windows driver printing
 * Professional Polish VAT invoice layout
 */
export class InvoiceA4Formatter {
  /**
   * Format invoice as HTML for A4 printing
   */
  formatInvoice(invoice: InvoiceRow, items: InvoiceItemRow[], vatSummary: VatSummaryEntry[]): string {
    const title = this.getInvoiceTitle(invoice.type);
    const isCorrection = invoice.type === 'CORRECTION';
    const isProforma = invoice.type === 'PROFORMA';

    return `<!DOCTYPE html>
<html lang="pl">
<head>
  <meta charset="UTF-8">
  <title>${title} ${invoice.invoice_number}</title>
  <style>
    @page {
      size: A4;
      margin: 15mm;
    }
    * {
      margin: 0;
      padding: 0;
      box-sizing: border-box;
    }
    body {
      font-family: 'Segoe UI', Tahoma, Arial, sans-serif;
      font-size: 10pt;
      line-height: 1.4;
      color: #333;
    }
    .invoice {
      max-width: 210mm;
      margin: 0 auto;
      padding: 10mm;
    }
    .header {
      display: flex;
      justify-content: space-between;
      margin-bottom: 20px;
      padding-bottom: 15px;
      border-bottom: 2px solid #333;
    }
    .title {
      font-size: 18pt;
      font-weight: bold;
      color: #1a1a1a;
    }
    .title-sub {
      font-size: 10pt;
      color: #666;
      margin-top: 5px;
    }
    .document-info {
      text-align: right;
    }
    .parties {
      display: flex;
      gap: 30px;
      margin-bottom: 20px;
    }
    .party {
      flex: 1;
      padding: 15px;
      background: #f8f9fa;
      border-radius: 4px;
    }
    .party-title {
      font-size: 9pt;
      font-weight: bold;
      color: #666;
      text-transform: uppercase;
      margin-bottom: 8px;
      letter-spacing: 0.5px;
    }
    .party-name {
      font-size: 11pt;
      font-weight: bold;
      margin-bottom: 5px;
    }
    .party-detail {
      font-size: 9pt;
      color: #555;
      margin-bottom: 2px;
    }
    .dates-row {
      display: flex;
      gap: 20px;
      margin-bottom: 20px;
      padding: 10px 15px;
      background: #fff;
      border: 1px solid #ddd;
      border-radius: 4px;
    }
    .date-item {
      flex: 1;
    }
    .date-label {
      font-size: 8pt;
      color: #666;
      text-transform: uppercase;
    }
    .date-value {
      font-size: 10pt;
      font-weight: 500;
    }
    table.items {
      width: 100%;
      border-collapse: collapse;
      margin-bottom: 20px;
      font-size: 9pt;
    }
    table.items th {
      background: #333;
      color: white;
      padding: 8px 10px;
      text-align: left;
      font-weight: 500;
    }
    table.items th.right {
      text-align: right;
    }
    table.items td {
      padding: 8px 10px;
      border-bottom: 1px solid #e0e0e0;
    }
    table.items td.right {
      text-align: right;
    }
    table.items tr:last-child td {
      border-bottom: none;
    }
    table.items tbody tr:nth-child(even) {
      background: #fafafa;
    }
    .summary-section {
      display: flex;
      justify-content: space-between;
      gap: 30px;
      margin-bottom: 20px;
    }
    .vat-table {
      flex: 1;
    }
    .vat-table table {
      width: 100%;
      border-collapse: collapse;
      font-size: 9pt;
    }
    .vat-table th {
      background: #f0f0f0;
      padding: 6px 10px;
      text-align: left;
      font-weight: 500;
      border: 1px solid #ddd;
    }
    .vat-table th.right {
      text-align: right;
    }
    .vat-table td {
      padding: 6px 10px;
      border: 1px solid #ddd;
    }
    .vat-table td.right {
      text-align: right;
    }
    .totals-box {
      width: 250px;
      padding: 15px;
      background: #f8f9fa;
      border-radius: 4px;
    }
    .total-row {
      display: flex;
      justify-content: space-between;
      margin-bottom: 8px;
      font-size: 10pt;
    }
    .total-row.grand {
      font-size: 14pt;
      font-weight: bold;
      padding-top: 10px;
      border-top: 2px solid #333;
      margin-top: 10px;
    }
    .payment-section {
      margin-bottom: 20px;
      padding: 15px;
      background: #f8f9fa;
      border-radius: 4px;
    }
    .payment-row {
      display: flex;
      gap: 30px;
      margin-bottom: 5px;
    }
    .payment-label {
      font-size: 9pt;
      color: #666;
      min-width: 120px;
    }
    .payment-value {
      font-size: 10pt;
      font-weight: 500;
    }
    .bank-info {
      margin-top: 10px;
      padding-top: 10px;
      border-top: 1px dashed #ccc;
    }
    .bank-info .bank-name {
      font-weight: 500;
    }
    .bank-info .bank-account {
      font-family: 'Courier New', monospace;
      font-size: 11pt;
      letter-spacing: 1px;
    }
    .notes-section {
      margin-bottom: 20px;
      padding: 10px 15px;
      background: #fff9e6;
      border-left: 4px solid #f5c518;
      font-size: 9pt;
    }
    .notes-title {
      font-weight: bold;
      margin-bottom: 5px;
    }
    .mpp-warning {
      padding: 10px 15px;
      background: #fff3cd;
      border: 1px solid #ffc107;
      border-radius: 4px;
      font-weight: bold;
      text-align: center;
      margin-bottom: 20px;
    }
    .words-amount {
      font-size: 9pt;
      color: #666;
      font-style: italic;
    }
    .footer {
      display: flex;
      justify-content: space-between;
      margin-top: 40px;
      padding-top: 20px;
    }
    .signature-box {
      width: 200px;
      text-align: center;
    }
    .signature-line {
      border-top: 1px solid #333;
      padding-top: 5px;
      font-size: 8pt;
      color: #666;
    }
    .correction-info {
      margin-bottom: 20px;
      padding: 15px;
      background: #fff0f0;
      border: 1px solid #ffcccc;
      border-radius: 4px;
    }
    .proforma-warning {
      text-align: center;
      padding: 10px;
      background: #e3f2fd;
      border: 1px solid #2196f3;
      border-radius: 4px;
      margin-bottom: 20px;
      font-weight: 500;
      color: #1565c0;
    }
    @media print {
      body { print-color-adjust: exact; -webkit-print-color-adjust: exact; }
    }
  </style>
</head>
<body>
  <div class="invoice">
    <div class="header">
      <div>
        <div class="title">${title}</div>
        ${isProforma ? '<div class="title-sub">Dokument nie jest faktura VAT</div>' : ''}
        ${isCorrection ? `<div class="title-sub">Do faktury nr ${this.escapeHtml(invoice.corrected_invoice_id || '')}</div>` : ''}
      </div>
      <div class="document-info">
        <div style="font-size: 14pt; font-weight: bold;">${this.escapeHtml(invoice.invoice_number)}</div>
      </div>
    </div>

    ${isProforma ? '<div class="proforma-warning">PROFORMA - Dokument nie stanowi podstawy do odliczenia VAT</div>' : ''}

    ${isCorrection && invoice.correction_reason ? `
    <div class="correction-info">
      <strong>Przyczyna korekty:</strong> ${this.escapeHtml(invoice.correction_reason)}
    </div>
    ` : ''}

    <div class="parties">
      <div class="party">
        <div class="party-title">Sprzedawca</div>
        <div class="party-name">${this.escapeHtml(invoice.seller_name)}</div>
        <div class="party-detail">${this.escapeHtml(invoice.seller_address)}</div>
        <div class="party-detail">NIP: ${this.escapeHtml(invoice.seller_nip)}</div>
        ${invoice.seller_regon ? `<div class="party-detail">REGON: ${this.escapeHtml(invoice.seller_regon)}</div>` : ''}
      </div>
      <div class="party">
        <div class="party-title">Nabywca</div>
        <div class="party-name">${this.escapeHtml(invoice.customer_name)}</div>
        ${invoice.customer_address ? `<div class="party-detail">${this.escapeHtml(invoice.customer_address)}</div>` : ''}
        ${invoice.customer_nip ? `<div class="party-detail">NIP: ${this.escapeHtml(invoice.customer_nip)}</div>` : ''}
        ${invoice.customer_regon ? `<div class="party-detail">REGON: ${this.escapeHtml(invoice.customer_regon)}</div>` : ''}
      </div>
    </div>

    <div class="dates-row">
      <div class="date-item">
        <div class="date-label">Data wystawienia</div>
        <div class="date-value">${this.escapeHtml(invoice.issue_date)}</div>
      </div>
      <div class="date-item">
        <div class="date-label">Data sprzedaży</div>
        <div class="date-value">${this.escapeHtml(invoice.sale_date)}</div>
      </div>
      ${invoice.due_date ? `
      <div class="date-item">
        <div class="date-label">Termin płatności</div>
        <div class="date-value">${this.escapeHtml(invoice.due_date)}</div>
      </div>
      ` : ''}
      <div class="date-item">
        <div class="date-label">Forma płatności</div>
        <div class="date-value">${this.getPaymentMethodName(invoice.payment_method)}</div>
      </div>
    </div>

    <table class="items">
      <thead>
        <tr>
          <th style="width: 30px;">Lp.</th>
          <th>Nazwa towaru / usługi</th>
          <th style="width: 50px;">Jedn.</th>
          <th class="right" style="width: 60px;">Ilość</th>
          <th class="right" style="width: 80px;">Cena netto</th>
          <th class="right" style="width: 50px;">VAT</th>
          <th class="right" style="width: 80px;">Wartość netto</th>
          <th class="right" style="width: 70px;">Kwota VAT</th>
          <th class="right" style="width: 90px;">Wartość brutto</th>
        </tr>
      </thead>
      <tbody>
        ${items.map((item, idx) => this.formatItemRow(item, idx + 1)).join('')}
      </tbody>
    </table>

    <div class="summary-section">
      <div class="vat-table">
        <table>
          <thead>
            <tr>
              <th>Stawka VAT</th>
              <th class="right">Netto</th>
              <th class="right">VAT</th>
              <th class="right">Brutto</th>
            </tr>
          </thead>
          <tbody>
            ${vatSummary.map(vat => `
            <tr>
              <td>${vat.rate >= 0 ? vat.rate + '%' : 'ZW'}</td>
              <td class="right">${this.formatMoney(vat.net)}</td>
              <td class="right">${this.formatMoney(vat.vat)}</td>
              <td class="right">${this.formatMoney(vat.gross)}</td>
            </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
      <div class="totals-box">
        <div class="total-row">
          <span>Razem netto:</span>
          <span>${this.formatMoney(invoice.total_net)}</span>
        </div>
        <div class="total-row">
          <span>Razem VAT:</span>
          <span>${this.formatMoney(invoice.total_vat)}</span>
        </div>
        <div class="total-row grand">
          <span>DO ZAPLATY:</span>
          <span>${this.formatMoney(invoice.total_gross)}</span>
        </div>
        <div class="words-amount">
          Słownie: ${this.numberToWords(invoice.total_gross)}
        </div>
      </div>
    </div>

    ${invoice.split_payment_marker ? `
    <div class="mpp-warning">
      MECHANIZM PODZIELONEJ PŁATNOŚCI (MPP)
    </div>
    ` : ''}

    ${invoice.payment_method === 'BANK_TRANSFER' && invoice.seller_bank_account ? `
    <div class="payment-section">
      <div class="payment-row">
        <span class="payment-label">Forma płatności:</span>
        <span class="payment-value">Przelew bankowy</span>
      </div>
      <div class="bank-info">
        ${invoice.seller_bank_name ? `<div class="bank-name">${this.escapeHtml(invoice.seller_bank_name)}</div>` : ''}
        <div class="bank-account">${this.escapeHtml(invoice.seller_bank_account)}</div>
      </div>
    </div>
    ` : ''}

    ${invoice.notes ? `
    <div class="notes-section">
      <div class="notes-title">Uwagi:</div>
      <div>${this.escapeHtml(invoice.notes)}</div>
    </div>
    ` : ''}

    <div class="footer">
      <div class="signature-box">
        <div class="signature-line">Podpis osoby uprawnionej<br>do wystawienia dokumentu</div>
      </div>
      <div class="signature-box">
        <div class="signature-line">Podpis osoby uprawnionej<br>do odbioru dokumentu</div>
      </div>
    </div>
  </div>
</body>
</html>`;
  }

  /**
   * Format a single item row
   */
  private formatItemRow(item: InvoiceItemRow, index: number): string {
    const qty = (item.quantity / 1000).toFixed(2);
    const vatRate = item.vat_rate >= 0 ? `${item.vat_rate}%` : 'ZW';
    const unit = item.unit || 'szt.';

    return `
    <tr>
      <td>${index}</td>
      <td>${this.escapeHtml(item.name)}${item.sku ? ` <small style="color:#666">(${this.escapeHtml(item.sku)})</small>` : ''}</td>
      <td>${this.escapeHtml(unit)}</td>
      <td class="right">${qty}</td>
      <td class="right">${this.formatMoney(item.unit_price_net)}</td>
      <td class="right">${vatRate}</td>
      <td class="right">${this.formatMoney(item.total_net)}</td>
      <td class="right">${this.formatMoney(item.vat_amount)}</td>
      <td class="right">${this.formatMoney(item.total_gross)}</td>
    </tr>`;
  }

  /**
   * Get invoice title based on type
   */
  private getInvoiceTitle(type: string): string {
    const titles: Record<string, string> = {
      RECEIPT: 'PARAGON',
      VAT: 'FAKTURA VAT',
      PROFORMA: 'FAKTURA PROFORMA',
      CORRECTION: 'FAKTURA KORYGUJĄCA',
      ADVANCE: 'FAKTURA ZALICZKOWA',
    };
    return titles[type] || 'FAKTURA';
  }

  /**
   * Get payment method name in Polish
   */
  private getPaymentMethodName(method: string): string {
    const names: Record<string, string> = {
      CASH: 'Gotówka',
      CARD: 'Karta płatnicza',
      BANK_TRANSFER: 'Przelew bankowy',
      BLIK: 'BLIK',
      P24: 'Przelewy24',
    };
    return names[method] || method;
  }

  /**
   * Format money value (grosze to zł)
   */
  private formatMoney(grosze: number): string {
    const zl = grosze / 100;
    return zl.toLocaleString('pl-PL', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' PLN';
  }

  /**
   * Convert number to Polish words (simplified)
   */
  private numberToWords(grosze: number): string {
    const zl = Math.floor(grosze / 100);
    const gr = grosze % 100;

    const ones = ['', 'jeden', 'dwa', 'trzy', 'cztery', 'pięć', 'sześć', 'siedem', 'osiem', 'dziewięć'];
    const teens = ['dziesięć', 'jedenaście', 'dwanaście', 'trzynaście', 'czternaście', 'piętnaście', 'szesnaście', 'siedemnaście', 'osiemnaście', 'dziewiętnaście'];
    const tens = ['', '', 'dwadzieścia', 'trzydzieści', 'czterdzieści', 'pięćdziesiąt', 'sześćdziesiąt', 'siedemdziesiąt', 'osiemdziesiąt', 'dziewięćdziesiąt'];
    const hundreds = ['', 'sto', 'dwieście', 'trzysta', 'czterysta', 'pięćset', 'sześćset', 'siedemset', 'osiemset', 'dziewięćset'];

    const convertUnder1000 = (n: number): string => {
      if (n === 0) return '';
      if (n < 10) return ones[n];
      if (n < 20) return teens[n - 10];
      if (n < 100) {
        const t = Math.floor(n / 10);
        const o = n % 10;
        return tens[t] + (o > 0 ? ' ' + ones[o] : '');
      }
      const h = Math.floor(n / 100);
      const r = n % 100;
      return hundreds[h] + (r > 0 ? ' ' + convertUnder1000(r) : '');
    };

    const convertThousands = (n: number): string => {
      if (n === 0) return 'zero';
      if (n < 1000) return convertUnder1000(n);

      const thousands = Math.floor(n / 1000);
      const rest = n % 1000;

      let result = '';
      if (thousands === 1) {
        result = 'tysiąc';
      } else if (thousands >= 2 && thousands <= 4) {
        result = convertUnder1000(thousands) + ' tysiące';
      } else {
        result = convertUnder1000(thousands) + ' tysięcy';
      }

      if (rest > 0) {
        result += ' ' + convertUnder1000(rest);
      }

      return result;
    };

    const zlWords = convertThousands(zl);
    const grPadded = gr.toString().padStart(2, '0');

    return `${zlWords} ${grPadded}/100 PLN`;
  }

  /**
   * Escape HTML special characters
   */
  private escapeHtml(str: string | null | undefined): string {
    if (!str) return '';
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }
}
