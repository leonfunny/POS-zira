import { afterEach, describe, expect, it } from 'vitest';
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
});
