@echo off
rem Macht den laufenden Big-Leagues-Server (start.bat) ueber Pinggy im Internet erreichbar.
rem Der Gratis-Tunnel laeuft 60 Minuten - danach baut dieses Fenster automatisch einen neuen auf.
rem Achtung: Jeder neue Tunnel hat einen NEUEN Link.

rem Das SSH von Git funktioniert mit Pinggy, das in Windows eingebaute oft nicht.
set "SSH=C:\Program Files\Git\usr\bin\ssh.exe"
if not exist "%SSH%" set "SSH=ssh"

:loop
echo.
echo ============================================================
echo  Pinggy-Tunnel wird gestartet ... (Beenden: Fenster schliessen)
echo  Den https-Link unten an deine Freunde schicken.
echo  Beim ersten Oeffnen auf "Enter site" klicken.
echo ============================================================
"%SSH%" -T -p 443 -o StrictHostKeyChecking=accept-new -o ServerAliveInterval=30 -o ServerAliveCountMax=3 -R0:localhost:8000 a.pinggy.io
echo.
echo Tunnel beendet - neuer Tunnel in 5 Sekunden (neuer Link!) ...
timeout /t 5 /nobreak >nul
goto loop
