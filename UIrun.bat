@echo off
cd /d "%~dp0"

set "SYMBOL=%~1"
set "CATEGORY=%~2"

set "ENV_BOT_MARKET="
set "ENV_BOT_CATEGORY="
for /f "usebackq tokens=1,* delims==" %%A in (".env") do (
	if /I "%%A"=="BOT_MARKET" set "ENV_BOT_MARKET=%%B"
	if /I "%%A"=="BOT_CATEGORY" set "ENV_BOT_CATEGORY=%%B"
)

if "%SYMBOL%"=="" set "SYMBOL=%ENV_BOT_MARKET%"
if "%CATEGORY%"=="" set "CATEGORY=%ENV_BOT_CATEGORY%"
if "%SYMBOL%"=="" set "SYMBOL=BTCUSDT"
if "%CATEGORY%"=="" set "CATEGORY=spot"

if "%UI_HOST%"=="" set "UI_HOST=127.0.0.42"
if "%UI_PORT%"=="" set "UI_PORT=8787"

echo [UIrun] Startuje BOT + UI...
echo [UIrun] SYMBOL=%SYMBOL% CATEGORY=%CATEGORY%
echo.

set "BOT_MARKET=%SYMBOL%"
set "BOT_CATEGORY=%CATEGORY%"
set "BOT_HEADLESS=0"

rem prevent stale UI state/logs from previous run when bot fails early
del /q "scripts\logs\bot_ui_state.json" 2>nul
del /q "scripts\logs\bot_ui_logs.ndjson" 2>nul
del /q "scripts\logs\bot_ui_cmd.json" 2>nul
del /q "scripts\logs\ui_port.json" 2>nul

start "BOT (npm start)" cmd /k "cd /d ""%~dp0"" & npm start"
timeout /t 2 >nul

start "UI server (channels demo)" cmd /k "cd /d ""%~dp0"" & node scripts\js\momentum_regime_server.js --mode live --symbol %SYMBOL% --category %CATEGORY%"
set "UI_SELECTED_PORT=%UI_PORT%"
for /l %%N in (1,1,10) do (
	if exist "scripts\logs\ui_port.json" (
		for /f "usebackq delims=" %%P in (`powershell -NoProfile -Command "(Get-Content -Raw 'scripts\logs\ui_port.json' | ConvertFrom-Json).port"`) do set "UI_SELECTED_PORT=%%P"
		goto :ui_ready
	)
	timeout /t 1 >nul
)
:ui_ready

start "" "http://%UI_HOST%:%UI_SELECTED_PORT%/channels_demo.html?symbol=%SYMBOL%"

echo [UIrun] UI otwarte: http://%UI_HOST%:%UI_SELECTED_PORT%/channels_demo.html?symbol=%SYMBOL%
