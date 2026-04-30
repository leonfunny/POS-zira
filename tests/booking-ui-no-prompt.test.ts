import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

/**
 * Regression: BookingsTodayScreen.tsx must not call window.prompt /
 * window.alert / window.confirm. The Electron renderer this app ships
 * in throws "prompt() is not supported", which silently breaks the
 * cancel button and leaves bookings stuck. Use a controlled in-app
 * modal instead.
 */
describe('BookingsTodayScreen.tsx renderer guards', () => {
  const source = readFileSync(
    resolve(__dirname, '../src/renderer/components/booking/BookingsTodayScreen.tsx'),
    'utf-8',
  );

  it('does not call window.prompt(', () => {
    expect(source).not.toMatch(/\bwindow\.prompt\s*\(/);
  });

  it('does not call window.alert(', () => {
    expect(source).not.toMatch(/\bwindow\.alert\s*\(/);
  });

  it('does not call window.confirm(', () => {
    expect(source).not.toMatch(/\bwindow\.confirm\s*\(/);
  });

  it('uses a controlled cancel modal (cancelTarget state)', () => {
    expect(source).toMatch(/setCancelTarget\b/);
    expect(source).toMatch(/setCancelReason\b/);
  });
});
