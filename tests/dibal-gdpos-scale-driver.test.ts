import { beforeEach, describe, expect, it, vi } from 'vitest';
import { parseDibalGdposFrame } from '../src/main/hardware/scale/dibal-gdpos-scale-driver';

// getVidForPort shells out to PowerShell against the real machine. Left unmocked
// the port-selection tests below would depend on whatever COM hardware happens to
// be plugged into the build box, and would silently stop exercising the VID
// priority path. Drive it from a table instead.
const vidByPort: Record<string, string | null> = {};
vi.mock('../src/main/hardware/port-utils', () => ({
  getVidForPort: vi.fn(async (port: string) => vidByPort[port.toUpperCase()] ?? null),
  listSerialPorts: vi.fn(async () => Object.keys(vidByPort)),
}));

const { buildScalePortCandidates, identifyScaleChipset, mergeScaleSerialPorts } = await import(
  '../src/main/hardware/scale/scale-reader-service'
);

function setPorts(map: Record<string, string | null>): string[] {
  for (const key of Object.keys(vidByPort)) delete vidByPort[key];
  Object.assign(vidByPort, map);
  return Object.keys(map);
}

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
  beforeEach(() => {
    setPorts({});
  });

  it('keeps PnP scale ports even when generic serial listing drops them', () => {
    expect(mergeScaleSerialPorts(['COM3'], ['COM5'])).toEqual(['COM3', 'COM5']);
  });

  it('excludes ports already claimed by another configured device', async () => {
    const ports = setPorts({ COM3: null, COM5: null });

    const candidates = await buildScalePortCandidates(ports, new Set(['COM3']));

    expect(candidates).toEqual(['COM5']);
  });

  it('probes USB-serial adapters used by scales before unidentified ports', async () => {
    // COM9 carries a CH340 adapter, COM8 is an unidentified port. The scale
    // candidate must come first regardless of COM numbering.
    const ports = setPorts({ COM8: null, COM9: '1A86' });

    const candidates = await buildScalePortCandidates(ports, new Set());

    expect(candidates).toEqual(['COM9', 'COM8']);
  });

  it('does not favour COM5 just because it is COM5', async () => {
    // Regression guard for the hard-coded KNOWN_SCALE_PORTS = ['COM5'] short
    // circuit: it returned COM5 alone and never probed the port the scale had
    // actually moved to.
    const ports = setPorts({ COM5: null, COM7: '0403' });

    const candidates = await buildScalePortCandidates(ports, new Set());

    expect(candidates[0]).toBe('COM7');
    expect(candidates).toContain('COM5');
  });

  it('never probes fiscal printer ports', async () => {
    const ports = setPorts({ COM4: 'C1CA', COM6: '1424', COM10: null });

    const candidates = await buildScalePortCandidates(ports, new Set());

    expect(candidates).toEqual(['COM10']);
  });
});

describe('identifyScaleChipset', () => {
  it('names the USB-serial bridges that scale cables ship with', () => {
    expect(identifyScaleChipset('0403')).toBe('FTDI FT232 / USB-to-Serial');
    expect(identifyScaleChipset('067B')).toBe('Prolific PL2303 / USB-to-Serial');
    expect(identifyScaleChipset('1A86')).toBe('QinHeng CH340 / CH341');
    expect(identifyScaleChipset('10C4')).toBe('Silicon Labs CP210x');
  });

  it('accepts lower-case VIDs from the registry', () => {
    expect(identifyScaleChipset('1a86')).toBe('QinHeng CH340 / CH341');
  });

  it('reports the raw VID when the bridge is unknown', () => {
    expect(identifyScaleChipset('ABCD')).toBe('USB Serial (VID_ABCD)');
  });

  it('falls back to a generic label when no VID is available', () => {
    expect(identifyScaleChipset(null)).toBe('Standard Serial Port');
    expect(identifyScaleChipset('')).toBe('Standard Serial Port');
  });
});
