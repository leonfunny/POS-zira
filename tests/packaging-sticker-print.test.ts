import { describe, it, expect, beforeEach } from 'vitest';
import {
  PackagingStickerPrintGate,
  resolvePackagingStickerJob,
} from '../src/main/hardware/pdf/packaging-sticker-job';
import { PrinterType } from '../src/shared/types';

const LABEL_CONFIG = {
  enabled: true,
  protocol: 'WINDOWS' as const,
  windowsPrinter: 'Honeywell PC42E-D 203dpi',
  labelWidth: 50,
  labelHeight: 30,
};

const REQUEST = {
  customerName: 'MoonCollection',
  styleName: 'KURTKA',
  styleCode: '114',
  colorName: 'CAPPUCCINO',
  code: 'SP006290',
  quantity: 3,
};

describe('resolvePackagingStickerJob', () => {
  it('builds a print job from the LABEL slot config', () => {
    const job = resolvePackagingStickerJob(REQUEST, { [PrinterType.LABEL]: LABEL_CONFIG } as any);
    expect(job.printerName).toBe('Honeywell PC42E-D 203dpi');
    expect(job.widthMm).toBe(50);
    expect(job.heightMm).toBe(30);
    expect(job.copies).toBe(3);
    expect(job.html).toContain('MoonCollection');
    expect(job.html).toContain('SP006290');
  });

  it('refuses when no LABEL printer is configured, instead of printing nowhere', () => {
    expect(() => resolvePackagingStickerJob(REQUEST, {} as any)).toThrow(/no label printer/i);
  });

  it('refuses when the LABEL slot is disabled', () => {
    expect(() =>
      resolvePackagingStickerJob(REQUEST, {
        [PrinterType.LABEL]: { ...LABEL_CONFIG, enabled: false },
      } as any),
    ).toThrow(/disabled/i);
  });

  it('refuses when the slot has no Windows printer queue name', () => {
    expect(() =>
      resolvePackagingStickerJob(REQUEST, {
        [PrinterType.LABEL]: { ...LABEL_CONFIG, windowsPrinter: '  ' },
      } as any),
    ).toThrow(/queue/i);
  });

  it('falls back to 50x30 mm when the slot carries no label geometry', () => {
    const job = resolvePackagingStickerJob(REQUEST, {
      [PrinterType.LABEL]: { ...LABEL_CONFIG, labelWidth: undefined, labelHeight: undefined },
    } as any);
    expect(job.widthMm).toBe(50);
    expect(job.heightMm).toBe(30);
  });

  it('clamps the copy count to the documented 1..999 range', () => {
    const cfg = { [PrinterType.LABEL]: LABEL_CONFIG } as any;
    expect(resolvePackagingStickerJob({ ...REQUEST, quantity: 0 }, cfg).copies).toBe(1);
    expect(resolvePackagingStickerJob({ ...REQUEST, quantity: 5000 }, cfg).copies).toBe(999);
    expect(resolvePackagingStickerJob({ ...REQUEST, quantity: 2.6 }, cfg).copies).toBe(3);
  });

  it('rejects a non-finite quantity rather than sending NaN copies to the spooler', () => {
    const cfg = { [PrinterType.LABEL]: LABEL_CONFIG } as any;
    expect(() => resolvePackagingStickerJob({ ...REQUEST, quantity: NaN }, cfg)).toThrow(
      /quantity/i,
    );
    expect(() =>
      resolvePackagingStickerJob({ ...REQUEST, quantity: Infinity }, cfg),
    ).toThrow(/quantity/i);
  });

  it('refuses a sticker with no code now that the barcode is printed', () => {
    const cfg = { [PrinterType.LABEL]: LABEL_CONFIG } as any;
    expect(() => resolvePackagingStickerJob({ ...REQUEST, code: '' }, cfg)).toThrow(/code/);
    expect(resolvePackagingStickerJob(REQUEST, cfg).html).toContain('<svg');
  });
});

describe('PackagingStickerPrintGate', () => {
  let gate: PackagingStickerPrintGate;
  beforeEach(() => {
    gate = new PackagingStickerPrintGate();
  });

  it('runs one job at a time so a double click cannot double print', async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = gate.runExclusive(async () => {
      await blocked;
      return 'first';
    });

    await expect(gate.runExclusive(async () => 'second')).rejects.toThrow(/in progress/i);

    release();
    await expect(first).resolves.toBe('first');
  });

  it('frees the gate after a failed job so the operator can retry', async () => {
    await expect(
      gate.runExclusive(async () => {
        throw new Error('printer offline');
      }),
    ).rejects.toThrow('printer offline');

    await expect(gate.runExclusive(async () => 'ok')).resolves.toBe('ok');
  });

  it('reports whether a job is running', async () => {
    expect(gate.isBusy()).toBe(false);
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const job = gate.runExclusive(async () => {
      await blocked;
    });
    expect(gate.isBusy()).toBe(true);
    release();
    await job;
    expect(gate.isBusy()).toBe(false);
  });
});
