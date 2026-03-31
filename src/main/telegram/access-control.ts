/**
 * Access Control System (moltbot-style)
 * Handles dmPolicy, groupPolicy, pairing, allowlists, and per-chat permissions
 */

import { Context } from 'grammy';
import {
  TelegramDMPolicy,
  TelegramGroupPolicy,
  TelegramPairingRequest,
  TelegramConfig,
  TelegramGroupConfig,
} from '../../shared/types';
import { getConfig, setConfig } from '../config/store';
import logger from '../logger';

// Pending pairing requests
const pendingPairings = new Map<string, TelegramPairingRequest>();

// Pairing code expiration (5 minutes)
const PAIRING_EXPIRATION_MS = 5 * 60 * 1000;

// Rate limit for unauthorized users
const unauthorizedRateLimit = new Map<number, number>();
const UNAUTHORIZED_RATE_LIMIT_MS = 30 * 1000; // 30 seconds between messages from unauthorized users

/**
 * Generate a random 6-digit pairing code
 */
function generatePairingCode(): string {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

/**
 * Get Telegram config (with defaults)
 */
function getTelegramConfig(): TelegramConfig {
  const config = getConfig();
  return config.telegram || {
    enabled: false,
    dmPolicy: 'allowlist',
    groupPolicy: 'disabled',
    allowFrom: [],
    groupAllowFrom: [],
    groups: {},
    dms: {},
    replyToMode: 'first',
    streamMode: 'off',
    mediaMaxMb: 5,
    historyLimit: 50,
    reactionNotifications: 'off',
    reactionLevel: 'off',
    enableInput: false,
    enableBrowser: false,
  };
}

/**
 * Check if user ID or username is in an allowlist
 */
function isInAllowlist(
  userId: number,
  username: string | undefined,
  allowlist: (number | string)[]
): boolean {
  // Check for wildcard
  if (allowlist.includes('*')) {
    return true;
  }

  // Check user ID
  if (allowlist.includes(userId)) {
    return true;
  }

  // Check username (with or without @)
  if (username) {
    const normalizedUsername = username.toLowerCase().replace(/^@/, '');
    for (const entry of allowlist) {
      if (typeof entry === 'string') {
        const normalizedEntry = entry.toLowerCase().replace(/^@/, '');
        if (normalizedEntry === normalizedUsername) {
          return true;
        }
      }
    }
  }

  return false;
}

/**
 * Check DM access based on policy
 */
export async function checkDMAccess(ctx: Context): Promise<{
  allowed: boolean;
  reason?: string;
  pairingCode?: string;
}> {
  const telegram = getTelegramConfig();
  const userId = ctx.from?.id;
  const username = ctx.from?.username;

  if (!userId) {
    return { allowed: false, reason: 'No user ID' };
  }

  const policy = telegram.dmPolicy;

  switch (policy) {
    case 'disabled':
      return { allowed: false, reason: 'DMs are disabled' };

    case 'open':
      // Open policy - allow all (but require explicit '*' in allowlist for safety)
      if (telegram.allowFrom.includes('*')) {
        return { allowed: true };
      }
      return { allowed: false, reason: 'Open mode not configured (add "*" to allowFrom)' };

    case 'allowlist':
      // Check if user is in allowlist
      if (isInAllowlist(userId, username, telegram.allowFrom)) {
        return { allowed: true };
      }
      return {
        allowed: false,
        reason: `Unauthorized. Your ID: ${userId}`,
      };

    case 'pairing':
      // Check if user is already authorized
      if (isInAllowlist(userId, username, telegram.allowFrom)) {
        return { allowed: true };
      }

      // Check for existing pairing request
      const existingPairing = Array.from(pendingPairings.values()).find(
        p => p.userId === userId
      );

      if (existingPairing && existingPairing.expiresAt > Date.now()) {
        return {
          allowed: false,
          reason: 'Pairing pending',
          pairingCode: existingPairing.code,
        };
      }

      // Create new pairing request
      const code = generatePairingCode();
      const request: TelegramPairingRequest = {
        code,
        userId,
        username,
        firstName: ctx.from?.first_name,
        requestedAt: Date.now(),
        expiresAt: Date.now() + PAIRING_EXPIRATION_MS,
      };

      pendingPairings.set(code, request);
      logger.info(`[AccessControl] New pairing request from ${userId}: ${code}`);

      return {
        allowed: false,
        reason: 'Pairing required',
        pairingCode: code,
      };

    default:
      return { allowed: false, reason: 'Unknown policy' };
  }
}

/**
 * Check group access based on policy
 */
export function checkGroupAccess(ctx: Context): {
  allowed: boolean;
  reason?: string;
  requireMention?: boolean;
} {
  const telegram = getTelegramConfig();
  const chatId = ctx.chat?.id;
  const userId = ctx.from?.id;
  const username = ctx.from?.username;

  if (!chatId || !userId) {
    return { allowed: false, reason: 'Invalid chat or user' };
  }

  const policy = telegram.groupPolicy;
  const chatIdStr = chatId.toString();
  const groupConfig = telegram.groups?.[chatIdStr] || telegram.groups?.['*'];

  switch (policy) {
    case 'disabled':
      return { allowed: false, reason: 'Groups are disabled' };

    case 'open':
      // Check if this specific group is allowed
      const isGroupAllowed = telegram.groups?.[chatIdStr] !== undefined ||
                             telegram.groups?.['*'] !== undefined;
      if (isGroupAllowed) {
        return {
          allowed: true,
          requireMention: groupConfig?.requireMention ?? true,
        };
      }
      return { allowed: false, reason: 'Group not configured' };

    case 'allowlist':
      // Check if user is in group allowlist
      if (isInAllowlist(userId, username, telegram.groupAllowFrom)) {
        return {
          allowed: true,
          requireMention: groupConfig?.requireMention ?? true,
        };
      }
      // Also check per-group allowlist
      if (groupConfig?.allowedUserIds && groupConfig.allowedUserIds.includes(userId)) {
        return {
          allowed: true,
          requireMention: groupConfig.requireMention ?? true,
        };
      }
      return { allowed: false, reason: 'User not in group allowlist' };

    default:
      return { allowed: false, reason: 'Unknown policy' };
  }
}

/**
 * Check if bot is mentioned in message
 */
export function isBotMentioned(ctx: Context, botUsername: string | null): boolean {
  const text = ctx.message?.text || ctx.message?.caption || '';

  if (!botUsername) {
    return false;
  }

  // Check for @mention
  const mentionPattern = new RegExp(`@${botUsername}\\b`, 'i');
  if (mentionPattern.test(text)) {
    return true;
  }

  // Check entities for mention
  const entities = ctx.message?.entities || ctx.message?.caption_entities || [];
  for (const entity of entities) {
    if (entity.type === 'mention') {
      const mentionText = text.substring(entity.offset, entity.offset + entity.length);
      if (mentionText.toLowerCase() === `@${botUsername.toLowerCase()}`) {
        return true;
      }
    }
  }

  return false;
}

/**
 * Approve a pairing request
 */
export function approvePairing(code: string): {
  success: boolean;
  userId?: number;
  username?: string;
  error?: string;
} {
  const request = pendingPairings.get(code);

  if (!request) {
    return { success: false, error: 'Invalid pairing code' };
  }

  if (request.expiresAt < Date.now()) {
    pendingPairings.delete(code);
    return { success: false, error: 'Pairing code expired' };
  }

  // Add user to allowlist
  const config = getConfig();
  const telegram = config.telegram || getTelegramConfig();

  if (!telegram.allowFrom.includes(request.userId)) {
    telegram.allowFrom.push(request.userId);
  }

  setConfig({ telegram });
  pendingPairings.delete(code);

  logger.info(`[AccessControl] Approved pairing for user ${request.userId} (${request.username})`);

  return {
    success: true,
    userId: request.userId,
    username: request.username,
  };
}

/**
 * Reject a pairing request
 */
export function rejectPairing(code: string): boolean {
  const request = pendingPairings.get(code);

  if (!request) {
    return false;
  }

  pendingPairings.delete(code);
  logger.info(`[AccessControl] Rejected pairing for user ${request.userId}`);
  return true;
}

/**
 * Get all pending pairing requests
 */
export function getPendingPairings(): TelegramPairingRequest[] {
  const now = Date.now();
  const valid: TelegramPairingRequest[] = [];

  for (const [code, request] of pendingPairings.entries()) {
    if (request.expiresAt > now) {
      valid.push(request);
    } else {
      pendingPairings.delete(code);
    }
  }

  return valid;
}

/**
 * Add user to allowlist
 */
export function addToAllowlist(userId: number | string): boolean {
  const config = getConfig();
  const telegram = config.telegram || getTelegramConfig();

  const entry = typeof userId === 'string' && userId.startsWith('@')
    ? userId
    : Number(userId);

  if (!telegram.allowFrom.includes(entry)) {
    telegram.allowFrom.push(entry);
    setConfig({ telegram });
    logger.info(`[AccessControl] Added ${entry} to allowlist`);
    return true;
  }

  return false;
}

/**
 * Remove user from allowlist
 */
export function removeFromAllowlist(userId: number | string): boolean {
  const config = getConfig();
  const telegram = config.telegram || getTelegramConfig();

  const entry = typeof userId === 'string' && userId.startsWith('@')
    ? userId
    : Number(userId);

  const index = telegram.allowFrom.indexOf(entry);
  if (index !== -1) {
    telegram.allowFrom.splice(index, 1);
    setConfig({ telegram });
    logger.info(`[AccessControl] Removed ${entry} from allowlist`);
    return true;
  }

  return false;
}

/**
 * Configure a group
 */
export function configureGroup(
  chatId: number | string,
  config: TelegramGroupConfig
): void {
  const appConfig = getConfig();
  const telegram = appConfig.telegram || getTelegramConfig();

  telegram.groups = telegram.groups || {};
  telegram.groups[chatId.toString()] = {
    ...telegram.groups[chatId.toString()],
    ...config,
  };

  setConfig({ telegram });
  logger.info(`[AccessControl] Updated group config for ${chatId}`);
}

/**
 * Check rate limit for unauthorized users
 */
export function checkUnauthorizedRateLimit(userId: number): boolean {
  const now = Date.now();
  const lastTime = unauthorizedRateLimit.get(userId) || 0;

  if (now - lastTime < UNAUTHORIZED_RATE_LIMIT_MS) {
    return false; // Rate limited
  }

  unauthorizedRateLimit.set(userId, now);
  return true; // Allowed
}

/**
 * Clean up expired data
 */
export function cleanup(): void {
  const now = Date.now();

  // Clean expired pairings
  for (const [code, request] of pendingPairings.entries()) {
    if (request.expiresAt < now) {
      pendingPairings.delete(code);
    }
  }

  // Clean old rate limit entries
  const expireTime = now - (5 * 60 * 1000);
  for (const [userId, lastTime] of unauthorizedRateLimit.entries()) {
    if (lastTime < expireTime) {
      unauthorizedRateLimit.delete(userId);
    }
  }
}

// Run cleanup every minute
setInterval(cleanup, 60000);

logger.info('[AccessControl] Module loaded');
