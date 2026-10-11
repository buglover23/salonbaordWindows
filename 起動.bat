@echo off
rem Top folder of the shared layout: starts app\mens and app\ladies, each in its own window running that copy's
rem own start file. Copied here from app\mens\layout by its layout:sync script. ASCII commands only before chcp.
chcp 65001 > nul
set "MISSING="
rem Each folder comes in through a for variable, so a path with spaces, & or parentheses still reaches the new window quoted.
if not exist "%~dp0app\mens\起動.bat" goto no_mens
for %%D in ("%~dp0app\mens") do start "" cmd /c ""%%~fD\起動.bat""
goto ladies

:no_mens
echo メンズのツール（app\mens フォルダの 起動.bat）が見つからないため、メンズは起動しませんでした。
set "MISSING=1"

:ladies
if not exist "%~dp0app\ladies\起動.bat" goto no_ladies
for %%D in ("%~dp0app\ladies") do start "" cmd /c ""%%~fD\起動.bat""
goto done

:no_ladies
echo レディースのツール（app\ladies フォルダの 起動.bat）が見つからないため、レディースは起動しませんでした。
set "MISSING=1"

:done
if not defined MISSING exit /b 0
echo フォルダの置き方がわからないときは、開発担当に連絡してください。
pause
exit /b 0
