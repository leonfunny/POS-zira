/**
 * EscPosFormatter — Polish fiscal compliance regression coverage.
 *
 * Pinned wiki rules from
 * second-brain/wiki/concepts/zira-polish-fiscal-compliance.md:
 *   - Non-fiscal thermal output MUST NOT use the word "FISKALNY" — that
 *     term is legally reserved for registered fiscal printers and risks
 *     fines during a ZUS/US tax audit.
 *   - Refund receipts MUST reference the original order with date
 *     (`Oryginał: POS-… z dnia DD.MM.YYYY`).
 *   - Refund PTU lines MUST say `Zwrot opodatkowany X` (not
 *     `Sprzedaż opodatkowana X`) — same logic as the server PDF refund
 *     fix in wiki/troubleshooting/zira-refund-pdf-net-gross-mixup.md
 *     (Session 56).
 *   - Test print and other diagnostic dates MUST use the project's
 *     fixed `formatDatePl` helper, never `Date.toLocaleString()` (host-
 *     locale dependent).
 *
 * These tests prove the formatter behaves correctly today and prevent
 * a future commit from regressing into the legally risky shape.
 */

import { describe, expect, it } from 'vitest';
import { EscPosFormatter, type DailyReportData } from '../src/main/hardware/thermal/escpos-formatter';
import type { ReceiptData } from '../src/shared/types';

function buildReceiptData(overrides: Partial<ReceiptData> = {}): ReceiptData {
  return {
    orderNumber: 'POS-20260505-0001',
    salonName: 'Chè Sài Gòn',
    sellerName: 'Chè Sài Gòn Sp. z o.o.',
    sellerAddress: 'ul. Marszałkowska 1, 00-001 Warszawa',
    sellerNip: '5220052349',
    items: [
      { name: 'Bulka', quantity: 2, unitPrice: 200, totalPrice: 400, vatRate: 5 },
      { name: 'Mleko', quantity: 1, unitPrice: 350, totalPrice: 350, vatRate: 8 },
    ],
    payment: { method: 'CASH', amount: 750 },
    subtotal: 750,
    total: 750,
    cashierName: 'Anna',
    ...overrides,
  };
}

function buildReportData(overrides: Partial<DailyReportData> = {}): DailyReportData {
  return {
    date: '2026-05-06',
    transactionCount: 12,
    grossSales: 50000,
    discounts: 0,
    netSales: 50000,
    ...overrides,
  };
}

function bufferToString(buf: Buffer): string {
  // ESC/POS bytes embed text as UTF-8 between control sequences. A
  // string conversion is enough to grep for human-readable tokens; the
  // odd binary bytes simply become unmatched characters and don't
  // collide with our search needles.
  return buf.toString('utf8');
}

describe('EscPosFormatter — fiscal-wording compliance', () => {
  describe('G6 / fiscal-wording: non-fiscal thermal MUST not say FISKALNY', () => {
    // The thermal title is "ZAMOWIENIE" ("order" in Polish). Avoiding the
    // word PARAGON entirely also avoids the FISKALNY/NIEFISKALNY framing
    // — an order ticket is unambiguously not a fiscal receipt, so a ZUS/US
    // auditor cannot confuse it with the fiscal printout from the POSNET.
    // The compliance contract is: thermal output never contains the
    // standalone token FISKALNY (NIEFISKALNY is fine as a suffix because
    // the "NIE" negation is part of the same word).

    function expectThermalFiscalSafe(text: string) {
      // Negative lookbehind: FISKALNY must always be preceded by "NIE".
      expect(text).not.toMatch(/(?<!NIE)FISKALNY/);
    }

    it('formatReceipt prints "ZAMOWIENIE" and never the bare token FISKALNY', () => {
      const fmt = new EscPosFormatter(80, 48, { charset: 'utf8', cutMode: 'partial' });
      const buf = fmt.formatReceipt(buildReceiptData());
      const out = bufferToString(buf);
      expect(out).toContain('ZAMOWIENIE');
      expectThermalFiscalSafe(out);
    });

    it('formatReceiptPlainLines emits "ZAMOWIENIE" and never the bare token FISKALNY', () => {
      const fmt = new EscPosFormatter(80, 48, { charset: 'utf8', cutMode: 'partial' });
      const lines = fmt.formatReceiptPlainLines(buildReceiptData());
      const flat = lines.map((l) => l.text).join('\n');
      expect(flat).toContain('ZAMOWIENIE');
      expectThermalFiscalSafe(flat);
    });

    it('refund receipt also stays fiscal-safe', () => {
      const fmt = new EscPosFormatter(80, 48, { charset: 'utf8', cutMode: 'partial' });
      const buf = fmt.formatReceipt(
        buildReceiptData({
          isRefund: true,
          originalOrderNumber: 'POS-20260504-0099',
          originalDate: '2026-05-04T12:30:00.000Z',
          refundReason: 'Klient zwrocil towar',
        }),
      );
      const out = bufferToString(buf);
      expect(out).toContain('ZAMOWIENIE');
      expectThermalFiscalSafe(out);
    });
  });

  describe('G6 / refund PTU label: must say "Zwrot opodatkowany", not "Sprzedaz opodatkowana"', () => {
    it('refund formatReceipt PTU section uses Zwrot label', () => {
      const fmt = new EscPosFormatter(80, 48, { charset: 'utf8', cutMode: 'partial' });
      const buf = fmt.formatReceipt(
        buildReceiptData({
          isRefund: true,
          originalOrderNumber: 'POS-20260504-0099',
          originalDate: '2026-05-04T12:30:00.000Z',
        }),
      );
      const out = bufferToString(buf);
      // Wiki: "Zwrot opodatkowany X (not Sprzedaż opodatkowana — misleading on a refund)"
      expect(out).toMatch(/Zwrot opodatkowan[ya]/);
      // The sale-side label must NOT appear on a refund receipt.
      expect(out).not.toMatch(/Sprzedaz opodatkowana/);
    });

    it('refund formatReceiptPlainLines PTU section uses Zwrot label', () => {
      const fmt = new EscPosFormatter(80, 48, { charset: 'utf8', cutMode: 'partial' });
      const lines = fmt.formatReceiptPlainLines(
        buildReceiptData({
          isRefund: true,
          originalOrderNumber: 'POS-20260504-0099',
          originalDate: '2026-05-04T12:30:00.000Z',
        }),
      );
      const flat = lines.map((l) => l.text).join('\n');
      expect(flat).toMatch(/Zwrot opodatkowan[ya]/);
      expect(flat).not.toMatch(/Sprzedaz opodatkowana/);
    });

    it('non-refund (sale) keeps Sprzedaz opodatkowana — branch is correct, not unconditional', () => {
      const fmt = new EscPosFormatter(80, 48, { charset: 'utf8', cutMode: 'partial' });
      const buf = fmt.formatReceipt(buildReceiptData());
      const out = bufferToString(buf);
      expect(out).toMatch(/Sprzedaz opodatkowana/);
      expect(out).not.toMatch(/Zwrot opodatkowan/);
    });
  });

  describe('BLIK receipt instructions', () => {
    it('prints the BLIK phone number below the payment section', () => {
      const fmt = new EscPosFormatter(80, 48, { charset: 'utf8', cutMode: 'partial' });
      const lines = fmt.formatReceiptPlainLines(buildReceiptData({
        payment: { method: 'BLIK', amount: 750 },
      }));
      const flat = lines.map((l) => l.text).join('\n');

      expect(flat).toContain('BLIK');
      expect(flat).toContain('729448788');
      expect(flat.indexOf('729448788')).toBeLessThan(flat.lastIndexOf('BLIK'));
    });
  });

  describe('G3 / test print uses formatDatePl (not toLocaleString) and shows salon header', () => {
    it('formatTestPage date matches DD.MM.YYYY  HH:MM, never the slash-separated locale format', () => {
      const fmt = new EscPosFormatter(80, 48, { charset: 'utf8', cutMode: 'partial' });
      const buf = fmt.formatTestPage({ modelInfo: { modelName: 'Xprinter XP-80T' } });
      const out = bufferToString(buf);
      // Wiki rule: "Never use locale-dependent formatting
      // (toLocaleString) - results vary by machine". Assert the
      // structural date format that formatDatePl emits.
      expect(out).toMatch(/\d{2}\.\d{2}\.\d{4}\s+\d{2}:\d{2}/);
      // Defensive: a US-locale `M/D/YYYY` from toLocaleString would
      // collide with the line below. The fix replaces toLocaleString
      // with formatDatePl entirely.
      expect(out).not.toMatch(/\d{1,2}\/\d{1,2}\/\d{4}/);
    });

    it('formatTestPage prints printer profile (paper width / chars / charset / cut)', () => {
      const fmt = new EscPosFormatter(80, 48, { charset: 'utf8', cutMode: 'partial' });
      const buf = fmt.formatTestPage({ modelInfo: { modelName: 'Xprinter XP-80T' } });
      const out = bufferToString(buf);
      expect(out).toContain('Xprinter XP-80T');
      expect(out).toContain('80mm / 48 chars');
      expect(out).toMatch(/charset:\s*utf8/);
      expect(out).toMatch(/cut:\s*partial/);
    });

    it('formatTestPage includes salon header when opts.salonName/sellerName/sellerNip are passed', () => {
      const fmt = new EscPosFormatter(80, 48, { charset: 'utf8', cutMode: 'partial' });
      const buf = fmt.formatTestPage({
        salonName: 'Chè Sài Gòn',
        sellerName: 'Chè Sài Gòn Sp. z o.o.',
        sellerNip: '5220052349',
      });
      const out = bufferToString(buf);
      expect(out).toContain('Chè Sài Gòn');
      expect(out).toContain('Chè Sài Gòn Sp. z o.o.');
      expect(out).toContain('NIP: 5220052349');
    });

    it('formatTestPage works header-less when salon info is missing (legacy callsite)', () => {
      const fmt = new EscPosFormatter(80, 48, { charset: 'utf8', cutMode: 'partial' });
      const buf = fmt.formatTestPage({ modelInfo: { modelName: 'Generic 58mm' } });
      const out = bufferToString(buf);
      // Still emits diagnostic block — header is just absent.
      expect(out).toContain('Generic 58mm');
      expect(out).toContain('80mm / 48 chars');
      expect(out).not.toContain('NIP:');
    });
  });

  describe('G5 / refund must reference original order WITH date (z dnia DD.MM.YYYY)', () => {
    it('formatReceipt refund banner includes "z dnia DD.MM.YYYY" when originalDate is present', () => {
      const fmt = new EscPosFormatter(80, 48, { charset: 'utf8', cutMode: 'partial' });
      const buf = fmt.formatReceipt(
        buildReceiptData({
          isRefund: true,
          originalOrderNumber: 'POS-20260504-0099',
          // 2026-05-04 12:30 UTC. formatDatePl reads host-local time
          // components, so the printed date depends on the test
          // environment — assert the structural date pattern, not a
          // literal value.
          originalDate: '2026-05-04T12:30:00.000Z',
        }),
      );
      const out = bufferToString(buf);
      expect(out).toContain('Oryginal: #POS-20260504-0099');
      expect(out).toMatch(/z dnia \d{2}\.\d{2}\.\d{4}/);
    });

    it('formatReceiptPlainLines refund banner includes "z dnia DD.MM.YYYY" when originalDate is present', () => {
      const fmt = new EscPosFormatter(80, 48, { charset: 'utf8', cutMode: 'partial' });
      const lines = fmt.formatReceiptPlainLines(
        buildReceiptData({
          isRefund: true,
          originalOrderNumber: 'POS-20260504-0099',
          originalDate: '2026-05-04T12:30:00.000Z',
        }),
      );
      const flat = lines.map((l) => l.text).join('\n');
      expect(flat).toContain('Oryginal: #POS-20260504-0099');
      expect(flat).toMatch(/z dnia \d{2}\.\d{2}\.\d{4}/);
    });

    it('falls back to bare order number when originalDate is missing (older orders)', () => {
      const fmt = new EscPosFormatter(80, 48, { charset: 'utf8', cutMode: 'partial' });
      const buf = fmt.formatReceipt(
        buildReceiptData({
          isRefund: true,
          originalOrderNumber: 'POS-20260504-0099',
          // no originalDate
        }),
      );
      const out = bufferToString(buf);
      expect(out).toContain('Oryginal: #POS-20260504-0099');
      expect(out).not.toMatch(/z dnia/);
    });
  });

  describe('G3 / report footers use formatDatePl, not toLocaleString', () => {
    // PR-1 fixed only formatTestPage; the same wiki rule applies to the
    // three report methods. Date.toLocaleString() varies by host locale
    // (e.g. "5/4/2026, 2:30:00 PM" on en-US, "04/05/2026 14:30:00" on
    // vi-VN, "04.05.2026, 14:30:00" on pl-PL) — same Z-report from two
    // stations would render differently. formatDatePl emits the fixed
    // "DD.MM.YYYY  HH:MM" shape.

    it('formatDailyReport renders Wydrukowano: DD.MM.YYYY  HH:MM', () => {
      const fmt = new EscPosFormatter(80, 48, { charset: 'utf8', cutMode: 'partial' });
      const buf = fmt.formatDailyReport(buildReportData());
      const out = bufferToString(buf);
      expect(out).toMatch(/Wydrukowano:\s+\d{2}\.\d{2}\.\d{4}\s+\d{2}:\d{2}/);
      expect(out).not.toMatch(/\d{1,2}\/\d{1,2}\/\d{4}/);
    });

    it('formatXReport renders Wydrukowano: DD.MM.YYYY  HH:MM', () => {
      const fmt = new EscPosFormatter(80, 48, { charset: 'utf8', cutMode: 'partial' });
      const buf = fmt.formatXReport(buildReportData());
      const out = bufferToString(buf);
      expect(out).toMatch(/Wydrukowano:\s+\d{2}\.\d{2}\.\d{4}\s+\d{2}:\d{2}/);
      expect(out).not.toMatch(/\d{1,2}\/\d{1,2}\/\d{4}/);
    });

    it('formatZReport renders Wydrukowano: DD.MM.YYYY  HH:MM', () => {
      const fmt = new EscPosFormatter(80, 48, { charset: 'utf8', cutMode: 'partial' });
      const buf = fmt.formatZReport(buildReportData({ reportNumber: 'Z-001' }));
      const out = bufferToString(buf);
      expect(out).toMatch(/Wydrukowano:\s+\d{2}\.\d{2}\.\d{4}\s+\d{2}:\d{2}/);
      expect(out).not.toMatch(/\d{1,2}\/\d{1,2}\/\d{4}/);
    });
  });
});
