@echo off
setlocal
chcp 65001 >nul
title NEON DROP - P2P Dosya Transferi
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo  [HATA] Node.js bulunamadi.
  echo.
  echo  Node.js 18 veya daha yenisini kurun:
  echo  https://nodejs.org/
  echo.
  pause
  exit /b 1
)

if not defined PORT set "PORT=3000"

echo.
echo  NEON DROP baslatiliyor...
echo  Yerel adres: http://localhost:%PORT%
echo.

if not exist "node_modules\" (
  echo  Bagimliliklar ilk kez yukleniyor. Bu islem birkac dakika surebilir...
  call npm install --no-audit --no-fund
  if errorlevel 1 (
    echo.
    echo  [HATA] npm install basarisiz oldu.
    echo  Internet baglantisini ve npm ayarlarini kontrol edin.
    pause
    exit /b 1
  )
)

start "" /b powershell -NoProfile -WindowStyle Hidden -Command "Start-Sleep -Seconds 2; Start-Process 'http://localhost:%PORT%'"

call npm start
set "EXIT_CODE=%ERRORLEVEL%"

echo.
if not "%EXIT_CODE%"=="0" echo  Sunucu hata koduyla kapandi: %EXIT_CODE%
pause
exit /b %EXIT_CODE%
