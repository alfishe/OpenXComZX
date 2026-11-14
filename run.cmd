@echo off
rem OpenXComZX: start the emulator with tmp\build\oxz.spg (tools\run.js).
rem   run.cmd                  - game window only, no console (Win+G recording works)
rem   run.cmd -Script tests\campaign.oxs -Headless   - any run.js arguments, with console
rem Mouse: left click in the window captures it, Shift+Esc releases.
cd /d "%~dp0"
if not exist "tmp\build\oxz.spg" (
  echo tmp\build\oxz.spg not found - build first: node tools\build.js
  pause
  exit /b 1
)
if "%~1"=="" (
  start "" /min node "%~dp0tools\run.js"
  exit /b 0
)
node "%~dp0tools\run.js" %*
