import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

/**
 * UX design contract for the dashboard-synced Booking tab.
 * Source-text checks pin behaviors that the spec at
 * docs/superpowers/specs/2026-04-30-booking-tab-ux-design.md commits to:
 * digits-only phone input, in-app numeric keypad, action visibility per
 * status, edit-form patch-only behavior, and the missing-fields hint
 * that explains why Create stays disabled.
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
    // Product decision (Scope 1): the stored phone is digits only — no
    // `+`, no spaces, no dashes. The regex literal must remain so any
    // future refactor cannot silently re-introduce formatting.
    expect(createSource).toMatch(/function\s+sanitizePhone/);
    expect(createSource).toMatch(/replace\(\s*\/\\D\/g/);
  });

  it('runs onChange through sanitizePhone', () => {
    expect(createSource).toMatch(
      /setCustomerPhone\(\s*sanitizePhone\(\s*e\.target\.value/,
    );
  });

  it('intercepts paste so formatted clipboard content is sanitized before state', () => {
    // The paste handler must preventDefault and pipe through
    // sanitizePhone — without this, pasting "+48 600 123-456" would
    // briefly land in the input value before onChange strips it,
    // and any IME composition could leak letters into state.
    expect(createSource).toMatch(/onPaste/);
    expect(createSource).toMatch(/e\.preventDefault\(\)/);
    expect(createSource).toMatch(/clipboardData\.getData/);
  });

  it('blocks alphabetic input at the input-event level via onBeforeInput', () => {
    // Belt-and-braces against virtual keyboards (Windows touch
    // keyboard QWERTY) and IME composition: preventDefault on
    // onBeforeInput when the inserted data contains non-digits.
    expect(createSource).toMatch(/onBeforeInput/);
    expect(createSource).toMatch(/InputEvent/);
    expect(createSource).toMatch(/\/\\D\/\.test/);
  });

  it('declares numeric input attributes so native keyboards offer digits first', () => {
    expect(createSource).toMatch(/inputMode=["']numeric["']/);
    expect(createSource).toMatch(/pattern=["']\[0-9\]\*["']/);
    expect(createSource).toMatch(/autoComplete=["']tel["']/);
    // type=tel keeps the semantic role intact (autofill, etc.).
    expect(createSource).toMatch(/type=["']tel["']/);
  });
});

describe('BookingCreateForm in-app numeric keypad', () => {
  it('renders a NumericKeypad component while the phone field is focused', () => {
    expect(createSource).toMatch(/function\s+NumericKeypad/);
    expect(createSource).toMatch(/phoneFocused\s*&&/);
    expect(createSource).toMatch(/<NumericKeypad/);
  });

  it('exposes digit / backspace / clear / done handlers to the keypad', () => {
    expect(createSource).toMatch(/appendDigit/);
    expect(createSource).toMatch(/backspacePhone/);
    expect(createSource).toMatch(/clearPhone/);
    expect(createSource).toMatch(/dismissKeypad/);
  });

  it('keypad buttons preventDefault on mouseDown so taps do not blur the input', () => {
    // Without onMouseDown preventDefault, tapping a digit blurs the
    // phone input → the keypad re-closes on every tap.
    expect(createSource).toMatch(/onMouseDown=\{\(e\)\s*=>\s*e\.preventDefault\(\)/);
  });

  it('keypad container is tagged so the input blur handler can detect it', () => {
    // The phone input's onBlur checks relatedTarget for this attribute
    // to keep the keypad open while the user moves between buttons.
    expect(createSource).toMatch(/data-numeric-keypad/);
  });
});

describe('BookingCreateForm keyboard-safe layout', () => {
  it('uses a flex column with a scrollable body so sticky header/footer remain visible', () => {
    expect(createSource).toMatch(/flex\s+flex-col/);
    expect(createSource).toMatch(/overflow-y-auto/);
  });

  it('inputs scroll the focused field into view to dodge the on-screen keyboard', () => {
    expect(createSource).toMatch(/function\s+scrollFocusedIntoView/);
    expect(createSource).toMatch(/scrollIntoView\(\s*\{\s*block:\s*['"]center['"]/);
  });

  it('submit footer is sticky/structured separately so it stays reachable', () => {
    // The footer lives in its own <footer> with shrink-0 so the
    // scrollable body can grow without pushing the action group off
    // screen.
    expect(createSource).toMatch(/<footer[^>]*shrink-0/);
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

  it('numeric keypad buttons each carry an explicit aria-label', () => {
    expect(createSource).toMatch(/ariaLabel/);
    expect(createSource).toMatch(/aria-label=\{ariaLabel\}/);
  });
});
