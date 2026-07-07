import { beforeEach, describe, expect, it, vi } from 'vitest';

const mock = vi.hoisted(() => ({
  remoteInitialize: vi.fn(async () => undefined),
  sshInitialize: vi.fn(() => new Promise<void>(() => undefined)),
  sshHandleTunnelRequest: vi.fn(async (request: any) => ({
    requestId: request.requestId,
    accepted: true,
    port: 10001,
  })),
}));

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn() },
}));

vi.mock('../src/main/logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../src/main/config/store', () => ({
  getConfigValue: vi.fn(() => false),
  getSecureRemotePin: vi.fn(() => null),
}));

vi.mock('../src/main/remote/remote-session-manager', () => {
  class FakeEmitter {
    private listeners = new Map<string, Function[]>();
    on(event: string, handler: Function) {
      this.listeners.set(event, [...(this.listeners.get(event) || []), handler]);
      return this;
    }
    emit(event: string, ...args: unknown[]) {
      for (const handler of this.listeners.get(event) || []) handler(...args);
      return true;
    }
  }
  class RemoteSessionManager extends FakeEmitter {
    initialize = mock.remoteInitialize;
    getState = vi.fn(() => ({ isBeingControlled: false, session: null }));
    handleSessionRequest = vi.fn();
    handleOffer = vi.fn();
    handleIceCandidate = vi.fn();
    endSession = vi.fn();
    acceptSession = vi.fn();
    rejectSession = vi.fn();
    showSessionRequestDialog = vi.fn(async () => false);
  }
  return { RemoteSessionManager };
});

vi.mock('../src/main/remote/ssh-tunnel', () => {
  class FakeEmitter {
    private listeners = new Map<string, Function[]>();
    on(event: string, handler: Function) {
      this.listeners.set(event, [...(this.listeners.get(event) || []), handler]);
      return this;
    }
    emit(event: string, ...args: unknown[]) {
      for (const handler of this.listeners.get(event) || []) handler(...args);
      return true;
    }
  }
  class SshTunnelManager extends FakeEmitter {
    initialize = mock.sshInitialize;
    getStatus = vi.fn(() => ({ state: 'disconnected' }));
    disconnect = vi.fn();
    generateKeyPair = vi.fn();
    autoStart = vi.fn();
    handleTunnelRequest = mock.sshHandleTunnelRequest;
  }
  return { SshTunnelManager };
});

describe('RemoteModule startup', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('registers the SSH tunnel manager without waiting for SSH capability probing', async () => {
    const container = {
      set: vi.fn(),
      getOptional: vi.fn(() => null),
    };
    const { RemoteModule } = await import('../src/main/modules/remote.module');

    const module = new RemoteModule(container as any);
    const result = await Promise.race([
      module.init().then(() => 'settled'),
      new Promise(resolve => setTimeout(() => resolve('pending'), 0)),
    ]);

    expect(result).toBe('settled');
    expect(container.set).toHaveBeenCalled();
  });

  it('looks up the main window lazily for socket-driven SSH requests', async () => {
    const handlers = new Map<string, Function>();
    const socket = {
      on: vi.fn((event: string, handler: Function) => handlers.set(event, handler)),
      sendSshTunnelResponse: vi.fn(),
    };
    let currentWindow: any = null;
    const container = {
      set: vi.fn(),
      getOptional: vi.fn(() => currentWindow),
    };
    const { RemoteModule } = await import('../src/main/modules/remote.module');
    const { RemoteSessionManager } = await import('../src/main/remote/remote-session-manager');
    const { SshTunnelManager } = await import('../src/main/remote/ssh-tunnel');

    const module = new RemoteModule(container as any);
    (module as any).remoteSessionManager = new RemoteSessionManager();
    (module as any).sshTunnelManager = new SshTunnelManager();

    module.setupSocketHandlers(socket as any);
    currentWindow = { webContents: { send: vi.fn() } };
    await handlers.get('ssh-tunnel:request')?.({
      requestId: 'ssh-1',
      userId: 'admin-1',
      userName: 'Admin',
    });

    expect(mock.sshHandleTunnelRequest).toHaveBeenCalledWith(
      expect.objectContaining({ requestId: 'ssh-1' }),
      currentWindow,
    );
    expect(socket.sendSshTunnelResponse).toHaveBeenCalledWith(expect.objectContaining({
      requestId: 'ssh-1',
      accepted: true,
    }));
  });
});
