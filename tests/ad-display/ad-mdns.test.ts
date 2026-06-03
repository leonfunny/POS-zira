import { vi } from 'vitest';

// logger imports electron; mock it out so tests run without Electron runtime
vi.mock('../../src/main/logger', () => ({
  default: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

import { describe, it, expect } from 'vitest';
import { AdMdnsAdvertiser } from '../../src/main/ad-display/ad-mdns';

describe('AdMdnsAdvertiser', () => {
  it('start then stop without throwing, reports running state', () => {
    const adv = new AdMdnsAdvertiser();
    adv.start(17893, 'Test POS');
    expect(adv.isRunning()).toBe(true);
    adv.stop();
    expect(adv.isRunning()).toBe(false);
  });
});
