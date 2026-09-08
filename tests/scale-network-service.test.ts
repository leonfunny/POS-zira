import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentConfig, ScaleReadResult } from '../src/shared/types';
import { readRemoteScaleWeight, ScaleNetworkService } from '../src/main/hardware/scale/scale-network-service';

function configWithScale(scale: AgentConfig['scale']): AgentConfig {
  return {
    name: 'Test POS',
    printerProtocol: 'THERMAL',
    printerBaudRate: 9600,
    serverUrl: 'http://localhost:3003',
    isPaired: false,
    autoStart: false,
    scale,
  } as AgentConfig;
}

function successfulWeight(): ScaleReadResult {
  return {
    success: true,
    protocol: 'DIBAL_GDPOS',
    port: 'COM5',
    weightKg: 0.42,
    stable: true,
    status: 'S',
    rawAscii: '',
    rawHex: '',
  };
}

describe('scale network service', () => {
  let service: ScaleNetworkService | null = null;

  afterEach(async () => {
    await service?.stop();
    service = null;
  });

  it('shares a local scale over HTTP and reads it as a remote scale', async () => {
    const token = '123456';
    const hostConfig = configWithScale({
      enabled: true,
      connection: 'local',
      protocol: 'DIBAL_GDPOS',
      port: 'COM5',
      baudRate: 9600,
      share: { enabled: true, port: 0, token },
    });

    service = new ScaleNetworkService(() => hostConfig, async () => successfulWeight());
    await service.applyConfig();

    const status = service.getStatus();
    expect(status.running).toBe(true);
    expect(status.port).toBeGreaterThan(0);

    const remoteConfig = configWithScale({
      enabled: true,
      connection: 'remote',
      protocol: 'DIBAL_GDPOS',
      port: '',
      baudRate: 9600,
      remote: { host: '127.0.0.1', port: status.port || 0, token, timeoutMs: 1000 },
    });

    const result = await readRemoteScaleWeight(remoteConfig);
    expect(result).toMatchObject({
      success: true,
      protocol: 'DIBAL_GDPOS',
      port: 'COM5',
      weightKg: 0.42,
      source: 'remote',
      remoteHost: '127.0.0.1',
    });
  });

  it('rejects a remote read with the wrong pairing code', async () => {
    const hostConfig = configWithScale({
      enabled: true,
      connection: 'local',
      protocol: 'DIBAL_GDPOS',
      port: 'COM5',
      baudRate: 9600,
      share: { enabled: true, port: 0, token: '123456' },
    });

    service = new ScaleNetworkService(() => hostConfig, async () => successfulWeight());
    await service.applyConfig();

    const status = service.getStatus();
    const remoteConfig = configWithScale({
      enabled: true,
      connection: 'remote',
      protocol: 'DIBAL_GDPOS',
      port: '',
      baudRate: 9600,
      remote: { host: '127.0.0.1', port: status.port || 0, token: '000000', timeoutMs: 1000 },
    });

    const result = await readRemoteScaleWeight(remoteConfig);
    expect(result).toMatchObject({
      success: false,
      code: 'REMOTE_UNAUTHORIZED',
      source: 'remote',
    });
  });

  it('does not share when share is enabled but the scale is configured as remote', async () => {
    const hostConfig = configWithScale({
      enabled: true,
      connection: 'remote',
      protocol: 'DIBAL_GDPOS',
      port: '',
      baudRate: 9600,
      share: { enabled: true, port: 0, token: '123456' },
      remote: { host: '192.168.1.20', port: 17891, token: '123456', timeoutMs: 1000 },
    });

    service = new ScaleNetworkService(() => hostConfig, async () => successfulWeight());
    await service.applyConfig();

    expect(service.getStatus()).toMatchObject({
      running: false,
      port: null,
      error: 'Wi-Fi scale sharing only runs when Scale mode is "This POS has scale".',
    });
  });
});

describe('remote scale diagnostics and slow hardware', () => {
  let service: ScaleNetworkService | null = null;

  afterEach(async () => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    await service?.stop();
    service = null;
  });

  async function share(read: () => Promise<ScaleReadResult>) {
    const config = configWithScale({
      enabled: true, connection: 'local', protocol: 'DIBAL_GDPOS', port: 'COM5', baudRate: 9600,
      share: { enabled: true, port: 0, token: '123456' },
    });
    service = new ScaleNetworkService(() => config, read);
    await service.applyConfig();
    return configWithScale({
      ...config.scale!, connection: 'remote',
      remote: { host: '127.0.0.1', port: service.getStatus().port!, token: '123456', timeoutMs: 2000 },
    });
  }

  it('allows a real HTTP read slower than the legacy two-second setting', async () => {
    const config = await share(async () => {
      await new Promise((resolve) => setTimeout(resolve, 2200));
      return successfulWeight();
    });
    expect(await readRemoteScaleWeight(config)).toMatchObject({ success: true, weightKg: 0.42 });
  });

  it('preserves the COM error after confirming network connectivity', async () => {
    const config = await share(async () => ({
      success: false, protocol: 'DIBAL_GDPOS', port: 'COM5', code: 'NO_ACK', error: 'No ACK',
    }));
    expect(await readRemoteScaleWeight(config)).toMatchObject({
      success: false, code: 'NO_ACK', error: expect.stringContaining('scale service connected; COM5: No ACK'),
    });
  });

  it('coalesces simultaneous remote requests but takes a fresh reading afterwards', async () => {
    let release!: (result: ScaleReadResult) => void;
    const read = vi.fn(() => new Promise<ScaleReadResult>((resolve) => { release = resolve; }));
    const config = await share(read);
    const first = readRemoteScaleWeight(config);
    const second = readRemoteScaleWeight(config);
    await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(1));
    // Let the other HTTP request reach the pending read before releasing the hardware.
    await new Promise((resolve) => setTimeout(resolve, 100));
    release(successfulWeight());
    expect((await Promise.all([first, second])).every((result) => result.success)).toBe(true);
    expect(read).toHaveBeenCalledTimes(1);
    const third = readRemoteScaleWeight(config);
    await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(2));
    release(successfulWeight());
    expect(await third).toMatchObject({ success: true });
  });

  it('can read again after a hardware exception', async () => {
    const read = vi.fn().mockRejectedValueOnce(new Error('COM unavailable')).mockResolvedValue(successfulWeight());
    const config = await share(read);
    expect(await readRemoteScaleWeight(config)).toMatchObject({ success: false, code: 'REMOTE_HTTP_ERROR' });
    expect(await readRemoteScaleWeight(config)).toMatchObject({ success: true });
  });

  const remoteConfig = () => configWithScale({
    enabled: true, connection: 'remote', protocol: 'DIBAL_GDPOS', port: '', baudRate: 9600,
    remote: { host: '192.168.1.20', port: 17891, token: '123456', timeoutMs: 2000 },
  });

  it.each([
    [403, { error: 'LAN only' }, 'REMOTE_FORBIDDEN'],
    [503, {}, 'REMOTE_HTTP_ERROR'],
    [200, { running: false }, 'REMOTE_NOT_SHARING'],
    [200, { unrelatedService: true }, 'REMOTE_NOT_SHARING'],
  ])('does not attempt COM when status is %s / %j', async (status, payload, code) => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(payload), { status }));
    vi.stubGlobal('fetch', fetchMock);
    expect(await readRemoteScaleWeight(remoteConfig())).toMatchObject({ success: false, code });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('reports malformed JSON as a protocol error, not a network failure', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('<html>wrong service</html>')));
    expect(await readRemoteScaleWeight(remoteConfig())).toMatchObject({ success: false, code: 'REMOTE_PARSE_FAILED' });
  });

  it.each(['connection', 'read'] as const)('identifies timeout during %s', async (stage) => {
    vi.useFakeTimers();
    const hang = (_url: unknown, options: RequestInit) => new Promise<Response>((_resolve, reject) => {
      options.signal!.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
    });
    const fetchMock = vi.fn(hang);
    if (stage === 'read') fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ running: true })));
    vi.stubGlobal('fetch', fetchMock);
    const pending = readRemoteScaleWeight(remoteConfig());
    await vi.advanceTimersByTimeAsync(stage === 'connection' ? 2000 : 10_000);
    expect(await pending).toMatchObject({
      success: false,
      code: stage === 'connection' ? 'REMOTE_TIMEOUT' : 'REMOTE_READ_TIMEOUT',
      error: expect.stringContaining(stage === 'connection' ? 'scale service did not answer' : 'scale service connected, but no weight'),
    });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('includes the socket error code without exposing the pairing code', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(Object.assign(new Error('fetch failed'), { cause: { code: 'ECONNREFUSED' } })));
    const result = await readRemoteScaleWeight(remoteConfig());
    expect(result).toMatchObject({ success: false, code: 'REMOTE_NETWORK_ERROR', error: expect.stringContaining('ECONNREFUSED') });
    expect(JSON.stringify(result)).not.toContain('123456');
  });
});
