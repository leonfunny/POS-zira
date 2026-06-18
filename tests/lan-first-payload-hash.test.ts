import { describe, expect, it } from 'vitest';
import { canonicalJsonForPrintPayloadHash, hashLanFirstPrintPayload } from '../src/main/printing/lan-first-payload-hash';

describe('LAN_FIRST print payload hash', () => {
  it('sorts object keys ascending', () => {
    expect(canonicalJsonForPrintPayloadHash({ z: 1, a: 2 })).toBe('{"a":2,"z":1}');
  });

  it('sorts nested object keys recursively', () => {
    expect(canonicalJsonForPrintPayloadHash({
      z: { y: 1, a: 2 },
      a: { d: 4, c: 3 },
    })).toBe('{"a":{"c":3,"d":4},"z":{"a":2,"y":1}}');
  });

  it('preserves array order while sorting object entries inside arrays', () => {
    expect(canonicalJsonForPrintPayloadHash({
      items: [
        { z: 1, a: 2 },
        { b: 3, a: 4 },
      ],
    })).toBe('{"items":[{"a":2,"z":1},{"a":4,"b":3}]}');
  });

  it('omits undefined object keys', () => {
    expect(canonicalJsonForPrintPayloadHash({
      a: 1,
      skip: undefined,
      nested: { keep: true, skip: undefined },
    })).toBe('{"a":1,"nested":{"keep":true}}');
  });

  it('turns undefined array items into null', () => {
    expect(canonicalJsonForPrintPayloadHash({ values: [1, undefined, 2] })).toBe('{"values":[1,null,2]}');
  });

  it('rejects non-finite numbers', () => {
    expect(() => canonicalJsonForPrintPayloadHash({ value: Number.POSITIVE_INFINITY })).toThrow(/non-finite/i);
    expect(() => canonicalJsonForPrintPayloadHash({ value: Number.NaN })).toThrow(/non-finite/i);
  });

  it('rejects object instances that are not plain JSON data', () => {
    class CustomPayload {
      constructor(public value: number) {}
    }

    expect(() => canonicalJsonForPrintPayloadHash({ value: new Date('2026-06-18T00:00:00.000Z') })).toThrow(/plain/i);
    expect(() => canonicalJsonForPrintPayloadHash({ value: new Map([['a', 1]]) })).toThrow(/plain/i);
    expect(() => canonicalJsonForPrintPayloadHash({ value: new Set([1]) })).toThrow(/plain/i);
    expect(() => canonicalJsonForPrintPayloadHash({ value: new CustomPayload(1) })).toThrow(/plain/i);
  });

  it('rejects objects with custom toJSON', () => {
    expect(() => canonicalJsonForPrintPayloadHash({
      value: {
        amount: 1,
        toJSON() {
          return { amount: '1.00' };
        },
      },
    })).toThrow(/toJSON/i);
  });

  it('returns a sha256-prefixed lowercase hex hash', () => {
    const hash = hashLanFirstPrintPayload({
      jobType: 'KITCHEN_TICKET',
      printerType: 'KITCHEN',
      printerId: 'printer-1',
      referenceType: 'KITCHEN_TICKET',
      referenceId: 'order-1',
      payload: { items: [{ name: 'Pho', quantity: 1 }] },
    });

    expect(hash).toMatch(/^sha256:[a-f0-9]{64}$/);
  });

  it('hashes only the exact payload-hash envelope fields', () => {
    const input = {
      jobType: 'KITCHEN_TICKET',
      printerType: 'KITCHEN',
      printerId: 'printer-1',
      referenceType: 'KITCHEN_TICKET',
      referenceId: 'order-1',
      payload: { items: [] },
    } as const;

    expect(hashLanFirstPrintPayload({
      ...input,
      idempotencyKey: 'must-not-enter-hash',
      dispatchMode: 'LAN_FIRST',
    })).toBe(hashLanFirstPrintPayload(input));
  });
});
