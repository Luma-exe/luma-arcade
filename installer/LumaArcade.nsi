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

!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_DIRECTORY

; Detected up front so a re-run of the installer (upgrading an existing
; install, which happens on every app update) never re-applies the
; first-run marker file below and stomps on settings the user already
; configured — the launch-mode choice below only ever takes effect once,
; on a genuinely fresh install.
Var IsUpgrade
Function .onInit
  IfFileExists "$INSTDIR\server\luma-arcade.db" 0 +2
    StrCpy $IsUpgrade "1"
FunctionEnd

; --- Custom page: optional ES-DE install ---
Var EsdeCheckbox
Var InstallEsdeChoice
Var EsdePath
Var EsdePathEscaped

; Windows paths contain backslashes, which aren't valid unescaped inside a
; JSON string — doubles every backslash in $0, result left in $0. Written
; by hand rather than reaching for WordFunc.nsh's ${WordReplace} since this
; project has been burned before by assuming a library call's exact
; parameter semantics without verifying them (see pipeline.ts's history) —
; a few lines of primitive StrCpy/IntOp is worth the certainty here.
Function EscapeBackslashes
  StrCpy $9 ""
  StrCpy $8 0
  esc_loop:
    StrCpy $7 $0 1 $8
    StrCmp $7 "" esc_done
    StrCmp $7 "\" 0 esc_notslash
      StrCpy $9 "$9\\"
      Goto esc_next
    esc_notslash:
      StrCpy $9 "$9$7"
    esc_next:
    IntOp $8 $8 + 1
    Goto esc_loop
  esc_done:
  StrCpy $0 $9
FunctionEnd

Function EsdeChoicePageCreate
  !insertmacro MUI_HEADER_TEXT "Standalone vs. ES-DE (optional)" \
    "Choose how LumaArcade shows your library. You can switch anytime from the tray icon."
  nsDialogs::Create 1018
  Pop $0
  ${If} $0 == error
    Abort
  ${EndIf}

  ${NSD_CreateLabel} 0 0 100% 16u \
    "ES-DE (EmulationStation Desktop Edition) is a real, separately-developed frontend. \
    LumaArcade can either be its own simple front-end, or launch and stream a live window \
    straight into a real ES-DE install."
  Pop $0

  ${NSD_CreateLabel} 0 20u 100% 34u \
    "Standalone (no extra install):$\r$\n\
    + Works immediately, nothing else to install or set up$\r$\n\
    + One simple screen for Steam / Epic / emulators / Full Desktop$\r$\n\
    - Basic library view only - titles and IGDB box art, no scraped videos or themes"
  Pop $0

  ${NSD_CreateLabel} 0 62u 100% 34u \
    "ES-DE mode:$\r$\n\
    + Full ES-DE experience - real scraped box art, videos, themes, save states$\r$\n\
    + Best if you already use ES-DE on this PC for your emulator library$\r$\n\
    - Separate app you configure yourself; adds a moment's delay on open while it launches"
  Pop $0

  ${NSD_CreateCheckbox} 0 100u 100% 12u "Install ES-DE via winget (skip if you already have it)"
  Pop $EsdeCheckbox
  ${NSD_SetState} $EsdeCheckbox ${BST_UNCHECKED}

  ${NSD_CreateLabel} 0 116u 100% 12u "You'll pick which mode to start in on the last page."
  Pop $0

  nsDialogs::Show
FunctionEnd

Function EsdeChoicePageLeave
  ${NSD_GetState} $EsdeCheckbox $InstallEsdeChoice
FunctionEnd

Page custom EsdeChoicePageCreate EsdeChoicePageLeave

; --- Custom page: no-monitor / virtual display driver ---
; A significant fraction of LumaArcade users run it on a headless box (a
; spare PC in a closet, a cloud/rented server) with no monitor plugged in
; at all. Windows won't fully render a desktop with zero display devices —
; the screen-capture pipeline gets blank frames — so this asks up front
; rather than leaving the user to discover it later as "the stream is just
; black". The fix is a virtual display driver (usbmmidd_v2 — Amyuni's
; USB Mobile Monitor driver, signed, no reboot needed) that makes Windows
; believe a real 1024x768 monitor is attached at all times.
Var NoMonitorYesRadio
Var NoMonitorNoRadio
Var InstallVirtualDisplayCheckbox
Var InstallVirtualDisplayChoice

Function DisplayChoicePageCreate
  !insertmacro MUI_HEADER_TEXT "Display setup" \
    "This affects whether LumaArcade can actually capture and stream video."
  nsDialogs::Create 1018
  Pop $0
  ${If} $0 == error
    Abort
  ${EndIf}

  ${NSD_CreateLabel} 0 0 100% 28u \
    "LumaArcade streams your screen, so Windows needs something to actually render a \
    desktop to. If this PC has no monitor plugged in at all (a headless server, a spare \
    PC tucked away, etc.), Windows won't compose a real desktop and the stream will just \
    show up blank/black — even though everything else is working."

  ${NSD_CreateLabel} 0 32u 100% 12u "Is a real monitor connected to this PC right now?"
  Pop $0

  ${NSD_CreateRadioButton} 12u 46u 80u 12u "Yes"
  Pop $NoMonitorYesRadio
  ${NSD_SetState} $NoMonitorYesRadio ${BST_CHECKED}
  ${NSD_CreateRadioButton} 12u 60u 80u 12u "No"
  Pop $NoMonitorNoRadio
  ${NSD_OnClick} $NoMonitorNoRadio DisplayChoiceOnNoSelected
  ${NSD_OnClick} $NoMonitorYesRadio DisplayChoiceOnYesSelected

  ${NSD_CreateCheckbox} 12u 78u 100% 24u \
    "Install a virtual display driver (usbmmidd_v2, signed, no reboot) so Windows \
    always has a display to render to"
  Pop $InstallVirtualDisplayCheckbox
  ${NSD_SetState} $InstallVirtualDisplayCheckbox ${BST_UNCHECKED}
  EnableWindow $InstallVirtualDisplayCheckbox 0

  ${NSD_CreateLabel} 0 106u 100% 24u \
    "This step needs an admin confirmation (UAC prompt) since it installs a driver. \
    Skip it if you already set this up, or plan to plug in a monitor / dummy HDMI plug \
    instead."
  Pop $0

  nsDialogs::Show
FunctionEnd

Function DisplayChoiceOnNoSelected
  EnableWindow $InstallVirtualDisplayCheckbox 1
  ${NSD_SetState} $InstallVirtualDisplayCheckbox ${BST_CHECKED}
FunctionEnd

Function DisplayChoiceOnYesSelected
  ${NSD_SetState} $InstallVirtualDisplayCheckbox ${BST_UNCHECKED}
  EnableWindow $InstallVirtualDisplayCheckbox 0
FunctionEnd

Function DisplayChoicePageLeave
  ${NSD_GetState} $InstallVirtualDisplayCheckbox $InstallVirtualDisplayChoice
FunctionEnd

Page custom DisplayChoicePageCreate DisplayChoicePageLeave

!insertmacro MUI_PAGE_INSTFILES

; --- Finish page: start-with-Windows + launch mode choice ---
Var StartWithWindows
Var LaunchModeStandaloneRadio
Var LaunchModeEsdeRadio

Function FinishPageCheckbox
  ${NSD_CreateCheckbox} 120u -54u 100% 12u "Start LumaArcade when Windows starts"
  Pop $StartWithWindows

  ${NSD_CreateLabel} 120u -40u 60u 12u "Start in:"
  Pop $0
  ${NSD_CreateRadioButton} 120u -28u 90u 12u "Standalone"
  Pop $LaunchModeStandaloneRadio
  ${NSD_CreateRadioButton} 215u -28u 90u 12u "ES-DE"
  Pop $LaunchModeEsdeRadio
  ${If} $EsdePath != ""
    ${NSD_SetState} $LaunchModeEsdeRadio ${BST_CHECKED}
  ${Else}
    ${NSD_SetState} $LaunchModeStandaloneRadio ${BST_CHECKED}
  ${EndIf}
FunctionEnd

Function FinishPageCheckboxLeave
  ${NSD_GetState} $StartWithWindows $0
  ${If} $0 == ${BST_CHECKED}
    WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "LumaArcade" \
      'wscript.exe "$INSTDIR\LumaArcade.vbs"'
  ${EndIf}

  ; The installer can't write to the app's SQLite settings db directly (no
  ; bundled SQLite plugin), so this choice is dropped as a plain JSON marker
  ; file the app applies once on its first boot then deletes — see
  ; server/src/main.ts's applyInitialSettingsMarker(). Only on a genuinely
  ; fresh install ($IsUpgrade unset) — an upgrade re-running this installer
  ; must never silently reset a launch mode the user already chose.
  ${If} $IsUpgrade != "1"
    ${NSD_GetState} $LaunchModeEsdeRadio $0
    StrCpy $2 "standalone"
    ${If} $0 == ${BST_CHECKED}
      StrCpy $2 "esde"
    ${EndIf}

    StrCpy $0 $EsdePath
    Call EscapeBackslashes
    StrCpy $EsdePathEscaped $0

    FileOpen $3 "$INSTDIR\initial-settings.json" w
    FileWrite $3 '{"launchMode":"$2","esdeExePath":"$EsdePathEscaped"}'
    FileClose $3
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

; Fills $EsdePath if ES-DE is found at any known install location.
Function DetectEsde
  StrCpy $EsdePath ""
  IfFileExists "C:\Program Files\ES-DE\ES-DE.exe" 0 +2
    StrCpy $EsdePath "C:\Program Files\ES-DE\ES-DE.exe"
  IfFileExists "C:\Program Files (x86)\ES-DE\ES-DE.exe" 0 +2
    StrCpy $EsdePath "C:\Program Files (x86)\ES-DE\ES-DE.exe"
  IfFileExists "$LOCALAPPDATA\Programs\ES-DE\ES-DE.exe" 0 +2
    StrCpy $EsdePath "$LOCALAPPDATA\Programs\ES-DE\ES-DE.exe"
FunctionEnd

Section "Install"
  SetOutPath "$INSTDIR"
  File /r "staging\*.*"

  WriteUninstaller "$INSTDIR\Uninstall.exe"

  ; --- Prerequisites: GStreamer (video pipeline) and ViGEmBus (virtual
  ; controller driver) aren't bundled — too large/separately licensed — but
  ; the installer does try to fetch them itself via winget rather than just
  ; nagging, since a large fraction of users won't otherwise ever run the
  ; manual setup steps. Both checks are cheap presence probes so re-running
  ; the installer (e.g. an app upgrade) doesn't re-trigger a network install
  ; every time. Neither failure aborts the LumaArcade install itself — these
  ; degrade to documented manual setup (see README) if winget is missing,
  ; offline, or a driver install needs an admin prompt nobody is there to
  ; approve (relevant mainly under /S, where nothing can click through it).
  DetailPrint "Checking GStreamer..."
  nsExec::ExecToStack 'where gst-launch-1.0'
  Pop $0
  ${If} $0 != 0
    DetailPrint "GStreamer not found  -  installing via winget (this may take a while)..."
    nsExec::ExecToLog 'winget install --id gstreamerproject.gstreamer -e --accept-package-agreements --accept-source-agreements --silent'
    Pop $0
    ${If} $0 != 0
      DetailPrint "winget install of GStreamer did not succeed (code $0)  -  see README Prerequisites to install it manually."
    ${EndIf}
  ${Else}
    DetailPrint "GStreamer already present."
  ${EndIf}

  ; GStreamer's very first run after install (or after any plugin set
  ; change) has to scan every plugin DLL and build its registry cache
  ; on disk — observed to take well past the app's 15-second "did the
  ; capture pipeline come up" timeout, so a user's actual first stream
  ; attempt right after installing fails with a timeout even though
  ; nothing is wrong. Pay that cost once here instead, during install,
  ; where a slow one-off doesn't look like a broken app. Non-fatal:
  ; if this doesn't run (path not found, etc.) the app still works,
  ; it just eats the same delay on the user's first real stream.
  DetailPrint "Warming up GStreamer's plugin registry cache (one-time, may take a bit)..."
  nsExec::ExecToLog '"C:\gstreamer\1.0\msvc_x86_64\bin\gst-inspect-1.0.exe" -a'
  Pop $0
  ${If} $0 != 0
    nsExec::ExecToLog 'gst-inspect-1.0 -a'
    Pop $0
  ${EndIf}

  DetailPrint "Checking cloudflared (remote access tunnel)..."
  nsExec::ExecToStack 'where cloudflared'
  Pop $0
  ${If} $0 != 0
    DetailPrint "cloudflared not found  -  installing via winget..."
    nsExec::ExecToLog 'winget install --id Cloudflare.cloudflared -e --accept-package-agreements --accept-source-agreements --silent'
    Pop $0
    ${If} $0 != 0
      DetailPrint "winget install of cloudflared did not succeed (code $0)  -  install it manually if you want remote access via Cloudflare Tunnel."
    ${EndIf}
  ${Else}
    DetailPrint "cloudflared already present."
  ${EndIf}

  DetailPrint "Checking ViGEmBus (virtual controller driver)..."
  ReadRegStr $1 HKLM "SYSTEM\CurrentControlSet\Services\ViGEmBus" "Type"
  ${If} $1 == ""
    DetailPrint "ViGEmBus not found  -  installing via winget..."
    nsExec::ExecToLog 'winget install --id ViGEm.ViGEmBus -e --accept-package-agreements --accept-source-agreements --silent'
    Pop $0
    ${If} $0 != 0
      DetailPrint "winget install of ViGEmBus did not succeed (code $0)  -  controller passthrough will stay disabled until it's installed manually."
    ${EndIf}
  ${Else}
    DetailPrint "ViGEmBus already present."
  ${EndIf}

  ${If} $InstallVirtualDisplayChoice == ${BST_CHECKED}
    DetailPrint "Installing virtual display driver (usbmmidd_v2)..."
    nsExec::ExecToLog 'curl -L -o "$TEMP\usbmmidd_v2.zip" https://www.amyuni.com/downloads/usbmmidd_v2.zip'
    Pop $0
    ${If} $0 != 0
      DetailPrint "Download of usbmmidd_v2 failed (code $0)  -  install it manually, or plug in a monitor/dummy plug. See README."
    ${Else}
      CreateDirectory "$INSTDIR\drivers\usbmmidd_v2"
      nsExec::ExecToLog 'powershell -NoProfile -Command "Expand-Archive -Path $\"$TEMP\usbmmidd_v2.zip$\" -DestinationPath $\"$INSTDIR\drivers\usbmmidd_v2$\" -Force"'
      Pop $0
      ; Driver install genuinely needs admin rights, unlike the rest of this
      ; installer (RequestExecutionLevel user) — ExecShellWait's "runas" verb
      ; pops a UAC prompt scoped to just this step, so everyone who doesn't
      ; need this optional page never sees an elevation prompt at all.
      ExecShellWait "runas" "$INSTDIR\drivers\usbmmidd_v2\usbmmidd_v2\deviceinstaller64.exe" \
        'install "$INSTDIR\drivers\usbmmidd_v2\usbmmidd_v2\usbmmIdd.inf" usbmmIdd'
      ExecShellWait "runas" "$INSTDIR\drivers\usbmmidd_v2\usbmmidd_v2\deviceinstaller64.exe" \
        'enableidd 1'
      DetailPrint "Virtual display driver installed and enabled."
    ${EndIf}
  ${EndIf}

  Call DetectEsde
  ${If} $InstallEsdeChoice == ${BST_CHECKED}
  ${AndIf} $EsdePath == ""
    DetailPrint "Installing ES-DE via winget (this may take a while)..."
    nsExec::ExecToLog 'winget install --id ES-DE.EmulationStation-DE -e --accept-package-agreements --accept-source-agreements --silent'
    Pop $0
    ${If} $0 != 0
      DetailPrint "winget install of ES-DE did not succeed (code $0)  -  install it manually if you want ES-DE mode."
    ${EndIf}
    Call DetectEsde
  ${ElseIf} $EsdePath != ""
    DetailPrint "ES-DE already present at $EsdePath."
  ${EndIf}

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

  Delete "$INSTDIR\initial-settings.json"
  RMDir /r "$INSTDIR\server\dist"
  RMDir /r "$INSTDIR\server\node_modules"
  Delete "$INSTDIR\server\package.json"
  Delete "$INSTDIR\server\package-lock.json"
  RMDir /r "$INSTDIR\client"
  Delete "$INSTDIR\node.exe"
  Delete "$INSTDIR\LumaArcade.vbs"
  Delete "$INSTDIR\Uninstall.exe"
  RMDir "$INSTDIR\server"
  RMDir "$INSTDIR"
SectionEnd
