@echo off
title Kaia AI Manager - Discord
color 0B

echo.
echo  ╔══════════════════════════════════════╗
echo  ║   Kaia AI Manager - Discord          ║
echo  ║   !claude  = Bat dau Claude          ║
echo  ║   !end     = Dong session            ║
echo  ║   !status  = Trang thai              ║
echo  ║   Ctrl+C de tat                      ║
echo  ╚══════════════════════════════════════╝
echo.

:loop
node "%~dp0discord-manager.js"
echo.
echo [%date% %time%] Manager thoat. Khoi dong lai sau 5 giay...
timeout /t 5 /nobreak > nul
goto loop
