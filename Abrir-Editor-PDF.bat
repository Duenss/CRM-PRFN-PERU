@echo off
title Editor de PDF - Perfumeria Fina
cd /d "%~dp0"
echo.
echo   Abriendo el editor de PDF...
echo   Cerra esta ventana para apagarlo.
echo.
start "" http://127.0.0.1:4322
python scripts\catalogo\editor-pdf\server.py
pause
