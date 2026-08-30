@echo off
setlocal
cd /d "%~dp0"

echo [clean] Cleaning old run artifacts...

rem CSV run files (keeps test files like test.csv/testOffline.csv)
del /q "CSV\Start *.csv" 2>nul

rem UI/runtime bridge files
del /q "scripts\logs\bot_ui_state.json" 2>nul
del /q "scripts\logs\bot_ui_logs.ndjson" 2>nul
del /q "scripts\logs\bot_ui_cmd.json" 2>nul
del /q "scripts\logs\runtime_state_*.json" 2>nul
del /q "scripts\logs\bot.instance.lock" 2>nul

rem Run exports
del /q "scripts\logs\runs\*.tsv" 2>nul
del /q "scripts\logs\runs\*.csv" 2>nul
del /q "scripts\logs\runs\*.json" 2>nul

rem Demo outputs
del /q "demo_out\*.json" 2>nul

rem Analyzer data (indicator_history + market_history used by throttling_demo.html)
del /q "scripts\logs\indicator_history.json" 2>nul
del /q "scripts\logs\market_history.jsonl" 2>nul
del /q "scripts\logs\market_history_5m.csv" 2>nul

echo [clean] Done.
echo [clean] Next start should begin with a fresh runtime/log state.
endlocal
