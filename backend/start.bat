@echo off
:: Keep batch file ASCII only (cmd codepage issues)
setlocal EnableExtensions
chcp 65001 >nul
cd /d "%~dp0."

:: Default port: keep in sync with frontend config if any
set "PY_PORT=8002"

set "VENV_PY=%~dp0venv\Scripts\python.exe"

if exist "%VENV_PY%" goto HAS_VENV
echo [1/3] Creating venv...
python -m venv venv
if exist "%VENV_PY%" goto HAS_VENV
echo ERROR: Cannot create venv. Check Python on PATH.
pause
exit /b 1

:HAS_VENV
echo ============================================
echo   math-app backend  http://127.0.0.1:%PY_PORT%
echo   Python: %VENV_PY%
echo ============================================

echo [2/3] pip...
"%VENV_PY%" -m pip install --upgrade pip -q
"%VENV_PY%" -m pip install -r requirements.txt -q

echo [3/3] uvicorn...
echo.
echo http://127.0.0.1:%PY_PORT% (Ctrl+C to stop)
echo.
"%VENV_PY%" -m uvicorn server:app --host 127.0.0.1 --port %PY_PORT% --reload
pause

