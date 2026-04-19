# backup-machine.ps1
# Creates a full backup bundle for migrating Zira AI Print Agent work to a new machine.
# Captures: Claude Code state, Codex state, SSH keys, Zira AI app data, VSCode extensions,
# environment variables, and the project itself.
#
# Usage (from project root or anywhere):
#   powershell -ExecutionPolicy Bypass -File scripts/backup-machine.ps1 -Out "D:\backup"
#
# Defaults to current Desktop if -Out not provided.

param(
  [string]$Out = (Join-Path $HOME "Desktop\zira-backup-$(Get-Date -Format 'yyyyMMdd-HHmm')")
)

$ErrorActionPreference = 'Stop'
New-Item -ItemType Directory -Path $Out -Force | Out-Null
Write-Host "Backup destination: $Out" -ForegroundColor Cyan

function Zip-Folder($src, $dstZip) {
  if (Test-Path $src) {
    Write-Host "  -> zipping $src"
    Compress-Archive -Path $src -DestinationPath $dstZip -Force
  } else {
    Write-Host "  skip: $src (not found)" -ForegroundColor DarkGray
  }
}

Write-Host "1/7 Claude Code (~/.claude)" -ForegroundColor Yellow
Zip-Folder "$HOME\.claude" "$Out\claude.zip"

Write-Host "2/7 Codex (~/.codex)" -ForegroundColor Yellow
Zip-Folder "$HOME\.codex" "$Out\codex.zip"

Write-Host "3/7 SSH keys (~/.ssh)" -ForegroundColor Yellow
Zip-Folder "$HOME\.ssh" "$Out\ssh.zip"

Write-Host "4/7 Zira AI app data (%APPDATA%\zira-ai)" -ForegroundColor Yellow
# Exclude Cache/GPUCache/Code Cache (huge, regenerated)
$ziraSrc = Join-Path $env:APPDATA 'zira-ai'
if (Test-Path $ziraSrc) {
  $tmpStage = Join-Path $env:TEMP "zira-ai-stage-$(Get-Random)"
  New-Item -ItemType Directory -Path $tmpStage -Force | Out-Null
  Get-ChildItem $ziraSrc -Force | Where-Object {
    $_.Name -notmatch '^(Cache|Code Cache|GPUCache|DawnGraphiteCache|DawnWebGPUCache|Shared Dictionary|blob_storage|Session Storage|Local Storage|Network|browser-sessions)$'
  } | ForEach-Object {
    Copy-Item $_.FullName (Join-Path $tmpStage $_.Name) -Recurse -Force
  }
  Compress-Archive -Path "$tmpStage\*" -DestinationPath "$Out\zira-ai.zip" -Force
  Remove-Item $tmpStage -Recurse -Force
  Write-Host "  -> zira-ai.zip (without browser caches)"
} else {
  Write-Host "  skip: zira-ai not installed" -ForegroundColor DarkGray
}

Write-Host "5/7 VSCode extensions list" -ForegroundColor Yellow
if (Get-Command code -ErrorAction SilentlyContinue) {
  code --list-extensions | Out-File "$Out\vscode-extensions.txt" -Encoding utf8
  Write-Host "  -> vscode-extensions.txt"
} else {
  Write-Host "  skip: code CLI not on PATH" -ForegroundColor DarkGray
}

Write-Host "6/7 Environment variables (user scope)" -ForegroundColor Yellow
[Environment]::GetEnvironmentVariables('User').GetEnumerator() |
  Sort-Object Name |
  ForEach-Object { "$($_.Name)=$($_.Value)" } |
  Out-File "$Out\env-user.txt" -Encoding utf8
Write-Host "  -> env-user.txt (REDACT secrets before sharing)"

Write-Host "7/7 Git config" -ForegroundColor Yellow
git config --global --list 2>$null | Out-File "$Out\gitconfig-global.txt" -Encoding utf8
Write-Host "  -> gitconfig-global.txt"

# Manifest
@"
Zira AI Migration Backup
Created: $(Get-Date -Format 'yyyy-MM-dd HH:mm')
Host: $env:COMPUTERNAME
User: $env:USERNAME

Contents:
- claude.zip              -> extract to %USERPROFILE%\.claude\
- codex.zip               -> extract to %USERPROFILE%\.codex\
- ssh.zip                 -> extract to %USERPROFILE%\.ssh\ (chmod on Linux)
- zira-ai.zip             -> extract to %APPDATA%\zira-ai\ (optional: pos.db keeps local order history; authToken/apiKey are DPAPI-encrypted and WILL NOT decrypt on a new machine — re-pair required)
- vscode-extensions.txt   -> install with:  Get-Content vscode-extensions.txt | ForEach-Object { code --install-extension `$_ }
- env-user.txt            -> review and restore with setx (REDACT before sharing)
- gitconfig-global.txt    -> restore manually with git config --global

Next steps on the new machine:
1. Install: Node 18+, Git, VSCode, Claude Code CLI, Codex CLI
2. Extract the archives above to the indicated paths
3. git clone https://github.com/KaiPizz/zira-pos.git C:\print-agent-master
4. cd C:\print-agent-master; npm install
5. Read SESSION_HANDOFF.md for current project state
6. Re-pair Zira AI using API key from %APPDATA%\zira-ai\config.json on OLD machine (field: apiKey, plaintext, format pa_...)
"@ | Out-File "$Out\MANIFEST.txt" -Encoding utf8

$size = [math]::Round(((Get-ChildItem $Out -Recurse -File | Measure-Object Length -Sum).Sum / 1MB), 1)
Write-Host ""
Write-Host "Backup complete. Total size: $size MB" -ForegroundColor Green
Write-Host "Location: $Out" -ForegroundColor Green
Write-Host ""
Write-Host "Copy this folder to USB/external drive, then extract on the new machine." -ForegroundColor Cyan
