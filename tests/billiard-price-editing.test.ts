import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { nextNumberAppend, nextNumberBackspace } from '../src/renderer/hooks/keyboard-value';

const readSource = (relativePath: string): string =>
  readFileSync(join(__dirname, relativePath), 'utf8');

describe('numpad value editing — type over, no leading zeros', () => {
  it('the first key after focusing replaces the whole value', () => {
    expect(nextNumberAppend('60', '4', true)).toBe('4');
    expect(nextNumberAppend('0', '7', true)).toBe('7');
  });

  it('later keys append and leading zeros never survive', () => {
    expect(nextNumberAppend('4', '2', false)).toBe('42');
    expect(nextNumberAppend('0', '4', false)).toBe('4');
    expect(nextNumberAppend('0', '0', false)).toBe('0');
    expect(nextNumberAppend('', '0', false)).toBe('0');
  });

  it('backspace trims one character', () => {
    expect(nextNumberBackspace('42')).toBe('4');
    expect(nextNumberBackspace('')).toBe('');
  });

  it('the keyboard manager types over on focus (select + fresh replace)', () => {
    const manager = readSource('../src/renderer/hooks/useKeyboardManager.ts');
    expect(manager).toContain('nextNumberAppend');
    expect(manager).toContain('.select()');
  });
});

describe('hourly rate of an existing table is editable', () => {
  it('the edit menu offers Edit price and the floor saves pricing_rules', () => {
    const menu = readSource('../src/renderer/components/billiard/menu/MenuActionItems.tsx');
    expect(menu).toContain('onEditPrice');
    const contextMenu = readSource('../src/renderer/components/billiard/EditContextMenu.tsx');
    expect(contextMenu).toContain('onEditPrice');
    const floor = readSource('../src/renderer/components/billiard/BilliardFloorPlan.tsx');
    expect(floor).toContain('EditPriceDialog');
    expect(floor).toContain('pricing_rules');
  });

  it('the price dialog respects the keyboard inset and container height', () => {
    const dialog = readSource('../src/renderer/components/billiard/EditPriceDialog.tsx');
    expect(dialog).toContain('--touch-keyboard-inset');
    expect(dialog).not.toMatch(/max-h-\[\d+vh\]/);
  });
});
