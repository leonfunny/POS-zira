import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const css = readFileSync(new URL('../src/renderer/index.css', import.meta.url), 'utf8');
const app = readFileSync(new URL('../src/renderer/windows/kitchen-self-order/KitchenSelfOrderApp.tsx', import.meta.url), 'utf8');

describe('kitchen kiosk warm theme tokens', () => {
  it('defines warm tokens and derives accent shades from the brand accent', () => {
    expect(css).toContain('--kso-canvas');
    expect(css).toContain('--kso-surface');
    expect(css).toContain('--kso-serif');
    expect(css).toMatch(/--kso-accent-deep:\s*color-mix\(in srgb, var\(--kso-accent\)/);
    expect(css).toMatch(/--kso-accent-soft:\s*color-mix\(in srgb, var\(--kso-accent\)/);

    const shellBlock = css.match(/\.kso-shell\s*\{[\s\S]*?\n\}/)?.[0] ?? '';
    expect(shellBlock).not.toContain('radial-gradient');
  });

  it('keeps the accent driven by brand config (inline --kso-accent), not hardcoded', () => {
    expect(app).toMatch(/--kso-accent['"]?\s*:\s*[^,]*brand[^,]*accentColor/);
  });
});
