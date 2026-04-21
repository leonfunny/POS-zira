import { describe, expect, it } from 'vitest';

import {
  buildFindPosnetVidPortsScript,
  parsePosnetVidPortOutput,
} from '../src/main/hardware/posnet/pnp-port-parser';

describe('POSNET PnP PID parsing', () => {
  it('builds a PowerShell script that avoids the read-only $PID variable', () => {
    const script = buildFindPosnetVidPortsScript('1424');

    expect(script).toContain('$usbPid');
    expect(script).not.toMatch(/\$pid\b/i);
  });

  it('parses USB PID_100B as numeric product id 0x100B', () => {
    const ports = parsePosnetVidPortOutput('COM6|100B\n');

    expect(ports).toEqual([{ port: 'COM6', pidHex: '100B', pid: 0x100B }]);
  });

  it('rejects PowerShell error output instead of using a stale process id value', () => {
    expect(() => parsePosnetVidPortOutput(
      'COM6|9192\n',
      '#< CLIXML Cannot overwrite variable PID because it is read-only or constant.',
    )).toThrow(/PowerShell error/i);
  });
});
