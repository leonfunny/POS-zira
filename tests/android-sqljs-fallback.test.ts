import { describe, expect, test, vi } from 'vitest';

import { loadSqlJsWithFallback } from '../src/renderer/android-pos/shim/db/db';

/**
 * The SUNMI D2s Lite ships Android System WebView 83 (Chromium 83) and cannot
 * update it: the system's provider allowlist holds only the AOSP package. That
 * engine predates the CSP token 'wasm-unsafe-eval' (Chromium 97), so it treats
 * the token as an invalid source, drops it, and then refuses WASM code
 * generation entirely — `WebAssembly.instantiate()` throws, and so does the
 * ArrayBuffer path the console message calls a "fallback". Without a real
 * fallback the local SQLite never initialises: no catalog, no orders, no
 * shifts. sql.js ships an asm.js build that needs no WASM at all.
 */
describe('sql.js loader falls back to asm.js when WASM is unavailable', () => {
  const FAKE_WASM = { id: 'wasm' } as any;
  const FAKE_ASM = { id: 'asm' } as any;

  test('uses the WASM build when it initialises', async () => {
    const loadWasm = vi.fn(async () => FAKE_WASM);
    const loadAsm = vi.fn(async () => FAKE_ASM);

    await expect(loadSqlJsWithFallback(loadWasm, loadAsm)).resolves.toBe(FAKE_WASM);
    expect(loadAsm).not.toHaveBeenCalled();
  });

  test('falls back to asm.js when WASM codegen is blocked by the embedder', async () => {
    const loadWasm = vi.fn(async () => {
      throw new Error('CompileError: WebAssembly.instantiate(): Wasm code generation disallowed by embedder');
    });
    const loadAsm = vi.fn(async () => FAKE_ASM);

    await expect(loadSqlJsWithFallback(loadWasm, loadAsm)).resolves.toBe(FAKE_ASM);
    expect(loadAsm).toHaveBeenCalledTimes(1);
  });

  test('surfaces the ORIGINAL wasm error when the asm fallback also fails', async () => {
    // Reporting only the asm error would hide the real cause on a device where
    // WASM is blocked AND the asm chunk failed to load.
    const loadWasm = vi.fn(async () => { throw new Error('wasm blocked by embedder'); });
    const loadAsm = vi.fn(async () => { throw new Error('asm chunk 404'); });

    await expect(loadSqlJsWithFallback(loadWasm, loadAsm)).rejects.toThrow(/wasm blocked by embedder/);
  });

  test('the asm fallback is only imported when WASM fails (it is a multi-MB chunk)', async () => {
    const loadWasm = vi.fn(async () => FAKE_WASM);
    const loadAsm = vi.fn(async () => FAKE_ASM);

    await loadSqlJsWithFallback(loadWasm, loadAsm);
    await loadSqlJsWithFallback(loadWasm, loadAsm);

    expect(loadAsm).not.toHaveBeenCalled();
  });
});
