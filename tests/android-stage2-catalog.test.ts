import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, test } from 'vitest';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

async function source(path: string) {
  return readFile(resolve(ROOT, path), 'utf8');
}

describe('Android Stage 2 synthetic catalog', () => {
  test('renders only embedded demo records and keeps checkout locked', async () => {
    const html = await source('src/renderer/android-pos/index.html');
    const records = [...html.matchAll(/data-synthetic-record="(DEMO-\d{3})"/g)].map((match) => match[1]);

    expect(records).toEqual(['DEMO-001', 'DEMO-002', 'DEMO-003', 'DEMO-004', 'DEMO-005', 'DEMO-006']);
    expect(html).toContain('data-mode="synthetic-read-only"');
    expect(html).toContain('role="radiogroup" aria-label="Lọc danh mục mẫu"');
    expect(html).toContain('id="checkout-lock" type="button" disabled');
    expect(html).toContain('Không đăng nhập · Không API · Không fiscal · Không in');
    expect(html).not.toMatch(/<form\b/i);
    expect(html).not.toMatch(/https?:\/\//i);
  });

  test('publishes fail-closed runtime metadata', async () => {
    const runtime = await source('src/renderer/android-pos/main.ts');

    expect(runtime).toContain("mode: 'SYNTHETIC_READ_ONLY'");
    expect(runtime).toContain("dataSource: 'EMBEDDED_DEMO_RECORDS'");
    expect(runtime).toContain('checkoutEnabled: false');
    expect(runtime).toContain('writesEnabled: false');
    expect(runtime).toContain('networkEnabled: false');
  });
});
