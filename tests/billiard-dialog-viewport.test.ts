import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const readSource = (relativePath: string): string =>
  readFileSync(join(__dirname, relativePath), 'utf8');

describe('billiard dialogs fit their container, not the viewport', () => {
  // A card capped in vh overflows its container the moment the touch
  // keyboard shrinks it (bottom inset): the centered card then spills past
  // the top of the screen AND over the keyboard rows — the reported
  // "layers after layers" screenshot. Caps must be relative to the
  // container (max-h-full / calc(100%-…)), never the viewport.
  const dialogs = [
    'ReservationPanel.tsx',
    'AddTableDialog.tsx',
    'UnsettledPanel.tsx',
    'TableActionPopover.tsx',
    'PaymentDialog.tsx',
    'AddItemToTabModal.tsx',
    'TransferTableDialog.tsx',
  ];

  it('no billiard dialog card uses a viewport-height cap', () => {
    for (const file of dialogs) {
      const source = readSource(`../src/renderer/components/billiard/${file}`);
      expect(source, `${file} still caps a card in vh`).not.toMatch(/max-h-\[\d+vh\]/);
    }
  });
});
