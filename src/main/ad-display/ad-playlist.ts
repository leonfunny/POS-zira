import { createHash } from 'crypto';
import type { AdPlaylistPayload, TvAdConfig } from './ad-types';

export function buildAdPlaylistPayload(config: TvAdConfig): AdPlaylistPayload {
  const media = (config.tvAdPlaylist || [])
    .filter(v => v.enabled)
    .sort((a, b) => a.order - b.order)
    .map(v => {
      const type = v.type || inferTypeFromFilename(v.filename);
      const url = playableUrlFor(v);
      return {
        id: v.id,
        url,
        order: v.order,
        type,
        source: url.startsWith('http://') || url.startsWith('https://') ? 'cloud' as const : 'local' as const,
        ...(type === 'image' ? { durationMs: normalizeImageDuration(v.durationMs) } : {}),
        ...(Number.isFinite(v.size) && Number(v.size) > 0 ? { size: Number(v.size) } : {}),
        ...(isSha256(v.sha256) ? { sha256: String(v.sha256).toLowerCase() } : {}),
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
      .map(v => ({ id: v.id, url: v.source === 'cloud' ? v.url : `/video/${v.id}`, order: v.order })),
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
      .map(v => `${v.id}:${v.order}:${v.type || inferTypeFromFilename(v.filename)}:${normalizeImageDuration(v.durationMs)}:${playableUrlFor(v)}`),
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

function playableUrlFor(item: { id: string; cloudUrl?: string }): string {
  const cloudUrl = normalizeCloudUrl(item.cloudUrl);
  return cloudUrl || `/media/${item.id}`;
}

function normalizeCloudUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  try {
    const url = new URL(trimmed);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    return url.toString();
  } catch {
    return null;
  }
}

function isSha256(value: unknown): boolean {
  return typeof value === 'string' && /^[a-f0-9]{64}$/i.test(value.trim());
}
