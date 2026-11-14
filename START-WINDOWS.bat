@echo off
setlocal
cd /d "%~dp0"

where node >nul 2>&1
if errorlevel 1 (
  echo [ERROR] Node.js is not installed.
  echo Install Node.js 22.6 or newer from https://nodejs.org/ and reopen this file.
  pause
  exit /b 1
)

node -e "const [major,minor]=process.versions.node.split('.').map(Number); if (major < 22 || (major === 22 && minor < 6)) process.exit(1);"
if errorlevel 1 (
  echo [ERROR] Yozora requires Node.js 22.6 or newer.
  echo Your installed version is:
  node --version
  echo Update Node.js from https://nodejs.org/ and try again.
  pause
  exit /b 1
)

echo.
echo Starting Yozora Anime Player...
echo Keep this window open while you use Yozora.
echo Open http://127.0.0.1:3001 in your browser.
echo Press Ctrl+C here to stop the server.
echo.
npm start
if errorlevel 1 (
  echo.
  echo [ERROR] Yozora stopped because the server reported an error.
  echo Read the message above, then check README.md for troubleshooting.
  pause
)
endlocal
