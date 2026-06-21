import { randomBytes } from 'crypto';

/**
 * Dependency-free monotonic ULID generator.
 *
 * ULID = 48-bit millisecond timestamp + 80 bits of randomness, encoded as 26
 * Crockford base32 chars. Lexicographically sortable by creation time, which is
 * exactly what we want for an append-only outbox (oldest-first drains naturally
 * by `ORDER BY event_id`). Monotonic within the same millisecond so two events
 * emitted back-to-back never collide and keep their emission order.
 *
 * Spec: https://github.com/ulid/spec
 */

const ENCODING = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'; // Crockford base32 (no I, L, O, U)
const ENCODING_LEN = ENCODING.length;
const TIME_LEN = 10;
const RANDOM_LEN = 16;

let lastTime = -1;
// 80-bit randomness held as 16 base32 char-indices (0..31) for cheap increment.
let lastRandom: number[] = [];

function encodeTime(time: number): string {
  let mod: number;
  let str = '';
  let value = time;
  for (let i = TIME_LEN - 1; i >= 0; i--) {
    mod = value % ENCODING_LEN;
    str = ENCODING[mod] + str;
    value = (value - mod) / ENCODING_LEN;
  }
  return str;
}

function randomChars(): number[] {
  const bytes = randomBytes(RANDOM_LEN);
  const out: number[] = new Array(RANDOM_LEN);
  for (let i = 0; i < RANDOM_LEN; i++) {
    out[i] = bytes[i] % ENCODING_LEN;
  }
  return out;
}

function incrementRandom(chars: number[]): number[] {
  const out = chars.slice();
  for (let i = RANDOM_LEN - 1; i >= 0; i--) {
    if (out[i] < ENCODING_LEN - 1) {
      out[i] += 1;
      return out;
    }
    out[i] = 0; // carry
  }
  // Overflowed an entire millisecond of randomness (astronomically unlikely);
  // fall back to a fresh random tail.
  return randomChars();
}

export function ulid(now: number = Date.now()): string {
  let randomPart: number[];
  if (now === lastTime) {
    randomPart = incrementRandom(lastRandom);
  } else {
    randomPart = randomChars();
    lastTime = now;
  }
  lastRandom = randomPart;
  return encodeTime(now) + randomPart.map((i) => ENCODING[i]).join('');
}
