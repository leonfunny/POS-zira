import { describe, expect, it } from 'vitest';
import { modalClassNames, type ModalSize, type ModalZLayer } from '../src/renderer/components/shared/Modal';

describe('modalClassNames', () => {
  const sizes: ModalSize[] = ['sm', 'md', 'lg', 'full'];

  it('maps every size to a distinct panel width class', () => {
    const widths = sizes.map((size) => modalClassNames(size, 'base').panel);

    expect(widths[0]).toContain('max-w-sm');
    expect(widths[1]).toContain('max-w-md');
    expect(widths[2]).toContain('max-w-lg');
    expect(widths[3]).toContain('max-w-[calc(100vw-2rem)]');
    expect(new Set(widths).size).toBe(sizes.length);
  });

  it('maps z layers to base and nested overlay stacks', () => {
    const layers: Record<ModalZLayer, string> = {
      base: 'z-50',
      nested: 'z-[60]',
    };

    for (const [layer, expectedClass] of Object.entries(layers) as Array<[ModalZLayer, string]>) {
      expect(modalClassNames('md', layer).overlay).toContain(expectedClass);
    }
  });

  it('keeps the shared shell on the light modal treatment', () => {
    const classes = modalClassNames('md', 'base');

    expect(classes.overlay).toContain('bg-slate-950/50');
    expect(classes.panel).toContain('bg-white');
    expect(classes.panel).toContain('border-slate-200');
    expect(classes.panel).toContain('shadow-2xl');
    expect(classes.panel).toContain('rounded-xl');
  });
});
