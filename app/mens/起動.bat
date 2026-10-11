@echo off
rem SALON BOARD auto poster: double-click to start (spec 16.7). ASCII commands only; Japanese messages after chcp.
chcp 65001 > nul
cd /d "%~dp0"
rem The window title names this folder, so two copies of the tool (two logins) can be told apart.
rem A for variable, not %VAR%: a folder name with & or ^ must not be read as commands.
for %%I in ("%~dp0.") do title SALON BOARD auto poster - %%~nxI
where node > nul 2> nul
if errorlevel 1 goto no_node
if not exist "dist\src\launcher.js" goto no_build
node dist\src\launcher.js
set "EXIT_CODE=%ERRORLEVEL%"
if "%EXIT_CODE%"=="0" goto done
echo.
echo ツールが止まりました（終了コード %EXIT_CODE%）。上の表示を確認してください。詳しくは logs フォルダの記録にあります。
:done
pause
exit /b %EXIT_CODE%

:no_node
echo Node.js が見つかりません。README の「必要なもの」を見て Node.js 24 LTS を入れてから、もう一度ダブルクリックしてください。
pause
exit /b 2

:no_build
echo プログラムが組み立てられていません（dist\src\launcher.js がありません）。
echo README の「初回の手順」の npm.cmd ci と npm.cmd run build を済ませてから、もう一度ダブルクリックしてください。
pause
exit /b 2
