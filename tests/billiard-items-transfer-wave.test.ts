import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  getBilliardMutationPolicy,
  isAllowedBilliardMutation,
  isAllowedBilliardOperation,
} from '../src/shared/billiard-contract';
import { sortTablesByName } from '../src/renderer/components/billiard/utils';

const readSource = (relativePath: string): string =>
  readFileSync(join(__dirname, relativePath), 'utf8');

const uuid = '23ef50dd-eb5b-4ca9-8099-d43e994e659d';

describe('item quantity editing — contract and wiring', () => {
  it('allows PATCH on a session item, online-only, bound to update_item', () => {
    const path = `/billiard/sessions/${uuid}/items/${uuid}`;
    expect(isAllowedBilliardMutation('PATCH', path)).toBe(true);
    expect(getBilliardMutationPolicy('PATCH', path)).toBe('online-only');
    expect(isAllowedBilliardOperation('update_item', 'PATCH', path)).toBe(true);
    expect(isAllowedBilliardMutation('PUT', path)).toBe(false);
  });

  it('update_item joins the session-state sync set and has a renderer hook', () => {
    const sync = readSource('../src/main/sync/billiard-sync.ts');
    expect(sync).toContain("'update_item',");
    const hooks = readSource('../src/renderer/hooks/useBilliardData.ts');
    expect(hooks).toContain("'update_item', 'PATCH'");
  });

  it('the drawer renders -/+ steppers per tab line', () => {
    const popover = readSource('../src/renderer/components/billiard/TableActionPopover.tsx');
    expect(popover).toContain('onUpdateItemQty');
    const floor = readSource('../src/renderer/components/billiard/BilliardFloorPlan.tsx');
    expect(floor).toContain('onUpdateItemQty');
    expect(floor).toContain('useUpdateItem');
  });
});

describe('transfer dialog — stable list, no private polling, drawer follows', () => {
  it('sorts table names naturally so Bàn #2 comes before Bàn #10', () => {
    const names = [
      { name: 'Bàn #10' },
      { name: 'bàn bi-a' },
      { name: 'Bàn #2' },
      { name: 'Bàn #1' },
    ];
    expect(sortTablesByName(names).map((n) => n.name)).toEqual([
      'Bàn #1', 'Bàn #2', 'Bàn #10', 'bàn bi-a',
    ]);
    expect(names[0].name).toBe('Bàn #10');
  });

  it('the dialog uses the parent floor data instead of its own live query', () => {
    const dialog = readSource('../src/renderer/components/billiard/TransferTableDialog.tsx');
    expect(dialog).not.toContain('useFloorOverview');
    expect(dialog).toContain('sortTablesByName');
    expect(dialog).toContain('onTransferred');
  });

  it('the floor moves the drawer selection to the transfer target', () => {
    const floor = readSource('../src/renderer/components/billiard/BilliardFloorPlan.tsx');
    expect(floor).toContain('onTransferred');
  });
});

describe('add-item modal — categories wrap instead of clipping', () => {
  it('the category chips wrap, never shrink to a sliver, no hidden scroll', () => {
    const modal = readSource('../src/renderer/components/billiard/AddItemToTabModal.tsx');
    // shrink-0 on the search and chip rows: without it the flex column
    // squashes them to a few pixels when height is tight (the reported
    // "category is cut" screenshot).
    expect(modal).toContain('shrink-0 flex flex-wrap');
    expect(modal).toContain('relative shrink-0');
    expect(modal).not.toContain('scrollbar-none');
  });
});
