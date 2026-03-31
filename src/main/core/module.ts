/**
 * AppModule interface and ModuleState enum
 *
 * Every domain module implements this interface. The orchestrator
 * drives the lifecycle: init → start → stop → destroy.
 */

import type { EventBus } from './event-bus';
import type { ToolDefinition } from './tool-registry';
import type SocketClient from '../network/socket-client';

export enum ModuleState {
  CREATED = 'CREATED',
  READY = 'READY',
  RUNNING = 'RUNNING',
  STOPPED = 'STOPPED',
  DESTROYED = 'DESTROYED',
  ERROR = 'ERROR',
}

export interface AppModule {
  /** Unique module name (e.g. 'hardware', 'pos', 'invoice') */
  readonly name: string;

  /** Current lifecycle state */
  readonly state: ModuleState;

  /**
   * Phase 1 – Resolve dependencies, validate config.
   * Called once before any IPC or events are wired.
   */
  init(): Promise<void>;

  /**
   * Phase 2 – Begin active work (timers, polling, listeners).
   * Called after all modules have been init'd and IPC is ready.
   */
  start(): Promise<void>;

  /**
   * Graceful shutdown – stop timers, close connections.
   */
  stop(): Promise<void>;

  /**
   * Final cleanup – release resources, null references.
   */
  destroy(): Promise<void>;

  /**
   * Register ipcMain.handle / ipcMain.on listeners.
   * Called once between init() and start().
   */
  registerIpcHandlers(): void;

  /**
   * Return OpenAI-compatible tool definitions owned by this module.
   * Called after init() so tools can reference resolved dependencies.
   */
  getToolDefinitions(): ToolDefinition[];

  /**
   * Subscribe to EventBus events from other modules.
   * Called once between init() and start().
   */
  registerEventHandlers(bus: EventBus): void;

  /**
   * Wire up real-time socket event listeners (optional).
   * Called once after socket is available, before start().
   */
  setupSocketHandlers?(socket: SocketClient): void;
}

/**
 * Base class with default no-op implementations.
 * Modules extend this and override only what they need.
 */
export abstract class BaseModule implements AppModule {
  abstract readonly name: string;
  private _state: ModuleState = ModuleState.CREATED;

  get state(): ModuleState {
    return this._state;
  }

  protected setState(s: ModuleState): void {
    this._state = s;
  }

  async init(): Promise<void> {
    this._state = ModuleState.READY;
  }

  async start(): Promise<void> {
    this._state = ModuleState.RUNNING;
  }

  async stop(): Promise<void> {
    this._state = ModuleState.STOPPED;
  }

  async destroy(): Promise<void> {
    this._state = ModuleState.DESTROYED;
  }

  registerIpcHandlers(): void {
    // override in subclass
  }

  getToolDefinitions(): ToolDefinition[] {
    return [];
  }

  registerEventHandlers(_bus: EventBus): void {
    // override in subclass
  }
}
