import { describe, expect, it } from 'vitest';
import { parseDibalGdposFrame } from '../src/main/hardware/scale/dibal-gdpos-scale-driver';
import { buildScalePortCandidates, mergeScaleSerialPorts } from '../src/main/hardware/scale/scale-reader-service';

describe('Dibal GDPOS scale parser', () => {
  it('parses a stable Dibal GDPOS frame', () => {
    const frame = Buffer.from([
      0x01, 0x02, 0x30, 0x30, 0x30, 0x30, 0x30, 0x30, 0x30, 0x30, 0x00, 0x03,
      0x02, 0x53, 0x20, 0x30, 0x30, 0x2e, 0x31, 0x33, 0x38, 0x6b, 0x67, 0x6b, 0x03,
      0x02, 0x30, 0x30, 0x30, 0x30, 0x30, 0x30, 0x30, 0x30, 0x00, 0x03, 0x04,
    ]);

    const result = parseDibalGdposFrame(frame);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.status).toBe('S');
      expect(result.stable).toBe(true);
      expect(result.weightKg).toBe(0.138);
    }
  });

  it('rejects non-stable weight statuses', () => {
    const frame = Buffer.from('\x02U 00.138kg\x03', 'ascii');

    const result = parseDibalGdposFrame(frame);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('UNSTABLE');
      expect(result.status).toBe('U');
    }
  });
});

describe('Dibal scale port selection', () => {
  it('keeps PnP scale ports even when generic serial listing drops them', () => {
    expect(mergeScaleSerialPorts(['COM3'], ['COM5'])).toEqual(['COM3', 'COM5']);
  });

  it('tries the known scale COM port before fiscal ports', async () => {
    const candidates = await buildScalePortCandidates(['COM3', 'COM5'], new Set(['COM3']));

    expect(candidates).toEqual(['COM5']);
  });
});
