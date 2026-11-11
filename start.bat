@echo off
rem Starts the static app and the API together.
rem   static app : http://localhost:8000
rem   API        : http://localhost:4000
rem
rem The app needs a local server: ES modules and the service worker both
rem refuse to run from file://.

setlocal
cd /d "%~dp0"

start "todoist-app"  cmd /c "python -m http.server 8000"
start "todoist-api"  cmd /c "cd server && pnpm dev"

echo.
echo   App:  http://localhost:8000
echo   API:  http://localhost:4000
echo.
endlocal
