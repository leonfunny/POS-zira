import { describe, expect, it } from 'vitest';

import { buildFabricTagHtml } from '../src/main/hardware/tsc/fabric-tag-renderer';
import type { FabricTagData } from '../src/shared/types';

/** A 20 mm ribbon at 203 dpi — the machine this shop actually runs. */
const WIDTH_DOTS = Math.round((20 / 25.4) * 203);
const HEIGHT_DOTS = Math.round((60 / 25.4) * 203);

const TAG: FabricTagData = {
  size: 'M',
  composition: '70% POLIESTER 30% AKRYL',
  careSymbols: ['WASH_30', 'BLEACH_NO', 'TUMBLE_NO', 'IRON_LOW', 'DRYCLEAN_P'],
  careText: 'PRAĆ Z PODOBNYMI KOLORAMI',
  layout: 'default',
  quantity: 1,
} as FabricTagData;

function fontSizes(html: string): Record<string, number> {
  const sizes: Record<string, number> = {};
  for (const match of html.matchAll(/\.(\w[\w-]*) \{ font-size: (\d+)px/g)) {
    sizes[match[1]] = Number(match[2]);
  }
  return sizes;
}

describe('what the tag prints has to be readable at 203 dpi', () => {
  const sizes = fontSizes(buildFabricTagHtml(TAG, WIDTH_DOTS, HEIGHT_DOTS));

  it('prints the fibre percentages big enough to read on a 20 mm ribbon', () => {
    // 12 dots -- the old size -- came off the machine visibly fainter than the
    // rest of the tag, and the composition is the line customers ask about.
    expect(sizes.composition).toBeGreaterThanOrEqual(16);
  });

  it('keeps the size letter the largest thing on the tag', () => {
    expect(sizes.size).toBeGreaterThan(sizes.composition);
  });

  it('keeps the composition above the extra line, not level with it', () => {
    expect(sizes.composition).toBeGreaterThan(sizes['care-text']);
  });

  it('holds every line above the dot floor where strokes threshold away', () => {
    // Below roughly 11 dots a stroke falls between the dots and vanishes; that
    // is how "NATURALNY LEN" once printed as "ATURALNY LE".
    for (const [name, px] of Object.entries(sizes)) {
      expect(px, name).toBeGreaterThanOrEqual(11);
    }
  });

  it('scales with the ribbon rather than hard-coding one width', () => {
    const wide = fontSizes(buildFabricTagHtml(TAG, WIDTH_DOTS * 2, HEIGHT_DOTS));
    expect(wide.composition).toBeGreaterThan(sizes.composition);
  });
});
