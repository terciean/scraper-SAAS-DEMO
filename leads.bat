@echo off
REM Lead Board — double-click to open the board in a browser tab.
REM Keep this window open while you work; closing it stops the board.

cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   Node.js was not found on PATH. Install it from https://nodejs.org
  echo   ^(pick the LTS version^), then run this again.
  echo.
  pause
  exit /b 1
)

REM This app needs Node 22.5+ (it uses the built-in node:sqlite). "where node"
REM above only checks that SOME Node is on PATH -- an older one already
REM installed for something else would otherwise fail deep inside with a
REM cryptic error instead of a clear one here.
for /f "tokens=1 delims=v." %%v in ('node -v') do set NODE_MAJOR=%%v
if %NODE_MAJOR% LSS 22 (
  echo.
  echo   Node.js is installed, but it's too old ^(found v%NODE_MAJOR%.x, need v22.5+^).
  echo   Update it from https://nodejs.org, then run this again.
  echo.
  pause
  exit /b 1
)

if not exist "node_modules\" (
  echo.
  echo   First run — installing dependencies, this takes a minute...
  echo.
  call npm install
  if errorlevel 1 (
    echo.
    echo   npm install failed -- see the messages above ^(often no internet
    echo   connection, or something blocking the npm registry^). Fix that,
    echo   then run this again.
    echo.
    pause
    exit /b 1
  )
)

REM The scraper drives its own Chromium via Playwright -- separate from any
REM Chrome already on this PC, and separate from `npm install` above. Only
REM a real download the first time; a fast no-op every run after that.
echo.
echo   Checking the scraper's browser is installed...
call npx playwright install chromium
if errorlevel 1 (
  echo.
  echo   Could not install the scraper's browser -- see the messages above.
  echo   Fix that, then run this again.
  echo.
  pause
  exit /b 1
)

set "LEADCOUNT="
set /p LEADCOUNT="How many leads do you want to work today? (Enter for the saved default): "

if not "%LEADCOUNT%"=="" (
  echo %LEADCOUNT%| findstr /r "^[1-9][0-9]*$" >nul
  if errorlevel 1 (
    echo.
    echo   "%LEADCOUNT%" isn't a whole number - using the saved default instead.
    set "LEADCOUNT="
  )
)

echo.
echo   Starting the lead board...
if defined LEADCOUNT (
  node cli.js board --limit=%LEADCOUNT%
) else (
  node cli.js board
)

pause
