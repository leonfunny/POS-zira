import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const source = readFileSync(
  resolve(__dirname, '../src/renderer/components/pos/KitchenSelfOrderPanel.tsx'),
  'utf-8',
);

describe('kitchen voice toggle in KitchenSelfOrderPanel', () => {
  it('has state initialised from config (default true)', () => {
    expect(source).toContain('const [kitchenVoiceEnabled, setKitchenVoiceEnabled] = useState<boolean>(true)');
    expect(source).toContain('setKitchenVoiceEnabled(c.kitchenSelfOrderVoiceEnabled !== false)');
  });
  it('persists the flag on change', () => {
    expect(source).toContain('persist({ kitchenSelfOrderVoiceEnabled:');
  });
  it('labels the control in all three copy branches', () => {
    expect(source.match(/voiceLabel:/g)?.length).toBeGreaterThanOrEqual(3);
  });
});
