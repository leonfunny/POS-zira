import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

function readSource(relativePath: string): string {
  return readFileSync(join(__dirname, relativePath), 'utf8').replace(/\r\n/g, '\n');
}

const appSource = readSource('../src/renderer/App.tsx');
const settingsSource = readSource('../src/renderer/components/Settings.tsx');
const sidebarSource = readSource('../src/renderer/components/Sidebar.tsx');
const moduleManagerSource = readSource('../src/renderer/components/ModuleManager.tsx');
const sharedTypesSource = readSource('../src/shared/types.ts');

describe('Settings navigation tab toggles', () => {
  it('offers toggles for every non-settings sidebar tab', () => {
    const tabs = [...sidebarSource.matchAll(/\{ tab: '([^']+)'/g)]
      .map((match) => match[1])
      .filter((tab) => tab !== 'settings');

    for (const tab of tabs) {
      expect(appSource).toContain(`'${tab}'`);
      expect(sharedTypesSource).toContain(`'${tab}'`);
    }

    expect(settingsSource).toContain('<ModuleManager');
    expect(moduleManagerSource).toContain("import { MENU_GROUPS } from './Sidebar';");
    expect(moduleManagerSource).toContain('group.items.map((item) => {');
    expect(moduleManagerSource).toContain('onClick={() => setOverride(item.tab, !enabled)}');
    expect(settingsSource).not.toContain('TAB_VISIBILITY_CONFIG');
  });

  it('keeps newly added sales tabs wired through the shared sidebar menu list', () => {
    for (const tab of ['orders', 'products', 'warehouse', 'forecast']) {
      expect(sidebarSource).toContain(`tab: '${tab}'`);
    }

    expect(sidebarSource).toContain('ClipboardList');
    expect(sidebarSource).toContain('Package');
    expect(sidebarSource).toContain('Warehouse');
    expect(sidebarSource).toContain('TrendingUp');
    expect(moduleManagerSource).toContain('MENU_GROUPS.map((group) => (');
  });
});
