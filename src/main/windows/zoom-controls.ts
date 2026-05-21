import type { BrowserWindow } from 'electron';
import logger from '../logger';

const MIN_ZOOM_LEVEL = -3;
const MAX_ZOOM_LEVEL = 3;
const ZOOM_STEP = 0.5;

type ZoomInput = {
  type?: string;
  key?: string;
  code?: string;
  control?: boolean;
  meta?: boolean;
  alt?: boolean;
};

type ZoomEvent = {
  preventDefault(): void;
};

function clampZoomLevel(value: number): number {
  return Math.min(MAX_ZOOM_LEVEL, Math.max(MIN_ZOOM_LEVEL, value));
}

function getZoomAction(input: ZoomInput): 'in' | 'out' | 'reset' | null {
  if (input.type && input.type !== 'keyDown') return null;
  if (!(input.control || input.meta) || input.alt) return null;

  const key = (input.key || '').toLowerCase();
  const code = (input.code || '').toLowerCase();

  if (key === '0' || code === 'digit0' || code === 'numpad0') return 'reset';
  if (key === '+' || key === '=' || key === 'add' || key === 'numadd' || code === 'equal' || code === 'numpadadd') return 'in';
  if (key === '-' || key === '_' || key === 'subtract' || key === 'numsubtract' || code === 'minus' || code === 'numpadsubtract') return 'out';
  return null;
}

export function resetWindowZoom(win: BrowserWindow, label = 'window'): void {
  try {
    win.webContents.setZoomLevel(0);
  } catch (err: any) {
    logger.debug(`[ZoomControls] Failed to reset zoom for ${label}: ${err?.message || err}`);
  }
}

export function handleZoomShortcut(win: BrowserWindow, event: ZoomEvent, input: ZoomInput): boolean {
  const action = getZoomAction(input);
  if (!action) return false;

  event.preventDefault();

  try {
    if (action === 'reset') {
      win.webContents.setZoomLevel(0);
      return true;
    }

    const current = win.webContents.getZoomLevel();
    const delta = action === 'in' ? ZOOM_STEP : -ZOOM_STEP;
    win.webContents.setZoomLevel(clampZoomLevel(current + delta));
  } catch (err: any) {
    logger.warn(`[ZoomControls] Failed to apply zoom shortcut: ${err?.message || err}`);
  }

  return true;
}
