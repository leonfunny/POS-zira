import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

/**
 * UX design contract for the dashboard-synced Booking tab.
 * Source-text checks pin behaviors that the spec at
 * docs/superpowers/specs/2026-04-30-booking-tab-ux-design.md commits to:
 * phone sanitization, action visibility per status, edit-form
 * patch-only behavior, and the missing-fields hint that explains why
 * Create stays disabled.
 */

const todaySource = readFileSync(
  resolve(__dirname, '../src/renderer/components/booking/BookingsTodayScreen.tsx'),
  'utf-8',
);
const createSource = readFileSync(
  resolve(__dirname, '../src/renderer/components/booking/BookingCreateForm.tsx'),
  'utf-8',
);
const editSource = readFileSync(
  resolve(__dirname, '../src/renderer/components/booking/BookingEditForm.tsx'),
  'utf-8',
);

describe('BookingCreateForm phone sanitization', () => {
  it('strips alphabetic characters via a sanitizePhone helper', () => {
    // The helper drops anything that isn't digits or +/-/space/parens.
    // The regex literal must remain so paste-via-typing flows go
    // through it — without this guard a paste of "+48 600 abc 123"
    // would land alphabetic characters in state.
    expect(createSource).toMatch(/function\s+sanitizePhone/);
    expect(createSource).toMatch(/replace\(\s*\/\[\^[^/]*0-9[^/]*\]/);
  });

  it('runs onChange through sanitizePhone', () => {
    expect(createSource).toMatch(
      /setCustomerPhone\(\s*sanitizePhone\(\s*e\.target\.value/,
    );
  });

  it('handles paste via onPaste so multi-char alphabetic content cannot land', () => {
    // onChange alone cannot block a paste that the input element
    // accepts at IME level, so the paste handler intercepts and
    // sanitizes before commit.
    expect(createSource).toMatch(/onPaste/);
    expect(createSource).toMatch(/clipboardData/);
  });

  it('uses inputMode="tel" so the on-screen keyboard offers digits', () => {
    expect(createSource).toMatch(/inputMode=["']tel["']/);
  });
});

describe('BookingCreateForm missing-required hint', () => {
  it('exposes a missingFields list driving the inline hint copy', () => {
    // The disabled-state hint must explain *which* fields are still
    // required, not leave the cashier guessing at a mute button.
    expect(createSource).toMatch(/missingFields/);
    expect(createSource).toMatch(/missingFields\.join/);
  });
});

describe('BookingsTodayScreen status-aware actions', () => {
  it('groups statuses into ACTIVE / TERMINAL sets so terminal rows hide actions', () => {
    expect(todaySource).toMatch(/ACTIVE_STATUSES/);
    expect(todaySource).toMatch(/TERMINAL_STATUSES/);
  });

  it('shows Check in only for BOOKED/PENDING and Complete only for CHECKED_IN/IN_SERVICE', () => {
    expect(todaySource).toMatch(/canCheckIn\s*=\s*row\.status\s*===\s*'BOOKED'\s*\|\|\s*row\.status\s*===\s*'PENDING'/);
    expect(todaySource).toMatch(/canComplete\s*=\s*row\.status\s*===\s*'CHECKED_IN'\s*\|\|\s*row\.status\s*===\s*'IN_SERVICE'/);
  });

  it('hides Cancel for terminal statuses (CANCELLED / NO_SHOW / PAID)', () => {
    expect(todaySource).toMatch(/row\.status\s*!==\s*'CANCELLED'/);
    expect(todaySource).toMatch(/row\.status\s*!==\s*'NO_SHOW'/);
    expect(todaySource).toMatch(/row\.status\s*!==\s*'PAID'/);
  });

  it('renders a status badge with text + icon, not color alone', () => {
    // statusMeta returns { label, className, Icon } so the badge has a
    // readable label even for users who can't distinguish colors.
    expect(todaySource).toMatch(/function\s+statusMeta/);
    expect(todaySource).toMatch(/Icon:\s*\w+/);
    expect(todaySource).toMatch(/label:\s*label\(/);
  });

  it('derives summary counts from already-loaded rows (no extra fetching)', () => {
    expect(todaySource).toMatch(/function\s+deriveCounts/);
    expect(todaySource).toMatch(/SummaryStrip/);
  });
});

describe('BookingEditForm patch-only behavior', () => {
  it('only adds fields to the patch when the user actually changed them', () => {
    expect(editSource).toMatch(/staffUserId\s*!==\s*booking\.staff_user_id/);
    expect(editSource).toMatch(/customerNotes\s*!==\s*\(booking\.customer_notes/);
    expect(editSource).toMatch(/internalNotes\s*!==\s*\(booking\.internal_notes/);
  });

  it('disables Save when nothing changed (canSubmit derived from hasChanges)', () => {
    expect(editSource).toMatch(/hasChanges\s*=\s*Object\.keys\(patch\)\.length\s*>\s*0/);
    expect(editSource).toMatch(/canSubmit\s*=\s*hasChanges/);
  });
});

describe('Booking modals accessibility', () => {
  it('all three components mark the dialog with role + aria-modal', () => {
    for (const src of [createSource, editSource, todaySource]) {
      expect(src).toMatch(/role=["']dialog["']/);
      expect(src).toMatch(/aria-modal=["']true["']/);
    }
  });

  it('error banners use role="alert" so screen readers announce them', () => {
    expect(createSource).toMatch(/role=["']alert["']/);
    expect(editSource).toMatch(/role=["']alert["']/);
    expect(todaySource).toMatch(/role=["']alert["']/);
  });
});
