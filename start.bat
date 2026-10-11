@echo off
rem Startet den Big-Leagues-Server. Beim ersten Mal wird die Python-Umgebung eingerichtet.
cd /d "%~dp0"
if not exist .venv\Scripts\python.exe (
    echo Richte Python-Umgebung ein...
    python -m venv .venv || goto :error
)
.venv\Scripts\python -m pip install -q --disable-pip-version-check -r requirements.txt || goto :error

rem Neue Ability-/PlayStyle-Bilder aufbereiten (Hintergrund entfernen, umbenennen)
set PYTHONIOENCODING=utf-8
.venv\Scripts\python tools\prepare_icons.py

echo.
echo Big Leagues laeuft auf http://localhost:8000  (Beenden mit Strg+C)
echo.
.venv\Scripts\python -m uvicorn server.app:app --port 8000
goto :eof

:error
echo Einrichtung fehlgeschlagen. Ist Python 3.10+ installiert?
pause
