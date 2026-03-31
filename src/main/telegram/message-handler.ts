/**
 * Message Handler (moltbot-style)
 * Handles message buffering, media groups, debouncing, and routing
 */

import { Context, Bot } from 'grammy';
import { Message } from 'grammy/types';
import { TelegramMessageContext } from '../../shared/types';
import { getConfig } from '../config/store';
import { getBotUsername } from './bot';
import {
  checkDMAccess,
  checkGroupAccess,
  isBotMentioned,
  checkUnauthorizedRateLimit,
} from './access-control';
import {
  addUserMessage,
  addBotMessage,
  buildHistoryContext,
  getHistoryKey,
} from './history';
import logger from '../logger';

// Media group buffering
const mediaGroupBuffer = new Map<string, {
  messages: Message[];
  timeout: NodeJS.Timeout;
  chatId: number;
}>();
const MEDIA_GROUP_TIMEOUT_MS = 300; // Wait 300ms for all media in group

// Text fragment buffering (for long messages split by Telegram)
const textFragmentBuffer = new Map<number, {
  text: string;
  timeout: NodeJS.Timeout;
  lastMessageId: number;
}>();
const TEXT_FRAGMENT_TIMEOUT_MS = 500;

// Inbound debouncing
const debounceBuffer = new Map<string, {
  ctx: Context;
  timeout: NodeJS.Timeout;
}>();

// Message processing queue (per-chat sequentialization)
const processingQueue = new Map<string, Promise<void>>();

/**
 * Get chat key for sequentialization
 */
function getChatKey(ctx: Context): string {
  const chatId = ctx.chat?.id;
  const threadId = ctx.message?.message_thread_id;

  if (threadId) {
    return `chat:${chatId}:thread:${threadId}`;
  }
  return `chat:${chatId}`;
}

/**
 * Build message context from Telegram context
 */
export function buildMessageContext(ctx: Context): TelegramMessageContext | null {
  const message = ctx.message;
  if (!message || !ctx.chat || !ctx.from) {
    return null;
  }

  const replyTo = message.reply_to_message;

  return {
    chatId: ctx.chat.id,
    chatType: ctx.chat.type as 'private' | 'group' | 'supergroup' | 'channel',
    chatTitle: 'title' in ctx.chat ? ctx.chat.title : undefined,
    threadId: message.message_thread_id,
    senderId: ctx.from.id,
    senderUsername: ctx.from.username,
    senderFirstName: ctx.from.first_name,
    senderLastName: ctx.from.last_name,
    messageId: message.message_id,
    messageText: message.text || message.caption || '',
    replyToMessage: replyTo ? {
      messageId: replyTo.message_id,
      text: replyTo.text || replyTo.caption || '',
      senderId: replyTo.from?.id || 0,
      senderUsername: replyTo.from?.username,
    } : undefined,
    isMention: isBotMentioned(ctx, getBotUsername()),
    isForwarded: !!(message as any).forward_date || !!(message as any).forward_origin,
    mediaType: getMediaType(message),
    timestamp: message.date * 1000,
  };
}

/**
 * Get media type from message
 */
function getMediaType(message: Message): string | undefined {
  if (message.photo) return 'photo';
  if (message.video) return 'video';
  if (message.voice) return 'voice';
  if (message.audio) return 'audio';
  if (message.document) return 'document';
  if (message.sticker) return 'sticker';
  if (message.animation) return 'animation';
  if (message.video_note) return 'video_note';
  return undefined;
}

/**
 * Check access and return response message if denied
 */
export async function checkAccess(ctx: Context): Promise<{
  allowed: boolean;
  response?: string;
  requireMention?: boolean;
}> {
  const chatType = ctx.chat?.type;
  const userId = ctx.from?.id;

  if (!userId) {
    return { allowed: false };
  }

  if (chatType === 'private') {
    // DM access check
    const result = await checkDMAccess(ctx);

    if (!result.allowed) {
      // Rate limit unauthorized users
      if (!checkUnauthorizedRateLimit(userId)) {
        return { allowed: false }; // Silent reject (rate limited)
      }

      if (result.pairingCode) {
        return {
          allowed: false,
          response: result.reason === 'Pairing required'
            ? `🔐 *Pairing Required*\n\n` +
              `To use this bot, you need authorization.\n\n` +
              `Your pairing code: \`${result.pairingCode}\`\n\n` +
              `This code expires in 5 minutes.\n` +
              `Contact the administrator to approve your access.`
            : `⏳ *Pairing Pending*\n\n` +
              `Your pairing code: \`${result.pairingCode}\`\n\n` +
              `Waiting for administrator approval.`,
        };
      }

      return {
        allowed: false,
        response: `❌ *Access Denied*\n\n` +
          `${result.reason}\n\n` +
          `Your Telegram ID: \`${userId}\``,
      };
    }

    return { allowed: true };
  } else {
    // Group access check
    const result = checkGroupAccess(ctx);

    if (!result.allowed) {
      // Don't respond in groups for unauthorized access
      return { allowed: false };
    }

    return {
      allowed: true,
      requireMention: result.requireMention,
    };
  }
}

/**
 * Handle media group (multiple photos/videos in one send)
 */
export function handleMediaGroup(
  ctx: Context,
  onComplete: (messages: Message[]) => Promise<void>
): void {
  const mediaGroupId = ctx.message?.media_group_id;
  if (!mediaGroupId) {
    // Not a media group, process immediately
    onComplete([ctx.message!]).catch(err => {
      logger.error('[MessageHandler] Error processing single media:', err);
    });
    return;
  }

  const existing = mediaGroupBuffer.get(mediaGroupId);

  if (existing) {
    // Add to existing buffer
    existing.messages.push(ctx.message!);
    clearTimeout(existing.timeout);
    existing.timeout = setTimeout(() => {
      const buffer = mediaGroupBuffer.get(mediaGroupId);
      if (buffer) {
        mediaGroupBuffer.delete(mediaGroupId);
        onComplete(buffer.messages).catch(err => {
          logger.error('[MessageHandler] Error processing media group:', err);
        });
      }
    }, MEDIA_GROUP_TIMEOUT_MS);
  } else {
    // Create new buffer
    const timeout = setTimeout(() => {
      const buffer = mediaGroupBuffer.get(mediaGroupId);
      if (buffer) {
        mediaGroupBuffer.delete(mediaGroupId);
        onComplete(buffer.messages).catch(err => {
          logger.error('[MessageHandler] Error processing media group:', err);
        });
      }
    }, MEDIA_GROUP_TIMEOUT_MS);

    mediaGroupBuffer.set(mediaGroupId, {
      messages: [ctx.message!],
      timeout,
      chatId: ctx.chat!.id,
    });
  }
}

/**
 * Handle text fragments (long messages split by Telegram)
 */
export function handleTextFragment(
  ctx: Context,
  onComplete: (text: string) => Promise<void>
): void {
  const chatId = ctx.chat?.id;
  const text = ctx.message?.text || '';
  const messageId = ctx.message?.message_id || 0;

  if (!chatId) return;

  // Check if this looks like a fragment (message follows shortly after previous)
  const existing = textFragmentBuffer.get(chatId);

  if (existing && messageId === existing.lastMessageId + 1 && text.length > 0) {
    // This is a continuation
    clearTimeout(existing.timeout);
    existing.text += text;
    existing.lastMessageId = messageId;
    existing.timeout = setTimeout(() => {
      const buffer = textFragmentBuffer.get(chatId);
      if (buffer) {
        textFragmentBuffer.delete(chatId);
        onComplete(buffer.text).catch(err => {
          logger.error('[MessageHandler] Error processing text fragment:', err);
        });
      }
    }, TEXT_FRAGMENT_TIMEOUT_MS);
  } else {
    // New message or too far apart
    if (existing) {
      clearTimeout(existing.timeout);
      textFragmentBuffer.delete(chatId);
      // Process the previous buffer
      onComplete(existing.text).catch(err => {
        logger.error('[MessageHandler] Error processing buffered text:', err);
      });
    }

    // Start new buffer
    const timeout = setTimeout(() => {
      const buffer = textFragmentBuffer.get(chatId);
      if (buffer) {
        textFragmentBuffer.delete(chatId);
        onComplete(buffer.text).catch(err => {
          logger.error('[MessageHandler] Error processing text:', err);
        });
      }
    }, TEXT_FRAGMENT_TIMEOUT_MS);

    textFragmentBuffer.set(chatId, {
      text,
      timeout,
      lastMessageId: messageId,
    });
  }
}

/**
 * Debounce inbound messages
 */
export function debounceMessage(
  ctx: Context,
  onProcess: (ctx: Context) => Promise<void>
): void {
  const config = getConfig();
  const debounceMs = config.telegram?.debounceMs || 500;

  if (debounceMs <= 0) {
    // No debouncing
    onProcess(ctx).catch(err => {
      logger.error('[MessageHandler] Error processing message:', err);
    });
    return;
  }

  const chatKey = getChatKey(ctx);
  const existing = debounceBuffer.get(chatKey);

  if (existing) {
    clearTimeout(existing.timeout);
  }

  const timeout = setTimeout(() => {
    const buffer = debounceBuffer.get(chatKey);
    if (buffer) {
      debounceBuffer.delete(chatKey);
      onProcess(buffer.ctx).catch(err => {
        logger.error('[MessageHandler] Error processing debounced message:', err);
      });
    }
  }, debounceMs);

  debounceBuffer.set(chatKey, { ctx, timeout });
}

/**
 * Ensure sequential processing per chat
 */
export async function sequentialize(
  chatKey: string,
  task: () => Promise<void>
): Promise<void> {
  const existing = processingQueue.get(chatKey) || Promise.resolve();

  const newTask = existing.then(task).catch(err => {
    logger.error(`[MessageHandler] Error in sequential task for ${chatKey}:`, err);
  });

  processingQueue.set(chatKey, newTask);

  // Clean up completed promises
  newTask.finally(() => {
    if (processingQueue.get(chatKey) === newTask) {
      processingQueue.delete(chatKey);
    }
  });

  return newTask;
}

/**
 * Send typing indicator
 */
export async function sendTyping(ctx: Context): Promise<void> {
  try {
    await ctx.api.sendChatAction(ctx.chat!.id, 'typing');
  } catch (error) {
    // Ignore typing errors
  }
}

/**
 * Send reply with chunking (Telegram 4096 char limit)
 */
export async function sendReply(
  ctx: Context,
  text: string,
  options?: {
    parseMode?: 'Markdown' | 'HTML';
    replyToMessage?: boolean;
  }
): Promise<Message[]> {
  const MAX_LENGTH = 4096;
  const messages: Message[] = [];

  const parseMode = options?.parseMode || 'Markdown';
  const replyToMessageId = options?.replyToMessage ? ctx.message?.message_id : undefined;

  // Split into chunks
  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= MAX_LENGTH) {
      chunks.push(remaining);
      break;
    }

    // Find a good break point
    let breakPoint = MAX_LENGTH;

    // Try to break at paragraph
    const paragraphBreak = remaining.lastIndexOf('\n\n', MAX_LENGTH);
    if (paragraphBreak > MAX_LENGTH * 0.5) {
      breakPoint = paragraphBreak + 2;
    } else {
      // Try to break at newline
      const lineBreak = remaining.lastIndexOf('\n', MAX_LENGTH);
      if (lineBreak > MAX_LENGTH * 0.5) {
        breakPoint = lineBreak + 1;
      } else {
        // Try to break at space
        const spaceBreak = remaining.lastIndexOf(' ', MAX_LENGTH);
        if (spaceBreak > MAX_LENGTH * 0.5) {
          breakPoint = spaceBreak + 1;
        }
      }
    }

    chunks.push(remaining.substring(0, breakPoint));
    remaining = remaining.substring(breakPoint);
  }

  // Send chunks
  for (let i = 0; i < chunks.length; i++) {
    try {
      const message = await ctx.reply(chunks[i], {
        parse_mode: parseMode,
        reply_to_message_id: i === 0 ? replyToMessageId : undefined,
      });
      messages.push(message);
    } catch (error: any) {
      // If markdown fails, try without formatting
      if (parseMode === 'Markdown' && error.message?.includes('parse')) {
        logger.warn('[MessageHandler] Markdown parse failed, retrying as plain text');
        const message = await ctx.reply(chunks[i], {
          reply_to_message_id: i === 0 ? replyToMessageId : undefined,
        });
        messages.push(message);
      } else {
        throw error;
      }
    }
  }

  return messages;
}

/**
 * Add message to history and get context
 */
export function recordAndGetContext(
  ctx: Context,
  text: string
): string {
  const msgCtx = buildMessageContext(ctx);
  if (!msgCtx) return '';

  // Add to history
  addUserMessage({
    chatId: msgCtx.chatId,
    chatType: msgCtx.chatType,
    threadId: msgCtx.threadId,
    userId: msgCtx.senderId,
    username: msgCtx.senderUsername || msgCtx.senderFirstName,
    text,
    messageId: msgCtx.messageId,
    replyToId: msgCtx.replyToMessage?.messageId,
    mediaType: msgCtx.mediaType,
  });

  // Build history context
  return buildHistoryContext({
    chatId: msgCtx.chatId,
    chatType: msgCtx.chatType,
    threadId: msgCtx.threadId,
    userId: msgCtx.senderId,
    maxMessages: 10,
    currentMessage: text,
  });
}

/**
 * Record bot response in history
 */
export function recordBotResponse(
  ctx: Context,
  text: string,
  messageId?: number
): void {
  const msgCtx = buildMessageContext(ctx);
  if (!msgCtx) return;

  addBotMessage({
    chatId: msgCtx.chatId,
    chatType: msgCtx.chatType,
    threadId: msgCtx.threadId,
    userId: msgCtx.senderId,
    text,
    messageId,
  });
}

logger.info('[MessageHandler] Module loaded');
