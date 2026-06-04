import { describe, it, expect } from 'vitest';
import { pickPrimaryLanIp } from '../../src/main/ad-display/ad-net';

describe('pickPrimaryLanIp', () => {
  it('prefers 192.168.x over virtual/VPN adapters', () => {
    expect(pickPrimaryLanIp(['172.23.32.1', '192.168.0.105', '100.103.64.102'])).toBe('192.168.0.105');
  });
  it('prefers 10.x over 172.16-31.x', () => {
    expect(pickPrimaryLanIp(['172.20.0.5', '10.0.0.7'])).toBe('10.0.0.7');
  });
  it('falls back to whatever exists', () => {
    expect(pickPrimaryLanIp(['100.103.64.102'])).toBe('100.103.64.102');
    expect(pickPrimaryLanIp([])).toBeUndefined();
  });
});
