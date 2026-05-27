import { describe, expect, it } from 'vitest';
import {
  appendDigit,
  appendDecimal,
  appendDoubleZero,
  backspace,
  parseBufferGrosze,
  parseBufferInt,
  parseBufferQuantity,
} from '../src/renderer/hooks/usePOSNumpadController';

describe('POSNumpad buffer helpers', () => {
  describe('appendDigit', () => {
    it('appends digit to empty buffer', () => {
      expect(appendDigit('', '5')).toBe('5');
    });

    it('appends digit to existing buffer', () => {
      expect(appendDigit('1', '2')).toBe('12');
      expect(appendDigit('12', '3')).toBe('123');
    });

    it('replaces leading 0', () => {
      expect(appendDigit('0', '5')).toBe('5');
    });

    it('preserves "0." prefix', () => {
      expect(appendDigit('0.', '5')).toBe('0.5');
    });

    it('caps at 9 chars', () => {
      expect(appendDigit('123456789', '0')).toBe('123456789');
    });
  });

  describe('appendDecimal', () => {
    it('adds 0. when buffer empty', () => {
      expect(appendDecimal('', 'cash')).toBe('0.');
    });

    it('appends . to integer buffer', () => {
      expect(appendDecimal('50', 'cash')).toBe('50.');
    });

    it('does not duplicate .', () => {
      expect(appendDecimal('50.5', 'cash')).toBe('50.5');
    });

    it('allows decimal quantities', () => {
      expect(appendDecimal('5', 'qty')).toBe('5.');
      expect(appendDecimal('', 'qty')).toBe('0.');
    });
  });

  describe('appendDoubleZero', () => {
    it('appends 00 to single digit', () => {
      expect(appendDoubleZero('5', 'cash')).toBe('500');
    });

    it('returns "0" on empty buffer (cash)', () => {
      expect(appendDoubleZero('', 'cash')).toBe('0');
    });

    it('does not exceed 2 decimal places', () => {
      expect(appendDoubleZero('5.5', 'cash')).toBe('5.500');
      expect(appendDoubleZero('5.50', 'cash')).toBe('5.50');
    });

    it('is no-op in qty mode', () => {
      expect(appendDoubleZero('5', 'qty')).toBe('5');
    });
  });

  describe('backspace', () => {
    it('removes last char', () => {
      expect(backspace('123')).toBe('12');
      expect(backspace('5')).toBe('');
      expect(backspace('')).toBe('');
    });
  });

  describe('parseBufferGrosze', () => {
    it('returns 0 on empty', () => {
      expect(parseBufferGrosze('')).toBe(0);
    });

    it('parses integer as PLN (5 = 500 grosze)', () => {
      expect(parseBufferGrosze('5')).toBe(500);
      expect(parseBufferGrosze('50')).toBe(5000);
      expect(parseBufferGrosze('100')).toBe(10000);
    });

    it('parses decimal correctly', () => {
      expect(parseBufferGrosze('5.50')).toBe(550);
      expect(parseBufferGrosze('12.34')).toBe(1234);
      expect(parseBufferGrosze('0.99')).toBe(99);
    });

    it('rounds half-cents', () => {
      expect(parseBufferGrosze('5.005')).toBe(501);
    });

    it('handles trailing decimal point', () => {
      expect(parseBufferGrosze('5.')).toBe(500);
    });
  });

  describe('parseBufferInt', () => {
    it('parses positive integer', () => {
      expect(parseBufferInt('5')).toBe(5);
      expect(parseBufferInt('123')).toBe(123);
    });

    it('returns 0 on empty or invalid', () => {
      expect(parseBufferInt('')).toBe(0);
      expect(parseBufferInt('abc')).toBe(0);
    });

    it('returns 0 on zero or negative', () => {
      expect(parseBufferInt('0')).toBe(0);
    });

    it('ignores decimal portion (qty is int-only)', () => {
      expect(parseBufferInt('5.5')).toBe(5);
    });
  });

  describe('parseBufferQuantity', () => {
    it('parses decimal quantities', () => {
      expect(parseBufferQuantity('0.238')).toBe(0.238);
      expect(parseBufferQuantity('5.5')).toBe(5.5);
    });
  });

  describe('typical cashier flows', () => {
    it('cash: type 5, 0 = 50.00 PLN', () => {
      let buf = '';
      buf = appendDigit(buf, '5');
      buf = appendDigit(buf, '0');
      expect(buf).toBe('50');
      expect(parseBufferGrosze(buf)).toBe(5000);
    });

    it('cash: type 12, ., 50 = 12.50 PLN', () => {
      let buf = '';
      buf = appendDigit(buf, '1');
      buf = appendDigit(buf, '2');
      buf = appendDecimal(buf, 'cash');
      buf = appendDigit(buf, '5');
      buf = appendDigit(buf, '0');
      expect(buf).toBe('12.50');
      expect(parseBufferGrosze(buf)).toBe(1250);
    });

    it('cash: type 1, 00, 00 = 10000.00 PLN', () => {
      let buf = '';
      buf = appendDigit(buf, '1');
      buf = appendDoubleZero(buf, 'cash');
      buf = appendDoubleZero(buf, 'cash');
      expect(buf).toBe('10000');
      expect(parseBufferGrosze(buf)).toBe(1000000);
    });

    it('qty: type 3, ., 5 = decimal quantity 3.5', () => {
      let buf = '';
      buf = appendDigit(buf, '3');
      buf = appendDecimal(buf, 'qty');
      buf = appendDigit(buf, '5');
      expect(buf).toBe('3.5');
      expect(parseBufferQuantity(buf)).toBe(3.5);
    });

    it('backspace flow: 1234 → backspace twice → 12', () => {
      let buf = '1234';
      buf = backspace(buf);
      buf = backspace(buf);
      expect(buf).toBe('12');
    });

    it('discount %: type 10 = 10%', () => {
      let buf = '';
      buf = appendDigit(buf, '1');
      buf = appendDigit(buf, '0');
      expect(buf).toBe('10');
      expect(parseFloat(buf)).toBe(10);
    });
  });
});
