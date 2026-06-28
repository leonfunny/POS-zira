import { describe, it, expect } from 'vitest';
import { buildAdPlaylistPayload, computeAdVersion } from '../../src/main/ad-display/ad-playlist';
import { AD_DISPLAY_DEFAULTS } from '../../src/main/ad-display/ad-types';

const base = {
  ...AD_DISPLAY_DEFAULTS,
  tvAdPlaylist: [
    { id: 'b', filename: 'b.mp4', order: 1, enabled: true },
    { id: 'a', filename: 'a.png', order: 0, enabled: true, type: 'image' as const, durationMs: 9000 },
    { id: 'c', filename: 'c.mp4', order: 2, enabled: false },
  ],
};

describe('buildAdPlaylistPayload', () => {
  it('returns only enabled media, sorted by order, with local /media fallback urls', () => {
    const p = buildAdPlaylistPayload(base);
    expect(p.media.map(v => v.id)).toEqual(['a', 'b']);
    expect(p.media[0].url).toBe('/media/a');
    expect(p.media[0].source).toBe('local');
    expect(p.media[0].type).toBe('image');
    expect(p.media[0].durationMs).toBe(9000);
    expect(p.videos.map(v => v.id)).toEqual(['b']);
    expect(p.playbackMode).toBe('sequential');
    expect(p.muted).toBe(true);
  });

  it('uses absolute cloud urls when configured and keeps /video legacy fallback local only', () => {
    const p = buildAdPlaylistPayload({
      ...base,
      tvAdPlaylist: [
        { id: 'cloud-video', filename: 'cloud-video.mp4', order: 0, enabled: true, cloudUrl: 'https://media.enail.pro/tv/cloud-video.mp4' },
        { id: 'local-video', filename: 'local-video.mp4', order: 1, enabled: true },
      ],
    });
    expect(p.media[0]).toMatchObject({ id: 'cloud-video', url: 'https://media.enail.pro/tv/cloud-video.mp4', source: 'cloud' });
    expect(p.videos[0]).toMatchObject({ id: 'cloud-video', url: 'https://media.enail.pro/tv/cloud-video.mp4' });
    expect(p.media[1]).toMatchObject({ id: 'local-video', url: '/media/local-video', source: 'local' });
    expect(p.videos[1]).toMatchObject({ id: 'local-video', url: '/video/local-video' });
  });

  it('includes cloud verification metadata when present', () => {
    const p = buildAdPlaylistPayload({
      ...base,
      tvAdPlaylist: [
        {
          id: 'cloud-video',
          filename: 'cloud-video.mp4',
          order: 0,
          enabled: true,
          cloudUrl: 'https://media.enail.pro/tv/cloud-video.mp4',
          size: 1234,
          sha256: 'ABCDEFabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234',
        },
      ],
    });
    expect(p.media[0]).toMatchObject({
      size: 1234,
      sha256: 'abcdefabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234',
    });
  });

  it('version changes when playlist or settings change, stable otherwise', () => {
    const v1 = computeAdVersion(base);
    const v2 = computeAdVersion(base);
    expect(v1).toBe(v2);
    const v3 = computeAdVersion({ ...base, tvAdMuted: false });
    expect(v3).not.toBe(v1);
    const v4 = computeAdVersion({ ...base, tvAdPlaylist: [base.tvAdPlaylist[0]] });
    expect(v4).not.toBe(v1);
    const v5 = computeAdVersion({
      ...base,
      tvAdPlaylist: [{ ...base.tvAdPlaylist[0], cloudUrl: 'https://media.enail.pro/tv/b.mp4' }],
    });
    expect(v5).not.toBe(v1);
  });
});
