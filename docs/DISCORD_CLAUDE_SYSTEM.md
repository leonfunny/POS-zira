# Kaia AI — Discord Claude System

Hệ thống cho phép khởi động/đóng Claude Code session trực tiếp từ Discord mà không cần thao tác thủ công trên máy tính.

---

## Tổng quan hoạt động

```
Discord (người dùng gõ /claude)
        ↓
discord-manager.js (luôn chạy ngầm, poll Discord mỗi 2.5s)
        ↓
Spawn Claude session mới (terminal mở trên máy)
Claude session kết nối Discord → nhận & trả lời tin nhắn
        ↓
Discord (người dùng gõ /end)
        ↓
discord-manager.js kill Claude + bun.exe discord plugin
Terminal đóng lại
```

### Các lệnh trên Discord

| Lệnh | Tác dụng |
|------|----------|
| `/claude` | Mở Claude session mới, Claude bắt đầu nhận tin nhắn |
| `/end` | Đóng session, terminal tắt |
| Tin nhắn bình thường | Claude trong session đang mở sẽ phản hồi |

---

## Các file quan trọng

### File auto-start (chạy khi Windows khởi động)

```
C:\Users\pc\AppData\Roaming\Microsoft\Windows\Start Menu\Programs\Startup\kaia-ai-discord.vbs
```

- Chạy ngầm (hidden window) khi Windows boot
- Có restart loop: nếu manager crash, tự khởi động lại sau 5 giây
- Chạy: `node C:\print-agent-master\scripts\discord-manager.js`

### Manager script (não của hệ thống)

```
C:\print-agent-master\scripts\discord-manager.js
```

- Poll Discord REST API mỗi 2.5 giây
- Xử lý lệnh `/claude` và `/end`
- Khi `/claude`: viết `run-claude.bat` + `launch-claude.ps1` → spawn Claude
- Khi `/end`: `taskkill /F /T /PID` + kill bun.exe discord plugin
- Theo dõi Claude session, phát hiện khi session tự đóng

### Config Discord plugin

```
C:\Users\pc\.claude\channels\discord\access.json
```

```json
{
  "dmPolicy": "allowlist",
  "allowFrom": [],
  "groups": {
    "1486369081970917529": { "requireMention": false, "allowFrom": [] }
  },
  "ackReaction": "👀",
  "replyToMode": "first"
}
```

**Quan trọng:** `allowFrom: []` trong groups nghĩa là tất cả thành viên trong group đều được phép nhắn tin.

### Claude Code settings

```
C:\Users\pc\.claude\settings.json
```

```json
{
  "enabledPlugins": {
    "telegram@claude-plugins-official": true,
    "discord@claude-plugins-official": true
  },
  "skipDangerousModePermissionPrompt": true
}
```

**Quan trọng:** `discord@claude-plugins-official` phải là `true` để spawned session có thể kết nối Discord.

### State files (tự động tạo, không chỉnh tay)

| File | Mục đích |
|------|----------|
| `C:\Users\pc\.claude\channels\discord\manager.lock` | PID của discord-manager đang chạy |
| `C:\Users\pc\.claude\channels\discord\claude-session.pid` | PID của cmd window chứa Claude session |
| `C:\Users\pc\.claude\channels\discord\run-claude.bat` | Bat file tạm để spawn Claude |
| `C:\Users\pc\.claude\channels\discord\launch-claude.ps1` | PS1 file tạm để lấy PID khi spawn |
| `C:\Users\pc\.claude\channels\discord\kill.flag` | Flag file nếu cần kill session từ bên trong |

---

## Kiến trúc process

Khi có Claude session đang chạy, có các process sau:

```
wscript.exe (kaia-ai-discord.vbs — auto-start)
  └── node.exe (discord-manager.js — manager)

cmd.exe (run-claude.bat — spawned bởi /claude)
  └── cmd.exe (claude.cmd)
       └── node.exe (Claude Code cli.js --channels plugin:discord@claude-plugins-official)

bun.exe (discord MCP plugin server — tự start khi Claude kết nối Discord)
```

**Lưu ý quan trọng:** `bun.exe` là process **tách biệt** khỏi Claude. Nếu chỉ kill Claude mà không kill bun.exe, bot Discord vẫn hiện icon 👀 và "typing indicator" dù không có ai trả lời.

---

## Bugs đã fix (2026-03-27)

| Bug | Root cause | Fix |
|-----|-----------|-----|
| Spam tin nhắn sau `/end` | `startMonitor()` dùng `setTimeout` không lưu handle → không clear được → sau 6s vẫn chạy, detect Claude chết, gửi thêm message | Thêm `monitorDelayTimer`, clear trong `onClaudeExit()` |
| Typing indicator / 👀 không tắt sau restart | `bun.exe` từ session cũ còn sống qua restart manager | Kill `bun.exe` stale ngay lúc boot nếu Claude không chạy |
| Claude mới launch không kết nối Discord | `launchClaude()` không kill `bun.exe` cũ trước khi spawn | Gọi `killStaleBun()` trước khi spawn Claude |

---

## Các lỗi thường gặp & cách xử lý

### 1. `/claude` trên Discord không phản hồi, không mở terminal

**Nguyên nhân có thể:**
- Manager (`discord-manager.js`) không chạy
- Có nhiều instance manager xung đột

**Kiểm tra:**
```powershell
# Kiểm tra manager có chạy không
Get-WmiObject Win32_Process | Where-Object { $_.Name -eq 'node.exe' -and $_.CommandLine -like '*discord-manager.js*' } | Select-Object ProcessId, CommandLine
```

**Fix:**
```powershell
# Kill tất cả và restart sạch
Get-WmiObject Win32_Process | Where-Object { $_.Name -eq 'wscript.exe' -and $_.CommandLine -like '*kaia-ai-discord*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
Get-WmiObject Win32_Process | Where-Object { $_.Name -eq 'node.exe' -and $_.CommandLine -like '*discord-manager.js*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
# Sau đó chạy lại VBS
Start-Process wscript.exe -ArgumentList '"C:\Users\pc\AppData\Roaming\Microsoft\Windows\Start Menu\Programs\Startup\kaia-ai-discord.vbs"'
```

---

### 2. `/end` không đóng terminal

**Nguyên nhân:** Manager mất PID file hoặc `taskkill` thất bại.

**Fix thủ công:**
```powershell
# Kill tất cả Claude sessions đang kết nối Discord
Get-WmiObject Win32_Process | Where-Object { $_.Name -eq 'node.exe' -and $_.CommandLine -like '*discord@claude-plugins-official*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
# Kill bun.exe discord plugin
Get-WmiObject Win32_Process | Where-Object { $_.Name -eq 'bun.exe' -and $_.CommandLine -like '*external_plugins/discord*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
```

---

### 3. Sau `/end` vẫn còn icon 👀 hoặc "bot is typing" trên Discord

**Nguyên nhân:** `bun.exe` discord plugin chưa bị kill.

**Fix:**
```powershell
Get-WmiObject Win32_Process | Where-Object { $_.Name -eq 'bun.exe' -and $_.CommandLine -like '*external_plugins/discord*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
```

---

### 4. Claude mở nhưng không nhận/trả lời tin nhắn Discord

**Nguyên nhân có thể:**
- `discord@claude-plugins-official` bị xóa khỏi `enabledPlugins` trong settings.json
- Discord bot token hết hạn hoặc sai

**Kiểm tra settings.json:**
```
C:\Users\pc\.claude\settings.json
```
Đảm bảo `"discord@claude-plugins-official": true` có mặt trong `enabledPlugins`.

---

### 5. Manager crash liên tục, không stay alive

**Kiểm tra:** Chạy trực tiếp để xem lỗi:
```cmd
cd C:\print-agent-master
node scripts\discord-manager.js
```
Xem output lỗi trong terminal.

**Nguyên nhân phổ biến:** Bot token Discord hết hạn (lỗi 401 trong poll).

---

## Restart thủ công toàn bộ hệ thống

```powershell
# 1. Kill tất cả
Get-WmiObject Win32_Process | Where-Object { $_.Name -eq 'wscript.exe' -and $_.CommandLine -like '*kaia-ai-discord*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
Get-WmiObject Win32_Process | Where-Object { $_.Name -eq 'node.exe' -and $_.CommandLine -like '*discord-manager.js*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
Get-WmiObject Win32_Process | Where-Object { $_.Name -eq 'node.exe' -and $_.CommandLine -like '*discord@claude-plugins-official*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
Get-WmiObject Win32_Process | Where-Object { $_.Name -eq 'bun.exe' -and $_.CommandLine -like '*external_plugins/discord*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }

# 2. Xóa stale state files
Remove-Item "C:\Users\pc\.claude\channels\discord\manager.lock" -ErrorAction SilentlyContinue
Remove-Item "C:\Users\pc\.claude\channels\discord\claude-session.pid" -ErrorAction SilentlyContinue
Remove-Item "C:\Users\pc\.claude\channels\discord\kill.flag" -ErrorAction SilentlyContinue

# 3. Khởi động lại manager
Start-Process wscript.exe -ArgumentList '"C:\Users\pc\AppData\Roaming\Microsoft\Windows\Start Menu\Programs\Startup\kaia-ai-discord.vbs"'
```

---

## Thông tin kỹ thuật

| Thông số | Giá trị |
|----------|---------|
| Discord Channel ID | `1486369081970917529` |
| Poll interval | 2500ms |
| Claude khởi động timeout | 8 giây |
| Monitor delay sau spawn | 6 giây |
| Monitor interval | 3 giây |
| Manager restart delay (nếu crash) | 5 giây |
| Working directory Claude | `C:\print-agent-master` |
| Claude command | `%APPDATA%\npm\claude.cmd` |

---

## Sơ đồ flow chi tiết

```
Windows Boot
    ↓
kaia-ai-discord.vbs (Startup folder)
    ↓ chạy ngầm, có restart loop
discord-manager.js
    ↓ poll Discord mỗi 2.5s
    │
    ├─ nhận "/claude"
    │       ↓
    │   viết run-claude.bat + launch-claude.ps1
    │       ↓
    │   PowerShell Start-Process → cmd.exe → claude.cmd → node.exe (Claude)
    │   lưu PID vào claude-session.pid
    │       ↓
    │   bun.exe discord plugin tự start
    │       ↓
    │   Claude nhận & trả lời tin nhắn Discord
    │
    └─ nhận "/end"
            ↓
        taskkill /F /T /PID (từ claude-session.pid) → kill cả cmd tree
            ↓
        PowerShell kill node.exe theo command line (fallback)
            ↓
        PowerShell kill bun.exe discord plugin
            ↓
        Terminal đóng, không còn icon/typing trên Discord
```
