@echo off
chcp 65001 >nul
setlocal

REM Daepamilsudan single runner
REM Frontend is static HTML/CSS/JS, backend (FastAPI) serves it.

cd /d "%~dp0"

start "DaepamilSudan" cmd /k "cd /d %~dp0backend && python -m uvicorn main:app --host 0.0.0.0 --port 8000 --reload"

echo.
echo Server: http://127.0.0.1:8000
echo.
endlocal
