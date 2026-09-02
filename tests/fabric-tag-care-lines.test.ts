import { describe, expect, it } from 'vitest';

import { buildFabricTagHtml } from '../src/main/hardware/tsc/fabric-tag-renderer';
import {
  parseFabricTagCareText,
  parseFabricTagData,
} from '../src/main/hardware/tsc/fabric-tag-input';
import { FABRIC_TAG_LIMITS } from '../src/shared/types';
import type { FabricTagData } from '../src/shared/types';

const WIDTH_DOTS = Math.round((20 / 25.4) * 203);
const HEIGHT_DOTS = Math.round((60 / 25.4) * 203);

function tag(careText: string): FabricTagData {
  return {
    size: 'M',
    composition: '70% POLIESTER 30% AKRYL',
    careSymbols: ['WASH_30'],
    careText,
    layout: 'default',
    quantity: 1,
  } as FabricTagData;
}

function careRows(html: string): string[] {
  return Array.from(html.matchAll(/<div class="care-text">(.*?)<\/div>/g)).map((m) => m[1]);
}

describe('the extra wording prints one sentence per row', () => {
  it('puts each line in its own row', () => {
    // Joined into one paragraph, a note typed by hand ran on from the end of
    // the preset above it and read as part of that sentence.
    expect(careRows(buildFabricTagHtml(tag('NATURALNY LEN\nTEST123'), WIDTH_DOTS, HEIGHT_DOTS)))
      .toEqual(['NATURALNY LEN', 'TEST123']);
  });

  it('still prints a single line as one row', () => {
    expect(careRows(buildFabricTagHtml(tag('NATURALNY LEN'), WIDTH_DOTS, HEIGHT_DOTS)))
      .toEqual(['NATURALNY LEN']);
  });

  it('prints nothing when there is no wording', () => {
    expect(careRows(buildFabricTagHtml(tag(''), WIDTH_DOTS, HEIGHT_DOTS))).toEqual([]);
    expect(careRows(buildFabricTagHtml(tag('\n  \n'), WIDTH_DOTS, HEIGHT_DOTS))).toEqual([]);
  });

  it('escapes each line separately — markup cannot ride in on the second one', () => {
    const html = buildFabricTagHtml(tag('LEN\n<script>alert(1)</script>'), WIDTH_DOTS, HEIGHT_DOTS);
    expect(html).not.toContain('<script>');
    expect(careRows(html)[1]).toContain('&lt;script&gt;');
  });
});

describe('what the printer lane accepts as extra wording', () => {
  it('keeps the lines and trims each one', () => {
    expect(parseFabricTagCareText('  NATURALNY LEN \n\n  TEST123  '))
      .toBe('NATURALNY LEN\nTEST123');
  });

  it('treats wording that is only blank lines as none at all', () => {
    expect(parseFabricTagCareText('   \n \n')).toBeUndefined();
    expect(parseFabricTagCareText(null)).toBeUndefined();
  });

  it('refuses more lines than a tag can carry', () => {
    const tooMany = Array.from({ length: FABRIC_TAG_LIMITS.careTextLines + 1 }, (_, i) => `L${i}`);
    expect(() => parseFabricTagCareText(tooMany.join('\n'))).toThrow(/at most .* lines/);
  });

  it('refuses wording longer than the tag, counted across the lines', () => {
    const overLong = ['X'.repeat(FABRIC_TAG_LIMITS.careText - 1), 'YY'].join('\n');
    expect(() => parseFabricTagCareText(overLong)).toThrow(/at most .* characters/);
  });

  it('still refuses every other control character', () => {
    expect(() => parseFabricTagCareText('LEN\tTAB')).toThrow(/control characters/);
    expect(() => parseFabricTagCareText('LENBELL')).toThrow(/control characters/);
    expect(() => parseFabricTagCareText(42)).toThrow(/a string or null/);
  });

  it('carries the lines through the whole payload parser', () => {
    const parsed = parseFabricTagData({
      size: 'M',
      composition: '70% POLIESTER',
      careText: 'NATURALNY LEN\nTEST123',
      quantity: 1,
    });
    expect(parsed.careText).toBe('NATURALNY LEN\nTEST123');
  });
});
