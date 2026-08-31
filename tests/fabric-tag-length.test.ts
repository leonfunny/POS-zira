import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The fabric tag's length is decided at print time, not in config: care-label
 * ribbon is continuous, so a tag that fits in 18mm must advance 18mm or every
 * tag drags a blank gap behind it. That decision spans three modules -- the
 * rasteriser measures, the driver converts, the formatter emits SIZE -- so it
 * is covered here through the driver rather than on any one of them.
 */

const sent: Buffer[] = [];
const renderCalls: Array<{ widthDots: number; heightDots: number; options: any }> = [];

/** Content that needs 144 dots (18mm), well under the 60mm configured ceiling. */
const MEASURED_HEIGHT_DOTS = 144;

vi.mock('../src/main/logger', () => ({
  default: { info: () => {}, warn: () => {}, debug: () => {}, error: () => {} },
}));

vi.mock('../src/main/hardware/port-utils', () => ({
  listWindowsPrinters: async () => ['TSC MB241'],
  isWindowsPrinterPresent: async () => true,
  flushStuckPrintJobs: async () => 0,
  // Null means "queue is clear"; a string here would be a stuck-job reason.
  getStuckPrintJobStatus: async () => null,
}));

vi.mock('../src/main/hardware/windows-raw-print', () => ({
  sendRawToPrinter: async (_printer: string, payload: Buffer) => { sent.push(payload); },
  cleanRawPrintError: (error: any) => String(error),
}));

vi.mock('../src/main/hardware/tsc/fabric-tag-renderer', () => ({
  renderFabricTagBitmap: async (_data: any, widthDots: number, heightDots: number, options: any) => {
    renderCalls.push({ widthDots, heightDots, options });
    const height = options?.fitHeight ? MEASURED_HEIGHT_DOTS : heightDots;
    const widthBytes = Math.ceil(widthDots / 8);
    return { widthDots, heightDots: height, widthBytes, data: Buffer.alloc(widthBytes * height, 0xff) };
  },
}));

const { TscDriver } = await import('../src/main/hardware/tsc/tsc-driver');

const tag = { brandName: 'ZIRA', size: 'L', quantity: 1 } as any;

async function printOnce(overrides: Partial<{ heightMm: number }> = {}) {
  const driver = new TscDriver('TSC MB241', 20, overrides.heightMm ?? 60, { sensor: 'none' });
  expect(await driver.connect()).toBe(true);
  await driver.printFabricTag(tag);
  return sent[sent.length - 1].toString('latin1');
}

describe('fabric tag length follows the content', () => {
  beforeEach(() => { sent.length = 0; renderCalls.length = 0; });

  it('declares the measured length rather than the configured ceiling', async () => {
    const job = await printOnce();
    expect(job).toContain('SIZE 20 mm,18 mm');
    expect(job).not.toContain('SIZE 20 mm,60 mm');
  });

  it('asks the rasteriser to fit, and hands it the configured height as the ceiling', async () => {
    await printOnce();
    expect(renderCalls).toHaveLength(1);
    expect(renderCalls[0].options?.fitHeight).toBe(true);
    expect(renderCalls[0].heightDots).toBe(480); // 60mm at 203dpi
    // A tag still has to be big enough to handle and to sew in.
    expect(renderCalls[0].options?.minHeightDots).toBeGreaterThan(0);
  });

  it('never declares more than the configured ceiling', async () => {
    const job = await printOnce({ heightMm: 15 });
    const size = job.split('\r\n').find((line) => line.startsWith('SIZE '))!;
    const declared = Number(size.split(',')[1].replace(/[^0-9.]/g, ''));
    expect(declared).toBeLessThanOrEqual(15);
  });
});
