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

!define MUI_ABORTWARNING

!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES

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

Function .onInit
  ; Non-blocking check: GStreamer is a large external dependency this
  ; installer intentionally doesn't bundle (see README). Warn, don't block —
  ; and never show a dialog under /S, since nothing is there to click it.
  IfSilent skip_gst_check
  nsExec::ExecToStack 'where gst-launch-1.0'
  Pop $0
  ${If} $0 != 0
    MessageBox MB_OK|MB_ICONEXCLAMATION \
      "GStreamer (with the webrtcsink/d3d11 plugins) wasn't found on PATH.$\r$\n$\r$\n\
      LumaArcade will still install, but video streaming needs it. See the$\r$\n\
      README's Prerequisites section for setup instructions." /SD IDOK
  ${EndIf}
  skip_gst_check:
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
  Delete "$INSTDIR\node.exe"
  Delete "$INSTDIR\LumaArcade.vbs"
  Delete "$INSTDIR\Uninstall.exe"
  RMDir "$INSTDIR\server"
  RMDir "$INSTDIR"
SectionEnd
