/**
 * Browser Controller - Playwright-based browser automation
 * Provides high-level browser control for Telegram commands
 * Now with human-like behavior to avoid bot detection
 */

// Using rebrowser-playwright-core to bypass CDP Runtime.enable detection
// This is a drop-in replacement that fixes automation detection leaks
import { chromium, Browser, BrowserContext, Page } from 'rebrowser-playwright-core';
import logger from '../logger';
import { ensureChromeNotRunning, isChromeRunning } from './chrome-checker';
import {
  applyStealthSettings,
  getRealisticViewport,
  getRealisticUserAgent,
  getLocationProfile,
  getStealthLaunchArgs,
  humanClick,
  humanClickElement,
  humanType,
  humanScroll,
  humanDelay,
  shortPause,
  mediumPause,
  simulateReading,
  simulateFacebookBrowsing,
  rateLimiter,
  sessionTracker,
  safeAction,
} from './human-behavior';
import { SessionManager, createSessionManager } from './session-manager';

export interface BrowserTab {
  id: string;
  title: string;
  url: string;
}

export interface BrowserControllerOptions {
  headless?: boolean;
  defaultTimeout?: number;
  checkChromeBeforeLaunch?: boolean; // Check if Chrome is running and prompt user
  profileId?: string; // Profile ID for session persistence (e.g., 'facebook', 'booksy')
  autoSaveInterval?: number; // Auto-save session every N minutes (default: 5)
}

export class BrowserController {
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private pages: Map<string, Page> = new Map();
  private currentPageId: string | null = null;
  private options: BrowserControllerOptions;
  private sessionManager: SessionManager;

  constructor(options: BrowserControllerOptions = {}) {
    this.options = {
      headless: false, // Show browser by default for remote control
      defaultTimeout: 30000,
      checkChromeBeforeLaunch: true, // Check Chrome by default
      profileId: 'default',
      autoSaveInterval: 5, // Auto-save every 5 minutes
      ...options,
    };

    // Initialize session manager for cookie persistence
    this.sessionManager = new SessionManager(this.options.profileId);
  }

  /**
   * Check if Chrome is currently running
   */
  async isChromeRunning(): Promise<boolean> {
    const result = await isChromeRunning();
    return result.isRunning;
  }

  /**
   * Check Chrome and prompt user to close if running
   * Returns true if ready to proceed
   */
  async checkChromeAndPrompt(): Promise<boolean> {
    return ensureChromeNotRunning();
  }

  /**
   * Launch browser if not already running
   * @param skipChromeCheck - Skip Chrome check (useful for internal calls)
   */
  async ensureBrowser(skipChromeCheck = false): Promise<void> {
    if (this.browser && this.browser.isConnected()) {
      return;
    }

    // Check if Chrome is running and prompt user
    if (this.options.checkChromeBeforeLaunch && !skipChromeCheck) {
      const ready = await ensureChromeNotRunning();
      if (!ready) {
        throw new Error('Chrome is running. Please close Chrome and try again.');
      }
    }

    logger.info('[Browser] Launching browser with anti-detection...');
    try {
      // Get realistic browser settings
      const viewport = getRealisticViewport();
      const userAgent = getRealisticUserAgent();

      // Auto-detect location from system timezone
      const location = getLocationProfile();

      this.browser = await chromium.launch({
        headless: this.options.headless,
        args: getStealthLaunchArgs(),
      });

      this.context = await this.browser.newContext({
        viewport,
        userAgent,
        // Auto-detected location settings
        locale: location.locale,
        timezoneId: location.timezoneId,
        geolocation: location.geolocation,
        permissions: ['geolocation'],
        // Realistic device settings
        deviceScaleFactor: 1,
        isMobile: false,
        hasTouch: false,
      });

      // Apply saved cookies from previous session (makes bot look like "returning user")
      const cookieCount = await this.sessionManager.applyCookies(this.context);
      if (cookieCount > 0) {
        logger.info(`[Browser] Restored ${cookieCount} cookies from previous session`);
      }

      // Start auto-save to persist session changes
      this.sessionManager.startAutoSave(this.context, this.options.autoSaveInterval);

      logger.info(`[Browser] Browser launched with viewport ${viewport.width}x${viewport.height}`);
      logger.info(`[Browser] Location: ${location.city}, ${location.country} (${location.locale})`);
      logger.info(`[Browser] Timezone: ${location.timezoneId}`);
    } catch (error: any) {
      logger.error('[Browser] Failed to launch browser:', error);
      throw new Error(`Failed to launch browser: ${error.message}`);
    }
  }

  /**
   * Navigate to URL (creates new page if needed)
   * Now with human-like behavior and stealth
   */
  async navigate(url: string): Promise<{ pageId: string; title: string }> {
    await this.ensureBrowser();

    // Add protocol if missing
    const fullUrl = url.startsWith('http') ? url : `https://${url}`;

    let page: Page;
    let pageId: string;

    if (this.currentPageId && this.pages.has(this.currentPageId)) {
      // Use current page
      page = this.pages.get(this.currentPageId)!;
      pageId = this.currentPageId;
    } else {
      // Create new page
      page = await this.context!.newPage();
      pageId = `page_${Date.now()}`;
      this.pages.set(pageId, page);
      this.currentPageId = pageId;
      this.setupPageHandlers(page, pageId);

      // Apply stealth settings to new page
      await applyStealthSettings(page);
    }

    logger.info(`[Browser] Navigating to: ${fullUrl}`);

    // Add human-like delay before navigation
    await humanDelay(500, 0.5);

    await page.goto(fullUrl, { waitUntil: 'domcontentloaded', timeout: this.options.defaultTimeout });

    // Apply saved localStorage/sessionStorage for this origin
    try {
      const origin = new URL(fullUrl).origin;
      await this.sessionManager.applyStorage(page, origin);
    } catch (err: any) { logger.debug('[BrowserController] apply storage failed:', err?.message); }

    // Wait for page to settle (human-like)
    await humanDelay(1000, 0.5);

    const title = await page.title();

    // Small pause after page load (reading title/content)
    await shortPause();

    return { pageId, title };
  }

  /**
   * Take screenshot of current page
   */
  async screenshot(): Promise<Buffer> {
    const page = this.getCurrentPage();
    if (!page) {
      throw new Error('No page open. Use /browse <url> first.');
    }

    logger.info('[Browser] Taking screenshot...');
    const buffer = await page.screenshot({ type: 'png', fullPage: false });
    return buffer;
  }

  /**
   * Take full page screenshot
   */
  async screenshotFull(): Promise<Buffer> {
    const page = this.getCurrentPage();
    if (!page) {
      throw new Error('No page open. Use /browse <url> first.');
    }

    logger.info('[Browser] Taking full page screenshot...');
    const buffer = await page.screenshot({ type: 'png', fullPage: true });
    return buffer;
  }

  /**
   * Click on element by selector (human-like)
   */
  async click(selector: string): Promise<void> {
    const page = this.getCurrentPage();
    if (!page) {
      throw new Error('No page open. Use /browse <url> first.');
    }

    logger.info(`[Browser] Human-like clicking: ${selector}`);
    // Use human-like click instead of direct click
    const clicked = await humanClickElement(page, selector);
    if (!clicked) {
      // Fallback to direct click if human click fails
      await page.click(selector, { timeout: this.options.defaultTimeout });
    }
  }

  /**
   * Click at coordinates (human-like with mouse movement)
   */
  async clickAt(x: number, y: number): Promise<void> {
    const page = this.getCurrentPage();
    if (!page) {
      throw new Error('No page open. Use /browse <url> first.');
    }

    logger.info(`[Browser] Human-like clicking at: (${x}, ${y})`);
    await humanClick(page, x, y);
  }

  /**
   * Type text into element (human-like with variable speed)
   */
  async type(selector: string, text: string): Promise<void> {
    const page = this.getCurrentPage();
    if (!page) {
      throw new Error('No page open. Use /browse <url> first.');
    }

    logger.info(`[Browser] Human-like typing into: ${selector}`);
    // Use human-like typing with variable delays
    await humanType(page, text, { selector });
  }

  /**
   * Type text at current focus (human-like)
   */
  async typeText(text: string): Promise<void> {
    const page = this.getCurrentPage();
    if (!page) {
      throw new Error('No page open. Use /browse <url> first.');
    }

    logger.info(`[Browser] Human-like typing: ${text.substring(0, 20)}...`);
    await humanType(page, text);
  }

  /**
   * Press key (with human-like delay)
   */
  async pressKey(key: string): Promise<void> {
    const page = this.getCurrentPage();
    if (!page) {
      throw new Error('No page open. Use /browse <url> first.');
    }

    // Add small delay before pressing (human hesitation)
    await humanDelay(100, 0.5);
    logger.info(`[Browser] Pressing key: ${key}`);
    await page.keyboard.press(key);
    await humanDelay(50, 0.3);
  }

  /**
   * Scroll page (human-like with variable speed)
   */
  async scroll(direction: 'up' | 'down' | 'left' | 'right', amount: number = 300): Promise<void> {
    const page = this.getCurrentPage();
    if (!page) {
      throw new Error('No page open. Use /browse <url> first.');
    }

    logger.info(`[Browser] Human-like scrolling ${direction} by ${amount}px`);

    // Use human scroll for up/down
    if (direction === 'up' || direction === 'down') {
      await humanScroll(page, { direction, distance: amount, readContent: true });
    } else {
      // Left/right scroll (less common, simpler)
      const scrollMap = {
        left: [-amount, 0],
        right: [amount, 0],
      };
      const [x, y] = scrollMap[direction];
      await page.mouse.wheel(x, y);
    }
  }

  /**
   * Go back
   */
  async goBack(): Promise<void> {
    const page = this.getCurrentPage();
    if (!page) {
      throw new Error('No page open. Use /browse <url> first.');
    }

    logger.info('[Browser] Going back');
    await page.goBack({ timeout: this.options.defaultTimeout });
  }

  /**
   * Go forward
   */
  async goForward(): Promise<void> {
    const page = this.getCurrentPage();
    if (!page) {
      throw new Error('No page open. Use /browse <url> first.');
    }

    logger.info('[Browser] Going forward');
    await page.goForward({ timeout: this.options.defaultTimeout });
  }

  /**
   * Refresh page
   */
  async refresh(): Promise<void> {
    const page = this.getCurrentPage();
    if (!page) {
      throw new Error('No page open. Use /browse <url> first.');
    }

    logger.info('[Browser] Refreshing page');
    await page.reload({ timeout: this.options.defaultTimeout });
  }

  /**
   * Evaluate JavaScript in page
   */
  async evaluate(script: string): Promise<any> {
    const page = this.getCurrentPage();
    if (!page) {
      throw new Error('No page open. Use /browse <url> first.');
    }

    logger.info(`[Browser] Evaluating script: ${script.substring(0, 50)}...`);
    return await page.evaluate(script);
  }

  /**
   * Get page info
   */
  async getPageInfo(): Promise<{ title: string; url: string }> {
    const page = this.getCurrentPage();
    if (!page) {
      throw new Error('No page open. Use /browse <url> first.');
    }

    return {
      title: await page.title(),
      url: page.url(),
    };
  }

  /**
   * Get page text content
   */
  async getPageText(): Promise<string> {
    const page = this.getCurrentPage();
    if (!page) {
      throw new Error('No page open. Use /browse <url> first.');
    }

    const text = await page.evaluate(() => document.body.innerText);
    return text.substring(0, 4000); // Limit to 4000 chars for Telegram
  }

  /**
   * List all open tabs
   */
  async listTabs(): Promise<BrowserTab[]> {
    const tabs: BrowserTab[] = [];

    for (const [id, page] of this.pages) {
      try {
        if (!page.isClosed()) {
          tabs.push({
            id,
            title: await page.title(),
            url: page.url(),
          });
        } else {
          this.pages.delete(id);
        }
      } catch {
        this.pages.delete(id);
      }
    }

    return tabs;
  }

  /**
   * Switch to tab by ID
   */
  async switchTab(tabId: string): Promise<void> {
    if (!this.pages.has(tabId)) {
      throw new Error(`Tab not found: ${tabId}`);
    }

    this.currentPageId = tabId;
    const page = this.pages.get(tabId)!;
    await page.bringToFront();
    logger.info(`[Browser] Switched to tab: ${tabId}`);
  }

  /**
   * Close tab by ID
   */
  async closeTab(tabId?: string): Promise<void> {
    const id = tabId || this.currentPageId;
    if (!id || !this.pages.has(id)) {
      throw new Error('No tab to close');
    }

    const page = this.pages.get(id)!;
    await page.close();
    this.pages.delete(id);

    if (this.currentPageId === id) {
      // Switch to another tab or null
      const remaining = Array.from(this.pages.keys());
      this.currentPageId = remaining.length > 0 ? remaining[0] : null;
    }

    logger.info(`[Browser] Closed tab: ${id}`);
  }

  /**
   * New tab
   */
  async newTab(url?: string): Promise<string> {
    await this.ensureBrowser();

    const page = await this.context!.newPage();
    const pageId = `page_${Date.now()}`;
    this.pages.set(pageId, page);
    this.currentPageId = pageId;
    this.setupPageHandlers(page, pageId);

    if (url) {
      const fullUrl = url.startsWith('http') ? url : `https://${url}`;
      await page.goto(fullUrl, { waitUntil: 'domcontentloaded' });
    }

    logger.info(`[Browser] New tab created: ${pageId}`);
    return pageId;
  }

  /**
   * Close browser
   */
  async close(): Promise<void> {
    if (this.browser) {
      logger.info('[Browser] Closing browser...');

      // Stop auto-save
      this.sessionManager.stopAutoSave();

      // Save session before closing (cookies + storage from current page)
      if (this.context) {
        const currentPage = this.getCurrentPage();
        await this.sessionManager.saveCurrentState(this.context, currentPage || undefined);
        logger.info('[Browser] Session saved for next run');
      }

      await this.browser.close();
      this.browser = null;
      this.context = null;
      this.pages.clear();
      this.currentPageId = null;
      logger.info('[Browser] Browser closed');
    }
  }

  /**
   * Check if browser is running
   */
  isRunning(): boolean {
    return this.browser !== null && this.browser.isConnected();
  }

  /**
   * Get current page
   */
  private getCurrentPage(): Page | null {
    if (!this.currentPageId) return null;
    const page = this.pages.get(this.currentPageId);
    if (!page || page.isClosed()) {
      this.pages.delete(this.currentPageId);
      this.currentPageId = null;
      return null;
    }
    return page;
  }

  /**
   * Setup page event handlers
   */
  private setupPageHandlers(page: Page, pageId: string): void {
    page.on('close', () => {
      logger.info(`[Browser] Page closed: ${pageId}`);
      this.pages.delete(pageId);
      if (this.currentPageId === pageId) {
        const remaining = Array.from(this.pages.keys());
        this.currentPageId = remaining.length > 0 ? remaining[0] : null;
      }
    });
  }

  /**
   * Browse Facebook like a human (scroll, read, occasionally interact)
   */
  async browseFacebookHumanLike(options?: {
    postsToView?: number;
    interactionRate?: number;
  }): Promise<{ postsViewed: number; interactions: number; content: string }> {
    const page = this.getCurrentPage();
    if (!page) {
      throw new Error('No page open. Use /browse facebook.com first.');
    }

    logger.info('[Browser] Starting human-like Facebook browsing...');

    // Simulate reading behavior
    const result = await simulateFacebookBrowsing(page, options);

    // Get page content after browsing
    const content = await page.evaluate(() => {
      const posts = document.querySelectorAll('[data-ad-preview], [data-pagelet*="FeedUnit"], div[role="article"]');
      return Array.from(posts).slice(0, 10).map((p, i) => {
        const text = p.textContent?.substring(0, 300) || '';
        return `[Bài ${i}] ${text}...`;
      }).join('\n\n');
    });

    return { ...result, content };
  }

  /**
   * Simulate reading content (look natural)
   */
  async simulateReading(durationMs: number = 5000): Promise<void> {
    const page = this.getCurrentPage();
    if (!page) {
      throw new Error('No page open.');
    }

    logger.info(`[Browser] Simulating reading for ${durationMs}ms...`);
    await simulateReading(page, durationMs);
  }

  /**
   * Destroy - cleanup all resources
   */
  async destroy(): Promise<void> {
    await this.close();
  }

  /**
   * Manually save session (useful before important actions)
   */
  async saveSession(): Promise<void> {
    if (!this.context) {
      logger.warn('[Browser] Cannot save session: no browser context');
      return;
    }

    const currentPage = this.getCurrentPage();
    await this.sessionManager.saveCurrentState(this.context, currentPage || undefined);
    logger.info('[Browser] Session manually saved');
  }

  /**
   * Check if a saved session exists for this profile
   */
  hasSession(): boolean {
    return this.sessionManager.hasSession();
  }

  /**
   * Get session info (exists, last updated, cookie count)
   */
  getSessionInfo(): { exists: boolean; updatedAt?: number; cookieCount?: number } | null {
    return this.sessionManager.getSessionInfo();
  }

  /**
   * Delete saved session (start fresh)
   */
  deleteSession(): void {
    this.sessionManager.deleteSession();
    logger.info('[Browser] Session deleted, will start fresh next time');
  }

  /**
   * Get browser context (for advanced use)
   */
  getContext(): BrowserContext | null {
    return this.context;
  }
}

// ============================================================================
// FACTORY FUNCTIONS
// ============================================================================

/**
 * Create a BrowserController for Facebook with optimized settings
 */
export function createFacebookBrowser(): BrowserController {
  return new BrowserController({
    profileId: 'facebook',
    autoSaveInterval: 3, // Save more frequently for Facebook
    headless: false,
  });
}

/**
 * Create a BrowserController for Booksy with optimized settings
 */
export function createBooksyBrowser(): BrowserController {
  return new BrowserController({
    profileId: 'booksy',
    autoSaveInterval: 5,
    headless: false,
  });
}

/**
 * Create a BrowserController for a specific site
 */
export function createSiteBrowser(site: string): BrowserController {
  return new BrowserController({
    profileId: `site-${site}`,
    autoSaveInterval: 5,
    headless: false,
  });
}
