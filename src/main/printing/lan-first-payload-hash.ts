import { createHash } from 'crypto';
import type { LanFirstPrintPayloadHashInput, LanFirstPayloadHash } from '../../shared/types';

function isPlainObject(value: object): boolean {
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertNoCustomToJson(value: object): void {
  if (typeof (value as { toJSON?: unknown }).toJSON === 'function') {
    throw new TypeError('Cannot canonicalize object with custom toJSON');
  }
}

function canonicalize(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (value === null) return 'null';

  const valueType = typeof value;
  if (valueType === 'string' || valueType === 'boolean') {
    return JSON.stringify(value);
  }

  if (valueType === 'number') {
    if (!Number.isFinite(value)) {
      throw new TypeError('Cannot canonicalize non-finite number');
    }
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    assertNoCustomToJson(value);
    const items: string[] = [];
    for (let index = 0; index < value.length; index += 1) {
      items.push(canonicalize(value[index]) ?? 'null');
    }
    return `[${items.join(',')}]`;
  }

  if (valueType === 'object') {
    if (!isPlainObject(value as object)) {
      throw new TypeError('Cannot canonicalize non-plain object');
    }
    assertNoCustomToJson(value as object);
    const entries: string[] = [];
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const encoded = canonicalize((value as Record<string, unknown>)[key]);
      if (encoded === undefined) continue;
      entries.push(`${JSON.stringify(key)}:${encoded}`);
    }
    return `{${entries.join(',')}}`;
  }

  throw new TypeError(`Cannot canonicalize unsupported value type: ${valueType}`);
}

export function canonicalJsonForPrintPayloadHash(value: unknown): string {
  const encoded = canonicalize(value);
  if (encoded === undefined) {
    throw new TypeError('Cannot canonicalize undefined as top-level value');
  }
  return encoded;
}

export function hashLanFirstPrintPayload(input: LanFirstPrintPayloadHashInput): LanFirstPayloadHash {
  const hashInput: LanFirstPrintPayloadHashInput = {
    jobType: input.jobType,
    printerType: input.printerType,
    printerId: input.printerId,
    referenceType: input.referenceType,
    referenceId: input.referenceId,
    payload: input.payload,
  };
  const canonicalJson = canonicalJsonForPrintPayloadHash(hashInput);
  const digest = createHash('sha256').update(canonicalJson, 'utf8').digest('hex');
  return `sha256:${digest}`;
}
