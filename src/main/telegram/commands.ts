/**
 * Telegram Commands - Registers command handlers for the bot
 */

import { Bot, InputFile } from 'grammy';
import { app, shell } from 'electron';
import { ScreenCapturer } from '../remote/screen-capturer';
import { InputExecutor } from '../remote/input-executor';
import { BrowserController } from '../browser/browser-controller';
import { ZiraAI } from '../ai/zira-ai';
import { getConfigValue } from '../config/store';
import logger from '../logger';

// Printer functions interface
export interface PrinterFunctions {
  getPrintersStatus: () => Array<{ type: string; connected: boolean; protocol?: string; address?: string }>;
  testPrint: () => Promise<{ success: boolean; error?: string; results?: Record<string, boolean> }>;
  testPrinterByType: (type: string) => Promise<{ success: boolean; error?: string }>;
  openCashDrawer: (type?: string) => Promise<{ success: boolean; error?: string }>;
  printLabel: (barcode: string, text?: string) => Promise<{ success: boolean; error?: string }>;
}

export interface TelegramCommandsOptions {
  screenCapturer: ScreenCapturer;
  inputExecutor: InputExecutor;
  browserController?: BrowserController;
  ziraAI?: ZiraAI;
  printerFunctions?: PrinterFunctions;
}

/**
 * Register all command handlers on the bot
 */
export function registerCommands(bot: Bot, options: TelegramCommandsOptions): void {
  const { screenCapturer, inputExecutor, browserController, ziraAI, printerFunctions } = options;

  logger.info('[Telegram] Registering commands...');

  // /start - Welcome message
  bot.command('start', async (ctx) => {
    logger.info(`[Telegram] /start from user ${ctx.from?.id}`);
    const aiEnabled = getConfigValue('aiEnabled') || false;
    await ctx.reply(
      `🖥️ *eNail Remote Control*\n\n` +
      `Welcome! Control this computer via Telegram.\n\n` +
      `*Quick Commands:*\n` +
      `/screenshot - Capture screen\n` +
      `/status - System info\n` +
      `/click <x> <y> - Click\n` +
      `/type <text> - Type text\n` +
      `/hotkey <combo> - Press hotkey\n` +
      `/browse <url> - Open in browser\n` +
      `${aiEnabled ? `/ask <question> - Ask Zira AI\n` : ''}` +
      `/help - Full command list\n\n` +
      `_Input: ${getConfigValue('telegramEnableInput') ? '✅ Enabled' : '❌ Disabled'}_\n` +
      `_Browser: ${getConfigValue('telegramEnableBrowser') ? '✅ Enabled' : '❌ Disabled'}_\n` +
      `_Zira AI: ${aiEnabled ? '✅ Enabled' : '❌ Disabled'}_`,
      { parse_mode: 'Markdown' }
    );
  });

  // /help - Help message
  bot.command('help', async (ctx) => {
    logger.info(`[Telegram] /help from user ${ctx.from?.id}`);
    const inputEnabled = getConfigValue('telegramEnableInput') ? '✅' : '❌';
    const browserEnabled = getConfigValue('telegramEnableBrowser') ? '✅' : '❌';
    const aiEnabled = getConfigValue('aiEnabled') ? '✅' : '❌';

    await ctx.reply(
      `📖 *Help - eNail Remote Control*\n\n` +
      `*System Commands:*\n` +
      `• /status - System information\n` +
      `• /screenshot - Capture screen\n\n` +
      `*Keyboard Commands:* ${inputEnabled}\n` +
      `• /type <text> - Type text\n` +
      `• /key <key> - Press key (enter, f5, etc)\n` +
      `• /hotkey <combo> - Hotkey (ctrl+c, alt+tab)\n\n` +
      `*Mouse Commands:* ${inputEnabled}\n` +
      `• /click <x> <y> - Left click\n` +
      `• /doubleclick <x> <y> - Double click\n` +
      `• /rightclick <x> <y> - Right click\n` +
      `• /scroll <dir> [n] - Scroll (up/down/left/right)\n` +
      `• /drag <x1> <y1> <x2> <y2> - Drag\n\n` +
      `*Browser Commands:* ${browserEnabled}\n` +
      `• /open <url> - Open in default browser\n` +
      `• /browse <url> - Open in Playwright browser\n` +
      `• /bscreen - Screenshot browser\n` +
      `• /bclick <x> <y> - Click in browser\n` +
      `• /btype <text> - Type in browser\n` +
      `• /btabs - List browser tabs\n` +
      `• /bclose - Close browser\n\n` +
      `*Zira AI:* ${aiEnabled}\n` +
      `• /ask <question> - Ask Zira AI\n` +
      `• /clearai - Clear AI history\n\n` +
      `*Printer Commands:* 🖨️\n` +
      `• /printers - List printers status\n` +
      `• /testprint [type] - Test print\n` +
      `• /openbox - Open cash drawer\n` +
      `• /label <barcode> [text] - Print label\n\n` +
      `*Quick Examples:*\n` +
      `\`/screenshot\`\n` +
      `\`/click 500 300\`\n` +
      `\`/testprint RECEIPT\`\n` +
      `\`/label 1234567890128 Product Name\``,
      { parse_mode: 'Markdown' }
    );
  });

  // /status - System status
  bot.command('status', async (ctx) => {
    logger.info(`[Telegram] /status from user ${ctx.from?.id}`);

    const screenDims = screenCapturer.getScreenDimensions();
    const inputEnabled = getConfigValue('telegramEnableInput') || false;
    const browserEnabled = getConfigValue('telegramEnableBrowser') || false;

    const statusLines = [
      `📊 *Zira AI Status*\n`,
      `*Version:* ${app.getVersion()}`,
      `*Platform:* ${process.platform} ${process.arch}`,
      `*Screen:* ${screenDims.width}x${screenDims.height}`,
      ``,
      `*Features:*`,
      `• Input Control: ${inputEnabled ? '✅ Enabled' : '❌ Disabled'}`,
      `• Browser Control: ${browserEnabled ? '✅ Enabled' : '❌ Disabled'}`,
      `• Input Executor: ${inputExecutor.isInitialized() ? '✅ Ready' : '❌ Not Ready'}`,
    ];

    await ctx.reply(statusLines.join('\n'), { parse_mode: 'Markdown' });
  });

  // /screenshot - Take screenshot
  bot.command('screenshot', async (ctx) => {
    logger.info(`[Telegram] /screenshot from user ${ctx.from?.id}`);

    const statusMsg = await ctx.reply('📸 Capturing screen...');

    try {
      const buffer = await screenCapturer.takeScreenshot();

      // Send as photo
      await ctx.replyWithPhoto(new InputFile(buffer, 'screenshot.png'), {
        caption: `🖥️ Screenshot captured at ${new Date().toLocaleTimeString()}`,
      });

      // Delete status message
      await ctx.api.deleteMessage(ctx.chat.id, statusMsg.message_id).catch((e: any) => { logger.debug('[Telegram] delete status msg failed:', e?.message); });

      logger.info('[Telegram] Screenshot sent successfully');
    } catch (error: any) {
      logger.error('[Telegram] Screenshot failed:', error);
      await ctx.api.editMessageText(
        ctx.chat.id,
        statusMsg.message_id,
        `❌ Failed to capture screenshot: ${error.message}`
      );
    }
  });

  // /type <text> - Type text
  bot.command('type', async (ctx) => {
    const text = ctx.match;

    if (!text) {
      await ctx.reply(
        `⌨️ *Type Command*\n\n` +
        `Usage: \`/type <text>\`\n` +
        `Example: \`/type Hello World\``,
        { parse_mode: 'Markdown' }
      );
      return;
    }

    logger.info(`[Telegram] /type from user ${ctx.from?.id}: "${text.substring(0, 50)}..."`);

    // Check if input is enabled
    if (!getConfigValue('telegramEnableInput')) {
      await ctx.reply(
        `❌ *Input Disabled*\n\n` +
        `Enable "Input Control" in Print Agent settings to use this command.`,
        { parse_mode: 'Markdown' }
      );
      return;
    }

    // Check if input executor is ready
    if (!inputExecutor.isInitialized()) {
      await ctx.reply('❌ Input executor not available. Restart Print Agent.');
      return;
    }

    try {
      await inputExecutor.typeText(text);
      await ctx.reply(`⌨️ Typed: "${text.length > 50 ? text.substring(0, 50) + '...' : text}"`);
      logger.info('[Telegram] Type command executed');
    } catch (error: any) {
      logger.error('[Telegram] Type failed:', error);
      await ctx.reply(`❌ Failed to type: ${error.message}`);
    }
  });

  // /click <x> <y> - Click at position
  bot.command('click', async (ctx) => {
    const args = ctx.match?.split(/\s+/) || [];

    if (args.length < 2) {
      const screenDims = screenCapturer.getScreenDimensions();
      await ctx.reply(
        `🖱️ *Click Command*\n\n` +
        `Usage: \`/click <x> <y>\`\n` +
        `Example: \`/click 500 300\`\n\n` +
        `Screen size: ${screenDims.width}x${screenDims.height}`,
        { parse_mode: 'Markdown' }
      );
      return;
    }

    const x = parseInt(args[0], 10);
    const y = parseInt(args[1], 10);

    if (isNaN(x) || isNaN(y)) {
      await ctx.reply('❌ Invalid coordinates. Use numbers for x and y.');
      return;
    }

    logger.info(`[Telegram] /click from user ${ctx.from?.id}: (${x}, ${y})`);

    // Check if input is enabled
    if (!getConfigValue('telegramEnableInput')) {
      await ctx.reply(
        `❌ *Input Disabled*\n\n` +
        `Enable "Input Control" in Print Agent settings to use this command.`,
        { parse_mode: 'Markdown' }
      );
      return;
    }

    // Check if input executor is ready
    if (!inputExecutor.isInitialized()) {
      await ctx.reply('❌ Input executor not available. Restart Print Agent.');
      return;
    }

    // Validate coordinates
    const screenDims = screenCapturer.getScreenDimensions();
    if (x < 0 || x > screenDims.width || y < 0 || y > screenDims.height) {
      await ctx.reply(
        `❌ Coordinates out of bounds.\n` +
        `Screen: ${screenDims.width}x${screenDims.height}`
      );
      return;
    }

    try {
      await inputExecutor.clickAt(x, y);
      await ctx.reply(`🖱️ Clicked at (${x}, ${y})`);
      logger.info('[Telegram] Click command executed');
    } catch (error: any) {
      logger.error('[Telegram] Click failed:', error);
      await ctx.reply(`❌ Failed to click: ${error.message}`);
    }
  });

  // /open <url> - Open URL in browser
  bot.command('open', async (ctx) => {
    const url = ctx.match;

    if (!url) {
      await ctx.reply(
        `🌐 *Open URL Command*\n\n` +
        `Usage: \`/open <url>\`\n` +
        `Example: \`/open https://google.com\``,
        { parse_mode: 'Markdown' }
      );
      return;
    }

    logger.info(`[Telegram] /open from user ${ctx.from?.id}: ${url}`);

    // Check if browser control is enabled
    if (!getConfigValue('telegramEnableBrowser')) {
      await ctx.reply(
        `❌ *Browser Control Disabled*\n\n` +
        `Enable "Browser Control" in Print Agent settings to use this command.`,
        { parse_mode: 'Markdown' }
      );
      return;
    }

    // Basic URL validation
    let parsedUrl: URL;
    try {
      // Add https:// if no protocol
      const urlToOpen = url.startsWith('http') ? url : `https://${url}`;
      parsedUrl = new URL(urlToOpen);
    } catch {
      await ctx.reply('❌ Invalid URL format.');
      return;
    }

    try {
      await shell.openExternal(parsedUrl.href);
      await ctx.reply(`🌐 Opened: ${parsedUrl.href}`);
      logger.info('[Telegram] Open command executed');
    } catch (error: any) {
      logger.error('[Telegram] Open failed:', error);
      await ctx.reply(`❌ Failed to open URL: ${error.message}`);
    }
  });

  // /key <keyname> - Press a single key
  bot.command('key', async (ctx) => {
    const keyName = ctx.match?.trim();

    if (!keyName) {
      await ctx.reply(
        `⌨️ *Key Command*\n\n` +
        `Usage: \`/key <keyname>\`\n` +
        `Examples:\n` +
        `\`/key enter\` - Press Enter\n` +
        `\`/key escape\` - Press Escape\n` +
        `\`/key f5\` - Press F5\n` +
        `\`/key tab\` - Press Tab\n\n` +
        `*Available keys:* enter, escape, tab, space, backspace, delete, home, end, pageup, pagedown, f1-f12, up, down, left, right, a-z, 0-9`,
        { parse_mode: 'Markdown' }
      );
      return;
    }

    logger.info(`[Telegram] /key from user ${ctx.from?.id}: ${keyName}`);

    if (!getConfigValue('telegramEnableInput')) {
      await ctx.reply('❌ *Input Disabled*\n\nEnable "Input Control" in Print Agent settings.', { parse_mode: 'Markdown' });
      return;
    }

    if (!inputExecutor.isInitialized()) {
      await ctx.reply('❌ Input executor not available. Restart Print Agent.');
      return;
    }

    try {
      await inputExecutor.pressKey(keyName);
      await ctx.reply(`⌨️ Pressed: ${keyName.toUpperCase()}`);
      logger.info('[Telegram] Key command executed');
    } catch (error: any) {
      logger.error('[Telegram] Key failed:', error);
      await ctx.reply(`❌ Failed: ${error.message}`);
    }
  });

  // /hotkey <combo> - Press hotkey combination
  bot.command('hotkey', async (ctx) => {
    const combo = ctx.match?.trim();

    if (!combo) {
      await ctx.reply(
        `⌨️ *Hotkey Command*\n\n` +
        `Usage: \`/hotkey <key1+key2+...>\`\n` +
        `Examples:\n` +
        `\`/hotkey ctrl+c\` - Copy\n` +
        `\`/hotkey ctrl+v\` - Paste\n` +
        `\`/hotkey ctrl+z\` - Undo\n` +
        `\`/hotkey alt+tab\` - Switch window\n` +
        `\`/hotkey alt+f4\` - Close window\n` +
        `\`/hotkey win+d\` - Show desktop\n` +
        `\`/hotkey ctrl+shift+esc\` - Task Manager`,
        { parse_mode: 'Markdown' }
      );
      return;
    }

    logger.info(`[Telegram] /hotkey from user ${ctx.from?.id}: ${combo}`);

    if (!getConfigValue('telegramEnableInput')) {
      await ctx.reply('❌ *Input Disabled*\n\nEnable "Input Control" in Print Agent settings.', { parse_mode: 'Markdown' });
      return;
    }

    if (!inputExecutor.isInitialized()) {
      await ctx.reply('❌ Input executor not available. Restart Print Agent.');
      return;
    }

    try {
      const keys = combo.split('+').map(k => k.trim()).filter(k => k);
      await inputExecutor.pressHotkey(keys);
      await ctx.reply(`⌨️ Pressed: ${keys.map(k => k.toUpperCase()).join('+')}`);
      logger.info('[Telegram] Hotkey command executed');
    } catch (error: any) {
      logger.error('[Telegram] Hotkey failed:', error);
      await ctx.reply(`❌ Failed: ${error.message}`);
    }
  });

  // /scroll <direction> [amount] - Scroll
  bot.command('scroll', async (ctx) => {
    const args = ctx.match?.split(/\s+/) || [];

    if (args.length < 1 || !['up', 'down', 'left', 'right'].includes(args[0]?.toLowerCase())) {
      await ctx.reply(
        `🖱️ *Scroll Command*\n\n` +
        `Usage: \`/scroll <direction> [amount]\`\n` +
        `Examples:\n` +
        `\`/scroll down\` - Scroll down (default 3)\n` +
        `\`/scroll up 5\` - Scroll up 5 times\n` +
        `\`/scroll left 2\` - Scroll left 2 times\n\n` +
        `*Directions:* up, down, left, right`,
        { parse_mode: 'Markdown' }
      );
      return;
    }

    const direction = args[0].toLowerCase() as 'up' | 'down' | 'left' | 'right';
    const amount = parseInt(args[1], 10) || 3;

    logger.info(`[Telegram] /scroll from user ${ctx.from?.id}: ${direction} ${amount}`);

    if (!getConfigValue('telegramEnableInput')) {
      await ctx.reply('❌ *Input Disabled*\n\nEnable "Input Control" in Print Agent settings.', { parse_mode: 'Markdown' });
      return;
    }

    if (!inputExecutor.isInitialized()) {
      await ctx.reply('❌ Input executor not available. Restart Print Agent.');
      return;
    }

    try {
      await inputExecutor.scroll(direction, Math.min(amount, 20)); // Max 20 to prevent abuse
      await ctx.reply(`🖱️ Scrolled ${direction} ${amount}x`);
      logger.info('[Telegram] Scroll command executed');
    } catch (error: any) {
      logger.error('[Telegram] Scroll failed:', error);
      await ctx.reply(`❌ Failed: ${error.message}`);
    }
  });

  // /doubleclick <x> <y> - Double click
  bot.command('doubleclick', async (ctx) => {
    const args = ctx.match?.split(/\s+/) || [];

    if (args.length < 2) {
      const screenDims = screenCapturer.getScreenDimensions();
      await ctx.reply(
        `🖱️ *Double Click Command*\n\n` +
        `Usage: \`/doubleclick <x> <y>\`\n` +
        `Example: \`/doubleclick 500 300\`\n\n` +
        `Screen size: ${screenDims.width}x${screenDims.height}`,
        { parse_mode: 'Markdown' }
      );
      return;
    }

    const x = parseInt(args[0], 10);
    const y = parseInt(args[1], 10);

    if (isNaN(x) || isNaN(y)) {
      await ctx.reply('❌ Invalid coordinates. Use numbers for x and y.');
      return;
    }

    logger.info(`[Telegram] /doubleclick from user ${ctx.from?.id}: (${x}, ${y})`);

    if (!getConfigValue('telegramEnableInput')) {
      await ctx.reply('❌ *Input Disabled*\n\nEnable "Input Control" in Print Agent settings.', { parse_mode: 'Markdown' });
      return;
    }

    if (!inputExecutor.isInitialized()) {
      await ctx.reply('❌ Input executor not available. Restart Print Agent.');
      return;
    }

    const screenDims = screenCapturer.getScreenDimensions();
    if (x < 0 || x > screenDims.width || y < 0 || y > screenDims.height) {
      await ctx.reply(`❌ Coordinates out of bounds.\nScreen: ${screenDims.width}x${screenDims.height}`);
      return;
    }

    try {
      await inputExecutor.doubleClickAt(x, y);
      await ctx.reply(`🖱️ Double-clicked at (${x}, ${y})`);
      logger.info('[Telegram] Double click executed');
    } catch (error: any) {
      logger.error('[Telegram] Double click failed:', error);
      await ctx.reply(`❌ Failed: ${error.message}`);
    }
  });

  // /rightclick <x> <y> - Right click
  bot.command('rightclick', async (ctx) => {
    const args = ctx.match?.split(/\s+/) || [];

    if (args.length < 2) {
      const screenDims = screenCapturer.getScreenDimensions();
      await ctx.reply(
        `🖱️ *Right Click Command*\n\n` +
        `Usage: \`/rightclick <x> <y>\`\n` +
        `Example: \`/rightclick 500 300\`\n\n` +
        `Screen size: ${screenDims.width}x${screenDims.height}`,
        { parse_mode: 'Markdown' }
      );
      return;
    }

    const x = parseInt(args[0], 10);
    const y = parseInt(args[1], 10);

    if (isNaN(x) || isNaN(y)) {
      await ctx.reply('❌ Invalid coordinates. Use numbers for x and y.');
      return;
    }

    logger.info(`[Telegram] /rightclick from user ${ctx.from?.id}: (${x}, ${y})`);

    if (!getConfigValue('telegramEnableInput')) {
      await ctx.reply('❌ *Input Disabled*\n\nEnable "Input Control" in Print Agent settings.', { parse_mode: 'Markdown' });
      return;
    }

    if (!inputExecutor.isInitialized()) {
      await ctx.reply('❌ Input executor not available. Restart Print Agent.');
      return;
    }

    const screenDims = screenCapturer.getScreenDimensions();
    if (x < 0 || x > screenDims.width || y < 0 || y > screenDims.height) {
      await ctx.reply(`❌ Coordinates out of bounds.\nScreen: ${screenDims.width}x${screenDims.height}`);
      return;
    }

    try {
      await inputExecutor.rightClickAt(x, y);
      await ctx.reply(`🖱️ Right-clicked at (${x}, ${y})`);
      logger.info('[Telegram] Right click executed');
    } catch (error: any) {
      logger.error('[Telegram] Right click failed:', error);
      await ctx.reply(`❌ Failed: ${error.message}`);
    }
  });

  // /drag <x1> <y1> <x2> <y2> - Drag
  bot.command('drag', async (ctx) => {
    const args = ctx.match?.split(/\s+/) || [];

    if (args.length < 4) {
      const screenDims = screenCapturer.getScreenDimensions();
      await ctx.reply(
        `🖱️ *Drag Command*\n\n` +
        `Usage: \`/drag <x1> <y1> <x2> <y2>\`\n` +
        `Example: \`/drag 100 100 500 300\`\n\n` +
        `Drags from (x1,y1) to (x2,y2)\n` +
        `Screen size: ${screenDims.width}x${screenDims.height}`,
        { parse_mode: 'Markdown' }
      );
      return;
    }

    const x1 = parseInt(args[0], 10);
    const y1 = parseInt(args[1], 10);
    const x2 = parseInt(args[2], 10);
    const y2 = parseInt(args[3], 10);

    if (isNaN(x1) || isNaN(y1) || isNaN(x2) || isNaN(y2)) {
      await ctx.reply('❌ Invalid coordinates. All must be numbers.');
      return;
    }

    logger.info(`[Telegram] /drag from user ${ctx.from?.id}: (${x1},${y1}) -> (${x2},${y2})`);

    if (!getConfigValue('telegramEnableInput')) {
      await ctx.reply('❌ *Input Disabled*\n\nEnable "Input Control" in Print Agent settings.', { parse_mode: 'Markdown' });
      return;
    }

    if (!inputExecutor.isInitialized()) {
      await ctx.reply('❌ Input executor not available. Restart Print Agent.');
      return;
    }

    const screenDims = screenCapturer.getScreenDimensions();
    if (x1 < 0 || x1 > screenDims.width || y1 < 0 || y1 > screenDims.height ||
        x2 < 0 || x2 > screenDims.width || y2 < 0 || y2 > screenDims.height) {
      await ctx.reply(`❌ Coordinates out of bounds.\nScreen: ${screenDims.width}x${screenDims.height}`);
      return;
    }

    try {
      await inputExecutor.drag(x1, y1, x2, y2);
      await ctx.reply(`🖱️ Dragged from (${x1},${y1}) to (${x2},${y2})`);
      logger.info('[Telegram] Drag executed');
    } catch (error: any) {
      logger.error('[Telegram] Drag failed:', error);
      await ctx.reply(`❌ Failed: ${error.message}`);
    }
  });

  // ==========================================
  // Browser Control Commands (Playwright)
  // ==========================================

  // Track pending browse requests waiting for Chrome close confirmation
  const pendingBrowseRequests: Map<number, { url: string; chatId: number; messageId: number }> = new Map();

  // /browse <url> - Navigate to URL in Playwright browser
  bot.command('browse', async (ctx) => {
    const url = ctx.match;

    if (!url) {
      await ctx.reply(
        `🌐 *Browse Command*\n\n` +
        `Usage: \`/browse <url>\`\n` +
        `Example: \`/browse google.com\`\n\n` +
        `Opens URL in controlled Playwright browser.`,
        { parse_mode: 'Markdown' }
      );
      return;
    }

    logger.info(`[Telegram] /browse from user ${ctx.from?.id}: ${url}`);

    if (!getConfigValue('telegramEnableBrowser')) {
      await ctx.reply('❌ *Browser Control Disabled*\n\nEnable "Browser Control" in Print Agent settings.', { parse_mode: 'Markdown' });
      return;
    }

    if (!browserController) {
      await ctx.reply('❌ Browser controller not available.');
      return;
    }

    // Check if Chrome is running
    const { isChromeRunning, killChromeProcesses } = await import('../browser/chrome-checker');
    const chromeStatus = await isChromeRunning();

    if (chromeStatus.isRunning) {
      // Chrome is running - ask user if they want to close it
      const askMsg = await ctx.reply(
        `⚠️ *Chrome đang chạy*\n\n` +
        `Phát hiện ${chromeStatus.processCount} tiến trình Chrome đang hoạt động.\n\n` +
        `Tôi cần đóng Chrome để mở trình duyệt tự động với profile của bạn.\n\n` +
        `*Bạn có muốn đóng Chrome không?*`,
        {
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: [
              [
                { text: '✅ Đồng ý đóng Chrome', callback_data: `chrome_close_yes_${ctx.from?.id}` },
              ],
              [
                { text: '❌ Không, hủy bỏ', callback_data: `chrome_close_no_${ctx.from?.id}` },
              ],
            ],
          },
        }
      );

      // Store the pending request
      pendingBrowseRequests.set(ctx.from?.id || 0, {
        url,
        chatId: ctx.chat.id,
        messageId: askMsg.message_id,
      });

      return;
    }

    // Chrome not running - proceed directly
    const statusMsg = await ctx.reply('🌐 Opening browser...');

    try {
      const result = await browserController.navigate(url);
      await ctx.api.editMessageText(
        ctx.chat.id,
        statusMsg.message_id,
        `🌐 *Opened:* ${result.title}\n\n` +
        `Use /bscreen for screenshot, /bclick to click.`,
        { parse_mode: 'Markdown' }
      );
      logger.info('[Telegram] Browse command executed');
    } catch (error: any) {
      logger.error('[Telegram] Browse failed:', error);
      await ctx.api.editMessageText(ctx.chat.id, statusMsg.message_id, `❌ Failed: ${error.message}`);
    }
  });

  // Handle Chrome close confirmation callbacks
  bot.callbackQuery(/^chrome_close_(yes|no)_(\d+)$/, async (ctx) => {
    const match = ctx.callbackQuery.data?.match(/^chrome_close_(yes|no)_(\d+)$/);
    if (!match) return;

    const action = match[1];
    const userId = parseInt(match[2], 10);

    // Only allow the original user to respond
    if (ctx.from?.id !== userId) {
      await ctx.answerCallbackQuery({ text: 'Bạn không có quyền thao tác này.', show_alert: true });
      return;
    }

    const pendingRequest = pendingBrowseRequests.get(userId);
    if (!pendingRequest) {
      await ctx.answerCallbackQuery({ text: 'Yêu cầu đã hết hạn.', show_alert: true });
      return;
    }

    // Remove from pending
    pendingBrowseRequests.delete(userId);

    if (action === 'no') {
      // User cancelled
      await ctx.answerCallbackQuery({ text: 'Đã hủy.' });
      await ctx.api.editMessageText(
        pendingRequest.chatId,
        pendingRequest.messageId,
        '❌ *Đã hủy*\n\nBạn đã chọn không đóng Chrome.',
        { parse_mode: 'Markdown' }
      );
      return;
    }

    // User agreed to close Chrome
    await ctx.answerCallbackQuery({ text: 'Đang đóng Chrome...' });
    await ctx.api.editMessageText(
      pendingRequest.chatId,
      pendingRequest.messageId,
      '⏳ *Đang đóng Chrome...*',
      { parse_mode: 'Markdown' }
    );

    try {
      const { killChromeProcesses, isChromeRunning } = await import('../browser/chrome-checker');
      const killed = await killChromeProcesses();

      // Wait a moment for processes to terminate
      await new Promise(r => setTimeout(r, 1500));

      // Verify Chrome is closed
      const checkAgain = await isChromeRunning();
      if (checkAgain.isRunning) {
        await ctx.api.editMessageText(
          pendingRequest.chatId,
          pendingRequest.messageId,
          `❌ *Không thể đóng Chrome*\n\n` +
          `Vẫn còn ${checkAgain.processCount} tiến trình đang chạy.\n` +
          `Vui lòng đóng Chrome thủ công và thử lại.`,
          { parse_mode: 'Markdown' }
        );
        return;
      }

      // Chrome closed successfully - now open browser
      await ctx.api.editMessageText(
        pendingRequest.chatId,
        pendingRequest.messageId,
        '✅ *Chrome đã đóng*\n\n🌐 Đang mở trình duyệt...',
        { parse_mode: 'Markdown' }
      );

      if (!browserController) {
        await ctx.api.editMessageText(
          pendingRequest.chatId,
          pendingRequest.messageId,
          '❌ Browser controller not available.',
          { parse_mode: 'Markdown' }
        );
        return;
      }

      const result = await browserController.navigate(pendingRequest.url);
      await ctx.api.editMessageText(
        pendingRequest.chatId,
        pendingRequest.messageId,
        `🌐 *Opened:* ${result.title}\n\n` +
        `Use /bscreen for screenshot, /bclick to click.`,
        { parse_mode: 'Markdown' }
      );
      logger.info('[Telegram] Browse command executed after Chrome close');
    } catch (error: any) {
      logger.error('[Telegram] Browse after Chrome close failed:', error);
      await ctx.api.editMessageText(
        pendingRequest.chatId,
        pendingRequest.messageId,
        `❌ Failed: ${error.message}`,
        { parse_mode: 'Markdown' }
      );
    }
  });

  // /bscreen - Screenshot browser
  bot.command('bscreen', async (ctx) => {
    logger.info(`[Telegram] /bscreen from user ${ctx.from?.id}`);

    if (!getConfigValue('telegramEnableBrowser')) {
      await ctx.reply('❌ *Browser Control Disabled*', { parse_mode: 'Markdown' });
      return;
    }

    if (!browserController) {
      await ctx.reply('❌ Browser controller not available.');
      return;
    }

    if (!browserController.isRunning()) {
      await ctx.reply('❌ No browser open. Use /browse <url> first.');
      return;
    }

    const statusMsg = await ctx.reply('📸 Capturing browser...');

    try {
      const buffer = await browserController.screenshot();
      const pageInfo = await browserController.getPageInfo();

      await ctx.replyWithPhoto(new InputFile(buffer, 'browser.png'), {
        caption: `🌐 ${pageInfo.title}\n${pageInfo.url}`,
      });

      await ctx.api.deleteMessage(ctx.chat.id, statusMsg.message_id).catch((e: any) => { logger.debug('[Telegram] delete status msg failed:', e?.message); });
      logger.info('[Telegram] Browser screenshot sent');
    } catch (error: any) {
      logger.error('[Telegram] Browser screenshot failed:', error);
      await ctx.api.editMessageText(ctx.chat.id, statusMsg.message_id, `❌ Failed: ${error.message}`);
    }
  });

  // /bclick <x> <y> - Click in browser at position
  bot.command('bclick', async (ctx) => {
    const args = ctx.match?.split(/\s+/) || [];

    if (args.length < 2) {
      await ctx.reply(
        `🖱️ *Browser Click Command*\n\n` +
        `Usage: \`/bclick <x> <y>\`\n` +
        `Example: \`/bclick 500 300\``,
        { parse_mode: 'Markdown' }
      );
      return;
    }

    const x = parseInt(args[0], 10);
    const y = parseInt(args[1], 10);

    if (isNaN(x) || isNaN(y)) {
      await ctx.reply('❌ Invalid coordinates.');
      return;
    }

    logger.info(`[Telegram] /bclick from user ${ctx.from?.id}: (${x}, ${y})`);

    if (!getConfigValue('telegramEnableBrowser')) {
      await ctx.reply('❌ *Browser Control Disabled*', { parse_mode: 'Markdown' });
      return;
    }

    if (!browserController || !browserController.isRunning()) {
      await ctx.reply('❌ No browser open. Use /browse <url> first.');
      return;
    }

    try {
      await browserController.clickAt(x, y);
      await ctx.reply(`🖱️ Clicked at (${x}, ${y}) in browser`);
      logger.info('[Telegram] Browser click executed');
    } catch (error: any) {
      logger.error('[Telegram] Browser click failed:', error);
      await ctx.reply(`❌ Failed: ${error.message}`);
    }
  });

  // /btype <text> - Type text in browser
  bot.command('btype', async (ctx) => {
    const text = ctx.match;

    if (!text) {
      await ctx.reply(
        `⌨️ *Browser Type Command*\n\n` +
        `Usage: \`/btype <text>\`\n` +
        `Example: \`/btype Hello World\``,
        { parse_mode: 'Markdown' }
      );
      return;
    }

    logger.info(`[Telegram] /btype from user ${ctx.from?.id}: "${text.substring(0, 50)}..."`);

    if (!getConfigValue('telegramEnableBrowser')) {
      await ctx.reply('❌ *Browser Control Disabled*', { parse_mode: 'Markdown' });
      return;
    }

    if (!browserController || !browserController.isRunning()) {
      await ctx.reply('❌ No browser open. Use /browse <url> first.');
      return;
    }

    try {
      await browserController.typeText(text);
      await ctx.reply(`⌨️ Typed in browser: "${text.length > 50 ? text.substring(0, 50) + '...' : text}"`);
      logger.info('[Telegram] Browser type executed');
    } catch (error: any) {
      logger.error('[Telegram] Browser type failed:', error);
      await ctx.reply(`❌ Failed: ${error.message}`);
    }
  });

  // /btabs - List browser tabs
  bot.command('btabs', async (ctx) => {
    logger.info(`[Telegram] /btabs from user ${ctx.from?.id}`);

    if (!getConfigValue('telegramEnableBrowser')) {
      await ctx.reply('❌ *Browser Control Disabled*', { parse_mode: 'Markdown' });
      return;
    }

    if (!browserController) {
      await ctx.reply('❌ Browser controller not available.');
      return;
    }

    try {
      const tabs = await browserController.listTabs();

      if (tabs.length === 0) {
        await ctx.reply('📑 No tabs open. Use /browse <url> to open one.');
        return;
      }

      const tabList = tabs.map((t, i) => `${i + 1}. ${t.title}\n   ${t.url}`).join('\n\n');
      await ctx.reply(`📑 *Browser Tabs (${tabs.length}):*\n\n${tabList}`, { parse_mode: 'Markdown' });
      logger.info('[Telegram] Browser tabs listed');
    } catch (error: any) {
      logger.error('[Telegram] Browser tabs failed:', error);
      await ctx.reply(`❌ Failed: ${error.message}`);
    }
  });

  // /bclose - Close browser
  bot.command('bclose', async (ctx) => {
    logger.info(`[Telegram] /bclose from user ${ctx.from?.id}`);

    if (!getConfigValue('telegramEnableBrowser')) {
      await ctx.reply('❌ *Browser Control Disabled*', { parse_mode: 'Markdown' });
      return;
    }

    if (!browserController) {
      await ctx.reply('❌ Browser controller not available.');
      return;
    }

    try {
      await browserController.close();
      await ctx.reply('🌐 Browser closed.');
      logger.info('[Telegram] Browser closed');
    } catch (error: any) {
      logger.error('[Telegram] Browser close failed:', error);
      await ctx.reply(`❌ Failed: ${error.message}`);
    }
  });

  // ==========================================
  // Zira AI Commands
  // ==========================================

  // /ask <question> - Ask Zira AI
  bot.command('ask', async (ctx) => {
    const question = ctx.match;

    if (!question) {
      await ctx.reply(
        `🤖 *Zira AI*\n\n` +
        `Usage: \`/ask <question>\`\n` +
        `Example: \`/ask What is the weather today?\`\n\n` +
        `Ask anything and Zira AI will respond!`,
        { parse_mode: 'Markdown' }
      );
      return;
    }

    logger.info(`[Telegram] /ask from user ${ctx.from?.id}: "${question.substring(0, 50)}..."`);

    if (!getConfigValue('aiEnabled')) {
      await ctx.reply('❌ *Zira AI Disabled*\n\nEnable "Zira AI" in Print Agent settings.', { parse_mode: 'Markdown' });
      return;
    }

    if (!ziraAI) {
      await ctx.reply('❌ Zira AI not initialized. Check API key in settings.');
      return;
    }

    const statusMsg = await ctx.reply('🤖 Thinking...');

    try {
      const userId = ctx.from?.id?.toString();
      const response = await ziraAI.chat(question, userId);

      // Format response
      let reply = response.content;

      // Add token usage info if available
      if (response.usage) {
        reply += `\n\n_Tokens: ${response.usage.totalTokens}_`;
      }

      await ctx.api.editMessageText(ctx.chat.id, statusMsg.message_id, reply, { parse_mode: 'Markdown' });
      logger.info(`[Telegram] Zira AI responded (${response.usage?.totalTokens || 0} tokens)`);
    } catch (error: any) {
      logger.error('[Telegram] Zira AI failed:', error);
      await ctx.api.editMessageText(ctx.chat.id, statusMsg.message_id, `❌ AI Error: ${error.message}`);
    }
  });

  // /clearai - Clear AI conversation history
  bot.command('clearai', async (ctx) => {
    logger.info(`[Telegram] /clearai from user ${ctx.from?.id}`);

    if (!ziraAI) {
      await ctx.reply('❌ Zira AI not available.');
      return;
    }

    const userId = ctx.from?.id?.toString();
    ziraAI.clearHistory(userId);
    await ctx.reply('🧹 AI conversation history cleared.');
    logger.info('[Telegram] AI history cleared');
  });

  // ==========================================
  // Printer Commands
  // ==========================================

  // /printers - List printers and status
  bot.command('printers', async (ctx) => {
    logger.info(`[Telegram] /printers from user ${ctx.from?.id}`);

    if (!printerFunctions) {
      await ctx.reply('❌ Printer functions not available.');
      return;
    }

    try {
      const printers = printerFunctions.getPrintersStatus();

      if (printers.length === 0) {
        await ctx.reply('🖨️ *Printers*\n\nNo printers configured.', { parse_mode: 'Markdown' });
        return;
      }

      const lines = printers.map(p => {
        const status = p.connected ? '✅' : '❌';
        return `${status} *${p.type}*\n   ${p.protocol || 'N/A'} - ${p.address || 'N/A'}`;
      });

      await ctx.reply(
        `🖨️ *Printers Status*\n\n${lines.join('\n\n')}`,
        { parse_mode: 'Markdown' }
      );
      logger.info('[Telegram] Printers status sent');
    } catch (error: any) {
      logger.error('[Telegram] Printers failed:', error);
      await ctx.reply(`❌ Error: ${error.message}`);
    }
  });

  // /testprint [type] - Test print
  bot.command('testprint', async (ctx) => {
    const printerType = ctx.match?.trim().toUpperCase();
    logger.info(`[Telegram] /testprint from user ${ctx.from?.id}: ${printerType || 'ALL'}`);

    if (!printerFunctions) {
      await ctx.reply('❌ Printer functions not available.');
      return;
    }

    const statusMsg = await ctx.reply('🖨️ Printing test page...');

    try {
      let result: { success: boolean; error?: string; results?: Record<string, boolean> };

      if (printerType && ['RECEIPT', 'LABEL', 'A4', 'TICKET', 'KITCHEN'].includes(printerType)) {
        // Test specific printer
        result = await printerFunctions.testPrinterByType(printerType);
        if (result.success) {
          await ctx.api.editMessageText(ctx.chat.id, statusMsg.message_id, `✅ Test print sent to ${printerType}`);
        } else {
          await ctx.api.editMessageText(ctx.chat.id, statusMsg.message_id, `❌ ${printerType}: ${result.error}`);
        }
      } else {
        // Test all printers
        result = await printerFunctions.testPrint();
        if (result.success && result.results) {
          const lines = Object.entries(result.results)
            .map(([type, ok]) => `${ok ? '✅' : '❌'} ${type}`)
            .join('\n');
          await ctx.api.editMessageText(ctx.chat.id, statusMsg.message_id, `🖨️ *Test Print Results:*\n\n${lines}`, { parse_mode: 'Markdown' });
        } else {
          await ctx.api.editMessageText(ctx.chat.id, statusMsg.message_id, `❌ ${result.error || 'No printers available'}`);
        }
      }
      logger.info('[Telegram] Test print completed');
    } catch (error: any) {
      logger.error('[Telegram] Test print failed:', error);
      await ctx.api.editMessageText(ctx.chat.id, statusMsg.message_id, `❌ Error: ${error.message}`);
    }
  });

  // /openbox - Open cash drawer
  bot.command('openbox', async (ctx) => {
    logger.info(`[Telegram] /openbox from user ${ctx.from?.id}`);

    if (!printerFunctions) {
      await ctx.reply('❌ Printer functions not available.');
      return;
    }

    try {
      const result = await printerFunctions.openCashDrawer();
      if (result.success) {
        await ctx.reply('💰 Cash drawer opened!');
      } else {
        await ctx.reply(`❌ ${result.error}`);
      }
      logger.info('[Telegram] Cash drawer command completed');
    } catch (error: any) {
      logger.error('[Telegram] Open box failed:', error);
      await ctx.reply(`❌ Error: ${error.message}`);
    }
  });

  // /label <barcode> [text] - Print label
  bot.command('label', async (ctx) => {
    const args = ctx.match?.split(/\s+/) || [];

    if (args.length < 1 || !args[0]) {
      await ctx.reply(
        `🏷️ *Print Label Command*\n\n` +
        `Usage: \`/label <barcode> [text]\`\n` +
        `Examples:\n` +
        `\`/label 1234567890128\`\n` +
        `\`/label ABC123 Product Name\`\n` +
        `\`/label 5901234123457 Shampoo 500ml\``,
        { parse_mode: 'Markdown' }
      );
      return;
    }

    const barcode = args[0];
    const text = args.slice(1).join(' ') || undefined;

    logger.info(`[Telegram] /label from user ${ctx.from?.id}: ${barcode} - ${text || 'no text'}`);

    if (!printerFunctions) {
      await ctx.reply('❌ Printer functions not available.');
      return;
    }

    const statusMsg = await ctx.reply('🏷️ Printing label...');

    try {
      const result = await printerFunctions.printLabel(barcode, text);
      if (result.success) {
        await ctx.api.editMessageText(ctx.chat.id, statusMsg.message_id, `✅ Label printed: ${barcode}${text ? ` - ${text}` : ''}`);
      } else {
        await ctx.api.editMessageText(ctx.chat.id, statusMsg.message_id, `❌ ${result.error}`);
      }
      logger.info('[Telegram] Label print completed');
    } catch (error: any) {
      logger.error('[Telegram] Label print failed:', error);
      await ctx.api.editMessageText(ctx.chat.id, statusMsg.message_id, `❌ Error: ${error.message}`);
    }
  });

  // Handle unknown commands
  bot.on('message:text', async (ctx) => {
    const text = ctx.message.text;
    if (text.startsWith('/')) {
      await ctx.reply(
        `❓ Unknown command: ${text.split(' ')[0]}\n\n` +
        `Use /help to see available commands.`
      );
    }
  });

  logger.info('[Telegram] Commands registered');
}

// Export class for type reference
export class TelegramCommands {
  static register = registerCommands;
}
