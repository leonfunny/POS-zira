/**
 * E2E test helpers for Playwright + Electron.
 *
 * Uses `playwright` (not playwright-core) so we get the Electron
 * helper via `_electron`.  The app is built first, then launched
 * with `electron .` pointing at the compiled dist/.
 */

import { _electron as electron, type ElectronApplication, type Page } from 'playwright';
import { spawnSync } from 'child_process';
import { readFileSync, existsSync, mkdtempSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// ─── Constants ──────────────────────────────────────────────────────

const ROOT = join(__dirname, '..', '..');

/** Where Winston writes logs (mirrors logger.ts → app.getPath('userData')) */
function getLogDir(): string {
  const appData = process.env.APPDATA || join(process.env.HOME || '', 'AppData', 'Roaming');
  return join(appData, 'enail-print-agent', 'logs');
}

// ─── Launch ─────────────────────────────────────────────────────────

export interface LaunchResult {
  app: ElectronApplication;
  page: Page;
}

/**
 * Build the app (main + renderer) then launch Electron.
 * Returns the ElectronApplication and first window Page.
 */
export async function launchApp(): Promise<LaunchResult> {
  // Build main process (tsc)
  function run(cmd: string) {
    const result = spawnSync(cmd, { cwd: ROOT, stdio: 'pipe', shell: true });
    if (result.status !== 0) {
      throw new Error(`Command failed (${result.status}): ${cmd}\n${result.stderr?.toString()}`);
    }
  }

  console.log('[e2e] Building main process…');
  run('npx tsc -p tsconfig.main.json');

  // Build renderer (vite)
  console.log('[e2e] Building renderer…');
  run('npx vite build');

  // Use a temp user-data-dir so the test instance doesn't conflict with
  // a running production app (which holds the single-instance lock).
  const tempUserData = mkdtempSync(join(tmpdir(), 'zira-e2e-'));

  console.log('[e2e] Launching Electron…');
  const app = await electron.launch({
    args: ['.', `--user-data-dir=${tempUserData}`],
    cwd: ROOT,
    env: {
      ...process.env,
      NODE_ENV: 'production',
      E2E_TEST: '1',
      ELECTRON_USER_DATA_DIR: tempUserData,
    },
    timeout: 30_000,
  });

  const page = await app.firstWindow();
  // Wait for the renderer to paint something
  await page.waitForLoadState('domcontentloaded');
  return { app, page };
}

// ─── Log Reader ─────────────────────────────────────────────────────

export interface LogEntries {
  errors: string[];
  warnings: string[];
}

/**
 * Read log files and return lines that appeared after `since`.
 * @param type  'error' reads error.log; 'combined' reads combined.log
 * @param since Only return lines timestamped after this Date
 */
export function readLogs(type: 'error' | 'combined', since?: Date): LogEntries {
  const filename = type === 'error' ? 'error.log' : 'combined.log';
  const filepath = join(getLogDir(), filename);

  if (!existsSync(filepath)) {
    return { errors: [], warnings: [] };
  }

  const raw = readFileSync(filepath, 'utf-8');
  const lines = raw.split('\n').filter(Boolean);

  const errors: string[] = [];
  const warnings: string[] = [];

  for (const line of lines) {
    // Winston format: "2026-02-22 14:05:33 [ERROR] message"
    if (since) {
      const tsMatch = line.match(/^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})/);
      if (tsMatch) {
        const lineDate = new Date(tsMatch[1].replace(' ', 'T'));
        if (lineDate < since) continue;
      }
    }

    if (/\[ERROR\]/i.test(line)) {
      errors.push(line);
    } else if (/\[WARN\]/i.test(line)) {
      warnings.push(line);
    }
  }

  return { errors, warnings };
}

// ─── UI Helpers ─────────────────────────────────────────────────────

/**
 * Click a selector if it exists. Returns true if clicked, false if
 * the element was not found within the timeout.
 */
export async function safeClick(
  page: Page,
  selector: string,
  options?: { timeout?: number },
): Promise<boolean> {
  try {
    await page.click(selector, { timeout: options?.timeout ?? 3_000 });
    return true;
  } catch {
    return false;
  }
}

/**
 * Wait for a selector to appear. Returns true if found within
 * timeout, false otherwise.
 */
export async function safeWait(
  page: Page,
  selector: string,
  options?: { timeout?: number },
): Promise<boolean> {
  try {
    await page.waitForSelector(selector, { timeout: options?.timeout ?? 5_000 });
    return true;
  } catch {
    return false;
  }
}

/**
 * Take a screenshot and save it to tests/e2e/screenshots/.
 * File name is sanitised from testName.
 */
export async function screenshotOnFail(page: Page, testName: string): Promise<string> {
  const dir = join(ROOT, 'tests', 'e2e', 'screenshots');
  const safe = testName.replace(/[^a-zA-Z0-9_-]/g, '_');
  const filepath = join(dir, `${safe}.png`);
  await page.screenshot({ path: filepath, fullPage: true });
  return filepath;
}

/**
 * Click a sidebar tab button by its `data-tooltip` or by matching
 * the tab name in the sidebar item text.
 */
export async function navigateToTab(page: Page, tab: string): Promise<boolean> {
  // Sidebar buttons have class "sidebar-item" and contain text or data-tooltip
  const selector = `aside button.sidebar-item:has-text("${tab}"), aside button[data-tooltip="${tab}"]`;
  return safeClick(page, selector, { timeout: 5_000 });
}
