import { EventEmitter } from 'events';
import { describe, expect, it, vi } from 'vitest';
import SocketClient from '../src/main/network/socket-client';

vi.mock('../src/main/logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

describe('SocketClient job status contract', () => {
  it('emits failureClass when reporting a failed print job', () => {
    const client = new SocketClient();
    const emit = vi.fn();
    (client as any).socket = { connected: true, emit };

    client.sendJobStatus('job-1', 'FAILED', 'Printer not connected', 'SAFE_BEFORE_PRINT');

    expect(emit).toHaveBeenCalledWith('job:status', {
      jobId: 'job-1',
      status: 'FAILED',
      errorMessage: 'Printer not connected',
      failureClass: 'SAFE_BEFORE_PRINT',
    });
  });

  it('starts heartbeat after a late backend connection event', () => {
    vi.useFakeTimers();
    const client = new SocketClient();
    const socket = new EventEmitter() as EventEmitter & {
      connected: boolean;
      disconnect: ReturnType<typeof vi.fn>;
    };
    socket.connected = true;
    socket.disconnect = vi.fn();
    const emitSpy = vi.spyOn(socket, 'emit');

    (client as any).socket = socket;
    (client as any).setupEventHandlers();
    socket.emit('connected', { agentId: 'agent-1', pendingJobs: 0 });
    emitSpy.mockClear();

    vi.advanceTimersByTime(30000);

    expect(emitSpy).toHaveBeenCalledWith('heartbeat', {}, expect.any(Function));
    client.disconnect();
    vi.useRealTimers();
  });
});
