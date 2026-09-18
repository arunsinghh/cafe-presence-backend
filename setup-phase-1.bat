@echo off
cd /d "%~dp0"
echo Installing dependencies...
call npm install
echo Phase 1 project ready: %CD%
