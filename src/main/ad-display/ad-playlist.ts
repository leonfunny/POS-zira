import { createHash } from 'crypto';
import type { AdPlaylistPayload, TvAdConfig } from './ad-types';

export function buildAdPlaylistPayload(config: TvAdConfig): AdPlaylistPayload {
  const videos = (config.tvAdPlaylist || [])
    .filter(v => v.enabled)
    .sort((a, b) => a.order - b.order)
    .map(v => ({ id: v.id, url: `/video/${v.id}`, order: v.order }));

  return {
    version: computeAdVersion(config),
    playbackMode: config.tvAdPlaybackMode,
    repeatVideoId: config.tvAdRepeatVideoId,
    muted: config.tvAdMuted,
    volume: config.tvAdVolume,
    videos,
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
      .map(v => `${v.id}:${v.order}`),
  };
  return createHash('sha1').update(JSON.stringify(signature)).digest('hex').slice(0, 12);
}
