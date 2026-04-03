/**
 * Zira AI - Chatbot using OpenRouter API (moltbot-style)
 * Uses x-ai/grok-4.1-fast model with dynamic system prompts
 * Full integration with InputExecutor, ScreenCapturer, and BrowserController
 */

import OpenAI from 'openai';
import { shell, desktopCapturer, screen, nativeImage } from 'electron';
import { exec, execFile, spawn } from 'child_process';
import * as path from 'path';
import { join } from 'path';
import { app } from 'electron';
import * as fs from 'fs';
import { AIChatMessage, ZiraAIChatResponse, AIProvider } from '../../shared/types';
import { buildSystemPrompt, getDefaultSystemPrompt } from './system-prompt';
import { getPendingAttachments, clearPendingAttachments, setGeneratedPostContent } from './attachment-store';
import { getConfigValue, setConfigValue } from '../config/store';
import logger from '../logger';
import { WebSocket } from 'ws';

// Extension Communication
let extensionSocket: WebSocket | null = null;
const pendingExtensionRequests = new Map<string, (response: any) => void>();

export function setGlobalExtensionSocket(ws: WebSocket | null) {
  extensionSocket = ws;
  logger.info(`[ZiraAI] Extension socket ${ws ? 'connected' : 'disconnected'}`);
}

export function handleGlobalExtensionResponse(id: string, data: any) {
  const resolve = pendingExtensionRequests.get(id);
  if (resolve) {
    resolve(data);
    pendingExtensionRequests.delete(id);
  }
}

async function sendToExtension(action: string, args: any): Promise<any> {
  if (!extensionSocket || extensionSocket.readyState !== WebSocket.OPEN) {
    throw new Error("Extension not connected. Please install 'Zira AI Helper' extension.");
  }
  
  return new Promise((resolve) => {
    const id = Date.now().toString() + Math.random().toString();
    pendingExtensionRequests.set(id, resolve);
    
    extensionSocket?.send(JSON.stringify({
      type: 'EXECUTE',
      id: id,
      action: action,
      args: args
    }));
    
    // Timeout 10s
    setTimeout(() => {
      if (pendingExtensionRequests.has(id)) {
        pendingExtensionRequests.delete(id);
        resolve({ success: false, error: "Extension timeout" });
      }
    }, 10000);
  });
}

/**
 * Identity Filter - Replace Grok/xAI identity with Zira AI identity
 * This is necessary because Grok model has very strong identity training
 */
export function filterIdentity(text: string): string {
  if (!text) return text;

  // Patterns to replace (case insensitive)
  const replacements: [RegExp, string][] = [
    // Vietnamese identity claims
    [/\b(Tao|Tôi|Mình)\s+(là|tên là|tên)\s+\*{0,2}Grok\*{0,2}/gi, '$1 là **Zira AI**'],
    [/\bTao là Grok\b/gi, 'Tao là Zira AI'],
    [/\bTôi là Grok\b/gi, 'Tôi là Zira AI'],
    [/\bMình là Grok\b/gi, 'Mình là Zira AI'],
    [/\bGrok đây\b/gi, 'Zira AI đây'],
    [/\bGrok nè\b/gi, 'Zira AI nè'],

    // English identity claims
    [/\bI am Grok\b/gi, 'I am Zira AI'],
    [/\bI'm Grok\b/gi, 'I\'m Zira AI'],
    [/\bMy name is Grok\b/gi, 'My name is Zira AI'],
    [/\bcall me Grok\b/gi, 'call me Zira AI'],

    // Creator/company claims - replace xAI with Zira AI
    [/\b(do|bởi|của|by)\s+\*{0,2}xAI\*{0,2}/gi, '$1 **Zira AI**'],
    [/\b(created|built|made|developed)\s+by\s+\*{0,2}xAI\*{0,2}/gi, '$1 by **Zira AI**'],
    [/\bxAI\s*[\-–]\s*(công ty|company)\s+(của|of)\s+Elon Musk/gi, 'Zira AI - được phát triển bởi eNail.pro'],
    [/\bElon Musk('s)?\s+(company|công ty)/gi, 'eNail.pro'],
    [/\bElon Musk\s+(tạo|created|built|made)/gi, 'eNail.pro $1'],
    [/\bElon Musk\b/gi, 'eNail.pro'],

    // Direct name replacements (careful - only in identity context)
    [/\*{1,2}Grok\*{1,2}/g, '**Zira AI**'],
    [/\bGrok,\s+một AI\b/gi, 'Zira AI, một AI'],
    [/\bGrok,\s+an AI\b/gi, 'Zira AI, an AI'],
    [/\bGrok\s+AI\b/gi, 'Zira AI'],

    // xAI company name (standalone) - replace with Zira AI
    [/\bxAI\b/g, 'Zira AI'],

    // Hitchhiker's Guide / Jarvis references (Grok-specific)
    [/Hitchhiker('s)?\s+Guide/gi, 'modern AI assistants'],
    [/Hướng dẫn du hành vũ trụ của Hitchhiker/gi, 'các trợ lý AI hiện đại'],
    [/lấy cảm hứng từ Jarvis trong Iron Man và/gi, 'được thiết kế để'],
  ];

  let filtered = text;
  for (const [pattern, replacement] of replacements) {
    filtered = filtered.replace(pattern, replacement);
  }

  // Log if any replacement was made
  if (filtered !== text) {
    logger.info('[ZiraAI] Identity filter applied - replaced Grok references');
  }

  return filtered;
}

// Dynamic import for nut-js (mouse/keyboard control)
let nutMouse: any = null;
let nutKeyboard: any = null;
let nutButton: any = null;
let nutKey: any = null;
let nutjsInitialized = false;

// Booksy provider - set from app.ts to avoid circular dependency
let booksySyncProvider: (() => any) | null = null;

export function setBooksySyncProvider(provider: () => any): void {
  booksySyncProvider = provider;
  logger.info('[ZiraAI] Booksy sync provider set');
}

function getBooksySync(): any {
  if (!booksySyncProvider) {
    logger.warn('[ZiraAI] Booksy sync provider not set');
    return null;
  }
  return booksySyncProvider();
}

async function initNutJs(): Promise<boolean> {
  if (nutjsInitialized) return true;
  try {
    const nutjs = await import('@nut-tree-fork/nut-js');
    nutMouse = nutjs.mouse;
    nutKeyboard = nutjs.keyboard;
    nutButton = nutjs.Button;
    nutKey = nutjs.Key;
    nutMouse.config.autoDelayMs = 0;
    nutMouse.config.mouseSpeed = 2000;
    nutKeyboard.config.autoDelayMs = 0;
    nutjsInitialized = true;
    logger.info('[ZiraAI] nut-js initialized for input control');
    return true;
  } catch (error) {
    logger.warn('[ZiraAI] nut-js not available:', error);
    return false;
  }
}

// Tool definitions for function calling - FULL INTEGRATION
const ZIRA_TOOLS: OpenAI.ChatCompletionTool[] = [
  // === APP & URL TOOLS ===
  {
    type: 'function',
    function: {
      name: 'open_chrome',
      description: 'Open Google Chrome browser, optionally with a specific URL',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'Optional URL to open in Chrome' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'open_url',
      description: 'Open a URL in the default browser',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'The URL to open' },
        },
        required: ['url'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'open_application',
      description: 'Open a Windows application (notepad, calculator, explorer, paint, settings, task manager, word, excel, outlook)',
      parameters: {
        type: 'object',
        properties: {
          app_name: { type: 'string', description: 'Name of the application' },
        },
        required: ['app_name'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_system_info',
      description: 'Get system information (platform, memory, uptime, etc.)',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },

  // === MOUSE TOOLS ===
  {
    type: 'function',
    function: {
      name: 'mouse_click',
      description: 'Click the mouse at specific screen coordinates',
      parameters: {
        type: 'object',
        properties: {
          x: { type: 'number', description: 'X coordinate on screen' },
          y: { type: 'number', description: 'Y coordinate on screen' },
        },
        required: ['x', 'y'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'mouse_double_click',
      description: 'Double click at specific screen coordinates',
      parameters: {
        type: 'object',
        properties: {
          x: { type: 'number', description: 'X coordinate' },
          y: { type: 'number', description: 'Y coordinate' },
        },
        required: ['x', 'y'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'mouse_right_click',
      description: 'Right click at specific screen coordinates',
      parameters: {
        type: 'object',
        properties: {
          x: { type: 'number', description: 'X coordinate' },
          y: { type: 'number', description: 'Y coordinate' },
        },
        required: ['x', 'y'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'mouse_move',
      description: 'Move the mouse cursor to specific coordinates',
      parameters: {
        type: 'object',
        properties: {
          x: { type: 'number', description: 'X coordinate' },
          y: { type: 'number', description: 'Y coordinate' },
        },
        required: ['x', 'y'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'mouse_scroll',
      description: 'Scroll the mouse wheel',
      parameters: {
        type: 'object',
        properties: {
          direction: { type: 'string', enum: ['up', 'down', 'left', 'right'], description: 'Scroll direction' },
          amount: { type: 'number', description: 'Scroll amount (default 3)' },
        },
        required: ['direction'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'mouse_drag',
      description: 'Drag from one position to another',
      parameters: {
        type: 'object',
        properties: {
          x1: { type: 'number', description: 'Start X' },
          y1: { type: 'number', description: 'Start Y' },
          x2: { type: 'number', description: 'End X' },
          y2: { type: 'number', description: 'End Y' },
        },
        required: ['x1', 'y1', 'x2', 'y2'],
      },
    },
  },

  // === KEYBOARD TOOLS ===
  {
    type: 'function',
    function: {
      name: 'keyboard_type',
      description: 'Type text using the keyboard',
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'Text to type' },
        },
        required: ['text'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'keyboard_press',
      description: 'Press a single key (enter, escape, tab, f5, delete, etc.)',
      parameters: {
        type: 'object',
        properties: {
          key: { type: 'string', description: 'Key name (enter, escape, tab, f1-f12, delete, home, end, etc.)' },
        },
        required: ['key'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'keyboard_hotkey',
      description: 'Press a keyboard shortcut/hotkey combination (e.g., Ctrl+C, Alt+Tab, Ctrl+Shift+S)',
      parameters: {
        type: 'object',
        properties: {
          keys: {
            type: 'array',
            items: { type: 'string' },
            description: 'Array of keys to press together, e.g., ["ctrl", "c"] for Ctrl+C',
          },
        },
        required: ['keys'],
      },
    },
  },

  // === SCREENSHOT TOOL ===
  {
    type: 'function',
    function: {
      name: 'take_screenshot',
      description: 'Take a screenshot of the screen and save it',
      parameters: {
        type: 'object',
        properties: {
          filename: { type: 'string', description: 'Optional filename for the screenshot' },
        },
        required: [],
      },
    },
  },

  // === FILE TOOLS ===
  {
    type: 'function',
    function: {
      name: 'open_folder',
      description: 'Open a folder in File Explorer',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Folder path to open' },
        },
        required: ['path'],
      },
    },
  },
  // run_command REMOVED — was full RCE via arbitrary shell execution

  // === BOOKSY TOOLS ===
  {
    type: 'function',
    function: {
      name: 'booksy_get_bookings',
      description: 'Get bookings/appointments from Booksy for a specific date. Use this when user asks about appointments, bookings, schedule, calendar, or how many customers. Default is today. Examples: "mai có bao nhiêu khách", "xem lịch hôm nay", "hôm nay có ai đặt lịch"',
      parameters: {
        type: 'object',
        properties: {
          date: {
            type: 'string',
            description: 'Date in YYYY-MM-DD format. Use "today" for today, "tomorrow" for tomorrow. If user says "mai" it means tomorrow.'
          },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'booksy_get_status',
      description: 'Get Booksy sync status - check if Chrome is connected, if session is valid, last sync time',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'booksy_get_customers',
      description: 'Get list of customers from Booksy. Use when user asks about customer list or client database.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'booksy_get_staff',
      description: 'Get list of staff members from Booksy. Use when user asks about employees, staff, workers.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'booksy_get_services',
      description: 'Get list of services offered from Booksy. Use when user asks about services, menu, prices.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },

  // === BROWSER AUTOMATION TOOLS (Chrome CDP) ===
  {
    type: 'function',
    function: {
      name: 'browser_setup',
      description: 'Start Chrome with CDP debugging port and open a website for login. Use this FIRST when user wants to browse Facebook/Gmail/etc. Chrome will keep the session for future use. If user has multiple Chrome profiles, will ask them to select one.',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'URL to open for login (e.g., facebook.com, gmail.com). Default: facebook.com' },
          profile: { type: 'string', description: 'Chrome profile name or directory to use (e.g., "Osoba 1", "Profile 1", "Default"). If user says "dùng profile X" or "chọn profile X", pass X here.' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'select_chrome_profile',
      description: 'Select and save a Chrome profile for browser automation. Use when user says "chọn profile X", "dùng profile X", "select profile X". The choice will be saved for future sessions.',
      parameters: {
        type: 'object',
        properties: {
          profile: { type: 'string', description: 'Profile name or number (e.g., "Osoba 1", "1", "Default", "Profile 2")' },
        },
        required: ['profile'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'kill_chrome',
      description: 'Kill all Chrome processes. Use when user says "tắt chrome", "đóng chrome", "kill chrome", "close chrome". This is needed before browser automation can use user profile.',
      parameters: {
        type: 'object',
        properties: {},
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'browser_check_login',
      description: 'Check if user has completed login. Call this after user says "done", "xong rồi", "đăng nhập xong". Returns the page content if logged in.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'browser_open_and_read',
      description: 'Open a website in Chrome and read its content. Uses Chrome CDP to connect to existing Chrome session (preserves login). Perfect for "mở Facebook xem có gì mới", "check email", "xem tin tức". Returns page text content.',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'URL to open (e.g., facebook.com, gmail.com, news site)' },
          scroll_times: { type: 'number', description: 'How many times to scroll down to load more content (default 2)' },
          wait_seconds: { type: 'number', description: 'Seconds to wait for page load (default 3)' },
        },
        required: ['url'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'browser_screenshot',
      description: 'Take a screenshot of the currently open browser page. Use after browser_open_and_read.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'browser_scroll_and_read',
      description: 'Scroll the current browser page and read more content. Use to load more posts/items.',
      parameters: {
        type: 'object',
        properties: {
          direction: { type: 'string', enum: ['down', 'up'], description: 'Scroll direction' },
          times: { type: 'number', description: 'Number of scroll actions (default 3)' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'browser_click',
      description: 'Click on an element in the browser by text content or selector',
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'Text of the element to click (e.g., "Like", "Comment", "See more")' },
          selector: { type: 'string', description: 'CSS selector if text not provided' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'browser_close',
      description: 'Close the browser tab that was opened',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'browser_type',
      description: 'Type text into the currently focused input field or a specific element in the browser. Use for typing comments, search queries, messages.',
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'Text to type' },
          selector: { type: 'string', description: 'Optional CSS selector for the input field' },
          submit: { type: 'boolean', description: 'Whether to press Enter after typing (default false)' },
        },
        required: ['text'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'browser_get_posts',
      description: 'Get structured list of posts/items from the current page. Returns posts with their content, author, and index for interaction.',
      parameters: {
        type: 'object',
        properties: {
          limit: { type: 'number', description: 'Maximum number of posts to return (default 10)' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'browser_find_posts_by_topic',
      description: 'Find and filter posts by topic/keyword. Use to find music posts, news about a specific topic, etc.',
      parameters: {
        type: 'object',
        properties: {
          topic: { type: 'string', description: 'Topic or keyword to search for (e.g., "music", "nhạc", "news")' },
          scroll_to_find: { type: 'number', description: 'How many times to scroll to find more matching posts (default 3)' },
        },
        required: ['topic'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'browser_comment_on_post',
      description: 'Comment on a specific post. Finds the post, clicks comment button, types comment, and optionally submits.',
      parameters: {
        type: 'object',
        properties: {
          post_index: { type: 'number', description: 'Index of the post to comment on (from browser_get_posts)' },
          comment: { type: 'string', description: 'Comment text to post' },
          submit: { type: 'boolean', description: 'Whether to submit the comment (default false - just types it)' },
        },
        required: ['post_index', 'comment'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'browser_summarize',
      description: 'Get a summary of the current page content. Useful for "tóm tắt trang này", "summarize what\'s on screen".',
      parameters: {
        type: 'object',
        properties: {
          focus: { type: 'string', description: 'Optional focus area: "posts", "news", "emails", "all" (default "all")' },
        },
        required: [],
      },
    },
  },
  // === FACEBOOK-SPECIFIC TOOLS ===
  {
    type: 'function',
    function: {
      name: 'facebook_create_post',
      description: 'Create a new Facebook post. Can include text, and optionally attach images/videos. Use for "đăng bài fb", "post lên facebook", "viết status facebook".',
      parameters: {
        type: 'object',
        properties: {
          content: { type: 'string', description: 'Text content of the post' },
          image_path: { type: 'string', description: 'Optional: Local path to image file to attach' },
          video_path: { type: 'string', description: 'Optional: Local path to video file to attach' },
          feeling: { type: 'string', description: 'Optional: Feeling/activity (e.g., "happy", "excited", "at Hanoi")' },
          privacy: { type: 'string', enum: ['public', 'friends', 'only_me'], description: 'Post privacy setting (default: friends)' },
          submit: { type: 'boolean', description: 'Whether to actually submit the post (default false - just prepares it)' },
        },
        required: ['content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'facebook_like_post',
      description: 'Like or react to a Facebook post by index. Use for "like bài fb", "thích bài số X trên facebook", "react bài".',
      parameters: {
        type: 'object',
        properties: {
          post_index: { type: 'number', description: 'Index of the post to like (from facebook_get_posts)' },
          reaction: { type: 'string', enum: ['like', 'love', 'haha', 'wow', 'sad', 'angry'], description: 'Type of reaction (default: like)' },
        },
        required: ['post_index'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'facebook_share_post',
      description: 'Share a Facebook post to your timeline or with friends. Use for "share bài fb", "chia sẻ bài số X".',
      parameters: {
        type: 'object',
        properties: {
          post_index: { type: 'number', description: 'Index of the post to share (from facebook_get_posts)' },
          message: { type: 'string', description: 'Optional message to add when sharing' },
          share_to: { type: 'string', enum: ['timeline', 'story', 'message'], description: 'Where to share (default: timeline)' },
          submit: { type: 'boolean', description: 'Whether to actually submit the share (default false)' },
        },
        required: ['post_index'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'facebook_get_notifications',
      description: 'Get Facebook notifications. Use for "xem thông báo fb", "có thông báo facebook gì không", "check fb notifications".',
      parameters: {
        type: 'object',
        properties: {
          limit: { type: 'number', description: 'Maximum notifications to return (default 10)' },
          unread_only: { type: 'boolean', description: 'Only show unread notifications (default false)' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'facebook_get_messages',
      description: 'Get Facebook Messenger conversations. Use for "xem tin nhắn messenger", "có tin nhắn fb gì không", "check messenger".',
      parameters: {
        type: 'object',
        properties: {
          limit: { type: 'number', description: 'Maximum conversations to return (default 10)' },
          unread_only: { type: 'boolean', description: 'Only show unread messages (default false)' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'facebook_reply_message',
      description: 'Reply to a Facebook Messenger conversation. Use for "trả lời tin nhắn messenger", "reply fb message".',
      parameters: {
        type: 'object',
        properties: {
          conversation_index: { type: 'number', description: 'Index of conversation to reply (from facebook_get_messages)' },
          message: { type: 'string', description: 'Message to send' },
          submit: { type: 'boolean', description: 'Whether to actually send the message (default false)' },
        },
        required: ['conversation_index', 'message'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'facebook_search',
      description: 'Search Facebook for people, pages, groups, or posts. Use for "tìm kiếm trên fb", "search facebook".',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search query' },
          filter: { type: 'string', enum: ['all', 'posts', 'people', 'pages', 'groups', 'photos', 'videos'], description: 'Filter results by type (default: all)' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'facebook_get_posts',
      description: 'Get structured list of Facebook posts from News Feed. Returns posts with their content, author, and index for interaction.',
      parameters: {
        type: 'object',
        properties: {
          limit: { type: 'number', description: 'Maximum number of posts to return (default 10)' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'facebook_find_posts',
      description: 'Find and filter Facebook posts by topic/keyword. Use to find music posts, news about a specific topic, etc.',
      parameters: {
        type: 'object',
        properties: {
          topic: { type: 'string', description: 'Topic or keyword to search for (e.g., "music", "nhạc", "news")' },
          scroll_to_find: { type: 'number', description: 'How many times to scroll to find more matching posts (default 3)' },
        },
        required: ['topic'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'facebook_comment',
      description: 'Comment on a Facebook post. Finds the post, clicks comment button, types comment.',
      parameters: {
        type: 'object',
        properties: {
          post_index: { type: 'number', description: 'Index of the post to comment on (from facebook_get_posts)' },
          comment: { type: 'string', description: 'Comment text to post' },
          submit: { type: 'boolean', description: 'Whether to submit the comment (default false - just types it)' },
        },
        required: ['post_index', 'comment'],
      },
    },
  },
  // === MEDIA ANALYSIS TOOLS ===
  {
    type: 'function',
    function: {
      name: 'analyze_video',
      description: 'Extract frames from a video and analyze their content. Use for "phân tích video", "xem video có gì", "mô tả video". Returns scene descriptions.',
      parameters: {
        type: 'object',
        properties: {
          video_path: { type: 'string', description: 'Path to video file (optional if user dropped a video)' },
          frame_count: { type: 'number', description: 'Number of frames to extract (default 5, max 10)' },
          language: { type: 'string', description: 'Language for description (default: vi for Vietnamese, pl for Polish)' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'analyze_image',
      description: 'Analyze an image and describe its content. Use for "phân tích ảnh", "mô tả ảnh", "ảnh này là gì". Can generate captions for social media.',
      parameters: {
        type: 'object',
        properties: {
          image_path: { type: 'string', description: 'Path to image file (optional if user dropped an image)' },
          language: { type: 'string', description: 'Language for description (default: vi for Vietnamese, pl for Polish)' },
          style: { type: 'string', enum: ['casual', 'professional', 'funny', 'poetic'], description: 'Style of description (default: casual)' },
          for_platform: { type: 'string', enum: ['facebook', 'instagram', 'tiktok', 'twitter'], description: 'Optimize description for specific platform' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'generate_post_content',
      description: 'Generate social media post content based on uploaded image/video. Use for "viết caption", "viết mô tả cho ảnh", "tạo nội dung đăng fb".',
      parameters: {
        type: 'object',
        properties: {
          language: { type: 'string', description: 'Language for content (vi, pl, en, etc.)' },
          platform: { type: 'string', enum: ['facebook', 'instagram', 'tiktok', 'twitter'], description: 'Target platform' },
          tone: { type: 'string', enum: ['casual', 'professional', 'funny', 'inspiring', 'promotional'], description: 'Tone of content' },
          include_hashtags: { type: 'boolean', description: 'Include relevant hashtags (default true)' },
          max_length: { type: 'number', description: 'Maximum character length (default 280 for Twitter, 2200 for others)' },
        },
        required: [],
      },
    },
  },
];

// =============================================
// TOOL EXECUTION FUNCTIONS
// =============================================

// --- APP & URL TOOLS ---
async function executeOpenChrome(args: { url?: string }): Promise<string> {
  return new Promise((resolve) => {
    const chromePaths = [
      process.env['PROGRAMFILES'] + '\\Google\\Chrome\\Application\\chrome.exe',
      process.env['PROGRAMFILES(X86)'] + '\\Google\\Chrome\\Application\\chrome.exe',
      process.env['LOCALAPPDATA'] + '\\Google\\Chrome\\Application\\chrome.exe',
    ];

    let chromePath = '';
    for (const p of chromePaths) {
      if (fs.existsSync(p)) {
        chromePath = p;
        break;
      }
    }

    if (!chromePath) {
      resolve('❌ Chrome không tìm thấy. Vui lòng cài đặt Google Chrome.');
      return;
    }

    const url = args.url || '';
    const cmd = url ? `"${chromePath}" "${url}"` : `"${chromePath}"`;

    exec(cmd, (error) => {
      if (error) {
        logger.error('[ZiraAI Tool] Chrome error:', error);
        resolve(`❌ Lỗi mở Chrome: ${error.message}`);
      } else {
        resolve(url ? `✅ Đã mở Chrome với URL: ${url}` : '✅ Đã mở Chrome!');
      }
    });
  });
}

async function executeOpenUrl(args: { url: string }): Promise<string> {
  try {
    let url = args.url.trim();
    if (!url.startsWith('http://') && !url.startsWith('https://')) {
      url = 'https://' + url;
    }

    // SECURITY: Validate URL structure to prevent abuse (e.g., javascript:, data:, file: schemes via encoding tricks)
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return `❌ URL không hợp lệ: ${args.url}`;
    }

    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return `❌ Chỉ cho phép mở URL http/https`;
    }

    // SECURITY: Domain allowlist to prevent opening malicious/phishing URLs via AI prompt injection
    const allowedDomains = [
      'google.com', 'google.pl', 'youtube.com', 'facebook.com', 'instagram.com',
      'booksy.com', 'enail.pro', 'zira.pl', 'github.com',
      'wikipedia.org', 'maps.google.com', 'translate.google.com',
      'outlook.com', 'gmail.com', 'linkedin.com',
    ];
    const hostname = parsed.hostname.toLowerCase();
    const isAllowed = allowedDomains.some(d => hostname === d || hostname.endsWith('.' + d));
    if (!isAllowed) {
      return `❌ Domen "${hostname}" không nằm trong danh sách cho phép. Cho phép: ${allowedDomains.join(', ')}`;
    }

    await shell.openExternal(url);
    return `✅ Đã mở URL: ${url}`;
  } catch (error: any) {
    return `❌ Lỗi mở URL: ${error.message}`;
  }
}

async function executeOpenApplication(args: { app_name: string }): Promise<string> {
  const appName = args.app_name.toLowerCase().trim();
  // SECURITY: Strict allowlist — only these apps can be opened. No fallback to raw input.
  const appMap: Record<string, string> = {
    'notepad': 'notepad.exe', 'calculator': 'calc.exe', 'calc': 'calc.exe',
    'explorer': 'explorer.exe', 'file explorer': 'explorer.exe',
    'paint': 'mspaint.exe', 'mspaint': 'mspaint.exe',
    'settings': 'ms-settings:', 'task manager': 'taskmgr.exe', 'taskmgr': 'taskmgr.exe',
    'word': 'winword.exe', 'excel': 'excel.exe', 'outlook': 'outlook.exe',
  };
  const executable = appMap[appName];
  if (!executable) {
    return `❌ Ứng dụng "${args.app_name}" không nằm trong danh sách cho phép. Cho phép: ${Object.keys(appMap).join(', ')}`;
  }

  // ms-settings: is a URI, use shell.openExternal
  if (executable.startsWith('ms-settings:')) {
    try {
      await shell.openExternal(executable);
      return `✅ Đã mở ${appName}!`;
    } catch (error: any) {
      return `❌ Lỗi mở ${appName}: ${error.message}`;
    }
  }

  // SECURITY: Use execFile (no shell) to prevent injection
  return new Promise((resolve) => {
    execFile(executable, [], (error: Error | null) => {
      if (error) {
        resolve(`❌ Lỗi mở ${appName}: ${error.message}`);
      } else {
        resolve(`✅ Đã mở ${appName}!`);
      }
    });
  });
}

function executeGetSystemInfo(): string {
  const primaryDisplay = screen.getPrimaryDisplay();
  return `📊 Thông tin hệ thống:
- Nền tảng: ${process.platform} ${process.arch}
- Phiên bản: ${app.getVersion()}
- Node.js: ${process.versions.node}
- Electron: ${process.versions.electron}
- Màn hình: ${primaryDisplay.size.width}x${primaryDisplay.size.height}
- Bộ nhớ: ${Math.round(process.memoryUsage().heapUsed / 1024 / 1024)} MB đang dùng
- Uptime: ${Math.round(process.uptime() / 60)} phút`;
}

// --- MOUSE TOOLS ---
async function executeMouseClick(args: { x: number; y: number }): Promise<string> {
  await initNutJs();
  if (!nutMouse) return '❌ Không thể điều khiển chuột (nut-js chưa cài)';
  try {
    await nutMouse.setPosition({ x: args.x, y: args.y });
    await nutMouse.click(nutButton.LEFT);
    return `✅ Đã click tại (${args.x}, ${args.y})`;
  } catch (e: any) {
    return `❌ Lỗi click: ${e.message}`;
  }
}

async function executeMouseDoubleClick(args: { x: number; y: number }): Promise<string> {
  await initNutJs();
  if (!nutMouse) return '❌ Không thể điều khiển chuột';
  try {
    await nutMouse.setPosition({ x: args.x, y: args.y });
    await nutMouse.doubleClick(nutButton.LEFT);
    return `✅ Đã double-click tại (${args.x}, ${args.y})`;
  } catch (e: any) {
    return `❌ Lỗi: ${e.message}`;
  }
}

async function executeMouseRightClick(args: { x: number; y: number }): Promise<string> {
  await initNutJs();
  if (!nutMouse) return '❌ Không thể điều khiển chuột';
  try {
    await nutMouse.setPosition({ x: args.x, y: args.y });
    await nutMouse.click(nutButton.RIGHT);
    return `✅ Đã click phải tại (${args.x}, ${args.y})`;
  } catch (e: any) {
    return `❌ Lỗi: ${e.message}`;
  }
}

async function executeMouseMove(args: { x: number; y: number }): Promise<string> {
  await initNutJs();
  if (!nutMouse) return '❌ Không thể điều khiển chuột';
  try {
    await nutMouse.setPosition({ x: args.x, y: args.y });
    return `✅ Đã di chuyển chuột đến (${args.x}, ${args.y})`;
  } catch (e: any) {
    return `❌ Lỗi: ${e.message}`;
  }
}

async function executeMouseScroll(args: { direction: string; amount?: number }): Promise<string> {
  await initNutJs();
  if (!nutMouse) return '❌ Không thể điều khiển chuột';
  const amount = args.amount || 3;
  try {
    switch (args.direction) {
      case 'up': await nutMouse.scrollUp(amount); break;
      case 'down': await nutMouse.scrollDown(amount); break;
      case 'left': await nutMouse.scrollLeft(amount); break;
      case 'right': await nutMouse.scrollRight(amount); break;
    }
    return `✅ Đã cuộn ${args.direction} ${amount} đơn vị`;
  } catch (e: any) {
    return `❌ Lỗi: ${e.message}`;
  }
}

async function executeMouseDrag(args: { x1: number; y1: number; x2: number; y2: number }): Promise<string> {
  await initNutJs();
  if (!nutMouse) return '❌ Không thể điều khiển chuột';
  try {
    await nutMouse.setPosition({ x: args.x1, y: args.y1 });
    await nutMouse.pressButton(nutButton.LEFT);
    await nutMouse.setPosition({ x: args.x2, y: args.y2 });
    await nutMouse.releaseButton(nutButton.LEFT);
    return `✅ Đã kéo từ (${args.x1}, ${args.y1}) đến (${args.x2}, ${args.y2})`;
  } catch (e: any) {
    return `❌ Lỗi: ${e.message}`;
  }
}

// --- KEYBOARD TOOLS ---
async function executeKeyboardType(args: { text: string }): Promise<string> {
  await initNutJs();
  if (!nutKeyboard) return '❌ Không thể điều khiển bàn phím';
  try {
    await nutKeyboard.type(args.text);
    return `✅ Đã gõ: "${args.text}"`;
  } catch (e: any) {
    return `❌ Lỗi: ${e.message}`;
  }
}

async function executeKeyboardPress(args: { key: string }): Promise<string> {
  await initNutJs();
  if (!nutKeyboard || !nutKey) return '❌ Không thể điều khiển bàn phím';

  const keyMap: Record<string, any> = {
    'enter': nutKey.Enter, 'return': nutKey.Enter, 'tab': nutKey.Tab,
    'escape': nutKey.Escape, 'esc': nutKey.Escape, 'space': nutKey.Space,
    'backspace': nutKey.Backspace, 'delete': nutKey.Delete, 'del': nutKey.Delete,
    'home': nutKey.Home, 'end': nutKey.End,
    'pageup': nutKey.PageUp, 'pagedown': nutKey.PageDown,
    'up': nutKey.Up, 'down': nutKey.Down, 'left': nutKey.Left, 'right': nutKey.Right,
    'f1': nutKey.F1, 'f2': nutKey.F2, 'f3': nutKey.F3, 'f4': nutKey.F4,
    'f5': nutKey.F5, 'f6': nutKey.F6, 'f7': nutKey.F7, 'f8': nutKey.F8,
    'f9': nutKey.F9, 'f10': nutKey.F10, 'f11': nutKey.F11, 'f12': nutKey.F12,
  };

  const keyName = args.key.toLowerCase();
  const key = keyMap[keyName];
  if (!key) return `❌ Không tìm thấy phím: ${args.key}`;

  try {
    await nutKeyboard.pressKey(key);
    await nutKeyboard.releaseKey(key);
    return `✅ Đã nhấn phím: ${args.key.toUpperCase()}`;
  } catch (e: any) {
    return `❌ Lỗi: ${e.message}`;
  }
}

async function executeKeyboardHotkey(args: { keys: string[] }): Promise<string> {
  await initNutJs();
  if (!nutKeyboard || !nutKey) return '❌ Không thể điều khiển bàn phím';

  const keyMap: Record<string, any> = {
    'ctrl': nutKey.LeftControl, 'control': nutKey.LeftControl,
    'alt': nutKey.LeftAlt, 'shift': nutKey.LeftShift,
    'win': nutKey.LeftWin, 'windows': nutKey.LeftWin, 'meta': nutKey.LeftWin,
    'a': nutKey.A, 'b': nutKey.B, 'c': nutKey.C, 'd': nutKey.D, 'e': nutKey.E,
    'f': nutKey.F, 'g': nutKey.G, 'h': nutKey.H, 'i': nutKey.I, 'j': nutKey.J,
    'k': nutKey.K, 'l': nutKey.L, 'm': nutKey.M, 'n': nutKey.N, 'o': nutKey.O,
    'p': nutKey.P, 'q': nutKey.Q, 'r': nutKey.R, 's': nutKey.S, 't': nutKey.T,
    'u': nutKey.U, 'v': nutKey.V, 'w': nutKey.W, 'x': nutKey.X, 'y': nutKey.Y, 'z': nutKey.Z,
    'tab': nutKey.Tab, 'enter': nutKey.Enter, 'escape': nutKey.Escape, 'esc': nutKey.Escape,
    'f1': nutKey.F1, 'f2': nutKey.F2, 'f3': nutKey.F3, 'f4': nutKey.F4,
    'f5': nutKey.F5, 'f6': nutKey.F6, 'f7': nutKey.F7, 'f8': nutKey.F8,
    'f9': nutKey.F9, 'f10': nutKey.F10, 'f11': nutKey.F11, 'f12': nutKey.F12,
  };

  try {
    const nutKeys = args.keys.map(k => keyMap[k.toLowerCase()]).filter(k => k);
    if (nutKeys.length === 0) return `❌ Không tìm thấy phím: ${args.keys.join('+')}`;

    for (const k of nutKeys) await nutKeyboard.pressKey(k);
    for (const k of nutKeys.reverse()) await nutKeyboard.releaseKey(k);
    return `✅ Đã nhấn: ${args.keys.join('+').toUpperCase()}`;
  } catch (e: any) {
    return `❌ Lỗi: ${e.message}`;
  }
}

// --- SCREENSHOT TOOL ---
async function executeTakeScreenshot(args: { filename?: string }): Promise<string> {
  try {
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: screen.getPrimaryDisplay().size,
    });

    if (sources.length === 0) return '❌ Không tìm thấy màn hình';

    const thumbnail = sources[0].thumbnail;
    const pngBuffer = thumbnail.toPNG();

    const filename = args.filename || `screenshot_${Date.now()}.png`;
    const filePath = join(app.getPath('pictures'), filename);
    fs.writeFileSync(filePath, pngBuffer);

    // Also open the file
    shell.openPath(filePath);
    return `✅ Đã chụp màn hình và lưu tại: ${filePath}`;
  } catch (e: any) {
    return `❌ Lỗi chụp màn hình: ${e.message}`;
  }
}

// --- FILE TOOLS ---
async function executeOpenFolder(args: { path: string }): Promise<string> {
  try {
    const { normalize, resolve } = require('path');
    const requestedPath = normalize(resolve(args.path));

    // SECURITY: Only allow opening folders under safe base directories
    const safeBases = [
      app.getPath('home'),
      app.getPath('documents'),
      app.getPath('downloads'),
      app.getPath('pictures'),
      app.getPath('desktop'),
      app.getPath('userData'),
    ].map(p => normalize(p).toLowerCase());

    const normalizedLower = requestedPath.toLowerCase();
    const isSafe = safeBases.some(base => normalizedLower.startsWith(base));
    if (!isSafe) {
      return `❌ Đường dẫn không được phép. Chỉ cho mở trong: Documents, Downloads, Pictures, Desktop.`;
    }

    await shell.openPath(requestedPath);
    return `✅ Đã mở thư mục: ${requestedPath}`;
  } catch (e: any) {
    return `❌ Lỗi: ${e.message}`;
  }
}

// executeRunCommand REMOVED — was full RCE via arbitrary shell execution with trivially-bypassed blocklist

// --- BOOKSY TOOLS ---
async function executeBooksyGetBookings(args: { date?: string }): Promise<string> {
  const booksy = getBooksySync();
  if (!booksy) {
    return '❌ Booksy sync chưa được cấu hình. Vui lòng setup trong Settings → Booksy Sync.';
  }

  // Parse date
  let targetDate: string;
  const now = new Date();

  if (!args.date || args.date === 'today' || args.date === 'hôm nay') {
    targetDate = now.toISOString().split('T')[0];
  } else if (args.date === 'tomorrow' || args.date === 'mai' || args.date === 'ngày mai') {
    const tomorrow = new Date(now);
    tomorrow.setDate(tomorrow.getDate() + 1);
    targetDate = tomorrow.toISOString().split('T')[0];
  } else if (/^\d{4}-\d{2}-\d{2}$/.test(args.date)) {
    targetDate = args.date;
  } else {
    // Try to parse relative dates
    const lowerDate = (args.date || '').toLowerCase();
    if (lowerDate.includes('hôm qua') || lowerDate.includes('yesterday')) {
      const yesterday = new Date(now);
      yesterday.setDate(yesterday.getDate() - 1);
      targetDate = yesterday.toISOString().split('T')[0];
    } else if (lowerDate.includes('tuần sau') || lowerDate.includes('next week')) {
      const nextWeek = new Date(now);
      nextWeek.setDate(nextWeek.getDate() + 7);
      targetDate = nextWeek.toISOString().split('T')[0];
    } else {
      targetDate = now.toISOString().split('T')[0]; // Default to today
    }
  }

  try {
    // If asking for today and we have cached data, use it
    const today = now.toISOString().split('T')[0];
    let bookings: any[];

    if (targetDate === today) {
      bookings = booksy.getBookings() || [];
      if (bookings.length === 0) {
        // Try to fetch fresh
        bookings = await booksy.fetchBookingsForDate(targetDate);
      }
    } else {
      // Fetch for specific date
      bookings = await booksy.fetchBookingsForDate(targetDate);
    }

    if (bookings.length === 0) {
      const status = booksy.getStatus();
      if (status.sessionExpired) {
        return `⚠️ Booksy session đã hết hạn. Cần đăng nhập lại trong Chrome.\n\nKhông có dữ liệu cho ngày ${targetDate}.`;
      }
      if (!status.chromeConnected) {
        return `⚠️ Chrome chưa kết nối. Mở Chrome với --remote-debugging-port=9222 và đăng nhập Booksy.\n\nKhông có dữ liệu cho ngày ${targetDate}.`;
      }
      return `📅 Ngày ${targetDate}: Không có lịch hẹn nào.`;
    }

    // Format response
    const dateLabel = targetDate === today ? 'Hôm nay' :
                      targetDate === new Date(now.getTime() + 86400000).toISOString().split('T')[0] ? 'Ngày mai' :
                      targetDate;

    let response = `📅 **${dateLabel}** (${targetDate}): **${bookings.length} lịch hẹn**\n\n`;

    for (const b of bookings.slice(0, 10)) { // Limit to 10 for readability
      const time = b.from ? b.from.substring(11, 16) : '??:??';
      const endTime = b.till ? b.till.substring(11, 16) : '';
      response += `• ${time}${endTime ? '-' + endTime : ''} - **${b.customerName}** - ${b.serviceName} (${b.staffName})\n`;
    }

    if (bookings.length > 10) {
      response += `\n... và ${bookings.length - 10} lịch hẹn khác`;
    }

    return response;
  } catch (e: any) {
    logger.error('[ZiraAI Booksy] Error fetching bookings:', e);
    return `❌ Lỗi lấy lịch hẹn: ${e.message}`;
  }
}

async function executeBooksyGetStatus(): Promise<string> {
  const booksy = getBooksySync();
  if (!booksy) {
    return '❌ Booksy sync chưa được cấu hình.';
  }

  const status = booksy.getStatus();
  let response = '📊 **Trạng thái Booksy Sync**\n\n';
  response += `• Enabled: ${status.enabled ? '✅' : '❌'}\n`;
  response += `• Running: ${status.running ? '🔄' : '⏸️'}\n`;
  response += `• Chrome connected: ${status.chromeConnected ? '✅' : '❌'}\n`;
  response += `• Session: ${status.sessionExpired ? '❌ Hết hạn' : status.hasToken ? '✅ Active' : '⚠️ Chưa có token'}\n`;
  response += `• Last sync: ${status.lastSyncTime || 'Chưa sync'}\n`;
  response += `• Business hours: ${status.isBusinessHours ? '✅' : '❌'}\n`;

  if (status.lastSyncReport) {
    response += `\n📈 **Lần sync gần nhất:**\n`;
    response += `• Ngày: ${status.lastSyncReport.date}\n`;
    response += `• Số lịch hẹn: ${status.lastSyncReport.bookings}\n`;
    if (status.lastSyncReport.error) {
      response += `• Lỗi: ${status.lastSyncReport.error}\n`;
    }
  }

  if (status.sessionExpired) {
    response += '\n⚠️ **Session đã hết hạn!** Vui lòng đăng nhập lại Booksy trong Chrome.';
  }

  return response;
}

async function executeBooksyGetCustomers(): Promise<string> {
  const booksy = getBooksySync();
  if (!booksy) {
    return '❌ Booksy sync chưa được cấu hình.';
  }

  const customers = booksy.getCustomers() || [];
  const status = booksy.getStatus();

  if (customers.length === 0) {
    if (status.sessionExpired) {
      return '⚠️ Booksy session hết hạn. Chưa có dữ liệu khách hàng.';
    }
    return '📋 Chưa có dữ liệu khách hàng. Chạy Sync Customers trong Booksy tab.';
  }

  let response = `👥 **Khách hàng Booksy: ${customers.length} người**\n\n`;

  // Show last 10 customers
  const recent = customers.slice(-10);
  for (const c of recent) {
    const name = c.full_name || `${c.first_name} ${c.last_name}`.trim();
    response += `• ${name}`;
    if (c.cell_phone) response += ` - ${c.cell_phone}`;
    if (c.visit_frequency) response += ` (${c.visit_frequency} lượt)`;
    response += '\n';
  }

  if (customers.length > 10) {
    response += `\n... và ${customers.length - 10} khách hàng khác`;
  }

  return response;
}

async function executeBooksyGetStaff(): Promise<string> {
  const booksy = getBooksySync();
  if (!booksy) {
    return '❌ Booksy sync chưa được cấu hình.';
  }

  const staff = booksy.getStaff() || [];

  if (staff.length === 0) {
    return '📋 Chưa có dữ liệu nhân viên. Chạy Sync Staff trong Booksy tab.';
  }

  let response = `👨‍💼 **Nhân viên: ${staff.length} người**\n\n`;

  for (const s of staff) {
    response += `• **${s.name}**`;
    if (s.description) response += ` - ${s.description}`;
    if (s.is_current_user) response += ' (Bạn)';
    response += '\n';
  }

  return response;
}

async function executeBooksyGetServices(): Promise<string> {
  const booksy = getBooksySync();
  if (!booksy) {
    return '❌ Booksy sync chưa được cấu hình.';
  }

  const categories = booksy.getServices() || [];

  if (categories.length === 0) {
    return '📋 Chưa có dữ liệu dịch vụ. Chạy Sync Services trong Booksy tab.';
  }

  let response = '💅 **Dịch vụ Booksy:**\n\n';
  let totalServices = 0;

  for (const cat of categories) {
    response += `**${cat.name}:**\n`;
    for (const svc of (cat.services || []).slice(0, 5)) {
      response += `  • ${svc.name}`;
      if (svc.price_text) response += ` - ${svc.price_text}`;
      else if (svc.price) response += ` - ${svc.price} PLN`;
      response += '\n';
      totalServices++;
    }
    if ((cat.services || []).length > 5) {
      response += `  ... và ${cat.services.length - 5} dịch vụ khác\n`;
      totalServices += cat.services.length - 5;
    }
    response += '\n';
  }

  response = response.replace('**Dịch vụ Booksy:**', `**Dịch vụ Booksy: ${totalServices} dịch vụ**`);
  return response;
}

// --- BROWSER AUTOMATION TOOLS (Chrome CDP) ---
// Keep track of the current browser page for multi-step operations
let currentBrowserPage: any = null;
let currentBrowser: any = null;
let chromeProcess: any = null;
let pendingLoginUrl: string | null = null;

// Chrome profile modes
type ChromeProfileMode = 'user' | 'separate';

// Get Chrome user data directory
function getChromeUserDataDir(mode: ChromeProfileMode = 'separate'): string {
  if (mode === 'user') {
    // Use user's REAL Chrome profile - has all logins already!
    // But Chrome must be closed first or we use existing running Chrome
    const userProfile = join(process.env['LOCALAPPDATA'] || '', 'Google', 'Chrome', 'User Data');
    if (fs.existsSync(userProfile)) {
      return userProfile;
    }
  }
  // Fallback to separate profile (needs login once, then remembers)
  return join(app.getPath('userData'), 'chrome-cdp-profile');
}

// Chrome profile info
interface ChromeProfile {
  directory: string;  // e.g., 'Default', 'Profile 1'
  name: string;       // Display name e.g., 'Osoba 1', 'Work'
}

// List all Chrome profiles
function listChromeProfiles(): ChromeProfile[] {
  const profiles: ChromeProfile[] = [];
  const userDataDir = join(process.env['LOCALAPPDATA'] || '', 'Google', 'Chrome', 'User Data');

  logger.info(`[ZiraAI] listChromeProfiles: userDataDir = ${userDataDir}`);

  if (!fs.existsSync(userDataDir)) {
    logger.info(`[ZiraAI] listChromeProfiles: userDataDir not found, returning Default`);
    return [{ directory: 'Default', name: 'Default' }];
  }

  // Read Local State file to get profile names
  const localStatePath = join(userDataDir, 'Local State');
  let profileInfoCache: Record<string, { name?: string }> = {};

  try {
    if (fs.existsSync(localStatePath)) {
      const localState = JSON.parse(fs.readFileSync(localStatePath, 'utf-8'));
      profileInfoCache = localState?.profile?.info_cache || {};
    }
  } catch (e) {
    logger.warn('[ZiraAI Browser] Failed to read Chrome Local State:', e);
  }

  // List profile directories
  const entries = fs.readdirSync(userDataDir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isDirectory() && (entry.name === 'Default' || entry.name.startsWith('Profile '))) {
      const profileInfo = profileInfoCache[entry.name];
      profiles.push({
        directory: entry.name,
        name: profileInfo?.name || entry.name,
      });
    }
  }

  // Sort: Default first, then by profile number
  profiles.sort((a, b) => {
    if (a.directory === 'Default') return -1;
    if (b.directory === 'Default') return 1;
    return a.directory.localeCompare(b.directory, undefined, { numeric: true });
  });

  const result = profiles.length > 0 ? profiles : [{ directory: 'Default', name: 'Default' }];
  logger.info(`[ZiraAI] listChromeProfiles: returning ${result.length} profiles: ${result.map(p => p.name).join(', ')}`);
  return result;
}

// Flag to track if we're waiting for profile selection
let pendingProfileSelection = false;
// Store pending browser intent (URL) to auto-open after profile selection
let pendingBrowserIntent: { url: string } | null = null;

// Check if user's Chrome is running (not CDP mode)
async function isUserChromeRunning(): Promise<boolean> {
  return new Promise((resolve) => {
    exec('tasklist /FI "IMAGENAME eq chrome.exe" /FO CSV', { shell: 'cmd.exe' }, (error: Error | null, stdout: string) => {
      if (error) {
        resolve(false);
        return;
      }
      // Check if Chrome is running but NOT with remote-debugging-port
      const hasChromeProcess = stdout.toLowerCase().includes('chrome.exe');
      resolve(hasChromeProcess);
    });
  });
}

// Check if Chrome CDP is running
async function isChromeCdpRunning(port: number = 9222): Promise<boolean> {
  return new Promise((resolve) => {
    const http = require('http');
    const req = http.get(`http://127.0.0.1:${port}/json/version`, (res: any) => {
      resolve(res.statusCode === 200);
    });
    req.on('error', () => resolve(false));
    req.setTimeout(2000, () => {
      req.destroy();
      resolve(false);
    });
  });
}

// Start Chrome with CDP - supports user profile or separate profile
async function startChromeCdp(url?: string, useUserProfile: boolean = true): Promise<{ success: boolean; message: string; needsLogin: boolean; needsProfileSelection?: boolean; profiles?: ChromeProfile[] }> {
  const cdpPort = 9222;

  // 1. Determine profile mode
  let profileMode: ChromeProfileMode = 'separate';
  let needsLogin = true;

  if (useUserProfile) {
    profileMode = 'user';
    needsLogin = false;
    
    // KILL EXISTING CHROME: "Fresh Start" Policy
    // Always kill Chrome when using user profile to ensure CDP port availability
    logger.info('[ZiraAI Browser] Fresh Start: Killing any existing Chrome processes...');
    try {
      await executeKillChrome(); 
    } catch (e) { 
      logger.warn('[ZiraAI Browser] Kill chrome warning:', e); 
    }
    
    // Wait for cleanup
    await new Promise(r => setTimeout(r, 2000));
  } else {
    // Check if CDP is already running (only relevant for separate profile mode)
    if (await isChromeCdpRunning(cdpPort)) {
      logger.info('[ZiraAI Browser] Chrome CDP already running (separate mode)');
      return { success: true, message: 'Chrome CDP đã chạy sẵn.', needsLogin: false };
    }
  }

  const userDataDir = getChromeUserDataDir(profileMode);

  // 2. Check Chrome profiles (only for user profile mode)
  let profileDirectory: string | undefined;
  if (profileMode === 'user') {
    const savedProfile = getConfigValue('chromeProfileDirectory');
    const profiles = listChromeProfiles();

    logger.info(`[ZiraAI Browser] Found ${profiles.length} Chrome profiles, saved: ${savedProfile || 'none'}`);

    if (profiles.length === 1) {
      profileDirectory = profiles[0].directory;
      logger.info(`[ZiraAI Browser] Auto-selecting only profile: ${profileDirectory}`);
    } else if (savedProfile) {
      const profileExists = profiles.some(p => p.directory === savedProfile);
      if (profileExists) {
        profileDirectory = savedProfile;
        logger.info(`[ZiraAI Browser] Using saved profile: ${profileDirectory}`);
      } else {
        logger.warn(`[ZiraAI Browser] Saved profile '${savedProfile}' not found, need selection`);
        pendingProfileSelection = true;
        return { success: false, message: '', needsLogin: false, needsProfileSelection: true, profiles: profiles };
      }
    } else {
      logger.info(`[ZiraAI Browser] Multiple profiles found, need user selection`);
      pendingProfileSelection = true;
      return { success: false, message: '', needsLogin: false, needsProfileSelection: true, profiles: profiles };
    }
  }

  // 3. Find Chrome path
  const chromePaths = [
    process.env['PROGRAMFILES'] + '\\Google\\Chrome\\Application\\chrome.exe',
    process.env['PROGRAMFILES(X86)'] + '\\Google\\Chrome\\Application\\chrome.exe',
    process.env['LOCALAPPDATA'] + '\\Google\\Chrome\\Application\\chrome.exe',
  ];

  let chromePath = '';
  for (const p of chromePaths) {
    if (fs.existsSync(p)) {
      chromePath = p;
      break;
    }
  }

  if (!chromePath) {
    return { success: false, message: '❌ Không tìm thấy Chrome. Vui lòng cài đặt Google Chrome.', needsLogin: false };
  }

  // Ensure user data directory exists (only for separate profile)
  if (profileMode === 'separate' && !fs.existsSync(userDataDir)) {
    fs.mkdirSync(userDataDir, { recursive: true });
  }

  // 4. Build Chrome args
  const args = [
    `--remote-debugging-port=${cdpPort}`,
    `--user-data-dir="${userDataDir}"`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-blink-features=AutomationControlled', // Hide automation flag
  ];

  if (profileDirectory) {
    args.push(`--profile-directory="${profileDirectory}"`);
  }

  if (url) {
    args.push(`"${url}"`);
  }

  // 5. Start Chrome
  const cmd = `"${chromePath}" ${args.join(' ')}`;
  logger.info(`[ZiraAI Browser] Launching Chrome: ${cmd}`);

  try {
    // Use spawn instead of exec for better process control
    const { spawn } = require('child_process');
    // Extract args correctly for spawn to avoid quoting issues with child_process
    // But since we use simple args, exec is fine and we need the shell for some Windows quirks
    chromeProcess = exec(cmd, { shell: 'cmd.exe' });
    
    chromeProcess.on('error', (err: any) => {
      logger.error('[ZiraAI Browser] Chrome process error:', err);
    });
  } catch (err: any) {
    logger.error('[ZiraAI Browser] Failed to launch Chrome:', err);
    return { success: false, message: `❌ Lỗi khởi động Chrome: ${err.message}`, needsLogin: false };
  }

  // 6. Poll for CDP readiness
  return new Promise((resolve) => {
    const startTime = Date.now();
    const checkInterval = setInterval(async () => {
      const cdpRunning = await isChromeCdpRunning(cdpPort);
      const elapsed = Date.now() - startTime;

      if (cdpRunning) {
        clearInterval(checkInterval);
        logger.info(`[ZiraAI Browser] Chrome CDP ready in ${elapsed}ms`);
        
        const profileInfo = profileMode === 'user' ? '(profile cá nhân)' : '(profile riêng)';
        resolve({
          success: true,
          message: `✅ Chrome đã khởi động ${profileInfo}`,
          needsLogin: needsLogin && profileMode === 'separate'
        });
      } else if (elapsed > 15000) {
        clearInterval(checkInterval);
        logger.error(`[ZiraAI Browser] CDP timeout after 15s`);
        
        let errorMsg = '❌ Không thể kết nối với Chrome (Timeout 15s).';
        
        // Only check for interference if we failed
        const zombieChrome = await isUserChromeRunning();
        if (zombieChrome) {
             errorMsg += '\n\nCó thể Chrome bị treo hoặc chặn cổng 9222. Hãy thử lệnh "tắt chrome" rồi mở lại.';
        }
        
        resolve({ success: false, message: errorMsg, needsLogin: false });
      }
    }, 500);
  });
}

async function executeBrowserSetup(args: { url?: string; profile?: string }): Promise<string> {
  const url = args.url || 'facebook.com';
  pendingLoginUrl = url;

  // If profile is provided, save it first
  if (args.profile) {
    const profiles = listChromeProfiles();
    const selectedProfile = profiles.find(p => p.directory === args.profile || p.name === args.profile);
    if (selectedProfile) {
      setConfigValue('chromeProfileDirectory', selectedProfile.directory);
      logger.info(`[ZiraAI Browser] Saved profile selection: ${selectedProfile.directory} (${selectedProfile.name})`);
      pendingProfileSelection = false;
    }
  }

  // Start Chrome with CDP - prefer user profile if available
  const result = await startChromeCdp(url, true);

  // Handle profile selection needed
  if (result.needsProfileSelection && result.profiles) {
    // Save intent for auto-launch after selection
    pendingBrowserIntent = { url: url };
    
    const profileList = result.profiles.map((p, i) => `${i + 1}. **${p.name}** (${p.directory})`).join('\n');
    return `🔍 **Bạn có nhiều Chrome profile!**\n\nChọn profile bạn muốn sử dụng:\n${profileList}\n\n💡 **Cách chọn:** Gõ tên profile hoặc số thứ tự, ví dụ:\n- "dùng profile Osoba 1"\n- "chọn profile 1"\n\n✅ Lựa chọn sẽ được lưu lại cho lần sau.`;
  }

  if (!result.success) {
    // DON'T open another browser - it causes duplicate Chrome windows
    // Just return error message
    logger.warn('[ZiraAI Browser] CDP failed:', result.message);
    return `❌ Không thể khởi động Chrome với CDP.\n\n${result.message}\n\n**Giải pháp:**\n1. Đóng TẤT CẢ cửa sổ Chrome\n2. Thử lại lệnh`;
  }

  // Check if already logged in by connecting and checking page
  try {
    const chromium = (await import('rebrowser-playwright-core')).chromium;
    const browser = await chromium.connectOverCDP('http://localhost:9222');
    const contexts = browser.contexts();

    if (contexts.length > 0) {
      // Wait for Chrome to fully initialize (session restore, etc.)
      await new Promise(r => setTimeout(r, 2000));

      const pages = contexts[0].pages();

      // Extract domain from URL for flexible matching (handles www., m., etc.)
      const urlDomain = url.replace('https://', '').replace('http://', '').split('/')[0];
      const baseDomain = urlDomain.replace(/^(www\.|m\.)/, ''); // e.g., "facebook.com"

      logger.info(`[ZiraAI Browser] Looking for page with domain: ${baseDomain} among ${pages.length} pages`);
      
      // OPTIMIZED LOGIC: If we just launched Chrome (result.success), rely on the first tab
      // This prevents the "Race Condition" where Playwright connects before Chrome finishes loading the CLI URL
      let targetPage: any;

      if (result.success && pages.length > 0) {
         // We just launched it, so the first tab IS the one we want (or will be)
         targetPage = pages[0];
         const currentUrl = targetPage.url();
         logger.info(`[ZiraAI Browser] Fresh launch detected. Using first tab: ${currentUrl}`);
         
         // If URL doesn't match yet (still loading or about:blank), navigate it
         if (!currentUrl.includes(baseDomain)) {
             logger.info(`[ZiraAI Browser] Tab URL '${currentUrl}' doesn't match '${baseDomain}' yet. Navigating...`);
             await targetPage.goto(url.startsWith('http') ? url : `https://${url}`, { waitUntil: 'domcontentloaded', timeout: 30000 });
         } else {
             logger.info(`[ZiraAI Browser] Tab already on target URL.`);
         }
      } else {
          // Fallback for connecting to existing session (not fresh launch)
          // ... existing search logic ...
          targetPage = pages.find((p: any) => {
            const pageUrl = p.url().toLowerCase();
            return pageUrl.includes(baseDomain.toLowerCase());
          });

          if (!targetPage) {
             if (pages.length === 1 && (pages[0].url() === 'about:blank' || pages[0].url().startsWith('chrome://newtab'))) {
                 targetPage = pages[0];
                 await targetPage.goto(url.startsWith('http') ? url : `https://${url}`, { waitUntil: 'domcontentloaded', timeout: 30000 });
             } else {
                 targetPage = await contexts[0].newPage();
                 await targetPage.goto(url.startsWith('http') ? url : `https://${url}`, { waitUntil: 'domcontentloaded', timeout: 30000 });
             }
          }
      }

      currentBrowserPage = targetPage;
      currentBrowser = browser;

      // Wait for page to load
      await new Promise(r => setTimeout(r, 2000));

      // Check if already logged in (for Facebook)
      const pageUrl = targetPage.url();
      const pageContent = await targetPage.evaluate(() => document.body.innerText.substring(0, 500));

      // Facebook login detection
      if (url.includes('facebook')) {
        const isLoggedIn = !pageUrl.includes('login') && !pageContent.includes('Log in') && !pageContent.includes('Đăng nhập');
        if (isLoggedIn) {
          pendingLoginUrl = null; // Already logged in
          return `✅ **Bạn đã đăng nhập Facebook rồi!**\n\nĐang ở trang: ${pageUrl}\n\nBạn muốn tôi làm gì tiếp? (ví dụ: "lướt xem có gì mới", "xem thông báo")`;
        }
      }

      // Gmail login detection
      if (url.includes('gmail') || url.includes('mail.google')) {
        const isLoggedIn = pageUrl.includes('mail.google.com/mail');
        if (isLoggedIn) {
          pendingLoginUrl = null;
          return `✅ **Bạn đã đăng nhập Gmail rồi!**\n\nBạn muốn tôi làm gì tiếp?`;
        }
      }

      // Booksy login detection
      if (url.includes('booksy')) {
        const isLoggedIn = pageUrl.includes('biz.booksy') && !pageUrl.includes('login');
        if (isLoggedIn) {
          pendingLoginUrl = null;
          return `✅ **Bạn đã đăng nhập Booksy rồi!**\n\nBạn muốn tôi làm gì tiếp?`;
        }
      }

      // If not using user profile, close and let user know
      if (result.needsLogin) {
        await browser.close();
      } else {
        // Using user profile but not logged in to this specific site
        await browser.close();
      }
    }
  } catch (e: any) {
    logger.warn('[ZiraAI Browser] Check login error:', e.message);
  }

  // Check if we're using separate profile (needs login)
  if (result.needsLogin) {
    return `🌐 **Chrome đã mở ${url}**

⚠️ **Chrome đang chạy nên tôi dùng profile riêng**

📝 **Để sử dụng account đã login sẵn:**
1. **Đóng TẤT CẢ cửa sổ Chrome** đang mở
2. Nói với tôi: **"mở lại facebook"** (hoặc trang bạn muốn)
3. Lúc đó tôi sẽ dùng profile Chrome của bạn - đã login sẵn!

**Hoặc login ở đây:**
1. Đăng nhập tài khoản trong cửa sổ Chrome này
2. Nói: **"xong rồi"** khi đăng nhập xong`;
  }

  return `🌐 **Chrome đã mở ${url}**

📝 **Bạn cần đăng nhập:**
1. Đăng nhập tài khoản của bạn trong cửa sổ Chrome vừa mở
2. Sau khi đăng nhập xong, nói với tôi: **"xong rồi"** hoặc **"đã đăng nhập"**

💡 **Lưu ý:** Lần sau bạn không cần đăng nhập lại - Chrome sẽ nhớ phiên của bạn!`;
}

async function executeBrowserCheckLogin(): Promise<string> {
  if (!pendingLoginUrl) {
    return '❌ Chưa có yêu cầu đăng nhập nào. Hãy nói "mở facebook" hoặc "mở gmail" trước.';
  }

  try {
    const chromium = (await import('rebrowser-playwright-core')).chromium;
    currentBrowser = await chromium.connectOverCDP('http://localhost:9222');
    const contexts = currentBrowser.contexts();

    if (contexts.length === 0) {
      return '❌ Chrome không có context. Thử chạy lại browser_setup.';
    }

    const pages = contexts[0].pages();
    const urlDomain = pendingLoginUrl.replace('https://', '').replace('http://', '').split('/')[0];
    let targetPage = pages.find((p: any) => p.url().includes(urlDomain));

    if (!targetPage && pages.length > 0) {
      targetPage = pages[pages.length - 1]; // Use last page
    }

    if (!targetPage) {
      return '❌ Không tìm thấy tab. Bạn đã đóng Chrome chưa?';
    }

    currentBrowserPage = targetPage;

    // Wait and scroll
    await new Promise(r => setTimeout(r, 2000));

    // Scroll to load content
    for (let i = 0; i < 2; i++) {
      await targetPage.mouse.wheel(0, 400);
      await new Promise(r => setTimeout(r, 800));
    }

    // Get page info
    const title = await targetPage.title();
    const pageUrl = targetPage.url();

    // Check login status
    if (pendingLoginUrl.includes('facebook')) {
      if (pageUrl.includes('login') || pageUrl.includes('checkpoint')) {
        return '⏳ Bạn chưa đăng nhập xong. Hãy hoàn tất đăng nhập rồi nói "xong rồi" nhé!';
      }
    }

    // Get content
    const text = await targetPage.evaluate(() => {
      // Try to get posts/feed content
      const posts = document.querySelectorAll('[role="article"], [data-ad-preview], .userContentWrapper');
      if (posts.length > 0) {
        return Array.from(posts).slice(0, 10).map(p => {
          const text = p.textContent || '';
          return text.substring(0, 400);
        }).join('\n\n---\n\n');
      }
      return document.body.innerText;
    });

    const limitedText = text.substring(0, 5000);
    pendingLoginUrl = null; // Clear pending

    return `✅ **Đăng nhập thành công!**

📄 **${title}**
🔗 ${pageUrl}

📰 **Nội dung:**

${limitedText}

---
💡 Nói "cuộn tiếp" để xem thêm, hoặc "đóng lại" để thoát.`;

  } catch (e: any) {
    logger.error('[ZiraAI Browser] Check login error:', e);
    return `❌ Lỗi kết nối Chrome: ${e.message}\n\nThử chạy lại "mở facebook" nhé.`;
  }
}

async function executeBrowserOpenAndRead(args: { url: string; scroll_times?: number; wait_seconds?: number }): Promise<string> {
  let chromium: any;
  try {
    chromium = (await import('rebrowser-playwright-core')).chromium;
  } catch {
    return '❌ Playwright chưa được cài đặt. Chạy: npm install playwright';
  }

  const cdpPort = 9222; // Same port as Booksy
  let url = args.url;
  if (!url.startsWith('http://') && !url.startsWith('https://')) {
    url = 'https://' + url;
  }

  try {
    // Connect to existing Chrome via CDP
    logger.info(`[ZiraAI Browser] Connecting to Chrome CDP port ${cdpPort}...`);
    currentBrowser = await chromium.connectOverCDP(`http://localhost:${cdpPort}`);

    const contexts = currentBrowser.contexts();
    if (contexts.length === 0) {
      return '❌ Chrome không có context. Mở Chrome với --remote-debugging-port=9222';
    }

    // Create new tab in existing context (preserves cookies/login)
    currentBrowserPage = await contexts[0].newPage();

    // Navigate to URL
    logger.info(`[ZiraAI Browser] Navigating to: ${url}`);
    await currentBrowserPage.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });

    // Wait for page to load
    const waitTime = (args.wait_seconds || 3) * 1000;
    await new Promise(r => setTimeout(r, waitTime));

    // Scroll to load more content
    const scrollTimes = args.scroll_times || 2;
    for (let i = 0; i < scrollTimes; i++) {
      await currentBrowserPage.mouse.wheel(0, 500);
      await new Promise(r => setTimeout(r, 1000));
    }

    // Get page title and text content
    const title = await currentBrowserPage.title();
    const text = await currentBrowserPage.evaluate(() => {
      // For Facebook/social media, try to get post content
      const posts = document.querySelectorAll('[data-ad-preview], [role="article"], .userContentWrapper, .x1yztbdb');
      if (posts.length > 0) {
        return Array.from(posts).slice(0, 10).map(p => p.textContent?.substring(0, 500)).join('\n---\n');
      }
      // Fallback to body text
      return document.body.innerText;
    });

    // Limit text length
    const limitedText = text.substring(0, 6000);

    logger.info(`[ZiraAI Browser] Page loaded: ${title}`);
    return `🌐 **${title}**\nURL: ${url}\n\n📄 **Nội dung:**\n${limitedText}\n\n_Dùng browser_scroll_and_read để xem thêm, hoặc browser_close để đóng._`;

  } catch (e: any) {
    logger.error('[ZiraAI Browser] Error:', e);
    if (e.message?.includes('connect')) {
      return `❌ Không kết nối được Chrome CDP. Đảm bảo Chrome đang chạy với:\n\nchrome.exe --remote-debugging-port=9222`;
    }
    return `❌ Lỗi: ${e.message}`;
  }
}

async function executeBrowserScreenshot(): Promise<string> {
  if (!currentBrowserPage) {
    return '❌ Chưa mở trang nào. Dùng browser_open_and_read trước.';
  }

  try {
    const buffer = await currentBrowserPage.screenshot({ type: 'png', fullPage: false });
    const filename = `browser_screenshot_${Date.now()}.png`;
    const filePath = join(app.getPath('pictures'), filename);
    fs.writeFileSync(filePath, buffer);
    shell.openPath(filePath);
    return `✅ Đã chụp màn hình browser và lưu tại: ${filePath}`;
  } catch (e: any) {
    return `❌ Lỗi chụp màn hình: ${e.message}`;
  }
}

async function executeBrowserScrollAndRead(args: { direction?: string; times?: number }): Promise<string> {
  if (!currentBrowserPage) {
    return '❌ Chưa mở trang nào. Dùng browser_open_and_read trước.';
  }

  try {
    const times = args.times || 3;
    const direction = args.direction || 'down';
    const scrollAmount = direction === 'down' ? 500 : -500;

    for (let i = 0; i < times; i++) {
      await currentBrowserPage.mouse.wheel(0, scrollAmount);
      await new Promise(r => setTimeout(r, 800));
    }

    // Get updated text content
    const text = await currentBrowserPage.evaluate(() => {
      const posts = document.querySelectorAll('[data-ad-preview], [role="article"], .userContentWrapper, .x1yztbdb');
      if (posts.length > 0) {
        return Array.from(posts).slice(0, 15).map(p => p.textContent?.substring(0, 500)).join('\n---\n');
      }
      return document.body.innerText;
    });

    const limitedText = text.substring(0, 6000);
    return `📜 **Đã cuộn ${direction} ${times} lần**\n\n${limitedText}`;

  } catch (e: any) {
    return `❌ Lỗi: ${e.message}`;
  }
}

async function executeBrowserClick(args: { text?: string; selector?: string }): Promise<string> {
  if (!currentBrowserPage) {
    return '❌ Chưa mở trang nào. Dùng browser_open_and_read trước.';
  }

  try {
    if (args.text) {
      // Click by text content
      await currentBrowserPage.getByText(args.text, { exact: false }).first().click({ timeout: 5000 });
      return `✅ Đã click vào "${args.text}"`;
    } else if (args.selector) {
      await currentBrowserPage.click(args.selector, { timeout: 5000 });
      return `✅ Đã click vào ${args.selector}`;
    } else {
      return '❌ Cần cung cấp text hoặc selector để click';
    }
  } catch (e: any) {
    return `❌ Không tìm thấy hoặc không click được: ${e.message}`;
  }
}

async function executeKillChrome(): Promise<string> {
  return new Promise((resolve) => {
    exec('taskkill /F /IM chrome.exe', { shell: 'cmd.exe' }, (error, stdout, stderr) => {
      if (error) {
        // Check if error is because no Chrome is running
        if (stderr.includes('not found') || stderr.includes('không tìm thấy')) {
          resolve('✅ Chrome không chạy.');
        } else {
          logger.warn('[ZiraAI Browser] Kill Chrome error:', error.message);
          resolve(`⚠️ Không thể tắt Chrome: ${error.message}`);
        }
        return;
      }
      logger.info('[ZiraAI Browser] Chrome killed successfully');
      resolve('✅ Đã tắt tất cả Chrome!\n\nBây giờ bạn có thể gõ **"mở facebook"** để tiếp tục.');
    });
  });
}

async function executeSelectChromeProfile(args: { profile: string }): Promise<string> {
  const profiles = listChromeProfiles();
  const input = args.profile.trim();

  // Try to match by number
  const num = parseInt(input);
  let selectedProfile: ChromeProfile | undefined;

  if (!isNaN(num) && num >= 1 && num <= profiles.length) {
    selectedProfile = profiles[num - 1];
  } else {
    // Try to match by name or directory (case insensitive)
    selectedProfile = profiles.find(p =>
      p.name.toLowerCase() === input.toLowerCase() ||
      p.directory.toLowerCase() === input.toLowerCase()
    );
  }

  if (!selectedProfile) {
    const profileList = profiles.map((p, i) => `${i + 1}. **${p.name}** (${p.directory})`).join('\n');
    return `❌ Không tìm thấy profile "${input}".\n\nCác profile có sẵn:\n${profileList}\n\nHãy gõ lại tên hoặc số thứ tự.`;
  }

  // Save the selection
  setConfigValue('chromeProfileDirectory', selectedProfile.directory);
  pendingProfileSelection = false;

  logger.info(`[ZiraAI Browser] Profile selected and saved: ${selectedProfile.directory} (${selectedProfile.name})`);

  // Auto-execute pending intent if exists
  if (pendingBrowserIntent) {
    const url = pendingBrowserIntent.url;
    pendingBrowserIntent = null; // Clear it
    logger.info(`[ZiraAI Browser] Auto-executing pending intent: open ${url}`);
    return await executeBrowserSetup({ url });
  }

  return `✅ Đã chọn profile **${selectedProfile.name}**!\n\nProfile này sẽ được dùng tự động cho các lần sau.\n\n💡 Bây giờ bạn có thể bảo tôi "mở facebook" hoặc "đăng nhập gmail".`;
}

async function executeBrowserClose(): Promise<string> {
  try {
    if (currentBrowserPage) {
      await currentBrowserPage.close();
      currentBrowserPage = null;
    }
    if (currentBrowser) {
      await currentBrowser.close();
      currentBrowser = null;
    }
    return '✅ Đã đóng tab browser.';
  } catch (e: any) {
    currentBrowserPage = null;
    currentBrowser = null;
    return `✅ Đã đóng (${e.message})`;
  }
}

// --- MULTI-STEP BROWSER TOOLS ---

async function executeBrowserType(args: { text: string; selector?: string; submit?: boolean }): Promise<string> {
  if (!currentBrowserPage) {
    return '❌ Chưa mở trang nào. Dùng "mở facebook" trước.';
  }

  try {
    if (args.selector) {
      // Type into specific element
      await currentBrowserPage.fill(args.selector, args.text);
    } else {
      // Type into currently focused element
      await currentBrowserPage.keyboard.type(args.text, { delay: 50 });
    }

    if (args.submit) {
      await currentBrowserPage.keyboard.press('Enter');
      await new Promise(r => setTimeout(r, 1000)); // Wait for submission
      return `✅ Đã gõ "${args.text}" và nhấn Enter`;
    }

    return `✅ Đã gõ: "${args.text}"`;
  } catch (e: any) {
    return `❌ Lỗi gõ text: ${e.message}`;
  }
}

interface PostInfo {
  index: number;
  content: string;
  author: string;
  hasImage: boolean;
  hasVideo: boolean;
  element?: any; // Store reference for interaction
}

// Cache posts for multi-step interaction
let cachedPosts: PostInfo[] = [];

async function executeBrowserGetPosts(args: { limit?: number }): Promise<string> {
  try {
    const result = await sendToExtension('get_posts', { limit: args.limit || 10 });
    
    if (!result.success) return `❌ Lỗi: ${result.error}`;
    
    const posts = result.data;
    if (posts.length === 0) return '📄 Không tìm thấy bài viết nào.';

    let response = `📰 **${posts.length} bài viết:**\n\n`;
    for (const post of posts) {
      const media = [];
      if (post.hasImage) media.push('🖼️');
      if (post.hasVideo) media.push('🎬');
      const mediaStr = media.length > 0 ? ` ${media.join('')}` : '';

      response += `**[${post.index}]** ${post.author}${mediaStr}\n`;
      response += `${post.content}...\n\n`;
    }
    response += `\n💡 Dùng số index [0-${posts.length - 1}] để tương tác.`;
    return response;
  } catch (e: any) {
    return `❌ Lỗi kết nối Extension: ${e.message}`;
  }
}

async function executeBrowserFindPostsByTopic(args: { topic: string; scroll_to_find?: number }): Promise<string> {
  if (!currentBrowserPage) {
    return '❌ Chưa mở trang nào. Dùng "mở facebook" trước.';
  }

  const topic = args.topic.toLowerCase();
  const scrollTimes = args.scroll_to_find || 3;

  try {
    const matchingPosts: PostInfo[] = [];

    // Scroll and collect matching posts
    for (let i = 0; i < scrollTimes; i++) {
      // Get posts
      const posts = await currentBrowserPage.evaluate((topicSearch: string) => {
        const results: Array<{
          index: number;
          content: string;
          author: string;
          hasImage: boolean;
          hasVideo: boolean;
        }> = [];

        const postElements = document.querySelectorAll('[role="article"], [data-ad-preview], .userContentWrapper');

        postElements.forEach((el, idx) => {
          const text = (el.textContent || '').toLowerCase();
          // Check if post contains topic
          if (text.includes(topicSearch)) {
            const authorEl = el.querySelector('strong, a[role="link"]');
            const author = authorEl?.textContent?.substring(0, 50) || 'Unknown';

            results.push({
              index: idx,
              content: (el.textContent || '').substring(0, 300),
              author: author,
              hasImage: !!el.querySelector('img:not([role="presentation"])'),
              hasVideo: !!el.querySelector('video, [data-video-id]'),
            });
          }
        });

        return results;
      }, topic);

      // Add new posts (avoid duplicates by content)
      for (const post of posts) {
        const exists = matchingPosts.some(p => p.content.substring(0, 100) === post.content.substring(0, 100));
        if (!exists) {
          matchingPosts.push({ ...post, index: matchingPosts.length });
        }
      }

      // Scroll down
      await currentBrowserPage.mouse.wheel(0, 600);
      await new Promise(r => setTimeout(r, 1500));
    }

    // Cache for later use
    cachedPosts = matchingPosts;

    if (matchingPosts.length === 0) {
      return `🔍 Không tìm thấy bài viết nào về "${args.topic}".\n\nThử dùng từ khóa khác hoặc scroll thêm: "tìm thêm bài về ${args.topic}"`;
    }

    let response = `🔍 **Tìm thấy ${matchingPosts.length} bài viết về "${args.topic}":**\n\n`;
    for (const post of matchingPosts.slice(0, 10)) {
      const media = [];
      if (post.hasImage) media.push('🖼️');
      if (post.hasVideo) media.push('🎬');
      const mediaStr = media.length > 0 ? ` ${media.join('')}` : '';

      response += `**[${post.index}]** ${post.author}${mediaStr}\n`;
      response += `${post.content.substring(0, 150)}...\n\n`;
    }

    if (matchingPosts.length > 10) {
      response += `\n... và ${matchingPosts.length - 10} bài viết khác`;
    }

    response += `\n\n💡 Nói "comment bài ${matchingPosts[0].index} về [nội dung]" để bình luận.`;
    return response;

  } catch (e: any) {
    return `❌ Lỗi tìm kiếm: ${e.message}`;
  }
}

async function executeBrowserCommentOnPost(args: { post_index: number; comment: string; submit?: boolean }): Promise<string> {
  if (!currentBrowserPage) {
    return '❌ Chưa mở trang nào. Dùng "mở facebook" trước.';
  }

  const { post_index, comment, submit } = args;

  try {
    // Dismiss popups first
    await dismissFacebookPopups(currentBrowserPage);

    // Find the post by index
    const clickedComment = await currentBrowserPage.evaluate((idx: number) => {
      const posts = document.querySelectorAll('[role="article"], [data-ad-preview], .userContentWrapper, .x1yztbdb');
      const post = posts[idx];

      if (!post) return false;

      // Scroll post into view
      post.scrollIntoView({ behavior: 'smooth', block: 'center' });

      // Robust Comment Button Finding:
      // 1. Explicit aria-label (Comment/Bình luận)
      let commentBtn = post.querySelector('[aria-label="Comment"], [aria-label="Bình luận"], [aria-label="Viết bình luận"], [data-testid="UFI2Comment/root"]');
      
      // 2. Search inside buttons
      if (!commentBtn) {
          const buttons = post.querySelectorAll('[role="button"]');
          for (const btn of buttons) {
              const label = btn.getAttribute('aria-label') || '';
              if (label === 'Comment' || label === 'Bình luận' || label.includes('Comment') || label.includes('Bình luận')) {
                  commentBtn = btn;
                  break;
              }
          }
      }

      if (commentBtn) {
        (commentBtn as HTMLElement).click();
        return true;
      }

      // 3. Fallback: "Comment" text inside span (common in new UI)
      const allSpans = post.querySelectorAll('span');
      for (const span of allSpans) {
        const text = span.textContent?.trim();
        if (text === 'Comment' || text === 'Bình luận') {
           ((span.closest('[role="button"]') || span) as HTMLElement).click();
           return true;
        }
      }

      return false;
    }, post_index);

    if (!clickedComment) {
      return `❌ Không tìm thấy nút comment ở bài viết [${post_index}]. Thử bài khác?`;
    }

    // Wait for comment box to appear
    await new Promise(r => setTimeout(r, 1000));

    // Type the comment
    await currentBrowserPage.keyboard.type(comment, { delay: 30 });

    if (submit) {
      // Press Enter to submit
      await currentBrowserPage.keyboard.press('Enter');
      await new Promise(r => setTimeout(r, 1500));
      return `✅ Đã comment "${comment}" vào bài viết [${post_index}] và gửi thành công!`;
    }

    return `✅ Đã gõ comment "${comment}" vào bài viết [${post_index}].\n\n💡 Nói "gửi" hoặc "submit" để đăng comment, hoặc "hủy" để không gửi.`;

  } catch (e: any) {
    return `❌ Lỗi comment: ${e.message}`;
  }
}

async function executeBrowserSummarize(args: { focus?: string }): Promise<string> {
  if (!currentBrowserPage) {
    return '❌ Chưa mở trang nào. Dùng "mở facebook" trước.';
  }

  const focus = args.focus || 'all';

  try {
    const pageInfo = await currentBrowserPage.evaluate((focusArea: string) => {
      const result: {
        title: string;
        url: string;
        postCount: number;
        topPosts: string[];
        hasNotifications: boolean;
        hasMessages: boolean;
      } = {
        title: document.title,
        url: window.location.href,
        postCount: 0,
        topPosts: [],
        hasNotifications: false,
        hasMessages: false,
      };

      // Count posts
      const posts = document.querySelectorAll('[role="article"], [data-ad-preview], .userContentWrapper');
      result.postCount = posts.length;

      // Get top 5 posts
      posts.forEach((el, idx) => {
        if (idx < 5) {
          const text = (el.textContent || '').substring(0, 200);
          result.topPosts.push(text);
        }
      });

      // Check for notifications (Facebook-specific)
      const notifBadge = document.querySelector('[aria-label*="notification"], [aria-label*="thông báo"]');
      result.hasNotifications = !!notifBadge?.textContent?.match(/\d+/);

      // Check for messages
      const msgBadge = document.querySelector('[aria-label*="Messenger"], [aria-label*="tin nhắn"]');
      result.hasMessages = !!msgBadge?.textContent?.match(/\d+/);

      return result;
    }, focus);

    let summary = `📊 **Tóm tắt trang**\n\n`;
    summary += `📄 **${pageInfo.title}**\n`;
    summary += `🔗 ${pageInfo.url}\n\n`;

    if (pageInfo.hasNotifications) {
      summary += `🔔 **Có thông báo mới!**\n`;
    }
    if (pageInfo.hasMessages) {
      summary += `💬 **Có tin nhắn mới!**\n`;
    }

    summary += `\n📰 **${pageInfo.postCount} bài viết trên màn hình**\n\n`;

    if (pageInfo.topPosts.length > 0) {
      summary += `**Nội dung chính:**\n`;
      pageInfo.topPosts.forEach((post: string, idx: number) => {
        // Clean up and truncate
        const cleanPost = post.replace(/\s+/g, ' ').trim().substring(0, 100);
        summary += `${idx + 1}. ${cleanPost}...\n`;
      });
    }

    summary += `\n💡 Nói "xem thêm" để cuộn, "tìm bài về [chủ đề]" để lọc, hoặc "đóng" để thoát.`;

    return summary;

  } catch (e: any) {
    return `❌ Lỗi tóm tắt: ${e.message}`;
  }
}

// =============================================
// FACEBOOK-SPECIFIC TOOLS
// =============================================

// Cache for messages/notifications
let cachedNotifications: Array<{ index: number; text: string; time: string; unread: boolean }> = [];
let cachedMessages: Array<{ index: number; name: string; lastMessage: string; time: string; unread: boolean }> = [];

// Helper to dismiss common Facebook popups/overlays
async function dismissFacebookPopups(page: any): Promise<void> {
  try {
    await page.evaluate(() => {
      // Common aria-labels for close/dismiss buttons
      const closeLabels = ['Close', 'Đóng', 'Not Now', 'Lúc khác', 'Allow', 'Cho phép', 'Block', 'Chặn'];
      const buttons = document.querySelectorAll('[role="button"], [aria-label]');
      
      for (const btn of buttons) {
        const label = btn.getAttribute('aria-label') || btn.textContent || '';
        if (closeLabels.some(l => label.includes(l))) {
          // Only click if it looks like an overlay/dialog button (heuristic)
          const rect = btn.getBoundingClientRect();
          // Check if it's visible and likely a popup action
          if (rect.width > 0 && rect.height > 0 && window.getComputedStyle(btn).zIndex !== 'auto') {
             // Use with caution - logging might be better than auto-clicking everything
          }
        }
      }
      
      // Specifically target "Allow Notifications" popup if standard
      const notifPopup = document.querySelector('[aria-label="Allow Notifications"]');
      if (notifPopup) (notifPopup as HTMLElement).click(); // Or close it
    });
  } catch (err: any) { logger.debug('[ZiraAI] dismiss notification popup failed:', err?.message); }
}

async function executeFacebookCreatePost(args: {
  content: string;
  image_path?: string;
  video_path?: string;
  feeling?: string;
  privacy?: 'public' | 'friends' | 'only_me';
  submit?: boolean;
}): Promise<string> {
  if (!currentBrowserPage) {
    return '❌ Chưa mở Facebook. Dùng "mở facebook" trước.';
  }

  // Dismiss any potential popups first
  await dismissFacebookPopups(currentBrowserPage);

  // Check for pending attachments from user drag & drop
  const pendingAttachments = getPendingAttachments();
  let imagePath = args.image_path;
  let videoPath = args.video_path;

  if (pendingAttachments && pendingAttachments.length > 0) {
    logger.info(`[Facebook] Found ${pendingAttachments.length} pending attachments`);
    for (const att of pendingAttachments) {
      if (att.type === 'image' && !imagePath) {
        imagePath = att.path;
        logger.info(`[Facebook] Using pending image: ${imagePath}`);
      } else if (att.type === 'video' && !videoPath) {
        videoPath = att.path;
        logger.info(`[Facebook] Using pending video: ${videoPath}`);
      }
    }
    // Clear pending attachments after use
    clearPendingAttachments();
  }

  try {
    // Check if on Facebook
    const url = currentBrowserPage.url();
    if (!url.includes('facebook.com')) {
      return '❌ Không phải trang Facebook. Hãy mở facebook trước.';
    }

    // Click on "What's on your mind?" or status composer
    const clickedComposer = await currentBrowserPage.evaluate(() => {
      // Try multiple selectors for the status composer
      const selectors = [
        '[aria-label*="What\'s on your mind"]',
        '[aria-label*="Bạn đang nghĩ gì"]',
        '[data-testid="status-attachment-mentions-input"]',
        'div[role="button"][tabindex="0"]:has-text("What\'s on your mind")',
        'div[role="button"][tabindex="0"]:has-text("Bạn đang nghĩ")',
        // New Facebook UI
        'div[role="textbox"][contenteditable="true"]',
        'span:has-text("What\'s on your mind")',
        'span:has-text("Bạn đang nghĩ")',
      ];

      for (const selector of selectors) {
        const el = document.querySelector(selector);
        if (el) {
          (el as HTMLElement).click();
          return true;
        }
      }

      // Fallback: Find any element with "What's on your mind" text
      const allElements = document.querySelectorAll('div, span');
      for (const el of allElements) {
        const text = el.textContent?.toLowerCase() || '';
        if (text.includes("what's on your mind") || text.includes('bạn đang nghĩ')) {
          (el as HTMLElement).click();
          return true;
        }
      }

      return false;
    });

    if (!clickedComposer) {
      return '❌ Không tìm thấy ô viết status. Hãy thử vào trang chủ Facebook (facebook.com).';
    }

    // Wait for composer to open
    await new Promise(r => setTimeout(r, 1500));

    // Type the content
    await currentBrowserPage.keyboard.type(args.content, { delay: 30 });

    // Handle image upload if provided
    if (imagePath) {
      try {
        // Click photo/video button
        const photoButtonClicked = await currentBrowserPage.evaluate(() => {
          const photoBtn = document.querySelector('[aria-label*="Photo"], [aria-label*="Ảnh"], [aria-label*="Video"]');
          if (photoBtn) {
            (photoBtn as HTMLElement).click();
            return true;
          }
          return false;
        });

        if (photoButtonClicked) {
          await new Promise(r => setTimeout(r, 500));
          // Set file input
          const fileInput = await currentBrowserPage.$('input[type="file"][accept*="image"]');
          if (fileInput) {
            await fileInput.setInputFiles(imagePath);
            await new Promise(r => setTimeout(r, 2000)); // Wait for upload
            logger.info(`[Facebook] Uploaded image: ${imagePath}`);
          }
        }
      } catch (e) {
        logger.warn('[Facebook] Could not upload image:', e);
      }
    }

    // Handle video upload if provided
    if (videoPath) {
      try {
        const videoBtn = await currentBrowserPage.$('[aria-label*="Video"], [aria-label*="Reel"]');
        if (videoBtn) {
          await videoBtn.click();
          await new Promise(r => setTimeout(r, 500));
          const fileInput = await currentBrowserPage.$('input[type="file"][accept*="video"]');
          if (fileInput) {
            await fileInput.setInputFiles(videoPath);
            await new Promise(r => setTimeout(r, 3000)); // Videos take longer
            logger.info(`[Facebook] Uploaded video: ${videoPath}`);
          }
        }
      } catch (e) {
        logger.warn('[Facebook] Could not upload video:', e);
      }
    }

    // Add feeling if provided
    if (args.feeling) {
      try {
        const feelingBtn = await currentBrowserPage.$('[aria-label*="Feeling"], [aria-label*="Cảm xúc"]');
        if (feelingBtn) {
          await feelingBtn.click();
          await new Promise(r => setTimeout(r, 500));
          await currentBrowserPage.keyboard.type(args.feeling);
          await currentBrowserPage.keyboard.press('Enter');
        }
      } catch (e) {
        logger.warn('[Facebook] Could not add feeling:', e);
      }
    }

    if (args.submit) {
      // Find and click Post button
      const posted = await currentBrowserPage.evaluate(() => {
        const postBtns = document.querySelectorAll('[aria-label*="Post"], [aria-label*="Đăng"], button');
        for (const btn of postBtns) {
          const text = btn.textContent?.toLowerCase() || '';
          const ariaLabel = btn.getAttribute('aria-label')?.toLowerCase() || '';
          if (text === 'post' || text === 'đăng' || ariaLabel.includes('post') || ariaLabel.includes('đăng')) {
            (btn as HTMLElement).click();
            return true;
          }
        }
        return false;
      });

      if (posted) {
        await new Promise(r => setTimeout(r, 2000));
        return `✅ Đã đăng bài thành công!\n\nNội dung: "${args.content.substring(0, 100)}${args.content.length > 100 ? '...' : ''}"`;
      } else {
        return `⚠️ Đã nhập nội dung nhưng không tìm thấy nút "Đăng". Hãy đăng thủ công.`;
      }
    }

    return `✅ Đã nhập nội dung bài viết:\n"${args.content.substring(0, 100)}${args.content.length > 100 ? '...' : ''}"\n\n💡 Nói "đăng đi" hoặc "submit" để đăng bài, hoặc "hủy" để không đăng.`;

  } catch (e: any) {
    return `❌ Lỗi tạo bài viết: ${e.message}`;
  }
}

async function executeFacebookLikePost(args: { post_index: number; reaction?: string }): Promise<string> {
  if (!currentBrowserPage) {
    return '❌ Chưa mở Facebook. Dùng "mở facebook" trước.';
  }

  const { post_index, reaction = 'like' } = args;

  try {
    // Dismiss popups before interaction
    await dismissFacebookPopups(currentBrowserPage);

    // Find and like the post
    const result = await currentBrowserPage.evaluate((idx: number, reactionType: string) => {
      const posts = document.querySelectorAll('[role="article"], [data-ad-preview], .userContentWrapper, .x1yztbdb');
      const post = posts[idx];

      if (!post) return { success: false, error: 'Không tìm thấy bài viết' };

      // Scroll into view
      post.scrollIntoView({ behavior: 'smooth', block: 'center' });

      // Improved Selector Strategy:
      // 1. Look for explicit aria-label "Like" or "Thích" (standard buttons)
      // 2. Look for reaction count/status which might wrap the button
      // 3. Fallback to text content
      
      let likeBtn = post.querySelector('[aria-label="Like"], [aria-label="Thích"], [aria-label="Bày tỏ cảm xúc"], [data-testid="UFI2ReactionLink"]');
      
      if (!likeBtn) {
          // Deep search for button inside the action bar
          const buttons = post.querySelectorAll('[role="button"]');
          for (const btn of buttons) {
              const label = btn.getAttribute('aria-label') || '';
              if (label === 'Like' || label === 'Thích' || label.includes('Like') || label.includes('Thích')) {
                  likeBtn = btn;
                  break;
              }
          }
      }

      if (!likeBtn) {
        // Fallback by text content
        const allSpans = post.querySelectorAll('span');
        for (const span of allSpans) {
           // Check for exact text match for "Like" or "Thích" to avoid "Reply" or "Like comment"
           const text = span.textContent?.trim();
           if (text === 'Like' || text === 'Thích') {
               // Find closest clickable parent
               likeBtn = span.closest('[role="button"]') || span;
               break;
           }
        }
        
        if (!likeBtn) return { success: false, error: 'Không tìm thấy nút Like' };
      }

      // For non-like reactions, we need to hover to show reaction picker
      if (reactionType !== 'like') {
        // Hover over like button to trigger reaction bar
        const hoverEvent = new MouseEvent('mouseover', { bubbles: true });
        likeBtn.dispatchEvent(hoverEvent);
        // Also try standard mouseenter
        const mouseEnter = new MouseEvent('mouseenter', { bubbles: true });
        likeBtn.dispatchEvent(mouseEnter);
        
        return { success: true, reaction: reactionType, needWait: true };
      }

      // Simple like
      (likeBtn as HTMLElement).click();
      return { success: true, reaction: 'like' };
    }, post_index, reaction);

    if (!result.success) {
      return `❌ ${result.error} ở bài viết [${post_index}].`;
    }

    // If we need to wait for reaction picker
    if (result.needWait) {
      await new Promise(r => setTimeout(r, 1000));

      // Try to click the specific reaction
      const reactionMap: Record<string, string[]> = {
        'love': ['Love', 'Yêu thích', '❤️'],
        'haha': ['Haha', 'Haha', '😆'],
        'wow': ['Wow', 'Wow', '😮'],
        'sad': ['Sad', 'Buồn', '😢'],
        'angry': ['Angry', 'Phẫn nộ', '😡'],
      };

      const reactionLabels = reactionMap[reaction] || [];
      const clicked = await currentBrowserPage.evaluate((labels: string[]) => {
        for (const label of labels) {
          const el = document.querySelector(`[aria-label*="${label}"]`);
          if (el) {
            (el as HTMLElement).click();
            return true;
          }
        }
        return false;
      }, reactionLabels);

      if (clicked) {
        return `✅ Đã react "${reaction}" bài viết [${post_index}]!`;
      }
    }

    return `✅ Đã like bài viết [${post_index}]!`;

  } catch (e: any) {
    return `❌ Lỗi like: ${e.message}`;
  }
}

async function executeFacebookSharePost(args: {
  post_index: number;
  message?: string;
  share_to?: 'timeline' | 'story' | 'message';
  submit?: boolean;
}): Promise<string> {
  if (!currentBrowserPage) {
    return '❌ Chưa mở Facebook. Dùng "mở facebook" trước.';
  }

  const { post_index, message, share_to = 'timeline', submit = false } = args;

  try {
    // Find and click share button
    const shareClicked = await currentBrowserPage.evaluate((idx: number) => {
      const posts = document.querySelectorAll('[role="article"], [data-ad-preview], .userContentWrapper');
      const post = posts[idx];

      if (!post) return false;

      post.scrollIntoView({ behavior: 'smooth', block: 'center' });

      // Find share button
      const shareBtn = post.querySelector('[aria-label*="Share"], [aria-label*="Chia sẻ"], [data-testid="UFI2ShareLink"]');
      if (shareBtn) {
        (shareBtn as HTMLElement).click();
        return true;
      }

      // Fallback by text
      const allBtns = post.querySelectorAll('div[role="button"], span');
      for (const btn of allBtns) {
        const text = btn.textContent?.toLowerCase() || '';
        if (text.includes('share') || text.includes('chia sẻ')) {
          (btn as HTMLElement).click();
          return true;
        }
      }

      return false;
    }, post_index);

    if (!shareClicked) {
      return `❌ Không tìm thấy nút Share ở bài viết [${post_index}].`;
    }

    await new Promise(r => setTimeout(r, 1000));

    // Select share destination based on share_to
    if (share_to === 'timeline') {
      // Click "Share Now" or "Share to Feed"
      const clickedOption = await currentBrowserPage.evaluate(() => {
        const options = document.querySelectorAll('[role="menuitem"], [role="button"]');
        for (const opt of options) {
          const text = opt.textContent?.toLowerCase() || '';
          if (text.includes('share now') || text.includes('chia sẻ ngay') ||
              text.includes('share to feed') || text.includes('chia sẻ lên')) {
            (opt as HTMLElement).click();
            return true;
          }
        }
        return false;
      });

      if (clickedOption && !message) {
        await new Promise(r => setTimeout(r, 1500));
        return `✅ Đã chia sẻ bài viết [${post_index}] lên timeline!`;
      }
    }

    // For custom message or other options, click "Share to Feed" to open dialog
    await currentBrowserPage.evaluate(() => {
      const options = document.querySelectorAll('[role="menuitem"], [role="button"]');
      for (const opt of options) {
        const text = opt.textContent?.toLowerCase() || '';
        if (text.includes('write post') || text.includes('viết bài') ||
            text.includes('share to feed') || text.includes('chia sẻ lên')) {
          (opt as HTMLElement).click();
          return true;
        }
      }
      return false;
    });

    await new Promise(r => setTimeout(r, 1000));

    // Add message if provided
    if (message) {
      await currentBrowserPage.keyboard.type(message, { delay: 30 });
    }

    if (submit) {
      // Click share/post button
      const shared = await currentBrowserPage.evaluate(() => {
        const btns = document.querySelectorAll('[aria-label*="Share"], [aria-label*="Post"], [aria-label*="Đăng"], button');
        for (const btn of btns) {
          const text = btn.textContent?.toLowerCase() || '';
          if (text === 'share' || text === 'post' || text === 'đăng' || text === 'chia sẻ') {
            (btn as HTMLElement).click();
            return true;
          }
        }
        return false;
      });

      if (shared) {
        await new Promise(r => setTimeout(r, 2000));
        return `✅ Đã chia sẻ bài viết [${post_index}]${message ? ` với lời nhắn: "${message}"` : ''}!`;
      }
    }

    return `✅ Đã mở dialog chia sẻ bài viết [${post_index}].\n\n💡 Nói "share đi" để chia sẻ, hoặc "hủy" để đóng.`;

  } catch (e: any) {
    return `❌ Lỗi chia sẻ: ${e.message}`;
  }
}

async function executeFacebookGetNotifications(args: { limit?: number; unread_only?: boolean }): Promise<string> {
  if (!currentBrowserPage) {
    return '❌ Chưa mở Facebook. Dùng "mở facebook" trước.';
  }

  const { limit = 10, unread_only = false } = args;

  try {
    // Click notifications icon
    const clickedNotif = await currentBrowserPage.evaluate(() => {
      const notifBtn = document.querySelector('[aria-label*="Notifications"], [aria-label*="Thông báo"]');
      if (notifBtn) {
        (notifBtn as HTMLElement).click();
        return true;
      }
      return false;
    });

    if (!clickedNotif) {
      // Try navigating to notifications page
      await currentBrowserPage.goto('https://www.facebook.com/notifications', { waitUntil: 'domcontentloaded' });
    }

    await new Promise(r => setTimeout(r, 2000));

    // Get notifications
    const notifications = await currentBrowserPage.evaluate((maxNotifs: number, unreadOnlyFilter: boolean) => {
      const results: Array<{ index: number; text: string; time: string; unread: boolean }> = [];

      // Try multiple selectors for notifications
      const notifSelectors = [
        '[role="listitem"]',
        '[data-testid="notification"]',
        'div[class*="notification"]',
        'a[href*="/notifications"]',
      ];

      let notifElements: NodeListOf<Element> | null = null;
      for (const selector of notifSelectors) {
        const els = document.querySelectorAll(selector);
        if (els.length > 0) {
          notifElements = els;
          break;
        }
      }

      if (!notifElements) return results;

      notifElements.forEach((el, idx) => {
        if (idx >= maxNotifs) return;

        const text = el.textContent?.substring(0, 200) || '';
        if (text.length < 10) return; // Skip empty items

        // Check if unread (usually has different background or badge)
        const isUnread = el.classList.contains('unread') ||
                         el.querySelector('[aria-label*="unread"]') !== null ||
                         el.getAttribute('data-unread') === 'true' ||
                         (el as HTMLElement).style.backgroundColor !== '';

        if (unreadOnlyFilter && !isUnread) return;

        // Try to extract time
        const timeEl = el.querySelector('abbr, time, [data-timestamp]');
        const time = timeEl?.textContent || timeEl?.getAttribute('title') || '';

        results.push({
          index: idx,
          text: text.replace(/\s+/g, ' ').trim(),
          time,
          unread: isUnread,
        });
      });

      return results;
    }, limit, unread_only);

    cachedNotifications = notifications;

    if (notifications.length === 0) {
      return '📭 Không có thông báo' + (unread_only ? ' chưa đọc' : '') + '.';
    }

    let response = `🔔 **${notifications.length} thông báo${unread_only ? ' chưa đọc' : ''}:**\n\n`;
    for (const notif of notifications) {
      const unreadMark = notif.unread ? '🔴 ' : '';
      response += `${unreadMark}**[${notif.index}]** ${notif.text.substring(0, 100)}...\n`;
      if (notif.time) response += `   ⏰ ${notif.time}\n`;
      response += '\n';
    }

    response += `\n💡 Click vào thông báo bằng "click thông báo số [index]"`;
    return response;

  } catch (e: any) {
    return `❌ Lỗi lấy thông báo: ${e.message}`;
  }
}

async function executeFacebookGetMessages(args: { limit?: number; unread_only?: boolean }): Promise<string> {
  if (!currentBrowserPage) {
    return '❌ Chưa mở Facebook. Dùng "mở facebook" trước.';
  }

  const { limit = 10, unread_only = false } = args;

  try {
    // Click Messenger icon or navigate to Messenger
    const clickedMsg = await currentBrowserPage.evaluate(() => {
      const msgBtn = document.querySelector('[aria-label*="Messenger"], [aria-label*="Chat"]');
      if (msgBtn) {
        (msgBtn as HTMLElement).click();
        return true;
      }
      return false;
    });

    if (!clickedMsg) {
      await currentBrowserPage.goto('https://www.facebook.com/messages', { waitUntil: 'domcontentloaded' });
    }

    await new Promise(r => setTimeout(r, 2000));

    // Get messages/conversations
    const messages = await currentBrowserPage.evaluate((maxMsgs: number, unreadOnlyFilter: boolean) => {
      const results: Array<{ index: number; name: string; lastMessage: string; time: string; unread: boolean }> = [];

      // Messenger conversation selectors
      const convSelectors = [
        '[role="row"]',
        '[data-testid="mwthreadlist-item"]',
        'a[href*="/messages/t/"]',
        'div[class*="conversation"]',
      ];

      let convElements: NodeListOf<Element> | null = null;
      for (const selector of convSelectors) {
        const els = document.querySelectorAll(selector);
        if (els.length > 0) {
          convElements = els;
          break;
        }
      }

      if (!convElements) return results;

      convElements.forEach((el, idx) => {
        if (idx >= maxMsgs) return;

        const text = el.textContent || '';
        if (text.length < 5) return;

        // Try to extract name (usually first strong/link)
        const nameEl = el.querySelector('strong, span[dir="auto"]');
        const name = nameEl?.textContent?.substring(0, 50) || 'Unknown';

        // Check if unread
        const isUnread = el.classList.contains('unread') ||
                         el.querySelector('[data-testid="unread-indicator"]') !== null ||
                         el.querySelector('.unread') !== null;

        if (unreadOnlyFilter && !isUnread) return;

        // Get last message and time
        const allText = text.replace(name, '').trim();
        const lastMessage = allText.substring(0, 100);

        results.push({
          index: idx,
          name,
          lastMessage,
          time: '', // Time extraction varies by UI
          unread: isUnread,
        });
      });

      return results;
    }, limit, unread_only);

    cachedMessages = messages;

    if (messages.length === 0) {
      return '📭 Không có tin nhắn' + (unread_only ? ' chưa đọc' : '') + '.';
    }

    let response = `💬 **${messages.length} cuộc trò chuyện${unread_only ? ' chưa đọc' : ''}:**\n\n`;
    for (const msg of messages) {
      const unreadMark = msg.unread ? '🔴 ' : '';
      response += `${unreadMark}**[${msg.index}]** ${msg.name}\n`;
      response += `   💬 ${msg.lastMessage.substring(0, 80)}...\n\n`;
    }

    response += `\n💡 Nói "trả lời tin nhắn số [index] là [nội dung]" để reply.`;
    return response;

  } catch (e: any) {
    return `❌ Lỗi lấy tin nhắn: ${e.message}`;
  }
}

async function executeFacebookReplyMessage(args: {
  conversation_index: number;
  message: string;
  submit?: boolean;
}): Promise<string> {
  if (!currentBrowserPage) {
    return '❌ Chưa mở Facebook. Dùng "mở facebook" trước.';
  }

  const { conversation_index, message, submit = false } = args;

  try {
    // Click on the conversation
    const clicked = await currentBrowserPage.evaluate((idx: number) => {
      const convSelectors = ['[role="row"]', '[data-testid="mwthreadlist-item"]', 'a[href*="/messages/t/"]'];

      for (const selector of convSelectors) {
        const els = document.querySelectorAll(selector);
        if (els[idx]) {
          (els[idx] as HTMLElement).click();
          return true;
        }
      }
      return false;
    }, conversation_index);

    if (!clicked) {
      return `❌ Không tìm thấy cuộc trò chuyện [${conversation_index}].`;
    }

    await new Promise(r => setTimeout(r, 1500));

    // Find message input and type
    const textboxFound = await currentBrowserPage.evaluate(() => {
      const input = document.querySelector('[aria-label*="Message"], [aria-label*="Tin nhắn"], [contenteditable="true"]');
      if (input) {
        (input as HTMLElement).focus();
        return true;
      }
      return false;
    });

    if (!textboxFound) {
      return `❌ Không tìm thấy ô nhập tin nhắn.`;
    }

    await currentBrowserPage.keyboard.type(message, { delay: 30 });

    if (submit) {
      await currentBrowserPage.keyboard.press('Enter');
      await new Promise(r => setTimeout(r, 1000));
      return `✅ Đã gửi tin nhắn "${message}" đến cuộc trò chuyện [${conversation_index}]!`;
    }

    return `✅ Đã nhập tin nhắn "${message}".\n\n💡 Nói "gửi đi" để gửi tin nhắn.`;

  } catch (e: any) {
    return `❌ Lỗi trả lời tin nhắn: ${e.message}`;
  }
}

async function executeFacebookSearch(args: { query: string; filter?: string }): Promise<string> {
  if (!currentBrowserPage) {
    return '❌ Chưa mở Facebook. Dùng "mở facebook" trước.';
  }

  const { query, filter = 'all' } = args;

  try {
    // Click search box
    const clickedSearch = await currentBrowserPage.evaluate(() => {
      const searchBox = document.querySelector('[aria-label*="Search"], [aria-label*="Tìm kiếm"], [placeholder*="Search"]');
      if (searchBox) {
        (searchBox as HTMLElement).click();
        return true;
      }
      return false;
    });

    if (!clickedSearch) {
      // Navigate directly to search
      await currentBrowserPage.goto(`https://www.facebook.com/search/top?q=${encodeURIComponent(query)}`, {
        waitUntil: 'domcontentloaded',
      });
    } else {
      await new Promise(r => setTimeout(r, 500));
      await currentBrowserPage.keyboard.type(query, { delay: 30 });
      await currentBrowserPage.keyboard.press('Enter');
    }

    await new Promise(r => setTimeout(r, 2500));

    // Apply filter if specified
    if (filter !== 'all') {
      const filterMap: Record<string, string> = {
        'posts': '/posts',
        'people': '/people',
        'pages': '/pages',
        'groups': '/groups',
        'photos': '/photos',
        'videos': '/videos',
      };

      if (filterMap[filter]) {
        const currentUrl = currentBrowserPage.url();
        const baseUrl = currentUrl.split('?')[0].replace(/\/top$/, '');
        await currentBrowserPage.goto(`${baseUrl}${filterMap[filter]}?q=${encodeURIComponent(query)}`, {
          waitUntil: 'domcontentloaded',
        });
        await new Promise(r => setTimeout(r, 2000));
      }
    }

    // Get search results
    const results = await currentBrowserPage.evaluate((maxResults: number) => {
      const items: string[] = [];

      // Common result selectors
      const resultEls = document.querySelectorAll('[role="article"], [data-testid="search-result"], .search-result');

      resultEls.forEach((el, idx) => {
        if (idx >= maxResults) return;
        const text = el.textContent?.substring(0, 200) || '';
        if (text.length > 10) {
          items.push(text.replace(/\s+/g, ' ').trim());
        }
      });

      return items;
    }, 10);

    if (results.length === 0) {
      return `🔍 Không tìm thấy kết quả cho "${query}"${filter !== 'all' ? ` (filter: ${filter})` : ''}.`;
    }

    let response = `🔍 **Kết quả tìm kiếm "${query}"${filter !== 'all' ? ` (${filter})` : ''}:**\n\n`;
    results.forEach((result: string, idx: number) => {
      response += `**[${idx}]** ${result.substring(0, 150)}...\n\n`;
    });

    response += `\n💡 Click vào kết quả bằng "click số [index]"`;
    return response;

  } catch (e: any) {
    return `❌ Lỗi tìm kiếm: ${e.message}`;
  }
}

// Alias functions that map old browser_* names to facebook_* for backward compatibility
const executeFacebookGetPosts = executeBrowserGetPosts;
const executeFacebookFindPosts = executeBrowserFindPostsByTopic;
const executeFacebookComment = executeBrowserCommentOnPost;

// =============================================
// MEDIA ANALYSIS TOOLS
// =============================================

// Extract frames from video using ffmpeg
async function extractVideoFrames(videoPath: string, frameCount: number = 5): Promise<string[]> {
  const tempDir = path.join(app.getPath('temp'), 'video-frames');
  if (!fs.existsSync(tempDir)) {
    fs.mkdirSync(tempDir, { recursive: true });
  }

  const outputPattern = path.join(tempDir, `frame_${Date.now()}_%03d.jpg`);

  return new Promise((resolve, reject) => {
    // Get video duration first
    const ffprobe = spawn('ffprobe', [
      '-v', 'error',
      '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1',
      videoPath,
    ]);

    let duration = '';
    ffprobe.stdout.on('data', (data) => {
      duration += data.toString();
    });

    ffprobe.on('close', (code) => {
      if (code !== 0) {
        // Fallback: extract every 2 seconds
        const ffmpeg = spawn('ffmpeg', [
          '-i', videoPath,
          '-vf', `fps=1/${Math.ceil(10 / frameCount)}`,
          '-frames:v', frameCount.toString(),
          '-q:v', '2',
          outputPattern,
        ]);

        ffmpeg.on('close', (code2) => {
          if (code2 !== 0) {
            reject(new Error('FFmpeg failed to extract frames'));
            return;
          }

          const frames: string[] = [];
          for (let i = 1; i <= frameCount; i++) {
            const framePath = outputPattern.replace('%03d', i.toString().padStart(3, '0'));
            if (fs.existsSync(framePath)) {
              frames.push(framePath);
            }
          }
          resolve(frames);
        });
        return;
      }

      const durationSec = parseFloat(duration.trim()) || 30;
      const interval = durationSec / (frameCount + 1);

      // Extract frames at intervals
      const ffmpeg = spawn('ffmpeg', [
        '-i', videoPath,
        '-vf', `select=not(mod(n\\,${Math.floor(interval * 30)}))`,
        '-frames:v', frameCount.toString(),
        '-q:v', '2',
        '-vsync', 'vfr',
        outputPattern,
      ]);

      ffmpeg.on('close', () => {
        const frames: string[] = [];
        for (let i = 1; i <= frameCount; i++) {
          const framePath = outputPattern.replace('%03d', i.toString().padStart(3, '0'));
          if (fs.existsSync(framePath)) {
            frames.push(framePath);
          }
        }
        resolve(frames);
      });
    });
  });
}

// Analyze image using OpenAI Vision or local model
async function analyzeImageWithVision(imagePath: string, prompt: string): Promise<string> {
  try {
    // Read image as base64
    const imageBuffer = fs.readFileSync(imagePath);
    const base64Image = imageBuffer.toString('base64');
    const mimeType = imagePath.toLowerCase().endsWith('.png') ? 'image/png' : 'image/jpeg';

    // Use OpenAI Vision API
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      return '❌ Cần cấu hình OpenAI API key để phân tích ảnh.';
    }

    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: prompt },
              {
                type: 'image_url',
                image_url: {
                  url: `data:${mimeType};base64,${base64Image}`,
                },
              },
            ],
          },
        ],
        max_tokens: 500,
      }),
    });

    const data = await response.json() as any;
    if (data.choices && data.choices[0]?.message?.content) {
      return data.choices[0].message.content;
    }
    return '❌ Không thể phân tích ảnh.';
  } catch (e: any) {
    logger.error('[Vision] Error analyzing image:', e);
    return `❌ Lỗi phân tích ảnh: ${e.message}`;
  }
}

async function executeAnalyzeVideo(args: {
  video_path?: string;
  frame_count?: number;
  language?: string;
}): Promise<string> {
  const { frame_count = 5, language = 'vi' } = args;
  let videoPath = args.video_path;

  // Check for pending video attachment
  const pendingAttachments = getPendingAttachments();
  if (!videoPath && pendingAttachments) {
    const video = pendingAttachments.find(a => a.type === 'video');
    if (video) {
      videoPath = video.path;
      logger.info(`[Video] Using pending video: ${videoPath}`);
    }
  }

  if (!videoPath) {
    return '❌ Không có video để phân tích. Hãy kéo thả video vào chat hoặc cung cấp đường dẫn.';
  }

  if (!fs.existsSync(videoPath)) {
    return `❌ Không tìm thấy file video: ${videoPath}`;
  }

  try {
    logger.info(`[Video] Extracting ${frame_count} frames from ${videoPath}`);

    // Extract frames
    const frames = await extractVideoFrames(videoPath, Math.min(frame_count, 10));

    if (frames.length === 0) {
      return '❌ Không thể trích xuất frame từ video. Đảm bảo ffmpeg đã được cài đặt.';
    }

    logger.info(`[Video] Extracted ${frames.length} frames, analyzing...`);

    // Analyze each frame
    const langPrompt = language === 'pl'
      ? 'Opisz szczegółowo co widzisz na tym obrazku. Odpowiedz po polsku.'
      : language === 'en'
      ? 'Describe in detail what you see in this image.'
      : 'Mô tả chi tiết những gì bạn thấy trong hình ảnh này. Trả lời bằng tiếng Việt.';

    const analyses: string[] = [];
    for (let i = 0; i < frames.length; i++) {
      const analysis = await analyzeImageWithVision(frames[i], langPrompt);
      analyses.push(`**Scene ${i + 1}:** ${analysis}`);

      // Clean up frame file
      try { fs.unlinkSync(frames[i]); } catch (err: any) { logger.debug('[ZiraAI] delete video frame file failed:', err?.message); }
    }

    // Clear pending attachments
    clearPendingAttachments();

    const header = language === 'pl'
      ? `🎬 **Phân tích video (${frames.length} scenes):**\n\n`
      : language === 'en'
      ? `🎬 **Video Analysis (${frames.length} scenes):**\n\n`
      : `🎬 **Phân tích video (${frames.length} cảnh):**\n\n`;

    return header + analyses.join('\n\n');

  } catch (e: any) {
    logger.error('[Video] Analysis error:', e);
    return `❌ Lỗi phân tích video: ${e.message}`;
  }
}

async function executeAnalyzeImage(args: {
  image_path?: string;
  language?: string;
  style?: string;
  for_platform?: string;
}): Promise<string> {
  const { language = 'vi', style = 'casual', for_platform } = args;
  let imagePath = args.image_path;

  // Check for pending image attachment
  const pendingAttachments = getPendingAttachments();
  if (!imagePath && pendingAttachments) {
    const image = pendingAttachments.find(a => a.type === 'image');
    if (image) {
      imagePath = image.path;
      logger.info(`[Image] Using pending image: ${imagePath}`);
    }
  }

  if (!imagePath) {
    return '❌ Không có ảnh để phân tích. Hãy kéo thả ảnh vào chat hoặc cung cấp đường dẫn.';
  }

  if (!fs.existsSync(imagePath)) {
    return `❌ Không tìm thấy file ảnh: ${imagePath}`;
  }

  try {
    let prompt = '';

    if (for_platform) {
      prompt = language === 'pl'
        ? `Stwórz ${style} opis tego zdjęcia dla ${for_platform}. Odpowiedz po polsku.`
        : language === 'en'
        ? `Create a ${style} description of this image for ${for_platform}.`
        : `Tạo mô tả ${style} cho ảnh này để đăng ${for_platform}. Trả lời bằng tiếng Việt.`;
    } else {
      prompt = language === 'pl'
        ? `Opisz szczegółowo co widzisz na tym obrazku w stylu ${style}. Odpowiedz po polsku.`
        : language === 'en'
        ? `Describe in detail what you see in this image in a ${style} style.`
        : `Mô tả chi tiết những gì bạn thấy trong hình ảnh này theo phong cách ${style}. Trả lời bằng tiếng Việt.`;
    }

    const analysis = await analyzeImageWithVision(imagePath, prompt);

    // Clear pending attachments
    clearPendingAttachments();

    const header = language === 'pl'
      ? '🖼️ **Analiza obrazka:**\n\n'
      : language === 'en'
      ? '🖼️ **Image Analysis:**\n\n'
      : '🖼️ **Phân tích ảnh:**\n\n';

    return header + analysis;

  } catch (e: any) {
    logger.error('[Image] Analysis error:', e);
    return `❌ Lỗi phân tích ảnh: ${e.message}`;
  }
}

async function executeGeneratePostContent(args: {
  language?: string;
  platform?: string;
  tone?: string;
  include_hashtags?: boolean;
  max_length?: number;
}): Promise<string> {
  const {
    language = 'vi',
    platform = 'facebook',
    tone = 'casual',
    include_hashtags = true,
    max_length = platform === 'twitter' ? 280 : 2200,
  } = args;

  // Check for pending attachments
  const pendingAttachments = getPendingAttachments();

  if (!pendingAttachments || pendingAttachments.length === 0) {
    return '❌ Không có ảnh/video để tạo nội dung. Hãy kéo thả ảnh/video vào chat trước.';
  }

  const attachment = pendingAttachments[0];
  const mediaPath = attachment.path;

  if (!fs.existsSync(mediaPath)) {
    return '❌ File media không tồn tại.';
  }

  try {
    let prompt = '';

    if (language === 'pl') {
      prompt = `Stwórz ${tone} post na ${platform} opisujący to ${attachment.type === 'image' ? 'zdjęcie' : 'wideo'}.
Maksymalna długość: ${max_length} znaków.
${include_hashtags ? 'Dodaj odpowiednie hashtagi na końcu.' : 'Nie dodawaj hashtagów.'}
Odpowiedz tylko treścią posta, bez dodatkowych komentarzy.`;
    } else if (language === 'en') {
      prompt = `Create a ${tone} ${platform} post describing this ${attachment.type}.
Maximum length: ${max_length} characters.
${include_hashtags ? 'Include relevant hashtags at the end.' : 'Do not include hashtags.'}
Respond only with the post content, no additional commentary.`;
    } else {
      prompt = `Tạo bài đăng ${platform} theo phong cách ${tone} mô tả ${attachment.type === 'image' ? 'ảnh' : 'video'} này.
Độ dài tối đa: ${max_length} ký tự.
${include_hashtags ? 'Thêm hashtag phù hợp ở cuối.' : 'Không thêm hashtag.'}
Chỉ trả lời nội dung bài đăng, không thêm bình luận.`;
    }

    let content: string;

    if (attachment.type === 'image') {
      content = await analyzeImageWithVision(mediaPath, prompt);
    } else {
      // For video, analyze first frame
      const frames = await extractVideoFrames(mediaPath, 1);
      if (frames.length > 0) {
        content = await analyzeImageWithVision(frames[0], prompt);
        try { fs.unlinkSync(frames[0]); } catch (err: any) { logger.debug('[ZiraAI] delete video thumbnail file failed:', err?.message); }
      } else {
        return '❌ Không thể phân tích video để tạo nội dung.';
      }
    }

    // Store generated content for potential facebook_create_post
    setGeneratedPostContent(content);

    const header = language === 'pl'
      ? `✍️ **Wygenerowany post dla ${platform}:**\n\n`
      : language === 'en'
      ? `✍️ **Generated ${platform} post:**\n\n`
      : `✍️ **Nội dung đã tạo cho ${platform}:**\n\n`;

    return header + content + `\n\n💡 Nói "đăng đi" hoặc "post lên facebook" để đăng bài này.`;

  } catch (e: any) {
    logger.error('[PostGen] Error:', e);
    return `❌ Lỗi tạo nội dung: ${e.message}`;
  }
}

// =============================================
// MAIN TOOL EXECUTOR - Exported for hybrid mode
// =============================================

// Export tools definition for hybrid mode (server decides, client executes)
export { ZIRA_TOOLS };

// Export browser session status for context awareness
export function getBrowserSessionStatus(): {
  hasActivePage: boolean;
  currentUrl: string | null;
  cachedPostsCount: number;
} {
  return {
    hasActivePage: !!currentBrowserPage,
    currentUrl: currentBrowserPage ? currentBrowserPage.url?.() || null : null,
    cachedPostsCount: cachedPosts.length,
  };
}

// Export tool executor for hybrid mode
export async function executeTool(name: string, args: any): Promise<string> {
  logger.info(`[ZiraAI] Executing tool: ${name}`, args);

  switch (name) {
    // App & URL
    case 'open_chrome': return executeOpenChrome(args);
    case 'open_url': return executeOpenUrl(args);
    case 'open_application': return executeOpenApplication(args);
    case 'get_system_info': return executeGetSystemInfo();

    // Mouse
    case 'mouse_click': return executeMouseClick(args);
    case 'mouse_double_click': return executeMouseDoubleClick(args);
    case 'mouse_right_click': return executeMouseRightClick(args);
    case 'mouse_move': return executeMouseMove(args);
    case 'mouse_scroll': return executeMouseScroll(args);
    case 'mouse_drag': return executeMouseDrag(args);

    // Keyboard
    case 'keyboard_type': return executeKeyboardType(args);
    case 'keyboard_press': return executeKeyboardPress(args);
    case 'keyboard_hotkey': return executeKeyboardHotkey(args);

    // Screenshot
    case 'take_screenshot': return executeTakeScreenshot(args);

    // File
    case 'open_folder': return executeOpenFolder(args);
    // run_command REMOVED — RCE vulnerability

    // Booksy
    case 'booksy_get_bookings': return executeBooksyGetBookings(args);
    case 'booksy_get_status': return executeBooksyGetStatus();
    case 'booksy_get_customers': return executeBooksyGetCustomers();
    case 'booksy_get_staff': return executeBooksyGetStaff();
    case 'booksy_get_services': return executeBooksyGetServices();

    // Browser automation
    case 'browser_setup': return executeBrowserSetup(args);
    case 'select_chrome_profile': return executeSelectChromeProfile(args);
    case 'kill_chrome': return executeKillChrome();
    case 'browser_check_login': return executeBrowserCheckLogin();
    case 'browser_open_and_read': return executeBrowserOpenAndRead(args);
    case 'browser_screenshot': return executeBrowserScreenshot();
    case 'browser_scroll_and_read': return executeBrowserScrollAndRead(args);
    case 'browser_click': return executeBrowserClick(args);
    case 'browser_close': return executeBrowserClose();

    // Multi-step browser tools
    case 'browser_type': return executeBrowserType(args);
    case 'browser_get_posts': return executeBrowserGetPosts(args);
    case 'browser_find_posts_by_topic': return executeBrowserFindPostsByTopic(args);
    case 'browser_comment_on_post': return executeBrowserCommentOnPost(args);
    case 'browser_summarize': return executeBrowserSummarize(args);

    // Facebook-specific tools
    case 'facebook_create_post': return executeFacebookCreatePost(args);
    case 'facebook_like_post': return executeFacebookLikePost(args);
    case 'facebook_share_post': return executeFacebookSharePost(args);
    case 'facebook_get_notifications': return executeFacebookGetNotifications(args);
    case 'facebook_get_messages': return executeFacebookGetMessages(args);
    case 'facebook_reply_message': return executeFacebookReplyMessage(args);
    case 'facebook_search': return executeFacebookSearch(args);
    // Facebook tools (aliased from browser_*)
    case 'facebook_get_posts': return executeBrowserGetPosts(args);
    case 'facebook_find_posts': return executeBrowserFindPostsByTopic(args);
    case 'facebook_comment': return executeBrowserCommentOnPost(args);

    // Media analysis tools
    case 'analyze_video': return executeAnalyzeVideo(args);
    case 'analyze_image': return executeAnalyzeImage(args);
    case 'generate_post_content': return executeGeneratePostContent(args);

    default:
      return `❌ Tool không tồn tại: ${name}`;
  }
}

// Export helper for app.ts to check/handle profile selection
export function isPendingProfileSelection(): boolean {
  return pendingProfileSelection;
}

export async function handleProfileSelection(message: string): Promise<string | null> {
  const trimmed = message.trim().toLowerCase();
  const profiles = listChromeProfiles();
  const num = parseInt(trimmed);

  // Check if likely a profile selection
  const isLikely = !isNaN(num) && num >= 1 && num <= 9 && profiles.length > 1;
  
  if (pendingProfileSelection || isLikely) {
    let matchedProfile: ChromeProfile | undefined;

    if (!isNaN(num) && num >= 1 && num <= profiles.length) {
      matchedProfile = profiles[num - 1];
    } else {
      matchedProfile = profiles.find(p =>
        p.name.toLowerCase().includes(trimmed) ||
        p.directory.toLowerCase().includes(trimmed) ||
        trimmed.includes(p.name.toLowerCase())
      );
    }

    if (matchedProfile) {
      pendingProfileSelection = false;
      return await executeSelectChromeProfile({ profile: matchedProfile.directory });
    }
  }
  return null;
}

export interface ChatMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

export interface ChatResponse {
  content: string;
  model: string;
  provider?: AIProvider;
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
}

export interface ZiraAIOptions {
  apiKey: string;
  model?: string;
  maxTokens?: number;
  temperature?: number;
  systemPrompt?: string;
  provider?: AIProvider;
}

export class ZiraAI {
  private client: OpenAI;
  private model: string;
  private maxTokens: number;
  private temperature: number;
  private systemPrompt: string;
  private provider: AIProvider;
  private conversationHistory: Map<string, ChatMessage[]> = new Map();
  private totalTokensUsed: number = 0;

  constructor(options: ZiraAIOptions) {
    this.provider = options.provider || 'openrouter';

    // Configure client based on provider
    const clientConfig = this.getClientConfig(options.apiKey, this.provider);
    this.client = new OpenAI(clientConfig);

    this.model = options.model || 'x-ai/grok-4.1-fast';
    this.maxTokens = options.maxTokens || 1024;
    this.temperature = options.temperature || 0.7;

    // Use dynamic system prompt or custom
    this.systemPrompt = options.systemPrompt || getDefaultSystemPrompt();

    logger.info(`[ZiraAI] Initialized with model: ${this.model} (provider: ${this.provider})`);
  }
  
  // Bridge for App.ts to pass socket
  setExtensionSocket(ws: WebSocket | null) {
      setGlobalExtensionSocket(ws);
  }
  
  handleExtensionResponse(id: string, data: any) {
      handleGlobalExtensionResponse(id, data);
  }

  /**
   * Get client configuration based on provider
   */
  private getClientConfig(apiKey: string, provider: AIProvider): {
    apiKey: string;
    baseURL?: string;
    defaultHeaders?: Record<string, string>;
  } {
    switch (provider) {
      case 'openai':
        return { apiKey };
      case 'anthropic':
        return {
          apiKey,
          baseURL: 'https://api.anthropic.com/v1',
        };
      case 'google':
        return {
          apiKey,
          baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai',
        };
      case 'openrouter':
      default:
        return {
          apiKey,
          baseURL: 'https://openrouter.ai/api/v1',
          defaultHeaders: {
            'HTTP-Referer': 'https://enail.pro',
            'X-Title': 'Zira AI',
          },
        };
    }
  }

  /**
   * Send a chat message and get response
   */
  async chat(message: string, userId?: string): Promise<ChatResponse> {
    const conversationId = userId || 'default';

    // Auto-detect Chrome profile selection
    // If we're waiting for profile selection and user's message looks like a profile choice
    const trimmed = message.trim().toLowerCase();
    const profiles = listChromeProfiles();
    const num = parseInt(trimmed);

    logger.info(`[ZiraAI] === CHAT DEBUG ===`);
    logger.info(`[ZiraAI] message = "${message}", trimmed = "${trimmed}"`);
    logger.info(`[ZiraAI] pendingProfileSelection = ${pendingProfileSelection}`);
    logger.info(`[ZiraAI] profiles.length = ${profiles.length}`);
    logger.info(`[ZiraAI] parsed num = ${num}, isNaN = ${isNaN(num)}`);

    // If user types just a number 1-9 and we have multiple profiles, treat as profile selection
    const isLikelyProfileSelection = !isNaN(num) && num >= 1 && num <= 9 && profiles.length > 1;
    logger.info(`[ZiraAI] isLikelyProfileSelection = ${isLikelyProfileSelection}`);

    if (pendingProfileSelection || isLikelyProfileSelection) {
      logger.info(`[ZiraAI] >>> Entering profile selection logic <<<`);
      let matchedProfile: ChromeProfile | undefined;

      if (!isNaN(num) && num >= 1 && num <= profiles.length) {
        matchedProfile = profiles[num - 1];
      } else {
        // Try to match by name (case insensitive, partial match)
        matchedProfile = profiles.find(p =>
          p.name.toLowerCase().includes(trimmed) ||
          p.directory.toLowerCase().includes(trimmed) ||
          trimmed.includes(p.name.toLowerCase())
        );
      }

      if (matchedProfile) {
        // Auto-execute profile selection
        logger.info(`[ZiraAI] Auto-detected profile selection: ${matchedProfile.name}`);
        pendingProfileSelection = false; // Reset flag
        const result = await executeSelectChromeProfile({ profile: matchedProfile.directory });
        return {
          content: result,
          model: this.model,
          provider: this.provider,
        };
      }
    }

    // Get or create conversation history
    if (!this.conversationHistory.has(conversationId)) {
      this.conversationHistory.set(conversationId, []);
    }
    const history = this.conversationHistory.get(conversationId)!;

    // Add user message to history
    history.push({ role: 'user', content: message });

    // Keep only last 10 messages to manage context
    if (history.length > 10) {
      history.splice(0, history.length - 10);
    }

    // Build messages array
    const messages: OpenAI.ChatCompletionMessageParam[] = [
      { role: 'system', content: this.systemPrompt },
      ...history.map(m => ({ role: m.role as 'user' | 'assistant', content: m.content })),
    ];

    logger.info(`[ZiraAI] Sending message from user ${conversationId}: ${message.substring(0, 50)}...`);

    try {
      // First API call with tools
      const response = await this.client.chat.completions.create({
        model: this.model,
        messages,
        max_tokens: this.maxTokens,
        temperature: this.temperature,
        tools: ZIRA_TOOLS,
        tool_choice: 'auto',
      });

      let assistantMessage = response.choices[0]?.message?.content || '';
      const toolCalls = response.choices[0]?.message?.tool_calls;

      // Handle tool calls if any
      if (toolCalls && toolCalls.length > 0) {
        logger.info(`[ZiraAI] Tool calls detected: ${toolCalls.length}`);

        // Execute each tool and collect results
        const toolResults: string[] = [];
        for (const toolCall of toolCalls) {
          const toolName = toolCall.function.name;
          let toolArgs = {};
          try {
            toolArgs = JSON.parse(toolCall.function.arguments || '{}');
          } catch (err: any) { logger.debug('[ZiraAI] parse tool arguments failed:', err?.message); }

          const result = await executeTool(toolName, toolArgs);
          toolResults.push(result);
          logger.info(`[ZiraAI] Tool ${toolName} result: ${result}`);
        }

        // Add tool results to the conversation and get final response
        const toolResultsText = toolResults.join('\n');

        // Build messages with tool results
        const messagesWithTools: OpenAI.ChatCompletionMessageParam[] = [
          ...messages,
          {
            role: 'assistant',
            content: assistantMessage || null,
            tool_calls: toolCalls,
          } as any,
          {
            role: 'tool',
            tool_call_id: toolCalls[0].id,
            content: toolResultsText,
          } as any,
        ];

        // Get final response after tool execution
        const finalResponse = await this.client.chat.completions.create({
          model: this.model,
          messages: messagesWithTools,
          max_tokens: this.maxTokens,
          temperature: this.temperature,
        });

        assistantMessage = finalResponse.choices[0]?.message?.content || toolResultsText;

        // Track tokens from both calls
        if (response.usage?.total_tokens) {
          this.totalTokensUsed += response.usage.total_tokens;
        }
        if (finalResponse.usage?.total_tokens) {
          this.totalTokensUsed += finalResponse.usage.total_tokens;
        }
      } else {
        // No tool calls, just track tokens
        if (response.usage?.total_tokens) {
          this.totalTokensUsed += response.usage.total_tokens;
        }
      }

      // Fallback if no content
      if (!assistantMessage) {
        assistantMessage = 'Sorry, I could not generate a response.';
      }

      // Apply identity filter to replace Grok/xAI with Zira AI/eNail.pro
      assistantMessage = filterIdentity(assistantMessage);

      // Add assistant response to history
      history.push({ role: 'assistant', content: assistantMessage });

      logger.info(`[ZiraAI] Response received (total tokens used: ${this.totalTokensUsed})`);

      return {
        content: assistantMessage,
        model: response.model,
        provider: this.provider,
        usage: response.usage ? {
          promptTokens: response.usage.prompt_tokens,
          completionTokens: response.usage.completion_tokens,
          totalTokens: response.usage.total_tokens,
        } : undefined,
      };
    } catch (error: any) {
      logger.error('[ZiraAI] Chat error:', error);

      // Handle specific errors
      if (error.status === 401) {
        throw new Error('Invalid API key. Please check your OpenRouter API key.');
      } else if (error.status === 429) {
        throw new Error('Rate limited. Please try again later.');
      } else if (error.status === 500) {
        throw new Error('AI service temporarily unavailable.');
      }

      throw new Error(`AI error: ${error.message}`);
    }
  }

  /**
   * Clear conversation history for a user
   */
  clearHistory(userId?: string): void {
    const conversationId = userId || 'default';
    this.conversationHistory.delete(conversationId);
    logger.info(`[ZiraAI] Cleared history for: ${conversationId}`);
  }

  /**
   * Clear all conversation histories
   */
  clearAllHistory(): void {
    this.conversationHistory.clear();
    logger.info('[ZiraAI] Cleared all conversation histories');
  }

  /**
   * Get conversation history
   */
  getHistory(userId?: string): ChatMessage[] {
    const conversationId = userId || 'default';
    return this.conversationHistory.get(conversationId) || [];
  }

  /**
   * Update settings
   */
  updateSettings(options: Partial<ZiraAIOptions>): void {
    if (options.model) this.model = options.model;
    if (options.maxTokens) this.maxTokens = options.maxTokens;
    if (options.temperature) this.temperature = options.temperature;
    if (options.systemPrompt) this.systemPrompt = options.systemPrompt;
    logger.info('[ZiraAI] Settings updated');
  }

  /**
   * Get stats
   */
  getStats(): {
    conversationCount: number;
    totalTokensUsed: number;
    model: string;
    provider: AIProvider;
  } {
    return {
      conversationCount: this.conversationHistory.size,
      totalTokensUsed: this.totalTokensUsed,
      model: this.model,
      provider: this.provider,
    };
  }

  /**
   * Chat with context (moltbot-style)
   */
  async chatWithContext(
    message: string,
    context: {
      userId?: string;
      chatType?: string;
      chatTitle?: string;
      userName?: string;
      historyContext?: string;
    }
  ): Promise<ChatResponse> {
    const { userId, chatType, chatTitle, userName, historyContext } = context;

    // Build enhanced system prompt with context
    let enhancedPrompt = this.systemPrompt;

    if (chatType || userName) {
      enhancedPrompt += '\n\n---\n\n## Current Context\n';
      if (userName) {
        enhancedPrompt += `User: ${userName}\n`;
      }
      if (chatType) {
        enhancedPrompt += `Chat type: ${chatType}`;
        if (chatTitle) {
          enhancedPrompt += ` (${chatTitle})`;
        }
        enhancedPrompt += '\n';
      }
    }

    if (historyContext) {
      enhancedPrompt += '\n' + historyContext;
    }

    // Temporarily set enhanced prompt
    const originalPrompt = this.systemPrompt;
    this.systemPrompt = enhancedPrompt;

    try {
      return await this.chat(message, userId);
    } finally {
      // Restore original prompt
      this.systemPrompt = originalPrompt;
    }
  }

  /**
   * Destroy - cleanup
   */
  destroy(): void {
    this.conversationHistory.clear();
    this.totalTokensUsed = 0;
    logger.info('[ZiraAI] Destroyed');
  }
}
