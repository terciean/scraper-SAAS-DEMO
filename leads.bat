@echo off
REM Lead Board — double-click to open the board in a browser tab.
REM Keep this window open while you work; closing it stops the board.

cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   Node.js was not found on PATH. Install it from https://nodejs.org
  echo.
  pause
  exit /b 1
)

if not exist "node_modules\" (
  echo.
  echo   First run — installing dependencies, this takes a minute...
  echo.
  call npm install
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
