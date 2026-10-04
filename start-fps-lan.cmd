@echo off
setlocal
cd /d "%~dp0"
title Freight Fire - LAN Host
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js 20 or newer is required.
  echo Install the official LTS release from https://nodejs.org/
  echo Then run this file again.
  pause
  exit /b 1
)
node -e "process.exit(Number(process.versions.node.split('.')[0]) >= 20 ? 0 : 1)"
if errorlevel 1 (
  echo Node.js is too old. Install Node.js 20 or newer from https://nodejs.org/
  pause
  exit /b 1
)
if not exist "node_modules\ws\package.json" (
  echo Installing the locked LAN dependency. Package lifecycle scripts are disabled.
  call npm.cmd ci --omit=dev --ignore-scripts
  if errorlevel 1 (
    echo Dependency installation failed. Check your connection and try again.
    pause
    exit /b 1
  )
)
echo.
echo Starting LAN host. Keep this window open while playing.
echo This script does not change firewall rules or router settings.
echo Open the localhost game link below, choose LAN, and create a 4v4 or 8v8 room.
echo Use the game's invite button to copy a link for friends on the same network.
echo.
node scripts\lan-server.mjs %*
if errorlevel 1 (
  echo.
  echo The host stopped with an error. Read the message above.
  pause
  exit /b 1
)
endlocal
