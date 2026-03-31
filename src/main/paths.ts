import { join } from 'path';
import { app } from 'electron';

/**
 * Get the correct path to an asset file.
 * In development: assets/ is relative to project root
 * In production (packaged): assets/ is in process.resourcesPath
 */
export function getAssetPath(...paths: string[]): string {
  const isPacked = app.isPackaged;
  if (isPacked) {
    return join(process.resourcesPath, 'assets', ...paths);
  }
  return join(__dirname, '../../assets', ...paths);
}

export function getIconPath(iconName: string): string {
  return getAssetPath('icons', iconName);
}
