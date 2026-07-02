import { describe, expect, it } from 'vitest';
import { matchesSettingSection } from '../src/renderer/components/settings-search';

describe('matchesSettingSection', () => {
  it('matches empty queries so sections stay visible by default', () => {
    expect(matchesSettingSection('', 'Printer settings')).toBe(true);
    expect(matchesSettingSection('   ', 'Printer settings')).toBe(true);
  });

  it('matches case-insensitively', () => {
    expect(matchesSettingSection('PRINTER', 'Fiscal printer detection')).toBe(true);
    expect(matchesSettingSection('receipt', 'Receipt Header')).toBe(true);
  });

  it('matches without diacritics', () => {
    expect(matchesSettingSection('may in', 'máy in')).toBe(true);
    expect(matchesSettingSection('sao luu', 'Sao lưu dữ liệu')).toBe(true);
  });

  it('does not match unrelated text', () => {
    expect(matchesSettingSection('telegram', 'Fiscal printer detection')).toBe(false);
  });
});
