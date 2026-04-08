import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const rootTsconfig = JSON.parse(readFileSync(join(__dirname, '../tsconfig.json'), 'utf8'));
const mainTsconfig = JSON.parse(readFileSync(join(__dirname, '../tsconfig.main.json'), 'utf8'));
const rendererTsconfig = JSON.parse(readFileSync(join(__dirname, '../tsconfig.renderer.json'), 'utf8'));

describe('tsconfig compatibility', () => {
  it('does not use deprecated baseUrl in local tsconfig files', () => {
    expect(rootTsconfig.compilerOptions).not.toHaveProperty('baseUrl');
    expect(mainTsconfig.compilerOptions).not.toHaveProperty('baseUrl');
    expect(rendererTsconfig.compilerOptions).not.toHaveProperty('baseUrl');
  });

  it('uses relative path mappings when baseUrl is absent', () => {
    for (const config of [rootTsconfig, mainTsconfig, rendererTsconfig]) {
      const pathEntries = Object.values(config.compilerOptions.paths ?? {}).flat() as string[];
      for (const pathValue of pathEntries) {
        expect(pathValue.startsWith('./')).toBe(true);
      }
    }
  });
});
