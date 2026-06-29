import { describe, it, expect } from 'vitest';
import { grossFromNet, netFromGross, parsePriceNumber } from '../src/renderer/components/products/price-vat';

describe('price-vat calculator', () => {
  it('computes gross from net + vat', () => {
    expect(grossFromNet('10', '23')).toBe('12.30');
    expect(grossFromNet('2.86', '5')).toBe('3.00');
    expect(grossFromNet('100', '0')).toBe('100.00');
  });

  it('computes net from gross + vat', () => {
    expect(netFromGross('12.30', '23')).toBe('10.00');
    expect(netFromGross('3.00', '5')).toBe('2.86');
    expect(netFromGross('100', '0')).toBe('100.00');
  });

  it('round-trips gross -> net -> gross within a grosz', () => {
    const gross = '3.00';
    const net = netFromGross(gross, '5');
    expect(grossFromNet(net, '5')).toBe('3.00');
  });

  it('returns empty string on invalid input', () => {
    expect(grossFromNet('', '23')).toBe('');
    expect(grossFromNet('abc', '23')).toBe('');
    expect(netFromGross('10', '')).toBe('');
  });

  it('parsePriceNumber accepts comma decimals and rejects negatives', () => {
    expect(parsePriceNumber('1,50')).toBe(1.5);
    expect(parsePriceNumber('-3')).toBeNull();
    expect(parsePriceNumber('')).toBeNull();
  });
});
