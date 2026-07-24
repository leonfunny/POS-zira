import { describe, expect, it } from 'vitest';
import {
  buildSharedPrintIdempotencyKey,
  classifySharedPrintResponse,
} from '../src/main/printing/shared-print-retry-policy';

describe('shared print retry policy', () => {
  it('allows auto retry only for FAILED + SAFE_BEFORE_PRINT + retryAllowed', () => {
    expect(classifySharedPrintResponse('FISCAL_RECEIPT', {
      jobId: 'job-1',
      status: 'FAILED',
      failureClass: 'SAFE_BEFORE_PRINT',
      retryAllowed: true,
    }).decision).toBe('AUTO_RETRY_SAFE');

    expect(classifySharedPrintResponse('FISCAL_RECEIPT', {
      jobId: 'job-1',
      status: 'FAILED',
      failureClass: 'SAFE_BEFORE_PRINT',
      retryAllowed: false,
    }).decision).toBe('STOP_MANUAL_RETRY');
  });

  it('keeps polling an order copy whose backend wait expired instead of failing it', () => {
    // The backend never persists a TIMEOUT job status — timedOut means the
    // blocking wait expired while the job still feeds the shared till
    // (POS2: ~95% of receipts outlived the 10s hold, 2026-07-24).
    expect(classifySharedPrintResponse('RECEIPT_ORDER_COPY', {
      jobId: 'job-1',
      status: 'TIMEOUT',
      timedOut: true,
      retryAllowed: false,
    }).decision).toBe('ALREADY_IN_FLIGHT');

    // Without a job to poll there is nothing to resume — still a manual stop.
    expect(classifySharedPrintResponse('RECEIPT_ORDER_COPY', {
      status: 'TIMEOUT',
      timedOut: true,
    }).decision).toBe('STOP_MANUAL_RETRY');
  });

  it('routes fiscal timeout and uncertain failures away from auto retry', () => {
    expect(classifySharedPrintResponse('FISCAL_RECEIPT', {
      jobId: 'job-1',
      status: 'TIMEOUT',
      timedOut: true,
      retryAllowed: false,
    }).decision).toBe('STOP_RECONCILE_REQUIRED');

    expect(classifySharedPrintResponse('FISCAL_RECEIPT', {
      jobId: 'job-1',
      status: 'FAILED',
      failureClass: 'UNCERTAIN_AFTER_PRINT',
      retryAllowed: false,
    }).decision).toBe('STOP_RECONCILE_REQUIRED');
  });

  it('requires machine and order identity before building retry idempotency keys', () => {
    expect(buildSharedPrintIdempotencyKey('fiscal', 'machine-2', 'order-1', 'default'))
      .toBe('pos-fiscal:machine-2:order-1:default:v1');
    expect(buildSharedPrintIdempotencyKey('receipt', '', 'order-1', 'order')).toBeUndefined();
    expect(buildSharedPrintIdempotencyKey('receipt', 'machine-2', '', 'order')).toBeUndefined();
  });
});
