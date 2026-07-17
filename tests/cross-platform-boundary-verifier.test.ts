import { strict as assert } from 'node:assert';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, test } from 'vitest';

import { verifyCrossPlatformBoundaries } from '../scripts/verify-cross-platform-boundaries.mjs';

const TESTS_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = resolve(TESTS_DIRECTORY, '..');
const FIXTURES = resolve(TESTS_DIRECTORY, 'fixtures/cross-platform-boundaries');
const TSCONFIG = resolve(REPOSITORY_ROOT, 'tsconfig.json');

function verifyFixture(name: string, allowedPackages: string[] = []) {
  const root = resolve(FIXTURES, name);
  return verifyCrossPlatformBoundaries({
    root,
    entries: [resolve(root, 'entry.ts')],
    tsconfigPath: TSCONFIG,
    allowedPackages,
  });
}

describe('cross-platform boundary verifier', () => {
  test('accepts a pure TypeScript dependency graph', async () => {
    const result = await verifyFixture('positive');

    expect(result.ok).toBe(true);
    expect(result.diagnostics).toHaveLength(0);
    assert.deepEqual(
      result.visitedFiles.map((file: string) => basename(file)),
      ['entry.ts', 'money.ts'],
    );
  });

  test('accepts only explicitly allowlisted bare packages', async () => {
    const result = await verifyFixture('positive-allowlisted-package', ['react']);

    expect(result.ok).toBe(true);
    expect(result.diagnostics).toHaveLength(0);
  });

  test('does not treat lexically shadowed Node-like names as globals', async () => {
    const result = await verifyFixture('positive-shadowed-node-names');

    expect(result.ok).toBe(true);
    expect(result.diagnostics).toHaveLength(0);
  });

  test('allows lexically shadowed browser-global names', async () => {
    const result = await verifyFixture('positive-shadowed-global-namespaces');

    expect(result.ok).toBe(true);
    expect(result.diagnostics).toHaveLength(0);
  });

  test('does not execute a dormant exported function while checking module-load effects', async () => {
    const result = await verifyFixture('positive-dormant-exported-function');

    expect(result.ok).toBe(true);
    expect(result.diagnostics).toHaveLength(0);
  });

  test('rejects destructured Node and Electron globals from globalThis', async () => {
    const result = await verifyFixture('forbidden-globalthis-destructuring');

    expect(result.ok).toBe(false);
    expect(result.diagnostics.some(
      ({ rule }: { rule: string }) => rule === 'FORBIDDEN_NODE_GLOBAL',
    )).toBe(true);
    expect(result.diagnostics.some(
      ({ rule }: { rule: string }) => rule === 'FORBIDDEN_ELECTRON_API_GLOBAL',
    )).toBe(true);
  });

  test('rejects equivalent aliases and destructuring from window and self', async () => {
    const result = await verifyFixture('forbidden-window-self-aliases');

    expect(result.ok).toBe(false);
    expect(result.diagnostics.some(
      ({ rule }: { rule: string }) => rule === 'FORBIDDEN_NODE_GLOBAL',
    )).toBe(true);
    expect(result.diagnostics.some(
      ({ rule }: { rule: string }) => rule === 'FORBIDDEN_ELECTRON_API_GLOBAL',
    )).toBe(true);
  });

  test('rejects every unshadowed Node global escape in dormant code', async () => {
    const result = await verifyFixture('forbidden-node-global-escapes');
    const nodeGlobalDiagnostics = result.diagnostics.filter(
      ({ rule }: { rule: string }) => rule === 'FORBIDDEN_NODE_GLOBAL',
    );

    expect(result.ok).toBe(false);
    expect(nodeGlobalDiagnostics.length).toBeGreaterThanOrEqual(3);
  });

  for (const [fixture, expectedRule] of [
    ['forbidden-electron', 'FORBIDDEN_ELECTRON_IMPORT'],
    ['forbidden-node-builtin', 'FORBIDDEN_NODE_BUILTIN'],
    ['forbidden-node-global', 'FORBIDDEN_NODE_GLOBAL'],
    ['forbidden-electron-api', 'FORBIDDEN_ELECTRON_API_GLOBAL'],
    ['forbidden-capacitor', 'FORBIDDEN_CAPACITOR_IMPORT'],
    ['forbidden-print-agent-identity', 'FORBIDDEN_PRINT_AGENT_IDENTITY'],
    ['forbidden-windows-native', 'FORBIDDEN_WINDOWS_NATIVE_PACKAGE'],
    ['forbidden-top-level-side-effect', 'FORBIDDEN_TOP_LEVEL_SIDE_EFFECT'],
    ['forbidden-top-level-iife-arrow', 'FORBIDDEN_TOP_LEVEL_SIDE_EFFECT'],
    ['forbidden-top-level-iife-function', 'FORBIDDEN_TOP_LEVEL_SIDE_EFFECT'],
    ['forbidden-top-level-named-initializer', 'FORBIDDEN_TOP_LEVEL_SIDE_EFFECT'],
    ['forbidden-top-level-nested-helper', 'UNVERIFIED_TOP_LEVEL_CALL'],
    ['forbidden-top-level-imported-call', 'UNVERIFIED_TOP_LEVEL_CALL'],
    ['forbidden-top-level-imported-member-call', 'UNVERIFIED_TOP_LEVEL_CALL'],
    ['forbidden-globalthis-node', 'FORBIDDEN_NODE_GLOBAL'],
    ['forbidden-globalthis-electron-api', 'FORBIDDEN_ELECTRON_API_GLOBAL'],
    ['forbidden-globalthis-alias', 'FORBIDDEN_NODE_GLOBAL'],
    ['forbidden-nested-globalthis-alias', 'FORBIDDEN_GLOBAL_NAMESPACE'],
    ['forbidden-top-level-constructor', 'UNVERIFIED_TOP_LEVEL_CONSTRUCTION'],
    ['forbidden-top-level-member-constructor', 'UNVERIFIED_TOP_LEVEL_CONSTRUCTION'],
    ['forbidden-top-level-computed-constructor', 'UNVERIFIED_TOP_LEVEL_CONSTRUCTION'],
    ['forbidden-top-level-tagged-template', 'UNVERIFIED_TOP_LEVEL_TAGGED_TEMPLATE'],
    ['forbidden-electron-api-bare-dormant', 'FORBIDDEN_ELECTRON_API_GLOBAL'],
    ['forbidden-print-agent-bearer-key', 'FORBIDDEN_PRINT_AGENT_IDENTITY'],
    ['forbidden-class-static-field', 'FORBIDDEN_TOP_LEVEL_SIDE_EFFECT'],
    ['forbidden-class-static-block', 'FORBIDDEN_TOP_LEVEL_SIDE_EFFECT'],
    ['forbidden-class-extends-effect', 'UNVERIFIED_TOP_LEVEL_CALL'],
    ['forbidden-class-computed-effect', 'UNVERIFIED_TOP_LEVEL_CALL'],
    ['forbidden-class-bare-decorator', 'UNVERIFIED_TOP_LEVEL_DECORATOR'],
    ['forbidden-class-member-decorator', 'UNVERIFIED_TOP_LEVEL_DECORATOR'],
    ['forbidden-class-parameter-decorator', 'UNVERIFIED_TOP_LEVEL_DECORATOR'],
    ['forbidden-print-agent-machine-header', 'FORBIDDEN_PRINT_AGENT_IDENTITY'],
    ['forbidden-print-agent-agent-route', 'FORBIDDEN_PRINT_AGENT_IDENTITY'],
    ['forbidden-main-alias', 'FORBIDDEN_MAIN_PROCESS_IMPORT'],
    ['forbidden-unresolved-alias', 'UNRESOLVED_INTERNAL_ALIAS'],
    ['forbidden-bare-package', 'NON_ALLOWLISTED_BARE_PACKAGE'],
    ['forbidden-dynamic-template', 'FORBIDDEN_NODE_BUILTIN'],
  ]) {
    test(`rejects ${fixture}`, async () => {
      const result = await verifyFixture(fixture);

      expect(result.ok).toBe(false);
      expect(result.diagnostics.some(({ rule }: { rule: string }) => rule === expectedRule)).toBe(true);
    });
  }

  test('resolves reviewed aliases and rejects imports escaping the boundary root', async () => {
    const result = await verifyFixture('forbidden-shared-alias-escape');

    expect(result.ok).toBe(false);
    expect(result.diagnostics.some(
      ({ rule }: { rule: string }) => rule === 'IMPORT_OUTSIDE_BOUNDARY_ROOT',
    )).toBe(true);
  });

  test('follows a resolved alias transitively when it remains inside the boundary root', async () => {
    const entry = resolve(FIXTURES, 'forbidden-shared-alias-escape/entry.ts');
    const result = await verifyCrossPlatformBoundaries({
      root: REPOSITORY_ROOT,
      entries: [entry],
      tsconfigPath: TSCONFIG,
    });

    expect(result.ok).toBe(true);
    expect(result.visitedFiles).toContain(resolve(REPOSITORY_ROOT, 'src/shared/pos-sale.ts'));
  });

  test('reports a forbidden import reached through the transitive graph', async () => {
    const result = await verifyFixture('forbidden-transitive');
    const diagnostic = result.diagnostics.find(
      ({ rule }: { rule: string }) => rule === 'FORBIDDEN_NODE_BUILTIN',
    );

    expect(result.ok).toBe(false);
    expect(diagnostic).toBeTruthy();
    assert.deepEqual(
      diagnostic.chain.map((file: string) => basename(file)),
      ['entry.ts', 'middle.ts', 'leaf.ts'],
    );
  });

  test('does not execute a dormant instance field initializer at module load', async () => {
    const result = await verifyFixture('positive-dormant-instance-field');

    expect(result.ok).toBe(true);
    expect(result.diagnostics).toHaveLength(0);
  });
});
