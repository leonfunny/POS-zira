import { describe, it, expect, vi, beforeEach } from 'vitest';

const execFileAsyncMock = vi.fn();
const withPortLockMock = vi.fn(async (_port: string, _operation: string, fn: () => Promise<unknown>) => ({
  ok: true,
  value: await fn(),
}));

vi.mock('../src/main/logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../src/main/hardware/posnet/port-mutex', () => ({
  withPortLock: withPortLockMock,
  isPortBusy: vi.fn(() => false),
}));

vi.mock('child_process', () => ({ execFile: vi.fn() }));
vi.mock('util', () => ({
  promisify: () => execFileAsyncMock,
}));

describe('runtime serial locking', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    execFileAsyncMock.mockResolvedValue({ stdout: 'NOREPLY', stderr: '' });
  });

  it('wraps POSNET profile probing in the per-port mutex', async () => {
    const { PosnetProbeEngine } = await import('../src/main/hardware/posnet/posnet-probe-engine');
    const engine = new PosnetProbeEngine();

    await engine.probePort('COM6', 0x100B);

    expect(withPortLockMock).toHaveBeenCalledWith('COM6', expect.stringContaining('probePort'), expect.any(Function));
  });

  it('wraps ESC/POS serial probing in the per-port mutex', async () => {
    const { probeEscPosPort } = await import('../src/main/hardware/port-utils');

    await probeEscPosPort('COM6', 9600);

    expect(withPortLockMock).toHaveBeenCalledWith('COM6', expect.stringContaining('probeEscPosPort'), expect.any(Function));
  });
});
