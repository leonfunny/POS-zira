/**
 * Typed EventBus for cross-module communication
 *
 * Replaces direct socket.on() → this.method() coupling in app.ts.
 * Each event has a typed payload so modules stay decoupled but type-safe.
 */

import { EventEmitter } from 'events';
import logger from '../logger';

// ─── Event Catalog ──────────────────────────────────────────────

export interface AppEvents {
  // Connection lifecycle
  'socket:connected': { salonId?: string; salonName?: string };
  'socket:disconnected': { reason?: string };

  // Auth
  'user:logged-in': { userId: string; salonId: string; salonName?: string; salonSwitched?: boolean };
  'user:logged-out': { reason?: string };
  'salon:switching': { salonName?: string };

  // Print jobs
  'print:job-received': {
    jobId: string;
    jobType: string;
    printerType?: string;
    printerId?: string | null;
    referenceType?: string | null;
    referenceId?: string | null;
    openDrawer?: boolean;
    createdAt?: string;
    payload: unknown;
  };
  'print:job-completed': { jobId: string };
  'print:job-failed': { jobId: string; error: string };

  // Hardware
  'barcode:scanned': { barcode: string; source: string };
  'printer:status-changed': { printerType: string; connected: boolean };
  'hardware:printer-errors': { errors: string[] };
  'hardware:status-changed': { printerConnected: boolean; printerPort: string | null; scannerActive: boolean; appVersion: string };

  // Sync
  'sync:products-synced': { count: number };
  'sync:catalog-updated': { productId: string; data: unknown };
  'sync:stock-updated': { variantId: string; warehouseId: string; quantity: number };

  // POS
  'pos:order-created': { orderId: string; total: number };
  'pos:payment-completed': { orderId: string; method: string; amount: number };
  'pos:shift-opened': { shiftId: string; staffId: string };
  'pos:shift-closed': { shiftId: string };

  // AI
  'ai:tool-executed': { toolName: string; module: string; durationMs: number };

  // Extension
  'extension:connected': {};
  'extension:disconnected': {};

  // Booksy
  'booksy:sync-completed': { entityCount: number };
  'booksy:status-changed': { status: string };

  // Billiard
  'billiard:data-updated': { type: 'dashboard' | 'session' | 'resource' | 'combo' };
  'billiard:mutation-queued': { operation: string; queueSize: number };
  'billiard:queue-replayed': { ok: number; failed: number };

  // Remote
  'remote:session-request': { sessionId: string; userId: string };
  'remote:session-started': { sessionId: string };
  'remote:session-ended': { sessionId: string; reason?: string };

  // Telegram
  'telegram:bot-started': {};
  'telegram:bot-stopped': { reason?: string };

  // Config
  'config:changed': { changedKeys: string[] };

  // Window lifecycle
  'window:main-ready': {};
  'window:main-closed': {};
  'window:pos-ready': {};
  'window:pos-closed': {};
}

export type AppEventName = keyof AppEvents;

// ─── EventBus Class ─────────────────────────────────────────────

export class EventBus {
  private emitter = new EventEmitter();

  constructor() {
    // Allow many listeners (modules subscribe independently)
    this.emitter.setMaxListeners(50);
  }

  /**
   * Emit a typed event.
   */
  emit<K extends AppEventName>(event: K, payload: AppEvents[K]): void {
    logger.debug(`[EventBus] ${event}`);
    try {
      this.emitter.emit(event, payload);
    } catch (error) {
      logger.error(`[EventBus] Error in handler for "${event}":`, error);
    }
  }

  /**
   * Subscribe to a typed event.
   */
  on<K extends AppEventName>(event: K, handler: (payload: AppEvents[K]) => void): void {
    this.emitter.on(event, handler);
  }

  /**
   * Subscribe once.
   */
  once<K extends AppEventName>(event: K, handler: (payload: AppEvents[K]) => void): void {
    this.emitter.once(event, handler);
  }

  /**
   * Unsubscribe.
   */
  off<K extends AppEventName>(event: K, handler: (payload: AppEvents[K]) => void): void {
    this.emitter.off(event, handler);
  }

  /**
   * Remove all listeners (for shutdown).
   */
  removeAllListeners(): void {
    this.emitter.removeAllListeners();
  }
}
