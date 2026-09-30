@echo off
rem Luma Arcade: starts an EasyRPG game (ES-DE's easyrpg system) with its
rem saves in saves\<game> next to Player.exe instead of in the game's own
rem folder, so profiles.ps1 can swap them per player (slot EasyRPG-saves).
rem Deployed to G:\ES-DE\Emulators\EasyRPG\luma-easyrpg.bat; ES-DE runs it
rem from C:\Users\Arcade\ES-DE\custom_systems\es_systems.xml.
rem   luma-easyrpg.bat <game folder or .zip>
setlocal
set "GAME=%~1"
set "SAVES=%~dp0saves\%~n1"
if not exist "%SAVES%" mkdir "%SAVES%"
"%~dp0Player.exe" --project-path "%GAME%" --save-path "%SAVES%" --fullscreen
