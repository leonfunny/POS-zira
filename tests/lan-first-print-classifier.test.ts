import { describe, expect, it } from 'vitest';
import {
  classifyLanPrintResponse,
  classifyLanPrintError,
  LAN_FIRST_DEFAULT_TIMEOUT_MS,
} from '../src/main/printing/lan-first-print-classifier';

describe('LAN_FIRST_DEFAULT_TIMEOUT_MS', () => {
  it('is 6000ms (raised from 2000 so a normal thermal LAN print completes before timeout)', () => {
    expect(LAN_FIRST_DEFAULT_TIMEOUT_MS).toBe(6000);
  });
});

const base = { status: '', failureClass: '', error: '', message: '', responseOk: true, httpStatus: 200 };

describe('classifyLanPrintResponse', () => {
  it('COMPLETED → ACCEPTED', () => {
    expect(classifyLanPrintResponse({ ...base, status: 'COMPLETED' })).toEqual({ action: 'ACCEPTED', status: 'COMPLETED' });
  });
  it('PRINTING → ACCEPTED', () => {
    expect(classifyLanPrintResponse({ ...base, status: 'PRINTING' }).action).toBe('ACCEPTED');
  });
  it('SAFE_BEFORE_PRINT → FALLBACK (receiver confirmed no print; safe to dispatch)', () => {
    expect(classifyLanPrintResponse({ ...base, responseOk: false, httpStatus: 409, failureClass: 'SAFE_BEFORE_PRINT' }).action).toBe('FALLBACK');
  });
  it('LEDGER_NOT_DURABLE → FALLBACK', () => {
    expect(classifyLanPrintResponse({ ...base, responseOk: false, httpStatus: 503, error: 'LEDGER_NOT_DURABLE' }).action).toBe('FALLBACK');
  });
  it('UNCERTAIN_AFTER_PRINT → FAILED_NO_FALLBACK + uncertain', () => {
    expect(classifyLanPrintResponse({ ...base, responseOk: false, httpStatus: 500, failureClass: 'UNCERTAIN_AFTER_PRINT' }))
      .toMatchObject({ action: 'FAILED_NO_FALLBACK', uncertain: true });
  });
  it('FINAL → FAILED_NO_FALLBACK + NOT uncertain (definitive failure, no slip)', () => {
    expect(classifyLanPrintResponse({ ...base, responseOk: false, httpStatus: 500, failureClass: 'FINAL' }))
      .toMatchObject({ action: 'FAILED_NO_FALLBACK', uncertain: false });
  });
  it('HTTP error without failureClass → FAILED_NO_FALLBACK + uncertain (may have printed; no dispatch)', () => {
    expect(classifyLanPrintResponse({ ...base, responseOk: false, httpStatus: 502 }))
      .toMatchObject({ action: 'FAILED_NO_FALLBACK', uncertain: true });
  });
  it('unexpected ok response (no status) → FAILED_NO_FALLBACK + uncertain', () => {
    expect(classifyLanPrintResponse({ ...base, responseOk: true, status: '' }))
      .toMatchObject({ action: 'FAILED_NO_FALLBACK', uncertain: true });
  });
});

describe('classifyLanPrintError', () => {
  it('AbortError/timeout → FAILED_NO_FALLBACK + uncertain (the K-002 bug: no dispatch, no double)', () => {
    const e = new Error('aborted');
    (e as { name: string }).name = 'AbortError';
    expect(classifyLanPrintError(e)).toMatchObject({ action: 'FAILED_NO_FALLBACK', uncertain: true });
  });
  it('ECONNREFUSED → FALLBACK (receiver never reached; safe to dispatch)', () => {
    const e: Error & { code?: string } = new Error('connect ECONNREFUSED');
    e.code = 'ECONNREFUSED';
    expect(classifyLanPrintError(e).action).toBe('FALLBACK');
  });
  it('ECONNREFUSED via cause.code → FALLBACK', () => {
    const e: Error & { cause?: { code: string } } = new TypeError('fetch failed');
    e.cause = { code: 'ECONNREFUSED' };
    expect(classifyLanPrintError(e).action).toBe('FALLBACK');
  });
  it('generic error → FAILED_NO_FALLBACK + uncertain (conservative; avoid double)', () => {
    expect(classifyLanPrintError(new Error('boom'))).toMatchObject({ action: 'FAILED_NO_FALLBACK', uncertain: true });
  });
});
