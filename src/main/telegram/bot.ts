/**
 * Telegram Bot (moltbot-style)
 * Creates and manages the grammy Bot instance with full access control
 */

import { Bot, Context, NextFunction } from 'grammy';
import { getConfig, getConfigValue } from '../config/store';
import { checkAccess, buildMessageContext, sendReply } from './message-handler';
import logger from '../logger';

let bot: Bot | null = null;
let botUsername: string | null = null;

// Rate limiting - track last command time per user
const userRateLimits = new Map<number, number>();
const RATE_LIMIT_MS = 1000; // 1 second between commands
const RATE_LIMIT_CLEANUP_INTERVAL = 60000;

// Cleanup old rate limit entries periodically
let rateLimitCleanupTimer: ReturnType<typeof setInterval> | null = setInterval(() => {
  const now = Date.now();
  const expireTime = now - (5 * 60 * 1000);
  for (const [userId, lastTime] of userRateLimits.entries()) {
    if (lastTime < expireTime) {
      userRateLimits.delete(userId);
    }
  }
}, RATE_LIMIT_CLEANUP_INTERVAL);

/**
 * Get sequential key for per-chat sequentialization
 */
function getSequentialKey(ctx: Context): string {
  const chatId = ctx.chat?.id;
  const threadId = ctx.message?.message_thread_id;
  const isCommand = ctx.message?.text?.startsWith('/');

  // Commands get priority processing
  if (isCommand) {
    return `telegram:${chatId}:control`;
  }

  // Forum topics get separate keys
  if (threadId) {
    return `telegram:${chatId}:topic:${threadId}`;
  }

  return `telegram:${chatId}`;
}

/**
 * Create a new Telegram bot instance (moltbot-style)
 */
export function createTelegramBot(token: string): Bot {
  if (bot) {
    logger.warn('[Telegram] Bot already exists, destroying old instance first');
    destroyTelegramBot();
  }

  logger.info('[Telegram] Creating new bot instance...');
  bot = new Bot(token);

  // Sequentialization middleware - ensures messages from same chat processed in order
  // Note: @grammyjs/runner may not be installed, using simple approach
  // bot.use(grammySequentialize(getSequentialKey));

  // Rate limiting middleware
  bot.use(async (ctx: Context, next: NextFunction) => {
    const userId = ctx.from?.id;
    if (!userId) {
      await next();
      return;
    }

    const now = Date.now();
    const lastCommandTime = userRateLimits.get(userId) || 0;

    if (now - lastCommandTime < RATE_LIMIT_MS) {
      logger.debug(`[Telegram] Rate limited user ${userId}`);
      // Silent rate limit for non-commands
      if (ctx.message?.text?.startsWith('/')) {
        await ctx.reply('⏳ Too fast! Please wait 1 second between commands.');
      }
      return;
    }

    userRateLimits.set(userId, now);
    await next();
  });

  // Access control middleware (moltbot-style)
  bot.use(async (ctx: Context, next: NextFunction) => {
    // Skip for callback queries (buttons)
    if (ctx.callbackQuery) {
      await next();
      return;
    }

    // Skip non-message updates
    if (!ctx.message && !ctx.editedMessage) {
      await next();
      return;
    }

    const accessResult = await checkAccess(ctx);

    if (!accessResult.allowed) {
      if (accessResult.response) {
        await ctx.reply(accessResult.response, { parse_mode: 'Markdown' });
      }
      return;
    }

    // For groups, check if mention is required
    const chatType = ctx.chat?.type;
    if ((chatType === 'group' || chatType === 'supergroup') && accessResult.requireMention) {
      const msgCtx = buildMessageContext(ctx);
      const isCommand = ctx.message?.text?.startsWith('/');

      // Allow commands and mentions
      if (!isCommand && !msgCtx?.isMention) {
        // Not mentioned, skip (don't process)
        return;
      }
    }

    // User is authorized, proceed
    logger.debug(`[Telegram] Authorized: ${ctx.from?.id} in ${ctx.chat?.type}`);
    await next();
  });

  return bot;
}

/**
 * Get the current bot instance
 */
export function getTelegramBot(): Bot | null {
  return bot;
}

/**
 * Get the bot username (set after bot.start())
 */
export function getBotUsername(): string | null {
  return botUsername;
}

/**
 * Set the bot username (called from polling.ts after bot starts)
 */
export function setBotUsername(username: string): void {
  botUsername = username;
}

/**
 * Destroy the bot instance
 */
export function destroyTelegramBot(): void {
  if (bot) {
    logger.info('[Telegram] Destroying bot instance...');
    bot = null;
    botUsername = null;
  }
  userRateLimits.clear();
  if (rateLimitCleanupTimer) {
    clearInterval(rateLimitCleanupTimer);
    rateLimitCleanupTimer = null;
  }
}

/**
 * Check if bot is running
 */
export function isBotRunning(): boolean {
  return bot !== null;
}

/**
 * Get bot info
 */
export async function getBotInfo(): Promise<{
  id: number;
  username: string;
  firstName: string;
} | null> {
  if (!bot) return null;

  try {
    const me = await bot.api.getMe();
    return {
      id: me.id,
      username: me.username,
      firstName: me.first_name,
    };
  } catch (error) {
    logger.error('[Telegram] Failed to get bot info:', error);
    return null;
  }
}

// Type exports
export { Bot };
export type TelegramBot = Bot;
