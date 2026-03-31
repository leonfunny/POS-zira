/**
 * Media Handler (moltbot-style)
 * Handles downloading, processing, and caching media from Telegram
 */

import { Context, InputFile } from 'grammy';
import { PhotoSize, Document, Video, Voice, Audio, Sticker, Animation } from 'grammy/types';
import * as fs from 'fs';
import * as path from 'path';
import { app } from 'electron';
import { TelegramStickerCache } from '../../shared/types';
import { getConfig } from '../config/store';
import logger from '../logger';

// Media cache directory
const MEDIA_CACHE_DIR = path.join(app.getPath('userData'), 'telegram', 'media');
const STICKER_CACHE_FILE = path.join(app.getPath('userData'), 'telegram', 'sticker-cache.json');

// Sticker cache (in memory, persisted to disk)
let stickerCache: Map<string, TelegramStickerCache> = new Map();

// Ensure directories exist
function ensureDirectories(): void {
  const dirs = [
    MEDIA_CACHE_DIR,
    path.dirname(STICKER_CACHE_FILE),
  ];

  for (const dir of dirs) {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }
}

// Load sticker cache from disk
function loadStickerCache(): void {
  try {
    if (fs.existsSync(STICKER_CACHE_FILE)) {
      const data = JSON.parse(fs.readFileSync(STICKER_CACHE_FILE, 'utf-8'));
      stickerCache = new Map(Object.entries(data));
      logger.info(`[MediaHandler] Loaded ${stickerCache.size} sticker descriptions from cache`);
    }
  } catch (error) {
    logger.error('[MediaHandler] Failed to load sticker cache:', error);
  }
}

// Save sticker cache to disk
function saveStickerCache(): void {
  try {
    const data = Object.fromEntries(stickerCache);
    fs.writeFileSync(STICKER_CACHE_FILE, JSON.stringify(data, null, 2));
  } catch (error) {
    logger.error('[MediaHandler] Failed to save sticker cache:', error);
  }
}

// Initialize
ensureDirectories();
loadStickerCache();

/**
 * Get media type from message
 */
export function getMediaType(ctx: Context): string | undefined {
  const message = ctx.message;
  if (!message) return undefined;

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
 * Get file ID from message
 */
export function getFileId(ctx: Context): string | undefined {
  const message = ctx.message;
  if (!message) return undefined;

  if (message.photo) {
    // Get largest photo
    const largest = message.photo.reduce((a, b) =>
      (a.file_size || 0) > (b.file_size || 0) ? a : b
    );
    return largest.file_id;
  }
  if (message.video) return message.video.file_id;
  if (message.voice) return message.voice.file_id;
  if (message.audio) return message.audio.file_id;
  if (message.document) return message.document.file_id;
  if (message.sticker) return message.sticker.file_id;
  if (message.animation) return message.animation.file_id;
  if (message.video_note) return message.video_note.file_id;
  return undefined;
}

/**
 * Get file extension from MIME type
 */
function getExtension(mimeType: string | undefined): string {
  if (!mimeType) return '.bin';

  const map: Record<string, string> = {
    'image/jpeg': '.jpg',
    'image/png': '.png',
    'image/gif': '.gif',
    'image/webp': '.webp',
    'video/mp4': '.mp4',
    'video/webm': '.webm',
    'audio/ogg': '.ogg',
    'audio/mpeg': '.mp3',
    'audio/mp4': '.m4a',
    'application/pdf': '.pdf',
    'application/json': '.json',
    'text/plain': '.txt',
  };

  return map[mimeType] || '.bin';
}

/**
 * Check if file size is within limit
 */
export function checkFileSizeLimit(ctx: Context): { allowed: boolean; sizeMb?: number } {
  const config = getConfig();
  const maxMb = config.telegram?.mediaMaxMb || 5;

  const message = ctx.message;
  if (!message) return { allowed: true };

  let fileSize = 0;

  if (message.photo) {
    const largest = message.photo.reduce((a, b) =>
      (a.file_size || 0) > (b.file_size || 0) ? a : b
    );
    fileSize = largest.file_size || 0;
  } else if (message.video) {
    fileSize = message.video.file_size || 0;
  } else if (message.voice) {
    fileSize = message.voice.file_size || 0;
  } else if (message.audio) {
    fileSize = message.audio.file_size || 0;
  } else if (message.document) {
    fileSize = message.document.file_size || 0;
  } else if (message.animation) {
    fileSize = message.animation.file_size || 0;
  }

  const sizeMb = fileSize / (1024 * 1024);

  if (sizeMb > maxMb) {
    return { allowed: false, sizeMb };
  }

  return { allowed: true, sizeMb };
}

/**
 * Download media from Telegram
 */
export async function downloadMedia(ctx: Context): Promise<{
  path: string;
  type: string;
  mimeType?: string;
} | null> {
  const fileId = getFileId(ctx);
  const mediaType = getMediaType(ctx);

  if (!fileId || !mediaType) {
    return null;
  }

  // Check size limit
  const sizeCheck = checkFileSizeLimit(ctx);
  if (!sizeCheck.allowed) {
    logger.warn(`[MediaHandler] File too large: ${sizeCheck.sizeMb?.toFixed(2)}MB`);
    return null;
  }

  try {
    // Get file info
    const file = await ctx.api.getFile(fileId);
    const filePath = file.file_path;

    if (!filePath) {
      logger.error('[MediaHandler] No file path returned');
      return null;
    }

    // Determine extension and MIME type
    let extension = path.extname(filePath) || '.bin';
    let mimeType: string | undefined;

    const message = ctx.message;
    if (message?.document) {
      mimeType = message.document.mime_type;
      extension = getExtension(mimeType);
    } else if (message?.video) {
      mimeType = message.video.mime_type;
      extension = getExtension(mimeType) || '.mp4';
    } else if (message?.voice) {
      mimeType = message.voice.mime_type;
      extension = getExtension(mimeType) || '.ogg';
    } else if (message?.audio) {
      mimeType = message.audio.mime_type;
      extension = getExtension(mimeType) || '.mp3';
    } else if (mediaType === 'photo') {
      extension = '.jpg';
      mimeType = 'image/jpeg';
    } else if (message?.sticker) {
      if (message.sticker.is_animated) {
        extension = '.tgs';
        mimeType = 'application/x-tgsticker';
      } else if (message.sticker.is_video) {
        extension = '.webm';
        mimeType = 'video/webm';
      } else {
        extension = '.webp';
        mimeType = 'image/webp';
      }
    }

    // Create local path
    const localFileName = `${Date.now()}_${fileId.substring(0, 8)}${extension}`;
    const localPath = path.join(MEDIA_CACHE_DIR, localFileName);

    // Download file
    const response = await fetch(
      `https://api.telegram.org/file/bot${ctx.api.token}/${filePath}`
    );

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const buffer = Buffer.from(await response.arrayBuffer());
    fs.writeFileSync(localPath, buffer);

    logger.info(`[MediaHandler] Downloaded ${mediaType}: ${localPath} (${buffer.length} bytes)`);

    return {
      path: localPath,
      type: mediaType,
      mimeType,
    };
  } catch (error) {
    logger.error('[MediaHandler] Download failed:', error);
    return null;
  }
}

/**
 * Get sticker description from cache or generate
 */
export async function getStickerDescription(
  ctx: Context,
  visionDescriber?: (imagePath: string) => Promise<string>
): Promise<string | null> {
  const sticker = ctx.message?.sticker;
  if (!sticker) return null;

  // Check cache
  const cached = stickerCache.get(sticker.file_unique_id);
  if (cached?.description) {
    logger.debug(`[MediaHandler] Using cached sticker description: ${cached.description.substring(0, 50)}...`);
    return cached.description;
  }

  // Skip animated and video stickers (can't process easily)
  if (sticker.is_animated || sticker.is_video) {
    const emoji = sticker.emoji || '🎭';
    const setName = sticker.set_name || 'unknown';
    return `[${sticker.is_animated ? 'Animated' : 'Video'} sticker ${emoji} from "${setName}"]`;
  }

  // Try to download and describe with vision
  if (visionDescriber) {
    try {
      const media = await downloadMedia(ctx);
      if (media) {
        const description = await visionDescriber(media.path);

        // Cache the description
        const cacheEntry: TelegramStickerCache = {
          fileId: sticker.file_id,
          fileUniqueId: sticker.file_unique_id,
          emoji: sticker.emoji,
          setName: sticker.set_name,
          description,
          cachedAt: new Date().toISOString(),
        };
        stickerCache.set(sticker.file_unique_id, cacheEntry);
        saveStickerCache();

        // Clean up temp file
        fs.unlinkSync(media.path);

        return description;
      }
    } catch (error) {
      logger.error('[MediaHandler] Failed to describe sticker:', error);
    }
  }

  // Fallback to emoji + set name
  const emoji = sticker.emoji || '🎭';
  const setName = sticker.set_name || 'unknown';
  return `[Sticker ${emoji} from "${setName}"]`;
}

/**
 * Clean up old media files
 */
export function cleanupOldMedia(maxAgeMs: number = 24 * 60 * 60 * 1000): void {
  try {
    const now = Date.now();
    const files = fs.readdirSync(MEDIA_CACHE_DIR);

    let deleted = 0;
    for (const file of files) {
      const filePath = path.join(MEDIA_CACHE_DIR, file);
      const stat = fs.statSync(filePath);

      if (now - stat.mtimeMs > maxAgeMs) {
        fs.unlinkSync(filePath);
        deleted++;
      }
    }

    if (deleted > 0) {
      logger.info(`[MediaHandler] Cleaned up ${deleted} old media files`);
    }
  } catch (error) {
    logger.error('[MediaHandler] Cleanup failed:', error);
  }
}

/**
 * Get media description for AI
 */
export async function getMediaDescription(ctx: Context): Promise<string | null> {
  const mediaType = getMediaType(ctx);
  if (!mediaType) return null;

  const message = ctx.message;
  if (!message) return null;

  switch (mediaType) {
    case 'photo':
      return '[User sent a photo]';

    case 'video':
      const video = message.video;
      return `[User sent a video: ${video?.duration || 0}s, ${video?.width || 0}x${video?.height || 0}]`;

    case 'voice':
      const voice = message.voice;
      return `[User sent a voice message: ${voice?.duration || 0}s]`;

    case 'audio':
      const audio = message.audio;
      return `[User sent an audio file: "${audio?.title || 'Unknown'}" by ${audio?.performer || 'Unknown'}, ${audio?.duration || 0}s]`;

    case 'document':
      const doc = message.document;
      return `[User sent a document: "${doc?.file_name || 'Unknown'}" (${doc?.mime_type || 'unknown type'})]`;

    case 'sticker':
      return await getStickerDescription(ctx);

    case 'animation':
      return '[User sent a GIF/animation]';

    case 'video_note':
      const videoNote = message.video_note;
      return `[User sent a video note: ${videoNote?.duration || 0}s]`;

    default:
      return `[User sent ${mediaType}]`;
  }
}

// Run cleanup periodically (every hour)
setInterval(() => cleanupOldMedia(), 60 * 60 * 1000);

logger.info('[MediaHandler] Module loaded');
