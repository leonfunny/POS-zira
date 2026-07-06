import { vi } from 'vitest';

// Unit tests exercise main-process modules without bootstrapping Electron.
vi.mock('../src/main/app-identity', () => ({
  APP_DISPLAY_NAME: 'Zira',
  PACKAGE_USER_DATA_NAME: 'zira-ai',
  DISPLAY_LEGACY_USER_DATA_NAME: 'Zira AI',
  APP_USER_DATA_DIR: 'C:\\tmp\\zira-ai',
}));
