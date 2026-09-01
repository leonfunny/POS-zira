import { afterEach, describe, expect, it, vi } from 'vitest';

import { createRawPrintTempFilePath } from '../src/main/hardware/windows-raw-print';

describe('raw print staging paths', () => {
  afterEach(() => vi.restoreAllMocks());

  it('stays unique when concurrent jobs start in the same process and millisecond', () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_788_257_338_000);

    const first = createRawPrintTempFilePath('zira_tspl');
    const second = createRawPrintTempFilePath('zira_tspl');

    expect(first).not.toBe(second);
    expect(first).toMatch(/zira_tspl_/);
    expect(second).toMatch(/zira_tspl_/);
  });

  it('keeps an untrusted prefix inside a filename', () => {
    const result = createRawPrintTempFilePath('../outside/path');
    expect(result).not.toContain('../outside/path');
    expect(result).toContain('.._outside_path');
  });
});
