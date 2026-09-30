@echo off
rem Luma Arcade: starts a DOS game (ES-DE's dos and pc systems) in DOSBox
rem Staging with an overlay on drive C: the game's folder is never written
rem to; everything the game saves goes to saves\<game> next to dosbox.exe,
rem which profiles.ps1 swaps per player (slot DOSBox-saves).
rem Deployed to G:\ES-DE\Emulators\dosbox-staging\luma-dosbox.bat; ES-DE runs
rem it from C:\Users\Arcade\ES-DE\custom_systems\es_systems.xml.
rem   luma-dosbox.bat <game folder, or its .bat/.exe/.com>
rem Anything else (.conf, disc and disk images, .zip) starts the plain way.
setlocal
set "ROM=%~1"
set "DOSBOX=%~dp0dosbox.exe"
set "NAME=%~n1"

if exist "%ROM%\" (
    rem A game folder: run its dosbox.bat, else its only .bat.
    set "GAMEDIR=%~f1"
    set "RUN="
    if exist "%ROM%\dosbox.bat" set "RUN=dosbox.bat"
    if not defined RUN for %%F in ("%ROM%\*.bat") do set "RUN=%%~nxF"
    goto overlay
)
set "EXT=%~x1"
if /i "%EXT%"==".bat" goto file
if /i "%EXT%"==".exe" goto file
if /i "%EXT%"==".com" goto file
"%DOSBOX%" "%ROM%"
exit /b

:file
set "GAMEDIR=%~dp1"
set "GAMEDIR=%GAMEDIR:~0,-1%"
set "RUN=%~nx1"

:overlay
set "SAVES=%~dp0saves\%NAME%"
if not exist "%SAVES%" mkdir "%SAVES%"
if not defined RUN (
    "%DOSBOX%" -c "mount c \"%GAMEDIR%\"" -c "mount -t overlay c \"%SAVES%\"" -c "c:"
    exit /b
)
rem --exit: DOSBox closes when the game does (a DOS prompt is a dead end
rem with a controller); "-c exit" doesn't do it in DOSBox Staging 0.82.
"%DOSBOX%" --exit -c "mount c \"%GAMEDIR%\"" -c "mount -t overlay c \"%SAVES%\"" -c "c:" -c "call %RUN%"
