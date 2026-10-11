@echo off
rem Moving day: writes the Mac package (SalonBoard-Mac-*.zip on the Desktop) from this top folder, then pauses both
rem copies here. Copied here from app\mens\layout by its layout:sync script. ASCII commands only before chcp.
chcp 65001 > nul
if not exist "%~dp0app\mens\package.json" goto no_mens
cd /d "%~dp0app\mens"
call npm.cmd run export:mac
set "EXIT_CODE=%ERRORLEVEL%"
echo.
pause
exit /b %EXIT_CODE%

:no_mens
echo メンズのツール（app\mens フォルダ）が見つからないため、書き出せません。開発担当に連絡してください。
pause
exit /b 2
