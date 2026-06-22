import { describe, expect, it } from 'vitest';
import QRCode from 'qrcode';
import { ZplFormatter } from '../src/main/hardware/zebra/zpl-formatter';
import type { KitchenTicketData } from '../src/shared/types';

const labelData: KitchenTicketData = {
  orderId: 'o-1',
  orderNumber: 'K-042',
  createdAt: '2026-06-17T12:23:00.000Z',
  source: 'KITCHEN_SELF_ORDER',
  fulfillmentType: 'TAKEAWAY',
  customerLanguage: 'vi',
  pickupNumber: 'K-042',
  brandName: 'Chè Sài Gòn',
  totalGrosze: 3400,
  qrPayload: 'KSO1:withnotes',
  labelQrPayload: 'KSO1:compact',
  items: [{ name: 'Chè', quantity: 3 }],
};

describe('formatKitchenPaymentLabel', () => {
  it('renders order number, count, total and fulfillment in the customer language', () => {
    const zpl = new ZplFormatter(50, 30).formatKitchenPaymentLabel(labelData);
    expect(zpl).toContain('K-042');
    expect(zpl).toContain('SO DON');
    expect(zpl).toContain('MANG DI');
    expect(zpl).toContain('3 mon');
    expect(zpl).toContain('34,00 zl');
  });

  it('uses labelQrPayload (compact), not qrPayload', () => {
    const zpl = new ZplFormatter(50, 30).formatKitchenPaymentLabel(labelData);
    expect(zpl).toContain('KSO1:compact');
    expect(zpl).not.toContain('KSO1:withnotes');
  });

  it('ASCII-folds Vietnamese deterministically regardless of textProfile', () => {
    for (const profile of ['zebra', 'ascii'] as const) {
      const zpl = new ZplFormatter(50, 30, 203, profile).formatKitchenPaymentLabel(labelData);
      expect(zpl).toContain('Che Sai Gon');
      expect(/[^\x00-\x7F]/.test(zpl)).toBe(false);
    }
  });

  it('keeps the QR within the label width for realistic compact payloads (~1/2/4 items)', () => {
    const dotsPerMm = 203 / 25.4;
    const labelDots = Math.round(50 * dotsPerMm);

    for (const total of [237, 313, 469]) {
      const payload = 'KSO1:' + 'a'.repeat(total - 5);
      const zpl = new ZplFormatter(50, 30).formatKitchenPaymentLabel({ ...labelData, labelQrPayload: payload });
      const match = zpl.match(/\^FO(\d+),\d+\n\^BQN,2,(\d)/);
      expect(match).toBeTruthy();
      const x = Number(match![1]);
      const mag = Number(match![2]);
      const modules = QRCode.create(payload, { errorCorrectionLevel: 'M' }).modules.size;
      expect(x + modules * mag).toBeLessThanOrEqual(labelDots);
    }
  });
});
