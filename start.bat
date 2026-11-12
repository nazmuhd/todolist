@echo off
rem Starts the app and the API from one process.
rem
rem   app + API : http://localhost:4000
rem
rem The server serves the static app and the API from the same origin, so
rem there is no CORS to configure and the service worker works as usual.
rem Close this window (or press Ctrl+C) to stop it.

setlocal
cd /d "%~dp0server"

if not exist node_modules (
  echo Installing dependencies...
  pnpm install
  if errorlevel 1 (
    echo.
    echo Install failed. Is pnpm installed? Try: npm install -g pnpm
    pause
    exit /b 1
  )
)

echo.
echo Starting Todolist...
echo Open http://localhost:4000 in your browser.
echo.

pnpm dev
