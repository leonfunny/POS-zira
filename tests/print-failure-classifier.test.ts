import { describe, expect, it } from 'vitest';
import {
  classifyPrintFailureAfterDriverCall,
  getExplicitPrintFailureClass,
} from '../src/main/printing/print-failure-classifier';

function classifiedError(
  failureClass: 'SAFE_BEFORE_PRINT' | 'UNCERTAIN_AFTER_PRINT' | 'FINAL',
  message = 'driver failure',
): Error & { failureClass: typeof failureClass } {
  return Object.assign(new Error(message), { failureClass });
}

describe('print failure classifier', () => {
  it.each([
    'SAFE_BEFORE_PRINT',
    'UNCERTAIN_AFTER_PRINT',
    'FINAL',
  ] as const)('honors an explicit %s classification', (failureClass) => {
    const error = classifiedError(failureClass, 'printer not connected after an ambiguous write');

    expect(getExplicitPrintFailureClass(error)).toBe(failureClass);
    expect(classifyPrintFailureAfterDriverCall(error, false)).toBe(failureClass);
    expect(classifyPrintFailureAfterDriverCall(error, true)).toBe(failureClass);
  });

  it('does not accept an unknown explicit classification', () => {
    const error = Object.assign(new Error('printer not connected'), {
      failureClass: 'RETRY',
    });

    expect(getExplicitPrintFailureClass(error)).toBeNull();
    expect(classifyPrintFailureAfterDriverCall(error, false)).toBe('SAFE_BEFORE_PRINT');
  });

  it('keeps unclassified post-driver failures uncertain', () => {
    expect(classifyPrintFailureAfterDriverCall(new Error('write failed'), false))
      .toBe('UNCERTAIN_AFTER_PRINT');
  });
});
