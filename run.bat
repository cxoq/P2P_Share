@echo off
setlocal
chcp 65001 >nul
title iShare
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo  [ERROR] Node.js was not found.
  echo.
  echo  Install Node.js 18 or newer from https://nodejs.org/
  echo.
  pause
  exit /b 1
)

if not defined PORT set "PORT=3000"

echo.
echo  Starting iShare...
echo  Local address: http://localhost:%PORT% (the next free port if this one is busy)
echo  A public Cloudflare link will appear here in a few seconds.
echo.

if not exist "node_modules\" (
  echo  Installing dependencies for the first time. This can take a few minutes...
  call npm install --no-audit --no-fund
  if errorlevel 1 (
    echo.
    echo  [ERROR] npm install failed.
    echo  Check your internet connection and npm settings.
    pause
    exit /b 1
  )
)

node tools\host.js %*
set "EXIT_CODE=%ERRORLEVEL%"

echo.
if not "%EXIT_CODE%"=="0" echo  The host stopped with exit code %EXIT_CODE%.
pause
exit /b %EXIT_CODE%
