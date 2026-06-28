import { createHash } from 'crypto';
import type { AdPlaylistPayload, TvAdConfig } from './ad-types';

export function buildAdPlaylistPayload(config: TvAdConfig): AdPlaylistPayload {
  const media = (config.tvAdPlaylist || [])
    .filter(v => v.enabled)
    .sort((a, b) => a.order - b.order)
    .map(v => {
      const type = v.type || inferTypeFromFilename(v.filename);
      return {
        id: v.id,
        url: `/media/${v.id}`,
        order: v.order,
        type,
        ...(type === 'image' ? { durationMs: normalizeImageDuration(v.durationMs) } : {}),
      };
    });

  return {
    version: computeAdVersion(config),
    playbackMode: config.tvAdPlaybackMode,
    repeatVideoId: config.tvAdRepeatVideoId,
    muted: config.tvAdMuted,
    volume: config.tvAdVolume,
    media,
    videos: media
      .filter(v => v.type === 'video')
      .map(v => ({ id: v.id, url: `/video/${v.id}`, order: v.order })),
  };
}

export function computeAdVersion(config: TvAdConfig): string {
  const signature = {
    mode: config.tvAdPlaybackMode,
    repeat: config.tvAdRepeatVideoId,
    muted: config.tvAdMuted,
    volume: config.tvAdVolume,
    videos: (config.tvAdPlaylist || [])
      .filter(v => v.enabled)
      .sort((a, b) => a.order - b.order)
      .map(v => `${v.id}:${v.order}:${v.type || inferTypeFromFilename(v.filename)}:${normalizeImageDuration(v.durationMs)}`),
  };
  return createHash('sha1').update(JSON.stringify(signature)).digest('hex').slice(0, 12);
}

export function normalizeImageDuration(value: unknown): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return 7000;
  return Math.min(60000, Math.max(2000, Math.round(n)));
}

function inferTypeFromFilename(filename: string): 'video' | 'image' {
  return /\.(jpe?g|png|webp)$/i.test(filename) ? 'image' : 'video';
}
