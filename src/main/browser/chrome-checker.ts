/**
 * Chrome Process Checker
 * Checks if Chrome is running and prompts user to close it before automation
 */

import { exec } from 'child_process';
import { dialog, BrowserWindow } from 'electron';
import logger from '../logger';

export interface ChromeCheckResult {
  isRunning: boolean;
  processCount: number;
  userClosed: boolean;
  forceClosed: boolean;
}

/**
 * Check if Chrome processes are running
 */
export async function isChromeRunning(): Promise<{ isRunning: boolean; processCount: number }> {
  return new Promise((resolve) => {
    const platform = process.platform;
    let command: string;

    if (platform === 'win32') {
      // Windows: tasklist to find chrome.exe
      command = 'tasklist /FI "IMAGENAME eq chrome.exe" /NH';
    } else if (platform === 'darwin') {
      // macOS: pgrep for Chrome
      command = 'pgrep -x "Google Chrome"';
    } else {
      // Linux: pgrep for chrome
      command = 'pgrep -x chrome || pgrep -x chromium';
    }

    exec(command, (error, stdout) => {
      if (platform === 'win32') {
        // Windows: check if any chrome.exe processes found
        const lines = stdout.trim().split('\n').filter(line => line.includes('chrome.exe'));
        resolve({
          isRunning: lines.length > 0,
          processCount: lines.length,
        });
      } else {
        // Unix: check if pgrep found any PIDs
        const pids = stdout.trim().split('\n').filter(Boolean);
        resolve({
          isRunning: pids.length > 0,
          processCount: pids.length,
        });
      }
    });
  });
}

/**
 * Kill all Chrome processes
 */
export async function killChromeProcesses(): Promise<boolean> {
  return new Promise((resolve) => {
    const platform = process.platform;
    let command: string;

    if (platform === 'win32') {
      command = 'taskkill /F /IM chrome.exe /T';
    } else if (platform === 'darwin') {
      command = 'pkill -9 "Google Chrome"';
    } else {
      command = 'pkill -9 chrome || pkill -9 chromium';
    }

    exec(command, (error) => {
      if (error) {
        logger.warn('[ChromeChecker] Failed to kill Chrome processes:', error.message);
        resolve(false);
      } else {
        logger.info('[ChromeChecker] Chrome processes terminated');
        resolve(true);
      }
    });
  });
}

/**
 * Check Chrome and prompt user to close if running
 * Returns true if Chrome is not running or user closed it
 */
export async function checkChromeAndPrompt(
  parentWindow?: BrowserWindow | null,
  options?: {
    title?: string;
    message?: string;
    allowForceClose?: boolean;
  }
): Promise<ChromeCheckResult> {
  const { isRunning, processCount } = await isChromeRunning();

  if (!isRunning) {
    logger.info('[ChromeChecker] Chrome is not running');
    return {
      isRunning: false,
      processCount: 0,
      userClosed: false,
      forceClosed: false,
    };
  }

  logger.info(`[ChromeChecker] Chrome is running (${processCount} processes)`);

  const {
    title = 'Chrome đang chạy',
    message = 'Vui lòng đóng tất cả cửa sổ Chrome để tiếp tục.\n\nPlaywright cần Chrome không chạy để có thể mở trình duyệt tự động.',
    allowForceClose = true,
  } = options || {};

  const buttons = allowForceClose
    ? ['Tôi đã đóng Chrome', 'Tự động đóng Chrome', 'Hủy']
    : ['Tôi đã đóng Chrome', 'Hủy'];

  const result = await dialog.showMessageBox(parentWindow || BrowserWindow.getFocusedWindow() || undefined as any, {
    type: 'warning',
    title,
    message,
    detail: `Phát hiện ${processCount} tiến trình Chrome đang chạy.`,
    buttons,
    defaultId: 0,
    cancelId: allowForceClose ? 2 : 1,
    noLink: true,
  });

  // User clicked "I've closed Chrome"
  if (result.response === 0) {
    // Wait a moment and re-check
    await new Promise(r => setTimeout(r, 1000));
    const recheck = await isChromeRunning();

    if (recheck.isRunning) {
      // Chrome still running, show warning
      await dialog.showMessageBox(parentWindow || BrowserWindow.getFocusedWindow() || undefined as any, {
        type: 'error',
        title: 'Chrome vẫn đang chạy',
        message: `Vẫn còn ${recheck.processCount} tiến trình Chrome đang chạy.\n\nVui lòng đóng tất cả cửa sổ Chrome và thử lại.`,
        buttons: ['OK'],
      });
      return {
        isRunning: true,
        processCount: recheck.processCount,
        userClosed: false,
        forceClosed: false,
      };
    }

    logger.info('[ChromeChecker] User closed Chrome successfully');
    return {
      isRunning: false,
      processCount: 0,
      userClosed: true,
      forceClosed: false,
    };
  }

  // User clicked "Force close Chrome" (if allowed)
  if (allowForceClose && result.response === 1) {
    const killed = await killChromeProcesses();

    if (killed) {
      // Wait a moment for processes to fully terminate
      await new Promise(r => setTimeout(r, 1500));

      const recheck = await isChromeRunning();
      if (!recheck.isRunning) {
        logger.info('[ChromeChecker] Chrome force-closed successfully');
        return {
          isRunning: false,
          processCount: 0,
          userClosed: false,
          forceClosed: true,
        };
      }
    }

    // Failed to kill
    await dialog.showMessageBox(parentWindow || BrowserWindow.getFocusedWindow() || undefined as any, {
      type: 'error',
      title: 'Không thể đóng Chrome',
      message: 'Không thể tự động đóng Chrome.\n\nVui lòng đóng Chrome thủ công và thử lại.',
      buttons: ['OK'],
    });

    return {
      isRunning: true,
      processCount,
      userClosed: false,
      forceClosed: false,
    };
  }

  // User clicked "Cancel"
  logger.info('[ChromeChecker] User cancelled');
  return {
    isRunning: true,
    processCount,
    userClosed: false,
    forceClosed: false,
  };
}

/**
 * Simple check and prompt - returns true if ready to proceed
 */
export async function ensureChromeNotRunning(
  parentWindow?: BrowserWindow | null
): Promise<boolean> {
  const result = await checkChromeAndPrompt(parentWindow, {
    allowForceClose: true,
  });

  return !result.isRunning;
}
