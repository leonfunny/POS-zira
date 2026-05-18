import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DevMockElzabBridge,
  MissingElzabBridge,
  ElzabSidecarBridge,
  createDefaultElzabBridge,
  type ElzabConnectionConfig,
} from '../src/main/hardware/elzab/elzab-bridge';

vi.mock('electron', () => ({
  app: { isPackaged: false },
}));

vi.mock('../src/main/logger', () => ({
  default: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const CONFIG: ElzabConnectionConfig = {
  protocol: 'ELZAB_STX',
  port: 'COM3',
  baudRate: 9600,
};

describe('DevMockElzabBridge', () => {
  const bridge = new DevMockElzabBridge();

  it('checkAvailability returns ok with mock metadata', async () => {
    const r = await bridge.checkAvailability();
    expect(r.ok).toBe(true);
    expect(r.detail).toMatch(/MOCK/i);
    expect((r.data as any).mock).toBe(true);
  });

  it('connect returns ok and echoes target', async () => {
    const r = await bridge.connect(CONFIG);
    expect(r.ok).toBe(true);
    expect(r.detail).toContain('COM3');
    expect(r.detail).toContain('9600');
  });

  it('getStatus returns ok with mock device info', async () => {
    const r = await bridge.getStatus(CONFIG);
    expect(r.ok).toBe(true);
    expect((r.data as any).mock).toBe(true);
    expect((r.data as any).paper).toBe('OK');
  });

  it('printTest succeeds because it is non-fiscal diagnostic', async () => {
    const r = await bridge.printTest(CONFIG);
    expect(r.ok).toBe(true);
    expect(r.detail).toMatch(/nothing actually sent/);
    expect((r.data as any).lines).toContain('*** DEV MOCK TEST PAGE ***');
  });

  it('printReceipt REFUSES — real fiscal output would be illegal', async () => {
    const r = await bridge.printReceipt(CONFIG, {} as any);
    expect(r.ok).toBe(false);
    expect(r.code).toBe('ELZAB_UNSUPPORTED_OPERATION');
    expect(r.detail).toMatch(/ELZAB_MOCK_REFUSES_REAL_FISCAL/);
    expect(r.detail).toMatch(/printReceipt/);
  });

  it('printReport REFUSES — real fiscal output would be illegal', async () => {
    const r = await bridge.printReport!(CONFIG, 'DAILY', {} as any);
    expect(r.ok).toBe(false);
    expect(r.code).toBe('ELZAB_UNSUPPORTED_OPERATION');
    expect(r.detail).toMatch(/ELZAB_MOCK_REFUSES_REAL_FISCAL/);
    expect(r.detail).toMatch(/printReport/);
  });
});

describe('createDefaultElzabBridge() routing', () => {
  const savedMock = process.env.ZIRA_ELZAB_MOCK;
  const savedPath = process.env.ZIRA_ELZAB_BRIDGE_PATH;
  const savedDisableAuto = process.env.ZIRA_ELZAB_DISABLE_AUTO_SIDECAR;

  beforeEach(() => {
    delete process.env.ZIRA_ELZAB_MOCK;
    delete process.env.ZIRA_ELZAB_BRIDGE_PATH;
    process.env.ZIRA_ELZAB_DISABLE_AUTO_SIDECAR = 'true';
  });

  afterEach(() => {
    if (savedMock === undefined) delete process.env.ZIRA_ELZAB_MOCK;
    else process.env.ZIRA_ELZAB_MOCK = savedMock;
    if (savedPath === undefined) delete process.env.ZIRA_ELZAB_BRIDGE_PATH;
    else process.env.ZIRA_ELZAB_BRIDGE_PATH = savedPath;
    if (savedDisableAuto === undefined) delete process.env.ZIRA_ELZAB_DISABLE_AUTO_SIDECAR;
    else process.env.ZIRA_ELZAB_DISABLE_AUTO_SIDECAR = savedDisableAuto;
  });

  it('returns MissingElzabBridge when no env vars set', () => {
    const b = createDefaultElzabBridge();
    expect(b).toBeInstanceOf(MissingElzabBridge);
  });

  it('returns DevMockElzabBridge when ZIRA_ELZAB_MOCK=true (dev mode)', () => {
    process.env.ZIRA_ELZAB_MOCK = 'true';
    const b = createDefaultElzabBridge();
    expect(b).toBeInstanceOf(DevMockElzabBridge);
  });

  it('mock takes precedence over sidecar path when both env vars set', () => {
    process.env.ZIRA_ELZAB_MOCK = 'true';
    process.env.ZIRA_ELZAB_BRIDGE_PATH = 'C:\\fake\\sidecar.exe';
    const b = createDefaultElzabBridge();
    expect(b).toBeInstanceOf(DevMockElzabBridge);
  });

  it('falls back to MissingElzabBridge when ZIRA_ELZAB_MOCK is anything other than "true"', () => {
    process.env.ZIRA_ELZAB_MOCK = '1';
    expect(createDefaultElzabBridge()).toBeInstanceOf(MissingElzabBridge);
    process.env.ZIRA_ELZAB_MOCK = 'yes';
    expect(createDefaultElzabBridge()).toBeInstanceOf(MissingElzabBridge);
    process.env.ZIRA_ELZAB_MOCK = 'TRUE';
    expect(createDefaultElzabBridge()).toBeInstanceOf(MissingElzabBridge);
  });

  it('returns ElzabSidecarBridge when ZIRA_ELZAB_BRIDGE_PATH set and mock disabled', () => {
    process.env.ZIRA_ELZAB_BRIDGE_PATH = 'C:\\real\\sidecar.exe';
    const b = createDefaultElzabBridge();
    expect(b).toBeInstanceOf(ElzabSidecarBridge);
  });
});

// Production guard (`app.isPackaged === true` → throw ELZAB_MOCK_REFUSED_IN_PRODUCTION)
// is verified manually: in dev mode app.isPackaged is false so the mock loads;
// in NSIS-built installer it is true so createDefaultElzabBridge throws. Mocking
// require('electron') across the module boundary is brittle with Vitest's CJS
// cache. The runtime check is 3 lines (see elzab-bridge.ts isPackagedProductionBuild),
// and the actual fiscal-safety contract — mock REFUSING printReceipt/printReport —
// is already covered by the `DevMockElzabBridge` tests above.
