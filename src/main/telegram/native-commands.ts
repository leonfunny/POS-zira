/**
 * Native Telegram Commands (moltbot-style)
 * Built-in commands for session management, configuration, and debugging
 */

import { Bot } from 'grammy';
import { app } from 'electron';
import { getConfig, setConfig, getConfigValue } from '../config/store';
import { clearHistory, getHistoryStats, exportHistory, getHistoryKey } from './history';
import {
  approvePairing,
  rejectPairing,
  getPendingPairings,
  addToAllowlist,
  removeFromAllowlist,
  configureGroup,
} from './access-control';
import { buildSystemPrompt, getDefaultSystemPrompt } from '../ai/system-prompt';
import logger from '../logger';

/**
 * Register native commands (moltbot-style)
 */
export function registerNativeCommands(bot: Bot): void {
  logger.info('[Telegram] Registering native commands...');

  // /reset - Clear conversation history
  bot.command('reset', async (ctx) => {
    const chatId = ctx.chat?.id;
    const chatType = ctx.chat?.type as 'private' | 'group' | 'supergroup' | 'channel';
    const threadId = ctx.message?.message_thread_id;
    const userId = ctx.from?.id;

    if (!chatId) return;

    clearHistory({ chatId, chatType, threadId, userId });

    await ctx.reply('🧹 Conversation history cleared.');
    logger.info(`[Telegram] History cleared by user ${userId} in chat ${chatId}`);
  });

  // /model [name] - Show or change AI model
  bot.command('model', async (ctx) => {
    const modelName = ctx.match?.trim();
    const config = getConfig();

    if (!modelName) {
      // Show current model
      await ctx.reply(
        `🤖 *AI Model Configuration*\n\n` +
        `Current model: \`${config.aiModel || 'x-ai/grok-4.1-fast'}\`\n` +
        `Provider: ${config.aiProvider || 'openrouter'}\n\n` +
        `To change: \`/model <model-name>\`\n\n` +
        `*Popular models:*\n` +
        `• \`x-ai/grok-4.1-fast\`\n` +
        `• \`anthropic/claude-3-haiku\`\n` +
        `• \`openai/gpt-4o-mini\`\n` +
        `• \`google/gemini-2.0-flash\``,
        { parse_mode: 'Markdown' }
      );
      return;
    }

    // Change model
    setConfig({ aiModel: modelName });
    await ctx.reply(`✅ Model changed to: \`${modelName}\``, { parse_mode: 'Markdown' });
    logger.info(`[Telegram] Model changed to ${modelName} by user ${ctx.from?.id}`);
  });

  // /context - Show current context/configuration
  bot.command('context', async (ctx) => {
    const config = getConfig();
    const telegram = config.telegram;
    const stats = getHistoryStats();

    const lines = [
      `📋 *Current Context*\n`,
      `*Session:*`,
      `• Chat ID: \`${ctx.chat?.id}\``,
      `• Chat Type: ${ctx.chat?.type}`,
      `• Thread ID: ${ctx.message?.message_thread_id || 'N/A'}`,
      `• Your ID: \`${ctx.from?.id}\``,
      ``,
      `*Agent:*`,
      `• Salon: ${config.salonName || 'Not configured'}`,
      `• Agent ID: ${config.agentId || 'Not paired'}`,
      `• Version: ${app.getVersion()}`,
      ``,
      `*History:*`,
      `• Active chats: ${stats.totalChats}`,
      `• Total messages: ${stats.totalMessages}`,
      ``,
      `*AI:*`,
      `• Model: ${config.aiModel || 'x-ai/grok-4.1-fast'}`,
      `• Enabled: ${config.aiEnabled ? 'Yes' : 'No'}`,
      ``,
      `*Telegram:*`,
      `• DM Policy: ${telegram?.dmPolicy || 'allowlist'}`,
      `• Group Policy: ${telegram?.groupPolicy || 'disabled'}`,
      `• Input: ${telegram?.enableInput ? 'Enabled' : 'Disabled'}`,
      `• Browser: ${telegram?.enableBrowser ? 'Enabled' : 'Disabled'}`,
    ];

    await ctx.reply(lines.join('\n'), { parse_mode: 'Markdown' });
  });

  // /memory - Show conversation history summary
  bot.command('memory', async (ctx) => {
    const chatId = ctx.chat?.id;
    const chatType = ctx.chat?.type as 'private' | 'group' | 'supergroup' | 'channel';
    const threadId = ctx.message?.message_thread_id;
    const userId = ctx.from?.id;

    if (!chatId) return;

    const history = exportHistory({ chatId, chatType, threadId, userId });

    if (history.length === 0) {
      await ctx.reply('📭 No conversation history yet.');
      return;
    }

    const stats = {
      total: history.length,
      user: history.filter(h => h.sender !== 'bot' && h.sender !== 'system').length,
      bot: history.filter(h => h.sender === 'bot').length,
      system: history.filter(h => h.sender === 'system').length,
    };

    const oldest = new Date(history[0].timestamp);
    const newest = new Date(history[history.length - 1].timestamp);

    // Get last 5 messages preview
    const preview = history.slice(-5).map(h => {
      const time = new Date(h.timestamp).toLocaleTimeString();
      const sender = h.sender === 'bot' ? '🤖' : h.sender === 'system' ? '⚙️' : '👤';
      const text = h.body.length > 50 ? h.body.substring(0, 50) + '...' : h.body;
      return `${sender} [${time}] ${text}`;
    }).join('\n');

    await ctx.reply(
      `📊 *Conversation Memory*\n\n` +
      `*Messages:* ${stats.total}\n` +
      `• User: ${stats.user}\n` +
      `• Bot: ${stats.bot}\n` +
      `• System: ${stats.system}\n\n` +
      `*Time Range:*\n` +
      `From: ${oldest.toLocaleString()}\n` +
      `To: ${newest.toLocaleString()}\n\n` +
      `*Recent Messages:*\n${preview}\n\n` +
      `Use /reset to clear history.`,
      { parse_mode: 'Markdown' }
    );
  });

  // /activation [mention|always] - Configure group mention requirement
  bot.command('activation', async (ctx) => {
    const chatType = ctx.chat?.type;
    const chatId = ctx.chat?.id;
    const mode = ctx.match?.trim().toLowerCase();

    if (chatType === 'private') {
      await ctx.reply('ℹ️ This command is only for group chats.');
      return;
    }

    if (!chatId) return;

    if (!mode || !['mention', 'always'].includes(mode)) {
      const config = getConfig();
      const groupConfig = config.telegram?.groups?.[chatId.toString()];
      const currentMode = groupConfig?.requireMention !== false ? 'mention' : 'always';

      await ctx.reply(
        `⚡ *Activation Mode*\n\n` +
        `Current: ${currentMode === 'mention' ? 'Require @mention' : 'Always respond'}\n\n` +
        `*Options:*\n` +
        `• \`/activation mention\` - Only respond when @mentioned\n` +
        `• \`/activation always\` - Respond to all messages`,
        { parse_mode: 'Markdown' }
      );
      return;
    }

    const requireMention = mode === 'mention';
    configureGroup(chatId, { requireMention });

    await ctx.reply(
      `✅ Activation mode set to: *${mode}*\n\n` +
      (requireMention
        ? 'I will only respond when @mentioned.'
        : 'I will respond to all messages.'),
      { parse_mode: 'Markdown' }
    );

    logger.info(`[Telegram] Group ${chatId} activation set to ${mode} by ${ctx.from?.id}`);
  });

  // /pairing - Manage pairing requests (admin only)
  bot.command('pairing', async (ctx) => {
    const action = ctx.match?.trim().split(/\s+/)[0]?.toLowerCase();
    const code = ctx.match?.trim().split(/\s+/)[1];

    // Check if user is in allowlist (admin)
    const config = getConfig();
    const allowFrom = config.telegram?.allowFrom || [];
    const isAdmin = allowFrom.includes(ctx.from?.id || 0);

    if (!isAdmin && allowFrom.length > 0) {
      await ctx.reply('❌ Only administrators can manage pairings.');
      return;
    }

    const pending = getPendingPairings();

    if (!action || action === 'list') {
      if (pending.length === 0) {
        await ctx.reply('📭 No pending pairing requests.');
        return;
      }

      const list = pending.map(p => {
        const expires = Math.round((p.expiresAt - Date.now()) / 1000 / 60);
        return `• \`${p.code}\` - ${p.username || p.firstName || p.userId} (${expires}m left)`;
      }).join('\n');

      await ctx.reply(
        `🔐 *Pending Pairing Requests*\n\n${list}\n\n` +
        `*Commands:*\n` +
        `• \`/pairing approve <code>\`\n` +
        `• \`/pairing reject <code>\``,
        { parse_mode: 'Markdown' }
      );
      return;
    }

    if (action === 'approve' && code) {
      const result = approvePairing(code);
      if (result.success) {
        await ctx.reply(`✅ Approved pairing for ${result.username || result.userId}`);
      } else {
        await ctx.reply(`❌ ${result.error}`);
      }
      return;
    }

    if (action === 'reject' && code) {
      if (rejectPairing(code)) {
        await ctx.reply(`✅ Rejected pairing code: ${code}`);
      } else {
        await ctx.reply('❌ Invalid pairing code.');
      }
      return;
    }

    await ctx.reply(
      `🔐 *Pairing Commands*\n\n` +
      `• \`/pairing\` or \`/pairing list\` - Show pending requests\n` +
      `• \`/pairing approve <code>\` - Approve a request\n` +
      `• \`/pairing reject <code>\` - Reject a request`,
      { parse_mode: 'Markdown' }
    );
  });

  // /allow <user_id or @username> - Add user to allowlist
  bot.command('allow', async (ctx) => {
    const target = ctx.match?.trim();

    if (!target) {
      await ctx.reply(
        `👤 *Allow User*\n\n` +
        `Usage: \`/allow <user_id or @username>\`\n` +
        `Example: \`/allow 123456789\`\n` +
        `Example: \`/allow @username\``,
        { parse_mode: 'Markdown' }
      );
      return;
    }

    // Check if admin
    const config = getConfig();
    const allowFrom = config.telegram?.allowFrom || [];
    const isAdmin = allowFrom.length === 0 || allowFrom.includes(ctx.from?.id || 0);

    if (!isAdmin) {
      await ctx.reply('❌ Only administrators can manage allowlist.');
      return;
    }

    if (addToAllowlist(target)) {
      await ctx.reply(`✅ Added ${target} to allowlist.`);
    } else {
      await ctx.reply(`ℹ️ ${target} is already in allowlist.`);
    }
  });

  // /deny <user_id or @username> - Remove user from allowlist
  bot.command('deny', async (ctx) => {
    const target = ctx.match?.trim();

    if (!target) {
      await ctx.reply(
        `🚫 *Deny User*\n\n` +
        `Usage: \`/deny <user_id or @username>\`\n` +
        `Example: \`/deny 123456789\``,
        { parse_mode: 'Markdown' }
      );
      return;
    }

    // Check if admin
    const config = getConfig();
    const allowFrom = config.telegram?.allowFrom || [];
    const isAdmin = allowFrom.length === 0 || allowFrom.includes(ctx.from?.id || 0);

    if (!isAdmin) {
      await ctx.reply('❌ Only administrators can manage allowlist.');
      return;
    }

    if (removeFromAllowlist(target)) {
      await ctx.reply(`✅ Removed ${target} from allowlist.`);
    } else {
      await ctx.reply(`ℹ️ ${target} was not in allowlist.`);
    }
  });

  // /prompt - Show current system prompt
  bot.command('prompt', async (ctx) => {
    const prompt = getDefaultSystemPrompt();

    // Truncate if too long
    const maxLen = 3500;
    let display = prompt;
    if (prompt.length > maxLen) {
      display = prompt.substring(0, maxLen) + '\n\n... (truncated)';
    }

    await ctx.reply(
      `📝 *Current System Prompt*\n\n` +
      `\`\`\`\n${display}\n\`\`\``,
      { parse_mode: 'Markdown' }
    );
  });

  // /config [key] [value] - View or set configuration
  bot.command('config', async (ctx) => {
    const args = ctx.match?.trim().split(/\s+/) || [];
    const key = args[0];
    const value = args.slice(1).join(' ');

    // Check if admin
    const config = getConfig();
    const allowFrom = config.telegram?.allowFrom || [];
    const isAdmin = allowFrom.length === 0 || allowFrom.includes(ctx.from?.id || 0);

    if (!isAdmin) {
      await ctx.reply('❌ Only administrators can manage configuration.');
      return;
    }

    if (!key) {
      // Show available config keys
      const telegram = config.telegram;
      await ctx.reply(
        `⚙️ *Configuration*\n\n` +
        `*Telegram:*\n` +
        `• dmPolicy: ${telegram?.dmPolicy || 'allowlist'}\n` +
        `• groupPolicy: ${telegram?.groupPolicy || 'disabled'}\n` +
        `• enableInput: ${telegram?.enableInput || false}\n` +
        `• enableBrowser: ${telegram?.enableBrowser || false}\n` +
        `• historyLimit: ${telegram?.historyLimit || 50}\n` +
        `• streamMode: ${telegram?.streamMode || 'off'}\n\n` +
        `*AI:*\n` +
        `• aiEnabled: ${config.aiEnabled || false}\n` +
        `• aiModel: ${config.aiModel || 'x-ai/grok-4.1-fast'}\n` +
        `• aiMaxTokens: ${config.aiMaxTokens || 1024}\n` +
        `• aiTemperature: ${config.aiTemperature || 0.7}\n\n` +
        `To set: \`/config <key> <value>\``,
        { parse_mode: 'Markdown' }
      );
      return;
    }

    if (!value) {
      await ctx.reply(`ℹ️ Current value of ${key}: \`${getConfigValue(key as any)}\``, { parse_mode: 'Markdown' });
      return;
    }

    // Set value (with type coercion)
    let parsedValue: any = value;
    if (value === 'true') parsedValue = true;
    else if (value === 'false') parsedValue = false;
    else if (!isNaN(Number(value))) parsedValue = Number(value);

    // Handle telegram nested config
    if (key.startsWith('telegram.')) {
      const telegramKey = key.replace('telegram.', '');
      const telegram = config.telegram || {
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
      (telegram as any)[telegramKey] = parsedValue;
      setConfig({ telegram });
    } else {
      setConfig({ [key]: parsedValue } as any);
    }

    await ctx.reply(`✅ Set ${key} = \`${parsedValue}\``, { parse_mode: 'Markdown' });
    logger.info(`[Telegram] Config ${key} set to ${parsedValue} by ${ctx.from?.id}`);
  });

  // /debug - Show debug information
  bot.command('debug', async (ctx) => {
    const config = getConfig();
    const stats = getHistoryStats();

    const lines = [
      `🔧 *Debug Information*`,
      ``,
      `*System:*`,
      `• Version: ${app.getVersion()}`,
      `• Platform: ${process.platform} ${process.arch}`,
      `• Node: ${process.version}`,
      `• Memory: ${Math.round(process.memoryUsage().heapUsed / 1024 / 1024)}MB`,
      ``,
      `*Telegram:*`,
      `• Chat ID: \`${ctx.chat?.id}\``,
      `• User ID: \`${ctx.from?.id}\``,
      `• Username: @${ctx.from?.username || 'N/A'}`,
      `• Chat Type: ${ctx.chat?.type}`,
      ``,
      `*History:*`,
      `• Active chats: ${stats.totalChats}`,
      `• Total messages: ${stats.totalMessages}`,
      `• LRU size: ${stats.lruSize}`,
      ``,
      `*Config:*`,
      `• Salon ID: ${config.salonId || 'N/A'}`,
      `• Agent ID: ${config.agentId || 'N/A'}`,
      `• AI Enabled: ${config.aiEnabled}`,
    ];

    await ctx.reply(lines.join('\n'), { parse_mode: 'Markdown' });
  });

  logger.info('[Telegram] Native commands registered');
}
