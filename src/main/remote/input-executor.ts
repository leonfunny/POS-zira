/**
 * Input Executor - Executes remote mouse and keyboard events
 * Uses @nut-tree-fork/nut-js for native input control
 */

import { screen } from 'electron';
import { EventEmitter } from 'events';
import {
  RemoteInputEvent,
  RemoteMouseEvent,
  RemoteKeyboardEvent,
  RemoteMouseButton,
} from '../../shared/types';

// Dynamic import for nut-js to handle cases where it's not installed
let nutMouse: any = null;
let nutKeyboard: any = null;
let nutButton: any = null;
let nutKey: any = null;

async function initNutJs(): Promise<boolean> {
  try {
    const nutjs = await import('@nut-tree-fork/nut-js');
    nutMouse = nutjs.mouse;
    nutKeyboard = nutjs.keyboard;
    nutButton = nutjs.Button;
    nutKey = nutjs.Key;
    console.log('[InputExecutor] nut-js initialized successfully');
    return true;
  } catch (error) {
    console.error('[InputExecutor] Failed to load @nut-tree-fork/nut-js:', error);
    console.error('[InputExecutor] Run: npm install @nut-tree-fork/nut-js');
    return false;
  }
}

// Rate limiting settings
const RATE_LIMITS = {
  mouse: 60,    // Max 60 mouse events per second
  keyboard: 30, // Max 30 keyboard events per second
};

export interface InputExecutorOptions {
  enabled?: boolean;
  rateLimitMouse?: number;
  rateLimitKeyboard?: number;
}

export class InputExecutor extends EventEmitter {
  private enabled = false;
  private initialized = false;
  private mouseEventCount = 0;
  private keyboardEventCount = 0;
  private lastMouseReset = Date.now();
  private lastKeyboardReset = Date.now();
  private rateLimitMouse: number;
  private rateLimitKeyboard: number;

  constructor(options: InputExecutorOptions = {}) {
    super();
    this.enabled = options.enabled ?? false;
    this.rateLimitMouse = options.rateLimitMouse ?? RATE_LIMITS.mouse;
    this.rateLimitKeyboard = options.rateLimitKeyboard ?? RATE_LIMITS.keyboard;
  }

  /**
   * Initialize the input executor
   */
  async initialize(): Promise<boolean> {
    if (this.initialized) {
      return true;
    }

    const success = await initNutJs();
    if (success) {
      this.initialized = true;
      // Configure nut-js for speed
      if (nutMouse) {
        nutMouse.config.autoDelayMs = 0;
        nutMouse.config.mouseSpeed = 2000; // Fast mouse movement
      }
      if (nutKeyboard) {
        nutKeyboard.config.autoDelayMs = 0;
      }
    }
    return success;
  }

  /**
   * Enable/disable input execution
   */
  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    console.log(`[InputExecutor] ${enabled ? 'Enabled' : 'Disabled'}`);
    this.emit('enabledChanged', enabled);
  }

  /**
   * Check if enabled
   */
  isEnabled(): boolean {
    return this.enabled && this.initialized;
  }

  /**
   * Execute an input event
   */
  async executeEvent(event: RemoteInputEvent): Promise<void> {
    if (!this.enabled || !this.initialized) {
      return;
    }

    try {
      if (event.type === 'mouse') {
        await this.executeMouseEvent(event);
      } else if (event.type === 'keyboard') {
        await this.executeKeyboardEvent(event);
      }
    } catch (error) {
      console.error('[InputExecutor] Error executing event:', error);
      this.emit('error', error);
    }
  }

  /**
   * Execute mouse event
   */
  private async executeMouseEvent(event: RemoteMouseEvent): Promise<void> {
    // Rate limiting
    const now = Date.now();
    if (now - this.lastMouseReset > 1000) {
      this.mouseEventCount = 0;
      this.lastMouseReset = now;
    }
    if (this.mouseEventCount >= this.rateLimitMouse) {
      return; // Rate limited
    }
    this.mouseEventCount++;

    // Convert normalized coordinates to screen coordinates
    const { x, y } = this.normalizedToScreen(event.x, event.y);

    switch (event.action) {
      case 'move':
        await nutMouse.setPosition({ x, y });
        break;

      case 'down':
        await nutMouse.setPosition({ x, y });
        await nutMouse.pressButton(this.toNutButton(event.button || 'left'));
        break;

      case 'up':
        await nutMouse.setPosition({ x, y });
        await nutMouse.releaseButton(this.toNutButton(event.button || 'left'));
        break;

      case 'click':
        await nutMouse.setPosition({ x, y });
        await nutMouse.click(this.toNutButton(event.button || 'left'));
        break;

      case 'dblclick':
        await nutMouse.setPosition({ x, y });
        await nutMouse.doubleClick(this.toNutButton(event.button || 'left'));
        break;

      case 'scroll':
        await nutMouse.setPosition({ x, y });
        if (event.deltaY) {
          // Scroll amount - positive is down, negative is up
          const scrollAmount = Math.round(event.deltaY / 10); // Reduce scroll speed
          await nutMouse.scrollDown(scrollAmount > 0 ? scrollAmount : 0);
          await nutMouse.scrollUp(scrollAmount < 0 ? Math.abs(scrollAmount) : 0);
        }
        if (event.deltaX) {
          const scrollAmount = Math.round(event.deltaX / 10);
          await nutMouse.scrollRight(scrollAmount > 0 ? scrollAmount : 0);
          await nutMouse.scrollLeft(scrollAmount < 0 ? Math.abs(scrollAmount) : 0);
        }
        break;
    }
  }

  /**
   * Execute keyboard event
   */
  private async executeKeyboardEvent(event: RemoteKeyboardEvent): Promise<void> {
    // Rate limiting
    const now = Date.now();
    if (now - this.lastKeyboardReset > 1000) {
      this.keyboardEventCount = 0;
      this.lastKeyboardReset = now;
    }
    if (this.keyboardEventCount >= this.rateLimitKeyboard) {
      return; // Rate limited
    }
    this.keyboardEventCount++;

    const nutKey = this.toNutKey(event.code, event.key);
    if (!nutKey) {
      console.warn(`[InputExecutor] Unknown key: ${event.code} (${event.key})`);
      return;
    }

    // Handle modifiers
    const modifiers: any[] = [];
    if (event.modifiers.ctrl) modifiers.push(this.toNutKey('ControlLeft', 'Control'));
    if (event.modifiers.alt) modifiers.push(this.toNutKey('AltLeft', 'Alt'));
    if (event.modifiers.shift) modifiers.push(this.toNutKey('ShiftLeft', 'Shift'));
    if (event.modifiers.meta) modifiers.push(this.toNutKey('MetaLeft', 'Meta'));

    if (event.action === 'down') {
      // Press modifiers first
      for (const mod of modifiers) {
        if (mod) await nutKeyboard.pressKey(mod);
      }
      await nutKeyboard.pressKey(nutKey);
    } else if (event.action === 'up') {
      await nutKeyboard.releaseKey(nutKey);
      // Release modifiers in reverse order
      for (const mod of modifiers.reverse()) {
        if (mod) await nutKeyboard.releaseKey(mod);
      }
    }
  }

  /**
   * Convert normalized coordinates (0-1) to screen coordinates
   */
  private normalizedToScreen(normalX: number, normalY: number): { x: number; y: number } {
    const primaryDisplay = screen.getPrimaryDisplay();
    const { width, height } = primaryDisplay.size;

    // Clamp values between 0 and 1
    const clampedX = Math.max(0, Math.min(1, normalX));
    const clampedY = Math.max(0, Math.min(1, normalY));

    return {
      x: Math.round(clampedX * width),
      y: Math.round(clampedY * height),
    };
  }

  /**
   * Convert mouse button to nut-js button
   */
  private toNutButton(button: RemoteMouseButton): any {
    if (!nutButton) return null;
    switch (button) {
      case 'left':
        return nutButton.LEFT;
      case 'middle':
        return nutButton.MIDDLE;
      case 'right':
        return nutButton.RIGHT;
      default:
        return nutButton.LEFT;
    }
  }

  /**
   * Convert key code to nut-js key
   */
  private toNutKey(code: string, key: string): any {
    if (!nutKey) return null;

    // Map common key codes to nut-js keys
    const keyMap: Record<string, any> = {
      // Letters
      KeyA: nutKey.A, KeyB: nutKey.B, KeyC: nutKey.C, KeyD: nutKey.D,
      KeyE: nutKey.E, KeyF: nutKey.F, KeyG: nutKey.G, KeyH: nutKey.H,
      KeyI: nutKey.I, KeyJ: nutKey.J, KeyK: nutKey.K, KeyL: nutKey.L,
      KeyM: nutKey.M, KeyN: nutKey.N, KeyO: nutKey.O, KeyP: nutKey.P,
      KeyQ: nutKey.Q, KeyR: nutKey.R, KeyS: nutKey.S, KeyT: nutKey.T,
      KeyU: nutKey.U, KeyV: nutKey.V, KeyW: nutKey.W, KeyX: nutKey.X,
      KeyY: nutKey.Y, KeyZ: nutKey.Z,

      // Numbers
      Digit0: nutKey.Num0, Digit1: nutKey.Num1, Digit2: nutKey.Num2,
      Digit3: nutKey.Num3, Digit4: nutKey.Num4, Digit5: nutKey.Num5,
      Digit6: nutKey.Num6, Digit7: nutKey.Num7, Digit8: nutKey.Num8,
      Digit9: nutKey.Num9,

      // Numpad
      Numpad0: nutKey.NumPad0, Numpad1: nutKey.NumPad1, Numpad2: nutKey.NumPad2,
      Numpad3: nutKey.NumPad3, Numpad4: nutKey.NumPad4, Numpad5: nutKey.NumPad5,
      Numpad6: nutKey.NumPad6, Numpad7: nutKey.NumPad7, Numpad8: nutKey.NumPad8,
      Numpad9: nutKey.NumPad9,
      NumpadMultiply: nutKey.NumPadMultiply, NumpadAdd: nutKey.NumPadAdd,
      NumpadSubtract: nutKey.NumPadSubtract, NumpadDecimal: nutKey.NumPadDecimal,
      NumpadDivide: nutKey.NumPadDivide, NumpadEnter: nutKey.Enter,

      // Function keys
      F1: nutKey.F1, F2: nutKey.F2, F3: nutKey.F3, F4: nutKey.F4,
      F5: nutKey.F5, F6: nutKey.F6, F7: nutKey.F7, F8: nutKey.F8,
      F9: nutKey.F9, F10: nutKey.F10, F11: nutKey.F11, F12: nutKey.F12,

      // Control keys
      Enter: nutKey.Enter, Tab: nutKey.Tab, Space: nutKey.Space,
      Backspace: nutKey.Backspace, Delete: nutKey.Delete,
      Escape: nutKey.Escape, Insert: nutKey.Insert,
      Home: nutKey.Home, End: nutKey.End,
      PageUp: nutKey.PageUp, PageDown: nutKey.PageDown,

      // Arrow keys
      ArrowUp: nutKey.Up, ArrowDown: nutKey.Down,
      ArrowLeft: nutKey.Left, ArrowRight: nutKey.Right,

      // Modifiers
      ShiftLeft: nutKey.LeftShift, ShiftRight: nutKey.RightShift,
      ControlLeft: nutKey.LeftControl, ControlRight: nutKey.RightControl,
      AltLeft: nutKey.LeftAlt, AltRight: nutKey.RightAlt,
      MetaLeft: nutKey.LeftWin, MetaRight: nutKey.RightWin,
      CapsLock: nutKey.CapsLock, NumLock: nutKey.NumLock,

      // Punctuation
      Minus: nutKey.Minus, Equal: nutKey.Equal,
      BracketLeft: nutKey.LeftBracket, BracketRight: nutKey.RightBracket,
      Backslash: nutKey.Backslash, Semicolon: nutKey.Semicolon,
      Quote: nutKey.Quote, Backquote: nutKey.Grave,
      Comma: nutKey.Comma, Period: nutKey.Period, Slash: nutKey.Slash,

      // Print Screen, Scroll Lock, Pause
      PrintScreen: nutKey.Print, ScrollLock: nutKey.ScrollLock, Pause: nutKey.Pause,
    };

    return keyMap[code] || null;
  }

  /**
   * Get screen dimensions
   */
  getScreenDimensions(): { width: number; height: number } {
    const primaryDisplay = screen.getPrimaryDisplay();
    return primaryDisplay.size;
  }

  /**
   * Type text using keyboard (for Telegram commands)
   */
  async typeText(text: string): Promise<void> {
    if (!this.initialized) {
      throw new Error('Input executor not initialized');
    }
    if (!nutKeyboard) {
      throw new Error('Keyboard not available');
    }
    await nutKeyboard.type(text);
  }

  /**
   * Click at specific screen coordinates (for Telegram commands)
   */
  async clickAt(x: number, y: number): Promise<void> {
    if (!this.initialized) {
      throw new Error('Input executor not initialized');
    }
    if (!nutMouse || !nutButton) {
      throw new Error('Mouse not available');
    }
    await nutMouse.setPosition({ x, y });
    await nutMouse.click(nutButton.LEFT);
  }

  /**
   * Check if initialized
   */
  isInitialized(): boolean {
    return this.initialized;
  }

  /**
   * Double click at specific screen coordinates
   */
  async doubleClickAt(x: number, y: number): Promise<void> {
    if (!this.initialized) {
      throw new Error('Input executor not initialized');
    }
    if (!nutMouse || !nutButton) {
      throw new Error('Mouse not available');
    }
    await nutMouse.setPosition({ x, y });
    await nutMouse.doubleClick(nutButton.LEFT);
  }

  /**
   * Right click at specific screen coordinates
   */
  async rightClickAt(x: number, y: number): Promise<void> {
    if (!this.initialized) {
      throw new Error('Input executor not initialized');
    }
    if (!nutMouse || !nutButton) {
      throw new Error('Mouse not available');
    }
    await nutMouse.setPosition({ x, y });
    await nutMouse.click(nutButton.RIGHT);
  }

  /**
   * Scroll at current position or specified position
   */
  async scroll(direction: 'up' | 'down' | 'left' | 'right', amount: number = 3): Promise<void> {
    if (!this.initialized) {
      throw new Error('Input executor not initialized');
    }
    if (!nutMouse) {
      throw new Error('Mouse not available');
    }
    switch (direction) {
      case 'up':
        await nutMouse.scrollUp(amount);
        break;
      case 'down':
        await nutMouse.scrollDown(amount);
        break;
      case 'left':
        await nutMouse.scrollLeft(amount);
        break;
      case 'right':
        await nutMouse.scrollRight(amount);
        break;
    }
  }

  /**
   * Drag from one position to another
   */
  async drag(x1: number, y1: number, x2: number, y2: number): Promise<void> {
    if (!this.initialized) {
      throw new Error('Input executor not initialized');
    }
    if (!nutMouse || !nutButton) {
      throw new Error('Mouse not available');
    }
    await nutMouse.setPosition({ x: x1, y: y1 });
    await nutMouse.pressButton(nutButton.LEFT);
    await nutMouse.setPosition({ x: x2, y: y2 });
    await nutMouse.releaseButton(nutButton.LEFT);
  }

  /**
   * Press a single key by name
   */
  async pressKey(keyName: string): Promise<void> {
    if (!this.initialized) {
      throw new Error('Input executor not initialized');
    }
    if (!nutKeyboard || !nutKey) {
      throw new Error('Keyboard not available');
    }

    const key = this.getKeyByName(keyName);
    if (!key) {
      throw new Error(`Unknown key: ${keyName}`);
    }

    await nutKeyboard.pressKey(key);
    await nutKeyboard.releaseKey(key);
  }

  /**
   * Press a hotkey combination (e.g., ['ctrl', 'c'] for Ctrl+C)
   */
  async pressHotkey(keys: string[]): Promise<void> {
    if (!this.initialized) {
      throw new Error('Input executor not initialized');
    }
    if (!nutKeyboard || !nutKey) {
      throw new Error('Keyboard not available');
    }

    const nutKeys = keys.map(k => this.getKeyByName(k)).filter(k => k !== null);
    if (nutKeys.length !== keys.length) {
      throw new Error(`Some keys not found: ${keys.join('+')}`);
    }

    // Press all keys
    for (const key of nutKeys) {
      await nutKeyboard.pressKey(key);
    }

    // Release in reverse order
    for (const key of nutKeys.reverse()) {
      await nutKeyboard.releaseKey(key);
    }
  }

  /**
   * Get nut-js key by friendly name
   */
  private getKeyByName(name: string): any {
    if (!nutKey) return null;

    const normalizedName = name.toLowerCase().trim();

    // Common key name mappings
    const friendlyKeyMap: Record<string, any> = {
      // Modifiers
      'ctrl': nutKey.LeftControl,
      'control': nutKey.LeftControl,
      'alt': nutKey.LeftAlt,
      'shift': nutKey.LeftShift,
      'win': nutKey.LeftWin,
      'windows': nutKey.LeftWin,
      'meta': nutKey.LeftWin,
      'cmd': nutKey.LeftWin,
      'command': nutKey.LeftWin,

      // Special keys
      'enter': nutKey.Enter,
      'return': nutKey.Enter,
      'tab': nutKey.Tab,
      'space': nutKey.Space,
      'backspace': nutKey.Backspace,
      'delete': nutKey.Delete,
      'del': nutKey.Delete,
      'escape': nutKey.Escape,
      'esc': nutKey.Escape,
      'insert': nutKey.Insert,
      'ins': nutKey.Insert,
      'home': nutKey.Home,
      'end': nutKey.End,
      'pageup': nutKey.PageUp,
      'pgup': nutKey.PageUp,
      'pagedown': nutKey.PageDown,
      'pgdn': nutKey.PageDown,
      'capslock': nutKey.CapsLock,
      'numlock': nutKey.NumLock,
      'scrolllock': nutKey.ScrollLock,
      'printscreen': nutKey.Print,
      'prtsc': nutKey.Print,

      // Arrow keys
      'up': nutKey.Up,
      'down': nutKey.Down,
      'left': nutKey.Left,
      'right': nutKey.Right,
      'arrowup': nutKey.Up,
      'arrowdown': nutKey.Down,
      'arrowleft': nutKey.Left,
      'arrowright': nutKey.Right,

      // Function keys
      'f1': nutKey.F1, 'f2': nutKey.F2, 'f3': nutKey.F3, 'f4': nutKey.F4,
      'f5': nutKey.F5, 'f6': nutKey.F6, 'f7': nutKey.F7, 'f8': nutKey.F8,
      'f9': nutKey.F9, 'f10': nutKey.F10, 'f11': nutKey.F11, 'f12': nutKey.F12,

      // Letters
      'a': nutKey.A, 'b': nutKey.B, 'c': nutKey.C, 'd': nutKey.D,
      'e': nutKey.E, 'f': nutKey.F, 'g': nutKey.G, 'h': nutKey.H,
      'i': nutKey.I, 'j': nutKey.J, 'k': nutKey.K, 'l': nutKey.L,
      'm': nutKey.M, 'n': nutKey.N, 'o': nutKey.O, 'p': nutKey.P,
      'q': nutKey.Q, 'r': nutKey.R, 's': nutKey.S, 't': nutKey.T,
      'u': nutKey.U, 'v': nutKey.V, 'w': nutKey.W, 'x': nutKey.X,
      'y': nutKey.Y, 'z': nutKey.Z,

      // Numbers
      '0': nutKey.Num0, '1': nutKey.Num1, '2': nutKey.Num2, '3': nutKey.Num3,
      '4': nutKey.Num4, '5': nutKey.Num5, '6': nutKey.Num6, '7': nutKey.Num7,
      '8': nutKey.Num8, '9': nutKey.Num9,
    };

    return friendlyKeyMap[normalizedName] || null;
  }

  /**
   * Cleanup resources
   */
  destroy(): void {
    this.enabled = false;
    this.removeAllListeners();
    console.log('[InputExecutor] Destroyed');
  }
}
