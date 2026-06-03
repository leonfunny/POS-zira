import { describe, it, expect } from 'vitest';
import { buildAdPlaylistPayload, computeAdVersion } from '../../src/main/ad-display/ad-playlist';
import { AD_DISPLAY_DEFAULTS } from '../../src/main/ad-display/ad-types';

const base = {
  ...AD_DISPLAY_DEFAULTS,
  tvAdPlaylist: [
    { id: 'b', filename: 'b.mp4', order: 1, enabled: true },
    { id: 'a', filename: 'a.mp4', order: 0, enabled: true },
    { id: 'c', filename: 'c.mp4', order: 2, enabled: false },
  ],
};

describe('buildAdPlaylistPayload', () => {
  it('returns only enabled videos, sorted by order, with /video/:id urls', () => {
    const p = buildAdPlaylistPayload(base);
    expect(p.videos.map(v => v.id)).toEqual(['a', 'b']);
    expect(p.videos[0].url).toBe('/video/a');
    expect(p.playbackMode).toBe('sequential');
    expect(p.muted).toBe(true);
  });

  it('version changes when playlist or settings change, stable otherwise', () => {
    const v1 = computeAdVersion(base);
    const v2 = computeAdVersion(base);
    expect(v1).toBe(v2);
    const v3 = computeAdVersion({ ...base, tvAdMuted: false });
    expect(v3).not.toBe(v1);
    const v4 = computeAdVersion({ ...base, tvAdPlaylist: [base.tvAdPlaylist[0]] });
    expect(v4).not.toBe(v1);
  });
});
