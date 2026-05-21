import { EventEmitter } from 'events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type DisplayLike = {
  id: number;
  label: string;
  bounds: { x: number; y: number; width: number; height: number };
  workArea: { x: number; y: number; width: number; height: number };
};

const screenListeners = new Map<string, Set<(...args: any[]) => void>>();
const ipcHandlers = new Map<string, (...args: any[]) => unknown>();
const ipcListeners = new Map<string, Set<(...args: any[]) => void>>();
const createdWindows: MockBrowserWindow[] = [];

let displays: DisplayLike[] = [];
let primaryDisplay: DisplayLike;
let configValues: Record<string, any> = {};

class MockWebContents extends EventEmitter {
  owner: MockBrowserWindow;
  sentMessages: Array<{ channel: string; payload: any }> = [];
  zoomLevel = 0;

  constructor(owner: MockBrowserWindow) {
    super();
    this.owner = owner;
  }

  setWindowOpenHandler = vi.fn();
  toggleDevTools = vi.fn();
  getZoomLevel = vi.fn(() => this.zoomLevel);
  setZoomLevel = vi.fn((level: number) => {
    this.zoomLevel = level;
  });

  send(channel: string, payload?: any) {
    this.sentMessages.push({ channel, payload });
  }
}

class MockBrowserWindow extends EventEmitter {
  static fromWebContents(webContents: MockWebContents) {
    return webContents?.owner ?? null;
  }

  options: Record<string, any>;
  webContents: MockWebContents;
  destroyed = false;
  currentBounds: { x: number; y: number; width: number; height: number };
  kiosk = false;
  fullscreen = false;
  boundsHistory: Array<{ x: number; y: number; width: number; height: number }> = [];
  kioskHistory: boolean[] = [];
  fullscreenHistory: boolean[] = [];
  alwaysOnTopHistory: Array<{ flag: boolean; level?: string }> = [];
  menuBarVisibilityHistory: boolean[] = [];
  autoHideMenuBarHistory: boolean[] = [];

  constructor(options: Record<string, any>) {
    super();
    this.options = options;
    this.webContents = new MockWebContents(this);
    this.currentBounds = {
      x: options.x,
      y: options.y,
      width: options.width,
      height: options.height,
    };
    this.kiosk = !!options.kiosk;
    this.fullscreen = !!options.fullscreen;
    this.boundsHistory.push(this.currentBounds);
    this.kioskHistory.push(this.kiosk);
    this.fullscreenHistory.push(this.fullscreen);
    this.alwaysOnTopHistory.push({ flag: !!options.alwaysOnTop });
    createdWindows.push(this);
  }

  show = vi.fn();
  showInactive = vi.fn();
  focus = vi.fn();
  loadURL = vi.fn();
  loadFile = vi.fn();

  setBounds(bounds: { x: number; y: number; width: number; height: number }) {
    this.currentBounds = bounds;
    this.boundsHistory.push(bounds);
  }

  setKiosk(flag: boolean) {
    this.kiosk = flag;
    this.kioskHistory.push(flag);
  }

  isKiosk() {
    return this.kiosk;
  }

  setFullScreen(flag: boolean) {
    this.fullscreen = flag;
    this.fullscreenHistory.push(flag);
  }

  isFullScreen() {
    return this.fullscreen;
  }

  setAlwaysOnTop(flag: boolean, level?: string) {
    this.alwaysOnTopHistory.push({ flag, level });
  }

  setMenuBarVisibility(flag: boolean) {
    this.menuBarVisibilityHistory.push(flag);
  }

  setAutoHideMenuBar(flag: boolean) {
    this.autoHideMenuBarHistory.push(flag);
  }

  isDestroyed() {
    return this.destroyed;
  }

  destroy() {
    this.destroyed = true;
    this.emit('closed');
  }

  getTitle() {
    return this.options.title;
  }
}

const mockScreen = {
  getAllDisplays: vi.fn(() => displays as any),
  getPrimaryDisplay: vi.fn(() => primaryDisplay as any),
  on: vi.fn((event: string, listener: (...args: any[]) => void) => {
    if (!screenListeners.has(event)) {
      screenListeners.set(event, new Set());
    }
    screenListeners.get(event)!.add(listener);
  }),
  removeListener: vi.fn((event: string, listener: (...args: any[]) => void) => {
    screenListeners.get(event)?.delete(listener);
  }),
};

const mockIpcMain = {
  handle: vi.fn((channel: string, handler: (...args: any[]) => unknown) => {
    ipcHandlers.set(channel, handler);
  }),
  on: vi.fn((channel: string, listener: (...args: any[]) => void) => {
    if (!ipcListeners.has(channel)) {
      ipcListeners.set(channel, new Set());
    }
    ipcListeners.get(channel)!.add(listener);
  }),
  removeListener: vi.fn((channel: string, listener: (...args: any[]) => void) => {
    ipcListeners.get(channel)?.delete(listener);
  }),
  removeHandler: vi.fn((channel: string) => {
    ipcHandlers.delete(channel);
  }),
};

const mockShell = {
  openExternal: vi.fn(),
};

const execFileMock = vi.fn((...args: any[]) => {
  const callback = args.at(-1);
  if (typeof callback === 'function') {
    callback(null, '', '');
  }
});

vi.mock('electron', () => ({
  BrowserWindow: MockBrowserWindow,
  screen: mockScreen,
  ipcMain: mockIpcMain,
  shell: mockShell,
}));

vi.mock('child_process', () => ({
  execFile: execFileMock,
}));

vi.mock('../src/main/logger', () => ({
  default: {
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('../src/main/config/store', () => ({
  getConfigValue: vi.fn((key: string) => configValues[key]),
}));

function emitScreenEvent(event: string) {
  for (const listener of screenListeners.get(event) ?? []) {
    listener();
  }
}

function makeDisplay(id: number, x: number, y: number, width: number, height: number, workHeight = height - 40): DisplayLike {
  return {
    id,
    label: `Display ${id}`,
    bounds: { x, y, width, height },
    workArea: { x, y, width, height: workHeight },
  };
}

function emitBeforeInput(win: MockBrowserWindow, input: Record<string, any>) {
  const event = { preventDefault: vi.fn() };
  win.webContents.emit('before-input-event', event, input);
  return event;
}

describe('WindowManager customer display behavior', () => {
  let WindowManager: typeof import('../src/main/windows/window-manager').WindowManager;
  const posStore = {
    registerWindow: vi.fn(),
    unregisterWindow: vi.fn(),
  };

  beforeEach(async () => {
    vi.resetModules();
    vi.useFakeTimers();

    displays = [makeDisplay(1, 0, 0, 1920, 1080)];
    primaryDisplay = displays[0];
    configValues = {
      posEnabled: true,
      customerDisplayEnabled: true,
      customerDisplayMonitor: 0,
    };

    createdWindows.length = 0;
    screenListeners.clear();
    ipcHandlers.clear();
    ipcListeners.clear();

    mockScreen.getAllDisplays.mockClear();
    mockScreen.getPrimaryDisplay.mockClear();
    mockScreen.on.mockClear();
    mockScreen.removeListener.mockClear();
    mockIpcMain.handle.mockClear();
    mockIpcMain.on.mockClear();
    mockIpcMain.removeListener.mockClear();
    mockIpcMain.removeHandler.mockClear();
    mockShell.openExternal.mockClear();
    execFileMock.mockClear();
    posStore.registerWindow.mockClear();
    posStore.unregisterWindow.mockClear();

    const mod = await import('../src/main/windows/window-manager');
    WindowManager = mod.WindowManager;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('defaults missing customerDisplayForceKiosk to true and uses display bounds with screen-saver always-on-top', () => {
    const manager = new WindowManager(posStore as any);
    const win = manager.createWindow('customer') as unknown as MockBrowserWindow;

    expect(win).toBeTruthy();
    expect(win.options.width).toBe(1920);
    expect(win.options.height).toBe(1080);
    expect(win.options.kiosk).toBe(true);
    expect(win.options.fullscreen).toBe(true);
    expect(win.boundsHistory.at(-1)).toEqual(primaryDisplay.bounds);
    expect(win.alwaysOnTopHistory).toContainEqual({ flag: true, level: 'screen-saver' });

    manager.destroy();
  });

  it('keeps the legacy windowed fallback when customerDisplayForceKiosk is false', () => {
    configValues.customerDisplayForceKiosk = false;

    const manager = new WindowManager(posStore as any);
    const win = manager.createWindow('customer') as unknown as MockBrowserWindow;

    expect(win.options.kiosk).toBe(false);
    expect(win.options.fullscreen).toBe(false);
    expect(win.boundsHistory.at(-1)).toEqual({
      x: 448,
      y: 136,
      width: 1024,
      height: 768,
    });
    expect(win.alwaysOnTopHistory.some((entry) => entry.flag && entry.level === 'screen-saver')).toBe(false);
    expect(emitBeforeInput(win, { key: 'a' }).preventDefault).toHaveBeenCalledOnce();

    manager.destroy();
  });

  it('refreshes customer display config when opening an existing customer window', () => {
    configValues.customerDisplayForceKiosk = false;

    const manager = new WindowManager(posStore as any);
    const win = manager.createWindow('customer') as unknown as MockBrowserWindow;
    win.webContents.sentMessages.length = 0;

    const existing = manager.createWindow('customer') as unknown as MockBrowserWindow;

    expect(existing).toBe(win);
    expect(win.showInactive).toHaveBeenCalledOnce();
    expect(win.focus).not.toHaveBeenCalled();
    expect(win.webContents.sentMessages).toContainEqual({
      channel: 'customer-display:refresh-config',
      payload: undefined,
    });

    manager.destroy();
  });

  it('reapplies bounds-based customer display layout when displays are added or removed', () => {
    configValues.customerDisplayForceKiosk = true;
    configValues.customerDisplayMonitor = 1;
    displays = [
      makeDisplay(1, 0, 0, 1920, 1080),
      makeDisplay(2, 1920, 0, 1280, 1024),
    ];
    primaryDisplay = displays[0];

    const manager = new WindowManager(posStore as any);
    const win = manager.createWindow('customer') as unknown as MockBrowserWindow;

    expect(win.boundsHistory.at(-1)).toEqual(displays[1].bounds);

    displays = [primaryDisplay];
    emitScreenEvent('display-removed');

    expect(win.boundsHistory.at(-1)).toEqual(primaryDisplay.bounds);
    expect(win.kioskHistory.at(-1)).toBe(true);

    displays = [
      primaryDisplay,
      makeDisplay(2, 1920, 0, 1280, 1024),
    ];
    emitScreenEvent('display-added');

    expect(win.boundsHistory.at(-1)).toEqual(displays[1].bounds);
    expect(win.alwaysOnTopHistory.at(-1)).toEqual({ flag: true, level: 'screen-saver' });

    manager.destroy();
  });

  it('does not steal focus back to customer display after blur', () => {
    const manager = new WindowManager(posStore as any);
    const win = manager.createWindow('customer') as unknown as MockBrowserWindow;

    win.emit('blur');
    vi.advanceTimersByTime(100);

    expect(win.focus).not.toHaveBeenCalled();

    manager.destroy();
  });

  it('opens self-checkout as a locked kiosk on the configured monitor', () => {
    configValues.selfCheckoutEnabled = true;
    configValues.selfCheckoutMonitor = 1;
    displays = [
      makeDisplay(1, 0, 0, 1920, 1080),
      makeDisplay(2, 1920, 0, 1280, 1024),
    ];
    primaryDisplay = displays[0];

    const manager = new WindowManager(posStore as any);
    const win = manager.createWindow('selfCheckout') as unknown as MockBrowserWindow;

    expect(win).toBeTruthy();
    expect(win.options.width).toBe(1280);
    expect(win.options.height).toBe(1024);
    expect(win.options.x).toBe(1920);
    expect(win.options.y).toBe(0);
    expect(win.options.kiosk).toBe(true);
    expect(win.options.fullscreen).toBe(true);
    expect(win.options.frame).toBe(false);
    expect(win.options.closable).toBe(false);
    expect(win.options.minimizable).toBe(false);
    expect(win.options.maximizable).toBe(false);
    expect(win.options.movable).toBe(false);
    expect(win.options.resizable).toBe(false);
    expect(win.options.skipTaskbar).toBe(true);
    expect(win.boundsHistory.at(-1)).toEqual(displays[1].bounds);
    expect(win.alwaysOnTopHistory).toContainEqual({ flag: true, level: 'screen-saver' });

    manager.destroy();
  });

  it('blocks self-checkout kiosk escape/debug shortcuts while preserving scanner input and staff exit', () => {
    configValues.selfCheckoutEnabled = true;

    const manager = new WindowManager(posStore as any);
    const win = manager.createWindow('selfCheckout') as unknown as MockBrowserWindow;

    const scannerDigit = emitBeforeInput(win, { key: '5' });
    expect(scannerDigit.preventDefault).not.toHaveBeenCalled();

    const scannerEnter = emitBeforeInput(win, { key: 'Enter' });
    expect(scannerEnter.preventDefault).not.toHaveBeenCalled();

    const escape = emitBeforeInput(win, { key: 'Escape' });
    expect(escape.preventDefault).toHaveBeenCalledOnce();
    expect(win.destroyed).toBe(false);

    const reload = emitBeforeInput(win, { key: 'r', control: true });
    expect(reload.preventDefault).toHaveBeenCalledOnce();

    const devtools = emitBeforeInput(win, { key: 'I', control: true, shift: true });
    expect(devtools.preventDefault).toHaveBeenCalledOnce();
    expect(win.webContents.toggleDevTools).not.toHaveBeenCalled();

    const staffExit = emitBeforeInput(win, { key: 'Q', control: true, shift: true });
    expect(staffExit.preventDefault).toHaveBeenCalledOnce();
    expect(win.destroyed).toBe(true);

    manager.destroy();
  });

  it('toggles fullscreen with F11 on ordinary POS windows', () => {
    const manager = new WindowManager(posStore as any);
    const win = manager.createWindow('pos') as unknown as MockBrowserWindow;

    const enter = emitBeforeInput(win, { key: 'F11' });
    expect(enter.preventDefault).toHaveBeenCalledOnce();
    expect(win.fullscreenHistory.at(-1)).toBe(true);

    const exit = emitBeforeInput(win, { key: 'F11' });
    expect(exit.preventDefault).toHaveBeenCalledOnce();
    expect(win.fullscreenHistory.at(-1)).toBe(false);

    manager.destroy();
  });

  it('handles POS zoom shortcuts with reset and clamping', () => {
    const manager = new WindowManager(posStore as any);
    const win = manager.createWindow('pos') as unknown as MockBrowserWindow;

    win.webContents.zoomLevel = -9;
    const reset = emitBeforeInput(win, { type: 'keyDown', key: '0', control: true });
    expect(reset.preventDefault).toHaveBeenCalledOnce();
    expect(win.webContents.zoomLevel).toBe(0);

    win.webContents.zoomLevel = -9;
    const zoomIn = emitBeforeInput(win, { type: 'keyDown', key: '=', code: 'Equal', control: true });
    expect(zoomIn.preventDefault).toHaveBeenCalledOnce();
    expect(win.webContents.zoomLevel).toBe(-3);

    win.webContents.zoomLevel = 9;
    const zoomOut = emitBeforeInput(win, { type: 'keyDown', key: '-', code: 'Minus', control: true });
    expect(zoomOut.preventDefault).toHaveBeenCalledOnce();
    expect(win.webContents.zoomLevel).toBe(3);

    manager.destroy();
  });

  it('closes only the sender self-checkout window through staff close IPC', () => {
    configValues.selfCheckoutEnabled = true;

    const manager = new WindowManager(posStore as any);
    const customerWin = manager.createWindow('customer') as unknown as MockBrowserWindow;
    const selfCheckoutWin = manager.createWindow('selfCheckout') as unknown as MockBrowserWindow;
    const handler = ipcHandlers.get('self-checkout:close');

    expect(handler).toBeDefined();
    expect(handler?.({ sender: customerWin.webContents })).toEqual({
      success: false,
      error: 'not_self_checkout_window',
    });
    expect(customerWin.destroyed).toBe(false);
    expect(selfCheckoutWin.destroyed).toBe(false);

    expect(handler?.({ sender: selfCheckoutWin.webContents })).toEqual({ success: true });
    expect(selfCheckoutWin.destroyed).toBe(true);

    manager.destroy();
  });

  it('restores self-checkout kiosk presentation after fullscreen loss and refocuses on blur', () => {
    configValues.selfCheckoutEnabled = true;

    const manager = new WindowManager(posStore as any);
    const win = manager.createWindow('selfCheckout') as unknown as MockBrowserWindow;

    win.setKiosk(false);
    win.emit('leave-full-screen');
    vi.advanceTimersByTime(50);

    expect(win.kioskHistory.at(-1)).toBe(true);
    expect(win.boundsHistory.at(-1)).toEqual(primaryDisplay.bounds);
    expect(win.alwaysOnTopHistory.at(-1)).toEqual({ flag: true, level: 'screen-saver' });

    win.emit('blur');
    vi.advanceTimersByTime(100);
    expect(win.focus).toHaveBeenCalled();

    manager.destroy();
  });
});
