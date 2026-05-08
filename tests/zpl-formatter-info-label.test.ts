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
    expect(zpl).toContain("Bánh quy");
    expect(zpl).toContain("Skladniki:");
    expect(zpl).toContain("cukier");
    expect(zpl).toContain("Najlepiej spożyć przed: 31.12.2026");
    expect(zpl).toContain("Producent:");
    expect(zpl).toContain("Lotus Bakeries");
  });

  it("at 50x30 truncates ingredients and drops countryOfOrigin", () => {
    const f = new ZplFormatter(50, 30);
    const zpl = f.formatInfoLabel(sampleData, 50, 30);
    expect(zpl).toContain("Bánh quy");
    expect(zpl).toContain("Skladniki:");
    expect(zpl).toContain("…");
    expect(zpl).not.toContain("Kraj pochodzenia");
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

  it("uses UTF-8 charset so Polish chars render", () => {
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
});
