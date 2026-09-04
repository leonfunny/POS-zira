import { describe, expect, it } from 'vitest';
import {
  formatIsoDate,
  monthCells,
  monthTitle,
  parseIsoDate,
  shiftMonth,
  weekdayLabels,
} from '../src/shared/calendar';

describe('the order-date calendar speaks the app language', () => {
  it('reads day/month/year the way each language writes it', () => {
    expect(formatIsoDate('2026-09-04', 'vi')).toBe('04/09/2026');
    expect(formatIsoDate('2026-09-04', 'pl')).toBe('04.09.2026');
    expect(formatIsoDate('2026-09-04', 'en')).toBe('04/09/2026');
  });

  it('shows nothing for a blank or broken date rather than "Invalid Date"', () => {
    expect(formatIsoDate('', 'vi')).toBe('');
    expect(formatIsoDate('2026-02-31', 'vi')).toBe('');
    expect(formatIsoDate('04/09/2026', 'vi')).toBe('');
    expect(parseIsoDate(null)).toBeNull();
  });

  it('names the month in the app language', () => {
    expect(monthTitle(2026, 9, 'vi').toLowerCase()).toContain('tháng 9');
    expect(monthTitle(2026, 9, 'pl').toLowerCase()).toContain('wrzesień');
    expect(monthTitle(2026, 9, 'en')).toBe('September 2026');
  });

  it('starts the week on Monday in every language', () => {
    expect(weekdayLabels('en')[0]).toBe('Mon');
    expect(weekdayLabels('pl')[0].toLowerCase()).toContain('pon');
    expect(weekdayLabels('vi')[0]).toContain('2');
    expect(weekdayLabels('vi')).toHaveLength(7);
  });

  it('lays September 2026 out from Monday the 31st of August', () => {
    const cells = monthCells(2026, 9);
    expect(cells).toHaveLength(42);
    expect(cells[0]).toEqual({ iso: '2026-08-31', day: 31, inMonth: false });
    expect(cells[1]).toEqual({ iso: '2026-09-01', day: 1, inMonth: true });
    expect(cells.filter((cell) => cell.inMonth)).toHaveLength(30);
  });

  it('rolls the year over when stepping past December or before January', () => {
    expect(shiftMonth(2026, 12, 1)).toEqual({ year: 2027, month: 1 });
    expect(shiftMonth(2026, 1, -1)).toEqual({ year: 2025, month: 12 });
  });
});
