@echo off
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Instale o Node.js 18 ou superior para iniciar o jogo.
  pause
  exit /b 1
)
node server.js
pause
