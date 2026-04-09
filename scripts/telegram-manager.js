#!/usr/bin/env node
/**
 * Kaia AI — Telegram Manager for Claude Code
 *
 * Lệnh Telegram:
 *   /claude   — Khởi động Claude Code qua kênh Telegram
 *   /discord  — Khởi động Claude Code qua kênh Discord
 *   /end      — Đóng session đang chạy
 *   /status   — Kiểm tra trạng thái
 *   /help     — Trợ giúp
 */

const TelegramBot = require('node-telegram-bot-api');
const { spawn, execSync } = require('child_process');
const fs   = require('fs');
const path = require('path');
const os   = require('os');

// ── Cấu hình ─────────────────────────────────────────────────────────────────
const TG_TOKEN  = process.env.TELEGRAM_BOT_TOKEN;
if (!TG_TOKEN) {
  console.error('[Manager] TELEGRAM_BOT_TOKEN env var is required.');
  process.exit(1);
}

const TG_STATE  = path.join(os.homedir(), '.claude', 'channels', 'telegram');
const DC_STATE  = path.join(os.homedir(), '.claude', 'channels', 'discord');

// Thêm Telegram user ID của bạn để bảo mật (lấy từ @userinfobot)
// Ví dụ: const ALLOWED_USERS = [123456789];
const ALLOWED_USERS = [];

// Proxy nếu ISP chặn Telegram (Discord thường không bị chặn)
// Ví dụ: const PROXY = 'socks5://127.0.0.1:1080';
const PROXY = process.env.HTTPS_PROXY || process.env.ALL_PROXY || null;
// ─────────────────────────────────────────────────────────────────────────────

// System prompt cho /end qua Telegram channel
const END_PROMPT_TG =
  'You are a remote Claude Code session accessed via Telegram. ' +
  'CRITICAL: When you receive a Telegram message that is exactly "/end", you MUST: ' +
  '(1) Use the Telegram reply tool to send: "Session Claude da dong. Go /claude de bat dau lai." ' +
  '(2) Use the Bash tool to run: touch "$HOME/.claude/channels/telegram/kill.flag" ' +
  '(3) Do nothing else — the manager will terminate this session automatically.';

// System prompt cho /end qua Discord channel
const END_PROMPT_DC =
  'You are a remote Claude Code session accessed via Discord. ' +
  'CRITICAL: When you receive a Discord message that is exactly "/end", you MUST: ' +
  '(1) Use the Discord reply tool to send: "Session Claude da dong. Go /discord de bat dau lai." ' +
  '(2) Use the Bash tool to run: touch "$HOME/.claude/channels/discord/kill.flag" ' +
  '(3) Do nothing else — the manager will terminate this session automatically.';

// ─────────────────────────────────────────────────────────────────────────────

[TG_STATE, DC_STATE].forEach(d => fs.mkdirSync(d, { recursive: true }));

let bot           = null;
let claudeProcess = null;
let activeChannel = null; // 'telegram' | 'discord'
let activeChatId  = null;
let killWatcher   = null;

// ── Helpers ──────────────────────────────────────────────────────────────────

function isAlive(proc) {
  if (!proc) return false;
  try { process.kill(proc.pid, 0); return true; } catch { return false; }
}

function killProcessTree(pid) {
  try {
    execSync(`taskkill /F /T /PID ${pid}`, { stdio: 'ignore' });
    console.log(`[Manager] Killed PID=${pid}`);
  } catch {
    try { process.kill(pid, 'SIGTERM'); } catch {}
  }
}

function cleanState(channel) {
  const dir = channel === 'discord' ? DC_STATE : TG_STATE;
  try { fs.unlinkSync(path.join(dir, 'kill.flag')); } catch {}
  try { fs.unlinkSync(path.join(dir, 'claude.pid')); } catch {}
}

function getKillFile(channel) {
  return path.join(channel === 'discord' ? DC_STATE : TG_STATE, 'kill.flag');
}

// ── Manager polling ──────────────────────────────────────────────────────────

function startPolling() {
  if (bot) {
    bot.removeAllListeners();
    bot.stopPolling({ cancel: true }).catch(() => {});
  }

  const requestOptions = { agentOptions: { rejectUnauthorized: false } };
  if (PROXY) {
    const { SocksProxyAgent } = require('socks-proxy-agent');
    const { HttpsProxyAgent } = require('https-proxy-agent');
    requestOptions.agent = PROXY.startsWith('socks')
      ? new SocksProxyAgent(PROXY)
      : new HttpsProxyAgent(PROXY);
    console.log(`[Manager] Proxy: ${PROXY}`);
  }

  bot = new TelegramBot(TG_TOKEN, { polling: true, request: requestOptions });

  bot.on('message', (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from?.id;
    const text   = (msg.text || '').trim();

    if (ALLOWED_USERS.length && !ALLOWED_USERS.includes(userId)) return;

    switch (text) {
      case '/claude':
        if (claudeProcess && isAlive(claudeProcess)) {
          bot.sendMessage(chatId,
            `⚠️ Session ${activeChannel === 'discord' ? 'Discord' : 'Telegram'} đang chạy.\nGõ /end để đóng trước.`);
        } else {
          activeChatId  = chatId;
          bot.sendMessage(chatId, '🚀 Đang khởi động Claude + Telegram channel...')
            .then(() => {
              bot.stopPolling({ cancel: true })
                 .then(()  => launchClaude(chatId, 'telegram'))
                 .catch(() => launchClaude(chatId, 'telegram'));
            });
        }
        break;

      case '/discord':
        if (claudeProcess && isAlive(claudeProcess)) {
          bot.sendMessage(chatId,
            `⚠️ Session ${activeChannel === 'discord' ? 'Discord' : 'Telegram'} đang chạy.\nGõ /end để đóng trước.`);
        } else {
          activeChatId  = chatId;
          bot.sendMessage(chatId, '🚀 Đang khởi động Claude + Discord channel...')
            .then(() => {
              bot.stopPolling({ cancel: true })
                 .then(()  => launchClaude(chatId, 'discord'))
                 .catch(() => launchClaude(chatId, 'discord'));
            });
        }
        break;

      case '/end':
        if (!claudeProcess || !isAlive(claudeProcess)) {
          bot.sendMessage(chatId, '⚠️ Không có session nào đang chạy.');
        } else {
          bot.sendMessage(chatId, '🛑 Đang đóng session...').then(() => {
            killProcessTree(claudeProcess.pid);
          });
        }
        break;

      case '/status':
        bot.sendMessage(chatId,
          claudeProcess && isAlive(claudeProcess)
            ? `✅ Claude đang chạy qua *${activeChannel}* (PID: ${claudeProcess.pid})`
            : '💤 Không có session.\n/claude — Telegram\n/discord — Discord',
          { parse_mode: 'Markdown' });
        break;

      case '/start':
      case '/help':
        bot.sendMessage(chatId,
          '🤖 *Kaia AI Manager*\n\n' +
          '/claude — Khởi động Claude qua Telegram\n' +
          '/discord — Khởi động Claude qua Discord\n' +
          '/end — Đóng session đang chạy\n' +
          '/status — Kiểm tra trạng thái\n\n' +
          '_Sau khi kết nối, ra lệnh trực tiếp qua kênh đó._',
          { parse_mode: 'Markdown' });
        break;
    }
  });

  bot.on('polling_error', (err) => {
    console.error('[Manager] Polling error:', err.code || err.message);
  });

  console.log('[Manager] Polling — chờ lệnh...');
}

// ── Claude session ───────────────────────────────────────────────────────────

function launchClaude(chatId, channel) {
  activeChannel = channel;
  cleanState(channel);

  const channelFlag = channel === 'discord'
    ? 'plugin:discord@claude-plugins-official'
    : 'plugin:telegram@claude-plugins-official';

  const endPrompt = channel === 'discord' ? END_PROMPT_DC : END_PROMPT_TG;

  console.log(`[Manager] Spawning Claude → ${channel}...`);

  claudeProcess = spawn('claude', [
    '--permission-mode', 'bypassPermissions',
    '--channels', channelFlag,
    '--append-system-prompt', endPrompt,
  ], { stdio: 'inherit', shell: true });

  const pidFile = path.join(channel === 'discord' ? DC_STATE : TG_STATE, 'claude.pid');
  fs.writeFileSync(pidFile, String(claudeProcess.pid));
  console.log(`[Manager] Claude PID=${claudeProcess.pid} channel=${channel}`);

  claudeProcess.on('error', (err) => {
    console.error('[Manager] Spawn error:', err.message);
    onClaudeExit(chatId, channel, `❌ Lỗi khởi động: ${err.message}`);
  });

  claudeProcess.on('exit', (code, signal) => {
    console.log(`[Manager] Claude exited code=${code} signal=${signal}`);
    onClaudeExit(chatId, channel, `✅ Session ${channel} đã đóng.`);
  });

  startKillWatcher(chatId, channel);
}

function startKillWatcher(chatId, channel) {
  if (killWatcher) { clearInterval(killWatcher); killWatcher = null; }
  const killFile = getKillFile(channel);

  killWatcher = setInterval(() => {
    if (!claudeProcess) { clearInterval(killWatcher); killWatcher = null; return; }

    if (fs.existsSync(killFile)) {
      console.log('[Manager] Kill flag — dừng Claude...');
      clearInterval(killWatcher); killWatcher = null;
      if (isAlive(claudeProcess)) killProcessTree(claudeProcess.pid);
      return;
    }

    if (!isAlive(claudeProcess)) {
      clearInterval(killWatcher); killWatcher = null;
    }
  }, 2000);
}

function onClaudeExit(chatId, channel, message) {
  if (killWatcher) { clearInterval(killWatcher); killWatcher = null; }
  cleanState(channel);
  claudeProcess = null;
  activeChannel = null;

  console.log('[Manager] Resume polling sau 4 giây...');
  setTimeout(() => {
    startPolling();
    setTimeout(() => {
      if (bot && chatId) {
        const hint = channel === 'discord'
          ? 'Gõ /discord để bắt đầu lại.'
          : 'Gõ /claude để bắt đầu lại.';
        bot.sendMessage(chatId, `${message}\n\n${hint}`).catch(() => {});
      }
    }, 1500);
  }, 4000);
}

// ── Khởi động ────────────────────────────────────────────────────────────────

cleanState('telegram');
cleanState('discord');
startPolling();

console.log('');
console.log('╔══════════════════════════════════════╗');
console.log('║     Kaia AI Manager — Telegram       ║');
console.log('║  /claude  → Claude + Telegram        ║');
console.log('║  /discord → Claude + Discord         ║');
console.log('║  Ctrl+C để thoát                     ║');
console.log('╚══════════════════════════════════════╝');
console.log('');

process.on('SIGINT',  () => { if (claudeProcess) killProcessTree(claudeProcess.pid); process.exit(0); });
process.on('SIGTERM', () => { if (claudeProcess) killProcessTree(claudeProcess.pid); process.exit(0); });
