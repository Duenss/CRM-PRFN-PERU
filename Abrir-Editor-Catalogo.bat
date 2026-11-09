@echo off
title Editor del catalogo - Perfumeria Fina
cd /d "%~dp0"
echo.
echo   Abriendo el editor del catalogo...
echo   Cuando termine, cerra esta ventana para apagarlo.
echo.
start "" http://127.0.0.1:4321
node scripts\catalogo\editor\server.mjs
pause
