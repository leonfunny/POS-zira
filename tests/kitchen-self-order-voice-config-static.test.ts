import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const types = readFileSync(resolve(__dirname, '../src/shared/types.ts'), 'utf-8');
const store = readFileSync(resolve(__dirname, '../src/main/config/store.ts'), 'utf-8');

describe('kitchenSelfOrderVoiceEnabled config', () => {
  it('is declared on the config type', () => {
    expect(types).toMatch(/kitchenSelfOrderVoiceEnabled\?\s*:\s*boolean/);
  });
  it('is in the store schema with default true', () => {
    expect(store).toMatch(/kitchenSelfOrderVoiceEnabled:\s*\{\s*type:\s*'boolean',\s*default:\s*true\s*\}/);
  });
});
