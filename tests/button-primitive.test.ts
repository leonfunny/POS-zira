import { describe, expect, it } from 'vitest';
import { buttonClassNames, type ButtonSize, type ButtonVariant } from '../src/renderer/components/shared/Button';

const variants: ButtonVariant[] = ['primary', 'secondary', 'danger', 'ghost'];
const sizes: ButtonSize[] = ['md', 'lg', 'kiosk'];

describe('buttonClassNames', () => {
  it.each(variants)('includes shared focus, disabled, and touch affordances for %s', (variant) => {
    const classes = buttonClassNames(variant, 'md');

    expect(classes).toContain('rounded-lg');
    expect(classes).toContain('font-extrabold');
    expect(classes).toContain('focus-visible:ring-2');
    expect(classes).toContain('disabled:opacity-50');
    expect(classes).toContain('disabled:cursor-not-allowed');
    expect(classes).toContain('touch-manipulation');
    expect(classes).toContain('transition-colors');
  });

  it('keeps variant surfaces distinct', () => {
    expect(buttonClassNames('primary', 'md')).toContain('bg-brand-600');
    expect(buttonClassNames('primary', 'md')).toContain('hover:bg-brand-700');
    expect(buttonClassNames('secondary', 'md')).toContain('bg-white');
    expect(buttonClassNames('secondary', 'md')).toContain('border-slate-300');
    expect(buttonClassNames('danger', 'md')).toContain('bg-red-600');
    expect(buttonClassNames('ghost', 'md')).toContain('bg-transparent');
  });

  it.each(sizes)('enforces a minimum touch height for %s size', (size) => {
    const classes = buttonClassNames('primary', size);

    if (size === 'md') expect(classes).toContain('min-h-11');
    if (size === 'lg') expect(classes).toContain('min-h-[56px]');
    if (size === 'kiosk') expect(classes).toContain('min-h-[64px]');
  });

  it('covers every variant and size combination', () => {
    for (const variant of variants) {
      for (const size of sizes) {
        const classes = buttonClassNames(variant, size);

        expect(classes).toContain('focus-visible:ring-2');
        expect(classes).toMatch(/min-h-(11|\[56px\]|\[64px\])/);
      }
    }
  });
});
