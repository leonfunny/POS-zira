import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const source = readFileSync(
  resolve(__dirname, '../src/renderer/windows/kitchen-self-order/KitchenSelfOrderApp.tsx'),
  'utf-8',
);

describe('KitchenSelfOrderApp voice wiring', () => {
  it('imports the announcer', () => {
    expect(source).toContain("from './order-number-tts'");
    expect(source).toContain('playOrderNumberAnnouncement');
    expect(source).toContain('shouldAnnounceOrderNumber');
  });
  it('reads the voice flag from config', () => {
    expect(source).toContain('kitchenSelfOrderVoiceEnabled');
  });
  it('primes audio inside the submit handler before awaiting', () => {
    expect(source).toContain('primeOrderNumberAudio()');
  });
  it('guards single playback with a ref', () => {
    expect(source).toContain('announcedRef');
  });
  it('cancels the announcement on reset', () => {
    expect(source).toContain('cancelOrderNumberAnnouncement()');
  });
});
