import { beforeEach, describe, expect, it, vi } from 'vitest';

const mock = vi.hoisted(() => ({
  execSync: vi.fn(() => ''),
  existsSync: vi.fn(() => false),
}));

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => 'C:\\tmp\\zira-ai') },
  BrowserWindow: { getFocusedWindow: vi.fn(() => null) },
  dialog: { showMessageBox: vi.fn() },
}));

vi.mock('child_process', async () => {
  const actual = await vi.importActual<typeof import('child_process')>('child_process');
  return {
    ...actual,
    execSync: mock.execSync,
  };
});

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    existsSync: mock.existsSync,
  };
});

vi.mock('../src/main/logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

describe('SshTunnelManager startup', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('does not run synchronous shell probes during initialize', async () => {
    const { SshTunnelManager } = await import('../src/main/remote/ssh-tunnel');
    const manager = new SshTunnelManager();

    await manager.initialize();

    expect(mock.execSync).not.toHaveBeenCalled();
  });
});
