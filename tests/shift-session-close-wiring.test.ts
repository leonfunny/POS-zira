import { readFileSync } from 'fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync(new URL('../src/main/modules/pos.module.ts', import.meta.url), 'utf8');

describe('POS shift close session identity wiring', () => {
  it('routes delayed manual and EOD close paths through the identity guard', () => {
    expect(source.match(/this\.posStore\?\.dispatch\(\{ type: 'session\/close' \}\);/g)).toHaveLength(1);
    expect(source.match(/this\.closeSessionIfShiftMatches\(\[data\.shiftId\]\);/g)).toHaveLength(2);
    expect(source).toContain('this.closeSessionIfShiftMatches([report.shiftId]);');
    expect(source).toContain('closedShiftIds.add(pendingReport.shiftId);');
    expect(source).toContain('closedShiftIds.add(shift.id);');
    expect(source).toContain('this.closeSessionIfShiftMatches(closedShiftIds);');
  });
});
