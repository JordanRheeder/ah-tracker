@echo off
rem AH Tracker for Windows: starts the collector and dashboard, then opens the dashboard.
rem Double-click it, or put a shortcut to it in shell:startup to start AH Tracker when you log in.
cd /d "%~dp0..\.."
where node >nul 2>nul || (echo Node.js 24 or newer is needed: https://nodejs.org/ & pause & exit /b 1)
if not exist node_modules call pnpm install
if not exist .env node scripts\setup.ts
start "" /min cmd /c "title AH Tracker && node scripts\serve.ts"
timeout /t 3 /nobreak >nul
start "" http://localhost:8787/
