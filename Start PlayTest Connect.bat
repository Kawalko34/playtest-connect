@echo off
title PlayTest Connect - server
cd /d "%~dp0"
rem Start a local server (Google sign-in requires http://, not file://)
start /min "PlayTest Connect server" cmd /c "npx -y http-server -p 8377 -c-1"
timeout /t 2 /nobreak >nul
start "" http://localhost:8377
exit
