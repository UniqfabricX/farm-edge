@echo off
chcp 65001 >nul
title Farm Edge — установка
cd /d "%~dp0"
echo.
echo  Farm Edge — подключение домашней фермы к farm.5dsap.ru
echo  -------------------------------------------------------
echo  Нужен код из облака: Администрирование → Получить код привязки
echo.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0Setup-FarmEdge.ps1"
if errorlevel 1 pause
