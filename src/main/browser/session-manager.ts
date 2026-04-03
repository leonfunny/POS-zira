/**
 * Session Manager - Cookie & Session Persistence
 * Saves and loads browser sessions between runs
 * Makes bot appear as "returning user" instead of "new device"
 */

import * as fs from 'fs';
import * as path from 'path';
import { app } from 'electron';
import { BrowserContext, Page } from 'rebrowser-playwright-core';
import logger from '../logger';

// ============================================================================
// TYPES
// ============================================================================

export interface SavedCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires: number;
  httpOnly: boolean;
  secure: boolean;
  sameSite: 'Strict' | 'Lax' | 'None';
}

export interface SavedStorage {
  localStorage: Record<string, string>;
  sessionStorage: Record<string, string>;
}

export interface SavedSession {
  profileId: string;
  createdAt: number;
  updatedAt: number;
  cookies: SavedCookie[];
  storage: Record<string, SavedStorage>; // Key is origin (e.g., "https://facebook.com")
  metadata: {
    userAgent?: string;
    viewport?: { width: number; height: number };
    locale?: string;
    timezone?: string;
    lastUrl?: string;
  };
}

// ============================================================================
// SESSION MANAGER
// ============================================================================

export class SessionManager {
  private sessionsDir: string;
  private currentSession: SavedSession | null = null;
  private profileId: string;
  private autoSaveInterval: NodeJS.Timeout | null = null;

  constructor(profileId: string = 'default') {
    // Sanitize profileId to prevent path traversal
    if (!/^[a-zA-Z0-9_-]+$/.test(profileId)) {
      logger.warn(`[SessionManager] Invalid profileId "${profileId}", falling back to "default"`);
      profileId = 'default';
    }
    this.profileId = profileId;
    this.sessionsDir = path.join(app.getPath('userData'), 'browser-sessions');

    // Ensure sessions directory exists
    if (!fs.existsSync(this.sessionsDir)) {
      fs.mkdirSync(this.sessionsDir, { recursive: true });
    }

    logger.info(`[SessionManager] Initialized for profile: ${profileId}`);
  }

  /**
   * Get session file path for a profile
   */
  private getSessionPath(): string {
    return path.join(this.sessionsDir, `${this.profileId}.json`);
  }

  /**
   * Load session from disk
   */
  async loadSession(): Promise<SavedSession | null> {
    const sessionPath = this.getSessionPath();

    if (!fs.existsSync(sessionPath)) {
      logger.info(`[SessionManager] No saved session found for profile: ${this.profileId}`);
      return null;
    }

    try {
      const data = fs.readFileSync(sessionPath, 'utf-8');
      const session = JSON.parse(data) as SavedSession;

      // Check if session is too old (7 days)
      const maxAge = 7 * 24 * 60 * 60 * 1000; // 7 days in ms
      if (Date.now() - session.updatedAt > maxAge) {
        logger.info(`[SessionManager] Session expired, removing`);
        fs.unlinkSync(sessionPath);
        return null;
      }

      this.currentSession = session;
      logger.info(`[SessionManager] Loaded session with ${session.cookies.length} cookies`);
      return session;
    } catch (error: any) {
      logger.error(`[SessionManager] Failed to load session: ${error.message}`);
      return null;
    }
  }

  /**
   * Save session to disk
   */
  async saveSession(session: SavedSession): Promise<void> {
    const sessionPath = this.getSessionPath();

    try {
      session.updatedAt = Date.now();
      fs.writeFileSync(sessionPath, JSON.stringify(session, null, 2));
      this.currentSession = session;
      logger.info(`[SessionManager] Saved session with ${session.cookies.length} cookies`);
    } catch (error: any) {
      logger.error(`[SessionManager] Failed to save session: ${error.message}`);
    }
  }

  /**
   * Apply saved cookies to browser context
   */
  async applyCookies(context: BrowserContext): Promise<number> {
    const session = this.currentSession || await this.loadSession();
    if (!session || session.cookies.length === 0) {
      return 0;
    }

    try {
      // Filter out expired cookies
      const now = Date.now() / 1000;
      const validCookies = session.cookies.filter(c => c.expires === -1 || c.expires > now);

      if (validCookies.length > 0) {
        await context.addCookies(validCookies);
        logger.info(`[SessionManager] Applied ${validCookies.length} cookies`);
      }

      return validCookies.length;
    } catch (error: any) {
      logger.error(`[SessionManager] Failed to apply cookies: ${error.message}`);
      return 0;
    }
  }

  /**
   * Apply saved localStorage/sessionStorage to page
   */
  async applyStorage(page: Page, origin: string): Promise<void> {
    const session = this.currentSession;
    if (!session || !session.storage[origin]) {
      return;
    }

    const storage = session.storage[origin];

    try {
      await page.evaluate(({ localStorage, sessionStorage }) => {
        // Apply localStorage
        for (const [key, value] of Object.entries(localStorage)) {
          window.localStorage.setItem(key, value);
        }
        // Apply sessionStorage
        for (const [key, value] of Object.entries(sessionStorage)) {
          window.sessionStorage.setItem(key, value);
        }
      }, storage);

      logger.debug(`[SessionManager] Applied storage for ${origin}`);
    } catch (error: any) {
      logger.warn(`[SessionManager] Failed to apply storage: ${error.message}`);
    }
  }

  /**
   * Capture current cookies from browser context
   */
  async captureCookies(context: BrowserContext): Promise<SavedCookie[]> {
    try {
      const cookies = await context.cookies();
      logger.debug(`[SessionManager] Captured ${cookies.length} cookies`);
      return cookies as SavedCookie[];
    } catch (error: any) {
      logger.error(`[SessionManager] Failed to capture cookies: ${error.message}`);
      return [];
    }
  }

  /**
   * Capture localStorage/sessionStorage from page
   */
  async captureStorage(page: Page): Promise<SavedStorage> {
    try {
      const storage = await page.evaluate(() => {
        const ls: Record<string, string> = {};
        const ss: Record<string, string> = {};

        for (let i = 0; i < localStorage.length; i++) {
          const key = localStorage.key(i);
          if (key) ls[key] = localStorage.getItem(key) || '';
        }

        for (let i = 0; i < sessionStorage.length; i++) {
          const key = sessionStorage.key(i);
          if (key) ss[key] = sessionStorage.getItem(key) || '';
        }

        return { localStorage: ls, sessionStorage: ss };
      });

      return storage;
    } catch (error: any) {
      logger.warn(`[SessionManager] Failed to capture storage: ${error.message}`);
      return { localStorage: {}, sessionStorage: {} };
    }
  }

  /**
   * Save current browser state (cookies + storage)
   */
  async saveCurrentState(context: BrowserContext, page?: Page): Promise<void> {
    const cookies = await this.captureCookies(context);

    const session: SavedSession = this.currentSession || {
      profileId: this.profileId,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      cookies: [],
      storage: {},
      metadata: {},
    };

    session.cookies = cookies;
    session.updatedAt = Date.now();

    // Capture storage from page if provided
    if (page) {
      try {
        const url = page.url();
        const origin = new URL(url).origin;
        session.storage[origin] = await this.captureStorage(page);
        session.metadata.lastUrl = url;
      } catch (err: any) { logger.debug('[SessionManager] capture storage on save failed:', err?.message); }
    }

    await this.saveSession(session);
  }

  /**
   * Start auto-save interval (saves every N minutes)
   */
  startAutoSave(context: BrowserContext, intervalMinutes: number = 5): void {
    if (this.autoSaveInterval) {
      clearInterval(this.autoSaveInterval);
    }

    this.autoSaveInterval = setInterval(async () => {
      try {
        logger.debug('[SessionManager] Auto-saving session...');
        await this.saveCurrentState(context);
      } catch (error: any) {
        logger.error(`[SessionManager] Auto-save failed: ${error.message}`);
      }
    }, intervalMinutes * 60 * 1000);

    logger.info(`[SessionManager] Auto-save started (every ${intervalMinutes} minutes)`);
  }

  /**
   * Stop auto-save interval
   */
  stopAutoSave(): void {
    if (this.autoSaveInterval) {
      clearInterval(this.autoSaveInterval);
      this.autoSaveInterval = null;
      logger.info('[SessionManager] Auto-save stopped');
    }
  }

  /**
   * Delete saved session
   */
  deleteSession(): void {
    const sessionPath = this.getSessionPath();

    if (fs.existsSync(sessionPath)) {
      fs.unlinkSync(sessionPath);
      logger.info(`[SessionManager] Deleted session for profile: ${this.profileId}`);
    }

    this.currentSession = null;
  }

  /**
   * List all saved profiles
   */
  listProfiles(): string[] {
    try {
      const files = fs.readdirSync(this.sessionsDir);
      return files
        .filter(f => f.endsWith('.json'))
        .map(f => f.replace('.json', ''));
    } catch {
      return [];
    }
  }

  /**
   * Check if session exists for profile
   */
  hasSession(): boolean {
    return fs.existsSync(this.getSessionPath());
  }

  /**
   * Get session info without loading full data
   */
  getSessionInfo(): { exists: boolean; updatedAt?: number; cookieCount?: number } | null {
    const sessionPath = this.getSessionPath();

    if (!fs.existsSync(sessionPath)) {
      return { exists: false };
    }

    try {
      const data = fs.readFileSync(sessionPath, 'utf-8');
      const session = JSON.parse(data) as SavedSession;
      return {
        exists: true,
        updatedAt: session.updatedAt,
        cookieCount: session.cookies.length,
      };
    } catch {
      return { exists: false };
    }
  }

  /**
   * Update metadata
   */
  updateMetadata(metadata: Partial<SavedSession['metadata']>): void {
    if (this.currentSession) {
      this.currentSession.metadata = { ...this.currentSession.metadata, ...metadata };
    }
  }
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Create session manager for a specific site
 */
export function createSessionManager(site: 'facebook' | 'gmail' | 'booksy' | string): SessionManager {
  return new SessionManager(`site-${site}`);
}

/**
 * Default session manager instance
 */
let defaultSessionManager: SessionManager | null = null;

export function getDefaultSessionManager(): SessionManager {
  if (!defaultSessionManager) {
    defaultSessionManager = new SessionManager('default');
  }
  return defaultSessionManager;
}

logger.info('[SessionManager] Module loaded');
