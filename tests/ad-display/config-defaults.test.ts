import { describe, it, expect } from 'vitest';
import { AD_DISPLAY_DEFAULTS } from '../../src/main/ad-display/ad-types';

describe('ad-display config defaults', () => {
  it('defaults: disabled, port 17893, sequential, muted', () => {
    expect(AD_DISPLAY_DEFAULTS.tvAdEnabled).toBe(false);
    expect(AD_DISPLAY_DEFAULTS.tvAdPort).toBe(17893);
    expect(AD_DISPLAY_DEFAULTS.tvAdPlaybackMode).toBe('sequential');
    expect(AD_DISPLAY_DEFAULTS.tvAdMuted).toBe(true);
    expect(AD_DISPLAY_DEFAULTS.tvAdVolume).toBe(0);
    expect(AD_DISPLAY_DEFAULTS.tvAdPlaylist).toEqual([]);
    expect(AD_DISPLAY_DEFAULTS.tvAdRepeatVideoId).toBeNull();
  });
});
