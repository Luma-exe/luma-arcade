Unicode true

!define APP_NAME "LumaArcade"
!define APP_TITLE "Luma Arcade"
!define APP_PUBLISHER "LumaArcade"
; build.mjs passes the version from package.json.
!ifndef APP_VERSION
  !define APP_VERSION "0.0.0"
!endif
!define APP_URL "https://github.com/Luma-exe/luma-arcade"
!define UNINST_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APP_NAME}"
; What was picked, so an upgrade (or the uninstaller) knows.
!define SETTINGS_KEY "Software\${APP_NAME}"
; 64-bit PowerShell from this 32-bit installer (plain $SYSDIR would give the
; 32-bit one: Program Files (x86), redirected registry).
!define POWERSHELL "$WINDIR\Sysnative\WindowsPowerShell\v1.0\powershell.exe"
; LumaArcade's port (web/config/settings.ts) and the HTTPS one next to it.
!define LUMA_PORT 7777
!define HTTPS_PORT 7778

Name "${APP_TITLE}"
; The exe's Properties > Details.
VIProductVersion "${APP_VERSION}.0"
VIAddVersionKey "ProductName" "${APP_TITLE}"
VIAddVersionKey "ProductVersion" "${APP_VERSION}"
VIAddVersionKey "FileVersion" "${APP_VERSION}"
VIAddVersionKey "FileDescription" "${APP_TITLE} Setup"
VIAddVersionKey "CompanyName" "${APP_PUBLISHER}"
VIAddVersionKey "LegalCopyright" "GPL-3.0-or-later"
OutFile "output\LumaArcadeSetup.exe"
InstallDir "$PROGRAMFILES64\${APP_NAME}"
; Admin: Sunshine, Windows accounts, drivers, the Server fixes and the
; shared games folder all need it.
RequestExecutionLevel admin
ShowInstDetails hide
ShowUninstDetails hide

; ---------------------------------------------------------------- look
; Current Windows controls (not the Windows 95 ones), sharp on high-DPI
; screens, in Windows' own font. The artwork comes from art\make-art.ps1.
XPStyle on
ManifestDPIAware true
ManifestSupportedOS all
SetFont "Segoe UI" 9
BrandingText " "
; The website's colours (server/src/web/pages/howitworks.html).
!define NAVY 0B1730      ; page header (art\header.bmp's background)
!define INK 10233B       ; text
!define MUTED 5B6B80     ; explanations under an option
!define SOFT_BLUE A9C4EA ; the header's second line

!include "MUI2.nsh"
!include "nsDialogs.nsh"
!include "LogicLib.nsh"
!include "Sections.nsh"
!include "x64.nsh"
!include "FileFunc.nsh"

!define MUI_ABORTWARNING
!define MUI_ICON "art\setup.ico"
!define MUI_UNICON "art\setup.ico"
!define MUI_HEADERIMAGE
!define MUI_HEADERIMAGE_RIGHT
!define MUI_HEADERIMAGE_BITMAP "art\header.bmp"
!define MUI_HEADERIMAGE_UNBITMAP "art\header.bmp"
!define MUI_WELCOMEFINISHPAGE_BITMAP "art\side.bmp"
!define MUI_UNWELCOMEFINISHPAGE_BITMAP "art\side.bmp"
; Welcome and finish pages: white, like the pages in between.
!define MUI_BGCOLOR FFFFFF
!define MUI_TEXTCOLOR ${INK}
!define MUI_COMPONENTSPAGE_SMALLDESC
!define MUI_CUSTOMFUNCTION_GUIINIT StyleWindow
!define MUI_CUSTOMFUNCTION_UNGUIINIT un.StyleWindow

; ---------------------------------------------------------------- state
Var SetupType        ; 0 = everything (streaming), 1 = ES-DE + emulators, 2 = emulators only
Var SetupTypeApplied ; the type the component selection was last set up for
Var IsUpgrade        ; 1 = Luma Arcade is already installed in $INSTDIR
Var Mode             ; already installed: 0 = update or change, 1 = repair, 2 = uninstall
Var LumaWasRunning   ; stop-luma.ps1's answer: 0 no, 2 yes, 3 yes and streaming
Var IsServer         ; 1 = Windows Server
Var DetectedServer
Var Ds4              ; 1 = Sunshine emulates PS4 pads (no Xbox 360 driver)
Var HwEncoder        ; the graphics card Sunshine can encode with ("" = none)
Var HwMonitors       ; physical monitors plugged in
Var HwVdd            ; 1 = virtual display driver installed
Var HwXusb           ; 1 = Xbox 360 controller driver installed
Var HwVigem          ; 1 = ViGEmBus (virtual controllers) installed
Var WantVdd
Var WantXusb
Var WantVigem
Var SeparateAccount  ; 1 = run under its own Windows account
Var AccountName
Var AccountPass
Var AutoLogon
Var StartAtLogon
Var AdminName        ; the first Luma Arcade account (admin) and Sunshine's sign-in
Var AdminPass
Var HttpsOn
Var TunnelToken
Var Latest           ; 1 = newest downloads instead of the tested versions (/LATEST)
Var GamesDir
Var EsDeExe
Var EmuList
Var CurrentUser
Var Opts             ; the command line
Var Str1             ; StrHas: haystack, needle, answer
Var Str2
Var Str3

; page controls
Var hMode0
Var hMode1
Var hMode2
Var hType0
Var hType1
Var hType2
Var hClient
Var hServer
Var hPadX360
Var hPadDs4
Var hVdd
Var hVigem
Var hXusb
Var hCurrent
Var hSeparate
Var hName
Var hPass
Var hPass2
Var hAutoLogon
Var hStartAtLogon
Var hAdminName
Var hAdminPass
Var hAdminPass2
Var hHttps
Var hToken

; uninstaller
Var UnAccount
Var UnSeparate
Var UnAutoLogon
Var UnGamesDir

; ---------------------------------------------------------------- pages
!define MUI_WELCOMEPAGE_TITLE "Welcome to ${APP_TITLE}"
!define MUI_WELCOMEPAGE_TEXT "Turn this PC into a game console you can play from any web browser - on your TV, laptop or phone, at home or away.$\r$\n$\r$\nNext, pick what to install: everything for streaming, just ES-DE and the emulators to play on this PC, or only the emulators.$\r$\n$\r$\nES-DE and the emulators are downloaded from their official releases (versions tested with Luma Arcade), so this PC needs to be online.$\r$\n$\r$\nAlready installed? Next you can update it, repair it, or remove some or all of it - your accounts, settings and games are kept unless you say otherwise."
!define MUI_PAGE_CUSTOMFUNCTION_SHOW WelcomeShow
!insertmacro MUI_PAGE_WELCOME
Page custom MaintenancePage MaintenanceLeave
Page custom SetupTypePage SetupTypeLeave
!define MUI_PAGE_CUSTOMFUNCTION_PRE ComponentsPre
!insertmacro MUI_PAGE_COMPONENTS
Page custom WindowsPage WindowsLeave
Page custom HardwarePage HardwareLeave
Page custom ControllersPage ControllersLeave
Page custom AccountPage AccountLeave
Page custom AdminPage AdminLeave
Page custom NetworkPage NetworkLeave

!define MUI_PAGE_HEADER_TEXT "Luma Arcade folder"
!define MUI_PAGE_HEADER_SUBTEXT "Where the Luma Arcade website and streaming server go."
!define MUI_PAGE_CUSTOMFUNCTION_PRE LumaDirPre
!insertmacro MUI_PAGE_DIRECTORY

!define MUI_PAGE_HEADER_TEXT "Games folder"
!define MUI_PAGE_HEADER_SUBTEXT "Where ES-DE, the emulators and your games go."
!define MUI_DIRECTORYPAGE_TEXT_TOP "ES-DE and the emulators are installed here, and your games (ROMs) go in here too - pick a drive with plenty of space. Every account on this PC will be able to use it."
!define MUI_DIRECTORYPAGE_TEXT_DESTINATION "Games folder"
!define MUI_DIRECTORYPAGE_VARIABLE $GamesDir
!define MUI_PAGE_CUSTOMFUNCTION_PRE GamesDirPre
!insertmacro MUI_PAGE_DIRECTORY

!insertmacro MUI_PAGE_INSTFILES

!define MUI_FINISHPAGE_TITLE "You're all set"
!define MUI_FINISHPAGE_TEXT "Setup is done. The next steps (signing in, playing from other devices, where games and BIOS files go) are in the file below."
!define MUI_FINISHPAGE_SHOWREADME ""
!define MUI_FINISHPAGE_SHOWREADME_TEXT "Show the next steps"
!define MUI_FINISHPAGE_SHOWREADME_FUNCTION ShowNextSteps
!define MUI_FINISHPAGE_RUN ""
!define MUI_FINISHPAGE_RUN_TEXT "Open Luma Arcade now"
!define MUI_FINISHPAGE_RUN_FUNCTION LaunchApp
!define MUI_PAGE_CUSTOMFUNCTION_SHOW FinishShow
!insertmacro MUI_PAGE_FINISH

!define MUI_PAGE_HEADER_TEXT "What to remove"
!define MUI_PAGE_HEADER_SUBTEXT "Tick exactly what should go. Only what this PC has is listed."
!define MUI_COMPONENTSPAGE_TEXT_TOP "Pick a ready-made choice, or tick things one by one - just ES-DE, just Sunshine, just one emulator, or everything."
!define MUI_PAGE_CUSTOMFUNCTION_LEAVE un.ComponentsLeave
!insertmacro MUI_UNPAGE_COMPONENTS
!insertmacro MUI_UNPAGE_INSTFILES

!insertmacro MUI_LANGUAGE "English"

; ---------------------------------------------------------------- styling
Var FontStrong       ; an option's name
Var FontHeader       ; the page header's title
Var FontWelcome      ; the welcome and finish pages' title

; A navy header with white text, without the lines and the empty branding
; line around it. Runs once, when the window opens.
!macro StyleWindow
  CreateFont $FontStrong "Segoe UI Semibold" 9 600
  CreateFont $FontHeader "Segoe UI Semibold" 10 600
  CreateFont $FontWelcome "Segoe UI Semibold" 15 600
  SetCtlColors $mui.Header.Background "" ${NAVY}
  SetCtlColors $mui.Header.Image "" ${NAVY}
  SetCtlColors $mui.Header.Text FFFFFF ${NAVY}
  SetCtlColors $mui.Header.SubText ${SOFT_BLUE} ${NAVY}
  SendMessage $mui.Header.Text ${WM_SETFONT} $FontHeader 1
  GetDlgItem $0 $HWNDPARENT 1035 ; the line under the header
  ShowWindow $0 ${SW_HIDE}
  GetDlgItem $0 $HWNDPARENT 1028 ; branding text
  ShowWindow $0 ${SW_HIDE}
  GetDlgItem $0 $HWNDPARENT 1256 ; branding text's shadow
  ShowWindow $0 ${SW_HIDE}
!macroend
Function StyleWindow
  !insertmacro StyleWindow
FunctionEnd
Function un.StyleWindow
  !insertmacro StyleWindow
FunctionEnd

; An option's name in semibold, and the explanation under it in grey.
!macro Strong HWND
  SendMessage ${HWND} ${WM_SETFONT} $FontStrong 1
!macroend
!macro Muted HWND
  SetCtlColors ${HWND} ${MUTED} transparent
!macroend

Function WelcomeShow
  SendMessage $mui.WelcomePage.Title ${WM_SETFONT} $FontWelcome 1
FunctionEnd

; ---------------------------------------------------------------- helpers
!macro RunPs SCRIPT ARGS
  nsExec::ExecToLog '"${POWERSHELL}" -NoProfile -ExecutionPolicy Bypass -File "$PLUGINSDIR\scripts\${SCRIPT}" ${ARGS}'
  Pop $0
!macroend

; A folder path safe to quote on a command line ("C:\" would end in \").
!macro QuotablePath OUT PATH
  StrCpy ${OUT} "${PATH}"
  StrCpy $R9 ${OUT} 1 -1
  ${If} $R9 == "\"
    StrCpy ${OUT} "${OUT}."
  ${EndIf}
!macroend

; A secret for a script, in a file (deleted by the script) - never on a
; command line other programs can read. UTF-16 with a byte order mark.
!macro WriteSecret FILE LINE1 LINE2
  FileOpen $9 "${FILE}" w
  FileWriteWord $9 0xFEFF
  FileWriteUTF16LE $9 "${LINE1}"
  ${If} "${LINE2}" != ""
    FileWriteUTF16LE $9 "$\r$\n${LINE2}"
  ${EndIf}
  FileClose $9
!macroend

; $Str3 = 1 if $Str1 contains $Str2 (not case sensitive), else 0.
Function StrHas
  Push $R0
  Push $R1
  Push $R2
  StrLen $R0 $Str2
  StrCpy $R1 0
  StrCpy $Str3 0
  ${Do}
    StrCpy $R2 $Str1 $R0 $R1
    ${If} $R2 == ""
      ${Break}
    ${EndIf}
    ${If} $R2 == $Str2
      StrCpy $Str3 1
      ${Break}
    ${EndIf}
    IntOp $R1 $R1 + 1
  ${Loop}
  Pop $R2
  Pop $R1
  Pop $R0
FunctionEnd

; A repair or an uninstall skips every question page.
!macro OnlyWhenChanging
  ${If} $Mode != 0
    Abort
  ${EndIf}
!macroend

; ---------------------------------------------------------------- sections
; Secrets for the steps below, written before anything runs.
Section "-Prepare"
  ${If} $AdminName != ""
  ${AndIf} $AdminPass != ""
  ${AndIfNot} ${FileExists} "$PLUGINSDIR\admin.txt"
    !insertmacro WriteSecret "$PLUGINSDIR\admin.txt" $AdminName $AdminPass
  ${EndIf}
  StrCpy $AdminPass ""
  Call FindEsDe
SectionEnd

Section "Luma Arcade" SEC_LUMA
  ; An upgrade: stop the running copy (its files are in use), keeping its
  ; database, accounts, paired PCs and settings.
  ${If} ${FileExists} "$INSTDIR\server\dist\main.js"
    StrCpy $IsUpgrade 1
    !insertmacro QuotablePath $2 $INSTDIR
    !insertmacro RunPs "stop-luma.ps1" '-LumaDir "$2"'
    StrCpy $LumaWasRunning $0
    ; The old build's files, so nothing stale is left behind.
    RMDir /r "$INSTDIR\server\dist"
    RMDir /r "$INSTDIR\server\node_modules"
    RMDir /r "$INSTDIR\moonlight-web-stream\static"
    RMDir /r "$INSTDIR\host"
  ${EndIf}

  SetOutPath "$INSTDIR"
  File /r "staging\*.*"
  File "NEXT-STEPS.txt"
  ; moonlight-web-stream's settings: the shipped defaults only on a fresh
  ; install (an upgrade keeps any changes, like session_cookie_secure).
  ${IfNot} ${FileExists} "$INSTDIR\moonlight-web-stream\server\config.json"
    CopyFiles /SILENT "$INSTDIR\moonlight-web-stream\server\config.default.json" "$INSTDIR\moonlight-web-stream\server\config.json"
  ${EndIf}
  ; For the uninstaller.
  SetOutPath "$INSTDIR\setup"
  File "scripts\common.ps1"
  File "scripts\uninstall-host.ps1"

  WriteUninstaller "$INSTDIR\Uninstall.exe"

  SetShellVarContext all
  CreateDirectory "$SMPROGRAMS\${APP_TITLE}"
  CreateShortcut "$SMPROGRAMS\${APP_TITLE}\${APP_TITLE}.lnk" "wscript.exe" \
    '"$INSTDIR\LumaArcade.vbs"' "$INSTDIR\node.exe"
  CreateShortcut "$SMPROGRAMS\${APP_TITLE}\Uninstall ${APP_TITLE}.lnk" "$INSTDIR\Uninstall.exe"

  SetRegView 64
  WriteRegStr HKLM "${UNINST_KEY}" "DisplayName" "${APP_TITLE}"
  WriteRegStr HKLM "${UNINST_KEY}" "UninstallString" '"$INSTDIR\Uninstall.exe"'
  WriteRegStr HKLM "${UNINST_KEY}" "QuietUninstallString" '"$INSTDIR\Uninstall.exe" /S'
  WriteRegStr HKLM "${UNINST_KEY}" "InstallLocation" "$INSTDIR"
  WriteRegStr HKLM "${UNINST_KEY}" "Publisher" "${APP_PUBLISHER}"
  WriteRegStr HKLM "${UNINST_KEY}" "DisplayVersion" "${APP_VERSION}"
  WriteRegStr HKLM "${UNINST_KEY}" "DisplayIcon" '"$INSTDIR\Uninstall.exe"'
  WriteRegStr HKLM "${UNINST_KEY}" "URLInfoAbout" "${APP_URL}"
  WriteRegDWORD HKLM "${UNINST_KEY}" "NoModify" 1
  WriteRegDWORD HKLM "${UNINST_KEY}" "NoRepair" 1
SectionEnd

; ES-DE and the emulators are downloaded together by the hidden "-Games"
; section below; these only record what was picked.
Section "ES-DE" SEC_ESDE
SectionEnd

SectionGroup "Emulators" SEC_EMUS
  Section "RetroArch - retro consoles" SEC_RETROARCH
  SectionEnd
  Section "Dolphin - GameCube, Wii" SEC_DOLPHIN
  SectionEnd
  Section "PCSX2 - PlayStation 2" SEC_PCSX2
  SectionEnd
  Section "DuckStation - PlayStation" SEC_DUCKSTATION
  SectionEnd
  Section "PPSSPP - PSP" SEC_PPSSPP
  SectionEnd
  Section "RPCS3 - PlayStation 3" SEC_RPCS3
  SectionEnd
  Section "Xenia Canary - Xbox 360" SEC_XENIA
  SectionEnd
  Section "xemu - original Xbox" SEC_XEMU
  SectionEnd
  Section "Cemu - Wii U" SEC_CEMU
  SectionEnd
  Section "Azahar - 3DS" SEC_AZAHAR
  SectionEnd
  Section "melonDS - DS" SEC_MELONDS
  SectionEnd
  Section "Vita3K - PS Vita" SEC_VITA3K
  SectionEnd
  Section "Flycast - Dreamcast" SEC_FLYCAST
  SectionEnd
  Section /o "shadPS4 - PS4 (experimental)" SEC_SHADPS4
  SectionEnd
SectionGroupEnd

!macro EmuArg SEC KEY
  ${If} ${SectionIsSelected} ${SEC}
    StrCpy $EmuList "$EmuList${KEY},"
  ${EndIf}
!macroend

!macro AllEmus MACRO
  !insertmacro ${MACRO} ${SEC_RETROARCH} "retroarch" "RetroArch-Win64"
  !insertmacro ${MACRO} ${SEC_DOLPHIN} "dolphin" "Dolphin-x64"
  !insertmacro ${MACRO} ${SEC_PCSX2} "pcsx2" "PCSX2-Qt"
  !insertmacro ${MACRO} ${SEC_DUCKSTATION} "duckstation" "duckstation"
  !insertmacro ${MACRO} ${SEC_PPSSPP} "ppsspp" "PPSSPP"
  !insertmacro ${MACRO} ${SEC_RPCS3} "rpcs3" "RPCS3"
  !insertmacro ${MACRO} ${SEC_XENIA} "xenia" "xenia_canary"
  !insertmacro ${MACRO} ${SEC_XEMU} "xemu" "xemu"
  !insertmacro ${MACRO} ${SEC_CEMU} "cemu" "cemu"
  !insertmacro ${MACRO} ${SEC_AZAHAR} "azahar" "azahar"
  !insertmacro ${MACRO} ${SEC_MELONDS} "melonds" "melonDS"
  !insertmacro ${MACRO} ${SEC_VITA3K} "vita3k" "Vita3K"
  !insertmacro ${MACRO} ${SEC_FLYCAST} "flycast" "flycast"
  !insertmacro ${MACRO} ${SEC_SHADPS4} "shadps4" "shadPS4"
!macroend

!macro EmuArg3 SEC KEY FOLDER
  !insertmacro EmuArg ${SEC} ${KEY}
!macroend

Section "-Games"
  ; Repair: ES-DE or emulators whose program has gone missing come back.
  ${If} $Mode == 1
    ${If} ${FileExists} "$GamesDir\*.*"
      DetailPrint "Checking ES-DE and the emulators..."
      !insertmacro QuotablePath $2 $GamesDir
      !insertmacro RunPs "install-games.ps1" '-GamesDir "$2" -Repair'
      ${If} $0 != 0
        MessageBox MB_ICONEXCLAMATION|MB_OK "Some of ES-DE or the emulators couldn't be put back - see the details list." /SD IDOK
      ${EndIf}
    ${EndIf}
    Return
  ${EndIf}
  StrCpy $EmuList ""
  !insertmacro AllEmus EmuArg3
  ${IfNot} ${SectionIsSelected} ${SEC_ESDE}
  ${AndIf} $EmuList == ""
    Return
  ${EndIf}
  DetailPrint "Downloading ES-DE and emulators (this can take a while)..."
  StrCpy $1 ""
  ${If} ${SectionIsSelected} ${SEC_ESDE}
    StrCpy $1 "-WithEsDe"
  ${EndIf}
  ${If} $Latest == 1
    StrCpy $1 "$1 -Latest"
  ${EndIf}
  !insertmacro QuotablePath $2 $GamesDir
  !insertmacro RunPs "install-games.ps1" '-GamesDir "$2" $1 -Emulators "$EmuList"'
  ${If} $0 != 0
    MessageBox MB_ICONEXCLAMATION|MB_OK "Some of ES-DE or the emulators couldn't be installed - see the details list. You can run $GamesDir\setup\install-games.ps1 again later." /SD IDOK
  ${EndIf}
SectionEnd

Section "Sunshine (streaming host)" SEC_SUNSHINE
  StrCpy $1 ""
  ${If} $EsDeExe != ""
    StrCpy $1 '-EsDeExe "$EsDeExe"'
  ${EndIf}
  ${If} $Ds4 == 1
    StrCpy $1 "$1 -Ds4"
  ${EndIf}
  ${If} ${FileExists} "$PLUGINSDIR\admin.txt"
    StrCpy $1 '$1 -AdminFile "$PLUGINSDIR\admin.txt"'
  ${EndIf}
  ${If} $Latest == 1
    StrCpy $1 "$1 -Latest"
  ${EndIf}
  !insertmacro RunPs "install-sunshine.ps1" $1
  ${If} $0 != 0
    MessageBox MB_ICONEXCLAMATION|MB_OK "Sunshine couldn't be installed - see the details list. You can install it by hand from github.com/LizardByte/Sunshine." /SD IDOK
  ${EndIf}
SectionEnd

Section "-Drivers"
  StrCpy $1 ""
  ${If} $WantVigem == 1
    StrCpy $1 "-ViGEm"
  ${EndIf}
  ${If} $WantXusb == 1
    StrCpy $1 "$1 -Xusb"
  ${EndIf}
  ${If} $WantVdd == 1
    SetOutPath "$PLUGINSDIR"
    File "staging\host\vdd_settings.xml"
    StrCpy $1 '$1 -VirtualDisplay -VddSettings "$PLUGINSDIR\vdd_settings.xml"'
  ${EndIf}
  ${If} $1 == ""
    Return
  ${EndIf}
  ${If} $Latest == 1
    StrCpy $1 "$1 -Latest"
  ${EndIf}
  !insertmacro RunPs "install-drivers.ps1" $1
  ${If} $0 != 0
    MessageBox MB_ICONEXCLAMATION|MB_OK "A driver couldn't be installed - see the details list." /SD IDOK
  ${EndIf}
SectionEnd

Section "-Windows setup"
  StrCpy $1 ""
  ${If} $IsServer == 1
    StrCpy $1 "-Server"
  ${EndIf}
  ${If} ${SectionIsSelected} ${SEC_LUMA}
    StrCpy $1 '$1 -LumaDir "$INSTDIR" -Port ${LUMA_PORT}'
    ${If} $StartAtLogon == 1
      StrCpy $1 "$1 -Autostart"
    ${EndIf}
    ${If} $SeparateAccount == 1
      StrCpy $1 '$1 -Account "$AccountName"'
      ${If} $AutoLogon == 1
        StrCpy $1 "$1 -AutoLogon"
      ${EndIf}
      ${If} $AccountPass != ""
        !insertmacro WriteSecret "$PLUGINSDIR\account.txt" $AccountPass ""
      ${EndIf}
      ${If} ${FileExists} "$PLUGINSDIR\account.txt"
        StrCpy $1 '$1 -PasswordFile "$PLUGINSDIR\account.txt"'
      ${EndIf}
    ${EndIf}
  ${EndIf}
  ${If} $1 == ""
    Return
  ${EndIf}
  !insertmacro RunPs "setup-windows.ps1" $1
  Delete "$PLUGINSDIR\account.txt"
  StrCpy $AccountPass ""
  ${If} $0 != 0
    MessageBox MB_ICONEXCLAMATION|MB_OK "Part of the Windows setup failed - see the details list." /SD IDOK
  ${EndIf}
SectionEnd

; The PC-side scripts behind lockdown, the Home button, the window picker,
; per-player saves, game tracking and the focus fix.
Section "-PC helpers"
  ${IfNot} ${SectionIsSelected} ${SEC_LUMA}
    Return
  ${EndIf}
  !insertmacro QuotablePath $2 $INSTDIR
  StrCpy $1 '-LumaDir "$2" -Port ${LUMA_PORT}'
  ${If} $SeparateAccount == 1
    StrCpy $1 '$1 -Account "$AccountName"'
  ${EndIf}
  ${If} $GamesDir != ""
  ${AndIf} ${FileExists} "$GamesDir\*.*"
    !insertmacro QuotablePath $3 $GamesDir
    StrCpy $1 '$1 -GamesDir "$3"'
  ${EndIf}
  ${If} $EsDeExe != ""
    StrCpy $1 '$1 -EsDeExe "$EsDeExe"'
  ${EndIf}
  !insertmacro RunPs "install-host.ps1" $1
  ${If} $0 != 0
    MessageBox MB_ICONEXCLAMATION|MB_OK "Luma Arcade's helper scripts couldn't all be set up - see the details list. Lockdown, the Home button and per-player saves need them." /SD IDOK
  ${EndIf}
SectionEnd

Section "-Network"
  ${IfNot} ${SectionIsSelected} ${SEC_LUMA}
    Return
  ${EndIf}
  ${If} $TunnelToken != ""
    !insertmacro WriteSecret "$PLUGINSDIR\tunnel.txt" $TunnelToken ""
    StrCpy $TunnelToken ""
  ${EndIf}
  StrCpy $1 ""
  ${If} $HttpsOn == 1
    StrCpy $1 "-HttpsPort ${HTTPS_PORT}"
  ${EndIf}
  ${If} ${FileExists} "$PLUGINSDIR\tunnel.txt"
    StrCpy $1 '$1 -TunnelTokenFile "$PLUGINSDIR\tunnel.txt"'
  ${EndIf}
  ${If} $1 == ""
    Return
  ${EndIf}
  ${If} $SeparateAccount == 1
    StrCpy $1 '$1 -Account "$AccountName"'
  ${EndIf}
  ${If} $Latest == 1
    StrCpy $1 "$1 -Latest"
  ${EndIf}
  !insertmacro QuotablePath $2 $INSTDIR
  !insertmacro RunPs "setup-network.ps1" '-LumaDir "$2" $1'
  Delete "$PLUGINSDIR\tunnel.txt"
  ${If} $0 != 0
    MessageBox MB_ICONEXCLAMATION|MB_OK "Setting up access from other devices partly failed - see the details list." /SD IDOK
  ${EndIf}
SectionEnd

; The first account and pairing with Sunshine: no manual steps after Setup.
Section "-First run"
  ${If} ${SectionIsSelected} ${SEC_LUMA}
  ${AndIf} ${FileExists} "$PLUGINSDIR\admin.txt"
    DetailPrint "Creating the admin account and pairing with Sunshine..."
    nsExec::ExecToLog '"$INSTDIR\node.exe" "$PLUGINSDIR\scripts\first-run.mjs" "$INSTDIR" "$PLUGINSDIR\admin.txt"'
    Pop $0
    ${If} $0 != 0
      MessageBox MB_ICONEXCLAMATION|MB_OK "The admin account or pairing with Sunshine didn't work - see the details list. The next steps file says how to do it by hand." /SD IDOK
    ${EndIf}
  ${EndIf}
  Delete "$PLUGINSDIR\admin.txt"
SectionEnd

Section "-Finish"
  SetRegView 64
  ${If} ${SectionIsSelected} ${SEC_LUMA}
    WriteRegDWORD HKLM "${SETTINGS_KEY}" "SetupType" $SetupType
    WriteRegStr HKLM "${SETTINGS_KEY}" "GamesDir" $GamesDir
    WriteRegDWORD HKLM "${SETTINGS_KEY}" "SeparateAccount" $SeparateAccount
    WriteRegStr HKLM "${SETTINGS_KEY}" "Account" $AccountName
    WriteRegDWORD HKLM "${SETTINGS_KEY}" "AutoLogon" $AutoLogon
    WriteRegDWORD HKLM "${SETTINGS_KEY}" "StartAtLogon" $StartAtLogon
    WriteRegDWORD HKLM "${SETTINGS_KEY}" "Https" $HttpsOn
  ${EndIf}

  ; Start Luma Arcade again after an upgrade (or now, for a games account
  ; that's already signed in). The task only runs while its account is.
  ${If} ${SectionIsSelected} ${SEC_LUMA}
  ${AndIf} $StartAtLogon == 1
    nsExec::Exec 'schtasks.exe /run /tn "\LumaArcade\LumaArcade"'
    Pop $0
  ${ElseIf} ${SectionIsSelected} ${SEC_LUMA}
  ${AndIf} $LumaWasRunning != 0
  ${AndIf} ${Silent}
    ; Through Explorer, so it runs as the signed-in user, not elevated.
    Exec '"$WINDIR\explorer.exe" "$INSTDIR\LumaArcade.vbs"'
  ${EndIf}
SectionEnd

; ES-DE: the one being installed, or one Setup installed before. (A
; function, after the sections: -Prepare runs first but can't name them.)
Function FindEsDe
  StrCpy $EsDeExe ""
  ${If} ${SectionIsSelected} ${SEC_ESDE}
  ${OrIf} ${FileExists} "$GamesDir\ES-DE\ES-DE.exe"
    StrCpy $EsDeExe "$GamesDir\ES-DE\ES-DE.exe"
  ${EndIf}
FunctionEnd

!insertmacro MUI_FUNCTION_DESCRIPTION_BEGIN
  !insertmacro MUI_DESCRIPTION_TEXT ${SEC_LUMA} "The Luma Arcade website: sign-in, the browser game streaming client (moonlight-web-stream), who may play when, and its helper scripts on this PC."
  !insertmacro MUI_DESCRIPTION_TEXT ${SEC_SUNSHINE} "Sunshine captures this PC's screen, sound and controllers for streaming. Already installed? Setup keeps yours and only adds what Luma Arcade needs to it."
  !insertmacro MUI_DESCRIPTION_TEXT ${SEC_ESDE} "ES-DE: a game library you browse with a controller. Finds and starts the emulators below."
  !insertmacro MUI_DESCRIPTION_TEXT ${SEC_EMUS} "Emulators, downloaded from their official releases. Ones already in the games folder start unticked - tick one to update it. BIOS and firmware files are not included."
  !insertmacro MUI_DESCRIPTION_TEXT ${SEC_RETROARCH} "RetroArch with cores for NES, SNES, Mega Drive, Master System, Game Boy (Color/Advance), N64, PC Engine, Atari 2600 and arcade."
  !insertmacro MUI_DESCRIPTION_TEXT ${SEC_DOLPHIN} "Dolphin: GameCube and Wii, in HD. Very mature - nearly every game runs."
  !insertmacro MUI_DESCRIPTION_TEXT ${SEC_PCSX2} "PCSX2: PlayStation 2, upscaled to HD. Needs a PS2 BIOS dumped from your console."
  !insertmacro MUI_DESCRIPTION_TEXT ${SEC_DUCKSTATION} "DuckStation: the original PlayStation, sharper than the real thing. Needs a PS1 BIOS dumped from your console."
  !insertmacro MUI_DESCRIPTION_TEXT ${SEC_PPSSPP} "PPSSPP: PSP, light enough for almost any PC. No BIOS needed."
  !insertmacro MUI_DESCRIPTION_TEXT ${SEC_RPCS3} "RPCS3: PlayStation 3. Many games run well on a strong processor. Needs the PS3 firmware from Sony's website."
  !insertmacro MUI_DESCRIPTION_TEXT ${SEC_XENIA} "Xenia Canary: Xbox 360. A good share of games run; some still have glitches."
  !insertmacro MUI_DESCRIPTION_TEXT ${SEC_XEMU} "xemu: the original Xbox. Needs BIOS and hard drive files dumped from your console."
  !insertmacro MUI_DESCRIPTION_TEXT ${SEC_CEMU} "Cemu: Wii U, in HD. Most of the big games run well."
  !insertmacro MUI_DESCRIPTION_TEXT ${SEC_AZAHAR} "Azahar: Nintendo 3DS, with both screens side by side or stacked. The successor to Citra."
  !insertmacro MUI_DESCRIPTION_TEXT ${SEC_MELONDS} "melonDS: Nintendo DS, with both screens. Light and accurate."
  !insertmacro MUI_DESCRIPTION_TEXT ${SEC_VITA3K} "Vita3K: PS Vita, experimental - a growing list of games run. Needs the Vita firmware from Sony's website."
  !insertmacro MUI_DESCRIPTION_TEXT ${SEC_FLYCAST} "Flycast: Dreamcast, plus the Naomi and Atomiswave arcade boards. Runs on almost any PC."
  !insertmacro MUI_DESCRIPTION_TEXT ${SEC_SHADPS4} "shadPS4: PlayStation 4, experimental - many games don't run yet."
!insertmacro MUI_FUNCTION_DESCRIPTION_END

; ---------------------------------------------------------------- init
Function .onInit
  ${IfNot} ${RunningX64}
    MessageBox MB_ICONSTOP "${APP_TITLE} needs 64-bit Windows." /SD IDOK
    SetErrorLevel 2
    Abort
  ${EndIf}
  SetRegView 64
  InitPluginsDir
  SetOutPath "$PLUGINSDIR\scripts"
  File "scripts\*.ps1"
  File "scripts\*.mjs"
  File "scripts\versions.json"
  File "scripts\es-de.png"

  ReadEnvStr $CurrentUser "USERNAME"
  StrCpy $SetupType 0
  StrCpy $SetupTypeApplied -1
  StrCpy $GamesDir "C:\Games"
  StrCpy $SeparateAccount 1
  StrCpy $AccountName "Arcade"
  StrCpy $AutoLogon 1
  StrCpy $StartAtLogon 1
  StrCpy $HttpsOn 1
  StrCpy $Latest 0
  StrCpy $IsUpgrade 0
  StrCpy $Mode 0
  StrCpy $LumaWasRunning 0

  ; An earlier install: same folder, same choices.
  ReadRegStr $0 HKLM "${UNINST_KEY}" "InstallLocation"
  ${If} $0 != ""
  ${AndIf} ${FileExists} "$0\server\dist\main.js"
    StrCpy $INSTDIR $0
    StrCpy $IsUpgrade 1
    ClearErrors
    ReadRegDWORD $1 HKLM "${SETTINGS_KEY}" "SetupType"
    ${IfNot} ${Errors}
      StrCpy $SetupType $1
      ReadRegStr $GamesDir HKLM "${SETTINGS_KEY}" "GamesDir"
      ReadRegDWORD $SeparateAccount HKLM "${SETTINGS_KEY}" "SeparateAccount"
      ReadRegStr $AccountName HKLM "${SETTINGS_KEY}" "Account"
      ReadRegDWORD $AutoLogon HKLM "${SETTINGS_KEY}" "AutoLogon"
      ReadRegDWORD $StartAtLogon HKLM "${SETTINGS_KEY}" "StartAtLogon"
      ReadRegDWORD $HttpsOn HKLM "${SETTINGS_KEY}" "Https"
    ${EndIf}
  ${EndIf}

  ReadRegStr $0 HKLM "SOFTWARE\Microsoft\Windows NT\CurrentVersion" "InstallationType"
  StrCpy $DetectedServer 0
  ${If} $0 == "Server"
    StrCpy $DetectedServer 1
  ${EndIf}
  StrCpy $IsServer $DetectedServer

  ; Graphics card, monitors, drivers.
  nsExec::Exec '"${POWERSHELL}" -NoProfile -ExecutionPolicy Bypass -File "$PLUGINSDIR\scripts\check-hardware.ps1" -Out "$PLUGINSDIR\hardware.ini"'
  Pop $0
  ReadINIStr $HwEncoder "$PLUGINSDIR\hardware.ini" "hw" "encoder"
  ReadINIStr $HwMonitors "$PLUGINSDIR\hardware.ini" "hw" "monitors"
  ReadINIStr $HwVdd "$PLUGINSDIR\hardware.ini" "hw" "vdd"
  ReadINIStr $HwXusb "$PLUGINSDIR\hardware.ini" "hw" "xusb"
  ReadINIStr $HwVigem "$PLUGINSDIR\hardware.ini" "hw" "vigem"
  ${If} $HwMonitors == ""
    ; The check couldn't run: assume a normal PC.
    StrCpy $HwMonitors 1
    StrCpy $HwVdd 0
    StrCpy $HwXusb 1
    StrCpy $HwVigem 0
  ${EndIf}
  StrCpy $WantVigem 0
  ${If} $HwVigem != 1
    StrCpy $WantVigem 1
  ${EndIf}
  StrCpy $WantVdd 0
  ${If} $HwMonitors == 0
  ${AndIf} $HwVdd != 1
    StrCpy $WantVdd 1
  ${EndIf}
  StrCpy $WantXusb 0
  ${If} $HwXusb != 1
    StrCpy $WantXusb 1
  ${EndIf}
  StrCpy $Ds4 0

  ${GetParameters} $Opts
  Call ReadOptions
  Call MarkInstalledComponents
  ${If} ${Silent}
    Call SilentSetup
  ${ElseIf} $IsUpgrade == 1
    ; Upgrading stops Luma Arcade, which drops anyone's stream.
    !insertmacro QuotablePath $2 $INSTDIR
    nsExec::Exec '"${POWERSHELL}" -NoProfile -ExecutionPolicy Bypass -File "$PLUGINSDIR\scripts\stop-luma.ps1" -LumaDir "$2" -CheckOnly'
    Pop $0
    ${If} $0 == 3
      MessageBox MB_YESNO|MB_ICONEXCLAMATION "Someone is streaming from this PC right now. Upgrading restarts Luma Arcade, which ends their stream (the game keeps running).$\r$\n$\r$\nUpgrade anyway?" IDYES +2
      Quit
    ${EndIf}
  ${EndIf}
FunctionEnd

; Command-line options (all optional; mostly for silent installs, /S):
;   /TYPE=everything|esde|emulators    /EMULATORS=all|none|retroarch,dolphin,...
;   /GAMESDIR=<folder>                 /D=<Luma Arcade folder> (last, no quotes)
;   /ACCOUNT=<name>|current            /PASSWORDFILE=<file with its password>
;   /NOAUTOLOGON  /NOAUTOSTART         /SERVER  /CLIENT  /DS4
;   /VDD  /NOVDD  /XUSB  /NOXUSB  /VIGEM  /NOVIGEM   (/DS4: PlayStation 4 pads, no Xbox 360 driver)
;   /ADMINFILE=<file: admin name, password on two lines>
;   /NOHTTPS  /TUNNELTOKENFILE=<file>  /LATEST (newest downloads, not the tested ones)
; Files given are copied, never changed or deleted.
Function ReadOptions
  ClearErrors
  ${GetOptions} $Opts "/TYPE=" $0
  ${IfNot} ${Errors}
    ${If} $0 == "esde"
      StrCpy $SetupType 1
    ${ElseIf} $0 == "emulators"
      StrCpy $SetupType 2
    ${Else}
      StrCpy $SetupType 0
    ${EndIf}
  ${EndIf}
  ClearErrors
  ${GetOptions} $Opts "/GAMESDIR=" $0
  ${IfNot} ${Errors}
    StrCpy $GamesDir $0
  ${EndIf}
  ClearErrors
  ${GetOptions} $Opts "/ACCOUNT=" $0
  ${IfNot} ${Errors}
    ${If} $0 == "current"
    ${OrIf} $0 == $CurrentUser
      StrCpy $SeparateAccount 0
    ${Else}
      StrCpy $SeparateAccount 1
      StrCpy $AccountName $0
    ${EndIf}
  ${EndIf}
  ClearErrors
  ${GetOptions} $Opts "/PASSWORDFILE=" $0
  ${IfNot} ${Errors}
    CopyFiles /SILENT "$0" "$PLUGINSDIR\account.txt"
  ${EndIf}
  ClearErrors
  ${GetOptions} $Opts "/ADMINFILE=" $0
  ${IfNot} ${Errors}
    CopyFiles /SILENT "$0" "$PLUGINSDIR\admin.txt"
  ${EndIf}
  ClearErrors
  ${GetOptions} $Opts "/TUNNELTOKENFILE=" $0
  ${IfNot} ${Errors}
    CopyFiles /SILENT "$0" "$PLUGINSDIR\tunnel.txt"
  ${EndIf}
  ClearErrors
  ${GetOptions} $Opts "/NOAUTOLOGON" $0
  ${IfNot} ${Errors}
    StrCpy $AutoLogon 0
  ${EndIf}
  ClearErrors
  ${GetOptions} $Opts "/NOAUTOSTART" $0
  ${IfNot} ${Errors}
    StrCpy $StartAtLogon 0
  ${EndIf}
  ClearErrors
  ${GetOptions} $Opts "/SERVER" $0
  ${IfNot} ${Errors}
    StrCpy $IsServer 1
  ${EndIf}
  ClearErrors
  ${GetOptions} $Opts "/CLIENT" $0
  ${IfNot} ${Errors}
    StrCpy $IsServer 0
  ${EndIf}
  ClearErrors
  ${GetOptions} $Opts "/DS4" $0
  ${IfNot} ${Errors}
    StrCpy $Ds4 1
    StrCpy $WantXusb 0
  ${EndIf}
  ClearErrors
  ${GetOptions} $Opts "/VDD" $0
  ${IfNot} ${Errors}
    StrCpy $WantVdd 1
  ${EndIf}
  ClearErrors
  ${GetOptions} $Opts "/NOVDD" $0
  ${IfNot} ${Errors}
    StrCpy $WantVdd 0
  ${EndIf}
  ClearErrors
  ${GetOptions} $Opts "/VIGEM" $0
  ${IfNot} ${Errors}
    StrCpy $WantVigem 1
  ${EndIf}
  ClearErrors
  ${GetOptions} $Opts "/NOVIGEM" $0
  ${IfNot} ${Errors}
    StrCpy $WantVigem 0
  ${EndIf}
  ClearErrors
  ${GetOptions} $Opts "/XUSB" $0
  ${IfNot} ${Errors}
    StrCpy $WantXusb 1
  ${EndIf}
  ClearErrors
  ${GetOptions} $Opts "/NOXUSB" $0
  ${IfNot} ${Errors}
    StrCpy $WantXusb 0
  ${EndIf}
  ClearErrors
  ${GetOptions} $Opts "/NOHTTPS" $0
  ${IfNot} ${Errors}
    StrCpy $HttpsOn 0
  ${EndIf}
  ClearErrors
  ${GetOptions} $Opts "/LATEST" $0
  ${IfNot} ${Errors}
    StrCpy $Latest 1
  ${EndIf}
FunctionEnd

!macro EmuOption SEC KEY FOLDER
  StrCpy $Str2 ",${KEY},"
  Call StrHas
  ${If} $Str3 == 1
    !insertmacro SelectSection ${SEC}
  ${Else}
    !insertmacro UnselectSection ${SEC}
  ${EndIf}
!macroend

; No pages to click through: apply the options and check what the pages would.
Function SilentSetup
  Call ComponentsPre
  ClearErrors
  ${GetOptions} $Opts "/EMULATORS=" $0
  ${IfNot} ${Errors}
    ${If} $0 == "all"
      StrCpy $Str1 ",retroarch,dolphin,pcsx2,duckstation,ppsspp,rpcs3,xenia,xemu,cemu,azahar,melonds,vita3k,flycast,shadps4,"
    ${Else}
      StrCpy $Str1 ",$0,"
    ${EndIf}
    !insertmacro AllEmus EmuOption
  ${EndIf}
  ${IfNot} ${SectionIsSelected} ${SEC_SUNSHINE}
    StrCpy $WantVdd 0
    StrCpy $WantVigem 0
    StrCpy $WantXusb 0
    StrCpy $Ds4 0
  ${EndIf}
  ${If} ${SectionIsSelected} ${SEC_LUMA}
  ${AndIf} $SeparateAccount == 1
    ; A new account needs a password.
    nsExec::Exec 'net.exe user "$AccountName"'
    Pop $0
    ${If} $0 != 0
    ${AndIfNot} ${FileExists} "$PLUGINSDIR\account.txt"
      MessageBox MB_ICONSTOP "The games account $AccountName doesn't exist: give its password with /PASSWORDFILE=<file>, or use /ACCOUNT=current." /SD IDOK
      SetErrorLevel 2
      Quit
    ${EndIf}
  ${EndIf}
FunctionEnd

; ---------------------------------------------------------------- setup type
Function SetupTypePage
  !insertmacro OnlyWhenChanging
  !insertmacro MUI_HEADER_TEXT "What do you want to install?" "You can change the exact list on the next page."
  nsDialogs::Create 1018
  Pop $0

  ${NSD_CreateRadioButton} 0 0 100% 12u "Everything: stream games to a web browser (recommended)"
  Pop $hType0
  !insertmacro Strong $hType0
  ${NSD_CreateLabel} 12u 13u -12u 26u "Luma Arcade + Sunshine + ES-DE + emulators. Play this PC's games from a browser on any device, share it with friends, with sign-in, play time limits and co-op."
  Pop $0
  !insertmacro Muted $0

  ${NSD_CreateRadioButton} 0 44u 100% 12u "ES-DE and emulators: play on this PC"
  Pop $hType1
  !insertmacro Strong $hType1
  ${NSD_CreateLabel} 12u 57u -12u 26u "A console-style game library for this PC, with a TV and controller. No streaming: no Sunshine, no website."
  Pop $0
  !insertmacro Muted $0

  ${NSD_CreateRadioButton} 0 88u 100% 12u "Just the emulators"
  Pop $hType2
  !insertmacro Strong $hType2
  ${NSD_CreateLabel} 12u 101u -12u 26u "Only the emulators, in one folder with Start menu shortcuts. For people who already use another front-end (or none)."
  Pop $0
  !insertmacro Muted $0

  ${If} $SetupType == 1
    ${NSD_Check} $hType1
  ${ElseIf} $SetupType == 2
    ${NSD_Check} $hType2
  ${Else}
    ${NSD_Check} $hType0
  ${EndIf}
  nsDialogs::Show
FunctionEnd

Function SetupTypeLeave
  ${NSD_GetState} $hType1 $0
  ${NSD_GetState} $hType2 $1
  ${If} $0 == ${BST_CHECKED}
    StrCpy $SetupType 1
  ${ElseIf} $1 == ${BST_CHECKED}
    StrCpy $SetupType 2
  ${Else}
    StrCpy $SetupType 0
  ${EndIf}
FunctionEnd

!macro Pick SEC ON
  !insertmacro ClearSectionFlag ${SEC} ${SF_RO}
  ${If} ${ON} == 1
    !insertmacro SelectSection ${SEC}
  ${Else}
    !insertmacro UnselectSection ${SEC}
  ${EndIf}
!macroend

!macro Lock SEC
  !insertmacro UnselectSection ${SEC}
  !insertmacro SetSectionFlag ${SEC} ${SF_RO}
!macroend

; Emulators already in the games folder (from an earlier Setup, or put
; there by hand) start unticked - tick one to update it - and say so in the
; list, so nobody downloads gigabytes again.
!macro UntickPresent SEC KEY FOLDER
  ${If} ${FileExists} "$GamesDir\ES-DE\Emulators\${FOLDER}\*.*"
  ${OrIf} ${FileExists} "$GamesDir\Emulators\${FOLDER}\*.*"
    !insertmacro UnselectSection ${SEC}
  ${EndIf}
!macroend

!macro MarkInstalled SEC
  SectionGetText ${SEC} $R9
  StrCpy $R8 $R9 "" -20
  ${If} $R8 != " (already installed)"
    SectionSetText ${SEC} "$R9 (already installed)"
  ${EndIf}
!macroend

!macro MarkPresent SEC KEY FOLDER
  ${If} ${FileExists} "$GamesDir\ES-DE\Emulators\${FOLDER}\*.*"
  ${OrIf} ${FileExists} "$GamesDir\Emulators\${FOLDER}\*.*"
    !insertmacro MarkInstalled ${SEC}
  ${EndIf}
!macroend

; Sets the component list up for the chosen type (only when it changed, so
; going Back and Next keeps someone's own ticks).
Function ComponentsPre
  !insertmacro OnlyWhenChanging
  ${If} $SetupType == $SetupTypeApplied
    Return
  ${EndIf}
  StrCpy $SetupTypeApplied $SetupType
  ${If} $SetupType == 0
    !insertmacro Pick ${SEC_LUMA} 1
    !insertmacro Pick ${SEC_SUNSHINE} 1
    !insertmacro Pick ${SEC_ESDE} 1
    ${If} ${FileExists} "$GamesDir\ES-DE\ES-DE.exe"
      !insertmacro UnselectSection ${SEC_ESDE}
    ${EndIf}
  ${ElseIf} $SetupType == 1
    !insertmacro Lock ${SEC_LUMA}
    !insertmacro Lock ${SEC_SUNSHINE}
    !insertmacro Pick ${SEC_ESDE} 1
    !insertmacro SetSectionFlag ${SEC_ESDE} ${SF_RO}
  ${Else}
    !insertmacro Lock ${SEC_LUMA}
    !insertmacro Lock ${SEC_SUNSHINE}
    !insertmacro Lock ${SEC_ESDE}
  ${EndIf}
  !insertmacro AllEmus UntickPresent
FunctionEnd

; "(already installed)" on what this PC has already: Sunshine (Setup keeps
; it and only adds what it needs), ES-DE and the emulators in the games folder.
Function MarkInstalledComponents
  SetRegView 64
  ClearErrors
  ReadRegStr $0 HKLM "SYSTEM\CurrentControlSet\Services\SunshineService" "ImagePath"
  ${IfNot} ${Errors}
    !insertmacro MarkInstalled ${SEC_SUNSHINE}
  ${EndIf}
  ${If} ${FileExists} "$GamesDir\ES-DE\ES-DE.exe"
    !insertmacro MarkInstalled ${SEC_ESDE}
  ${EndIf}
  !insertmacro AllEmus MarkPresent
FunctionEnd


; ---------------------------------------------------------------- already installed
Function MaintenancePage
  ${If} $IsUpgrade != 1
    Abort
  ${EndIf}
  !insertmacro MUI_HEADER_TEXT "Luma Arcade is already installed" "Update it, repair it, or remove some or all of it."
  nsDialogs::Create 1018
  Pop $0

  ${NSD_CreateRadioButton} 0 0 100% 12u "Update, or change what's installed"
  Pop $hMode0
  !insertmacro Strong $hMode0
  ${NSD_CreateLabel} 12u 13u -12u 20u "Installs this version and lets you add things - ES-DE, emulators, drivers. Your accounts, settings and games are kept."
  Pop $0
  !insertmacro Muted $0

  ${NSD_CreateRadioButton} 0 38u 100% 12u "Repair"
  Pop $hMode1
  !insertmacro Strong $hMode1
  ${NSD_CreateLabel} 12u 51u -12u 36u "No questions: puts Luma Arcade's files, helper scripts, scheduled tasks, firewall rules and Sunshine's setup back as they should be, with your current choices, and downloads ES-DE or any emulator whose program has gone missing. Your accounts, settings, games and saves are kept."
  Pop $0
  !insertmacro Muted $0

  ${NSD_CreateRadioButton} 0 92u 100% 12u "Uninstall"
  Pop $hMode2
  !insertmacro Strong $hMode2
  ${NSD_CreateLabel} 12u 105u -12u 28u "Pick exactly what to remove: Luma Arcade, its accounts, Sunshine, ES-DE, single emulators, the drivers, the games account - or everything. Your games folder is only deleted if you tick it."
  Pop $0
  !insertmacro Muted $0

  ${If} $Mode == 1
    ${NSD_Check} $hMode1
  ${ElseIf} $Mode == 2
    ${NSD_Check} $hMode2
  ${Else}
    ${NSD_Check} $hMode0
  ${EndIf}
  nsDialogs::Show
FunctionEnd

!macro UnselectEmu SEC KEY FOLDER
  !insertmacro UnselectSection ${SEC}
!macroend

Function MaintenanceLeave
  StrCpy $Mode 0
  ${NSD_GetState} $hMode1 $0
  ${If} $0 == ${BST_CHECKED}
    StrCpy $Mode 1
  ${EndIf}
  ${NSD_GetState} $hMode2 $0
  ${If} $0 == ${BST_CHECKED}
    StrCpy $Mode 2
  ${EndIf}

  ${If} $Mode == 2
    ; This version's uninstaller (with the full "what to remove" list),
    ; run in place for the install folder; Setup closes behind it.
    WriteUninstaller "$PLUGINSDIR\Uninstall.exe"
    HideWindow
    ExecWait '"$PLUGINSDIR\Uninstall.exe" _?=$INSTDIR'
    Quit
  ${EndIf}

  ${If} $Mode == 1
    ; Repair: Luma Arcade and Sunshine's setup again, with the saved
    ; choices; the games step only puts back what's missing.
    !insertmacro Pick ${SEC_LUMA} 1
    !insertmacro Pick ${SEC_SUNSHINE} 1
    !insertmacro UnselectSection ${SEC_ESDE}
    !insertmacro AllEmus UnselectEmu
  ${EndIf}
FunctionEnd


; ---------------------------------------------------------------- Windows edition
Function WindowsPage
  !insertmacro OnlyWhenChanging
  !insertmacro MUI_HEADER_TEXT "Which Windows is this?" "Windows Server needs a few extra fixes, which Setup can do."
  nsDialogs::Create 1018
  Pop $0

  StrCpy $1 ""
  StrCpy $2 ""
  ${If} $DetectedServer == 1
    StrCpy $2 " (detected)"
  ${Else}
    StrCpy $1 " (detected)"
  ${EndIf}
  ${NSD_CreateRadioButton} 0 0 100% 12u "Windows 10 or 11 (Home, Pro)$1"
  Pop $hClient
  !insertmacro Strong $hClient
  ${NSD_CreateRadioButton} 0 13u 100% 12u "Windows Server (2019, 2022, 2025)$2"
  Pop $hServer
  !insertmacro Strong $hServer
  ${If} $IsServer == 1
    ${NSD_Check} $hServer
  ${Else}
    ${NSD_Check} $hClient
  ${EndIf}

  ${NSD_CreateLabel} 0 30u 100% 108u "Most people should use normal Windows 10 or 11. Windows Server is worth it for a PC that does nothing but host games, 24/7: it doesn't force feature updates or restart on its own, has no ads or consumer apps running in the background, lets several people be signed in at once over Remote Desktop, and can give virtual machines a slice of the graphics card (GPU partitioning) for more players at once.$\r$\n$\r$\nThe catch: its sound is switched off, some games' anti-cheat and Microsoft Store / Game Pass games won't run, and it costs more to license. On Server, Setup turns the sound on."
  Pop $0
  !insertmacro Muted $0
  nsDialogs::Show
FunctionEnd

Function WindowsLeave
  ${NSD_GetState} $hServer $0
  StrCpy $IsServer 0
  ${If} $0 == ${BST_CHECKED}
    StrCpy $IsServer 1
  ${EndIf}
FunctionEnd

; ---------------------------------------------------------------- hardware
Function HardwarePage
  !insertmacro OnlyWhenChanging
  ; Without Sunshine none of this matters.
  ${IfNot} ${SectionIsSelected} ${SEC_SUNSHINE}
    StrCpy $WantVdd 0
    Abort
  ${EndIf}
  !insertmacro MUI_HEADER_TEXT "This PC's hardware" "What streaming needs, and the drivers Setup can add."
  nsDialogs::Create 1018
  Pop $0

  ${If} $HwEncoder != ""
    ${NSD_CreateLabel} 0 0 100% 20u "Graphics card: $HwEncoder. Sunshine uses it to encode the video, so streaming barely touches the processor."
  ${Else}
    ${NSD_CreateLabel} 0 0 100% 28u "WARNING: no NVIDIA, AMD or Intel graphics found. Sunshine would have to encode the video on the processor: slow, laggy, and not enough for more than one player. A graphics card (or a processor with Intel graphics) is strongly recommended."
  ${EndIf}
  Pop $0
  ${If} $HwEncoder == ""
    SetCtlColors $0 B45309 transparent
  ${EndIf}

  ${NSD_CreateCheckbox} 0 34u 100% 12u "Install a virtual display (for a PC with no monitor plugged in)"
  Pop $hVdd
  !insertmacro Strong $hVdd
  ${If} $HwVdd == 1
    ${NSD_SetText} $hVdd "Virtual display: already installed"
    EnableWindow $hVdd 0
  ${ElseIf} $WantVdd == 1
    ${NSD_Check} $hVdd
  ${EndIf}
  ${If} $HwMonitors == 0
    StrCpy $1 "No monitor is plugged in. "
  ${Else}
    StrCpy $1 ""
  ${EndIf}
  ${NSD_CreateLabel} 12u 47u -12u 26u "$1Sunshine can only stream a screen that's switched on. The virtual display (Virtual Display Driver) gives it one, and switches to each player's own size and frame rate."
  Pop $0
  !insertmacro Muted $0
  nsDialogs::Show
FunctionEnd

Function HardwareLeave
  StrCpy $WantVdd 0
  ${NSD_GetState} $hVdd $0
  ${If} $0 == ${BST_CHECKED}
  ${AndIf} $HwVdd != 1
    StrCpy $WantVdd 1
  ${EndIf}
FunctionEnd

; ---------------------------------------------------------------- controllers
Function ControllersPage
  !insertmacro OnlyWhenChanging
  ${IfNot} ${SectionIsSelected} ${SEC_SUNSHINE}
    StrCpy $WantVigem 0
    StrCpy $WantXusb 0
    StrCpy $Ds4 0
    Abort
  ${EndIf}
  !insertmacro MUI_HEADER_TEXT "Controllers" "How players' controllers reach this PC's games."
  nsDialogs::Create 1018
  Pop $0

  ${NSD_CreateLabel} 0 0 100% 20u "Each player's controller (on their phone, laptop or TV) becomes a virtual controller on this PC, which games see as if it were plugged in. Which kind:"
  Pop $0
  ${NSD_CreateRadioButton} 0 22u 100% 12u "Xbox 360 controllers (recommended)"
  Pop $hPadX360
  !insertmacro Strong $hPadX360
  ${NSD_CreateLabel} 12u 34u -12u 10u "Work in nearly every PC game and emulator. They need the Xbox 360 driver below."
  Pop $0
  !insertmacro Muted $0
  ${NSD_CreateRadioButton} 0 46u 100% 12u "PlayStation 4 controllers (DualShock 4)"
  Pop $hPadDs4
  !insertmacro Strong $hPadDs4
  ${NSD_CreateLabel} 12u 58u -12u 18u "PlayStation button prompts, touchpad and motion where games support them, and no Xbox 360 driver needed. Xbox-only PC games won't see them."
  Pop $0
  !insertmacro Muted $0
  ${If} $Ds4 == 1
    ${NSD_Check} $hPadDs4
  ${Else}
    ${NSD_Check} $hPadX360
  ${EndIf}

  ${NSD_CreateLabel} 0 82u 100% 10u "Controller drivers"
  Pop $0
  !insertmacro Strong $0
  ${NSD_CreateCheckbox} 0 93u 100% 18u "Install ViGEmBus, the virtual controller driver (needed for either kind; Sunshine may already have added it)"
  Pop $hVigem
  ${If} $HwVigem == 1
    ${NSD_SetText} $hVigem "ViGEmBus (virtual controllers): already installed"
    EnableWindow $hVigem 0
  ${ElseIf} $WantVigem == 1
    ${NSD_Check} $hVigem
  ${EndIf}
  ${NSD_CreateCheckbox} 0 113u 100% 18u "Install the Xbox 360 controller driver, from Microsoft"
  Pop $hXusb
  ${If} $HwXusb == 1
    ${NSD_SetText} $hXusb "Xbox 360 controller driver: already installed"
    EnableWindow $hXusb 0
  ${ElseIf} $WantXusb == 1
    ${NSD_Check} $hXusb
  ${EndIf}
  ${NSD_OnClick} $hPadX360 ControllersToggle
  ${NSD_OnClick} $hPadDs4 ControllersToggle
  nsDialogs::Show
FunctionEnd

; Xbox 360 pads need the Xbox 360 driver: tick it when they're picked.
Function ControllersToggle
  ${NSD_GetState} $hPadX360 $0
  ${If} $0 == ${BST_CHECKED}
  ${AndIf} $HwXusb != 1
    ${NSD_Check} $hXusb
  ${EndIf}
FunctionEnd

Function ControllersLeave
  StrCpy $Ds4 0
  ${NSD_GetState} $hPadDs4 $0
  ${If} $0 == ${BST_CHECKED}
    StrCpy $Ds4 1
  ${EndIf}
  StrCpy $WantVigem 0
  ${NSD_GetState} $hVigem $0
  ${If} $0 == ${BST_CHECKED}
  ${AndIf} $HwVigem != 1
    StrCpy $WantVigem 1
  ${EndIf}
  StrCpy $WantXusb 0
  ${NSD_GetState} $hXusb $0
  ${If} $0 == ${BST_CHECKED}
  ${AndIf} $HwXusb != 1
    StrCpy $WantXusb 1
  ${EndIf}
  ${If} $Ds4 == 0
  ${AndIf} $HwXusb != 1
  ${AndIf} $WantXusb == 0
    MessageBox MB_YESNO|MB_ICONQUESTION "Xbox 360 controllers won't work in games without the Xbox 360 controller driver. Continue without it?" IDYES +2
    Abort
  ${EndIf}
FunctionEnd

; ---------------------------------------------------------------- account
Function AccountPage
  !insertmacro OnlyWhenChanging
  ${IfNot} ${SectionIsSelected} ${SEC_LUMA}
    Abort
  ${EndIf}
  !insertmacro MUI_HEADER_TEXT "Which Windows account should run the games?" "What people who stream from this PC will see and control."
  nsDialogs::Create 1018
  Pop $0

  ${NSD_CreateLabel} 0 0 100% 42u "Anyone streaming from this PC sees and controls that account's desktop: its open windows, files and saved passwords. A separate account has only the games, can't change the PC, and can sign in by itself when the PC starts (Sunshine can only stream a signed-in desktop)."
  Pop $0

  ${NSD_CreateRadioButton} 0 44u 100% 12u "A separate account just for games (recommended)"
  Pop $hSeparate
  !insertmacro Strong $hSeparate
  ${NSD_CreateLabel} 12u 58u 50u 10u "Name"
  Pop $0
  ${NSD_CreateText} 64u 57u 120u 12u $AccountName
  Pop $hName
  ${NSD_CreateLabel} 12u 72u 50u 10u "Password"
  Pop $0
  ${NSD_CreatePassword} 64u 71u 120u 12u $AccountPass
  Pop $hPass
  ${NSD_CreateLabel} 12u 86u 50u 10u "Again"
  Pop $0
  ${NSD_CreatePassword} 64u 85u 120u 12u $AccountPass
  Pop $hPass2
  ${NSD_CreateCheckbox} 12u 99u -12u 12u "Sign this account in automatically when the PC starts"
  Pop $hAutoLogon
  ${If} $AutoLogon == 1
    ${NSD_Check} $hAutoLogon
  ${EndIf}

  ${NSD_CreateRadioButton} 0 114u 100% 12u "This account ($CurrentUser)"
  Pop $hCurrent
  !insertmacro Strong $hCurrent
  ${NSD_CreateCheckbox} 0 128u 100% 12u "Start Luma Arcade whenever the account signs in"
  Pop $hStartAtLogon
  ${If} $StartAtLogon == 1
    ${NSD_Check} $hStartAtLogon
  ${EndIf}

  ${If} $SeparateAccount == 1
    ${NSD_Check} $hSeparate
  ${Else}
    ${NSD_Check} $hCurrent
  ${EndIf}
  ${NSD_OnClick} $hSeparate AccountToggle
  ${NSD_OnClick} $hCurrent AccountToggle
  Call AccountToggle
  nsDialogs::Show
FunctionEnd

Function AccountToggle
  ${NSD_GetState} $hSeparate $0
  ${If} $0 == ${BST_CHECKED}
    StrCpy $0 1
  ${Else}
    StrCpy $0 0
  ${EndIf}
  EnableWindow $hName $0
  EnableWindow $hPass $0
  EnableWindow $hPass2 $0
  EnableWindow $hAutoLogon $0
FunctionEnd

Function AccountLeave
  ${NSD_GetState} $hSeparate $0
  ${NSD_GetState} $hAutoLogon $1
  ${NSD_GetState} $hStartAtLogon $2
  StrCpy $StartAtLogon 0
  ${If} $2 == ${BST_CHECKED}
    StrCpy $StartAtLogon 1
  ${EndIf}
  ${If} $0 != ${BST_CHECKED}
    StrCpy $SeparateAccount 0
    Return
  ${EndIf}
  StrCpy $SeparateAccount 1
  StrCpy $AutoLogon 0
  ${If} $1 == ${BST_CHECKED}
    StrCpy $AutoLogon 1
  ${EndIf}
  ${NSD_GetText} $hName $AccountName
  ${NSD_GetText} $hPass $AccountPass
  ${NSD_GetText} $hPass2 $3

  ${If} $AccountName == ""
    MessageBox MB_ICONEXCLAMATION "Type a name for the games account."
    Abort
  ${EndIf}
  ${If} $AccountName == $CurrentUser
    MessageBox MB_ICONEXCLAMATION "That's the account you're using now - pick $\"This account$\" instead, or another name."
    Abort
  ${EndIf}
  ${If} $AccountPass != $3
    MessageBox MB_ICONEXCLAMATION "The two passwords don't match."
    Abort
  ${EndIf}
  ; An existing account keeps its password; a new one (or signing in by
  ; itself, unless that's already set up for it) needs one.
  nsExec::Exec 'net.exe user "$AccountName"'
  Pop $4
  ReadRegStr $5 HKLM "SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon" "AutoAdminLogon"
  ReadRegStr $6 HKLM "SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon" "DefaultUserName"
  ${If} $AccountPass == ""
    ${If} $4 != 0
      MessageBox MB_ICONEXCLAMATION "Choose a password for the new account."
      Abort
    ${ElseIf} $AutoLogon == 1
      ${IfNot} $5 == "1"
      ${OrIfNot} $6 == $AccountName
        MessageBox MB_ICONEXCLAMATION "To sign $AccountName in automatically, type its password."
        Abort
      ${EndIf}
    ${EndIf}
  ${EndIf}
FunctionEnd

; ---------------------------------------------------------------- admin
; Only on a fresh install: an upgrade keeps its accounts.
Function AdminPage
  !insertmacro OnlyWhenChanging
  ${IfNot} ${SectionIsSelected} ${SEC_LUMA}
  ${OrIf} ${FileExists} "$INSTDIR\moonlight-web-stream\server\data.json"
  ${OrIf} ${FileExists} "$PLUGINSDIR\admin.txt"
    Abort
  ${EndIf}
  !insertmacro MUI_HEADER_TEXT "Your admin account" "So nothing needs setting up by hand after Setup."
  nsDialogs::Create 1018
  Pop $0

  ${NSD_CreateLabel} 0 0 100% 44u "The name and password you'll sign in to Luma Arcade with, as its admin. Setup also gives Sunshine (the streaming host) the same sign-in, if it doesn't have one yet, and pairs the two - normally three fiddly steps after installing.$\r$\n$\r$\nLeave it empty to do those steps yourself later."
  Pop $0
  ${NSD_CreateLabel} 0 52u 60u 10u "Name"
  Pop $0
  ${NSD_CreateText} 64u 51u 120u 12u $AdminName
  Pop $hAdminName
  ${NSD_CreateLabel} 0 67u 60u 10u "Password"
  Pop $0
  ${NSD_CreatePassword} 64u 66u 120u 12u ""
  Pop $hAdminPass
  ${NSD_CreateLabel} 0 82u 60u 10u "Again"
  Pop $0
  ${NSD_CreatePassword} 64u 81u 120u 12u ""
  Pop $hAdminPass2
  nsDialogs::Show
FunctionEnd

Function AdminLeave
  ${NSD_GetText} $hAdminName $AdminName
  ${NSD_GetText} $hAdminPass $AdminPass
  ${NSD_GetText} $hAdminPass2 $0
  ${If} $AdminName == ""
  ${AndIf} $AdminPass == ""
    Return
  ${EndIf}
  ${If} $AdminName == ""
    MessageBox MB_ICONEXCLAMATION "Type a name for your admin account (or leave both empty)."
    Abort
  ${EndIf}
  ${If} $AdminPass != $0
    MessageBox MB_ICONEXCLAMATION "The two passwords don't match."
    Abort
  ${EndIf}
  StrLen $1 $AdminPass
  ${If} $1 < 8
    MessageBox MB_ICONEXCLAMATION "Use at least 8 characters: people on the internet may be able to reach this sign-in."
    Abort
  ${EndIf}
FunctionEnd

; ---------------------------------------------------------------- network
Function NetworkPage
  !insertmacro OnlyWhenChanging
  ${IfNot} ${SectionIsSelected} ${SEC_LUMA}
    Abort
  ${EndIf}
  !insertmacro MUI_HEADER_TEXT "Playing from other devices" "Browsers only allow game controllers and full screen on secure (HTTPS) pages."
  nsDialogs::Create 1018
  Pop $0

  ${NSD_CreateCheckbox} 0 0 100% 12u "HTTPS on the home network (https://<this PC>:${HTTPS_PORT})"
  Pop $hHttps
  !insertmacro Strong $hHttps
  ${If} $HttpsOn == 1
    ${NSD_Check} $hHttps
  ${EndIf}
  ${NSD_CreateLabel} 12u 13u -12u 34u "A TV or laptop at home can then use controllers. The certificate is made for this PC, so each device warns about it once (continue anyway), or installs it from http://<this PC>:${LUMA_PORT}/luma-arcade.cer to trust it for good."
  Pop $0
  !insertmacro Muted $0

  ${NSD_CreateLabel} 0 54u 100% 42u "Away from home: a Cloudflare Tunnel gives Luma Arcade a secure address on your own domain, without opening ports. In the Cloudflare dashboard (Zero Trust > Networks > Tunnels) create a tunnel, copy its token (the long text after --token in its install command) and paste it here. Then give the tunnel a public hostname pointing at http://localhost:${LUMA_PORT}."
  Pop $0
  ${NSD_CreateLabel} 0 100u 60u 10u "Tunnel token"
  Pop $0
  ${NSD_CreatePassword} 64u 99u -64u 12u $TunnelToken
  Pop $hToken
  ${NSD_CreateLabel} 64u 114u -64u 10u "Optional - leave it empty to skip."
  Pop $0
  !insertmacro Muted $0
  nsDialogs::Show
FunctionEnd

Function NetworkLeave
  ${NSD_GetState} $hHttps $0
  StrCpy $HttpsOn 0
  ${If} $0 == ${BST_CHECKED}
    StrCpy $HttpsOn 1
  ${EndIf}
  ${NSD_GetText} $hToken $TunnelToken
FunctionEnd

; ---------------------------------------------------------------- folders
Function LumaDirPre
  !insertmacro OnlyWhenChanging
  ${IfNot} ${SectionIsSelected} ${SEC_LUMA}
  ${OrIf} $IsUpgrade == 1
    Abort
  ${EndIf}
FunctionEnd

!macro EmuAny SEC KEY FOLDER
  !insertmacro EmuArg ${SEC} "x"
!macroend

Function GamesDirPre
  !insertmacro OnlyWhenChanging
  StrCpy $EmuList ""
  !insertmacro AllEmus EmuAny
  ${IfNot} ${SectionIsSelected} ${SEC_ESDE}
  ${AndIf} $EmuList == ""
    Abort
  ${EndIf}
FunctionEnd

; ---------------------------------------------------------------- finish
Function FinishShow
  SendMessage $mui.FinishPage.Title ${WM_SETFONT} $FontWelcome 1
  ; "Open now" only when Luma Arcade was installed for this account (a
  ; separate account starts it when it signs in).
  ${IfNot} ${SectionIsSelected} ${SEC_LUMA}
  ${OrIf} $SeparateAccount == 1
    ShowWindow $mui.FinishPage.Run 0
    ${NSD_Uncheck} $mui.FinishPage.Run
  ${EndIf}
FunctionEnd

Function LaunchApp
  ; Through Explorer, so it runs as the signed-in user, not elevated.
  Exec '"$WINDIR\explorer.exe" "$INSTDIR\LumaArcade.vbs"'
FunctionEnd

Function ShowNextSteps
  ${If} ${SectionIsSelected} ${SEC_LUMA}
    ExecShell "open" "$INSTDIR\NEXT-STEPS.txt"
  ${EndIf}
  ${If} ${FileExists} "$GamesDir\READ ME - games setup.txt"
    ExecShell "open" "$GamesDir\READ ME - games setup.txt"
  ${EndIf}
FunctionEnd

Function .onGUIEnd
  ; Secrets never outlive Setup, whatever happened.
  Delete "$PLUGINSDIR\admin.txt"
  Delete "$PLUGINSDIR\account.txt"
  Delete "$PLUGINSDIR\tunnel.txt"
FunctionEnd

Function .onInstFailed
  Delete "$PLUGINSDIR\admin.txt"
  Delete "$PLUGINSDIR\account.txt"
  Delete "$PLUGINSDIR\tunnel.txt"
FunctionEnd

; ---------------------------------------------------------------- uninstall
; Silent: /REMOVEAUTOLOGON and /REMOVEACCOUNT (neither happens by default).
; ---------------------------------------------------------------- uninstall
; Two ready-made picks; anything else is "Custom".
InstType "un.Just Luma Arcade"
InstType "un.Everything (your games folder stays)"

Section "un.Luma Arcade" UN_LUMA
  SectionIn 1 2
SectionEnd
Section /o "un.Luma Arcade's accounts, settings and play history" UN_DATA
  SectionIn 2
SectionEnd
Section /o "un.The games account" UN_ACCOUNT
  SectionIn 2
SectionEnd
Section /o "un.Sunshine (with its settings and paired devices)" UN_SUNSHINE
  SectionIn 2
SectionEnd
Section /o "un.ES-DE (your ROMs folder stays)" UN_ESDE
  SectionIn 2
SectionEnd
SectionGroup "un.Emulators" UN_EMUS
  Section /o "un.RetroArch" UN_RETROARCH
    SectionIn 2
  SectionEnd
  Section /o "un.Dolphin" UN_DOLPHIN
    SectionIn 2
  SectionEnd
  Section /o "un.PCSX2" UN_PCSX2
    SectionIn 2
  SectionEnd
  Section /o "un.DuckStation" UN_DUCKSTATION
    SectionIn 2
  SectionEnd
  Section /o "un.PPSSPP" UN_PPSSPP
    SectionIn 2
  SectionEnd
  Section /o "un.RPCS3" UN_RPCS3
    SectionIn 2
  SectionEnd
  Section /o "un.Xenia Canary" UN_XENIA
    SectionIn 2
  SectionEnd
  Section /o "un.xemu" UN_XEMU
    SectionIn 2
  SectionEnd
  Section /o "un.Cemu" UN_CEMU
    SectionIn 2
  SectionEnd
  Section /o "un.Azahar" UN_AZAHAR
    SectionIn 2
  SectionEnd
  Section /o "un.melonDS" UN_MELONDS
    SectionIn 2
  SectionEnd
  Section /o "un.Vita3K" UN_VITA3K
    SectionIn 2
  SectionEnd
  Section /o "un.Flycast" UN_FLYCAST
    SectionIn 2
  SectionEnd
  Section /o "un.shadPS4 (PS4)" UN_SHADPS4
    SectionIn 2
  SectionEnd
SectionGroupEnd
Section /o "un.Virtual display driver" UN_VDD
  SectionIn 2
SectionEnd
Section /o "un.ViGEmBus (virtual controllers)" UN_VIGEM
  SectionIn 2
SectionEnd
Section /o "un.Your games folder: games, saves and BIOS files" UN_GAMES
SectionEnd

; Does the removing, in a safe order, once everything's been picked.
Section "-un.Remove"
  Call un.Remove
SectionEnd

!insertmacro MUI_UNFUNCTION_DESCRIPTION_BEGIN
  !insertmacro MUI_DESCRIPTION_TEXT ${UN_LUMA} "The website, the streaming server, its helper scripts, scheduled tasks, firewall rules, the Cloudflare Tunnel Setup added, and its Start menu shortcuts."
  !insertmacro MUI_DESCRIPTION_TEXT ${UN_DATA} "Everyone's Luma Arcade accounts, guest links, play history and settings, and the paired PCs. A copy goes to Documents\LumaArcade-backup first."
  !insertmacro MUI_DESCRIPTION_TEXT ${UN_ACCOUNT} "The Windows account the games ran under, and everything in its user folder. It's signed out first, and no longer signs in by itself."
  !insertmacro MUI_DESCRIPTION_TEXT ${UN_SUNSHINE} "Sunshine, the streaming host: the program, its settings, sign-in, paired devices and app pictures."
  !insertmacro MUI_DESCRIPTION_TEXT ${UN_ESDE} "ES-DE, its desktop shortcut, and its settings, game lists and favorites in each account. Your ROMs folder is kept."
  !insertmacro MUI_DESCRIPTION_TEXT ${UN_EMUS} "Each emulator goes with its settings and any saves kept in its own folder."
  !insertmacro MUI_DESCRIPTION_TEXT ${UN_VDD} "The virtual screen Sunshine streams when no monitor is plugged in."
  !insertmacro MUI_DESCRIPTION_TEXT ${UN_VIGEM} "The driver that turns players' controllers into Xbox or PlayStation pads on this PC. Other apps (like DS4Windows) may use it too."
  !insertmacro MUI_DESCRIPTION_TEXT ${UN_GAMES} "Deletes the whole games folder: your games (ROMs), saves, BIOS files, ES-DE and the emulators. Can't be undone."
!insertmacro MUI_UNFUNCTION_DESCRIPTION_END


; Takes a component off the list (this PC doesn't have it).
!macro UnHide SEC
  SectionSetText ${SEC} ""
  SectionSetInstTypes ${SEC} 0
  !insertmacro UnselectSection ${SEC}
!macroend

!macro UnAllEmus MACRO
  !insertmacro ${MACRO} ${UN_RETROARCH} "retroarch" "RetroArch-Win64"
  !insertmacro ${MACRO} ${UN_DOLPHIN} "dolphin" "Dolphin-x64"
  !insertmacro ${MACRO} ${UN_PCSX2} "pcsx2" "PCSX2-Qt"
  !insertmacro ${MACRO} ${UN_DUCKSTATION} "duckstation" "duckstation"
  !insertmacro ${MACRO} ${UN_PPSSPP} "ppsspp" "PPSSPP"
  !insertmacro ${MACRO} ${UN_RPCS3} "rpcs3" "RPCS3"
  !insertmacro ${MACRO} ${UN_XENIA} "xenia" "xenia_canary"
  !insertmacro ${MACRO} ${UN_XEMU} "xemu" "xemu"
  !insertmacro ${MACRO} ${UN_CEMU} "cemu" "cemu"
  !insertmacro ${MACRO} ${UN_AZAHAR} "azahar" "azahar"
  !insertmacro ${MACRO} ${UN_MELONDS} "melonds" "melonDS"
  !insertmacro ${MACRO} ${UN_VITA3K} "vita3k" "Vita3K"
  !insertmacro ${MACRO} ${UN_FLYCAST} "flycast" "flycast"
  !insertmacro ${MACRO} ${UN_SHADPS4} "shadps4" "shadPS4"
!macroend

; An emulator in the games folder stays listed ($Str1 counts them).
!macro UnHideAbsent SEC KEY FOLDER
  StrCpy $R7 0
  ${If} $UnGamesDir != ""
    ${If} ${FileExists} "$UnGamesDir\ES-DE\Emulators\${FOLDER}\*.*"
      StrCpy $R7 1
    ${ElseIf} ${FileExists} "$UnGamesDir\Emulators\${FOLDER}\*.*"
      StrCpy $R7 1
    ${EndIf}
  ${EndIf}
  ${If} $R7 == 1
    IntOp $Str1 $Str1 + 1
  ${Else}
    !insertmacro UnHide ${SEC}
  ${EndIf}
!macroend

!macro UnCountSelected SEC KEY FOLDER
  ${If} ${SectionIsSelected} ${SEC}
    StrCpy $0 1
  ${EndIf}
!macroend

!macro UnAnySelected
  StrCpy $0 0
  !insertmacro UnAllEmus UnCountSelected
  !insertmacro UnCountSelected ${UN_LUMA} "" ""
  !insertmacro UnCountSelected ${UN_DATA} "" ""
  !insertmacro UnCountSelected ${UN_ACCOUNT} "" ""
  !insertmacro UnCountSelected ${UN_SUNSHINE} "" ""
  !insertmacro UnCountSelected ${UN_ESDE} "" ""
  !insertmacro UnCountSelected ${UN_VDD} "" ""
  !insertmacro UnCountSelected ${UN_VIGEM} "" ""
  !insertmacro UnCountSelected ${UN_GAMES} "" ""
!macroend

Function un.onInit
  SetRegView 64
  ReadRegStr $UnAccount HKLM "${SETTINGS_KEY}" "Account"
  ReadRegDWORD $UnSeparate HKLM "${SETTINGS_KEY}" "SeparateAccount"
  ReadRegStr $UnGamesDir HKLM "${SETTINGS_KEY}" "GamesDir"
  StrCpy $UnAutoLogon 1
  ${If} ${Silent}
    StrCpy $UnAutoLogon 0
    ${GetParameters} $0
    ClearErrors
    ${GetOptions} $0 "/REMOVEAUTOLOGON" $1
    ${IfNot} ${Errors}
      StrCpy $UnAutoLogon 1
    ${EndIf}
    ClearErrors
    ${GetOptions} $0 "/REMOVEACCOUNT" $1
    ${IfNot} ${Errors}
      !insertmacro SelectSection ${UN_ACCOUNT}
    ${EndIf}
  ${EndIf}

  ; Only what this PC has is listed.
  ${IfNot} ${FileExists} "$INSTDIR\server\luma-arcade.db"
    !insertmacro UnHide ${UN_DATA}
  ${EndIf}
  ${If} $UnSeparate == 1
  ${AndIf} $UnAccount != ""
    SectionSetText ${UN_ACCOUNT} "The Windows account $UnAccount and its files"
  ${Else}
    !insertmacro UnHide ${UN_ACCOUNT}
  ${EndIf}
  ClearErrors
  ReadRegStr $0 HKLM "SYSTEM\CurrentControlSet\Services\SunshineService" "ImagePath"
  ${If} ${Errors}
    !insertmacro UnHide ${UN_SUNSHINE}
  ${EndIf}
  ClearErrors
  ReadRegStr $0 HKLM "SYSTEM\CurrentControlSet\Services\ViGEmBus" "ImagePath"
  ${If} ${Errors}
    !insertmacro UnHide ${UN_VIGEM}
  ${EndIf}
  ; The virtual display is a user-mode driver with no service of its own:
  ; ask Windows for its device.
  nsExec::ExecToStack `"${POWERSHELL}" -NoProfile -Command "[int][bool](Get-CimInstance Win32_PnPEntity | Where-Object { $$_.HardwareID -contains 'Root\MttVDD' })"`
  Pop $0
  Pop $1
  StrCpy $1 $1 1
  ${If} $1 != "1"
  ${AndIfNot} ${FileExists} "C:\VirtualDisplayDriver\*.*"
    !insertmacro UnHide ${UN_VDD}
  ${EndIf}
  ${If} $UnGamesDir == ""
  ${OrIfNot} ${FileExists} "$UnGamesDir\*.*"
    StrCpy $UnGamesDir ""
    !insertmacro UnHide ${UN_GAMES}
  ${EndIf}
  ${IfNot} ${FileExists} "$UnGamesDir\ES-DE\ES-DE.exe"
  ${OrIf} $UnGamesDir == ""
    !insertmacro UnHide ${UN_ESDE}
  ${EndIf}
  StrCpy $Str1 0
  !insertmacro UnAllEmus UnHideAbsent
  ${If} $Str1 == 0
    SectionSetText ${UN_EMUS} ""
  ${EndIf}
FunctionEnd

; Ticking your games folder or the games account deletes things that can't
; come back: ask first.
Function un.ComponentsLeave
  !insertmacro UnAnySelected
  ${If} $0 == 0
    MessageBox MB_ICONINFORMATION "Tick at least one thing to remove." /SD IDOK
    Abort
  ${EndIf}
  ${If} ${SectionIsSelected} ${UN_GAMES}
    MessageBox MB_YESNO|MB_ICONEXCLAMATION|MB_DEFBUTTON2 "Delete EVERYTHING in $UnGamesDir - your games, saves, BIOS files, ES-DE and the emulators? This can't be undone." /SD IDYES IDYES +2
    Abort
  ${EndIf}
  ${If} ${SectionIsSelected} ${UN_ACCOUNT}
    MessageBox MB_YESNO|MB_ICONEXCLAMATION|MB_DEFBUTTON2 "Delete the Windows account $UnAccount and everything in its user folder (desktop, documents, game settings and saves kept there)? This can't be undone." /SD IDYES IDYES +2
    Abort
  ${EndIf}
FunctionEnd

!macro UnEmuArg SEC KEY FOLDER
  ${If} ${SectionIsSelected} ${SEC}
    StrCpy $Str2 "$Str2${KEY},"
  ${EndIf}
!macroend

Function un.Remove
  SetRegView 64
  InitPluginsDir
  SetOutPath "$PLUGINSDIR\scripts"
  File "scripts\common.ps1"
  File "scripts\catalog.ps1"
  File "scripts\versions.json"
  File "scripts\uninstall-host.ps1"
  File "scripts\remove.ps1"
  SetOutPath "$TEMP"

  ${If} ${SectionIsSelected} ${UN_LUMA}
    nsExec::Exec 'schtasks.exe /end /tn "\LumaArcade\LumaArcade"'
    Pop $0
    ; Everything running from the install folder, so its files can go.
    nsExec::Exec `"${POWERSHELL}" -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { $$_.ExecutablePath -like '$INSTDIR\*' -and $$_.Name -ne 'cloudflared.exe' } | ForEach-Object { Stop-Process -Id $$_.ProcessId -Force }"`
    Pop $0
  ${EndIf}

  ; The PC-side setup: tasks, helper scripts, Sunshine prep-cmds, ES-DE
  ; event scripts, the tunnel - and the games account, when it's ticked.
  StrCpy $1 '-LumaDir "$INSTDIR"'
  ${If} $UnSeparate == 1
  ${AndIf} $UnAccount != ""
    StrCpy $1 '$1 -Account "$UnAccount"'
    ${If} $UnAutoLogon == 1
    ${OrIf} ${SectionIsSelected} ${UN_ACCOUNT}
      StrCpy $1 "$1 -RemoveAutoLogon"
    ${EndIf}
    ${If} ${SectionIsSelected} ${UN_ACCOUNT}
      StrCpy $1 "$1 -RemoveAccount"
    ${EndIf}
  ${EndIf}
  ${If} ${SectionIsSelected} ${UN_LUMA}
    nsExec::ExecToLog '"${POWERSHELL}" -NoProfile -ExecutionPolicy Bypass -File "$PLUGINSDIR\scripts\uninstall-host.ps1" $1'
    Pop $0
  ${ElseIf} ${SectionIsSelected} ${UN_ACCOUNT}
    nsExec::ExecToLog '"${POWERSHELL}" -NoProfile -ExecutionPolicy Bypass -File "$PLUGINSDIR\scripts\uninstall-host.ps1" $1 -AccountOnly'
    Pop $0
  ${EndIf}

  ${If} ${SectionIsSelected} ${UN_LUMA}
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "LumaArcade"
    nsExec::Exec `"${POWERSHELL}" -NoProfile -Command "Remove-NetFirewallRule -DisplayName 'Luma Arcade*' -ErrorAction SilentlyContinue"`
    Pop $0
    DeleteRegKey HKLM "${UNINST_KEY}"
    DeleteRegKey HKLM "${SETTINGS_KEY}"
    SetShellVarContext all
    RMDir /r "$SMPROGRAMS\${APP_TITLE}"

    ${If} ${SectionIsSelected} ${UN_DATA}
      ; Backed up to Documents first - a deleted database can't come back.
      CreateDirectory "$DOCUMENTS\LumaArcade-backup"
      CopyFiles /SILENT "$INSTDIR\server\luma-arcade.db*" "$DOCUMENTS\LumaArcade-backup\"
      CopyFiles /SILENT "$INSTDIR\moonlight-web-stream\server\data.json" "$DOCUMENTS\LumaArcade-backup\"
      ; Nothing of Luma Arcade's is kept: the whole folder goes.
      RMDir /r "$INSTDIR"
    ${Else}
      RMDir /r "$INSTDIR\server\dist"
      RMDir /r "$INSTDIR\server\assets"
      RMDir /r "$INSTDIR\server\node_modules"
      Delete "$INSTDIR\server\package.json"
      Delete "$INSTDIR\server\package-lock.json"
      Delete "$INSTDIR\server\*.log"
      RMDir /r "$INSTDIR\moonlight-web-stream\static"
      Delete "$INSTDIR\moonlight-web-stream\*.exe"
      Delete "$INSTDIR\moonlight-web-stream\*.log"
      Delete "$INSTDIR\moonlight-web-stream\server\config.default.json"
      Delete "$INSTDIR\moonlight-web-stream\server\turn_ice_script.*"
      RMDir "$INSTDIR\moonlight-web-stream\server"
      RMDir "$INSTDIR\moonlight-web-stream"
      RMDir /r "$INSTDIR\host"
      RMDir /r "$INSTDIR\setup"
      RMDir /r "$INSTDIR\cloudflared"
      Delete "$INSTDIR\node.exe"
      Delete "$INSTDIR\LumaArcade.vbs"
      Delete "$INSTDIR\NEXT-STEPS.txt"
      Delete "$INSTDIR\Uninstall.exe"
      RMDir "$INSTDIR\server"
      RMDir "$INSTDIR"
    ${EndIf}
  ${EndIf}

  ; Everything else Setup installed (remove.ps1).
  StrCpy $1 ""
  ${If} ${SectionIsSelected} ${UN_SUNSHINE}
    StrCpy $1 "$1 -Sunshine"
  ${EndIf}
  ${If} ${SectionIsSelected} ${UN_ESDE}
    StrCpy $1 "$1 -EsDe"
  ${EndIf}
  ${If} ${SectionIsSelected} ${UN_VDD}
    StrCpy $1 "$1 -VirtualDisplay"
  ${EndIf}
  ${If} ${SectionIsSelected} ${UN_VIGEM}
    StrCpy $1 "$1 -ViGEm"
  ${EndIf}
  ${If} ${SectionIsSelected} ${UN_GAMES}
    StrCpy $1 "$1 -Games"
  ${EndIf}
  StrCpy $Str2 ""
  !insertmacro UnAllEmus UnEmuArg
  ${If} $Str2 != ""
    StrCpy $1 '$1 -Emulators "$Str2"'
  ${EndIf}
  ${If} $1 != ""
    ${If} $UnGamesDir != ""
      StrCpy $1 '$1 -GamesDir "$UnGamesDir"'
    ${EndIf}
    nsExec::ExecToLog '"${POWERSHELL}" -NoProfile -ExecutionPolicy Bypass -File "$PLUGINSDIR\scripts\remove.ps1" $1'
    Pop $0
    ${If} $0 != 0
      MessageBox MB_ICONEXCLAMATION|MB_OK "Some of it couldn't be removed - see the details list." /SD IDOK
    ${EndIf}
  ${EndIf}

  ${If} ${SectionIsSelected} ${UN_LUMA}
  ${AndIfNot} ${SectionIsSelected} ${UN_GAMES}
    MessageBox MB_ICONINFORMATION "Luma Arcade is removed. Anything you didn't tick (and your games folder) was left in place." /SD IDOK
  ${EndIf}
FunctionEnd
