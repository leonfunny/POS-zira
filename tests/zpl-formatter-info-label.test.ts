import { describe, expect, it } from 'vitest';
import { ZplFormatter } from "../src/main/hardware/zebra/zpl-formatter";
import { ManufacturerRole, InfoLabelData } from "../src/shared/types";

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
    expect(zpl).toContain("Składniki:");
    expect(zpl).toContain("cukier");
    expect(zpl).toContain("Najlepiej spożyć przed: 31.12.2026");
    expect(zpl).toContain("Producent:");
    expect(zpl).toContain("Lotus Bakeries");
  });

  it("at 50x30 truncates ingredients and drops countryOfOrigin", () => {
    const f = new ZplFormatter(50, 30);
    const zpl = f.formatInfoLabel(sampleData, 50, 30);
    expect(zpl).toContain("Bánh quy");
    expect(zpl).toContain("Składniki:");
    expect(zpl).toContain("…");
    expect(zpl).not.toContain("Kraj pochodzenia");
  });

  it("at 60x40 includes countryOfOrigin row when present", () => {
    const f = new ZplFormatter(60, 40);
    const zpl = f.formatInfoLabel(sampleData, 60, 40);
    expect(zpl).toContain("Kraj pochodzenia:");
    expect(zpl).toContain("BE");
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
