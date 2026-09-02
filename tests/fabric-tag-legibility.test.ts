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

  it('prints the size the way the shop\'s own sample tags do — twice the body', () => {
    // On the tags this shop was given to copy, the size dwarfs everything else;
    // at the old 1.5x it read as just another line.
    expect(sizes.size / sizes.composition).toBeGreaterThanOrEqual(2.2);
  });

  it('shrinks a long size label instead of wrapping it across two rows', () => {
    // "44/46" and "L/XL" are real columns on the shop's sheets; at the full
    // size they would run off a 20 mm ribbon and break in half.
    const long = fontSizes(buildFabricTagHtml(
      { ...TAG, size: 'XS/S/M/L' }, WIDTH_DOTS, HEIGHT_DOTS,
    ));
    expect(long.size).toBeLessThan(sizes.size);
    // Still the biggest thing on the tag, though.
    expect(long.size).toBeGreaterThan(long.composition);
  });

  it('never shrinks the size under the composition, however narrow the ribbon', () => {
    // Not a tag this shop prints: a 7 mm ribbon with a ten-character size is
    // where the shrink would otherwise take the size below the body text and
    // the tag would read as if the size were an afterthought.
    const narrow = fontSizes(buildFabricTagHtml(
      { ...TAG, size: 'XS/S/M/L/X' }, 54, HEIGHT_DOTS,
    ));
    expect(narrow.size).toBe(narrow.composition + 2);
  });

  it('gives the sizes the shop actually types the full treatment', () => {
    for (const label of ['M', '2XL', 'S/M', 'L/XL', '44/46']) {
      const at = fontSizes(buildFabricTagHtml({ ...TAG, size: label }, WIDTH_DOTS, HEIGHT_DOTS));
      expect(at.size, label).toBe(sizes.size);
    }
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
