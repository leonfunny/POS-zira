import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';

const css = readFileSync(new URL('../src/renderer/index.css', import.meta.url), 'utf8');
const tailwind = readFileSync(new URL('../tailwind.config.js', import.meta.url), 'utf8');
const posLayout = readFileSync(new URL('../src/renderer/components/pos/POSLayout.tsx', import.meta.url), 'utf8');
const fontRoot = new URL('../src/renderer/fonts/kso/', import.meta.url);

function plusJakartaFaces(): string[] {
  return css.match(/@font-face\s*\{[^}]*font-family:\s*['"]Plus Jakarta Sans['"][^}]*\}/gs) ?? [];
}

describe('POS self-hosted font parity', () => {
  test('scopes offline Plus Jakarta Sans to both stable POSLayout roots only', () => {
    expect(css).toMatch(/\.zira-pos-layout-root\s*\{[^}]*font-family:\s*"Plus Jakarta Sans"/s);
    expect(posLayout.match(/zira-pos-layout-root/g)).toHaveLength(2);
    expect(posLayout).toContain('zira-pos-layout-root min-h-screen');
    expect(posLayout).toContain("zira-pos-layout-root ${embedded ? 'h-full' : 'h-screen'}");
    expect(css).not.toMatch(/(?:fonts\.googleapis\.com|fonts\.gstatic\.com|@import\s+url|url\(['"]?https?:)/);
  });

  test('leaves global renderer and Tailwind typography exactly on the baseline stack', () => {
    expect(css).toMatch(/body\s*\{[^}]*font-family:\s*"Bahnschrift",\s*"Segoe UI Variable Text",\s*"Segoe UI",\s*Tahoma,\s*sans-serif/s);
    expect(tailwind).toContain("sans: ['\"Bahnschrift\"', '\"Segoe UI Variable Text\"', '\"Segoe UI\"', 'Tahoma', 'sans-serif']");
    expect(tailwind).not.toMatch(/sans:\s*\[[^\]]*Plus Jakarta Sans/);
  });

  test('maps normal 400 explicitly to the bundled static 500 outlines for every subset', () => {
    const normalFaces = plusJakartaFaces().filter((face) => /font-weight:\s*400/.test(face));
    expect(normalFaces).toHaveLength(3);

    for (const subset of ['latin', 'latin-ext', 'vietnamese']) {
      const source = `plus-jakarta-sans-${subset}-500-normal.woff2`;
      const face = normalFaces.find((candidate) => candidate.includes(source));
      expect(face, `missing explicit 400 mapping for ${subset}`).toBeTruthy();
      expect(face).toMatch(/font-style:\s*normal/);
      expect(face).toMatch(/font-display:\s*swap/);
      expect(face).toMatch(/unicode-range:\s*U\+/);
      expect(existsSync(new URL(source, fontRoot)), `${source} must remain local`).toBe(true);
    }
  });

  test('pins Polish and Vietnamese coverage at every shipped operational weight', () => {
    const faces = plusJakartaFaces();
    for (const weight of [500, 600, 700, 800]) {
      for (const subset of ['latin', 'latin-ext', 'vietnamese']) {
        const source = `plus-jakarta-sans-${subset}-${weight}-normal.woff2`;
        expect(faces.some((face) => face.includes(source) && new RegExp(`font-weight:\\s*${weight}`).test(face)),
          `missing ${subset} ${weight} face`).toBe(true);
        expect(existsSync(new URL(source, fontRoot)), `${source} must exist`).toBe(true);
      }
    }
  });

  test('preserves scoped KSO Fraunces display typography and the existing display stack', () => {
    expect(css).toContain("--kso-serif: 'Fraunces'");
    expect(css).toContain("--kso-sans: 'Plus Jakarta Sans'");
    expect(tailwind).toContain("display: ['\"Sitka Display\"', '\"Bahnschrift\"', '\"Segoe UI\"', 'Tahoma', 'sans-serif']");
  });
});
