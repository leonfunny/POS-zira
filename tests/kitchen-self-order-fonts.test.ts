import { existsSync, readFileSync, statSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const css = readFileSync(new URL('../src/renderer/index.css', import.meta.url), 'utf8');
const fontDir = new URL('../src/renderer/fonts/kso/', import.meta.url);

const subsets = ['latin', 'latin-ext', 'vietnamese'] as const;
const fontFiles = [
  ...[500, 600, 700].flatMap((weight) =>
    subsets.map((subset) => `fraunces-${subset}-${weight}-normal.woff2`),
  ),
  ...[500, 600, 700, 800].flatMap((weight) =>
    subsets.map((subset) => `plus-jakarta-sans-${subset}-${weight}-normal.woff2`),
  ),
];

describe('kitchen kiosk fonts are self-hosted', () => {
  it('declares Fraunces and Plus Jakarta Sans via @font-face', () => {
    expect(css).toContain('@font-face');
    expect(css).toMatch(/font-family:\s*['"]Fraunces['"]/);
    expect(css).toMatch(/font-family:\s*['"]Plus Jakarta Sans['"]/);
  });

  it('loads fonts from local fonts/kso assets only, with no CDN, import, or remote URL', () => {
    expect(css).toMatch(/url\(['"]?\.\/fonts\/kso\/[^)]+\.woff2/);
    expect(css).not.toContain('fonts.googleapis.com');
    expect(css).not.toContain('fonts.gstatic.com');
    expect(css).not.toMatch(/@import\s+url\(/);
    expect(css).not.toMatch(/url\(['"]?https?:/);
  });

  it('commits the referenced subset font binaries and license/source notes', () => {
    for (const file of fontFiles) {
      const url = new URL(file, fontDir);
      const bytes = existsSync(url) ? readFileSync(url) : Buffer.from('');

      expect(existsSync(url), `${file} should exist`).toBe(true);
      expect(bytes.subarray(0, 4).toString('latin1'), `${file} should be woff2`).toBe('wOF2');
      expect(statSync(url).size, `${file} should be a real subset font file`).toBeGreaterThan(3_000);
      expect(css).toContain(`./fonts/kso/${file}`);
    }

    expect(existsSync(new URL('LICENSE-OFL.txt', fontDir))).toBe(true);
    expect(existsSync(new URL('SOURCE.txt', fontDir))).toBe(true);
  });

  it('keeps subset font faces explicit so Polish and Vietnamese glyphs do not fall back silently', () => {
    for (const subset of subsets) {
      expect(css).toContain(`${subset}-500-normal.woff2`);
    }

    expect(css).toMatch(/unicode-range:\s*U\+/);
  });
});
