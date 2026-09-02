import { describe, it, expect, vi } from 'vitest';
import { runPrintPlan } from '../src/renderer/components/label/print-order-runner';
import { PrintStep } from '../src/shared/label-print-order';

const HEADER = { customerName: 'MoonCollection', styleName: 'KURTKA', styleCode: '114' };

function stickerStep(over: Partial<PrintStep> = {}): PrintStep {
  return {
    kind: 'sticker',
    id: 'sticker:r1:0',
    rowId: 'r1',
    colorName: 'CZEKOLADA',
    code: 'SP006290',
    quantity: 100,
    ...(over as any),
  };
}

function fabricStep(over: Partial<PrintStep> = {}): PrintStep {
  return {
    kind: 'fabric',
    id: 'fabric:r1:s:0',
    rowId: 'r1',
    sizeText: 'S',
    composition: '70% POLIESTER 30% AKRYL',
    careSymbols: ['WASH_30'],
    careText: '',
    quantity: 50,
    ...(over as any),
  };
}

function makeApi() {
  return {
    printSticker: vi.fn(async (_req: any) => ({ success: true, error: undefined as string | undefined })),
    printFabricTag: vi.fn(async (_req: any) => ({ success: true, error: undefined as string | undefined })),
  };
}

function makeHooks() {
  return {
    onProgress: vi.fn(),
    shouldStop: vi.fn(() => false),
  };
}

describe('runPrintPlan', () => {
  it('sends the sticker payload the printer lane expects', async () => {
    const api = makeApi();
    await runPrintPlan([stickerStep()], HEADER, api, makeHooks());

    expect(api.printSticker).toHaveBeenCalledWith({
      customerName: 'MoonCollection',
      styleName: 'KURTKA',
      styleCode: '114',
      colorName: 'CZEKOLADA',
      code: 'SP006290',
      sizeText: undefined,
      quantity: 100,
    });
  });

  it('sends no size on a sticker — one sticker covers a bag of mixed sizes', async () => {
    const api = makeApi();
    await runPrintPlan([stickerStep()], HEADER, api, makeHooks());
    expect(api.printSticker.mock.calls[0][0]).not.toHaveProperty('sizeText');
  });

  it('sends the fabric payload without colour or customer — the tag carries neither', async () => {
    const api = makeApi();
    await runPrintPlan([fabricStep()], HEADER, api, makeHooks());

    const payload = api.printFabricTag.mock.calls[0][0];
    expect(payload).toEqual({
      size: 'S',
      composition: '70% POLIESTER 30% AKRYL',
      careSymbols: ['WASH_30'],
      careText: undefined,
      layout: 'default',
      quantity: 50,
    });
    expect(JSON.stringify(payload)).not.toContain('CZEKOLADA');
    expect(JSON.stringify(payload)).not.toContain('MoonCollection');
  });

  it('reports success with the copies actually printed', async () => {
    const api = makeApi();
    const result = await runPrintPlan(
      [stickerStep(), fabricStep()],
      HEADER,
      api,
      makeHooks(),
    );
    expect(result).toMatchObject({ type: 'success', printedCopies: 150, completedSteps: 2 });
    expect(result.completedIds).toEqual(['sticker:r1:0', 'fabric:r1:s:0']);
  });

  it('runs every fabric batch straight through, asking nothing in between', async () => {
    // The operator starts the order and walks away; batches exist only so Stop
    // has somewhere to take effect.
    const api = makeApi();
    const hooks = makeHooks();
    const result = await runPrintPlan(
      [
        fabricStep(),
        fabricStep({ id: 'fabric:r1:s:1' } as any),
        fabricStep({ id: 'fabric:r1:s:2' } as any),
      ],
      HEADER,
      api,
      hooks,
    );
    expect(api.printFabricTag).toHaveBeenCalledTimes(3);
    expect(result).toMatchObject({ type: 'success', printedCopies: 150 });
    expect(hooks.onProgress.mock.calls.map(([p]) => p.type)).not.toContain('waiting');
  });

  it('crosses from the sticker printer to the fabric one without stopping', async () => {
    const api = makeApi();
    const hooks = makeHooks();
    const result = await runPrintPlan([stickerStep(), fabricStep()], HEADER, api, hooks);
    expect(api.printSticker).toHaveBeenCalledTimes(1);
    expect(api.printFabricTag).toHaveBeenCalledTimes(1);
    expect(result.type).toBe('success');
  });

  it('stops between fabric batches when Stop is pressed mid-run', async () => {
    const api = makeApi();
    const hooks = makeHooks();
    hooks.shouldStop = vi.fn(() => api.printFabricTag.mock.calls.length > 0);
    const result = await runPrintPlan(
      [fabricStep(), fabricStep({ id: 'fabric:r1:s:1' } as any)],
      HEADER,
      api,
      hooks,
    );
    expect(api.printFabricTag).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ type: 'stopped', printedCopies: 50, completedSteps: 1 });
  });

  it('stops before the next step when a stop was requested mid-run', async () => {
    const api = makeApi();
    const hooks = makeHooks();
    hooks.shouldStop = vi.fn(() => api.printSticker.mock.calls.length > 0);
    const result = await runPrintPlan(
      [stickerStep(), stickerStep({ id: 'sticker:r2:0' } as any)],
      HEADER,
      api,
      hooks,
    );
    expect(api.printSticker).toHaveBeenCalledTimes(1);
    expect(result.type).toBe('stopped');
  });

  it('aborts on a failed step and names what was printed before it', async () => {
    const api = makeApi();
    api.printFabricTag = vi.fn(async (_req: any) => ({ success: false, error: 'Printer not connected' }));
    const result = await runPrintPlan([stickerStep(), fabricStep()], HEADER, api, makeHooks());

    expect(result).toMatchObject({
      type: 'error',
      printedCopies: 100,
      completedSteps: 1,
      message: 'Printer not connected',
    });
    expect(result.failedStepId).toBe('fabric:r1:s:0');
  });

  it('treats a thrown IPC error the same as a refused print', async () => {
    const api = makeApi();
    api.printSticker = vi.fn(async (_req: any) => {
      throw new Error('IPC channel closed');
    });
    const result = await runPrintPlan([stickerStep()], HEADER, api, makeHooks());
    expect(result).toMatchObject({ type: 'error', message: 'IPC channel closed', printedCopies: 0 });
  });

  it('skips steps already completed by an earlier run', async () => {
    const api = makeApi();
    const result = await runPrintPlan(
      [stickerStep(), fabricStep()],
      HEADER,
      api,
      makeHooks(),
      { completedIds: ['sticker:r1:0'] },
    );
    expect(api.printSticker).not.toHaveBeenCalled();
    expect(api.printFabricTag).toHaveBeenCalledTimes(1);
    expect(result.printedCopies).toBe(50);
  });

  it('reports progress before and after every step', async () => {
    const api = makeApi();
    const hooks = makeHooks();
    await runPrintPlan([stickerStep()], HEADER, api, hooks);
    const types = hooks.onProgress.mock.calls.map((call) => call[0].type);
    expect(types[0]).toBe('printing');
    expect(types[types.length - 1]).toBe('success');
  });

  it('does nothing for an empty plan', async () => {
    const api = makeApi();
    const result = await runPrintPlan([], HEADER, api, makeHooks());
    expect(result.type).toBe('success');
    expect(result.printedCopies).toBe(0);
    expect(api.printSticker).not.toHaveBeenCalled();
  });
});

describe('every progress event carries what has gone out so far', () => {
  it('grows the list batch by batch, so the panel can write it down', async () => {
    const api = makeApi();
    const hooks = makeHooks();
    await runPrintPlan(
      [stickerStep({ id: 'a' }), fabricStep({ id: 'b' })],
      HEADER,
      api,
      hooks,
    );

    const seen = hooks.onProgress.mock.calls.map((call: any[]) => call[0].completedIds);
    expect(seen[0]).toEqual([]);
    expect(seen[seen.length - 1]).toEqual(['a', 'b']);
    // A batch that failed or was stopped is never in the list before it ran.
    expect(seen).toContainEqual(['a']);
  });

  it('hands out a copy, not the list it keeps counting on', async () => {
    const api = makeApi();
    const seen: string[][] = [];
    await runPrintPlan([stickerStep({ id: 'a' }), fabricStep({ id: 'b' })], HEADER, api, {
      onProgress: (progress) => seen.push(progress.completedIds),
      shouldStop: () => false,
    });

    expect(seen[0]).toEqual([]);
  });

  it('reports what went out before a stop, which is what gets resumed', async () => {
    const api = makeApi();
    let calls = 0;
    const hooks = {
      onProgress: vi.fn(),
      shouldStop: () => {
        calls += 1;
        return calls > 1;
      },
    };
    const outcome = await runPrintPlan(
      [stickerStep({ id: 'a' }), fabricStep({ id: 'b' })],
      HEADER,
      api,
      hooks,
    );

    expect(outcome.type).toBe('stopped');
    expect(outcome.completedIds).toEqual(['a']);
    const last = hooks.onProgress.mock.calls.at(-1)![0];
    expect(last.completedIds).toEqual(['a']);
  });
});
