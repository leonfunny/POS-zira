@echo off
:: Script thêm Discord channel mới cho bot
:: Cách dùng: kéo thả file này, hoặc chạy: add-discord-channel.bat

title Them Discord Channel

echo.
echo ╔══════════════════════════════════════╗
echo ║    Them Discord Channel moi          ║
echo ╚══════════════════════════════════════╝
echo.
echo Lay Channel ID: Discord - Developer Mode - Right-click kenh - Copy Channel ID
echo.

set /p CHANNEL_ID="Nhap Channel ID: "

if "%CHANNEL_ID%"=="" (
  echo Khong co ID, thoat.
  pause
  exit /b
)

node "%~dp0add-discord-channel.js" %CHANNEL_ID%
pause
