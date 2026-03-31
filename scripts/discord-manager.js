#!/usr/bin/env node
/**
 * Kaia AI — Discord Manager
 * /claude → mở Claude trong terminal mới
 * /end    → đóng session
 * Text khác → Claude WebSocket xử lý
 */

const https   = require('https');
const { spawn, execSync, spawnSync } = require('child_process');
const fs      = require('fs');
const path    = require('path');
const os      = require('os');

// ── Config ────────────────────────────────────────────────────────────────────
const BOT_TOKEN          = '';
const CHANNEL_ID         = '1486369081970917529';
const WORK_DIR           = 'C:\\print-agent-master';
const WIN_HOME           = process.env.USERPROFILE || `C:\\Users\\${os.userInfo().username}`;
const STATE_DIR          = `${WIN_HOME}\\.claude\\channels\\discord`;
const LOCK_FILE          = path.join(STATE_DIR, 'manager.lock');
const KILL_FILE          = path.join(STATE_DIR, 'kill.flag');
const CLAUDE_CMD         = `${process.env.APPDATA}\\npm\\claude.cmd`;
const POLL_MS             = 2500;
const CLAUDE_WINDOW_TITLE = 'KaiaAI-Claude-Session';
const PID_FILE            = path.join(STATE_DIR, 'claude-session.pid');

// ─────────────────────────────────────────────────────────────────────────────

fs.mkdirSync(STATE_DIR, { recursive: true });

// ── Chống chạy nhiều instance ─────────────────────────────────────────────────
// Dùng powershell scan thay vì tin vào PID (PID có thể bị tái sử dụng trên Windows)
try {
  const out = execSync(
    `powershell -NoProfile -Command "Get-WmiObject Win32_Process | Where-Object { $_.Name -eq 'node.exe' -and $_.CommandLine -like '*discord-manager.js*' -and $_.ProcessId -ne ${process.pid} } | Select-Object -First 1 -ExpandProperty ProcessId"`,
    { stdio: 'pipe', encoding: 'utf8' }
  ).trim();
  if (out && !isNaN(parseInt(out))) {
    console.log(`[Manager] Đã có instance PID=${out}, thoát.`);
    process.exit(0);
  }
} catch {}
fs.writeFileSync(LOCK_FILE, String(process.pid));
process.on('exit', () => { try { fs.unlinkSync(LOCK_FILE); } catch {} });
// ─────────────────────────────────────────────────────────────────────────────

let isRunning        = false;
let pollTimer        = null;
let monitorTimer     = null;
let monitorDelayTimer = null;  // BUG FIX: track setTimeout handle để clear đúng cách
let lastMessageId    = null;
let lastPollTime  = Date.now();
let checkFailCount = 0;          // consecutive isClaudeRunning() failures
const EXIT_MSG_COOLDOWN = 60000; // 60s cooldown giữa các lần gửi "Session tự đóng"
const EXIT_TS_FILE = path.join(STATE_DIR, 'last-exit-msg.ts'); // file-based cooldown (sống qua restart)

// ── Detect & Kill Claude ──────────────────────────────────────────────────────
function isClaudeRunning() {
  try {
    const out = execSync(
      `powershell -NoProfile -Command "Get-WmiObject Win32_Process | Where-Object { $_.Name -eq 'node.exe' -and $_.CommandLine -like '*discord@claude-plugins-official*' } | Select-Object -First 1 -ExpandProperty ProcessId"`,
      { stdio: 'pipe', encoding: 'utf8', timeout: 8000 }
    ).trim();
    if (out.length > 0 && !isNaN(parseInt(out))) {
      checkFailCount = 0;
      return true;
    }
    checkFailCount++;
    return false;
  } catch {
    // WMI query failed (timeout, service not ready after sleep, etc.)
    checkFailCount++;
    // Cần 3 lần fail liên tiếp mới coi là Claude đã chết
    // (tránh false positive khi WMI chưa sẵn sàng sau sleep)
    if (checkFailCount < 3) {
      console.log(`[Manager] isClaudeRunning check failed (${checkFailCount}/3), giả định còn chạy...`);
      return true;  // assume still running until confirmed dead
    }
    return false;
  }
}

function killClaude() {
  // Kill bằng PID đã lưu + toàn bộ process tree
  try {
    const pid = parseInt(fs.readFileSync(PID_FILE, 'utf8').trim());
    if (!isNaN(pid)) {
      execSync(`taskkill /F /T /PID ${pid}`, { stdio: 'ignore' });
      console.log(`[Manager] Killed tree PID=${pid}`);
    }
  } catch {}
  // Fallback: kill node.exe theo command line
  try {
    execSync(
      `powershell -NoProfile -Command "Get-WmiObject Win32_Process | Where-Object { $_.Name -eq 'node.exe' -and $_.CommandLine -like '*discord@claude-plugins-official*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"`,
      { stdio: 'ignore' }
    );
  } catch {}
  // Kill discord plugin MCP server (bun.exe) — chạy tách biệt, sống sót qua kill Claude
  try {
    execSync(
      `powershell -NoProfile -Command "Get-WmiObject Win32_Process | Where-Object { $_.Name -eq 'bun.exe' -and $_.CommandLine -like '*external_plugins/discord*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"`,
      { stdio: 'ignore' }
    );
    console.log('[Manager] Killed discord plugin bun.exe');
  } catch {}
  try { fs.unlinkSync(PID_FILE); } catch {}
}

// ── Discord REST ──────────────────────────────────────────────────────────────
function api(method, endpoint, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = https.request({
      hostname: 'discord.com',
      path: `/api/v10${endpoint}`,
      method,
      headers: {
        'Authorization': `Bot ${BOT_TOKEN}`,
        'Content-Type': 'application/json',
        ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
      },
    }, res => {
      let raw = '';
      res.on('data', d => raw += d);
      res.on('end', () => { try { resolve(raw ? JSON.parse(raw) : {}); } catch { resolve({}); } });
    });
    req.setTimeout(10000, () => { req.destroy(); });  // 10s timeout tránh zombie request
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

const send = content => api('POST', `/channels/${CHANNEL_ID}/messages`, { content });

// ── Polling ───────────────────────────────────────────────────────────────────
async function initLastId() {
  const msgs = await api('GET', `/channels/${CHANNEL_ID}/messages?limit=1`).catch(() => []);
  if (Array.isArray(msgs) && msgs[0]) lastMessageId = msgs[0].id;
}

function startPolling() {
  if (pollTimer) return;
  pollTimer = setInterval(async () => {
    // ── Sleep detection ──────────────────────────────────────────────────
    const now = Date.now();
    const elapsed = now - lastPollTime;
    lastPollTime = now;

    if (elapsed > POLL_MS * 10) {  // >25s gap = máy vừa thức dậy từ sleep
      console.log(`[Manager] Phát hiện sleep (gap: ${Math.round(elapsed / 1000)}s). Đang recovery...`);
      checkFailCount = 0;  // reset để tránh false death detection
      // Re-check trạng thái Claude sau khi thức dậy
      const wasRunning = isRunning;
      isRunning = isClaudeRunning();
      if (wasRunning && !isRunning) {
        // Claude đã chết trong lúc sleep — gửi thông báo 1 lần (có cooldown)
        onClaudeExit('✅ Session tự đóng (máy đã sleep).');
      } else if (isRunning && !monitorTimer) {
        startMonitor();  // resume monitoring
      }
      // Re-init lastMessageId để không bỏ lỡ tin nhắn
      await initLastId();
      return;  // skip polling lần này, để lần sau bắt đầu clean
    }
    // ─────────────────────────────────────────────────────────────────────

    try {
      const qs   = lastMessageId ? `?after=${lastMessageId}&limit=10` : `?limit=1`;
      const msgs = await api('GET', `/channels/${CHANNEL_ID}/messages${qs}`);
      if (!Array.isArray(msgs)) return;

      for (const msg of msgs.reverse()) {
        if (msg.author?.bot) { lastMessageId = msg.id; continue; }
        const text = (msg.content || '').trim();
        lastMessageId = msg.id;

        if (text === '/claude') {
          if (isRunning) {
            await send('⚠️ Session đang chạy. Gõ `/end` để đóng trước.');
          } else {
            await send('🚀 Đang khởi động Claude Code...');
            launchClaude();
          }
        } else if (text === '/end') {
          if (!isRunning) {
            await send('⚠️ Không có session nào đang chạy.');
          } else {
            await send('🛑 Đang đóng session...');
            killClaude();
            onClaudeExit('✅ Session đã đóng.', { force: true });
          }
        }
        // Text khác → Claude WebSocket tự xử lý
      }
    } catch (e) {
      console.error('[Manager] Poll error:', e.message);
    }
  }, POLL_MS);
  console.log('[Manager] Polling Discord...');
}

// ── Claude session ────────────────────────────────────────────────────────────
function launchClaude() {
  isRunning = true;
  try { fs.unlinkSync(KILL_FILE); } catch {}
  try { fs.unlinkSync(PID_FILE); } catch {}
  // BUG FIX: kill bun.exe stale TRƯỚC khi spawn Claude mới để tránh xung đột
  killStaleBun();

  const runBat = path.join(STATE_DIR, 'run-claude.bat');
  fs.writeFileSync(runBat,
    '@echo off\r\n' +
    'title ' + CLAUDE_WINDOW_TITLE + '\r\n' +
    'cd /d "' + WORK_DIR + '"\r\n' +
    '"' + CLAUDE_CMD + '" --permission-mode bypassPermissions --channels plugin:discord@claude-plugins-official\r\n'
  );

  // Dùng PowerShell Start-Process -PassThru để lấy PID của cmd window
  const psFile = path.join(STATE_DIR, 'launch-claude.ps1');
  fs.writeFileSync(psFile,
    '$p = Start-Process cmd.exe -ArgumentList \'/c "' + runBat + '"\' -PassThru\r\n' +
    '$p.Id | Set-Content "' + PID_FILE + '"\r\n'
  );

  console.log('[Manager] Mở Claude qua PowerShell Start-Process...');
  try {
    execSync('powershell.exe -NoProfile -ExecutionPolicy Bypass -File "' + psFile + '"', { stdio: 'ignore', timeout: 8000 });
  } catch (e) {
    console.error('[Manager] Launch error:', e.message);
  }

  startMonitor();
}

function killStaleBun() {
  // Kill bun.exe discord plugin stale (từ session cũ) — gọi trước launch và lúc boot
  try {
    execSync(
      `powershell -NoProfile -Command "Get-WmiObject Win32_Process | Where-Object { $_.Name -eq 'bun.exe' -and $_.CommandLine -like '*external_plugins/discord*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"`,
      { stdio: 'ignore', timeout: 5000 }
    );
    console.log('[Manager] Cleared stale bun.exe discord plugin');
  } catch {}
}

function startMonitor() {
  // BUG FIX: clear cả delay timer lẫn interval timer
  if (monitorDelayTimer) { clearTimeout(monitorDelayTimer); monitorDelayTimer = null; }
  if (monitorTimer) { clearInterval(monitorTimer); monitorTimer = null; }

  // Đợi 6s cho Claude khởi động trước khi bắt đầu monitor
  monitorDelayTimer = setTimeout(() => {
    monitorDelayTimer = null;
    monitorTimer = setInterval(() => {
      // Kiểm tra kill flag (do Claude tạo khi nhận /end)
      if (fs.existsSync(KILL_FILE)) {
        clearInterval(monitorTimer); monitorTimer = null;
        killClaude();
        onClaudeExit('✅ Session đã đóng.', { force: true });
        return;
      }
      // Kiểm tra Claude còn chạy không
      if (!isClaudeRunning()) {
        clearInterval(monitorTimer); monitorTimer = null;
        onClaudeExit('✅ Session tự đóng.');
      }
    }, 3000);
  }, 6000);
}

function onClaudeExit(message, { force = false } = {}) {
  // BUG FIX: clear cả delay timer để tránh spam khi /end gọi trong 6s đầu
  if (monitorDelayTimer) { clearTimeout(monitorDelayTimer); monitorDelayTimer = null; }
  if (monitorTimer) { clearInterval(monitorTimer); monitorTimer = null; }
  try { fs.unlinkSync(KILL_FILE); } catch {}
  isRunning = false;
  checkFailCount = 0;

  // Cooldown chống spam: dùng file timestamp để sống qua restart của .bat
  if (!force) {
    try {
      const lastTs = parseInt(fs.readFileSync(EXIT_TS_FILE, 'utf8').trim());
      if (!isNaN(lastTs) && Date.now() - lastTs < EXIT_MSG_COOLDOWN) {
        console.log('[Manager] Skipping exit message (cooldown active)');
        return;
      }
    } catch {}
  }
  fs.writeFileSync(EXIT_TS_FILE, String(Date.now()));

  send(`${message}\n\nGõ \`/claude\` để bắt đầu session mới.`).catch(() => {});
  console.log('[Manager] Session ended, polling tiếp...');
}

// ── Boot ──────────────────────────────────────────────────────────────────────
(async () => {
  try { fs.unlinkSync(KILL_FILE); } catch {}

  // Reset isRunning nếu Claude không thực sự chạy
  isRunning = isClaudeRunning();
  if (isRunning) {
    console.log('[Manager] Phát hiện Claude đang chạy, tiếp tục monitor...');
  } else {
    // BUG FIX: nếu Claude không chạy nhưng bun.exe còn sống (từ session cũ),
    // kill ngay để tránh typing indicator / 👀 phantom trên Discord
    killStaleBun();
  }

  await initLastId();
  startPolling();
  if (isRunning) startMonitor();

  await send('🤖 **Kaia AI online** — `/claude` để bắt đầu · `/end` để đóng').catch(() => {});

  console.log('╔══════════════════════════════════════╗');
  console.log('║   Kaia AI Manager — Discord          ║');
  console.log('║   /claude → mở Claude                ║');
  console.log('║   /end    → đóng session             ║');
  console.log('╚══════════════════════════════════════╝');
})();

process.on('SIGINT',  () => { killClaude(); process.exit(0); });
process.on('SIGTERM', () => { killClaude(); process.exit(0); });
