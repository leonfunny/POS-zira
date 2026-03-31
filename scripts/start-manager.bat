@echo off
title Kaia AI Manager - Telegram Bot
color 0A

echo.
echo  ╔══════════════════════════════════════╗
echo  ║     Kaia AI Manager - Telegram       ║
echo  ║     Bot: @Kaia_nail_bot              ║
echo  ╚══════════════════════════════════════╝
echo.

:: ── Proxy (bỏ comment nếu ISP chặn Telegram) ─────────────────────────────
:: set HTTPS_PROXY=socks5://127.0.0.1:1080
:: set HTTPS_PROXY=http://127.0.0.1:7890
:: set ALL_PROXY=socks5://127.0.0.1:1080
:: ─────────────────────────────────────────────────────────────────────────

:loop
echo [%date% %time%] Khoi dong manager...
node "%~dp0telegram-manager.js"
echo.
echo [%date% %time%] Manager da thoat. Khoi dong lai sau 5 giay...
echo Nhan Ctrl+C de dung hoan toan.
echo.
timeout /t 5 /nobreak > nul
goto loop
