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
      quantity: 1,
    });

    const firstLineIndex = zpl.indexOf("Pra\u017cone wodorosty");
    const secondLineIndex = zpl.indexOf("Yangban Korea 30g");
    const barcodeIndex = zpl.indexOf("^BE,");

    expect(firstLineIndex).toBeGreaterThan(-1);
    expect(secondLineIndex).toBeGreaterThan(firstLineIndex);
    expect(barcodeIndex).toBeGreaterThan(secondLineIndex);
    expect(zpl).toContain("3.00 PLN");
    expect(zpl).toContain("^FD8801047626671^FS");
    expect(zpl).not.toContain("SKU ");
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

  it("keeps medium product names complete across readable lines and enlarges the price", () => {
    const f = new ZplFormatter(50, 30);
    const zpl = f.formatLabel({
      barcode: "5901234123457",
      barcodeType: "EAN13",
      text1: "Mieszanka do sma\u017cenia banan\u00f3w Lobo Banana Fritter Batter Mix 85g",
      text2: "6.00 PLN",
      quantity: 1,
    });
    const lines = zpl.split("\n");
    const priceIndex = lines.indexOf("^FD6.00 PLN^FS");
    const priceFont = lines[priceIndex - 1]?.match(/\^A0,(\d+),(\d+)/);
    const barcodeIndex = lines.findIndex((line) => line.startsWith("^BE,"));
    const barcodeY = Number(lines[barcodeIndex - 1]?.match(/\^FO\d+,(\d+)/)?.[1] || 0);
    const barcodeHeight = Number(lines[barcodeIndex]?.match(/\^BE,(\d+),/)?.[1] || 0);
    const priceY = Number(lines[priceIndex - 2]?.match(/\^FO\d+,(\d+)/)?.[1] || 0);
    const barcodeValueIndex = lines.lastIndexOf("^FD5901234123457^FS");
    const barcodeValueFont = lines[barcodeValueIndex - 1]?.match(/\^A0,(\d+),(\d+)/);
    const titleLines = lines
      .slice(0, barcodeIndex)
      .filter((line) => line.startsWith("^FD") && line.endsWith("^FS"));
    const titleFont = lines[lines.indexOf("^FDMieszanka do sma\u017cenia^FS") - 1]?.match(/\^A0,(\d+),(\d+)/);

    expect(titleLines).toEqual([
      "^FDMieszanka do sma\u017cenia^FS",
      "^FDbanan\u00f3w Lobo Banana Fritter^FS",
      "^FDBatter Mix 85g^FS",
    ]);
    expect(zpl).not.toContain("\u2026");
    expect(priceIndex).toBeGreaterThan(0);
    expect(Number(titleFont?.[1] || 0)).toBeGreaterThanOrEqual(21);
    expect(Number(priceFont?.[1] || 0)).toBeGreaterThanOrEqual(44);
    expect(Number(barcodeValueFont?.[1] || 0)).toBeGreaterThanOrEqual(19);
    expect(priceY - (barcodeY + barcodeHeight)).toBeGreaterThanOrEqual(24);
    expect(zpl).toContain("^BY3");
    expect(zpl).toContain("^BE,");
    expect(zpl).toContain(",N,N,N");
  });

  it("keeps the complete long Polish title, readable EAN, and price inside a 50x30 shelf label", () => {
    const f = new ZplFormatter(50, 30);
    const productName = 'Snack z wodorostów z solą morską "Kung Fu Panda" LAVERLAND CRUNCH 4.5g x 3szt';
    const zpl = f.formatLabel({
      barcode: "8802241901267",
      barcodeType: "EAN13",
      text1: productName,
      text2: "123.45 PLN/kg",
      quantity: 1,
    });
    const lines = zpl.split("\n");
    const textBounds: Array<{ x: number; y: number; height: number; width: number; text: string }> = [];

    for (let index = 0; index < lines.length - 2; index += 1) {
      const origin = lines[index].match(/^\^FO(\d+),(\d+)$/);
      const font = lines[index + 1].match(/^\^A0,(\d+),(\d+)$/);
      const field = lines[index + 2].match(/^\^FD(.*)\^FS$/);
      if (!origin || !font || !field) continue;
      textBounds.push({
        x: Number(origin[1]),
        y: Number(origin[2]),
        height: Number(font[1]),
        width: Number(font[2]),
        text: field[1],
      });
    }

    expect(zpl).toContain("^PW400");
    expect(zpl).not.toContain("^LL");
    expect(zpl).not.toContain("\u2026");
    expect(zpl).not.toContain("SKU ");
    const barcodeIndex = lines.findIndex((line) => line.startsWith("^BE,"));
    const printedTitle = lines
      .slice(0, barcodeIndex)
      .filter((line) => line.startsWith("^FD") && line.endsWith("^FS"))
      .map((line) => line.slice(3, -3))
      .join(" ");
    expect(printedTitle).toBe(productName);
    expect(textBounds.length).toBeGreaterThanOrEqual(5);
    for (const field of textBounds) {
      const estimatedPrintedWidth = Array.from(field.text).length * field.width * 0.32;
      expect(field.x + estimatedPrintedWidth).toBeLessThanOrEqual(400);
      expect(field.y + field.height).toBeLessThanOrEqual(240);
    }
    const titleBounds = textBounds.filter((field) => !["8802241901267", "123.45 PLN/kg"].includes(field.text));
    const barcodeY = Number(lines[barcodeIndex - 1]?.match(/\^FO\d+,(\d+)/)?.[1] || 0);
    const barcodeHeight = Number(lines[barcodeIndex]?.match(/\^BE,(\d+),/)?.[1] || 0);
    const eanBounds = textBounds.find((field) => field.text === "8802241901267");
    const priceBounds = textBounds.find((field) => field.text === "123.45 PLN/kg");
    expect(Math.min(...titleBounds.map((field) => field.height))).toBeGreaterThanOrEqual(19);
    expect(eanBounds?.height).toBeGreaterThanOrEqual(19);
    expect(priceBounds?.height).toBeGreaterThanOrEqual(44);
    expect(Math.max(...titleBounds.map((field) => field.y + field.height))).toBeLessThan(barcodeY);
    expect(barcodeY + barcodeHeight).toBeLessThan(eanBounds?.y || 0);
    expect((eanBounds?.y || 0) + (eanBounds?.height || 0)).toBeLessThan(priceBounds?.y || 0);
  });

  it("refuses to silently cut a name that cannot fit at the readable 50x30 minimum", () => {
    const f = new ZplFormatter(50, 30);
    const tooLongName = Array.from({ length: 35 }, (_, index) => `produkt${index}`).join(" ");

    expect(() => f.formatLabel({
      barcode: "5901234123457",
      barcodeType: "EAN13",
      text1: tooLongName,
      text2: "12,99 zl",
      quantity: 1,
    })).toThrow(/fit readably/);
  });

  it("uses the narrower Code128 module width for Bao Han 14-digit barcodes", () => {
    const f = new ZplFormatter(50, 30);
    const zpl = f.formatLabel({ barcode: "00648436120895", barcodeType: "CODE128", quantity: 1 });
    expect(zpl).toContain("^PW400");
    expect(zpl).toContain("^BY2");
  });

  it("uses the spare 50x30 title area for a larger two-line grocery name", () => {
    const f = new ZplFormatter(50, 30);
    const zpl = f.formatLabel({
      barcode: "6924743935396",
      barcodeType: "EAN13",
      text1: "Chipsy karbowane o smaku pikantnych Latiao LAY'S 70g",
      text2: "14,58 zl",
      text3: "SKU EAN-6924743935396",
      quantity: 1,
    });
    const lines = zpl.split("\n");
    const barcodeIndex = lines.findIndex((line) => line.startsWith("^BE,"));
    const titleFields = lines
      .slice(0, barcodeIndex)
      .filter((line) => line.startsWith("^FD") && line.endsWith("^FS"));
    const titleFonts = titleFields.map((field) => {
      const fieldIndex = lines.indexOf(field);
      const font = lines[fieldIndex - 1]?.match(/\^A0,(\d+),(\d+)/);
      return { height: Number(font?.[1] || 0), width: Number(font?.[2] || 0) };
    });

    expect(titleFields).toEqual([
      "^FDChipsy karbowane o smaku^FS",
      "^FDpikantnych Latiao LAY'S 70g^FS",
    ]);
    expect(titleFonts).toEqual([
      { height: 32, width: 32 },
      { height: 32, width: 32 },
    ]);
    expect(zpl).not.toContain("…");
    expect(zpl).toContain("^FD14,58 zl^FS");
    expect(zpl).toContain("^BY3");
  });

  it("prints the photographed HAIDILAO title and EAN large with visible spacing", () => {
    const f = new ZplFormatter(50, 30);
    const barcode = "5060786250193";
    const zpl = f.formatLabel({
      barcode,
      barcodeType: "EAN13",
      text1: "Baza do hot pot o smaku grzybowym HAIDILAO 150g",
      text2: "28,50 zl",
      quantity: 1,
    });
    const lines = zpl.split("\n");
    const barcodeIndex = lines.findIndex((line) => line.startsWith("^BE,"));
    const titleFields = lines
      .slice(0, barcodeIndex)
      .filter((line) => line.startsWith("^FD") && line.endsWith("^FS"));
    const titleMetrics = titleFields.map((field) => {
      const fieldIndex = lines.indexOf(field);
      const origin = lines[fieldIndex - 2]?.match(/\^FO(\d+),(\d+)/);
      const font = lines[fieldIndex - 1]?.match(/\^A0,(\d+),(\d+)/);
      return {
        y: Number(origin?.[2] || 0),
        height: Number(font?.[1] || 0),
        width: Number(font?.[2] || 0),
      };
    });
    const eanFieldIndex = lines.lastIndexOf(`^FD${barcode}^FS`);
    const eanFont = lines[eanFieldIndex - 1]?.match(/\^A0,(\d+),(\d+)/);
    const titleLineGap = titleMetrics[1].y - (titleMetrics[0].y + titleMetrics[0].height);

    expect(titleFields).toEqual([
      "^FDBaza do hot pot o smaku^FS",
      "^FDgrzybowym HAIDILAO 150g^FS",
    ]);
    expect(titleMetrics.every((font) => font.height === 32 && font.width === 32)).toBe(true);
    expect(titleLineGap).toBeGreaterThanOrEqual(5);
    expect(Number(eanFont?.[1] || 0)).toBeGreaterThanOrEqual(24);
    expect(Number(eanFont?.[2] || 0)).toBeGreaterThanOrEqual(28);
    expect(zpl).toContain("^FD28,50 zl^FS");
    expect(zpl).not.toContain("…");
  });

  it("wraps the photographed LAY'S names before they can overflow the right edge", () => {
    const f = new ZplFormatter(50, 30);
    const samples = [
      {
        barcode: "6924743935990",
        name: "Chipsy o smaku awokado LAY'S 90g",
        expectedLines: ["Chipsy o smaku", "awokado LAY'S 90g"],
      },
      {
        barcode: "6924743936027",
        name: "Chipsy o smaku smietany i cebuli LAY'S 90g",
        expectedLines: ["Chipsy o smaku smietany", "i cebuli LAY'S 90g"],
      },
    ];

    for (const sample of samples) {
      const zpl = f.formatLabel({
        barcode: sample.barcode,
        barcodeType: "EAN13",
        text1: sample.name,
        text2: "12,00 zl",
        quantity: 1,
      });
      const lines = zpl.split("\n");
      const barcodeIndex = lines.findIndex((line) => line.startsWith("^BE,"));
      const titleFields = lines
        .slice(0, barcodeIndex)
        .filter((line) => line.startsWith("^FD") && line.endsWith("^FS"));
      const printedName = titleFields.map((line) => line.slice(3, -3)).join(" ");
      const titleFonts = titleFields.map((field) => {
        const fieldIndex = lines.indexOf(field);
        return lines[fieldIndex - 1];
      });

      expect(printedName).toBe(sample.name);
      expect(titleFields).toHaveLength(2);
      expect(titleFields.map((line) => line.slice(3, -3))).toEqual(sample.expectedLines);
      expect(titleFields.every((line) => Array.from(line.slice(3, -3)).length <= 28)).toBe(true);
      expect(titleFonts).toEqual(["^A0,32,32", "^A0,32,32"]);
      expect(zpl).not.toContain("…");
    }
  });
});

describe("ZplFormatter.formatKitchenPaymentLabel", () => {
  it("renders a compact KSO payment label without using the product label layout", () => {
    const f = new ZplFormatter(50, 30, 203, "ascii");
    const zpl = f.formatKitchenPaymentLabel({
      orderId: "kso-1",
      orderNumber: "K-042",
      pickupNumber: "K-042",
      createdAt: "2026-06-16T10:00:00.000Z",
      source: "KIOSK",
      fulfillmentType: "DINE_IN",
      customerLanguage: "pl",
      totalGrosze: 2900,
      qrPayload: "KSO1:test",
      items: [
        { name: "Pho bo", quantity: 2, unitPriceGrosze: 1200, lineTotalGrosze: 2400 },
      ],
    });

    expect(zpl).toContain("^PW400");
    expect(zpl).not.toContain("^LL");
    expect(zpl).toContain("Zira POS  -  NA MIEJSCU");
    expect(zpl).toContain("NR ZAMOWIENIA");
    expect(zpl).toContain("K-042");
    expect(zpl).toContain("2 poz.  -  29,00 zl");
    expect(zpl).toContain("Zaplac przy kasie");
    expect(zpl).toContain("^BQN,2,4");
    expect(zpl).toContain("^FDMA,KSO1:test^FS");
    expect(zpl).not.toContain("Pho bo");
    expect(zpl).not.toContain("^BE,");
    expect(zpl).not.toContain("^BC,");
  });

  it("does not truncate compact KSO QR payloads", () => {
    const payload = `KSO1:${"a".repeat(420)}`;
    const f = new ZplFormatter(50, 30, 203, "ascii");
    const zpl = f.formatKitchenPaymentLabel({
      orderId: "kso-1",
      orderNumber: "K-042",
      createdAt: "2026-06-16T10:00:00.000Z",
      source: "KIOSK",
      customerLanguage: "pl",
      totalGrosze: 2900,
      qrPayload: payload,
      items: [],
    });

    expect(zpl).toContain(`^FDMA,${payload}^FS`);
  });
});
