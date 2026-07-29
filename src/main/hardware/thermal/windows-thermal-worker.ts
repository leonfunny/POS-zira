import { ChildProcessWithoutNullStreams, SpawnOptionsWithoutStdio, spawn } from 'child_process';
import { existsSync } from 'fs';
import path from 'path';
import logger from '../../logger';

export const WINDOWS_THERMAL_WORKER_PROTOCOL_VERSION = 1;

export type ThermalWorkerFailureClass = 'SAFE_BEFORE_PRINT' | 'UNCERTAIN_AFTER_PRINT';
export type ThermalWorkerAction = 'ping' | 'render' | 'print' | 'stop';

export interface ThermalWorkerRasterLine {
  text: string;
  rightText?: string;
  bold?: boolean;
  big?: boolean;
  center?: boolean;
  separator?: boolean;
}

export interface ThermalWorkerRasterOptions {
  includeInit?: boolean;
  includeFeed?: boolean;
  includeCut?: boolean;
}

export interface ThermalWorkerRasterResult {
  data: Buffer;
  width: number;
  height: number;
  bytes: number;
  renderMs: number;
}

export interface ThermalWorkerPrintResult {
  jobId: number;
  bytesWritten: number;
  spoolMs: number;
  preflightMs: number;
  presenceProbeMs: number;
  presenceReason: string;
  portName: string;
  reconcileMs: number;
  printerStatus: number;
  printerStatusText: string;
  jobStatus: number;
  jobStatusText: string;
}

export class WindowsThermalWorkerError extends Error {
  readonly code: string;
  readonly stage: string;
  readonly failureClass: ThermalWorkerFailureClass;
  readonly action: ThermalWorkerAction;

  constructor(input: {
    message: string;
    code: string;
    stage: string;
    failureClass: ThermalWorkerFailureClass;
    action: ThermalWorkerAction;
    cause?: unknown;
  }) {
    super(input.message, input.cause === undefined ? undefined : { cause: input.cause });
    this.name = 'WindowsThermalWorkerError';
    this.code = input.code;
    this.stage = input.stage;
    this.failureClass = input.failureClass;
    this.action = input.action;
  }
}

const SAFE_WORKER_TRANSPORT_FAILURE_CODES = new Set([
  'UNSUPPORTED_PLATFORM',
  'WORKER_SCRIPT_NOT_FOUND',
  'WORKER_SPAWN_FAILED',
  'WORKER_READY_TIMEOUT',
  'WORKER_PROTOCOL_MISMATCH',
  'WORKER_PROCESS_ERROR',
  'WORKER_EXITED',
  'WORKER_STOPPED',
  'WORKER_NOT_WRITABLE',
  'WORKER_WRITE_FAILED',
]);

/**
 * Only worker startup/stdio failures that provably happened before Winspool
 * accepted a job may use the slower one-shot PowerShell implementation.
 * Printer-health failures are deliberately excluded: retrying those through
 * another transport can queue a duplicate receipt or drawer pulse.
 */
export function isSafeWindowsThermalWorkerTransportFailure(
  error: unknown,
): error is WindowsThermalWorkerError {
  return (
    error instanceof WindowsThermalWorkerError
    && error.failureClass === 'SAFE_BEFORE_PRINT'
    && SAFE_WORKER_TRANSPORT_FAILURE_CODES.has(error.code)
  );
}

type WorkerSpawn = (
  command: string,
  args: readonly string[],
  options: SpawnOptionsWithoutStdio,
) => ChildProcessWithoutNullStreams;

interface PendingRequest {
  action: ThermalWorkerAction;
  resolve: (value: unknown) => void;
  reject: (reason: WindowsThermalWorkerError) => void;
  timer: NodeJS.Timeout;
  dispatched: boolean;
}

interface WorkerResponse {
  type?: string;
  id?: number;
  ok?: boolean;
  result?: Record<string, unknown>;
  error?: {
    code?: string;
    stage?: string;
    message?: string;
    failureClass?: ThermalWorkerFailureClass;
  };
  protocolVersion?: number;
}

export interface WindowsThermalWorkerOptions {
  powershellPath?: string;
  scriptPath?: string;
  platform?: NodeJS.Platform;
  readyTimeoutMs?: number;
  requestTimeoutMs?: number;
  stopTimeoutMs?: number;
  maxResponseBytes?: number;
  spawnProcess?: WorkerSpawn;
}

const DEFAULT_READY_TIMEOUT_MS = 12_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
const DEFAULT_STOP_TIMEOUT_MS = 1_500;
const DEFAULT_MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

function workerFailureClass(
  action: ThermalWorkerAction,
  dispatched: boolean,
): ThermalWorkerFailureClass {
  return action === 'print' && dispatched
    ? 'UNCERTAIN_AFTER_PRINT'
    : 'SAFE_BEFORE_PRINT';
}

function findPowerShellExecutable(): string {
  const systemRoot = process.env.SystemRoot || 'C:\\Windows';
  const candidates = [
    path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    path.join(systemRoot, 'Sysnative', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
  ];
  return candidates.find((candidate) => existsSync(candidate)) || 'powershell.exe';
}

function getElectronAppPath(): string | undefined {
  try {
    // Lazy require keeps this transport unit-testable in a plain Node process.
    const electron = require('electron');
    return electron?.app?.getAppPath?.();
  } catch {
    return undefined;
  }
}

/**
 * Locate the source script in both development and electron-builder layouts.
 * Packaged builds place it at resources/thermal/thermal-print-worker.ps1.
 */
export function resolveWindowsThermalWorkerScriptPath(explicitPath?: string): string {
  const resourcesPath = typeof process.resourcesPath === 'string'
    ? process.resourcesPath
    : undefined;
  const appPath = getElectronAppPath();
  const candidates = [
    explicitPath,
    resourcesPath ? path.join(resourcesPath, 'thermal', 'thermal-print-worker.ps1') : undefined,
    appPath ? path.join(appPath, 'resources', 'thermal', 'thermal-print-worker.ps1') : undefined,
    path.join(process.cwd(), 'resources', 'thermal', 'thermal-print-worker.ps1'),
  ].filter((candidate): candidate is string => Boolean(candidate));

  return candidates.find((candidate) => existsSync(candidate)) || candidates[0];
}

/**
 * Persistent Windows thermal-print bridge.
 *
 * The PowerShell process starts once, compiles its C# System.Drawing/Winspool
 * helper once, and then accepts base64-encoded JSON requests over stdin. A
 * print request is never replayed after it has been written to the worker:
 * process exit/timeout then has UNCERTAIN_AFTER_PRINT semantics.
 */
export class WindowsThermalWorker {
  private readonly powershellPath: string;
  private readonly scriptPath: string;
  private readonly platform: NodeJS.Platform;
  private readonly readyTimeoutMs: number;
  private readonly requestTimeoutMs: number;
  private readonly stopTimeoutMs: number;
  private readonly maxResponseBytes: number;
  private readonly spawnProcess: WorkerSpawn;

  private proc: ChildProcessWithoutNullStreams | null = null;
  private ready = false;
  private startPromise: Promise<void> | null = null;
  private startResolve: (() => void) | null = null;
  private startReject: ((reason: WindowsThermalWorkerError) => void) | null = null;
  private startTimer: NodeJS.Timeout | null = null;
  private requestId = 0;
  private pending = new Map<number, PendingRequest>();
  private stdoutBuffer = '';
  private stopping = false;

  constructor(options: WindowsThermalWorkerOptions = {}) {
    this.powershellPath = options.powershellPath || findPowerShellExecutable();
    this.scriptPath = resolveWindowsThermalWorkerScriptPath(options.scriptPath);
    this.platform = options.platform || process.platform;
    this.readyTimeoutMs = options.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS;
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.stopTimeoutMs = options.stopTimeoutMs ?? DEFAULT_STOP_TIMEOUT_MS;
    this.maxResponseBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
    this.spawnProcess = options.spawnProcess || ((
      command: string,
      args: readonly string[],
      spawnOptions: SpawnOptionsWithoutStdio,
    ) => spawn(command, [...args], spawnOptions) as ChildProcessWithoutNullStreams);
  }

  get isRunning(): boolean {
    return this.ready && this.proc !== null && !this.proc.killed;
  }

  get isBusy(): boolean {
    for (const request of this.pending.values()) {
      if (request.action === 'render' || request.action === 'print') return true;
    }
    return false;
  }

  get resolvedScriptPath(): string {
    return this.scriptPath;
  }

  async warmup(): Promise<void> {
    await this.ensureStarted();
  }

  async ping(): Promise<{ protocolVersion: number; pid?: number }> {
    const result = await this.sendRequest('ping', {});
    const protocolVersion = Number((result as any)?.protocolVersion);
    if (protocolVersion !== WINDOWS_THERMAL_WORKER_PROTOCOL_VERSION) {
      throw this.protocolError(
        'ping',
        `Worker reported unsupported protocol version ${String(protocolVersion)}`,
      );
    }
    const pid = Number((result as any)?.pid);
    return {
      protocolVersion,
      pid: Number.isFinite(pid) ? pid : undefined,
    };
  }

  async renderLines(
    lines: ThermalWorkerRasterLine[],
    width: number,
    options: ThermalWorkerRasterOptions = {},
  ): Promise<ThermalWorkerRasterResult> {
    if (!Number.isInteger(width) || width < 128 || width > 2048) {
      throw new WindowsThermalWorkerError({
        message: `Invalid raster width: ${width}`,
        code: 'INVALID_RASTER_WIDTH',
        stage: 'VALIDATE_REQUEST',
        failureClass: 'SAFE_BEFORE_PRINT',
        action: 'render',
      });
    }

    const result = await this.sendRequest('render', {
      lines,
      width,
      includeInit: options.includeInit !== false,
      includeFeed: options.includeFeed !== false,
      includeCut: options.includeCut !== false,
    });

    const dataBase64 = (result as any)?.dataBase64;
    const height = Number((result as any)?.height);
    const bytes = Number((result as any)?.bytes);
    const renderMs = Number((result as any)?.renderMs);
    if (
      typeof dataBase64 !== 'string'
      || !Number.isInteger(height)
      || height <= 0
      || !Number.isInteger(bytes)
      || bytes < 0
    ) {
      throw this.protocolError('render', 'Worker returned an invalid raster result');
    }

    const data = Buffer.from(dataBase64, 'base64');
    if (data.length !== bytes) {
      throw this.protocolError(
        'render',
        `Worker raster byte count mismatch: expected ${bytes}, received ${data.length}`,
      );
    }

    return {
      data,
      width,
      height,
      bytes,
      renderMs: Number.isFinite(renderMs) ? renderMs : 0,
    };
  }

  async printRaw(
    printerName: string,
    data: Buffer,
    documentName: string = 'Zira AI Receipt',
    expectedUsbVids: readonly string[] = [],
  ): Promise<ThermalWorkerPrintResult> {
    const normalizedPrinterName = printerName.trim();
    if (!normalizedPrinterName) {
      throw new WindowsThermalWorkerError({
        message: 'Printer name is required',
        code: 'INVALID_PRINTER_NAME',
        stage: 'VALIDATE_REQUEST',
        failureClass: 'SAFE_BEFORE_PRINT',
        action: 'print',
      });
    }
    if (!Buffer.isBuffer(data) || data.length === 0) {
      throw new WindowsThermalWorkerError({
        message: 'Raw print data must not be empty',
        code: 'INVALID_PRINT_DATA',
        stage: 'VALIDATE_REQUEST',
        failureClass: 'SAFE_BEFORE_PRINT',
        action: 'print',
      });
    }

    const normalizedUsbVids = [...new Set(
      expectedUsbVids
        .map((vid) => vid.trim().toUpperCase())
        .filter((vid) => /^[0-9A-F]{4}$/.test(vid)),
    )];
    const result = await this.sendRequest('print', {
      printerName: normalizedPrinterName,
      documentName: documentName.trim() || 'Zira AI Receipt',
      dataBase64: data.toString('base64'),
      expectedUsbVids: normalizedUsbVids,
    });

    const jobId = Number((result as any)?.jobId);
    const bytesWritten = Number((result as any)?.bytesWritten);
    const spoolMs = Number((result as any)?.spoolMs);
    const preflightMs = Number((result as any)?.preflightMs);
    const presenceProbeMs = Number((result as any)?.presenceProbeMs);
    const presenceReason = (result as any)?.presenceReason;
    const portName = (result as any)?.portName;
    const reconcileMs = Number((result as any)?.reconcileMs);
    const printerStatus = Number((result as any)?.printerStatus);
    const jobStatus = Number((result as any)?.jobStatus);
    const printerStatusText = (result as any)?.printerStatusText;
    const jobStatusText = (result as any)?.jobStatusText;
    if (
      !Number.isInteger(jobId)
      || jobId <= 0
      || !Number.isInteger(bytesWritten)
      || bytesWritten !== data.length
    ) {
      throw this.protocolError('print', 'Worker returned an invalid Winspool result');
    }

    return {
      jobId,
      bytesWritten,
      spoolMs: Number.isFinite(spoolMs) ? spoolMs : 0,
      preflightMs: Number.isFinite(preflightMs) ? preflightMs : 0,
      presenceProbeMs: Number.isFinite(presenceProbeMs) ? presenceProbeMs : 0,
      presenceReason: typeof presenceReason === 'string'
        ? presenceReason
        : 'UNKNOWN',
      portName: typeof portName === 'string' ? portName : '',
      reconcileMs: Number.isFinite(reconcileMs) ? reconcileMs : 0,
      printerStatus: Number.isInteger(printerStatus) && printerStatus >= 0
        ? printerStatus
        : 0,
      printerStatusText: typeof printerStatusText === 'string'
        ? printerStatusText
        : 'UNKNOWN',
      jobStatus: Number.isInteger(jobStatus) && jobStatus >= 0 ? jobStatus : 0,
      jobStatusText: typeof jobStatusText === 'string' ? jobStatusText : 'UNKNOWN',
    };
  }

  async stop(): Promise<void> {
    if (!this.proc) return;
    this.stopping = true;
    const proc = this.proc;

    try {
      if (this.ready && proc.stdin.writable) {
        await this.sendRequest('stop', {}, this.stopTimeoutMs);
      }
    } catch (error) {
      logger.debug(`[WindowsThermalWorker] Graceful stop failed: ${(error as Error)?.message || error}`);
    }

    if (this.proc === proc && !proc.killed) {
      await new Promise<void>((resolve) => {
        let settled = false;
        const finish = () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve();
        };
        const timer = setTimeout(() => {
          try { proc.kill(); } catch { /* best effort */ }
          finish();
        }, this.stopTimeoutMs);
        proc.once('exit', finish);
      });
    }

    if (this.proc === proc) {
      const stoppedError = new WindowsThermalWorkerError({
        message: 'Windows thermal worker stopped',
        code: 'WORKER_STOPPED',
        stage: this.ready ? 'PROCESS' : 'STARTUP',
        failureClass: 'SAFE_BEFORE_PRINT',
        action: 'stop',
      });
      this.rejectStartup(stoppedError);
      this.rejectAllPending(stoppedError.message, stoppedError.code, stoppedError.stage);
      this.resetProcess(proc);
    }
    this.stopping = false;
  }

  private async ensureStarted(): Promise<void> {
    if (this.ready && this.proc && !this.proc.killed) return;
    if (this.startPromise) return this.startPromise;

    if (this.platform !== 'win32') {
      throw new WindowsThermalWorkerError({
        message: `Windows thermal worker is unavailable on ${this.platform}`,
        code: 'UNSUPPORTED_PLATFORM',
        stage: 'STARTUP',
        failureClass: 'SAFE_BEFORE_PRINT',
        action: 'ping',
      });
    }
    if (!existsSync(this.scriptPath)) {
      throw new WindowsThermalWorkerError({
        message: `Windows thermal worker script not found: ${this.scriptPath}`,
        code: 'WORKER_SCRIPT_NOT_FOUND',
        stage: 'STARTUP',
        failureClass: 'SAFE_BEFORE_PRINT',
        action: 'ping',
      });
    }

    const promise = new Promise<void>((resolve, reject) => {
      this.startResolve = resolve;
      this.startReject = reject;
    });
    this.startPromise = promise;

    let proc: ChildProcessWithoutNullStreams;
    try {
      proc = this.spawnProcess(
        this.powershellPath,
        [
          '-NoLogo',
          '-NoProfile',
          '-NonInteractive',
          '-ExecutionPolicy',
          'Bypass',
          '-File',
          this.scriptPath,
        ],
        {
          stdio: ['pipe', 'pipe', 'pipe'],
          windowsHide: true,
          shell: false,
        },
      );
    } catch (error) {
      const workerError = new WindowsThermalWorkerError({
        message: `Failed to start Windows thermal worker: ${(error as Error)?.message || error}`,
        code: 'WORKER_SPAWN_FAILED',
        stage: 'STARTUP',
        failureClass: 'SAFE_BEFORE_PRINT',
        action: 'ping',
        cause: error,
      });
      this.startResolve = null;
      this.startReject = null;
      this.startPromise = null;
      throw workerError;
    }

    this.proc = proc;
    this.ready = false;
    this.stdoutBuffer = '';
    this.attachProcess(proc);
    this.startTimer = setTimeout(() => {
      if (this.proc !== proc || this.ready) return;
      const error = new WindowsThermalWorkerError({
        message: `Windows thermal worker did not become ready within ${this.readyTimeoutMs}ms`,
        code: 'WORKER_READY_TIMEOUT',
        stage: 'STARTUP',
        failureClass: 'SAFE_BEFORE_PRINT',
        action: 'ping',
      });
      this.rejectStartup(error);
      try { proc.kill(); } catch { /* best effort */ }
      this.resetProcess(proc);
    }, this.readyTimeoutMs);

    try {
      await promise;
    } finally {
      if (this.startPromise === promise) this.startPromise = null;
    }
  }

  private attachProcess(proc: ChildProcessWithoutNullStreams): void {
    proc.stdout.on('data', (chunk: Buffer | string) => {
      if (this.proc !== proc) return;
      this.stdoutBuffer += chunk.toString();
      if (Buffer.byteLength(this.stdoutBuffer, 'utf8') > this.maxResponseBytes) {
        const error = new WindowsThermalWorkerError({
          message: 'Windows thermal worker response exceeded the configured limit',
          code: 'WORKER_RESPONSE_TOO_LARGE',
          stage: 'READ_RESPONSE',
          failureClass: 'SAFE_BEFORE_PRINT',
          action: 'ping',
        });
        this.failProcess(proc, error);
        return;
      }

      const lines = this.stdoutBuffer.split(/\r?\n/);
      this.stdoutBuffer = lines.pop() || '';
      for (const line of lines) {
        if (line.trim()) this.handleLine(line.trim());
      }
    });

    proc.stderr.on('data', (chunk: Buffer | string) => {
      const message = chunk.toString().trim();
      if (message) {
        logger.warn(`[WindowsThermalWorker:stderr] ${message.slice(0, 1000)}`);
      }
    });

    proc.once('error', (cause: Error) => {
      if (this.proc !== proc) return;
      this.failProcess(proc, new WindowsThermalWorkerError({
        message: `Windows thermal worker process error: ${cause.message}`,
        code: 'WORKER_PROCESS_ERROR',
        stage: this.ready ? 'PROCESS' : 'STARTUP',
        failureClass: 'SAFE_BEFORE_PRINT',
        action: 'ping',
        cause,
      }));
    });

    proc.once('exit', (code, signal) => {
      if (this.proc !== proc) return;
      const message = this.stopping
        ? 'Windows thermal worker stopped'
        : `Windows thermal worker exited (code=${String(code)}, signal=${String(signal)})`;
      const startupError = new WindowsThermalWorkerError({
        message,
        code: this.stopping ? 'WORKER_STOPPED' : 'WORKER_EXITED',
        stage: this.ready ? 'PROCESS' : 'STARTUP',
        failureClass: 'SAFE_BEFORE_PRINT',
        action: 'ping',
      });
      this.rejectStartup(startupError);
      this.rejectAllPending(message, 'WORKER_EXITED', 'PROCESS');
      this.resetProcess(proc);
    });
  }

  private handleLine(line: string): void {
    let response: WorkerResponse;
    try {
      response = JSON.parse(line) as WorkerResponse;
    } catch {
      logger.warn(`[WindowsThermalWorker] Ignoring invalid JSON response: ${line.slice(0, 300)}`);
      return;
    }

    if (response.type === 'ready') {
      if (response.protocolVersion !== WINDOWS_THERMAL_WORKER_PROTOCOL_VERSION) {
        const error = new WindowsThermalWorkerError({
          message:
            `Windows thermal worker protocol mismatch: expected ` +
            `${WINDOWS_THERMAL_WORKER_PROTOCOL_VERSION}, received ${String(response.protocolVersion)}`,
          code: 'WORKER_PROTOCOL_MISMATCH',
          stage: 'STARTUP',
          failureClass: 'SAFE_BEFORE_PRINT',
          action: 'ping',
        });
        if (this.proc) this.failProcess(this.proc, error);
        return;
      }
      this.ready = true;
      if (this.startTimer) {
        clearTimeout(this.startTimer);
        this.startTimer = null;
      }
      const resolve = this.startResolve;
      this.startResolve = null;
      this.startReject = null;
      resolve?.();
      logger.info('[WindowsThermalWorker] Worker ready');
      return;
    }

    if (!Number.isInteger(response.id)) {
      logger.debug(`[WindowsThermalWorker] Ignoring response without request id: ${line.slice(0, 300)}`);
      return;
    }

    const pending = this.pending.get(response.id!);
    if (!pending) {
      logger.debug(`[WindowsThermalWorker] Ignoring late/unknown response id=${response.id}`);
      return;
    }
    this.pending.delete(response.id!);
    clearTimeout(pending.timer);

    if (response.ok === true) {
      pending.resolve(response.result || {});
      return;
    }

    const reportedClass = response.error?.failureClass;
    const failureClass = reportedClass === 'SAFE_BEFORE_PRINT'
      || reportedClass === 'UNCERTAIN_AFTER_PRINT'
      ? reportedClass
      : workerFailureClass(pending.action, pending.dispatched);
    pending.reject(new WindowsThermalWorkerError({
      message: response.error?.message || `Windows thermal worker ${pending.action} failed`,
      code: response.error?.code || 'WORKER_REQUEST_FAILED',
      stage: response.error?.stage || 'WORKER_REQUEST',
      failureClass,
      action: pending.action,
    }));
  }

  private async sendRequest(
    action: ThermalWorkerAction,
    payload: Record<string, unknown>,
    timeoutMs: number = this.requestTimeoutMs,
  ): Promise<unknown> {
    await this.ensureStarted();
    const proc = this.proc;
    if (!proc?.stdin?.writable) {
      throw new WindowsThermalWorkerError({
        message: 'Windows thermal worker stdin is not writable',
        code: 'WORKER_NOT_WRITABLE',
        stage: 'DISPATCH',
        failureClass: 'SAFE_BEFORE_PRINT',
        action,
      });
    }

    const id = ++this.requestId;
    const encoded = Buffer.from(JSON.stringify({ id, action, payload }), 'utf8').toString('base64');
    const line = `${encoded}\n`;

    return new Promise<unknown>((resolve, reject) => {
      const pending: PendingRequest = {
        action,
        resolve,
        reject,
        dispatched: false,
        timer: setTimeout(() => {
          const current = this.pending.get(id);
          if (!current) return;
          this.pending.delete(id);
          const timeoutError = new WindowsThermalWorkerError({
            message: `Windows thermal worker ${action} timed out after ${timeoutMs}ms`,
            code: 'WORKER_REQUEST_TIMEOUT',
            stage: 'WAIT_RESPONSE',
            failureClass: workerFailureClass(action, current.dispatched),
            action,
          });
          current.reject(timeoutError);

          // A timed-out stdio worker cannot safely accept more work. Do not
          // replay the timed-out request; terminate and lazily start a fresh
          // process for the next request.
          if (this.proc === proc) {
            this.rejectAllPending(
              'Windows thermal worker was terminated after a request timeout',
              'WORKER_TERMINATED_AFTER_TIMEOUT',
              'WAIT_RESPONSE',
            );
            try { proc.kill(); } catch { /* best effort */ }
            this.resetProcess(proc);
          }
        }, timeoutMs),
      };
      this.pending.set(id, pending);

      try {
        pending.dispatched = true;
        proc.stdin.write(line, 'ascii', (error?: Error | null) => {
          if (!error) return;
          const current = this.pending.get(id);
          if (!current) return;
          this.pending.delete(id);
          clearTimeout(current.timer);
          current.reject(new WindowsThermalWorkerError({
            message: `Failed to dispatch Windows thermal worker ${action}: ${error.message}`,
            code: 'WORKER_WRITE_FAILED',
            stage: 'DISPATCH',
            failureClass: workerFailureClass(action, current.dispatched),
            action,
            cause: error,
          }));
        });
      } catch (cause) {
        const current = this.pending.get(id);
        if (!current) return;
        this.pending.delete(id);
        clearTimeout(current.timer);
        // A synchronous stream exception happened before Node accepted the
        // write. It is safe to retry even for a print request.
        current.dispatched = false;
        current.reject(new WindowsThermalWorkerError({
          message: `Failed to dispatch Windows thermal worker ${action}: ${(cause as Error)?.message || cause}`,
          code: 'WORKER_WRITE_FAILED',
          stage: 'DISPATCH',
          failureClass: 'SAFE_BEFORE_PRINT',
          action,
          cause,
        }));
      }
    });
  }

  private protocolError(action: ThermalWorkerAction, message: string): WindowsThermalWorkerError {
    return new WindowsThermalWorkerError({
      message,
      code: 'WORKER_BAD_RESPONSE',
      stage: 'PARSE_RESPONSE',
      // A malformed print success/error response arrives only after dispatch.
      failureClass: action === 'print' ? 'UNCERTAIN_AFTER_PRINT' : 'SAFE_BEFORE_PRINT',
      action,
    });
  }

  private failProcess(
    proc: ChildProcessWithoutNullStreams,
    startupError: WindowsThermalWorkerError,
  ): void {
    if (this.proc !== proc) return;
    this.rejectStartup(startupError);
    this.rejectAllPending(
      startupError.message,
      startupError.code,
      startupError.stage,
    );
    try { proc.kill(); } catch { /* best effort */ }
    this.resetProcess(proc);
  }

  private rejectStartup(error: WindowsThermalWorkerError): void {
    if (this.startTimer) {
      clearTimeout(this.startTimer);
      this.startTimer = null;
    }
    const reject = this.startReject;
    this.startResolve = null;
    this.startReject = null;
    reject?.(error);
  }

  private rejectAllPending(message: string, code: string, stage: string): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new WindowsThermalWorkerError({
        message,
        code,
        stage,
        failureClass: workerFailureClass(pending.action, pending.dispatched),
        action: pending.action,
      }));
    }
    this.pending.clear();
  }

  private resetProcess(proc: ChildProcessWithoutNullStreams): void {
    if (this.proc !== proc) return;
    if (this.startTimer) {
      clearTimeout(this.startTimer);
      this.startTimer = null;
    }
    this.proc = null;
    this.ready = false;
    this.stdoutBuffer = '';
  }
}

/**
 * Default process-wide worker. Construction is side-effect free; PowerShell
 * starts only when warmup/render/print/ping is first called.
 */
export const windowsThermalWorker = new WindowsThermalWorker();
