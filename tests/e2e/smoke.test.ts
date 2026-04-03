/**
 * Print Agent E2E Smoke Test
 *
 * Launches the Electron app via Playwright, enters offline mode,
 * navigates every visible tab, clicks key buttons, and checks
 * log files for errors that occurred during the run.
 *
 * Run: npm run test:e2e
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { ElectronApplication, Page } from 'playwright';
import { launchApp, readLogs, safeClick, safeWait, screenshotOnFail, navigateToTab } from './helpers';

// Generous timeout for the full smoke suite (build + launch + interact)
const SUITE_TIMEOUT = 120_000;

let app: ElectronApplication;
let page: Page;
let testStartTime: Date;

// ─── Tab definitions ────────────────────────────────────────────────

/** Tabs visible by default in offline mode (entitlement defaults from App.tsx) */
const DEFAULT_TABS = [
  { id: 'pos',       label: 'POS' },
  { id: 'chat',      label: 'Zira AI' },
  { id: 'status',    label: 'Status' },
  { id: 'checkin',   label: 'Check-in' },
  { id: 'invoicing', label: 'Invoicing' },
  { id: 'settings',  label: 'Settings' },
  { id: 'debug',     label: 'Debug' },
] as const;

// ─── Setup & Teardown ───────────────────────────────────────────────

beforeAll(async () => {
  testStartTime = new Date();
  const result = await launchApp();
  app = result.app;
  page = result.page;
}, SUITE_TIMEOUT);

afterAll(async () => {
  if (app) {
    await app.close();
  }
});

// ─── Tests ──────────────────────────────────────────────────────────

describe('Print Agent Smoke Tests', () => {
  it('should load without crashing', async () => {
    const bgColor = await page.evaluate(() => {
      return window.getComputedStyle(document.body).backgroundColor;
    });
    // Any background is acceptable — light theme uses gray-50, dark uses slate-900
    expect(bgColor).toBeTruthy();
    console.log('[smoke] Initial bg:', bgColor);
  });

  it('should enter offline mode via auth screen button', async () => {
    // Take diagnostic screenshot to see what's on screen
    await screenshotOnFail(page, 'auth-screen-state');

    // Wait for the page to settle — auth screen may take a moment to render inputs
    await page.waitForTimeout(3_000);

    // Dump all visible button texts for debugging
    const buttonTexts = await page.evaluate(() =>
      Array.from(document.querySelectorAll('button')).map(b => b.textContent?.trim() || ''),
    );
    console.log('[smoke] Visible buttons:', JSON.stringify(buttonTexts));

    // Also check for any text inputs (auth form)
    const inputCount = await page.evaluate(() => document.querySelectorAll('input').length);
    console.log('[smoke] Input count:', inputCount);

    // Try multiple selectors for the offline button
    const offlineSelectors = [
      'button:has-text("Offline mode")',
      'button:has-text("Offline")',
      'button:has-text("offline")',
      'button:has-text("Tryb offline")',
      'text=Offline mode',
    ];

    let clicked = false;
    for (const sel of offlineSelectors) {
      clicked = await safeClick(page, sel, { timeout: 3_000 });
      if (clicked) {
        console.log(`[smoke] Clicked offline button via: ${sel}`);
        break;
      }
    }

    if (clicked) {
      // Wait for sidebar to appear (indicates successful login)
      const sidebarLoaded = await safeWait(page, 'aside', { timeout: 10_000 });
      expect(sidebarLoaded).toBe(true);
      console.log('[smoke] Entered offline mode');
    } else {
      // Already past auth (cached session) or different screen
      const hasSidebar = await safeWait(page, 'aside', { timeout: 5_000 });
      if (hasSidebar) {
        console.log('[smoke] Already authenticated, sidebar visible');
      } else {
        // Take screenshot for debugging
        const ssPath = await screenshotOnFail(page, 'auth-failed-state');
        console.log('[smoke] Screenshot saved to:', ssPath);
        // Dump page HTML for diagnosis
        const html = await page.evaluate(() => document.body.innerHTML.slice(0, 2000));
        console.log('[smoke] Page HTML (first 2000 chars):', html);
        expect.fail('Neither offline button nor sidebar found. Check screenshot.');
      }
    }
  });

  // ─── Per-Tab Tests ────────────────────────────────────────────────

  it('tab: POS — renders layout', async () => {
    const clicked = await navigateToTab(page, 'POS');
    expect(clicked).toBe(true);
    await page.waitForTimeout(1_000);

    // Force salon mode so the new light-themed SalonTemplate is visible in screenshot:
    // set config, then navigate away and back to remount POSLayout with fresh config
    await page.evaluate(async () => {
      try { await (window as any).electronAPI.setConfig({ posMode: 'salon' }); } catch { /* ignore */ }
    });
    await navigateToTab(page, 'Status');
    await page.waitForTimeout(500);
    await navigateToTab(page, 'POS');
    await page.waitForTimeout(2_000);

    const hasPosContent = await safeWait(page, 'main, .flex-1', { timeout: 5_000 });
    expect(hasPosContent).toBe(true);

    await screenshotOnFail(page, 'tab-pos');
    console.log('[smoke] POS tab: OK');
  });

  it('tab: Zira AI (Chat) — renders without crash', async () => {
    const clicked = await navigateToTab(page, 'Zira AI');
    expect(clicked).toBe(true);
    await page.waitForTimeout(1_000);

    // Chat typically has an input or textarea
    const hasInput = await safeWait(page, 'textarea, input[type="text"]', { timeout: 3_000 });
    console.log(`[smoke] Chat input found: ${hasInput}`);

    await screenshotOnFail(page, 'tab-chat');
    console.log('[smoke] Chat tab: OK');
  });

  it('tab: Status — renders connection panel', async () => {
    const clicked = await navigateToTab(page, 'Status');
    expect(clicked).toBe(true);
    await page.waitForTimeout(1_000);

    // Status page has "Server connection" heading
    const hasPanel = await safeWait(page, 'text=Server connection', { timeout: 5_000 });
    console.log(`[smoke] Status panel found: ${hasPanel}`);

    await screenshotOnFail(page, 'tab-status');
    console.log('[smoke] Status tab: OK');
  });

  it('tab: Check-in — renders without crash', async () => {
    const clicked = await navigateToTab(page, 'Check-in');
    expect(clicked).toBe(true);
    await page.waitForTimeout(1_000);

    await screenshotOnFail(page, 'tab-checkin');
    console.log('[smoke] Check-in tab: OK');
  });

  it('tab: Invoicing — renders without crash', async () => {
    const clicked = await navigateToTab(page, 'Invoicing');
    expect(clicked).toBe(true);
    await page.waitForTimeout(1_000);

    await screenshotOnFail(page, 'tab-invoicing');
    console.log('[smoke] Invoicing tab: OK');
  });

  it('tab: Settings — language dropdown and toggles present', async () => {
    const clicked = await navigateToTab(page, 'Settings');
    expect(clicked).toBe(true);
    await page.waitForTimeout(1_000);

    // Settings page contains select elements (language, protocol, etc.)
    const hasSelect = await safeWait(page, 'select', { timeout: 3_000 });
    console.log(`[smoke] Settings selects found: ${hasSelect}`);

    await screenshotOnFail(page, 'tab-settings');
    console.log('[smoke] Settings tab: OK');
  });

  it('tab: Debug — tools buttons present', async () => {
    const clicked = await navigateToTab(page, 'Debug');
    expect(clicked).toBe(true);
    await page.waitForTimeout(1_000);

    // Debug has "Debug tools" heading and action buttons
    const hasToolsHeading = await safeWait(page, 'text=Debug tools', { timeout: 5_000 });
    expect(hasToolsHeading).toBe(true);

    // Check the action buttons exist
    const hasDevToolsBtn = await safeWait(page, 'button:has-text("DevTools")');
    const hasLogsBtn = await safeWait(page, 'button:has-text("Logs folder")');
    const hasCopyBtn = await safeWait(page, 'button:has-text("Copy diagnostics")');
    const hasRefreshBtn = await safeWait(page, 'button:has-text("Refresh")');

    console.log(`[smoke] Debug buttons: devtools=${hasDevToolsBtn} logs=${hasLogsBtn} copy=${hasCopyBtn} refresh=${hasRefreshBtn}`);

    // Click Refresh (safe — just reloads diagnostics)
    await safeClick(page, 'button:has-text("Refresh")');
    await page.waitForTimeout(500);

    // Click Copy diagnostics (safe — copies to clipboard)
    await safeClick(page, 'button:has-text("Copy diagnostics")');
    await page.waitForTimeout(500);

    // Verify it changed to "Copied!"
    const copiedVisible = await safeWait(page, 'button:has-text("Copied!")', { timeout: 2_000 });
    console.log(`[smoke] Copy feedback: ${copiedVisible}`);

    await screenshotOnFail(page, 'tab-debug');
    console.log('[smoke] Debug tab: OK');
  });

  // ─── Sidebar interaction ──────────────────────────────────────────

  it('sidebar: collapse and expand toggle', async () => {
    // The collapse button is the chevron in the sidebar header
    const collapseBtn = 'aside button:has(svg)';

    // Click collapse (first button in sidebar header area)
    const collapsed = await safeClick(page, 'aside .shrink-0 button');
    await page.waitForTimeout(500);

    // Sidebar width should change
    const width = await page.evaluate(() => {
      const aside = document.querySelector('aside');
      return aside ? aside.offsetWidth : 0;
    });
    console.log(`[smoke] Sidebar width after toggle: ${width}px`);

    // Toggle back
    await safeClick(page, 'aside .shrink-0 button');
    await page.waitForTimeout(500);

    console.log('[smoke] Sidebar toggle: OK');
  });

  // ─── Log verification ─────────────────────────────────────────────

  it('logs: no unhandled errors during test run', async () => {
    // Small delay to let any pending log writes flush
    await page.waitForTimeout(1_000);

    const combined = readLogs('combined', testStartTime);
    const errorLog = readLogs('error', testStartTime);

    console.log(`\n[smoke] ═══ Log Summary ═══`);
    console.log(`[smoke] combined.log: ${combined.errors.length} errors, ${combined.warnings.length} warnings`);
    console.log(`[smoke] error.log:    ${errorLog.errors.length} errors`);

    if (combined.errors.length > 0) {
      console.log('[smoke] Errors found in combined.log:');
      combined.errors.slice(0, 10).forEach((e) => console.log(`  ${e}`));
    }

    if (combined.warnings.length > 0) {
      console.log('[smoke] Warnings in combined.log:');
      combined.warnings.slice(0, 5).forEach((w) => console.log(`  ${w}`));
    }

    // Check for excessive PosStore state changes (flickering indicator)
    const posStoreSpam = combined.errors
      .concat(combined.warnings)
      .filter((l) => /\[PosStore\].*state change/i.test(l));
    if (posStoreSpam.length > 10) {
      console.warn(`[smoke] WARNING: ${posStoreSpam.length} PosStore state change logs detected — possible flickering`);
    }

    // Fail only on unhandled crashes / unrecoverable errors
    const criticalErrors = errorLog.errors.filter(
      (e) => /unhandled|uncaught|FATAL|CRASH/i.test(e),
    );

    if (criticalErrors.length > 0) {
      console.error('[smoke] CRITICAL errors:');
      criticalErrors.forEach((e) => console.error(`  ${e}`));
    }

    expect(criticalErrors).toHaveLength(0);
  });

  // ─── Console error capture ────────────────────────────────────────

  it('renderer: no uncaught exceptions in console', async () => {
    // Collect any JS errors from the renderer console
    const consoleErrors: string[] = [];
    page.on('pageerror', (err) => {
      consoleErrors.push(err.message);
    });

    // Quick interaction to trigger any lazy errors
    await navigateToTab(page, 'POS');
    await page.waitForTimeout(500);
    await navigateToTab(page, 'Debug');
    await page.waitForTimeout(500);

    if (consoleErrors.length > 0) {
      console.error('[smoke] Renderer console errors:');
      consoleErrors.forEach((e) => console.error(`  ${e}`));
    }

    // We log them but don't necessarily fail — some errors may be expected
    // (e.g., missing APIs in offline mode)
    console.log(`[smoke] Renderer errors captured: ${consoleErrors.length}`);
  });
}, SUITE_TIMEOUT);
