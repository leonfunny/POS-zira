import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

/**
 * UX design contract for the dashboard-synced Booking tab.
 * Source-text checks pin behaviors that the spec at
 * docs/superpowers/specs/2026-04-30-booking-tab-ux-design.md commits to
 * — plus the Scope 1b touch keyboard-safety fixes (native-only phone
 * keyboard, keyboard-aware focus scroll, no backdrop close, dirty guard,
 * no auto-focus on master-data load).
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

describe('BookingCreateForm phone is digits-only', () => {
  it('sanitizePhone strips every non-digit via /\\D/g', () => {
    // Product decision: the stored phone is digits only — no `+`, no
    // spaces, no dashes. The regex literal must remain so any future
    // refactor cannot silently re-introduce formatting.
    expect(createSource).toMatch(/function\s+sanitizePhone/);
    expect(createSource).toMatch(/replace\(\s*\/\\D\/g/);
  });

  it('runs onChange through sanitizePhone', () => {
    expect(createSource).toMatch(
      /setCustomerPhone\(\s*sanitizePhone\(\s*e\.target\.value/,
    );
  });

  it('intercepts paste so formatted clipboard content is sanitized before state', () => {
    expect(createSource).toMatch(/onPaste/);
    expect(createSource).toMatch(/e\.preventDefault\(\)/);
    expect(createSource).toMatch(/clipboardData\.getData/);
  });

  it('blocks alphabetic input at the input-event level via onBeforeInput', () => {
    expect(createSource).toMatch(/onBeforeInput/);
    expect(createSource).toMatch(/InputEvent/);
    expect(createSource).toMatch(/\/\\D\/\.test/);
  });

  it('blocks letter keys from a physical keyboard via onKeyDown', () => {
    // Keyboard layout hints are not validation. A USB or Bluetooth
    // keyboard still fires keydown, so the form must explicitly reject
    // letter keypresses.
    expect(createSource).toMatch(/onKeyDown/);
    expect(createSource).toMatch(/\^\\d\$/);
  });
});

describe('BookingCreateForm uses one keyboard only (native-only)', () => {
  it('declares native phone keyboard hints on the phone input', () => {
    expect(createSource).toMatch(/type=["']tel["']/);
    expect(createSource).toMatch(/inputMode=["']numeric["']/);
    expect(createSource).toMatch(/pattern=["']\[0-9\]\*["']/);
    expect(createSource).toMatch(/autoComplete=["']tel["']/);
    expect(createSource).not.toMatch(/inputMode=["']none["']/);
  });

  it('does not render or retain a custom numeric keypad', () => {
    for (const marker of [
      'Numeric' + 'Keypad',
      'Keypad' + 'Button',
      'data-numeric-' + 'keypad',
      'append' + 'Digit',
      'backspace' + 'Phone',
      'clear' + 'Phone',
      'dismiss' + 'Keypad',
    ]) {
      expect(createSource).not.toContain(marker);
    }
  });

  it('keeps the action footer always rendered instead of replacing it with a keypad', () => {
    const phoneFocusState = 'phone' + 'Focused';
    expect(createSource).toMatch(/<footer className="shrink-0 border-t/);
    expect(createSource).not.toContain(phoneFocusState);
    expect(createSource).not.toMatch(new RegExp(`${phoneFocusState}\\s*\\?`));
  });

  it('routes phone focus through the keyboard-aware scroll handler', () => {
    expect(createSource).toMatch(/inputMode=["']numeric["'][\s\S]*onFocus=\{handleTextFocus\}/);
    expect(createSource).toMatch(/inputMode=["']numeric["'][\s\S]*onBlur=\{handleTextBlur\}/);
  });
});

describe('BookingCreateForm keyboard-aware focus scroll', () => {
  it('owns a body scroll ref so ensureFieldVisible can compute scrollTop', () => {
    expect(createSource).toMatch(/bodyRef\s*=\s*useRef</);
    expect(createSource).toMatch(/ref=\{bodyRef\}/);
  });

  it('uses visualViewport when available and a 380px reserve fallback', () => {
    expect(createSource).toMatch(/visualViewport/);
    expect(createSource).toMatch(/KEYBOARD_RESERVE_FALLBACK_PX/);
  });

  it('schedules ensureFieldVisible at 0/250/600ms to ride the keyboard reveal', () => {
    expect(createSource).toMatch(/function\s+ensureFieldVisible/);
    expect(createSource).toMatch(/scheduleEnsureVisible/);
    expect(createSource).toMatch(/setTimeout/);
    expect(createSource).toMatch(/,\s*250\s*\)/);
    expect(createSource).toMatch(/,\s*600\s*\)/);
  });

  it('grows the body bottom padding while a keyboard-relevant field is focused', () => {
    // Dynamic padding keeps Notes scrollable above the on-screen
    // keyboard.
    expect(createSource).toMatch(/keyboardActive/);
    expect(createSource).toMatch(/setKeyboardActive/);
    expect(createSource).toMatch(/pb-\[420px\]/);
  });
});

describe('BookingCreateForm close discipline', () => {
  it('does not bind onClick to the backdrop overlay', () => {
    // A stray tap on the dimmed backdrop used to wipe the entire form.
    // Closing now goes only through the explicit X / Cancel control.
    expect(createSource).not.toMatch(/role=["']dialog["'][^>]*onClick=\{safeClose\}/);
    expect(createSource).not.toMatch(/onClick=\{safeClose\}/);
  });

  it('renders an in-app DiscardConfirm modal instead of window.confirm', () => {
    expect(createSource).toMatch(/function\s+DiscardConfirm/);
    expect(createSource).toMatch(/showDiscardConfirm/);
    expect(createSource).not.toMatch(/window\.confirm\s*\(/);
    expect(createSource).not.toMatch(/window\.prompt\s*\(/);
    expect(createSource).not.toMatch(/window\.alert\s*\(/);
  });

  it('captures the initial start time so a default-only form is not dirty', () => {
    expect(createSource).toMatch(/initialStartsAtRef\s*=\s*useRef/);
    expect(createSource).toMatch(/startsAtLocal\s*!==\s*initialStartsAtRef\.current/);
  });

  it('exposes an isDirty derivation covering every user-entered field', () => {
    expect(createSource).toMatch(/isDirty\s*=/);
    expect(createSource).toMatch(/customerPhone\s*!==\s*['"]{2}/);
    expect(createSource).toMatch(/customerName\s*!==\s*['"]{2}/);
    expect(createSource).toMatch(/customerNotes\s*!==\s*['"]{2}/);
  });

  it('routes X / Cancel through requestClose (which honours the dirty guard)', () => {
    expect(createSource).toMatch(/function[\s\S]*requestClose|const\s+requestClose/);
    expect(createSource).toMatch(/onClick=\{requestClose\}/);
  });
});

describe('BookingCreateForm no automatic focus', () => {
  it('does not call firstFieldRef.current?.focus() in any effect', () => {
    // Auto-focusing service after master data load would steal focus
    // mid-tap on touch viewports and pop the wrong keyboard layout.
    expect(createSource).not.toMatch(/firstFieldRef\.current\?\.focus\(\)/);
  });
});

describe('BookingCreateForm missing-required hint', () => {
  it('exposes a missingFields list driving the inline hint copy', () => {
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
    expect(todaySource).toMatch(/function\s+statusMeta/);
    expect(todaySource).toMatch(/Icon:\s*\w+/);
    expect(todaySource).toMatch(/label:\s*label\(/);
  });

  it('derives summary counts from already-loaded rows (no extra fetching)', () => {
    expect(todaySource).toMatch(/function\s+deriveCounts/);
    expect(todaySource).toMatch(/SummaryStrip/);
  });

  it('renders compact metric tiles instead of a flat summary text strip', () => {
    expect(todaySource).toMatch(/grid-cols-2/);
    expect(todaySource).toMatch(/md:grid-cols-5/);
    expect(todaySource).toMatch(/min-h-\[56px\]/);
  });

  it('empty state includes a clear New walk-in CTA', () => {
    expect(todaySource).toMatch(/function\s+EmptyState/);
    expect(todaySource).toMatch(/No appointments today/);
    expect(todaySource).toMatch(/New walk-in/);
    expect(todaySource).toMatch(/onCreate/);
  });

  it('booking rows wrap actions for touch viewports instead of requiring a fixed desktop width', () => {
    expect(todaySource).toMatch(/flex-wrap/);
    expect(todaySource).toMatch(/xl:grid-cols/);
    expect(todaySource).not.toMatch(/min-w-\[300px\]/);
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

  it('create form icon-only close control carries an explicit aria-label', () => {
    expect(createSource).toMatch(/aria-label=\{label\('common\.close', 'Close'\)\}/);
  });
});
