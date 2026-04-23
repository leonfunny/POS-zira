/**
 * Booksy Calendar Sync Module for Zira AI
 *
 * Architecture:
 * - Chrome runs with --remote-debugging-port=9222 (manual login once)
 * - This module connects via CDP, captures token from existing session
 * - Polls Booksy calendar every ~30 min during business hours
 * - Sends booking data to eNail production server API
 * - When session expires → sends Telegram alert → user logs in Chrome (10 sec)
 */

import { EventEmitter } from 'events';
import * as https from 'https';
import * as http from 'http';
import logger from '../logger';
import { BooksySyncConfig, BooksySyncStatus, BooksySyncReport, BooksyBookingSummary, BooksyCustomer, BooksyCustomerSyncReport, BooksyStaff, BooksyStaffSyncReport, BooksyEquipment, BooksyResourceSyncReport, BooksySyncAllReport, BooksyServiceCategory, BooksyServiceSyncReport, BooksyAddon, BooksyAddonSyncReport } from '../../shared/types';

// SECURITY: Booksy API key - loaded from environment or use default public key
// This is a Booksy front desk public API key (not secret), but still best practice to externalize
const BOOKSY_API_KEY = process.env.BOOKSY_API_KEY || 'frontdesk-76661e2b-25f0-49b4-b33a-9d78957a58e3';

const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:133.0) Gecko/20100101 Firefox/133.0',
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.2 Mobile/15E148 Safari/604.1',
];

function randomUA(): string {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

function uuid(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

export class BooksySync extends EventEmitter {
  private config: BooksySyncConfig;
  private lastToken: string | null = null;
  private lastSyncTime: string | null = null;
  private lastSyncReport: BooksySyncReport | null = null;
  private lastBookings: BooksyBookingSummary[] = [];
  private knownCustomerIds: Set<number> = new Set();
  private lastCustomers: BooksyCustomer[] = [];
  private lastCustomerSyncReport: BooksyCustomerSyncReport | null = null;
  private lastStaff: BooksyStaff[] = [];
  private lastStaffSyncReport: BooksyStaffSyncReport | null = null;
  private lastResources: BooksyEquipment[] = [];
  private lastResourceSyncReport: BooksyResourceSyncReport | null = null;
  private lastServiceCategories: BooksyServiceCategory[] = [];
  private lastServiceSyncReport: BooksyServiceSyncReport | null = null;
  private lastAddons: BooksyAddon[] = [];
  private lastAddonSyncReport: BooksyAddonSyncReport | null = null;
  private isRunning = false;
  private isSyncingCustomers = false;
  private isSyncingStaff = false;
  private isSyncingResources = false;
  private isSyncingServices = false;
  private isSyncingAddons = false;
  private sessionExpired = false;
  private syncTimer: ReturnType<typeof setTimeout> | null = null;
  private started = false;
  private chromeConnected = false;
  private _capturePromise: Promise<string> | null = null;

  constructor(config: BooksySyncConfig) {
    super();
    this.config = config;
  }

  updateConfig(config: BooksySyncConfig): void {
    this.config = config;
  }

  getStatus(): BooksySyncStatus {
    return {
      enabled: this.config.enabled,
      running: this.isRunning,
      hasToken: !!this.lastToken,
      sessionExpired: this.sessionExpired,
      lastSyncTime: this.lastSyncTime,
      lastSyncReport: this.lastSyncReport,
      isBusinessHours: this.isBusinessHours(),
      nextSyncIn: this.syncTimer ? Math.round((this.config.syncIntervalMin || 30)) : null,
      chromeConnected: this.chromeConnected,
      customerCount: this.knownCustomerIds.size,
      lastCustomerSyncReport: this.lastCustomerSyncReport,
      staffCount: this.lastStaff.length,
      lastStaffSyncReport: this.lastStaffSyncReport,
      resourceCount: this.lastResources.length,
      lastResourceSyncReport: this.lastResourceSyncReport,
      serviceCount: this.lastServiceCategories.reduce((sum, c) => sum + (c.services?.length || 0), 0),
      lastServiceSyncReport: this.lastServiceSyncReport,
      addonCount: this.lastAddons.length,
      lastAddonSyncReport: this.lastAddonSyncReport,
    };
  }

  getBookings(): BooksyBookingSummary[] {
    return this.lastBookings;
  }

  getCustomers(): BooksyCustomer[] {
    return this.lastCustomers;
  }

  getStaff(): BooksyStaff[] {
    return this.lastStaff;
  }

  getResources(): BooksyEquipment[] {
    return this.lastResources;
  }

  getServices(): BooksyServiceCategory[] {
    return this.lastServiceCategories;
  }

  getAddons(): BooksyAddon[] {
    return this.lastAddons;
  }

  /**
   * Get cached token for external use (e.g., AI tools)
   */
  getToken(): string | null {
    return this.lastToken;
  }

  setToken(token: string | null): void {
    this.lastToken = token;
  }

  private getBusinessId(): string {
    const id = this.config.businessId;
    if (!id) throw new Error('Business ID not configured');
    return id;
  }

  /**
   * Fetch bookings for a specific date (for AI queries like "how many bookings tomorrow")
   * This is a one-off fetch that doesn't affect the sync loop
   */
  async fetchBookingsForDate(date: string): Promise<BooksyBookingSummary[]> {
    let token = this.lastToken;

    // If no cached token, try to capture from Chrome
    if (!token) {
      try {
        token = await this.captureTokenFromChrome();
      } catch (e: any) {
        logger.warn(`[Booksy] Cannot fetch bookings for ${date}: ${e.message}`);
        return [];
      }
    }

    try {
      const data = await this.fetchCalendar(token, date);
      const bookings = data.bookings || {};
      const resources = data.resources || [];
      const summaries: BooksyBookingSummary[] = [];

      for (const [id, booking] of Object.entries<any>(bookings)) {
        const resourceId = booking.resources?.[0]?.id;
        const staff = resources.find((r: any) => r.id === resourceId);
        summaries.push({
          id: booking.id || parseInt(id),
          customerName: booking.customer?.name || 'Unknown',
          serviceName: booking.service?.name || 'Unknown',
          staffName: staff?.name || `Resource ${resourceId}`,
          from: booking.booked_from || '',
          till: booking.booked_till || '',
          status: booking.status || '',
        });
      }

      summaries.sort((a, b) => a.from.localeCompare(b.from));
      logger.info(`[Booksy] Fetched ${summaries.length} bookings for ${date}`);
      return summaries;
    } catch (e: any) {
      if (e.message === 'TOKEN_EXPIRED') {
        this.lastToken = null;
        this.sessionExpired = true;
      }
      logger.error(`[Booksy] Fetch bookings for ${date} failed: ${e.message}`);
      return [];
    }
  }

  private _startTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * Start the sync loop
   */
  start(): void {
    if (this.started) return;
    this.started = true;
    logger.info('[Booksy] Starting sync service');
    this.emitStatus();

    // First sync after a short delay
    this._startTimer = setTimeout(() => {
      this._startTimer = null;
      if (!this.started) return; // Cancelled before first sync
      this.syncOnce().then(() => this.scheduleNext());
    }, 5000);
  }

  /**
   * Stop the sync loop
   */
  stop(): void {
    this.started = false;
    if (this._startTimer) {
      clearTimeout(this._startTimer);
      this._startTimer = null;
    }
    if (this.syncTimer) {
      clearTimeout(this.syncTimer);
      this.syncTimer = null;
    }
    logger.info('[Booksy] Stopped sync service');
    this.emitStatus();
  }

  /**
   * Force a sync now (ignores business hours check)
   */
  async syncNow(): Promise<BooksySyncReport | null> {
    await this.syncOnce(true);
    return this.lastSyncReport;
  }

  // ============ BUSINESS HOURS ============

  private isBusinessHours(): boolean {
    const now = new Date();
    const warsaw = new Date(now.toLocaleString('en-US', { timeZone: 'Europe/Warsaw' }));
    const h = warsaw.getHours();
    const m = warsaw.getMinutes();
    const mins = h * 60 + m;
    const day = warsaw.getDay(); // 0=Sun
    const workDays = this.config.workDays || [1, 2, 3, 4, 5, 6];
    const startMins = (this.config.workStartHour || 7) * 60 + (this.config.workStartMin || 30);
    const endMins = (this.config.workEndHour || 18) * 60 + (this.config.workEndMin || 30);
    return workDays.includes(day) && mins >= startMins && mins <= endMins;
  }

  // ============ TOKEN CAPTURE ============

  private async captureTokenFromChrome(): Promise<string> {
    if (this._capturePromise) return this._capturePromise;
    this._capturePromise = this._doCaptureToken();
    try {
      return await this._capturePromise;
    } finally {
      this._capturePromise = null;
    }
  }

  private async _doCaptureToken(): Promise<string> {
    let chromium: any;
    try {
      chromium = (await import('rebrowser-playwright-core')).chromium;
    } catch {
      throw new Error('Playwright not installed');
    }

    const cdpPort = this.config.cdpPort || 9222;
    let browser: any;
    try {
      browser = await chromium.connectOverCDP(`http://localhost:${cdpPort}`);
      this.chromeConnected = true;
    } catch {
      this.chromeConnected = false;
      throw new Error(`Chrome not reachable on CDP port ${cdpPort}. Start Chrome with --remote-debugging-port=${cdpPort}`);
    }

    let targetPage: any = null;

    try {
      let capturedToken: string | null = null;
      const contexts = browser.contexts();

      if (contexts.length === 0) throw new Error('No browser context');
      targetPage = await contexts[0].newPage();

      // Intercept API responses to capture token
      const tokenPromise = new Promise<string | null>((resolve) => {
        const handler = async (response: any) => {
          if (capturedToken) return;
          try {
            const url = response.url();
            if (url.includes('pl.booksy.com') && response.request().method() !== 'OPTIONS') {
              const token = response.request().headers()['x-access-token'];
              if (token) {
                capturedToken = token;
                clearTimeout(timeout);
                targetPage.removeListener('response', handler);
                resolve(token);
              }
            }
          } catch { /* ignore */ }
        };
        // FIX: Remove listener on timeout to prevent memory leak
        const timeout = setTimeout(() => {
          targetPage.removeListener('response', handler);
          resolve(null);
        }, 20000);
        targetPage.on('response', handler);
      });

      // Navigate to calendar
      const today = new Date().toISOString().split('T')[0];
      const businessId = this.getBusinessId();
      await targetPage.goto(
        `https://booksy.com/pro/en-pl/${businessId}/calendar?date=${today}&view=day&staffers=working`,
        { waitUntil: 'networkidle', timeout: 30000 },
      ).catch(() => { /* ignore navigation errors */ });

      await tokenPromise;

      // Check if redirected to login (session expired)
      const currentUrl = targetPage.url();
      if (currentUrl.includes('Login') || currentUrl.includes('login') || currentUrl.includes('onboarding')) {
        // Don't set sessionExpired here - let the caller handle it
        // so the Telegram alert logic can check the previous state
        throw new Error('SESSION_EXPIRED');
      }

      if (!capturedToken) {
        throw new Error('Could not capture token');
      }

      this.sessionExpired = false;
      this.lastToken = capturedToken;
      return capturedToken;
    } finally {
      // Close the tab we opened to avoid leaking Chrome tabs
      if (targetPage) {
        try { await targetPage.close(); } catch { /* ignore */ }
      }
      try { await browser.close(); } catch { /* ignore */ }
    }
  }

  // ============ BOOKSY API ============

  private fetchCalendar(token: string, date: string): Promise<any> {
    const businessId = this.getBusinessId();
    return new Promise((resolve, reject) => {
      const url = `https://pl.booksy.com/core/v2/business_api/me/businesses/${businessId}/calendar?start_date=${date}&end_date=${date}&include_unconfirmed=true&version=3&resources_per_page=50`;

      const req = https.get(url, {
        headers: {
          Accept: 'application/json',
          'x-access-token': token,
          'x-api-key': BOOKSY_API_KEY,
          'x-app-version': '3.0',
          'accept-language': 'en,pl;q=0.9',
          'User-Agent': randomUA(),
          bksreqid: uuid(),
          Origin: 'https://booksy.com',
          Referer: 'https://booksy.com/',
        },
        timeout: 30000, // 30 second timeout
      }, (res) => {
        let data = '';
        res.on('data', (chunk: string) => (data += chunk));
        res.on('end', () => {
          if (res.statusCode === 200) {
            try {
              resolve(JSON.parse(data));
            } catch (e) {
              reject(new Error(`Invalid JSON response`));
            }
          } else if (res.statusCode === 401 || res.statusCode === 403) {
            reject(new Error('TOKEN_EXPIRED'));
          } else {
            reject(new Error(`API ${res.statusCode}: ${data.substring(0, 200)}`));
          }
        });
      });
      req.on('timeout', () => {
        req.destroy();
        reject(new Error('Request timeout'));
      });
      req.on('error', reject);
    });
  }

  // ============ PUSH TO ENAIL ============

  private pushBookingsToEnail(calendarData: any, date: string): Promise<boolean> {
    const apiUrl = this.config.enailApiUrl;
    const jwt = this.config.enailJwt;
    if (!apiUrl || !jwt) {
      logger.debug('[Booksy] No eNail API URL/JWT configured, skipping push');
      return Promise.resolve(false);
    }

    return new Promise((resolve) => {
      const payload = JSON.stringify({ calendarData, date, source: 'print-agent-booksy-sync' });
      const url = new URL(`${apiUrl}/booksy/calendar/push`);
      const proto = url.protocol === 'https:' ? https : http;

      const req = proto.request({
        hostname: url.hostname,
        port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: url.pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${jwt}`,
          'Content-Length': Buffer.byteLength(payload),
        },
      }, (res) => {
        let data = '';
        res.on('data', (chunk: string) => (data += chunk));
        res.on('end', () => {
          resolve(res.statusCode === 200 || res.statusCode === 201);
        });
      });
      req.on('error', () => resolve(false));
      req.write(payload);
      req.end();
    });
  }

  // ============ TELEGRAM ALERT ============

  private sendTelegramAlert(message: string): void {
    const botToken = this.config.telegramBotToken;
    const chatId = this.config.telegramChatId;
    if (!botToken || !chatId) return;

    const payload = JSON.stringify({
      chat_id: chatId,
      text: message,
      parse_mode: 'Markdown',
    });

    const req = https.request({
      hostname: 'api.telegram.org',
      path: `/bot${botToken}/sendMessage`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
    });
    req.on('error', () => { /* ignore */ });
    req.write(payload);
    req.end();
  }

  // ============ SYNC LOGIC ============

  private async syncOnce(force = false): Promise<void> {
    if (this.isRunning) return;
    if (!force && !this.isBusinessHours()) {
      logger.debug('[Booksy] Outside business hours, skipping');
      return;
    }

    this.isRunning = true;
    this.emitStatus();
    const today = new Date().toISOString().split('T')[0];
    logger.info(`[Booksy] Syncing ${today}...`);

    try {
      let token = this.lastToken;

      // Try cached token first
      if (token) {
        try {
          const data = await this.fetchCalendar(token, today);
          const bookingCount = Object.keys(data.bookings || {}).length;
          logger.info(`[Booksy] OK! ${bookingCount} bookings (cached token)`);

          this.extractBookingSummaries(data);
          const pushed = await this.pushBookingsToEnail(data, today);
          this.lastSyncTime = new Date().toISOString();
          this.lastSyncReport = { date: today, bookings: bookingCount, pushed, time: this.lastSyncTime };
          this.isRunning = false;
          this.emitStatus();
          return;
        } catch (e: any) {
          if (e.message === 'TOKEN_EXPIRED') {
            logger.info('[Booksy] Cached token expired, refreshing from Chrome...');
            this.lastToken = null;
          } else {
            throw e;
          }
        }
      }

      // Capture fresh token from Chrome
      try {
        token = await this.captureTokenFromChrome();
        // SECURITY: Don't log token values, even partial
        logger.info('[Booksy] New token captured successfully');
      } catch (e: any) {
        if (e.message === 'SESSION_EXPIRED') {
          logger.warn('[Booksy] SESSION EXPIRED! Need manual login in Chrome.');
          if (!this.sessionExpired) {
            this.sendTelegramAlert(
              `\u26a0\ufe0f *Booksy Session Expired*\n\n` +
              `Login manually in Chrome:\nhttps://booksy.com/pro/en-pl/onboarding/Login\n\n` +
              `After login, sync will resume automatically.`
            );
          }
          this.sessionExpired = true;
          this.isRunning = false;
          this.lastSyncReport = { date: today, bookings: 0, pushed: false, time: new Date().toISOString(), error: 'Session expired' };
          this.emitStatus();
          return;
        }
        throw e;
      }

      // Fetch calendar with new token
      const data = await this.fetchCalendar(token, today);
      const bookingCount = Object.keys(data.bookings || {}).length;
      logger.info(`[Booksy] OK! ${bookingCount} bookings`);

      this.extractBookingSummaries(data);
      const pushed = await this.pushBookingsToEnail(data, today);
      if (pushed) logger.info('[Booksy] Pushed to eNail server');

      this.lastSyncTime = new Date().toISOString();
      this.lastSyncReport = { date: today, bookings: bookingCount, pushed, time: this.lastSyncTime };

      // Notify recovery if was expired
      if (this.sessionExpired) {
        this.sessionExpired = false;
        this.sendTelegramAlert(`\u2705 *Booksy Session Restored*\nSync resumed. ${bookingCount} bookings today.`);
      }
    } catch (e: any) {
      logger.error(`[Booksy] ERROR: ${e.message}`);
      this.lastSyncReport = { date: today, bookings: 0, pushed: false, time: new Date().toISOString(), error: e.message };
    } finally {
      this.isRunning = false;
      this.emitStatus();
    }
  }

  private extractBookingSummaries(data: any): void {
    const bookings = data.bookings || {};
    const resources = data.resources || [];
    const summaries: BooksyBookingSummary[] = [];

    for (const [id, booking] of Object.entries<any>(bookings)) {
      const resourceId = booking.resources?.[0]?.id;
      const staff = resources.find((r: any) => r.id === resourceId);
      summaries.push({
        id: booking.id || parseInt(id),
        customerName: booking.customer?.name || 'Unknown',
        serviceName: booking.service?.name || 'Unknown',
        staffName: staff?.name || `Resource ${resourceId}`,
        from: booking.booked_from || '',
        till: booking.booked_till || '',
        status: booking.status || '',
      });
    }

    // Sort by time
    summaries.sort((a, b) => a.from.localeCompare(b.from));
    this.lastBookings = summaries;
  }

  // ============ CUSTOMER SYNC ============

  /**
   * Sync customers from Booksy. First call fetches all pages,
   * subsequent calls only return new customers (not yet in knownCustomerIds).
   */
  async syncCustomersNow(): Promise<BooksyCustomerSyncReport> {
    if (this.isSyncingCustomers) {
      return this.lastCustomerSyncReport || { time: new Date().toISOString(), totalFetched: 0, newCustomers: 0, pushed: false, error: 'Already syncing' };
    }

    this.isSyncingCustomers = true;
    this.emitStatus();

    try {
      // Ensure we have a token
      let token = this.lastToken;
      if (!token) {
        token = await this.captureTokenFromChrome();
      }

      const isFirstSync = this.knownCustomerIds.size === 0;
      logger.info(`[Booksy] Customer sync starting (${isFirstSync ? 'full' : 'incremental'})...`);

      const allCustomers = await this.fetchAllCustomers(token);
      const newCustomers: BooksyCustomer[] = [];

      for (const c of allCustomers) {
        if (!this.knownCustomerIds.has(c.id)) {
          newCustomers.push(c);
          this.knownCustomerIds.add(c.id);
        }
      }

      this.lastCustomers = allCustomers;
      logger.info(`[Booksy] Customers: ${allCustomers.length} total, ${newCustomers.length} new`);

      // Push new customers to eNail
      let pushed = false;
      if (newCustomers.length > 0) {
        pushed = await this.pushCustomersToEnail(newCustomers, isFirstSync);
        if (pushed) logger.info(`[Booksy] Pushed ${newCustomers.length} customers to eNail`);
      }

      this.lastCustomerSyncReport = {
        time: new Date().toISOString(),
        totalFetched: allCustomers.length,
        newCustomers: newCustomers.length,
        pushed,
      };

      return this.lastCustomerSyncReport;
    } catch (e: any) {
      if (e.message === 'TOKEN_EXPIRED') {
        this.lastToken = null;
      }
      logger.error(`[Booksy] Customer sync ERROR: ${e.message}`);
      this.lastCustomerSyncReport = {
        time: new Date().toISOString(),
        totalFetched: 0,
        newCustomers: 0,
        pushed: false,
        error: e.message,
      };
      return this.lastCustomerSyncReport;
    } finally {
      this.isSyncingCustomers = false;
      this.emitStatus();
    }
  }

  private async fetchAllCustomers(token: string): Promise<BooksyCustomer[]> {
    const perPage = 100;
    const MAX_PAGES = 200; // Safety limit to prevent infinite loop
    let page = 1;
    const all: BooksyCustomer[] = [];
    let totalCount = 0;

    do {
      // FIX: Prevent infinite loop if API returns inconsistent data
      if (page > MAX_PAGES) {
        logger.warn(`[Booksy] Hit max page limit (${MAX_PAGES}), stopping customer fetch`);
        break;
      }

      const data = await this.fetchCustomerPage(token, page, perPage);
      totalCount = data.count || 0;

      for (const c of (data.customers || [])) {
        all.push({
          id: c.id,
          first_name: c.first_name || '',
          last_name: c.last_name || '',
          full_name: c.customer_profile?.full_name || `${c.first_name || ''} ${c.last_name || ''}`.trim(),
          cell_phone: c.cell_phone || '',
          email: c.email || '',
          photo_url: c.photo_url || null,
          blacklisted: !!c.blacklisted,
          visit_frequency: c.visit_frequency || 0,
          no_shows: c.no_shows || 0,
          discount: c.discount || 0,
          birthday: c.customer_profile?.birthday || null,
          city: c.customer_profile?.city || null,
          marketing_agreement: !!c.customer_profile?.marketing_agreement,
          created: c.created || '',
        });
      }

      logger.debug(`[Booksy] Customers page ${page}: ${data.customers?.length || 0} items (${all.length}/${totalCount})`);
      page++;

      // Random delay between pages (3-10s) to avoid detection
      if (all.length < totalCount) {
        const delay = 3000 + Math.floor(Math.random() * 7000);
        logger.debug(`[Booksy] Customer page delay: ${(delay / 1000).toFixed(1)}s`);
        await new Promise(r => setTimeout(r, delay));
      }
    } while (all.length < totalCount);

    return all;
  }

  private fetchCustomerPage(token: string, page: number, perPage: number): Promise<any> {
    const businessId = this.getBusinessId();
    return new Promise((resolve, reject) => {
      const url = `https://pl.booksy.com/core/v2/business_api/me/businesses/${businessId}/customers?page=${page}&per_page=${perPage}&compact=true`;

      const req = https.get(url, {
        headers: {
          Accept: 'application/json',
          'x-access-token': token,
          'x-api-key': BOOKSY_API_KEY,
          'x-app-version': '3.0',
          'accept-language': 'en,pl;q=0.9',
          'User-Agent': randomUA(),
          bksreqid: uuid(),
          Origin: 'https://booksy.com',
          Referer: 'https://booksy.com/',
        },
        timeout: 30000,
      }, (res) => {
        let data = '';
        res.on('data', (chunk: string) => (data += chunk));
        res.on('end', () => {
          if (res.statusCode === 200) {
            try {
              resolve(JSON.parse(data));
            } catch {
              reject(new Error('Invalid JSON response'));
            }
          } else if (res.statusCode === 401 || res.statusCode === 403) {
            reject(new Error('TOKEN_EXPIRED'));
          } else {
            reject(new Error(`Customer API ${res.statusCode}: ${data.substring(0, 200)}`));
          }
        });
      });
      req.on('timeout', () => {
        req.destroy();
        reject(new Error('Request timeout'));
      });
      req.on('error', reject);
    });
  }

  private pushCustomersToEnail(customers: BooksyCustomer[], isFullSync: boolean): Promise<boolean> {
    const apiUrl = this.config.enailApiUrl;
    const jwt = this.config.enailJwt;
    if (!apiUrl || !jwt) {
      logger.debug('[Booksy] No eNail API URL/JWT configured, skipping customer push');
      return Promise.resolve(false);
    }

    return new Promise((resolve) => {
      const payload = JSON.stringify({
        customers,
        isFullSync,
        source: 'print-agent-booksy-sync',
      });
      const url = new URL(`${apiUrl}/booksy/customers/push`);
      const proto = url.protocol === 'https:' ? https : http;

      const req = proto.request({
        hostname: url.hostname,
        port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: url.pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${jwt}`,
          'Content-Length': Buffer.byteLength(payload),
        },
      }, (res) => {
        let data = '';
        res.on('data', (chunk: string) => (data += chunk));
        res.on('end', () => {
          resolve(res.statusCode === 200 || res.statusCode === 201);
        });
      });
      req.on('error', () => resolve(false));
      req.write(payload);
      req.end();
    });
  }

  // ============ STAFF SYNC ============

  /**
   * Sync staff/resources from Booksy. Only fetches type "S" (staff), ignores "R" (equipment).
   */
  async syncStaffNow(): Promise<BooksyStaffSyncReport> {
    if (this.isSyncingStaff) {
      return this.lastStaffSyncReport || { time: new Date().toISOString(), totalFetched: 0, pushed: false, error: 'Already syncing' };
    }

    this.isSyncingStaff = true;
    this.emitStatus();

    try {
      let token = this.lastToken;
      if (!token) {
        token = await this.captureTokenFromChrome();
      }

      logger.info('[Booksy] Staff sync starting...');
      const allResources = await this.fetchResources(token);

      // Filter only staff (type "S"), not equipment ("R")
      const staffOnly = allResources.filter((r: any) => r.type === 'S');
      this.lastStaff = staffOnly.map((r: any) => ({
        id: r.id,
        name: r.name || '',
        type: r.type,
        description: r.description || '',
        photo_url: r.photo_url || null,
        is_current_user: !!r.is_current_user,
        visible_on_calendar: !!r.visible_on_calendar,
        working_hours: r.working_hours || {},
      }));

      logger.info(`[Booksy] Staff: ${this.lastStaff.length} members (${allResources.length} total resources)`);

      const pushed = await this.pushStaffToEnail(this.lastStaff);
      if (pushed) logger.info('[Booksy] Pushed staff to eNail');

      this.lastStaffSyncReport = {
        time: new Date().toISOString(),
        totalFetched: this.lastStaff.length,
        pushed,
      };

      return this.lastStaffSyncReport;
    } catch (e: any) {
      if (e.message === 'TOKEN_EXPIRED') {
        this.lastToken = null;
      }
      logger.error(`[Booksy] Staff sync ERROR: ${e.message}`);
      this.lastStaffSyncReport = {
        time: new Date().toISOString(),
        totalFetched: 0,
        pushed: false,
        error: e.message,
      };
      return this.lastStaffSyncReport;
    } finally {
      this.isSyncingStaff = false;
      this.emitStatus();
    }
  }

  private fetchResources(token: string): Promise<any[]> {
    const businessId = this.getBusinessId();
    return new Promise((resolve, reject) => {
      const url = `https://pl.booksy.com/core/v2/business_api/me/businesses/${businessId}/resources`;

      const req = https.get(url, {
        headers: {
          Accept: 'application/json',
          'x-access-token': token,
          'x-api-key': BOOKSY_API_KEY,
          'x-app-version': '3.0',
          'accept-language': 'en,pl;q=0.9',
          'User-Agent': randomUA(),
          bksreqid: uuid(),
          Origin: 'https://booksy.com',
          Referer: 'https://booksy.com/',
        },
        timeout: 30000,
      }, (res) => {
        let data = '';
        res.on('data', (chunk: string) => (data += chunk));
        res.on('end', () => {
          if (res.statusCode === 200) {
            try {
              const parsed = JSON.parse(data);
              // Response could be { resources: [...] } or direct array
              resolve(parsed.resources || parsed || []);
            } catch {
              reject(new Error('Invalid JSON response'));
            }
          } else if (res.statusCode === 401 || res.statusCode === 403) {
            reject(new Error('TOKEN_EXPIRED'));
          } else {
            reject(new Error(`Resources API ${res.statusCode}: ${data.substring(0, 200)}`));
          }
        });
      });
      req.on('timeout', () => {
        req.destroy();
        reject(new Error('Request timeout'));
      });
      req.on('error', reject);
    });
  }

  private pushStaffToEnail(staff: BooksyStaff[]): Promise<boolean> {
    const apiUrl = this.config.enailApiUrl;
    const jwt = this.config.enailJwt;
    if (!apiUrl || !jwt) {
      logger.debug('[Booksy] No eNail API URL/JWT configured, skipping staff push');
      return Promise.resolve(false);
    }

    return new Promise((resolve) => {
      const payload = JSON.stringify({
        staff,
        source: 'print-agent-booksy-sync',
      });
      const url = new URL(`${apiUrl}/booksy/staff/push`);
      const proto = url.protocol === 'https:' ? https : http;

      const req = proto.request({
        hostname: url.hostname,
        port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: url.pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${jwt}`,
          'Content-Length': Buffer.byteLength(payload),
        },
      }, (res) => {
        let data = '';
        res.on('data', (chunk: string) => (data += chunk));
        res.on('end', () => {
          resolve(res.statusCode === 200 || res.statusCode === 201);
        });
      });
      req.on('error', () => resolve(false));
      req.write(payload);
      req.end();
    });
  }

  // ============ RESOURCES SYNC ============

  /**
   * Sync equipment/resources from Booksy (type "R").
   */
  async syncResourcesNow(): Promise<BooksyResourceSyncReport> {
    if (this.isSyncingResources) {
      return this.lastResourceSyncReport || { time: new Date().toISOString(), totalFetched: 0, pushed: false, error: 'Already syncing' };
    }

    this.isSyncingResources = true;
    this.emitStatus();

    try {
      let token = this.lastToken;
      if (!token) {
        token = await this.captureTokenFromChrome();
      }

      logger.info('[Booksy] Resources sync starting...');
      const allResources = await this.fetchResources(token);

      // Filter only equipment (type "R"), not staff ("S")
      const equipmentOnly = allResources.filter((r: any) => r.type === 'R');
      this.lastResources = equipmentOnly.map((r: any) => ({
        id: r.id,
        name: r.name || '',
        type: 'R' as const,
        description: r.description || '',
      }));

      logger.info(`[Booksy] Resources: ${this.lastResources.length} equipment items`);

      const pushed = await this.pushResourcesToEnail(this.lastResources);
      if (pushed) logger.info('[Booksy] Pushed resources to eNail');

      this.lastResourceSyncReport = {
        time: new Date().toISOString(),
        totalFetched: this.lastResources.length,
        pushed,
      };

      return this.lastResourceSyncReport;
    } catch (e: any) {
      if (e.message === 'TOKEN_EXPIRED') {
        this.lastToken = null;
      }
      logger.error(`[Booksy] Resources sync ERROR: ${e.message}`);
      this.lastResourceSyncReport = {
        time: new Date().toISOString(),
        totalFetched: 0,
        pushed: false,
        error: e.message,
      };
      return this.lastResourceSyncReport;
    } finally {
      this.isSyncingResources = false;
      this.emitStatus();
    }
  }

  private pushResourcesToEnail(resources: BooksyEquipment[]): Promise<boolean> {
    const apiUrl = this.config.enailApiUrl;
    const jwt = this.config.enailJwt;
    if (!apiUrl || !jwt) {
      logger.debug('[Booksy] No eNail API URL/JWT configured, skipping resources push');
      return Promise.resolve(false);
    }

    return new Promise((resolve) => {
      const payload = JSON.stringify({
        resources,
        source: 'print-agent-booksy-sync',
      });
      const url = new URL(`${apiUrl}/booksy/resources/push`);
      const proto = url.protocol === 'https:' ? https : http;

      const req = proto.request({
        hostname: url.hostname,
        port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: url.pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${jwt}`,
          'Content-Length': Buffer.byteLength(payload),
        },
      }, (res) => {
        let data = '';
        res.on('data', (chunk: string) => (data += chunk));
        res.on('end', () => {
          resolve(res.statusCode === 200 || res.statusCode === 201);
        });
      });
      req.on('error', () => resolve(false));
      req.write(payload);
      req.end();
    });
  }

  // ============ SERVICES SYNC ============

  /**
   * Sync service categories + services + variants from Booksy.
   */
  async syncServicesNow(): Promise<BooksyServiceSyncReport> {
    if (this.isSyncingServices) {
      return this.lastServiceSyncReport || { time: new Date().toISOString(), categoriesFetched: 0, servicesFetched: 0, pushed: false, error: 'Already syncing' };
    }

    this.isSyncingServices = true;
    this.emitStatus();

    try {
      let token = this.lastToken;
      if (!token) {
        token = await this.captureTokenFromChrome();
      }

      logger.info('[Booksy] Services sync starting...');
      const categories = await this.fetchServiceCategories(token);

      this.lastServiceCategories = categories;
      const totalServices = categories.reduce((sum, c) => sum + (c.services?.length || 0), 0);
      logger.info(`[Booksy] Services: ${categories.length} categories, ${totalServices} services`);

      const pushed = await this.pushServicesToEnail(categories);
      if (pushed) logger.info('[Booksy] Pushed services to eNail');

      this.lastServiceSyncReport = {
        time: new Date().toISOString(),
        categoriesFetched: categories.length,
        servicesFetched: totalServices,
        pushed,
      };

      return this.lastServiceSyncReport;
    } catch (e: any) {
      if (e.message === 'TOKEN_EXPIRED') {
        this.lastToken = null;
      }
      logger.error(`[Booksy] Services sync ERROR: ${e.message}`);
      this.lastServiceSyncReport = {
        time: new Date().toISOString(),
        categoriesFetched: 0,
        servicesFetched: 0,
        pushed: false,
        error: e.message,
      };
      return this.lastServiceSyncReport;
    } finally {
      this.isSyncingServices = false;
      this.emitStatus();
    }
  }

  private fetchServiceCategories(token: string): Promise<BooksyServiceCategory[]> {
    const businessId = this.getBusinessId();
    return new Promise((resolve, reject) => {
      const url = `https://pl.booksy.com/core/v2/business_api/me/businesses/${businessId}/service_categories?with_combos=true`;

      const req = https.get(url, {
        headers: {
          Accept: 'application/json',
          'x-access-token': token,
          'x-api-key': BOOKSY_API_KEY,
          'x-app-version': '3.0',
          'accept-language': 'en,pl;q=0.9',
          'User-Agent': randomUA(),
          bksreqid: uuid(),
          Origin: 'https://booksy.com',
          Referer: 'https://booksy.com/',
        },
        timeout: 30000,
      }, (res) => {
        let data = '';
        res.on('data', (chunk: string) => (data += chunk));
        res.on('end', () => {
          if (res.statusCode === 200) {
            try {
              const parsed = JSON.parse(data);
              const rawCategories = parsed.service_categories || parsed.categories || parsed || [];
              const categories: BooksyServiceCategory[] = rawCategories.map((cat: any) => ({
                id: cat.id,
                name: cat.name || '',
                services: (cat.services || []).map((svc: any) => ({
                  id: svc.id,
                  name: svc.name || '',
                  description: svc.description || '',
                  price: svc.price ?? svc.min_price ?? null,
                  price_text: svc.price_text || svc.price_formatted || '',
                  photo_url: svc.photo_url || svc.image_url || null,
                  variants: (svc.variants || []).map((v: any) => ({
                    duration: v.duration ?? null,
                    price: v.price ?? null,
                    price_text: v.price_text || v.price_formatted || '',
                    label: v.name || v.label || '',
                  })),
                })),
              }));
              resolve(categories);
            } catch {
              reject(new Error('Invalid JSON response'));
            }
          } else if (res.statusCode === 401 || res.statusCode === 403) {
            reject(new Error('TOKEN_EXPIRED'));
          } else {
            reject(new Error(`Services API ${res.statusCode}: ${data.substring(0, 200)}`));
          }
        });
      });
      req.on('timeout', () => {
        req.destroy();
        reject(new Error('Request timeout'));
      });
      req.on('error', reject);
    });
  }

  private pushServicesToEnail(categories: BooksyServiceCategory[]): Promise<boolean> {
    const apiUrl = this.config.enailApiUrl;
    const jwt = this.config.enailJwt;
    if (!apiUrl || !jwt) {
      logger.debug('[Booksy] No eNail API URL/JWT configured, skipping services push');
      return Promise.resolve(false);
    }

    return new Promise((resolve) => {
      const payload = JSON.stringify({
        categories,
        source: 'print-agent-booksy-sync',
      });
      const url = new URL(`${apiUrl}/booksy/services/push`);
      const proto = url.protocol === 'https:' ? https : http;

      const req = proto.request({
        hostname: url.hostname,
        port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: url.pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${jwt}`,
          'Content-Length': Buffer.byteLength(payload),
        },
      }, (res) => {
        let data = '';
        res.on('data', (chunk: string) => (data += chunk));
        res.on('end', () => {
          resolve(res.statusCode === 200 || res.statusCode === 201);
        });
      });
      req.on('error', () => resolve(false));
      req.write(payload);
      req.end();
    });
  }

  // ============ ADDONS SYNC ============

  /**
   * Sync add-ons from Booksy.
   */
  async syncAddonsNow(): Promise<BooksyAddonSyncReport> {
    if (this.isSyncingAddons) {
      return this.lastAddonSyncReport || { time: new Date().toISOString(), totalFetched: 0, pushed: false, error: 'Already syncing' };
    }

    this.isSyncingAddons = true;
    this.emitStatus();

    try {
      let token = this.lastToken;
      if (!token) {
        token = await this.captureTokenFromChrome();
      }

      logger.info('[Booksy] Addons sync starting...');
      const addons = await this.fetchAddons(token);

      this.lastAddons = addons;
      logger.info(`[Booksy] Addons: ${addons.length} items`);

      const pushed = await this.pushAddonsToEnail(addons);
      if (pushed) logger.info('[Booksy] Pushed addons to eNail');

      this.lastAddonSyncReport = {
        time: new Date().toISOString(),
        totalFetched: addons.length,
        pushed,
      };

      return this.lastAddonSyncReport;
    } catch (e: any) {
      if (e.message === 'TOKEN_EXPIRED') {
        this.lastToken = null;
      }
      logger.error(`[Booksy] Addons sync ERROR: ${e.message}`);
      this.lastAddonSyncReport = {
        time: new Date().toISOString(),
        totalFetched: 0,
        pushed: false,
        error: e.message,
      };
      return this.lastAddonSyncReport;
    } finally {
      this.isSyncingAddons = false;
      this.emitStatus();
    }
  }

  private fetchAddons(token: string): Promise<BooksyAddon[]> {
    const businessId = this.getBusinessId();
    return new Promise((resolve, reject) => {
      const url = `https://pl.booksy.com/core/v2/business_api/me/businesses/${businessId}/addons`;

      const req = https.get(url, {
        headers: {
          Accept: 'application/json',
          'x-access-token': token,
          'x-api-key': BOOKSY_API_KEY,
          'x-app-version': '3.0',
          'accept-language': 'en,pl;q=0.9',
          'User-Agent': randomUA(),
          bksreqid: uuid(),
          Origin: 'https://booksy.com',
          Referer: 'https://booksy.com/',
        },
        timeout: 30000,
      }, (res) => {
        let data = '';
        res.on('data', (chunk: string) => (data += chunk));
        res.on('end', () => {
          if (res.statusCode === 200) {
            try {
              const parsed = JSON.parse(data);
              const rawAddons = parsed.addons || parsed || [];
              const addons: BooksyAddon[] = rawAddons.map((a: any) => ({
                id: a.id,
                name: a.name || '',
                description: a.description || '',
                price: a.price ?? null,
                price_text: a.price_text || a.price_formatted || '',
                duration: a.duration ?? null,
              }));
              resolve(addons);
            } catch {
              reject(new Error('Invalid JSON response'));
            }
          } else if (res.statusCode === 404) {
            resolve([]);
          } else if (res.statusCode === 401 || res.statusCode === 403) {
            reject(new Error('TOKEN_EXPIRED'));
          } else {
            reject(new Error(`Addons API ${res.statusCode}: ${data.substring(0, 200)}`));
          }
        });
      });
      req.on('timeout', () => {
        req.destroy();
        reject(new Error('Request timeout'));
      });
      req.on('error', reject);
    });
  }

  private pushAddonsToEnail(addons: BooksyAddon[]): Promise<boolean> {
    const apiUrl = this.config.enailApiUrl;
    const jwt = this.config.enailJwt;
    if (!apiUrl || !jwt) {
      logger.debug('[Booksy] No eNail API URL/JWT configured, skipping addons push');
      return Promise.resolve(false);
    }

    return new Promise((resolve) => {
      const payload = JSON.stringify({
        addons,
        source: 'print-agent-booksy-sync',
      });
      const url = new URL(`${apiUrl}/booksy/addons/push`);
      const proto = url.protocol === 'https:' ? https : http;

      const req = proto.request({
        hostname: url.hostname,
        port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: url.pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${jwt}`,
          'Content-Length': Buffer.byteLength(payload),
        },
      }, (res) => {
        let data = '';
        res.on('data', (chunk: string) => (data += chunk));
        res.on('end', () => {
          resolve(res.statusCode === 200 || res.statusCode === 201);
        });
      });
      req.on('error', () => resolve(false));
      req.write(payload);
      req.end();
    });
  }

  // ============ SYNC ALL ============

  /**
   * Sync all: staff + customers + resources + services + addons sequentially
   */
  async syncAllNow(): Promise<BooksySyncAllReport> {
    logger.info('[Booksy] Sync All starting...');
    const delay = () => new Promise(r => setTimeout(r, 2000 + Math.floor(Math.random() * 3000)));
    const staffReport = await this.syncStaffNow();
    await delay();
    const customerReport = await this.syncCustomersNow();
    await delay();
    const resourceReport = await this.syncResourcesNow();
    await delay();
    const servicesReport = await this.syncServicesNow();
    await delay();
    const addonsReport = await this.syncAddonsNow();
    logger.info('[Booksy] Sync All completed');
    return { staff: staffReport, customers: customerReport, resources: resourceReport, services: servicesReport, addons: addonsReport };
  }

  private scheduleNext(): void {
    if (!this.started) return;

    // Random interval: base ± 5 minutes
    const base = this.config.syncIntervalMin || 30;
    const jitter = Math.floor(Math.random() * 10) - 5;
    const intervalMs = Math.max(10, base + jitter) * 60 * 1000;

    this.syncTimer = setTimeout(async () => {
      // FIX: Wrap in try-catch to ensure scheduleNext always runs
      try {
        await this.syncOnce();
      } catch (e: any) {
        logger.error(`[Booksy] Unhandled sync error: ${e.message}`);
      }
      this.scheduleNext();
    }, intervalMs);

    if (this.isBusinessHours()) {
      logger.debug(`[Booksy] Next sync in ~${Math.round(intervalMs / 60000)} min`);
    }
  }

  private emitStatus(): void {
    this.emit('statusChanged', this.getStatus());
  }
}
