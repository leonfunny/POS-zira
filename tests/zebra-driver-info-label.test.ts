import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

vi.mock("../src/main/hardware/port-utils", () => ({
  listWindowsPrinters: vi.fn(async () => ["Mock Printer"]),
  sanitizePrinterName: vi.fn((name: string) => name),
  isWindowsPrinterPresent: vi.fn(async () => true),
  flushStuckPrintJobs: vi.fn(async () => 0),
  getStuckPrintJobStatus: vi.fn(async () => null),
}));

import { ZebraDriver } from "../src/main/hardware/zebra/zebra-driver";
import { ManufacturerRole, InfoLabelData } from "../src/shared/types";

const sample: InfoLabelData = {
  productName: "Test 100g",
  ingredients: "a, b, c",
  bestBefore: "2026-12-31",
  manufacturerInfo: "Foo Sp. z o.o., ul. Główna 1, Warszawa",
  manufacturerRole: ManufacturerRole.PRODUCER,
  countryOfOrigin: null,
  quantity: 1,
};

describe("ZebraDriver.printInfoLabel", () => {
  let driver: ZebraDriver;
  let spoolSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    driver = new ZebraDriver("Mock Printer", 60, 40);
    (driver as any).connected = true;
    spoolSpy = vi.spyOn(driver as any, "printRaw").mockResolvedValue(undefined);
  });

  afterEach(() => spoolSpy.mockRestore());

  it("calls the formatter with configured paper size", async () => {
    await driver.printInfoLabel(sample);
    expect(spoolSpy).toHaveBeenCalledTimes(1);
    const zpl: string = spoolSpy.mock.calls[0][0];
    expect(zpl).toContain("^CI28");
    expect(zpl).toContain("^PW480"); // 60mm * 8 dpmm = 480 dots
    expect(zpl).not.toContain("^LL");
    expect(zpl).toContain("Producent:");
    expect(zpl).toContain("Test 100g");
  });

  it("uses ASCII transliteration for Xprinter-compatible label printers", async () => {
    const xprinter = new ZebraDriver("Xprinter XP-423B", 100, 150);
    (xprinter as any).connected = true;
    const xprinterSpool = vi.spyOn(xprinter as any, "printRaw").mockResolvedValue(undefined);

    try {
      await xprinter.printInfoLabel({
        ...sample,
        productName: "Bánh tráng rế Toàn Á",
        ingredients: "Wartości odżywcze, węglowodany, białko, sól",
        manufacturerInfo: "Cơ sở chế biến thực phẩm Toàn Á, Zollerstraße 7, właściciel marki",
      });

      const zpl: string = xprinterSpool.mock.calls[0][0];
      expect(zpl).toContain("Banh trang re Toan A");
      expect(zpl).toContain("Wartosci odzywcze");
      expect(zpl).toContain("Co so che bien");
      expect(zpl).toContain("thuc pham");
      expect(zpl).toContain("Toan A");
      expect(zpl).toContain("Zollerstrasse 7");
      expect(zpl).toContain("wlasciciel");
      expect(zpl).toContain("marki");
      expect(zpl).not.toContain("Bánh");
      expect(zpl).not.toContain("Cơ sở");
      expect(zpl).not.toContain("Wartości");
      expect(zpl).not.toContain("Zollerstraße");
    } finally {
      xprinterSpool.mockRestore();
      xprinter.disconnect();
    }
  });

  it("does not replace configured dimensions with Windows driver paper size during connect", async () => {
    const detectSpy = vi
      .spyOn(ZebraDriver, "detectPaperSize")
      .mockResolvedValue({ widthMm: 76.2, heightMm: 50.8 });
    const configured = new ZebraDriver("Mock Printer", 50, 30);
    const labelSpy = vi.spyOn(configured as any, "printRaw").mockResolvedValue(undefined);

    try {
      await expect(configured.connect()).resolves.toBe(true);
      await configured.printLabel({
        barcode: "2000000000152",
        barcodeType: "EAN13",
        text1: "Bánh mì",
        quantity: 1,
      });

      const zpl: string = labelSpy.mock.calls[0][0];
      expect(detectSpy).not.toHaveBeenCalled();
      expect(zpl).toContain("^CI28");
      expect(zpl).toContain("^PW400");
      expect(zpl).not.toContain("^PW609");
      expect(zpl).toContain("Bánh mì");
    } finally {
      detectSpy.mockRestore();
      labelSpy.mockRestore();
      configured.disconnect();
    }
  });

  it("uses ASCII product-label text on GK420d so accented glyphs do not disappear", async () => {
    const configured = new ZebraDriver("ZDesigner GK420d", 50, 30);
    (configured as any).connected = true;
    const labelSpy = vi.spyOn(configured as any, "printRaw").mockResolvedValue(undefined);

    try {
      await configured.printLabel({
        barcode: "5901234123457",
        barcodeType: "EAN13",
        text1: "B\u00e1nh m\u00ec \u0141\u00f3d\u017a",
        text2: "12.99 zl",
        quantity: 1,
      });

      const zpl: string = labelSpy.mock.calls[0][0];
      expect(zpl).toContain("Banh mi Lodz");
      expect(zpl).not.toContain("B\u00e1nh");
      expect(zpl).not.toContain("\u0141\u00f3d\u017a");
    } finally {
      labelSpy.mockRestore();
      configured.disconnect();
    }
  });

  it("prints KSO payment labels through a dedicated method instead of product-label printLabel", async () => {
    const configured = new ZebraDriver("ZDesigner GK420d", 50, 30);
    (configured as any).connected = true;
    const labelSpy = vi.spyOn(configured as any, "printRaw").mockResolvedValue(undefined);

    try {
      await configured.printKitchenPaymentLabel({
        orderId: "kso-1",
        orderNumber: "K-042",
        pickupNumber: "K-042",
        createdAt: "2026-06-16T10:00:00.000Z",
        source: "KIOSK PC-YURI",
        fulfillmentType: "DINE_IN",
        customerLanguage: "pl",
        totalGrosze: 2900,
        qrPayload: "KSO1:test",
        items: [{ name: "Pho bo", quantity: 2, unitPriceGrosze: 1200, lineTotalGrosze: 2400 }],
      });

      const zpl: string = labelSpy.mock.calls[0][0];
      expect(zpl).toContain("DO ZAPLATY");
      expect(zpl).toContain("K-042");
      expect(zpl).toContain("^BQN,2,2");
      expect(zpl).not.toContain("^BE,");
    } finally {
      labelSpy.mockRestore();
      configured.disconnect();
    }
  });

  it("throws when disconnected", async () => {
    (driver as any).connected = false;
    await expect(driver.printInfoLabel(sample)).rejects.toThrow();
  });
});
