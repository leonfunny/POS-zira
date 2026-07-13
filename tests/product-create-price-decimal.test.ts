import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { sanitizeDecimalText } from '../src/renderer/components/products/decimal-input';

const root = resolve(__dirname, '..');
const source = (path: string): string =>
  readFileSync(resolve(root, path), 'utf8').replace(/\r\n/g, '\n');

const CREATE = source('src/renderer/components/products/ProductCreateDialog.tsx');

// The POS touch keyboard appends characters through the native value setter.
// <input type="number"> runs the HTML number sanitizer on assignment, and the
// intermediate state "21." is not a valid floating-point string — the field
// silently becomes "" and the decimal separator looks dead at the till.
describe('create-dialog price fields work with the touch keyboard', () => {
  it('no price input is type="number" (number inputs sanitize "21." to empty)', () => {
    expect(CREATE).not.toContain('type="number"');
  });

  it('price inputs stay decimal-mode text and run the sanitizer', () => {
    expect(CREATE).toContain("import { sanitizeDecimalText } from './decimal-input'");
    expect(CREATE.match(/sanitizeDecimalText\(/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
    expect(CREATE.match(/inputMode="decimal"/g)?.length ?? 0).toBeGreaterThanOrEqual(3);
  });
});

describe('sanitizeDecimalText', () => {
  it('keeps digits and one dot', () => {
    expect(sanitizeDecimalText('21.50')).toBe('21.50');
  });
  it('keeps digits and one comma', () => {
    expect(sanitizeDecimalText('21,50')).toBe('21,50');
  });
  it('drops a second separator', () => {
    expect(sanitizeDecimalText('21.5.0')).toBe('21.50');
  });
  it('drops letters and spaces', () => {
    expect(sanitizeDecimalText('2a1 .5')).toBe('21.5');
  });
  it('allows a leading separator while typing', () => {
    expect(sanitizeDecimalText('.5')).toBe('.5');
  });
  it('keeps empty input empty', () => {
    expect(sanitizeDecimalText('')).toBe('');
  });
});
