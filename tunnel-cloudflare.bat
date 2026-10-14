@echo off
rem Macht den laufenden Big-Leagues-Server (start.bat) ueber einen Cloudflare-Tunnel erreichbar.
rem Gratis, ohne Konto, ohne Zeitlimit und ohne Warnseite. Der Link aendert sich bei jedem Start.

set "CF=cloudflared"
where cloudflared >nul 2>nul || (
    if exist "C:\Program Files (x86)\cloudflared\cloudflared.exe" set "CF=C:\Program Files (x86)\cloudflared\cloudflared.exe"
    if exist "C:\Program Files\cloudflared\cloudflared.exe" set "CF=C:\Program Files\cloudflared\cloudflared.exe"
)
"%CF%" --version >nul 2>nul || (
    echo cloudflared ist nicht installiert. Installieren mit:
    echo     winget install --id Cloudflare.cloudflared
    pause
    goto :eof
)

echo.
echo ============================================================
echo  Cloudflare-Tunnel startet ... (Beenden: Fenster schliessen)
echo  Gleich erscheint ein Link wie https://xxxx-xxxx.trycloudflare.com
echo  Den an deine Freunde schicken.
echo ============================================================
echo.
"%CF%" tunnel --no-autoupdate --url http://localhost:8000
pause
