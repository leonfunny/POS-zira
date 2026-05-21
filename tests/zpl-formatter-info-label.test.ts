import { describe, expect, it } from 'vitest';
import { ZplFormatter } from "../src/main/hardware/zebra/zpl-formatter";
import { ManufacturerRole, InfoLabelData, LabelData } from "../src/shared/types";

const sampleData: InfoLabelData = {
  productName: "Bánh quy Lotus Biscoff 125g",
  ingredients: "cukier, mąka pszenna, syrop kandyzowany cukru, olej palmowy, sól",
  bestBefore: "2026-12-31",
  manufacturerInfo: "Lotus Bakeries N.V., Gentstraat 52, 8700 Tielt, Belgia",
  manufacturerRole: ManufacturerRole.PRODUCER,
  countryOfOrigin: "BE",
  quantity: 1,
};

describe("ZplFormatter.formatInfoLabel", () => {
  it("renders all four sections at 50x40", () => {
    const f = new ZplFormatter(50, 40);
    const zpl = f.formatInfoLabel(sampleData, 50, 40);
    expect(zpl).toContain("Banh quy");
    expect(zpl).toContain("Skladniki:");
    expect(zpl).toContain("cukier");
    expect(zpl).toContain("Najlepiej spozyc przed: 31.12.2026");
    expect(zpl).toContain("Producent:");
    expect(zpl).toContain("Lotus Bakeries");
  });

  it("at 50x30 keeps ingredients when they fit and drops countryOfOrigin", () => {
    const f = new ZplFormatter(50, 30);
    const zpl = f.formatInfoLabel(sampleData, 50, 30);
    expect(zpl).toContain("Banh quy");
    expect(zpl).toContain("Skladniki:");
    expect(zpl).toContain("olej");
    expect(zpl).toContain("palmowy, sol");
    expect(zpl).not.toContain("Kraj pochodzenia");
  });

  it("uses a larger compact layout on 50x30 labels", () => {
    const f = new ZplFormatter(50, 30);
    const zpl = f.formatInfoLabel(sampleData, 50, 30);

    expect(zpl).toContain("^FO16,16^A0N,22,22^FB368,2");
    expect(zpl).toContain("^FO16,43^A0N,17,17^FB368,3");
    expect(zpl).toContain("^FO16,105^A0N,19,19");
    expect(zpl).toContain("^FO16,132^A0N,17,17^FB368,3");
  });

  it("at 60x40 includes countryOfOrigin row when present", () => {
    const f = new ZplFormatter(60, 40);
    const zpl = f.formatInfoLabel(sampleData, 60, 40);
    expect(zpl).toContain("Kraj pochodzenia:");
    expect(zpl).toContain("BE");
  });

  it("uses the full 100x150 label budget for info labels", () => {
    const f = new ZplFormatter(100, 150);
    const zpl = f.formatInfoLabel(sampleData, 100, 150);
    const yPositions = Array.from(zpl.matchAll(/\^FO\d+,(\d+)/g)).map((match) => Number(match[1]));

    expect(zpl).toContain("^PW800");
    expect(zpl).toContain("^A0N,40,40");
    expect(zpl).toContain("^FB720,10");
    expect(Math.max(...yPositions)).toBeGreaterThan(700);
  });

  it("can transliterate Polish text for Xprinter-compatible fonts", () => {
    const f = new ZplFormatter(100, 150, 203, "ascii");
    const zpl = f.formatInfoLabel({
      ...sampleData,
      ingredients: "Wartości odżywcze, węglowodany, białko, sól",
      manufacturerInfo: "Zollerstraße 7, właściciel marki",
    }, 100, 150);

    expect(zpl).toContain("Wartosci odzywcze");
    expect(zpl).toContain("weglowodany");
    expect(zpl).toContain("Zollerstrasse 7");
    expect(zpl).toContain("wlasciciel marki");
    expect(zpl).not.toContain("Wartości");
    expect(zpl).not.toContain("Zollerstraße");
  });

  it("omits countryOfOrigin row when null", () => {
    const f = new ZplFormatter(60, 40);
    const zpl = f.formatInfoLabel({ ...sampleData, countryOfOrigin: null }, 60, 40);
    expect(zpl).not.toContain("Kraj pochodzenia");
  });

  it("maps each ManufacturerRole to its Polish prefix", () => {
    const f = new ZplFormatter(60, 40);
    expect(f.formatInfoLabel({ ...sampleData, manufacturerRole: ManufacturerRole.PRODUCER }, 60, 40))
      .toContain("Producent:");
    expect(f.formatInfoLabel({ ...sampleData, manufacturerRole: ManufacturerRole.IMPORTER }, 60, 40))
      .toContain("Importer:");
    expect(f.formatInfoLabel({ ...sampleData, manufacturerRole: ManufacturerRole.DISTRIBUTOR }, 60, 40))
      .toContain("Dystrybutor:");
    expect(f.formatInfoLabel({ ...sampleData, manufacturerRole: ManufacturerRole.SUPPLIER }, 60, 40))
      .toContain("Dostawca:");
  });

  it("keeps UTF-8 charset while using font-safe text", () => {
    const f = new ZplFormatter(60, 40);
    const zpl = f.formatInfoLabel(sampleData, 60, 40);
    expect(zpl).toContain("^CI28");
    // Verify ^LL is omitted so printer uses calibrated label length
    expect(zpl).not.toContain("^LL");
  });

  it("emits N copies via ^PQ when quantity > 1", () => {
    const f = new ZplFormatter(60, 40);
    const zpl = f.formatInfoLabel({ ...sampleData, quantity: 3 }, 60, 40);
    expect(zpl).toContain("^PQ3");
  });

  it("transliterates Polish glyphs on info labels so Font 0 does not print blanks", () => {
    const f = new ZplFormatter(60, 40);
    const zpl = f.formatInfoLabel({
      ...sampleData,
      productName: "Mąka żytnia 1kg",
      ingredients: "Mąka PSZENNA, cukier, sól",
      manufacturerInfo: "Zażółć sp. z o.o.",
    }, 60, 40);

    expect(zpl).toContain("Maka zytnia 1kg");
    expect(zpl).toContain("Skladniki: Maka PSZENNA");
    expect(zpl).toContain("sol");
    expect(zpl).toContain("Zazolc sp. z o.o.");
    expect(zpl).not.toContain("Mąka");
    expect(zpl).not.toContain("Zażółć");
  });

  it("transliterates Vietnamese glyphs on info labels so Font 0 does not print blanks", () => {
    const f = new ZplFormatter(50, 30);
    const zpl = f.formatInfoLabel({
      productName: "Bánh tráng rế cuốn chả giò Toàn Á",
      ingredients: "Mąka pszenna, mąka ryżowa, cukier, sól.",
      bestBefore: "2027-02-18",
      manufacturerInfo: "Cơ sở chế biến thực phẩm Toàn Á, Hải Phòng, Wietnam",
      manufacturerRole: ManufacturerRole.PRODUCER,
      countryOfOrigin: null,
      quantity: 1,
    }, 50, 30);

    expect(zpl).toContain("Banh trang re cuon");
    expect(zpl).toContain("cha gio");
    expect(zpl).toContain("Toan A");
    expect(zpl).toContain("Skladniki: Maka pszenna");
    expect(zpl).toContain("Najlepiej spozyc przed: 18.02.2027");
    expect(zpl).toContain("Producent: Co so che bien thuc pham");
    expect(zpl).toContain("Toan A, Hai Phong, Wietnam");
    expect(zpl).not.toContain("...");
    expect(zpl).not.toMatch(/[^\x00-\x7F]/);
  });

  it("does not crash when backend omits optional info-label text fields", () => {
    const f = new ZplFormatter(60, 40);
    const zpl = f.formatInfoLabel({
      ...sampleData,
      ingredients: undefined as any,
      manufacturerInfo: undefined as any,
    }, 60, 40);

    expect(zpl).toContain("Skladniki:");
    expect(zpl).toContain("Producent:");
  });
});

describe("ZplFormatter.formatLabel", () => {
  it("uses configured width and calibrated label length", () => {
    const f = new ZplFormatter(50, 30);
    const data: LabelData = {
      barcode: "2000000000152",
      barcodeType: "EAN13",
      text1: "Bánh mì",
      quantity: 1,
    };

    const zpl = f.formatLabel(data);

    expect(zpl).toContain("^CI28");
    expect(zpl).toContain("^PW400");
    expect(zpl).not.toContain("^PW609");
    expect(zpl).not.toContain("^LL");
    expect(zpl).toContain("Bánh mì");
  });

  it("puts a wrapped product title above a 50x30 linear barcode", () => {
    const f = new ZplFormatter(50, 30);
    const zpl = f.formatLabel({
      barcode: "8801047626671",
      barcodeType: "EAN13",
      text1: "Pra\u017cone wodorosty Yangban Korea 30g",
      text2: "3.00 PLN",
      text3: "SKU prazone-wodorosty",
      quantity: 1,
    });

    const firstLineIndex = zpl.indexOf("Pra\u017cone wodorosty Yangban");
    const secondLineIndex = zpl.indexOf("Korea 30g");
    const barcodeIndex = zpl.indexOf("^BE,");

    expect(firstLineIndex).toBeGreaterThan(-1);
    expect(secondLineIndex).toBeGreaterThan(firstLineIndex);
    expect(barcodeIndex).toBeGreaterThan(secondLineIndex);
    expect(zpl).toContain("3.00 PLN");
    expect(zpl).toContain("SKU prazone-wodorosty");
  });

  it("honors explicit text1 line breaks and resolves AUTO EAN13 payloads", () => {
    const f = new ZplFormatter(50, 30);
    const zpl = f.formatLabel({
      barcode: "8801047626671",
      barcodeType: "AUTO",
      text1: "Pra\u017cone wodorosty\nYangban Korea 30g",
      quantity: 1,
    });

    expect(zpl).toContain("Pra\u017cone wodorosty");
    expect(zpl).toContain("Yangban Korea 30g");
    expect(zpl).not.toContain("Pra\u017cone wodorostyYangban");
    expect(zpl).toContain("^BE,");
  });

  it("keeps medium product names on two larger title lines and enlarges the price", () => {
    const f = new ZplFormatter(50, 30);
    const zpl = f.formatLabel({
      barcode: "5901234123457",
      barcodeType: "EAN13",
      text1: "Mieszanka do sma\u017cenia banan\u00f3w Lobo Banana Fritter Batter Mix 85g",
      text2: "6.00 PLN",
      text3: "#LOBO-86G SKU mieszanka-do-smaz",
      quantity: 1,
    });
    const lines = zpl.split("\n");
    const priceIndex = lines.indexOf("^FD6.00 PLN^FS");
    const priceFont = lines[priceIndex - 1]?.match(/\^A0,(\d+),(\d+)/);
    const barcodeIndex = lines.findIndex((line) => line.startsWith("^BE,"));
    const titleLines = lines
      .slice(0, barcodeIndex)
      .filter((line) => line.startsWith("^FD") && line.endsWith("^FS"));
    const titleFont = lines[lines.indexOf("^FDMieszanka do sma\u017cenia banan\u00f3w Lobo^FS") - 1]?.match(/\^A0,(\d+),(\d+)/);

    expect(titleLines).toEqual([
      "^FDMieszanka do sma\u017cenia banan\u00f3w Lobo^FS",
      "^FDBanana Fritter Batter Mix 85g^FS",
    ]);
    expect(zpl).not.toContain("\u2026");
    expect(priceIndex).toBeGreaterThan(0);
    expect(Number(titleFont?.[1] || 0)).toBeGreaterThanOrEqual(19);
    expect(Number(priceFont?.[1] || 0)).toBeGreaterThanOrEqual(32);
    expect(zpl).toContain("#LOBO-86G SKU mieszanka-do-smaz");
  });
});
