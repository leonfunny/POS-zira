import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

/**
 * UX design contract for the dashboard-synced Booking tab.
 * Source-text checks pin behaviors that the spec at
 * docs/superpowers/specs/2026-04-30-booking-tab-ux-design.md commits to
 * - plus the Scope 1b touch keyboard-safety fixes and create-modal
 * picker rewrite (native-only phone keyboard, no native create selects,
 * no editable start-time text field, no huge keyboard padding hack, no
 * backdrop close, dirty guard, no auto-focus on master-data load).
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

  it('routes phone focus through the light focus-scroll handler', () => {
    expect(createSource).toMatch(/inputMode=["']numeric["'][\s\S]*onFocus=\{handleTextFocus\}/);
  });
});

describe('BookingCreateForm controlled create pickers', () => {
  it('does not use native selects for create service/rule/staff fields', () => {
    expect(createSource).not.toContain('<select');
    expect(createSource).toMatch(/function\s+PickerField/);
    expect(createSource).toMatch(/role=["']listbox["']/);
    expect(createSource).toMatch(/aria-haspopup=["']listbox["']/);
  });

  it('does not use an editable start time field', () => {
    expect(createSource).not.toContain('datetime-local');
    expect(createSource).not.toMatch(/type=["']datetime-local["']/);
    expect(createSource).toMatch(/function\s+StartTimeControl/);
    expect(createSource).toMatch(/Today/);
    expect(createSource).toMatch(/Tomorrow/);
    expect(createSource).toMatch(/\+15 min/);
    expect(createSource).toMatch(/-15 min/);
  });

  it('keeps custom picker popovers out of layout flow', () => {
    expect(createSource).toMatch(/absolute left-0 right-0 top-full z-50/);
    expect(createSource).toMatch(/max-h-72 overflow-y-auto/);
    expect(createSource).toMatch(/type=["']search["']/);
  });

  it('still binds staff options to s.user_id || s.id', () => {
    expect(createSource).toMatch(/value:\s*s\.user_id\s*\|\|\s*s\.id/);
  });
});

describe('BookingCreateForm light focus scroll', () => {
  it('owns a body scroll ref so ensureFieldVisible can compute scrollTop', () => {
    expect(createSource).toMatch(/bodyRef\s*=\s*useRef</);
    expect(createSource).toMatch(/ref=\{bodyRef\}/);
  });

  it('uses a computed tail spacer instead of fixed keyboard padding', () => {
    expect(createSource).toMatch(/function\s+ensureFieldVisible/);
    expect(createSource).toMatch(/function\s+computeFocusTailSpacer/);
    expect(createSource).toMatch(/focusTailSpacerRef/);
    expect(createSource).toMatch(/focusTailSpacerPx/);
    expect(createSource).toMatch(/style=\{\{\s*height:\s*focusTailSpacerPx\s*\}\}/);
    expect(createSource).toMatch(/scrollHeight\s*-\s*currentTailSpacerPx/);
    expect(createSource).toMatch(/document\.activeElement\s*!==\s*target/);
    expect(createSource).toMatch(/scheduleEnsureVisible/);
    expect(createSource).toMatch(/setTimeout/);
    expect(createSource).toMatch(/\[\s*250,\s*600,\s*1000\s*\]/);
    expect(createSource).not.toMatch(/keyboardActive/);
    expect(createSource).not.toMatch(/setKeyboardActive/);
    expect(createSource).not.toMatch(/pb-\[420px\]/);
    expect(createSource).not.toMatch(/KEYBOARD_RESERVE_FALLBACK_PX/);
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
    expect(editSource).toMatch(/staffUserId\s*!==\s*originalStaffUserId/);
    expect(editSource).toMatch(/startsAtLocal\s*!==\s*originalStartsAtLocal/);
    expect(editSource).toMatch(/customerNotes\s*!==\s*originalCustomerNotes/);
    expect(editSource).toMatch(/internalNotes\s*!==\s*originalInternalNotes/);
  });

  it('disables Save when nothing changed (canSubmit derived from hasChanges)', () => {
    expect(editSource).toMatch(/hasChanges\s*=\s*Object\.keys\(patch\)\.length\s*>\s*0/);
    expect(editSource).toMatch(/canSubmit\s*=\s*hasChanges/);
  });
});

describe('BookingEditForm touch-safe modal behavior', () => {
  it('uses the same header / scrollable body / sticky footer structure as create', () => {
    expect(editSource).toMatch(/flex flex-col w-full h-full/);
    expect(editSource).toMatch(/ref=\{bodyRef\}/);
    expect(editSource).toMatch(/flex-1 overflow-y-auto/);
    expect(editSource).toMatch(/<footer className="shrink-0 border-t/);
  });

  it('scrolls focused edit fields above the native keyboard', () => {
    expect(editSource).toMatch(/function\s+ensureFieldVisible/);
    expect(editSource).toMatch(/visualViewport/);
    expect(editSource).toMatch(/setTimeout/);
    expect(editSource).toMatch(/,\s*250\s*\)/);
    expect(editSource).toMatch(/,\s*600\s*\)/);
    expect(editSource).toMatch(/pb-\[420px\]/);
    expect(editSource).toMatch(/onFocus=\{handleFieldFocus\}/);
  });

  it('does not close from backdrop clicks or auto-focus the first field', () => {
    expect(editSource).not.toMatch(/onClick=\{safeClose\}/);
    expect(editSource).not.toMatch(/firstFieldRef/);
    expect(editSource).not.toMatch(/\.focus\(\)/);
  });

  it('routes X and Cancel through an in-app dirty discard guard', () => {
    expect(editSource).toMatch(/const\s+isDirty\s*=/);
    expect(editSource).toMatch(/showDiscardConfirm/);
    expect(editSource).toMatch(/function\s+DiscardConfirm/);
    expect(editSource).toMatch(/onClick=\{requestClose\}/);
    expect(editSource).not.toMatch(/window\.confirm\s*\(/);
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
