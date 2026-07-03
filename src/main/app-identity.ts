import { app } from 'electron';
import { existsSync } from 'fs';
import { join } from 'path';

export const APP_DISPLAY_NAME = 'Zira';
export const PACKAGE_USER_DATA_NAME = 'zira-ai';
export const DISPLAY_LEGACY_USER_DATA_NAME = 'Zira AI';

function resolveUserDataDir(): string {
  if (process.env.ELECTRON_USER_DATA_DIR) {
    return process.env.ELECTRON_USER_DATA_DIR;
  }

  const appDataDir = app.getPath('appData');
  const packageNameDir = join(appDataDir, PACKAGE_USER_DATA_NAME);
  const displayNameDir = join(appDataDir, DISPLAY_LEGACY_USER_DATA_NAME);

  if (existsSync(packageNameDir)) {
    return packageNameDir;
  }

  if (existsSync(displayNameDir)) {
    return displayNameDir;
  }

  return packageNameDir;
}

export const APP_USER_DATA_DIR = resolveUserDataDir();

app.setPath('userData', APP_USER_DATA_DIR);
app.setName(APP_DISPLAY_NAME);
