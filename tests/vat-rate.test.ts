/**
 * VAT 0% must survive.
 *
 * Every VAT mapping in this codebase used to end in `|| 23`. In JavaScript `||`
 * treats the number 0 exactly like null, so a genuine 0% rate silently became
 * 23% — the intent was only "if we cannot read a rate, assume the standard one",
 * but `||` cannot tell "unknown" from "known to be zero".
 *
 * 0% is a real Polish rate (exports, intra-EU supply), Poland applied it to
 * basic foodstuffs for two years running, and the product dialogs offer it as a
 * first-class choice. A wrong rate does not merely misprice a line — it
 * misstates the tax on a receipt already handed to a customer.
 */
import { describe, expect, test } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { normalizeVatRate, DEFAULT_VAT_RATE } from '../src/shared/pos/vat-rate';
import { toVatRate } from '../src/main/sync/pos-order-adapter';

describe('normalizeVatRate', () => {
  test('KEEPS A GENUINE ZERO — the whole point', () => {
    expect(normalizeVatRate(0)).toBe(0);
    expect(normalizeVatRate('0')).toBe(0);
    expect(normalizeVatRate('0.00')).toBe(0);
  });

  test('keeps every ordinary rate', () => {
    expect(normalizeVatRate(23)).toBe(23);
    expect(normalizeVatRate('8')).toBe(8);
    expect(normalizeVatRate('5.00')).toBe(5);
    // Rates from imported / foreign catalogues must pass through untouched too.
    expect(normalizeVatRate('21')).toBe(21);
    expect(normalizeVatRate(10)).toBe(10);
  });

  test('falls back only when the rate is genuinely unreadable', () => {
    expect(normalizeVatRate(null)).toBe(DEFAULT_VAT_RATE);
    expect(normalizeVatRate(undefined)).toBe(DEFAULT_VAT_RATE);
    expect(normalizeVatRate('')).toBe(DEFAULT_VAT_RATE);
    expect(normalizeVatRate('abc')).toBe(DEFAULT_VAT_RATE);
    expect(normalizeVatRate(Number.NaN)).toBe(DEFAULT_VAT_RATE);
    expect(normalizeVatRate(Number.POSITIVE_INFINITY)).toBe(DEFAULT_VAT_RATE);
  });

  test('a negative rate is not "readable" — it is nonsense', () => {
    // Reading -5 as valid is the same class of mistake as reading 0 as missing.
    expect(normalizeVatRate(-5)).toBe(DEFAULT_VAT_RATE);
    expect(normalizeVatRate('-0.01')).toBe(DEFAULT_VAT_RATE);
  });

  test('an explicit fallback is honoured, including a zero fallback', () => {
    expect(normalizeVatRate(null, 8)).toBe(8);
    expect(normalizeVatRate('nope', 0)).toBe(0);
  });
});

describe('the Windows order adapter shares the same rule', () => {
  test('toVatRate preserves 0 and still honours its explicit fallback', () => {
    expect(toVatRate(0, 23)).toBe(0);
    expect(toVatRate('0', 23)).toBe(0);
    expect(toVatRate(null, 8)).toBe(8);
    expect(toVatRate('abc', 5)).toBe(5);
  });
});

describe('anti-rot: no VAT mapping may reintroduce the `|| 23` trap', () => {
  const SRC = join(__dirname, '..', 'src');
  const NORMALIZER = join('shared', 'pos', 'vat-rate.ts');

  /** Every .ts/.tsx file under src, walked without a shell. */
  function sourceFiles(dir: string, out: string[] = []): string[] {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) sourceFiles(full, out);
      else if (/\.tsx?$/.test(entry)) out.push(full);
    }
    return out;
  }

  /** `|| 23` occurrences outside comments. */
  function offendingLines(file: string): string[] {
    return readFileSync(file, 'utf8')
      .split('\n')
      .map((line, i) => ({ line, at: `${file}:${i + 1}` }))
      .filter(({ line }) => new RegExp(`\\|\\|\\s*${DEFAULT_VAT_RATE}\\b`).test(line))
      // Prose that names the old pattern is documentation, not an instance.
      .filter(({ line }) => !/^\s*(\/\/|\*|\/\*)/.test(line))
      .map(({ at, line }) => `${at}  ${line.trim()}`);
  }

  test('the pattern is gone from every source file', () => {
    // Scanned as a tree, not as a list of known files: the bug reached nine
    // sites across both platforms precisely because each was written by hand.
    // Reintroducing it anywhere fails, including in a file that does not exist
    // yet.
    const hits = sourceFiles(SRC)
      .filter((f) => !f.endsWith(NORMALIZER))
      .flatMap(offendingLines);

    expect(
      hits,
      `These fall back to ${DEFAULT_VAT_RATE} with \`||\`, which eats a legitimate 0% rate.\n` +
        `Use normalizeVatRate() from src/shared/pos/vat-rate.ts:\n  ${hits.join('\n  ')}`,
    ).toEqual([]);
  });

  test('the scan is not vacuous — it reads real files and can match', () => {
    const files = sourceFiles(SRC);
    expect(files.length, 'the walker found no source files at all').toBeGreaterThan(100);
    // A synthetic line that SHOULD be caught, proving the regex fires.
    const probe = ['vat_rate: Number(x) || 23,', '// mentions || 23 in prose'];
    const caught = probe.filter((line) => new RegExp(`\\|\\|\\s*${DEFAULT_VAT_RATE}\\b`).test(line)
      && !/^\s*(\/\/|\*|\/\*)/.test(line));
    expect(caught).toEqual(['vat_rate: Number(x) || 23,']);
  });
});
