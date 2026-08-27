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

!define MUI_ABORTWARNING

; Security reminder shown on the welcome page rather than buried only in the
; README - anyone who connects and streams through LumaArcade gets full
; access to whatever Windows account it runs under (files, browser sessions,
; saved passwords). Cheap to say once, up front, before install even starts.
!define MUI_WELCOMEPAGE_TITLE "Welcome to LumaArcade Setup"
!define MUI_WELCOMEPAGE_TEXT "This will install LumaArcade.$\r$\n$\r$\nRecommended: install and run this under a Windows account dedicated to it, not your own personal daily account - anyone who streams through it gets full access to whatever's on that account's desktop.$\r$\n$\r$\nClick Next to continue."

!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_DIRECTORY
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
  SetOutPath "$INSTDIR"
  File /r "staging\*.*"

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
SectionEnd

Section "Uninstall"
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "LumaArcade"
  DeleteRegKey HKCU "${UNINST_KEY}"

  Delete "$SMPROGRAMS\${APP_NAME}\${APP_NAME}.lnk"
  Delete "$SMPROGRAMS\${APP_NAME}\Uninstall ${APP_NAME}.lnk"
  RMDir "$SMPROGRAMS\${APP_NAME}"

  ; /SD IDYES: under a silent uninstall (/S) there's no one to click the box,
  ; so default to the safe choice (keep data) instead of the box blocking -
  ; deterministic either way, rather than relying on unspecified fallback
  ; behavior for an unanswered dialog.
  IfFileExists "$INSTDIR\server\luma-arcade.db" 0 keepdata
    MessageBox MB_YESNO|MB_ICONQUESTION "Keep your LumaArcade settings and library data?" /SD IDYES IDYES keepdata
    ; Back up to Documents before deleting either way - a silent/scripted
    ; uninstall (/S) can't be asked "are you sure", and a deleted db is
    ; otherwise unrecoverable. Overwrites any previous backup from an
    ; earlier uninstall rather than accumulating timestamped copies.
    CreateDirectory "$DOCUMENTS\LumaArcade-backup"
    CopyFiles /SILENT "$INSTDIR\server\luma-arcade.db*" "$DOCUMENTS\LumaArcade-backup\"
    Delete "$INSTDIR\server\luma-arcade.db"
    Delete "$INSTDIR\server\luma-arcade.db-wal"
    Delete "$INSTDIR\server\luma-arcade.db-shm"
  keepdata:

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
