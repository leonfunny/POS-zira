/**
 * Telegram Polling - Manages bot polling lifecycle
 */

import { Bot } from 'grammy';
import { setBotUsername } from './bot';
import logger from '../logger';

let isRunning = false;
let lastError: string | null = null;

/**
 * Start long polling for the bot
 */
export async function startPolling(bot: Bot): Promise<void> {
  if (isRunning) {
    logger.warn('[Telegram] Polling already running');
    return;
  }

  logger.info('[Telegram] Starting long polling...');
  lastError = null;

  // Set up error handler - reset isRunning on fatal errors
  bot.catch((err) => {
    logger.error('[Telegram] Bot error:', err);
    lastError = err.message || 'Unknown error';
    // If polling crashes fatally, reset the running state so it can be restarted
    if (err.message?.includes('terminated') || err.message?.includes('network')) {
      isRunning = false;
      logger.warn('[Telegram] Polling state reset due to fatal error');
    }
  });

  try {
    // Get bot info first
    const me = await bot.api.getMe();
    setBotUsername(me.username);
    logger.info(`[Telegram] Bot started as @${me.username}`);

    isRunning = true;

    // Start polling (non-blocking)
    bot.start({
      onStart: (info) => {
        logger.info(`[Telegram] Polling started for @${info.username}`);
      },
    });
  } catch (error: any) {
    logger.error('[Telegram] Failed to start polling:', error);
    lastError = error.message || 'Failed to start';
    isRunning = false;
    throw error;
  }
}

/**
 * Stop polling
 */
export async function stopPolling(bot: Bot): Promise<void> {
  if (!isRunning) {
    logger.warn('[Telegram] Polling not running');
    return;
  }

  logger.info('[Telegram] Stopping polling...');

  try {
    await bot.stop();
    isRunning = false;
    logger.info('[Telegram] Polling stopped');
  } catch (error: any) {
    logger.error('[Telegram] Error stopping polling:', error);
    // Force stop state
    isRunning = false;
  }
}

/**
 * Check if polling is running
 */
export function isPollingRunning(): boolean {
  return isRunning;
}

/**
 * Get last error message
 */
export function getLastError(): string | null {
  return lastError;
}

/**
 * Clear last error
 */
export function clearLastError(): void {
  lastError = null;
}

/**
 * Restart polling
 */
export async function restartPolling(bot: Bot): Promise<void> {
  logger.info('[Telegram] Restarting polling...');
  await stopPolling(bot);
  // Small delay before restart
  await new Promise(resolve => setTimeout(resolve, 1000));
  await startPolling(bot);
}
