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
; default -- several of these are multi-gigabyte downloads. Dolphin (via
; winget) and Switch/Eden (its own Gitea releases, since it moved off
; GitHub after Nintendo takedown notices) need a real interactive install
; run to work -- winget in particular is confirmed to fail outright over a
; plain remote/automated session even as the same user, so both are more
; likely to actually succeed when this installer is run normally on the
; target PC than in any kind of unattended/remote deployment.
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
  ${NSD_CreateCheckbox} 0 16u 48% 12u "Dolphin (GameCube/Wii, via winget)"
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

  ${NSD_CreateLabel} 0 116u 100% 20u \
    "Dolphin and Eden need winget, which only works when you run this \
    installer normally (not via remote/unattended deployment) -- see the \
    README if either doesn't end up installed."
  Pop $0

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

Page custom EmulatorChoicePageCreate EmulatorChoicePageLeave

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
