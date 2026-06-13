import { execFile } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import path from 'path';
import { promisify } from 'util';
import type { DailyReportData, ReceiptData } from '../../../shared/types';

const execFileAsync = promisify(execFile);

export type ElzabDiagnosticCode =
  | 'ELZAB_BRIDGE_NOT_CONFIGURED'
  | 'ELZAB_BRIDGE_NOT_FOUND'
  | 'ELZAB_BRIDGE_BAD_RESPONSE'
  | 'ELZAB_TARGET_MISSING'
  | 'ELZAB_HARDWARE_NOT_FOUND'
  | 'ELZAB_PROTOCOL_NOT_READY'
  | 'ELZAB_LOCAL_MENU_MODE'
  | 'ELZAB_UNSUPPORTED_OPERATION'
  | 'ELZAB_NO_DAILY_REPORT_CREATED'
  | 'ELZAB_DAILY_REPORT_NUMBER_UNAVAILABLE'
  | 'ELZAB_DAILY_REPORT_CONFIRMATION_UNKNOWN'
  | 'ELZAB_COMMAND_FAILED'
  | 'REAL_FISCAL_PRINT_DISABLED'
  | 'FISCAL_IDEMPOTENCY_KEY_MISSING'
  | 'FISCAL_ATTEMPT_RETRY_BLOCKED';

export interface ElzabOperationResult {
  ok: boolean;
  code?: ElzabDiagnosticCode;
  detail?: string;
  data?: unknown;
}

export interface ElzabConnectionConfig {
  protocol: 'ELZAB_STX';
  port?: string;
  address?: string;
  baudRate: number;
}

export interface ElzabBridge {
  checkAvailability(): Promise<ElzabOperationResult>;
  connect(config: ElzabConnectionConfig): Promise<ElzabOperationResult>;
  getStatus(config: ElzabConnectionConfig): Promise<ElzabOperationResult>;
  printTest(config: ElzabConnectionConfig): Promise<ElzabOperationResult>;
  printReceipt(config: ElzabConnectionConfig, data: ReceiptData): Promise<ElzabOperationResult>;
  printReport?(config: ElzabConnectionConfig, kind: 'DAILY' | 'X' | 'Z', data: DailyReportData): Promise<ElzabOperationResult>;
}

export interface ElzabSidecarCommand {
  executablePath: string;
  args?: string[];
  cwd?: string;
  displayPath?: string;
}

export class MissingElzabBridge implements ElzabBridge {
  private unavailable(): ElzabOperationResult {
    return {
      ok: false,
      code: 'ELZAB_BRIDGE_NOT_CONFIGURED',
      detail: 'ELZAB_STX requires an official elzabdr/STX sidecar. Set ZIRA_ELZAB_BRIDGE_PATH after the helper is installed and verified with real hardware.',
    };
  }

  async checkAvailability(): Promise<ElzabOperationResult> { return this.unavailable(); }
  async connect(): Promise<ElzabOperationResult> { return this.unavailable(); }
  async getStatus(): Promise<ElzabOperationResult> { return this.unavailable(); }
  async printTest(): Promise<ElzabOperationResult> { return this.unavailable(); }
  async printReceipt(): Promise<ElzabOperationResult> { return this.unavailable(); }
  async printReport(): Promise<ElzabOperationResult> { return this.unavailable(); }
}

/**
 * Dev-only mock that simulates a healthy ELZAB sidecar so the UI flow
 * (test print, status check) can be verified without the official
 * elzabdr.dll + real hardware.
 *
 *  ┌─ FISCAL SAFETY GUARDRAILS ─────────────────────────────────────────┐
 *  │ • Refuses to instantiate inside a packaged production build       │
 *  │   (app.isPackaged === true) — only dev mode (npm run dev).        │
 *  │ • Refuses printReceipt / printReport — these would generate fake  │
 *  │   fiscal output, which is illegal under Polish tax law.           │
 *  │ • printTest is OK because it's a non-fiscal diagnostic page.      │
 *  │ • Logs a loud banner every time it is mounted so it cannot be     │
 *  │   accidentally enabled in production.                             │
 *  └────────────────────────────────────────────────────────────────────┘
 *
 * Activate by setting the env var `ZIRA_ELZAB_MOCK=true` BEFORE starting
 * Electron in development. Example:
 *
 *   $env:ZIRA_ELZAB_MOCK = "true"
 *   npx electron .
 */
export class DevMockElzabBridge implements ElzabBridge {
  private static readonly MOCK_MODEL = 'ELZAB Zeta Online (MOCK)';
  private static readonly MOCK_FIRMWARE = 'MOCK-0.0.0';

  private refuseReal(operation: string): ElzabOperationResult {
    return {
      ok: false,
      code: 'ELZAB_UNSUPPORTED_OPERATION',
      detail:
        `ELZAB_MOCK_REFUSES_REAL_FISCAL: The dev mock bridge refuses ${operation} because it would generate ` +
        'fake fiscal output. Polish tax law requires fiscalization with authorized ELZAB service ' +
        'before any real fiscal command. Unset ZIRA_ELZAB_MOCK and install the official sidecar to print real receipts.',
    };
  }

  async checkAvailability(): Promise<ElzabOperationResult> {
    return {
      ok: true,
      code: undefined,
      detail: 'DEV MOCK bridge available — non-fiscal diagnostics only',
      data: { mock: true, model: DevMockElzabBridge.MOCK_MODEL, firmware: DevMockElzabBridge.MOCK_FIRMWARE },
    };
  }

  async connect(config: ElzabConnectionConfig): Promise<ElzabOperationResult> {
    return {
      ok: true,
      detail: `DEV MOCK connected via ${config.port || config.address} @ ${config.baudRate}`,
      data: { mock: true },
    };
  }

  async getStatus(config: ElzabConnectionConfig): Promise<ElzabOperationResult> {
    return {
      ok: true,
      data: {
        mock: true,
        model: DevMockElzabBridge.MOCK_MODEL,
        firmware: DevMockElzabBridge.MOCK_FIRMWARE,
        paper: 'OK',
        target: config.port || config.address,
      },
    };
  }

  async printTest(config: ElzabConnectionConfig): Promise<ElzabOperationResult> {
    // Test pages are NON-FISCAL diagnostic prints — safe to simulate.
    return {
      ok: true,
      detail: `DEV MOCK printed test page to ${config.port || config.address} (nothing actually sent to hardware)`,
      data: { mock: true, lines: ['*** DEV MOCK TEST PAGE ***', 'Zira AI Print Agent', 'ELZAB_STX simulation', new Date().toISOString()] },
    };
  }

  async printReceipt(): Promise<ElzabOperationResult> {
    return this.refuseReal('printReceipt');
  }

  async printReport(): Promise<ElzabOperationResult> {
    return this.refuseReal('printReport');
  }
}

/**
 * Sidecar boundary for the official ELZAB library.
 *
 * Do not load elzabdr.dll directly into Electron. The helper process owns the
 * vendor DLL/API and speaks a tiny JSON protocol with this app:
 *
 *   helper.exe <command> <base64-json>
 *
 * stdout must be JSON shaped like ElzabOperationResult. This keeps the fiscal
 * integration mockable and avoids coupling Electron to vendor-native ABI.
 */
export class ElzabSidecarBridge implements ElzabBridge {
  private readonly command: Required<Omit<ElzabSidecarCommand, 'displayPath'>> & { displayPath: string };

  constructor(
    executable: string | ElzabSidecarCommand,
    private readonly timeoutMs = 30_000,
  ) {
    const command = typeof executable === 'string' ? { executablePath: executable } : executable;
    this.command = {
      executablePath: command.executablePath,
      args: command.args || [],
      cwd: command.cwd || path.dirname(command.executablePath),
      displayPath: command.displayPath || command.executablePath,
    };
  }

  async checkAvailability(): Promise<ElzabOperationResult> {
    if (!existsSync(this.command.executablePath)) {
      return {
        ok: false,
        code: 'ELZAB_BRIDGE_NOT_FOUND',
        detail: `ELZAB sidecar not found at ${this.command.displayPath}`,
      };
    }
    return this.invoke('check', {});
  }

  connect(config: ElzabConnectionConfig): Promise<ElzabOperationResult> {
    return this.invoke('connect', { config });
  }

  getStatus(config: ElzabConnectionConfig): Promise<ElzabOperationResult> {
    return this.invoke('status', { config });
  }

  printTest(config: ElzabConnectionConfig): Promise<ElzabOperationResult> {
    return this.invoke('test', { config });
  }

  printReceipt(config: ElzabConnectionConfig, data: ReceiptData): Promise<ElzabOperationResult> {
    return this.invoke('receipt', { config, data });
  }

  printReport(config: ElzabConnectionConfig, kind: 'DAILY' | 'X' | 'Z', data: DailyReportData): Promise<ElzabOperationResult> {
    return this.invoke('report', { config, kind, data });
  }

  private async invoke(command: string, payload: unknown): Promise<ElzabOperationResult> {
    try {
      const body = payload && typeof payload === 'object' && !Array.isArray(payload)
        ? { command, ...(payload as Record<string, unknown>) }
        : { command, payload };
      const encoded = Buffer.from(JSON.stringify(body), 'utf8').toString('base64');
      const timeout = command === 'receipt' || command === 'report'
        ? Math.max(this.timeoutMs, 120_000)
        : command === 'test'
          ? Math.max(this.timeoutMs, 45_000)
          : this.timeoutMs;
      const { stdout } = await execFileAsync(this.command.executablePath, [...this.command.args, command, encoded], {
        cwd: this.command.cwd,
        env: buildSidecarEnv(),
        timeout,
        windowsHide: true,
        maxBuffer: 1024 * 1024,
      });
      const parsed = JSON.parse(String(stdout || '').trim());
      if (typeof parsed?.ok !== 'boolean') {
        return {
          ok: false,
          code: 'ELZAB_BRIDGE_BAD_RESPONSE',
          detail: `ELZAB sidecar returned JSON without boolean ok for ${command}`,
          data: parsed,
        };
      }
      return parsed as ElzabOperationResult;
    } catch (error: any) {
      return {
        ok: false,
        code: 'ELZAB_COMMAND_FAILED',
        detail: error?.message || String(error),
      };
    }
  }
}

function isPackagedProductionBuild(): boolean {
  try {
    // Lazy require so this module stays testable outside Electron.
    const electron = require('electron');
    return !!electron?.app?.isPackaged;
  } catch {
    return false;
  }
}

/**
 * Dev mock can be enabled via either:
 *   • ZIRA_ELZAB_MOCK=true env var (CI / shell launches)
 *   • A file `elzab-dev-mock.flag` inside the app userData directory
 *     (survives Electron restarts and spawn-chain env loss; toggle by
 *     creating/deleting the file)
 *   • A boolean key `elzabDevMock: true` inside config.json next to it.
 *
 * The file/config flag is the recommended way for local dev because env
 * vars are lost across cmd/npx/Electron auto-restart boundaries.
 */
function isMockEnabled(): boolean {
  const envOn = process.env.ZIRA_ELZAB_MOCK === 'true';
  let userData: string | undefined;
  let flagExists = false;
  let configFlagOn = false;
  try {
    const electron = require('electron');
    userData = electron?.app?.getPath?.('userData');
    if (userData) {
      const fs = require('fs');
      const path = require('path');
      flagExists = fs.existsSync(path.join(userData, 'elzab-dev-mock.flag'));
      const cfgPath = path.join(userData, 'config.json');
      if (fs.existsSync(cfgPath)) {
        const raw = fs.readFileSync(cfgPath, 'utf8');
        const cfg = JSON.parse(raw);
        if (cfg?.elzabDevMock === true) configFlagOn = true;
      }
    }
  } catch {
    /* ignore */
  }
  const enabled = envOn || flagExists || configFlagOn;
  // Audit log so we can prove which path triggered (or didn't).
  try {
    const logger = require('../../logger').default;
    logger?.info?.(
      `[ElzabBridge] isMockEnabled probe: env=${envOn} flag=${flagExists} configKey=${configFlagOn} userData=${userData || 'NIL'} → ${enabled}`,
    );
  } catch {
    /* logger optional */
  }
  return enabled;
}

export function createDefaultElzabBridge(): ElzabBridge {
  if (isMockEnabled()) {
    if (isPackagedProductionBuild()) {
      // HARD FAIL — never allow mock in shipped builds. Sales would be illegal.
      throw new Error(
        'ELZAB_MOCK_REFUSED_IN_PRODUCTION: ZIRA_ELZAB_MOCK=true is rejected in packaged production builds. ' +
        'The mock bridge is dev-only because it cannot produce valid Polish fiscal receipts.',
      );
    }
    // Loud warning so this is never missed in logs or screen captures.
    const banner = '*'.repeat(72);
    // eslint-disable-next-line no-console
    console.warn(`\n${banner}\n[ElzabBridge] DEV MOCK BRIDGE ACTIVE — DO NOT USE IN PRODUCTION\n[ElzabBridge] Test prints will succeed without real hardware. Real fiscal\n[ElzabBridge] commands (printReceipt, printReport) will be REFUSED.\n${banner}\n`);
    try {
      // Best-effort: log via app logger if available so it lands in combined.log.
      const logger = require('../../logger').default;
      logger?.warn?.('[ElzabBridge] DEV MOCK ACTIVE — dev only, fiscal receipts will be refused');
    } catch { /* logger optional for unit tests */ }
    return new DevMockElzabBridge();
  }

  const executablePath = process.env.ZIRA_ELZAB_BRIDGE_PATH?.trim();
  if (!executablePath) {
    const bundledSidecar = resolveBundledPowerShellSidecar();
    if (bundledSidecar) return new ElzabSidecarBridge(bundledSidecar);
    return new MissingElzabBridge();
  }
  return new ElzabSidecarBridge(executablePath);
}

export function isRealFiscalPrintEnabled(): boolean {
  if (process.env.ALLOW_REAL_FISCAL_PRINT === 'true') return true;
  if (process.env.ZIRA_ELZAB_IGNORE_CONFIG_ALLOW_REAL === 'true') return false;
  try {
    const cfgPath = resolveConfigPath();
    if (!cfgPath || !existsSync(cfgPath)) return false;
    const cfg = JSON.parse(readFileSync(cfgPath, 'utf8').replace(/^\uFEFF/, ''));
    return cfg?.allowRealFiscalPrint === true;
  } catch {
    return false;
  }
}

function buildSidecarEnv(): NodeJS.ProcessEnv {
  if (!isRealFiscalPrintEnabled()) return process.env;
  return { ...process.env, ALLOW_REAL_FISCAL_PRINT: 'true' };
}

function findPowerShellExe(): string | undefined {
  const systemRoot = process.env.SystemRoot || 'C:\\Windows';
  const candidates = [
    path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    path.join(systemRoot, 'Sysnative', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
  ];
  return candidates.find((candidate) => existsSync(candidate));
}

function getElectronUserDataPath(): string | undefined {
  try {
    const electron = require('electron');
    return electron?.app?.getPath?.('userData');
  } catch {
    return undefined;
  }
}

function resolveConfigPath(): string | undefined {
  const userData = getElectronUserDataPath();
  if (userData) return path.join(userData, 'config.json');
  if (process.env.APPDATA) return path.join(process.env.APPDATA, 'zira-ai', 'config.json');
  return undefined;
}

function resolveBundledPowerShellSidecar(): ElzabSidecarCommand | undefined {
  if (process.env.ZIRA_ELZAB_DISABLE_AUTO_SIDECAR === 'true') return undefined;

  const powerShell = findPowerShellExe();
  if (!powerShell) return undefined;

  const explicitScript = process.env.ZIRA_ELZAB_SIDECAR_SCRIPT?.trim();
  const userData = getElectronUserDataPath();
  const candidates = [
    explicitScript,
    path.join(process.cwd(), 'resources', 'elzab', 'sidecar', 'elzab-stx-sidecar.ps1'),
    typeof process.resourcesPath === 'string'
      ? path.join(process.resourcesPath, 'elzab', 'sidecar', 'elzab-stx-sidecar.ps1')
      : undefined,
    userData ? path.join(userData, 'elzab', 'sidecar', 'elzab-stx-sidecar.ps1') : undefined,
  ].filter((candidate): candidate is string => !!candidate);

  const script = candidates.find((candidate) => existsSync(candidate));
  if (!script) return undefined;

  return {
    executablePath: powerShell,
    args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script],
    cwd: path.dirname(script),
    displayPath: script,
  };
}
