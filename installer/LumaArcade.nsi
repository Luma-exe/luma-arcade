Unicode true

!define APP_NAME "LumaArcade"
!define APP_PUBLISHER "LumaArcade"
!define UNINST_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APP_NAME}"

Name "${APP_NAME}"
OutFile "output\LumaArcadeSetup.exe"
InstallDir "$LOCALAPPDATA\Programs\${APP_NAME}"
RequestExecutionLevel user
ShowInstDetails show
ShowUninstDetails show

!include "MUI2.nsh"
!include "LogicLib.nsh"
!include "nsDialogs.nsh"

!define MUI_ABORTWARNING

; --- Existing-install detection + Repair/Install-more-emulators/Uninstall choice ---
; "full" (fresh install or Repair) runs the whole normal flow; "emulators-only"
; skips straight past the Sunshine/ES-DE/moonlight-web-stream/file-copy steps
; in the Install section and only runs the emulator installer script.
Var InstallMode
Var ExistingInstallFound

Function .onInit
  StrCpy $InstallMode "full"
  StrCpy $ExistingInstallFound ""
  IfFileExists "$INSTDIR\server\luma-arcade.db" 0 +2
    StrCpy $ExistingInstallFound "1"
FunctionEnd

Var RepairRadio
Var EmulatorsOnlyRadio
Var UninstallRadio

Function ExistingInstallChoicePageCreate
  ${If} $ExistingInstallFound != "1"
    Abort ; skip this page entirely on a fresh install
  ${EndIf}
  !insertmacro MUI_HEADER_TEXT "Existing install found" \
    "LumaArcade is already installed at $INSTDIR. What would you like to do?"
  nsDialogs::Create 1018
  Pop $0
  ${If} $0 == error
    Abort
  ${EndIf}

  ${NSD_CreateRadioButton} 0 0 100% 12u "Repair (reinstall LumaArcade and re-check Sunshine/ES-DE/moonlight-web-stream)"
  Pop $RepairRadio
  ${NSD_SetState} $RepairRadio ${BST_CHECKED}
  ${NSD_CreateRadioButton} 0 20u 100% 12u "Install more emulators (skip straight to the emulator list, don't touch anything else)"
  Pop $EmulatorsOnlyRadio
  ${NSD_CreateRadioButton} 0 40u 100% 12u "Uninstall LumaArcade"
  Pop $UninstallRadio

  nsDialogs::Show
FunctionEnd

Function ExistingInstallChoicePageLeave
  ${NSD_GetState} $EmulatorsOnlyRadio $0
  ${If} $0 == ${BST_CHECKED}
    StrCpy $InstallMode "emulators-only"
  ${EndIf}
  ${NSD_GetState} $UninstallRadio $0
  ${If} $0 == ${BST_CHECKED}
    ExecWait '"$INSTDIR\Uninstall.exe"'
    Quit
  ${EndIf}
FunctionEnd

Page custom ExistingInstallChoicePageCreate ExistingInstallChoicePageLeave

!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_DIRECTORY

; --- Emulator selection ---
; Each entry gets auto-detected and launched by ES-DE with no further setup
; needed — ES-DE's own bundled es_find_rules.xml already looks for a build
; at the exact folder installer/scripts/install-emulators.ps1 stages it to
; (verified against ES-DE's actual source, not guessed). All unchecked by
; default -- several of these are multi-gigabyte downloads. Every entry
; here downloads directly (no winget, no interactive-session dependency) --
; Dolphin's own site is behind an anti-bot challenge that blocks scripted
; page loads, but its actual file CDN (dl.dolphin-emu.org) isn't, and the
; current version number comes from GitHub's tag mirror of the project;
; Eden (Switch) ships its own releases directly since moving off GitHub
; after Nintendo takedown notices.
Var EmuCemu
Var Emu3ds
Var EmuDuckstation
Var EmuMelonds
Var EmuPcsx2
Var EmuPpsspp
Var EmuRpcs3
Var EmuShadps4
Var EmuVita3k
Var EmuXemu
Var EmuXenia
Var EmuRetroarch
Var EmuDolphin
Var EmuSwitch
Var EmuFlycast
Var EmuScummvm
Var EmuEasyrpg
Var EmuHypseus
Var EmuTsugaru
Var EmuSupermodel
Var EmuDosboxStaging
Var EmuDosboxX
Var EmuVpinball
Var EmuKemulator
Var EmuRuffle
Var EmuTeknoparrot
Var EmuSteam
Var EmuEpic
Var SelectedEmulators

Function EmulatorChoicePageCreate
  !insertmacro MUI_HEADER_TEXT "Choose emulators" \
    "Selected emulators are downloaded and set up so ES-DE finds them automatically. You can re-run this installer later to add more."

  nsDialogs::Create 1018
  Pop $0
  ${If} $0 == error
    Abort
  ${EndIf}

  ${NSD_CreateCheckbox} 0 0 48% 12u "Cemu (Wii U)"
  Pop $EmuCemu
  ${NSD_CreateCheckbox} 50% 0 48% 12u "Azahar (3DS, Citra successor)"
  Pop $Emu3ds
  ${NSD_CreateCheckbox} 0 16u 48% 12u "Dolphin (GameCube/Wii)"
  Pop $EmuDolphin
  ${NSD_CreateCheckbox} 50% 16u 48% 12u "DuckStation (PS1)"
  Pop $EmuDuckstation
  ${NSD_CreateCheckbox} 0 32u 48% 12u "melonDS (Nintendo DS)"
  Pop $EmuMelonds
  ${NSD_CreateCheckbox} 50% 32u 48% 12u "PCSX2 (PS2)"
  Pop $EmuPcsx2
  ${NSD_CreateCheckbox} 0 48u 48% 12u "PPSSPP (PSP)"
  Pop $EmuPpsspp
  ${NSD_CreateCheckbox} 50% 48u 48% 12u "RPCS3 (PS3)"
  Pop $EmuRpcs3
  ${NSD_CreateCheckbox} 0 64u 48% 12u "shadPS4 (PS4)"
  Pop $EmuShadps4
  ${NSD_CreateCheckbox} 50% 64u 48% 12u "Eden (Switch, Yuzu successor)"
  Pop $EmuSwitch
  ${NSD_CreateCheckbox} 0 80u 48% 12u "Vita3K (PS Vita)"
  Pop $EmuVita3k
  ${NSD_CreateCheckbox} 50% 80u 48% 12u "xemu (original Xbox)"
  Pop $EmuXemu
  ${NSD_CreateCheckbox} 0 96u 48% 12u "Xenia Canary (Xbox 360)"
  Pop $EmuXenia
  ${NSD_CreateCheckbox} 50% 96u 48% 12u "RetroArch (older/misc consoles)"
  Pop $EmuRetroarch

  nsDialogs::Show
FunctionEnd

Function EmulatorChoicePageLeave
  StrCpy $SelectedEmulators ""
  ${NSD_GetState} $EmuCemu $0
  ${If} $0 == ${BST_CHECKED}
    StrCpy $SelectedEmulators "$SelectedEmulators,cemu"
  ${EndIf}
  ${NSD_GetState} $Emu3ds $0
  ${If} $0 == ${BST_CHECKED}
    StrCpy $SelectedEmulators "$SelectedEmulators,3ds"
  ${EndIf}
  ${NSD_GetState} $EmuDolphin $0
  ${If} $0 == ${BST_CHECKED}
    StrCpy $SelectedEmulators "$SelectedEmulators,dolphin"
  ${EndIf}
  ${NSD_GetState} $EmuDuckstation $0
  ${If} $0 == ${BST_CHECKED}
    StrCpy $SelectedEmulators "$SelectedEmulators,duckstation"
  ${EndIf}
  ${NSD_GetState} $EmuMelonds $0
  ${If} $0 == ${BST_CHECKED}
    StrCpy $SelectedEmulators "$SelectedEmulators,melonds"
  ${EndIf}
  ${NSD_GetState} $EmuPcsx2 $0
  ${If} $0 == ${BST_CHECKED}
    StrCpy $SelectedEmulators "$SelectedEmulators,pcsx2"
  ${EndIf}
  ${NSD_GetState} $EmuPpsspp $0
  ${If} $0 == ${BST_CHECKED}
    StrCpy $SelectedEmulators "$SelectedEmulators,ppsspp"
  ${EndIf}
  ${NSD_GetState} $EmuRpcs3 $0
  ${If} $0 == ${BST_CHECKED}
    StrCpy $SelectedEmulators "$SelectedEmulators,rpcs3"
  ${EndIf}
  ${NSD_GetState} $EmuShadps4 $0
  ${If} $0 == ${BST_CHECKED}
    StrCpy $SelectedEmulators "$SelectedEmulators,shadps4"
  ${EndIf}
  ${NSD_GetState} $EmuSwitch $0
  ${If} $0 == ${BST_CHECKED}
    StrCpy $SelectedEmulators "$SelectedEmulators,switch"
  ${EndIf}
  ${NSD_GetState} $EmuVita3k $0
  ${If} $0 == ${BST_CHECKED}
    StrCpy $SelectedEmulators "$SelectedEmulators,vita3k"
  ${EndIf}
  ${NSD_GetState} $EmuXemu $0
  ${If} $0 == ${BST_CHECKED}
    StrCpy $SelectedEmulators "$SelectedEmulators,xemu"
  ${EndIf}
  ${NSD_GetState} $EmuXenia $0
  ${If} $0 == ${BST_CHECKED}
    StrCpy $SelectedEmulators "$SelectedEmulators,xenia"
  ${EndIf}
  ${NSD_GetState} $EmuRetroarch $0
  ${If} $0 == ${BST_CHECKED}
    StrCpy $SelectedEmulators "$SelectedEmulators,retroarch"
  ${EndIf}
FunctionEnd

Function EmulatorChoicePage2Create
  !insertmacro MUI_HEADER_TEXT "Choose more emulators" \
    "Arcade, engines, and older PC systems. Same deal — selected ones are downloaded and set up automatically."

  nsDialogs::Create 1018
  Pop $0
  ${If} $0 == error
    Abort
  ${EndIf}

  ${NSD_CreateCheckbox} 0 0 48% 12u "Flycast (Dreamcast/Naomi/Atomiswave)"
  Pop $EmuFlycast
  ${NSD_CreateCheckbox} 50% 0 48% 12u "ScummVM (point-and-click adventures)"
  Pop $EmuScummvm
  ${NSD_CreateCheckbox} 0 16u 48% 12u "EasyRPG Player (RPG Maker 2000/2003)"
  Pop $EmuEasyrpg
  ${NSD_CreateCheckbox} 50% 16u 48% 12u "Hypseus Singe (arcade LaserDisc)"
  Pop $EmuHypseus
  ${NSD_CreateCheckbox} 0 32u 48% 12u "Tsugaru (Fujitsu FM Towns)"
  Pop $EmuTsugaru
  ${NSD_CreateCheckbox} 50% 32u 48% 12u "Supermodel (Sega Model 3)"
  Pop $EmuSupermodel
  ${NSD_CreateCheckbox} 0 48u 48% 12u "DOSBox Staging (DOS)"
  Pop $EmuDosboxStaging
  ${NSD_CreateCheckbox} 50% 48u 48% 12u "DOSBox-X (Windows 3.x/9x)"
  Pop $EmuDosboxX
  ${NSD_CreateCheckbox} 0 64u 48% 12u "Visual Pinball"
  Pop $EmuVpinball
  ${NSD_CreateCheckbox} 50% 64u 48% 12u "KEmulator (Java ME / J2ME)"
  Pop $EmuKemulator
  ${NSD_CreateCheckbox} 0 80u 48% 12u "Ruffle (Adobe Flash)"
  Pop $EmuRuffle
  ${NSD_CreateCheckbox} 50% 80u 48% 12u "TeknoParrot (modern PC-based arcade)"
  Pop $EmuTeknoparrot

  nsDialogs::Show
FunctionEnd

Function EmulatorChoicePage2Leave
  ${NSD_GetState} $EmuFlycast $0
  ${If} $0 == ${BST_CHECKED}
    StrCpy $SelectedEmulators "$SelectedEmulators,flycast"
  ${EndIf}
  ${NSD_GetState} $EmuScummvm $0
  ${If} $0 == ${BST_CHECKED}
    StrCpy $SelectedEmulators "$SelectedEmulators,scummvm"
  ${EndIf}
  ${NSD_GetState} $EmuEasyrpg $0
  ${If} $0 == ${BST_CHECKED}
    StrCpy $SelectedEmulators "$SelectedEmulators,easyrpg"
  ${EndIf}
  ${NSD_GetState} $EmuHypseus $0
  ${If} $0 == ${BST_CHECKED}
    StrCpy $SelectedEmulators "$SelectedEmulators,hypseus"
  ${EndIf}
  ${NSD_GetState} $EmuTsugaru $0
  ${If} $0 == ${BST_CHECKED}
    StrCpy $SelectedEmulators "$SelectedEmulators,tsugaru"
  ${EndIf}
  ${NSD_GetState} $EmuSupermodel $0
  ${If} $0 == ${BST_CHECKED}
    StrCpy $SelectedEmulators "$SelectedEmulators,supermodel"
  ${EndIf}
  ${NSD_GetState} $EmuDosboxStaging $0
  ${If} $0 == ${BST_CHECKED}
    StrCpy $SelectedEmulators "$SelectedEmulators,dosbox-staging"
  ${EndIf}
  ${NSD_GetState} $EmuDosboxX $0
  ${If} $0 == ${BST_CHECKED}
    StrCpy $SelectedEmulators "$SelectedEmulators,dosbox-x"
  ${EndIf}
  ${NSD_GetState} $EmuVpinball $0
  ${If} $0 == ${BST_CHECKED}
    StrCpy $SelectedEmulators "$SelectedEmulators,vpinball"
  ${EndIf}
  ${NSD_GetState} $EmuKemulator $0
  ${If} $0 == ${BST_CHECKED}
    StrCpy $SelectedEmulators "$SelectedEmulators,kemulator"
  ${EndIf}
  ${NSD_GetState} $EmuRuffle $0
  ${If} $0 == ${BST_CHECKED}
    StrCpy $SelectedEmulators "$SelectedEmulators,ruffle"
  ${EndIf}
  ${NSD_GetState} $EmuTeknoparrot $0
  ${If} $0 == ${BST_CHECKED}
    StrCpy $SelectedEmulators "$SelectedEmulators,teknoparrot"
  ${EndIf}
FunctionEnd

Function EmulatorChoicePage3Create
  !insertmacro MUI_HEADER_TEXT "PC game launchers" \
    "Adds your installed Steam / Epic Games Store library to ES-DE automatically — no manual shortcuts needed. Safe to select even if one isn't installed; it's just skipped."

  nsDialogs::Create 1018
  Pop $0
  ${If} $0 == error
    Abort
  ${EndIf}

  ${NSD_CreateCheckbox} 0 0 48% 12u "Steam library"
  Pop $EmuSteam
  ${NSD_CreateCheckbox} 50% 0 48% 12u "Epic Games Store library"
  Pop $EmuEpic

  nsDialogs::Show
FunctionEnd

Function EmulatorChoicePage3Leave
  ${NSD_GetState} $EmuSteam $0
  ${If} $0 == ${BST_CHECKED}
    StrCpy $SelectedEmulators "$SelectedEmulators,steam"
  ${EndIf}
  ${NSD_GetState} $EmuEpic $0
  ${If} $0 == ${BST_CHECKED}
    StrCpy $SelectedEmulators "$SelectedEmulators,epic"
  ${EndIf}
FunctionEnd

; --- BIOS/firmware disclosure ---
; A few of the emulators above are legally unable to work at all without
; a BIOS/firmware dump the *user* has to provide (LumaArcade can't
; legally bundle Nintendo/Sony/Microsoft firmware, same reason no
; emulator project does) -- shown once, always, regardless of which
; emulators were actually selected, so it's seen even on a repair/
; install-more-emulators run where the emulator pages above are skipped.
Function BiosNoticePageCreate
  !insertmacro MUI_HEADER_TEXT "BIOS and firmware files" \
    "A few systems legally need files LumaArcade can't include for you. This is normal for every emulator, not specific to this installer."

  nsDialogs::Create 1018
  Pop $0
  ${If} $0 == error
    Abort
  ${EndIf}

  ${NSD_CreateLabel} 0 0 100% 200u "Won't work at all without these (dumped from hardware you own, or sourced yourself — this installer never provides them):$\r$\n$\r$\n  - Xbox (xemu) - MCPX boot ROM + an Xbox hard drive image$\r$\n  - Switch (Eden) - Switch firmware + prod.keys$\r$\n  - PS3 (RPCS3) - PS3 firmware, installed once from inside RPCS3$\r$\n  - PS Vita (Vita3K) - PS Vita firmware, installed once from inside Vita3K$\r$\n  - Wii U (Cemu) - a keys.txt file, needed by most retail games$\r$\n  - 3DS (Azahar) - 3DS firmware + seeddb.bin, needed by many games$\r$\n  - Sega CD, Saturn, TurboGrafx-CD (RetroArch) - a system BIOS file dropped into RetroArch's system\ folder$\r$\n  - Neo Geo (RetroArch/FBNeo) - neogeo.zip, specifically in RetroArch's system\neogeo\ folder, not next to the game ROMs$\r$\n  - Other arcade/MAME romsets - some need a separate BIOS zip alongside the game files too$\r$\n$\r$\nWork without one, but compatibility is noticeably better with a real BIOS: PS1, PS2, PSP, Dreamcast, and DS.$\r$\n$\r$\nEach emulator's own settings/documentation covers exactly where its BIOS files go — see the README for exact filenames."
  Pop $1

  nsDialogs::Show
FunctionEnd

Function BiosNoticePageLeave
FunctionEnd

Page custom EmulatorChoicePageCreate EmulatorChoicePageLeave
Page custom EmulatorChoicePage2Create EmulatorChoicePage2Leave
Page custom EmulatorChoicePage3Create EmulatorChoicePage3Leave
Page custom BiosNoticePageCreate BiosNoticePageLeave

!insertmacro MUI_PAGE_INSTFILES

; --- Finish page: start-with-Windows checkbox ---
Var StartWithWindows

Function FinishPageCheckbox
  ${NSD_CreateCheckbox} 120u -18u 100% 12u "Start LumaArcade when Windows starts"
  Pop $StartWithWindows
FunctionEnd

Function FinishPageCheckboxLeave
  ${NSD_GetState} $StartWithWindows $0
  ${If} $0 == ${BST_CHECKED}
    WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "LumaArcade" \
      'wscript.exe "$INSTDIR\LumaArcade.vbs"'
  ${EndIf}
FunctionEnd

!define MUI_FINISHPAGE_SHOWREADME ""
!define MUI_FINISHPAGE_SHOWREADME_TEXT "Launch LumaArcade now"
!define MUI_FINISHPAGE_SHOWREADME_FUNCTION LaunchApp
!define MUI_PAGE_CUSTOMFUNCTION_SHOW FinishPageCheckbox
!define MUI_PAGE_CUSTOMFUNCTION_LEAVE FinishPageCheckboxLeave
!insertmacro MUI_PAGE_FINISH

!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES

!insertmacro MUI_LANGUAGE "English"

Function LaunchApp
  Exec 'wscript.exe "$INSTDIR\LumaArcade.vbs"'
FunctionEnd

Section "Install"
  ${If} $InstallMode != "emulators-only"
    SetOutPath "$INSTDIR"
    File /r "staging\*.*"

    ; Fetches and installs Sunshine + ES-DE + moonlight-web-stream — see
    ; scripts/install-deps.ps1 for the details. Every step in that script is
    ; best-effort/non-fatal (network installs, one of the three's silent-mode
    ; flag isn't 100% confirmed), so a failure here logs to the install log
    ; and falls back to documented manual steps rather than aborting the
    ; LumaArcade install itself — same philosophy the old installer used for
    ; GStreamer/ViGEmBus.
    DetailPrint "Installing Sunshine, ES-DE, and moonlight-web-stream..."
    nsExec::ExecToLog 'powershell -NoProfile -ExecutionPolicy Bypass -File "$INSTDIR\scripts\install-deps.ps1" -InstDir "$INSTDIR"'
    Pop $0
    ${If} $0 != 0
      DetailPrint "Dependency setup script exited with code $0 — check the install log above; anything it couldn't do, do manually per the README."
    ${EndIf}

    WriteUninstaller "$INSTDIR\Uninstall.exe"

    CreateDirectory "$SMPROGRAMS\${APP_NAME}"
    CreateShortcut "$SMPROGRAMS\${APP_NAME}\${APP_NAME}.lnk" "wscript.exe" \
      '"$INSTDIR\LumaArcade.vbs"' "$INSTDIR\node.exe"
    CreateShortcut "$SMPROGRAMS\${APP_NAME}\Uninstall ${APP_NAME}.lnk" "$INSTDIR\Uninstall.exe"

    WriteRegStr HKCU "${UNINST_KEY}" "DisplayName" "${APP_NAME}"
    WriteRegStr HKCU "${UNINST_KEY}" "UninstallString" '"$INSTDIR\Uninstall.exe"'
    WriteRegStr HKCU "${UNINST_KEY}" "InstallLocation" "$INSTDIR"
    WriteRegStr HKCU "${UNINST_KEY}" "Publisher" "${APP_PUBLISHER}"
    WriteRegDWORD HKCU "${UNINST_KEY}" "NoModify" 1
    WriteRegDWORD HKCU "${UNINST_KEY}" "NoRepair" 1
  ${EndIf}

  ${If} $SelectedEmulators != ""
    ; ES-DE must already exist (from this run's install-deps.ps1 above, or
    ; a prior run in "emulators-only" mode) — probe the same locations
    ; detect.ts uses server-side, since the installer can't call into the
    ; Node app to ask it.
    StrCpy $1 ""
    IfFileExists "C:\Program Files\ES-DE\ES-DE.exe" 0 +2
      StrCpy $1 "C:\Program Files\ES-DE\ES-DE.exe"
    IfFileExists "C:\Program Files (x86)\ES-DE\ES-DE.exe" 0 +2
      StrCpy $1 "C:\Program Files (x86)\ES-DE\ES-DE.exe"
    IfFileExists "$LOCALAPPDATA\Programs\ES-DE\ES-DE.exe" 0 +2
      StrCpy $1 "$LOCALAPPDATA\Programs\ES-DE\ES-DE.exe"

    ${If} $1 == ""
      DetailPrint "Couldn't find an ES-DE install to attach emulators to — install ES-DE first, then re-run this installer and choose 'Install more emulators'."
    ${Else}
      DetailPrint "Installing selected emulators..."
      nsExec::ExecToLog 'powershell -NoProfile -ExecutionPolicy Bypass -File "$INSTDIR\scripts\install-emulators.ps1" -EsdePath "$1" -Selected "$SelectedEmulators"'
      Pop $0
      ${If} $0 != 0
        DetailPrint "Emulator install script exited with code $0 — check the install log above."
      ${EndIf}
    ${EndIf}
  ${EndIf}
SectionEnd

Section "Uninstall"
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "LumaArcade"
  DeleteRegKey HKCU "${UNINST_KEY}"

  Delete "$SMPROGRAMS\${APP_NAME}\${APP_NAME}.lnk"
  Delete "$SMPROGRAMS\${APP_NAME}\Uninstall ${APP_NAME}.lnk"
  RMDir "$SMPROGRAMS\${APP_NAME}"

  ; /SD IDYES: under a silent uninstall (/S) there's no one to click the box,
  ; so default to the safe choice (keep data) instead of the box blocking —
  ; deterministic either way, rather than relying on unspecified fallback
  ; behavior for an unanswered dialog.
  IfFileExists "$INSTDIR\server\luma-arcade.db" 0 +3
    MessageBox MB_YESNO|MB_ICONQUESTION "Keep your LumaArcade settings and library data?" /SD IDYES IDYES keepdata
    Delete "$INSTDIR\server\luma-arcade.db"
    Delete "$INSTDIR\server\luma-arcade.db-wal"
    Delete "$INSTDIR\server\luma-arcade.db-shm"
  keepdata:

  RMDir /r "$INSTDIR\server\dist"
  RMDir /r "$INSTDIR\server\node_modules"
  Delete "$INSTDIR\server\package.json"
  Delete "$INSTDIR\server\package-lock.json"
  RMDir /r "$INSTDIR\client"
  RMDir /r "$INSTDIR\scripts"
  RMDir /r "$INSTDIR\moonlight-web-stream"
  Delete "$INSTDIR\node.exe"
  Delete "$INSTDIR\LumaArcade.vbs"
  Delete "$INSTDIR\Uninstall.exe"
  RMDir "$INSTDIR\server"
  RMDir "$INSTDIR"
SectionEnd
