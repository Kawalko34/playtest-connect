@echo off
title Play Test - server
cd /d "%~dp0"
rem Start a local server (Google sign-in requires http://, not file://)
start /min "Play Test server" cmd /c "npx -y http-server public -p 8377 -c-1"
timeout /t 2 /nobreak >nul
start "" http://localhost:8377
exit


