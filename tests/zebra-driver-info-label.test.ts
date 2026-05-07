import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
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
    expect(zpl).toContain("^LL320"); // 40mm * 8 dpmm = 320 dots
    expect(zpl).toContain("Producent:");
    expect(zpl).toContain("Test 100g");
  });

  it("throws when disconnected", async () => {
    (driver as any).connected = false;
    await expect(driver.printInfoLabel(sample)).rejects.toThrow();
  });
});
