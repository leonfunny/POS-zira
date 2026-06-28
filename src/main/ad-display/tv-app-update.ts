import { createHash } from 'crypto';
import { existsSync, readFileSync, statSync } from 'fs';
import { join } from 'path';

export const TV_APP_LATEST_VERSION_CODE = 8;
export const TV_APP_LATEST_VERSION_NAME = '1.3.2';
export const TV_APP_APK_ROUTE = '/tv-app/app-release.apk';

export interface TvAppUpdateAsset {
  path: string;
  size: number;
  sha256: string;
}

export function resolveTvAppApkPath(): string | null {
  const candidates = [
    process.env.ZIRA_TV_ADS_APK_PATH || '',
    join(process.resourcesPath || '', 'tv-ads', 'app-release.apk'),
    join(process.cwd(), 'tv-ads', 'app-release.apk'),
    join(process.cwd(), 'android-tv-ads', 'app', 'build', 'outputs', 'apk', 'release', 'app-release.apk'),
    join(__dirname, '..', '..', '..', 'android-tv-ads', 'app', 'build', 'outputs', 'apk', 'release', 'app-release.apk'),
  ].filter(Boolean);

  return candidates.find(p => existsSync(p)) || null;
}

export function getTvAppUpdateAsset(): TvAppUpdateAsset | null {
  const path = resolveTvAppApkPath();
  if (!path) return null;
  const stat = statSync(path);
  return {
    path,
    size: stat.size,
    sha256: createHash('sha256').update(readFileSync(path)).digest('hex'),
  };
}
