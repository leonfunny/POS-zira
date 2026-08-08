import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

/**
 * The guard exists because the rule it enforces is invisible at review time:
 * the Windows Electron build (Chromium ~130) renders `flex gap-*` correctly
 * while the SUNMI counter (Android WebView 83) collapses it to zero spacing.
 * A guard that quietly stops catching things would be worse than none, so this
 * pins both what it must catch and what it must NOT.
 */
const SCRIPT = join(__dirname, '..', 'scripts', 'verify-css-baseline.mjs');
let dir: string;

function run(extra: string[] = []): { out: string; status: number } {
  try {
    const out = execFileSync('node', [SCRIPT, `--dir=${dir}`, ...extra], { encoding: 'utf8' });
    return { out, status: 0 };
  } catch (e: any) {
    return { out: `${e.stdout ?? ''}${e.stderr ?? ''}`, status: e.status ?? 1 };
  }
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'css-baseline-'));
  mkdirSync(join(dir, 'nested'), { recursive: true });
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('css baseline guard', () => {
  test('catches gap on a flex container — the zero-spacing bug', () => {
    writeFileSync(join(dir, 'bad.tsx'), `
      export const A = () => <div className="flex items-center gap-3">x</div>;
    `);
    const { out } = run();
    expect(out).toMatch(/flex \+ gap-\*\s+1 site/);
    rmSync(join(dir, 'bad.tsx'));
  });

  test('accepts gap on a grid container — supported since Chromium 66', () => {
    writeFileSync(join(dir, 'good.tsx'), `
      export const A = () => <div className="grid grid-cols-2 gap-3">x</div>;
    `);
    const { out } = run();
    expect(out).toContain('PASS css baseline');
    rmSync(join(dir, 'good.tsx'));
  });

  test('accepts margin-based spacing on a flex container', () => {
    writeFileSync(join(dir, 'spacex.tsx'), `
      export const A = () => <div className="flex items-center space-x-3">x</div>;
    `);
    const { out } = run();
    expect(out).toContain('PASS css baseline');
    rmSync(join(dir, 'spacex.tsx'));
  });

  test('sees through Tailwind variant chains', () => {
    writeFileSync(join(dir, 'variant.tsx'), `
      export const A = () => <div className="sm:flex lg:hover:gap-2">x</div>;
    `);
    const { out } = run();
    expect(out).toMatch(/flex \+ gap-\*\s+1 site/);
    rmSync(join(dir, 'variant.tsx'));
  });

  test('judges conditional class strings per branch, not as one soup', () => {
    // The grid branch must not be blamed for the flex branch's gap, and the
    // flex branch must still be caught.
    writeFileSync(join(dir, 'cond.tsx'), `
      export const A = ({ c }: { c: boolean }) => (
        <div className={c ? 'flex gap-2' : 'grid gap-2'}>x</div>
      );
    `);
    const { out } = run();
    expect(out).toMatch(/flex \+ gap-\*\s+1 site/);
    rmSync(join(dir, 'cond.tsx'));
  });

  test('catches aspect-* — unsupported until Chromium 88', () => {
    writeFileSync(join(dir, 'aspect.tsx'), `
      export const A = () => <div className="w-full aspect-[3/2]">x</div>;
    `);
    const { out } = run();
    expect(out).toMatch(/aspect-\*\s+1 site/);
    rmSync(join(dir, 'aspect.tsx'));
  });

  test('finds violations in nested directories', () => {
    writeFileSync(join(dir, 'nested', 'deep.tsx'), `
      export const A = () => <div className="inline-flex gap-1">x</div>;
    `);
    const { out } = run();
    expect(out).toMatch(/flex \+ gap-\*\s+1 site/);
    rmSync(join(dir, 'nested', 'deep.tsx'));
  });

  test('report mode exits 0, strict mode exits 1 on the same input', () => {
    writeFileSync(join(dir, 'bad2.tsx'), `
      export const A = () => <div className="flex gap-4">x</div>;
    `);
    expect(run().status).toBe(0);
    const strict = run(['--strict']);
    expect(strict.status).toBe(1);
    expect(strict.out).toContain('FAIL css baseline');
    rmSync(join(dir, 'bad2.tsx'));
  });

  test('a clean tree passes in strict mode', () => {
    writeFileSync(join(dir, 'clean.tsx'), `
      export const A = () => <div className="grid gap-2"><span className="flex items-center">x</span></div>;
    `);
    const { out, status } = run(['--strict']);
    expect(status).toBe(0);
    expect(out).toContain('PASS css baseline');
    rmSync(join(dir, 'clean.tsx'));
  });
});
