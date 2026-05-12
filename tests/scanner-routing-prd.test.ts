import { describe, expect, it } from 'vitest';
import {
  chooseScannerTargetWindow,
  ScannerTargetWindowCandidate,
} from '../src/main/hardware/scanner/scanner-target';

function candidate(
  label: string,
  id: number,
  options: { focused?: boolean; destroyed?: boolean } = {},
): ScannerTargetWindowCandidate {
  return {
    label,
    window: {
      id,
      isFocused: () => !!options.focused,
      isDestroyed: () => !!options.destroyed,
    },
  };
}

describe('scanner routing PRD contract', () => {
  it('routes one physical scan to focused self-checkout when POS is also open', () => {
    const target = chooseScannerTargetWindow([
      candidate('self-checkout', 2),
      candidate('POS', 3, { focused: true }),
      candidate('main', 1),
    ], 2);

    expect(target?.label).toBe('self-checkout');
  });

  it('routes one physical scan to focused POS when self-checkout is also open', () => {
    const target = chooseScannerTargetWindow([
      candidate('self-checkout', 2, { focused: true }),
      candidate('POS', 3),
      candidate('main', 1),
    ], 3);

    expect(target?.label).toBe('POS');
  });

  it('uses focused sales-window state when Electron has no focused-window id', () => {
    const target = chooseScannerTargetWindow([
      candidate('self-checkout', 2, { focused: true }),
      candidate('POS', 3),
      candidate('main', 1),
    ], null);

    expect(target?.label).toBe('self-checkout');
  });

  it('falls back to main only when no sales surface is focused', () => {
    const target = chooseScannerTargetWindow([
      candidate('self-checkout', 2),
      candidate('POS', 3),
      candidate('main', 1),
    ], null);

    expect(target?.label).toBe('main');
  });

  it('ignores destroyed windows when choosing the scanner target', () => {
    const target = chooseScannerTargetWindow([
      candidate('self-checkout', 2, { destroyed: true }),
      candidate('POS', 3),
      candidate('main', 1),
    ], 2);

    expect(target?.label).toBe('main');
  });
});
