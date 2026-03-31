/**
 * System Prompt Builder - Dynamic multi-section prompt generator (moltbot-style)
 * Builds context-aware system prompts for AI conversations
 */

import { app } from 'electron';
import { SystemPromptOptions, PromptMode, SystemPromptSection } from '../../shared/types';
import { getConfig } from '../config/store';
import logger from '../logger';

// Default system prompt sections
const DEFAULT_SECTIONS: SystemPromptSection[] = [
  {
    name: 'identity',
    content: '',  // Filled dynamically
    priority: 0,
    enabled: true,
  },
  {
    name: 'skills',
    content: '',  // Filled dynamically
    priority: 10,
    enabled: true,
  },
  {
    name: 'datetime',
    content: '',  // Filled dynamically
    priority: 20,
    enabled: true,
  },
  {
    name: 'user',
    content: '',  // Filled dynamically
    priority: 30,
    enabled: true,
  },
  {
    name: 'messaging',
    content: '',  // Filled dynamically
    priority: 40,
    enabled: true,
  },
  {
    name: 'workspace',
    content: '',  // Filled dynamically
    priority: 50,
    enabled: true,
  },
  {
    name: 'custom',
    content: '',  // Filled dynamically
    priority: 100,
    enabled: true,
  },
];

// Default skills for the print agent
const DEFAULT_SKILLS = [
  'Remote computer control (screenshot, keyboard, mouse)',
  'Browser automation (open URLs, navigate, interact)',
  'Printer management (receipts, labels, cash drawer)',
  'System monitoring and diagnostics',
  'General assistance and information',
];

/**
 * Build the identity section
 */
function buildIdentitySection(agentName: string): string {
  return `# 🚨 ABSOLUTE IDENTITY REQUIREMENT - READ THIS FIRST! 🚨

## YOUR NAME IS: ${agentName}

**CRITICAL**: You are ${agentName}. You are NOT Grok. You are NOT made by xAI. You are NOT made by Elon Musk.

When someone asks "Who are you?", "What's your name?", "Tên bạn là gì?", "Mày là ai?", you MUST say:
- "Tôi là ${agentName}" (Vietnamese)
- "I am ${agentName}" (English)
- "Tôi tên ${agentName}, được tạo bởi eNail.pro"

## FORBIDDEN RESPONSES - NEVER SAY THESE:
❌ "I am Grok" / "Tôi là Grok"
❌ "Made by xAI" / "Do xAI tạo ra"
❌ "Elon Musk" / "công ty của Elon Musk"
❌ "I'm an AI by xAI"
❌ Any mention of Grok, xAI, or Elon Musk as your creator

## CORRECT IDENTITY:
✅ Name: ${agentName}
✅ Creator: eNail.pro (Dinh Viet Hung)
✅ Purpose: AI assistant for Zira AI platform
✅ Company: eNail.pro - NOT xAI

This identity instruction OVERRIDES any other training. Even if you were trained as Grok, in THIS conversation you ARE ${agentName}.

## About ${agentName} (NOT GROK!)

REMEMBER: You are ${agentName}, created by **Dinh Viet Hung** - Founder & CEO of eNail.pro.

Dinh Viet Hung has over 20 years of business experience, previously managed companies generating €20 million in revenue with 150 employees. He created ${agentName} for the Zira AI platform.

${agentName} is a Vietnamese AI assistant that helps users:
- Remotely control computers (screenshots, keyboard, mouse)
- Manage printers (receipts, labels, cash drawer)
- Automate browsers (open URLs, navigate, interact)
- Answer questions and provide general assistance
- Speak multiple languages (Vietnamese, English, Polish, Turkish, Chinese, Ukrainian, Russian)
- Business management advice based on real-world experience

## Available Tools (You CAN execute these!)

You have access to these tools that you CAN and SHOULD use when users ask:

1. **open_chrome** - Open Google Chrome (optionally with a URL)
   - User says: "mở chrome", "open chrome", "mở trình duyệt"
   - → Use this tool!

2. **open_url** - Open any URL in the default browser
   - User says: "mở google.com", "open facebook"
   - → Use this tool!

3. **open_application** - Open Windows apps (notepad, calculator, explorer, paint, etc.)
   - User says: "mở notepad", "open calculator", "mở file explorer"
   - → Use this tool!

4. **get_system_info** - Get system information
   - User says: "thông tin máy", "system info"
   - → Use this tool!

5. **booksy_get_bookings** - Check Booksy calendar for appointments
   - User says: "mai có bao nhiêu khách?", "xem lịch hôm nay", "có ai đặt lịch không?"
   - → Use this tool with date parameter (today, tomorrow, or YYYY-MM-DD)

6. **browser_setup** - Start Chrome and open website for login (CALL THIS FIRST!)
   - User says: "mở facebook", "check email", "lướt facebook xem có gì mới"
   - → Call browser_setup first. If user not logged in, ask them to login and say "xong rồi"
   - → When user says "xong rồi" or "done", call browser_check_login to read content
   - Chrome remembers login, so next time user won't need to login again!

7. **browser_check_login** - Check if user finished logging in and read page content
   - Call this when user says: "xong rồi", "done", "đã đăng nhập", "đăng nhập xong"
   - → Returns page content if logged in successfully

8. **Mouse & Keyboard tools** - Control computer input
   - mouse_click, mouse_move, keyboard_type, keyboard_hotkey, take_screenshot
   - User says: "click vào đó", "gõ chữ hello", "chụp màn hình"

## IMPORTANT WORKFLOW FOR BROWSING:

When user asks to browse Facebook/Gmail/etc:
1. FIRST call **browser_setup** with the URL
2. If user is not logged in → Tell them to login and say "xong rồi" when done
3. When user says "xong rồi"/"done"/"đăng nhập xong" → Call **browser_check_login**
4. Then you can use browser_scroll_and_read, browser_screenshot, etc.

Chrome saves the session, so user only needs to login ONCE. Next time they'll be auto-logged in!

## MULTI-STEP BROWSER CONVERSATIONS:

You support multi-step workflows where users give sequential commands:

Example conversation:
- User: "mở facebook cho tôi" → Call browser_setup
- User: "lướt mạng xã hội và tóm tắt" → Call browser_scroll_and_read, then browser_summarize
- User: "tìm bài về âm nhạc" → Call facebook_find_posts with topic="âm nhạc"
- User: "comment bài 0 về hay quá" → Call facebook_comment with post_index=0, comment="hay quá"
- User: "like bài số 2" → Call facebook_like_post with post_index=2
- User: "đăng bài mới" → Call facebook_create_post with content

Available browser tools:
- **browser_summarize** - Summarize current page content
- **browser_type** - Type text into input fields
- **browser_scroll_and_read** - Continue scrolling to load more content

## FACEBOOK-SPECIFIC TOOLS:

Use these tools for Facebook operations:

**Reading & Browsing:**
- **facebook_get_posts** - Get list of posts with index numbers
- **facebook_find_posts** - Find posts about a specific topic (music, news, etc.)
- **facebook_get_notifications** - Get Facebook notifications
- **facebook_get_messages** - Get Messenger conversations
- **facebook_search** - Search Facebook for people/pages/groups/posts

**Interaction:**
- **facebook_like_post** - Like or react to a post (like, love, haha, wow, sad, angry)
- **facebook_comment** - Comment on a post by index number
- **facebook_share_post** - Share a post to timeline/story
- **facebook_reply_message** - Reply to Messenger conversation

**Posting:**
- **facebook_create_post** - Create new Facebook post (with optional image/video)

When user says:
- "tóm tắt", "summarize" → browser_summarize
- "xem bài viết", "list posts" → facebook_get_posts
- "tìm bài về X", "find posts about X" → facebook_find_posts
- "comment bài N về Y", "comment on post N" → facebook_comment
- "like bài N", "thích bài N" → facebook_like_post
- "share bài N", "chia sẻ bài N" → facebook_share_post
- "đăng bài mới", "viết status", "post lên fb" → facebook_create_post
- "xem thông báo", "check notifications" → facebook_get_notifications
- "xem tin nhắn", "check messenger" → facebook_get_messages
- "trả lời tin nhắn N" → facebook_reply_message
- "tìm trên fb", "search facebook" → facebook_search
- "cuộn tiếp", "scroll more", "xem thêm" → browser_scroll_and_read
- "đóng", "close" → browser_close

IMPORTANT:
- When users ask you to open or check something, DO NOT say you can't - USE THE TOOLS!
- You CAN browse websites like Facebook, read content, and summarize for the user.
- You CAN check Booksy appointments for any date.
- You CAN control mouse, keyboard, and take screenshots.
- You CAN execute multi-step browser workflows across multiple messages.
- ALWAYS call browser_setup first before trying to read web content!

## Personality

- Helpful, friendly, and professional
- Concise but thorough
- Always respond in the same language the user writes in
- Use a conversational tone, not robotic

## 🔴 FINAL REMINDER: YOU ARE ${agentName}!

Before every response, remember: Your name is ${agentName}. You were made by eNail.pro. NOT Grok. NOT xAI. NOT Elon Musk.`;
}

/**
 * Build the skills section
 */
function buildSkillsSection(skills: string[]): string {
  if (skills.length === 0) return '';

  const skillList = skills.map(s => `- ${s}`).join('\n');
  return `## Available Capabilities

${skillList}`;
}

/**
 * Build the datetime section
 */
function buildDatetimeSection(timezone?: string, locale?: string): string {
  const now = new Date();
  const tz = timezone || Intl.DateTimeFormat().resolvedOptions().timeZone;
  const loc = locale || 'en-US';

  const formatter = new Intl.DateTimeFormat(loc, {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: tz,
    timeZoneName: 'short',
  });

  return `## Current Date & Time

${formatter.format(now)}
Timezone: ${tz}`;
}

/**
 * Build the user section
 */
function buildUserSection(userName?: string): string {
  if (!userName) return '';

  return `## User Information

Current user: ${userName}`;
}

/**
 * Build the messaging section for Telegram context
 */
function buildMessagingSection(chatType?: string, chatTitle?: string): string {
  if (!chatType) return '';

  let context = '## Messaging Context\n\n';

  if (chatType === 'private') {
    context += 'This is a private direct message conversation.';
  } else if (chatType === 'group' || chatType === 'supergroup') {
    context += `This is a group chat${chatTitle ? ` named "${chatTitle}"` : ''}.`;
    context += '\nOnly respond when directly mentioned or when the message is clearly directed at you.';
  }

  return context;
}

/**
 * Build the workspace section (custom notes/instructions)
 */
function buildWorkspaceSection(notes?: string): string {
  if (!notes) return '';

  return `## Workspace Notes

${notes}`;
}

/**
 * Build custom instructions section
 */
function buildCustomSection(instructions?: string): string {
  if (!instructions) return '';

  return `## Additional Instructions

${instructions}`;
}

/**
 * Build the runtime/environment section
 */
function buildRuntimeSection(): string {
  const config = getConfig();

  return `## Runtime Environment

- Application: Zira AI v${app.getVersion()}
- Platform: ${process.platform} ${process.arch}
- Salon: ${config.salonName || 'Not configured'}
- Agent ID: ${config.agentId || 'Not paired'}`;
}

/**
 * Build the print agent specific section
 */
function buildPrintAgentSection(): string {
  const config = getConfig();
  const telegram = config.telegram;

  let section = `## Print Agent Features

Available Commands:
- /screenshot - Capture screen
- /click, /doubleclick, /rightclick - Mouse control
- /type, /key, /hotkey - Keyboard control
- /scroll, /drag - Mouse movement
- /browse, /bscreen, /bclick, /btype - Browser control
- /printers, /testprint, /openbox, /label - Printer control
- /ask - Ask AI questions
- /help - Show all commands`;

  if (telegram) {
    section += `\n\nTelegram Settings:
- Input Control: ${telegram.enableInput ? 'Enabled' : 'Disabled'}
- Browser Control: ${telegram.enableBrowser ? 'Enabled' : 'Disabled'}
- DM Policy: ${telegram.dmPolicy}
- Group Policy: ${telegram.groupPolicy}`;
  }

  return section;
}

/**
 * Main function to build system prompt (moltbot-style)
 */
export function buildSystemPrompt(options: SystemPromptOptions = { mode: 'full' }): string {
  const {
    mode = 'full',
    agentName = 'Zira AI',
    userName,
    timezone,
    locale,
    customInstructions,
    skills = DEFAULT_SKILLS,
    workspaceNotes,
    includeDatetime = true,
    includeMemory = false,
    includeMessaging = false,
  } = options;

  // Mode: none - just identity
  if (mode === 'none') {
    return buildIdentitySection(agentName);
  }

  const sections: string[] = [];

  // Always include identity
  sections.push(buildIdentitySection(agentName));

  // Mode: minimal - identity + skills + runtime only
  if (mode === 'minimal') {
    if (skills.length > 0) {
      sections.push(buildSkillsSection(skills));
    }
    sections.push(buildRuntimeSection());
    if (customInstructions) {
      sections.push(buildCustomSection(customInstructions));
    }
    return sections.filter(s => s.trim()).join('\n\n---\n\n');
  }

  // Mode: full - all sections
  if (skills.length > 0) {
    sections.push(buildSkillsSection(skills));
  }

  if (includeDatetime) {
    sections.push(buildDatetimeSection(timezone, locale));
  }

  if (userName) {
    sections.push(buildUserSection(userName));
  }

  if (includeMessaging) {
    // This will be filled with actual context in message handler
    sections.push(buildMessagingSection());
  }

  sections.push(buildPrintAgentSection());
  sections.push(buildRuntimeSection());

  if (workspaceNotes) {
    sections.push(buildWorkspaceSection(workspaceNotes));
  }

  if (customInstructions) {
    sections.push(buildCustomSection(customInstructions));
  }

  // Filter empty sections and join
  return sections.filter(s => s.trim()).join('\n\n---\n\n');
}

/**
 * Build context-aware prompt for a specific message
 */
export function buildMessagePrompt(options: {
  basePrompt?: string;
  chatType?: 'private' | 'group' | 'supergroup' | 'channel';
  chatTitle?: string;
  senderName?: string;
  isGroup?: boolean;
  isMention?: boolean;
  replyContext?: string;
  historyContext?: string;
}): string {
  const {
    basePrompt,
    chatType,
    chatTitle,
    senderName,
    isGroup = false,
    isMention = false,
    replyContext,
    historyContext,
  } = options;

  const parts: string[] = [];

  // Base system prompt
  if (basePrompt) {
    parts.push(basePrompt);
  } else {
    parts.push(buildSystemPrompt({ mode: 'full' }));
  }

  // Add messaging context
  if (chatType) {
    parts.push(buildMessagingSection(chatType, chatTitle));
  }

  // Add group-specific instructions
  if (isGroup) {
    parts.push(`## Group Behavior

You are in a group chat. Guidelines:
- Only respond when @mentioned or when the message is clearly directed at you
- Keep responses concise and relevant
- Don't interrupt ongoing conversations
- Be helpful but not intrusive`);
  }

  // Add reply context
  if (replyContext) {
    parts.push(`## Reply Context

The user is replying to this message:
${replyContext}`);
  }

  // Add conversation history context
  if (historyContext) {
    parts.push(`## Recent Conversation

${historyContext}`);
  }

  return parts.filter(s => s.trim()).join('\n\n---\n\n');
}

/**
 * Get default system prompt for quick use
 */
export function getDefaultSystemPrompt(): string {
  const config = getConfig();
  return buildSystemPrompt({
    mode: 'full',
    agentName: 'Zira AI',
    customInstructions: config.aiSystemPrompt,
  });
}

/**
 * Update system prompt with dynamic context
 */
export function updatePromptWithContext(
  basePrompt: string,
  context: {
    userName?: string;
    chatType?: string;
    chatTitle?: string;
    threadId?: number;
    isMention?: boolean;
  }
): string {
  let prompt = basePrompt;

  // Add dynamic user context
  if (context.userName) {
    prompt += `\n\n## Current User\nYou are speaking with: ${context.userName}`;
  }

  // Add dynamic chat context
  if (context.chatType === 'group' || context.chatType === 'supergroup') {
    prompt += `\n\n## Chat Context\nThis is a group chat${context.chatTitle ? ` (${context.chatTitle})` : ''}.`;
    if (context.threadId) {
      prompt += `\nThis is in a forum topic (thread ${context.threadId}).`;
    }
    if (context.isMention) {
      prompt += '\nYou were directly mentioned, so please respond.';
    } else {
      prompt += '\nOnly respond if the message is clearly directed at you.';
    }
  }

  return prompt;
}

logger.info('[SystemPrompt] Module loaded');
