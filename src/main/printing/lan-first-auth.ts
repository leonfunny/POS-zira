import { createHmac, timingSafeEqual } from 'crypto';
import type { IncomingHttpHeaders } from 'http';

export const LAN_FIRST_AUTH_CLOCK_SKEW_MS = 2 * 60 * 1000;
export const LAN_FIRST_MACHINE_ID_HEADER = 'x-zira-lan-first-machine-id';
export const LAN_FIRST_TIMESTAMP_HEADER = 'x-zira-lan-first-timestamp';
export const LAN_FIRST_SIGNATURE_HEADER = 'x-zira-lan-first-signature';

export function signLanFirstRequest(sharedSecret: string, timestamp: string | number, bodyJson: string): string {
  return createHmac('sha256', sharedSecret)
    .update(`${timestamp}.${bodyJson}`)
    .digest('hex');
}

export function buildLanFirstAuthHeaders(input: {
  sourceMachineId: string;
  sharedSecret: string;
  bodyJson: string;
  now?: number;
}): Record<string, string> {
  const timestamp = String(input.now ?? Date.now());
  return {
    [LAN_FIRST_MACHINE_ID_HEADER]: input.sourceMachineId,
    [LAN_FIRST_TIMESTAMP_HEADER]: timestamp,
    [LAN_FIRST_SIGNATURE_HEADER]: signLanFirstRequest(input.sharedSecret, timestamp, input.bodyJson),
  };
}

function headerValue(headers: IncomingHttpHeaders, name: string): string {
  const value = headers[name.toLowerCase()];
  if (Array.isArray(value)) return String(value[0] || '').trim();
  return typeof value === 'string' ? value.trim() : '';
}

function constantTimeHexEqual(left: string, right: string): boolean {
  if (!/^[a-f0-9]{64}$/i.test(left) || !/^[a-f0-9]{64}$/i.test(right)) return false;
  try {
    const leftBuffer = Buffer.from(left, 'hex');
    const rightBuffer = Buffer.from(right, 'hex');
    return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
  } catch {
    return false;
  }
}

export function validateLanFirstAuthHeaders(input: {
  headers: IncomingHttpHeaders;
  bodyJson: string;
  sharedSecret: string;
  now?: number;
  maxSkewMs?: number;
}): { ok: true; sourceMachineId: string } | { ok: false; statusCode: 401 | 403; error: string } {
  const sourceMachineId = headerValue(input.headers, LAN_FIRST_MACHINE_ID_HEADER);
  const timestamp = headerValue(input.headers, LAN_FIRST_TIMESTAMP_HEADER);
  const signature = headerValue(input.headers, LAN_FIRST_SIGNATURE_HEADER);

  if (!sourceMachineId || !timestamp || !signature) {
    return { ok: false, statusCode: 401, error: 'LAN_FIRST auth headers are required' };
  }

  if (!/^\d+$/.test(timestamp)) {
    return { ok: false, statusCode: 401, error: 'LAN_FIRST auth timestamp is invalid' };
  }

  const timestampMs = Number(timestamp);
  const now = input.now ?? Date.now();
  const maxSkewMs = input.maxSkewMs ?? LAN_FIRST_AUTH_CLOCK_SKEW_MS;
  if (!Number.isFinite(timestampMs) || Math.abs(now - timestampMs) > maxSkewMs) {
    return { ok: false, statusCode: 401, error: 'LAN_FIRST auth timestamp is stale' };
  }

  const expected = signLanFirstRequest(input.sharedSecret, timestamp, input.bodyJson);
  if (!constantTimeHexEqual(signature, expected)) {
    return { ok: false, statusCode: 403, error: 'LAN_FIRST auth signature is invalid' };
  }

  return { ok: true, sourceMachineId };
}
