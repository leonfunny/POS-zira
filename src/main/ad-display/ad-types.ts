export type TvAdPlaybackMode = 'sequential' | 'repeat-one';
export type TvAdMediaType = 'video' | 'image';

export interface TvAdVideo {
  id: string;        // stable id, e.g. 'ad_<timestamp>_<rand>'
  filename: string;  // file trong ad-videos/, vd 'ad_169..._a1.mp4'
  order: number;     // 0-based, thứ tự phát
  enabled: boolean;
  type?: TvAdMediaType;
  durationMs?: number; // image slide duration; video duration comes from the file
}

export interface TvAdConfig {
  tvAdEnabled: boolean;
  tvAdPort: number;
  tvAdControlToken?: string;
  tvAdPlaybackMode: TvAdPlaybackMode;
  tvAdRepeatVideoId: string | null;
  tvAdMuted: boolean;
  tvAdVolume: number; // 0..100
  tvAdPlaylist: TvAdVideo[];
}

export const AD_DISPLAY_DEFAULTS: TvAdConfig = {
  tvAdEnabled: false,
  tvAdPort: 17893,
  tvAdControlToken: undefined,
  tvAdPlaybackMode: 'sequential',
  tvAdRepeatVideoId: null,
  tvAdMuted: true,
  tvAdVolume: 0,
  tvAdPlaylist: [],
};

// Payload trả cho app TV qua GET /playlist.json
export interface AdPlaylistPayload {
  version: string;
  playbackMode: TvAdPlaybackMode;
  repeatVideoId: string | null;
  muted: boolean;
  volume: number;
  media: Array<{ id: string; url: string; order: number; type: TvAdMediaType; durationMs?: number }>;
  videos: Array<{ id: string; url: string; order: number }>;
}

export interface AdDisplayStatus {
  running: boolean;
  port: number | null;
  ips: string[];
  /** Địa chỉ LAN "thật" mà TV nhiều khả năng với tới được (đã lọc adapter ảo/VPN). */
  primaryIp?: string;
  connectedClients: number;
  remoteUrl?: string;
  error?: string;
}
