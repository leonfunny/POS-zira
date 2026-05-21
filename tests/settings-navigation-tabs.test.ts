import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

function readSource(relativePath: string): string {
  return readFileSync(join(__dirname, relativePath), 'utf8').replace(/\r\n/g, '\n');
}

const appSource = readSource('../src/renderer/App.tsx');
const settingsSource = readSource('../src/renderer/components/Settings.tsx');
const sidebarSource = readSource('../src/renderer/components/Sidebar.tsx');
const sharedTypesSource = readSource('../src/shared/types.ts');

describe('Settings navigation tab toggles', () => {
  it('offers toggles for every non-settings sidebar tab', () => {
    const tabs = [
      'pos',
      'selfCheckout',
      'billiard',
      'orders',
      'products',
      'warehouse',
      'forecast',
      'invoicing',
      'booksy',
      'bookings',
      'checkin',
      'chat',
      'status',
      'security',
      'debug',
    ];

    for (const tab of tabs) {
      expect(settingsSource).toContain(`tab: '${tab}'`);
      expect(appSource).toContain(`'${tab}'`);
      expect(sharedTypesSource).toContain(`'${tab}'`);
    }
  });

  it('keeps newly added sales tabs wired in the sidebar and Settings visibility list', () => {
    for (const tab of ['orders', 'products', 'warehouse', 'forecast']) {
      expect(sidebarSource).toContain(`tab: '${tab}'`);
      expect(settingsSource).toContain(`tab: '${tab}'`);
    }

    expect(settingsSource).toContain('ClipboardList');
    expect(settingsSource).toContain('Package');
    expect(settingsSource).toContain('Warehouse');
    expect(settingsSource).toContain('TrendingUp');
  });
});
