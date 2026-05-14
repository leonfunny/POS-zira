import type { BrowserWindow } from 'electron';
import type { ServiceContainer } from '../core/container';
import { SERVICE_TOKENS } from '../core/tokens';
import type { WindowManager } from './window-manager';

export function notifyPosRenderers(
  container: ServiceContainer,
  channel: string,
  data?: unknown,
): void {
  const wm = container.getOptional<WindowManager>(SERVICE_TOKENS.WINDOW_MANAGER);
  const candidates = [
    container.getOptional<BrowserWindow>(SERVICE_TOKENS.MAIN_WINDOW),
    wm?.getWindow('pos'),
  ];
  const seen = new Set<number>();

  for (const win of candidates) {
    if (!win || win.isDestroyed() || seen.has(win.id)) continue;
    seen.add(win.id);
    win.webContents.send(channel, data);
  }
}
