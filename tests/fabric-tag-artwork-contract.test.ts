import { describe, expect, it, vi } from 'vitest';
import {
  FABRIC_TAG_ARTWORK_CHANNELS,
  createFabricTagArtworksBridge,
} from '../src/shared/fabric-tag-artwork-ipc';
import {
  FABRIC_TAG_ARTWORK_LIMITS,
  FABRIC_TAG_ARTWORK_MEDIA,
} from '../src/shared/types';

describe('fabric artwork shared contract', () => {
  it('locks the measured 20mm/203dpi canvas and reachable content geometry', () => {
    expect(FABRIC_TAG_ARTWORK_MEDIA).toEqual({
      dpi: 203,
      dotsPerMm: 8,
      physicalWidthMm: 20,
      fullCanvasWidthPx: 160,
      edgeInsetPx: 9,
      printableWidthPx: 142,
      minHeightPx: 80,
      maxHeightPx: 480,
    });
    expect(
      FABRIC_TAG_ARTWORK_MEDIA.fullCanvasWidthPx
        - FABRIC_TAG_ARTWORK_MEDIA.edgeInsetPx * 2,
    ).toBe(FABRIC_TAG_ARTWORK_MEDIA.printableWidthPx);
    expect(FABRIC_TAG_ARTWORK_LIMITS.quantity).toBe(999);
  });

  it('uses an exact, collision-free method-to-channel map', () => {
    expect(FABRIC_TAG_ARTWORK_CHANNELS).toEqual({
      importSource: 'pos:fabric-tag-artworks:import-source',
      attachProduction: 'pos:fabric-tag-artworks:attach-production',
      list: 'pos:fabric-tag-artworks:list',
      getPreview: 'pos:fabric-tag-artworks:get-preview',
      retire: 'pos:fabric-tag-artworks:retire',
      print: 'pos:fabric-tag-artworks:print',
    });
    expect(new Set(Object.values(FABRIC_TAG_ARTWORK_CHANNELS)).size)
      .toBe(Object.keys(FABRIC_TAG_ARTWORK_CHANNELS).length);
  });

  it('forwards only the documented print request object on the exact print channel', async () => {
    const invoke = vi.fn(async () => ({ success: true }));
    const bridge = createFabricTagArtworksBridge(invoke);
    const request = { assetId: 'asset-1', quantity: 17 };

    await bridge.print(request);

    expect(invoke).toHaveBeenCalledOnce();
    expect(invoke).toHaveBeenCalledWith('pos:fabric-tag-artworks:print', request);
  });
});
