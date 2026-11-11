@echo off
rem Starts the app and the API from one process.
rem
rem   app + API : http://localhost:4000
rem
rem The server serves the static app and the API from the same origin, so
rem there is no CORS to configure and the service worker works as usual.

setlocal
cd /d "%~dp0server"

if not exist node_modules (
  echo Installing dependencies...
  pnpm install
)

pnpm dev
