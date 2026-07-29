import { EventEmitter } from 'events';
import { readFileSync } from 'fs';
import path from 'path';
import { PassThrough } from 'stream';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/main/logger', () => ({
  default: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

import {
  isSafeWindowsThermalWorkerTransportFailure,
  WINDOWS_THERMAL_WORKER_PROTOCOL_VERSION,
  WindowsThermalWorker,
  WindowsThermalWorkerError,
  type ThermalWorkerAction,
} from '../src/main/hardware/thermal/windows-thermal-worker';

type DecodedRequest = {
  id: number;
  action: ThermalWorkerAction;
  payload: Record<string, any>;
};

class FakeWorkerProcess extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly pid = 4242;
  killed = false;
  private inputBuffer = '';

  constructor(
    private readonly onRequest: (request: DecodedRequest, process: FakeWorkerProcess) => void,
  ) {
    super();
    this.stdin.on('data', (chunk: Buffer | string) => {
      this.inputBuffer += chunk.toString();
      const lines = this.inputBuffer.split(/\r?\n/);
      this.inputBuffer = lines.pop() || '';
      for (const line of lines) {
        if (!line.trim()) continue;
        const requestJson = Buffer.from(line.trim(), 'base64').toString('utf8');
        this.onRequest(JSON.parse(requestJson), this);
      }
    });
  }

  sendReady(protocolVersion = WINDOWS_THERMAL_WORKER_PROTOCOL_VERSION): void {
    this.stdout.write(`${JSON.stringify({
      type: 'ready',
      protocolVersion,
      pid: this.pid,
    })}\n`);
  }

  respond(id: number, result: Record<string, unknown> = {}): void {
    this.stdout.write(`${JSON.stringify({
      type: 'response',
      id,
      ok: true,
      result,
    })}\n`);
  }

  fail(
    id: number,
    error: {
      code: string;
      stage: string;
      failureClass: 'SAFE_BEFORE_PRINT' | 'UNCERTAIN_AFTER_PRINT';
      message: string;
    },
  ): void {
    this.stdout.write(`${JSON.stringify({
      type: 'response',
      id,
      ok: false,
      error,
    })}\n`);
  }

  kill(signal: NodeJS.Signals = 'SIGTERM'): boolean {
    if (this.killed) return false;
    this.killed = true;
    queueMicrotask(() => this.emit('exit', null, signal));
    return true;
  }
}

const workerScriptPath = path.resolve(
  __dirname,
  '../resources/thermal/thermal-print-worker.ps1',
);
const workers: WindowsThermalWorker[] = [];

function makeWorker(
  onRequest: (request: DecodedRequest, process: FakeWorkerProcess) => void,
  overrides: Partial<ConstructorParameters<typeof WindowsThermalWorker>[0]> = {},
): {
  worker: WindowsThermalWorker;
  fake: FakeWorkerProcess;
  spawnProcess: ReturnType<typeof vi.fn>;
} {
  const fake = new FakeWorkerProcess((request, process) => {
    if (request.action === 'stop') {
      process.respond(request.id, { stopped: true });
      queueMicrotask(() => process.emit('exit', 0, null));
      return;
    }
    onRequest(request, process);
  });
  const spawnProcess = vi.fn(() => {
    queueMicrotask(() => fake.sendReady());
    return fake as any;
  });
  const worker = new WindowsThermalWorker({
    platform: 'win32',
    powershellPath: 'powershell.exe',
    scriptPath: workerScriptPath,
    readyTimeoutMs: 100,
    requestTimeoutMs: 100,
    stopTimeoutMs: 30,
    spawnProcess,
    ...overrides,
  });
  workers.push(worker);
  return { worker, fake, spawnProcess };
}

afterEach(async () => {
  await Promise.all(workers.splice(0).map((worker) => worker.stop()));
  vi.restoreAllMocks();
});

describe('Windows thermal worker resource', () => {
  it('uses one persistent C# LockBits + Winspool implementation without GetPixel', () => {
    const source = readFileSync(workerScriptPath, 'utf8');

    expect(source).toContain('LockBits');
    expect(source).toContain('Marshal.Copy');
    expect(source).not.toContain('.GetPixel(');
    expect(source).toContain('EntryPoint = "StartDocPrinterW"');
    expect(source).toContain('WritePrinter(');
    expect(source).toContain('EntryPoint = "GetPrinterW"');
    expect(source).toContain('EntryPoint = "GetJobW"');
    expect(source).toContain('EntryPoint = "SetJobW"');
    expect(source).toContain('EntryPoint = "SetupDiGetClassDevsW"');
    expect(source).toContain('EntryPoint = "SetupDiGetDeviceInstanceIdW"');
    expect(source).toContain('DigcfPresent | DigcfAllClasses');
    expect(source).toContain('USBPRINT\\\\');
    expect(source).toContain('expectedUsbVids');
    expect(source).not.toContain('Get-PnpDevice');
    expect(source).toContain('PRINTER_INFO_2');
    expect(source).toContain('JOB_INFO_1');
    expect(source).toContain('FatalPrinterStatusMask');
    expect(source).toContain('PrinterStatusOffline');
    expect(source).toContain('PrinterStatusPaperOut');
    expect(source).toContain('FatalJobStatusMask');
    expect(source).toContain('JobStatusBlockedDeviceQueue');
    expect(source).toContain('JobControlDelete');
    expect(source).toContain('ReconcileJob(handle, jobId)');
    expect(source).toContain('bool jobSubmitted = false;');
    expect(source).toContain('jobSubmitted = true;');
    expect(source).toContain('jobSubmitted ? UncertainAfterPrint : SafeBeforePrint');
    const fatalMask = source.slice(
      source.indexOf('private const uint FatalJobStatusMask'),
      source.indexOf('private const uint CompleteJobStatusMask'),
    );
    const completeMask = source.slice(
      source.indexOf('private const uint CompleteJobStatusMask'),
      source.indexOf('[StructLayout', source.indexOf('private const uint CompleteJobStatusMask')),
    );
    expect(fatalMask).toContain('JobStatusDeleting');
    expect(fatalMask).toContain('JobStatusDeleted');
    expect(completeMask).toContain('JobStatusPrinted');
    expect(completeMask).toContain('JobStatusComplete');
    expect(completeMask).not.toContain('JobStatusDeleted');
    expect(source).not.toContain('Get-PrintJob');
    expect(source).not.toContain('powershell.exe');
    expect(source).toContain('SAFE_BEFORE_PRINT');
    expect(source).toContain('UNCERTAIN_AFTER_PRINT');
    expect(source).toContain("type = 'ready'");
  });
});

describe('WindowsThermalWorker protocol and lifecycle', () => {
  it('starts PowerShell once, waits for ready, and reuses the process', async () => {
    const { worker, spawnProcess } = makeWorker((request, process) => {
      expect(request.action).toBe('ping');
      process.respond(request.id, {
        protocolVersion: WINDOWS_THERMAL_WORKER_PROTOCOL_VERSION,
        pid: process.pid,
      });
    });

    await worker.warmup();
    await expect(worker.ping()).resolves.toEqual({
      protocolVersion: WINDOWS_THERMAL_WORKER_PROTOCOL_VERSION,
      pid: 4242,
    });
    await expect(worker.ping()).resolves.toEqual({
      protocolVersion: WINDOWS_THERMAL_WORKER_PROTOCOL_VERSION,
      pid: 4242,
    });

    expect(worker.isRunning).toBe(true);
    expect(spawnProcess).toHaveBeenCalledTimes(1);
    expect(spawnProcess.mock.calls[0][1]).toEqual([
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      workerScriptPath,
    ]);
  });

  it('preserves Unicode and raster options through the base64 JSON protocol', async () => {
    const raster = Buffer.from([0x1d, 0x76, 0x30, 0x00, 0xaa, 0xbb]);
    const { worker } = makeWorker((request, process) => {
      expect(request.action).toBe('render');
      expect(request.payload).toMatchObject({
        width: 576,
        includeInit: false,
        includeFeed: false,
        includeCut: false,
      });
      expect(request.payload.lines).toEqual([
        {
          text: 'Zażółć gęślą jaźń — Chè Sài Gòn',
          rightText: '42,00 zł',
          bold: true,
        },
      ]);
      process.respond(request.id, {
        dataBase64: raster.toString('base64'),
        width: 576,
        height: 44,
        bytes: raster.length,
        renderMs: 7,
      });
    });

    const result = await worker.renderLines(
      [{
        text: 'Zażółć gęślą jaźń — Chè Sài Gòn',
        rightText: '42,00 zł',
        bold: true,
      }],
      576,
      { includeInit: false, includeFeed: false, includeCut: false },
    );

    expect(result).toEqual({
      data: raster,
      width: 576,
      height: 44,
      bytes: raster.length,
      renderMs: 7,
    });
  });

  it('sends a combined drawer and receipt buffer exactly once', async () => {
    const drawer = Buffer.from([0x1b, 0x70, 0x00, 0x19, 0xfa]);
    const receipt = Buffer.from([0x1b, 0x40, 0x41, 0x0a, 0x1d, 0x56, 0x01]);
    const combined = Buffer.concat([drawer, receipt]);
    const printRequests: DecodedRequest[] = [];
    const { worker } = makeWorker((request, process) => {
      expect(request.action).toBe('print');
      printRequests.push(request);
      expect(Buffer.from(request.payload.dataBase64, 'base64')).toEqual(combined);
      process.respond(request.id, {
        jobId: 71,
        bytesWritten: combined.length,
        spoolMs: 11,
        preflightMs: 2,
        presenceProbeMs: 3,
        presenceReason: 'USBPRINT_PORT_PRESENT',
        portName: 'USB002',
        reconcileMs: 26,
        printerStatus: 0,
        printerStatusText: 'READY',
        jobStatus: 0x10,
        jobStatusText: 'PRINTING',
      });
    });

    await expect(
      worker.printRaw(
        'Xprinter XP-80T',
        combined,
        'Zira AI Receipt',
        ['1fc9', 'invalid', '1FC9'],
      ),
    ).resolves.toEqual({
      jobId: 71,
      bytesWritten: combined.length,
      spoolMs: 11,
      preflightMs: 2,
      presenceProbeMs: 3,
      presenceReason: 'USBPRINT_PORT_PRESENT',
      portName: 'USB002',
      reconcileMs: 26,
      printerStatus: 0,
      printerStatusText: 'READY',
      jobStatus: 0x10,
      jobStatusText: 'PRINTING',
    });

    expect(printRequests).toHaveLength(1);
    expect(printRequests[0].payload.expectedUsbVids).toEqual(['1FC9']);
    const sent = Buffer.from(printRequests[0].payload.dataBase64, 'base64');
    let drawerCommandCount = 0;
    for (let i = 0; i <= sent.length - drawer.length; i++) {
      if (sent.subarray(i, i + drawer.length).equals(drawer)) drawerCommandCount++;
    }
    expect(drawerCommandCount).toBe(1);
  });

  it('preserves offline/paper-out SAFE_BEFORE_PRINT before StartDocPrinter', async () => {
    const { worker } = makeWorker((request, process) => {
      process.fail(request.id, {
        code: 'PRINTER_NOT_READY',
        stage: 'PRINTER_PREFLIGHT',
        failureClass: 'SAFE_BEFORE_PRINT',
        message: 'Printer is not ready: OFFLINE|PAPER_OUT',
      });
    });

    const error = await worker
      .printRaw('Xprinter XP-80T', Buffer.from([0x1b, 0x40]))
      .catch((caught) => caught);

    expect(error).toBeInstanceOf(WindowsThermalWorkerError);
    expect(error).toMatchObject({
      code: 'PRINTER_NOT_READY',
      stage: 'PRINTER_PREFLIGHT',
      failureClass: 'SAFE_BEFORE_PRINT',
      action: 'print',
    });
    expect(isSafeWindowsThermalWorkerTransportFailure(error)).toBe(false);
  });

  it('preserves UNCERTAIN_AFTER_PRINT for exact accepted job entering paper-out', async () => {
    const { worker } = makeWorker((request, process) => {
      process.fail(request.id, {
        code: 'PRINT_JOB_NOT_READY',
        stage: 'JOB_RECONCILE',
        failureClass: 'UNCERTAIN_AFTER_PRINT',
        message: 'Accepted print job entered OFFLINE|PAPER_OUT; delete requested',
      });
    });

    const error = await worker
      .printRaw('Xprinter XP-80T', Buffer.from([0x1b, 0x40]))
      .catch((caught) => caught);

    expect(error).toBeInstanceOf(WindowsThermalWorkerError);
    expect(error).toMatchObject({
      code: 'PRINT_JOB_NOT_READY',
      stage: 'JOB_RECONCILE',
      failureClass: 'UNCERTAIN_AFTER_PRINT',
      action: 'print',
    });
    expect(isSafeWindowsThermalWorkerTransportFailure(error)).toBe(false);
  });

  it('allows legacy fallback only for safe worker startup/transport failures', () => {
    const startupError = new WindowsThermalWorkerError({
      message: 'worker ready timeout',
      code: 'WORKER_READY_TIMEOUT',
      stage: 'STARTUP',
      failureClass: 'SAFE_BEFORE_PRINT',
      action: 'ping',
    });
    const semanticPrinterError = new WindowsThermalWorkerError({
      message: 'printer paused',
      code: 'PRINTER_NOT_READY',
      stage: 'PRINTER_PREFLIGHT',
      failureClass: 'SAFE_BEFORE_PRINT',
      action: 'print',
    });
    const uncertainTransportError = new WindowsThermalWorkerError({
      message: 'worker exited after dispatch',
      code: 'WORKER_EXITED',
      stage: 'PROCESS',
      failureClass: 'UNCERTAIN_AFTER_PRINT',
      action: 'print',
    });

    expect(isSafeWindowsThermalWorkerTransportFailure(startupError)).toBe(true);
    expect(isSafeWindowsThermalWorkerTransportFailure(semanticPrinterError)).toBe(false);
    expect(isSafeWindowsThermalWorkerTransportFailure(uncertainTransportError)).toBe(false);
  });

  it('classifies a dispatched print timeout as UNCERTAIN_AFTER_PRINT', async () => {
    let observeRequest!: () => void;
    const requestObserved = new Promise<void>((resolve) => { observeRequest = resolve; });
    const { worker, fake } = makeWorker(
      () => {
        // Deliberately leave the dispatched print request unresolved.
        observeRequest();
      },
      { requestTimeoutMs: 20 },
    );

    const printing = worker
      .printRaw('Xprinter XP-80T', Buffer.from([0x1b, 0x40]))
      .catch((caught) => caught);
    await requestObserved;
    expect(worker.isBusy).toBe(true);
    const error = await printing;

    expect(error).toBeInstanceOf(WindowsThermalWorkerError);
    expect(error).toMatchObject({
      code: 'WORKER_REQUEST_TIMEOUT',
      stage: 'WAIT_RESPONSE',
      failureClass: 'UNCERTAIN_AFTER_PRINT',
      action: 'print',
    });
    expect(worker.isBusy).toBe(false);
    expect(worker.isRunning).toBe(false);
    expect(fake.killed).toBe(true);
  });

  it('classifies a render timeout as SAFE_BEFORE_PRINT', async () => {
    const { worker } = makeWorker(
      () => {
        // Deliberately leave the render request unresolved.
      },
      { requestTimeoutMs: 20 },
    );

    const error = await worker
      .renderLines([{ text: 'Chè Sài Gòn' }], 576)
      .catch((caught) => caught);

    expect(error).toBeInstanceOf(WindowsThermalWorkerError);
    expect(error).toMatchObject({
      code: 'WORKER_REQUEST_TIMEOUT',
      failureClass: 'SAFE_BEFORE_PRINT',
      action: 'render',
    });
  });

  it('does not replay a print when the worker exits after dispatch', async () => {
    const { worker, spawnProcess } = makeWorker((_request, process) => {
      queueMicrotask(() => process.emit('exit', 1, null));
    });

    const error = await worker
      .printRaw('Xprinter XP-80T', Buffer.from([0x1b, 0x40]))
      .catch((caught) => caught);

    expect(error).toBeInstanceOf(WindowsThermalWorkerError);
    expect(error).toMatchObject({
      code: 'WORKER_EXITED',
      stage: 'PROCESS',
      failureClass: 'UNCERTAIN_AFTER_PRINT',
      action: 'print',
    });
    expect(spawnProcess).toHaveBeenCalledTimes(1);
    expect(worker.isRunning).toBe(false);
  });

  it('rejects startup safely when the worker never reports ready', async () => {
    const fake = new FakeWorkerProcess(() => undefined);
    const spawnProcess = vi.fn(() => fake as any);
    const worker = new WindowsThermalWorker({
      platform: 'win32',
      powershellPath: 'powershell.exe',
      scriptPath: workerScriptPath,
      readyTimeoutMs: 20,
      requestTimeoutMs: 20,
      stopTimeoutMs: 20,
      spawnProcess,
    });
    workers.push(worker);

    const error = await worker.warmup().catch((caught) => caught);

    expect(error).toBeInstanceOf(WindowsThermalWorkerError);
    expect(error).toMatchObject({
      code: 'WORKER_READY_TIMEOUT',
      stage: 'STARTUP',
      failureClass: 'SAFE_BEFORE_PRINT',
    });
    expect(fake.killed).toBe(true);
    expect(worker.isRunning).toBe(false);
  });

  it('gracefully sends stop and releases the child process', async () => {
    const actions: ThermalWorkerAction[] = [];
    const { worker, fake } = makeWorker((request, process) => {
      actions.push(request.action);
      process.respond(request.id, {
        protocolVersion: WINDOWS_THERMAL_WORKER_PROTOCOL_VERSION,
        pid: process.pid,
      });
    });

    await worker.warmup();
    await worker.ping();
    await worker.stop();

    expect(actions).toEqual(['ping']);
    expect(worker.isRunning).toBe(false);
    expect(fake.killed).toBe(false);
  });
});
