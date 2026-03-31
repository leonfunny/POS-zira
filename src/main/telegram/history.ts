/**
 * Conversation History Manager (moltbot-style)
 * Per-chat/per-group history with LRU eviction and context building
 */

import { TelegramHistoryEntry } from '../../shared/types';
import { getConfig } from '../config/store';
import logger from '../logger';

// Maximum number of chat histories to keep (LRU eviction)
const MAX_HISTORY_KEYS = 1000;

// In-memory history storage
const historyStore = new Map<string, TelegramHistoryEntry[]>();

// LRU tracking - most recently used keys at the end
const lruOrder: string[] = [];

/**
 * Generate history key based on chat type
 */
export function getHistoryKey(options: {
  chatId: number;
  chatType: 'private' | 'group' | 'supergroup' | 'channel';
  threadId?: number;
  userId?: number;
}): string {
  const { chatId, chatType, threadId, userId } = options;

  if (chatType === 'private') {
    // DM: use userId or chatId
    return `dm:${userId || chatId}`;
  } else if (threadId) {
    // Forum topic: group:chatId:topic:threadId
    return `group:${chatId}:topic:${threadId}`;
  } else {
    // Regular group: group:chatId
    return `group:${chatId}`;
  }
}

/**
 * Get history limit for a specific chat
 */
function getHistoryLimit(chatId: number, chatType: string): number {
  const config = getConfig();
  const telegram = config.telegram;

  if (!telegram) {
    return 50; // Default
  }

  // Check per-chat override
  const chatIdStr = chatId.toString();

  if (chatType === 'private') {
    // Check DM-specific limit
    const dmConfig = telegram.dms?.[chatIdStr];
    if (dmConfig?.historyLimit) {
      return dmConfig.historyLimit;
    }
    // Use DM default or general default
    return telegram.dmHistoryLimit || telegram.historyLimit || 50;
  } else {
    // Check group-specific limit
    const groupConfig = telegram.groups?.[chatIdStr];
    if (groupConfig?.historyLimit) {
      return groupConfig.historyLimit;
    }
    // Use general limit
    return telegram.historyLimit || 50;
  }
}

/**
 * Update LRU order
 */
function touchLRU(key: string): void {
  const index = lruOrder.indexOf(key);
  if (index !== -1) {
    lruOrder.splice(index, 1);
  }
  lruOrder.push(key);

  // Evict oldest if over limit
  while (lruOrder.length > MAX_HISTORY_KEYS) {
    const oldestKey = lruOrder.shift();
    if (oldestKey) {
      historyStore.delete(oldestKey);
      logger.debug(`[History] Evicted oldest key: ${oldestKey}`);
    }
  }
}

/**
 * Get conversation history
 */
export function getHistory(key: string): TelegramHistoryEntry[] {
  touchLRU(key);
  return historyStore.get(key) || [];
}

/**
 * Add entry to history
 */
export function addToHistory(options: {
  chatId: number;
  chatType: 'private' | 'group' | 'supergroup' | 'channel';
  threadId?: number;
  userId?: number;
  entry: TelegramHistoryEntry;
}): void {
  const { chatId, chatType, threadId, userId, entry } = options;
  const key = getHistoryKey({ chatId, chatType, threadId, userId });
  const limit = getHistoryLimit(chatId, chatType);

  touchLRU(key);

  let history = historyStore.get(key);
  if (!history) {
    history = [];
    historyStore.set(key, history);
  }

  // Add entry
  history.push(entry);

  // Trim to limit
  if (history.length > limit) {
    history.splice(0, history.length - limit);
  }

  logger.debug(`[History] Added entry to ${key}, total: ${history.length}`);
}

/**
 * Add user message to history
 */
export function addUserMessage(options: {
  chatId: number;
  chatType: 'private' | 'group' | 'supergroup' | 'channel';
  threadId?: number;
  userId: number;
  username?: string;
  text: string;
  messageId?: number;
  replyToId?: number;
  mediaType?: string;
  mediaPath?: string;
}): void {
  const { chatId, chatType, threadId, userId, username, text, messageId, replyToId, mediaType, mediaPath } = options;

  addToHistory({
    chatId,
    chatType,
    threadId,
    userId,
    entry: {
      sender: username || userId.toString(),
      body: text,
      timestamp: Date.now(),
      messageId: messageId?.toString(),
      replyToId: replyToId?.toString(),
      mediaType,
      mediaPath,
    },
  });
}

/**
 * Add bot response to history
 */
export function addBotMessage(options: {
  chatId: number;
  chatType: 'private' | 'group' | 'supergroup' | 'channel';
  threadId?: number;
  userId?: number;
  text: string;
  messageId?: number;
}): void {
  const { chatId, chatType, threadId, userId, text, messageId } = options;

  addToHistory({
    chatId,
    chatType,
    threadId,
    userId,
    entry: {
      sender: 'bot',
      body: text,
      timestamp: Date.now(),
      messageId: messageId?.toString(),
    },
  });
}

/**
 * Add system event to history (reactions, joins, etc.)
 */
export function addSystemEvent(options: {
  chatId: number;
  chatType: 'private' | 'group' | 'supergroup' | 'channel';
  threadId?: number;
  text: string;
}): void {
  const { chatId, chatType, threadId, text } = options;

  addToHistory({
    chatId,
    chatType,
    threadId,
    entry: {
      sender: 'system',
      body: text,
      timestamp: Date.now(),
    },
  });
}

/**
 * Clear history for a specific chat
 */
export function clearHistory(options: {
  chatId: number;
  chatType: 'private' | 'group' | 'supergroup' | 'channel';
  threadId?: number;
  userId?: number;
}): void {
  const key = getHistoryKey(options);
  historyStore.delete(key);

  const index = lruOrder.indexOf(key);
  if (index !== -1) {
    lruOrder.splice(index, 1);
  }

  logger.info(`[History] Cleared history for: ${key}`);
}

/**
 * Clear all history
 */
export function clearAllHistory(): void {
  historyStore.clear();
  lruOrder.length = 0;
  logger.info('[History] Cleared all history');
}

/**
 * Build history context string for AI (moltbot-style)
 */
export function buildHistoryContext(options: {
  chatId: number;
  chatType: 'private' | 'group' | 'supergroup' | 'channel';
  threadId?: number;
  userId?: number;
  maxMessages?: number;
  currentMessage?: string;
}): string {
  const { chatId, chatType, threadId, userId, maxMessages = 10, currentMessage } = options;
  const key = getHistoryKey({ chatId, chatType, threadId, userId });
  const history = getHistory(key);

  if (history.length === 0 && !currentMessage) {
    return '';
  }

  const parts: string[] = [];

  // Add history header
  if (history.length > 0) {
    const oldestTimestamp = history[0].timestamp;
    const date = new Date(oldestTimestamp);
    parts.push(`[Chat messages since ${date.toLocaleString()}]`);

    // Get last N messages
    const recentHistory = history.slice(-maxMessages);

    for (const entry of recentHistory) {
      const time = new Date(entry.timestamp).toLocaleTimeString();
      let line = '';

      if (entry.sender === 'bot') {
        line = `[${time}] Bot: ${entry.body}`;
      } else if (entry.sender === 'system') {
        line = `[${time}] [System] ${entry.body}`;
      } else {
        line = `[${time}] ${entry.sender}: ${entry.body}`;
      }

      // Add media indicator
      if (entry.mediaType) {
        line += ` [${entry.mediaType}]`;
      }

      parts.push(line);
    }
  }

  // Add current message
  if (currentMessage) {
    parts.push('');
    parts.push('[Current message]');
    parts.push(currentMessage);
  }

  return parts.join('\n');
}

/**
 * Get history stats
 */
export function getHistoryStats(): {
  totalChats: number;
  totalMessages: number;
  lruSize: number;
} {
  let totalMessages = 0;
  for (const history of historyStore.values()) {
    totalMessages += history.length;
  }

  return {
    totalChats: historyStore.size,
    totalMessages,
    lruSize: lruOrder.length,
  };
}

/**
 * Export history for a chat (for debugging/backup)
 */
export function exportHistory(options: {
  chatId: number;
  chatType: 'private' | 'group' | 'supergroup' | 'channel';
  threadId?: number;
  userId?: number;
}): TelegramHistoryEntry[] {
  const key = getHistoryKey(options);
  return [...getHistory(key)];
}

logger.info('[History] Module loaded');
