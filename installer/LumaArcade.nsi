Unicode true

!define APP_NAME "LumaArcade"
!define APP_TITLE "Luma Arcade"
!define APP_PUBLISHER "LumaArcade"
!define UNINST_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APP_NAME}"
; 64-bit PowerShell from this 32-bit installer (plain $SYSDIR would give the
; 32-bit one: Program Files (x86), redirected registry).
!define POWERSHELL "$WINDIR\Sysnative\WindowsPowerShell\v1.0\powershell.exe"

Name "${APP_TITLE}"
OutFile "output\LumaArcadeSetup.exe"
InstallDir "$PROGRAMFILES64\${APP_NAME}"
; Admin: Sunshine, Windows accounts, the Server fixes and the shared games
; folder all need it.
RequestExecutionLevel admin
ShowInstDetails show
ShowUninstDetails show

!include "MUI2.nsh"
!include "nsDialogs.nsh"
!include "LogicLib.nsh"
!include "Sections.nsh"
!include "x64.nsh"

!define MUI_ABORTWARNING

; ---------------------------------------------------------------- state
Var SetupType        ; 0 = everything (streaming), 1 = ES-DE + emulators, 2 = emulators only
Var SetupTypeApplied ; the type the component selection was last set up for
Var IsServer         ; 1 = Windows Server
Var DetectedServer
Var Ds4              ; 1 = Sunshine emulates PS4 pads (Server without the Xbox 360 driver)
Var HasXusb
Var SeparateAccount  ; 1 = run under its own Windows account
Var AccountName
Var AccountPass
Var AutoLogon
Var StartAtLogon
Var GamesDir
Var EmuList
Var CurrentUser

; page controls
Var hType0
Var hType1
Var hType2
Var hClient
Var hServer
Var hDs4
Var hCurrent
Var hSeparate
Var hName
Var hPass
Var hPass2
Var hAutoLogon
Var hStartAtLogon

; ---------------------------------------------------------------- pages
!define MUI_WELCOMEPAGE_TITLE "Welcome to ${APP_TITLE} Setup"
!define MUI_WELCOMEPAGE_TEXT "Luma Arcade turns this PC into a game console you can play from any web browser - on your TV, laptop or phone, at home or away.$\r$\n$\r$\nYou don't have to install all of it. The next page lets you pick:$\r$\n  - everything, for streaming games to a browser,$\r$\n  - just ES-DE and emulators, to play on this PC, or$\r$\n  - just the emulators.$\r$\n$\r$\nEmulators and ES-DE are downloaded from their official releases, so this PC needs to be online.$\r$\n$\r$\nClick Next to continue."
!insertmacro MUI_PAGE_WELCOME
Page custom SetupTypePage SetupTypeLeave
!define MUI_PAGE_CUSTOMFUNCTION_PRE ComponentsPre
!insertmacro MUI_PAGE_COMPONENTS
Page custom WindowsPage WindowsLeave
Page custom AccountPage AccountLeave

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

!define MUI_FINISHPAGE_TEXT "Setup is done. The next steps (first sign-in, pairing, where games and BIOS files go) are in the file below."
!define MUI_FINISHPAGE_SHOWREADME ""
!define MUI_FINISHPAGE_SHOWREADME_TEXT "Show the next steps"
!define MUI_FINISHPAGE_SHOWREADME_FUNCTION ShowNextSteps
!define MUI_FINISHPAGE_RUN ""
!define MUI_FINISHPAGE_RUN_TEXT "Open Luma Arcade now"
!define MUI_FINISHPAGE_RUN_FUNCTION LaunchApp
!define MUI_PAGE_CUSTOMFUNCTION_SHOW FinishShow
!insertmacro MUI_PAGE_FINISH

!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES

!insertmacro MUI_LANGUAGE "English"

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

; ---------------------------------------------------------------- sections
Section "Luma Arcade" SEC_LUMA
  SetOutPath "$INSTDIR"
  File /r "staging\*.*"
  File "NEXT-STEPS.txt"

  WriteUninstaller "$INSTDIR\Uninstall.exe"

  SetShellVarContext all
  CreateDirectory "$SMPROGRAMS\${APP_TITLE}"
  CreateShortcut "$SMPROGRAMS\${APP_TITLE}\${APP_TITLE}.lnk" "wscript.exe" \
    '"$INSTDIR\LumaArcade.vbs"' "$INSTDIR\node.exe"
  CreateShortcut "$SMPROGRAMS\${APP_TITLE}\Uninstall ${APP_TITLE}.lnk" "$INSTDIR\Uninstall.exe"

  SetRegView 64
  WriteRegStr HKLM "${UNINST_KEY}" "DisplayName" "${APP_TITLE}"
  WriteRegStr HKLM "${UNINST_KEY}" "UninstallString" '"$INSTDIR\Uninstall.exe"'
  WriteRegStr HKLM "${UNINST_KEY}" "InstallLocation" "$INSTDIR"
  WriteRegStr HKLM "${UNINST_KEY}" "Publisher" "${APP_PUBLISHER}"
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

Section "-Games"
  StrCpy $EmuList ""
  !insertmacro EmuArg ${SEC_RETROARCH} "retroarch"
  !insertmacro EmuArg ${SEC_DOLPHIN} "dolphin"
  !insertmacro EmuArg ${SEC_PCSX2} "pcsx2"
  !insertmacro EmuArg ${SEC_DUCKSTATION} "duckstation"
  !insertmacro EmuArg ${SEC_PPSSPP} "ppsspp"
  !insertmacro EmuArg ${SEC_RPCS3} "rpcs3"
  !insertmacro EmuArg ${SEC_XENIA} "xenia"
  !insertmacro EmuArg ${SEC_XEMU} "xemu"
  !insertmacro EmuArg ${SEC_CEMU} "cemu"
  !insertmacro EmuArg ${SEC_AZAHAR} "azahar"
  !insertmacro EmuArg ${SEC_MELONDS} "melonds"
  !insertmacro EmuArg ${SEC_VITA3K} "vita3k"
  !insertmacro EmuArg ${SEC_FLYCAST} "flycast"
  !insertmacro EmuArg ${SEC_SHADPS4} "shadps4"
  ${IfNot} ${SectionIsSelected} ${SEC_ESDE}
  ${AndIf} $EmuList == ""
    Return
  ${EndIf}
  DetailPrint "Downloading ES-DE and emulators (this can take a while)..."
  StrCpy $1 ""
  ${If} ${SectionIsSelected} ${SEC_ESDE}
    StrCpy $1 "-WithEsDe"
  ${EndIf}
  !insertmacro QuotablePath $2 $GamesDir
  !insertmacro RunPs "install-games.ps1" '-GamesDir "$2" $1 -Emulators "$EmuList"'
  ${If} $0 != 0
    MessageBox MB_ICONEXCLAMATION|MB_OK "Some of ES-DE or the emulators couldn't be installed - see the details list. You can run $GamesDir\setup\install-games.ps1 again later."
  ${EndIf}
SectionEnd

Section "Sunshine (streaming host)" SEC_SUNSHINE
  StrCpy $1 ""
  ${If} ${SectionIsSelected} ${SEC_ESDE}
    StrCpy $1 '-EsDeExe "$GamesDir\ES-DE\ES-DE.exe"'
  ${EndIf}
  ${If} $Ds4 == 1
    StrCpy $1 "$1 -Ds4"
  ${EndIf}
  !insertmacro RunPs "install-sunshine.ps1" $1
  ${If} $0 != 0
    MessageBox MB_ICONEXCLAMATION|MB_OK "Sunshine couldn't be installed - see the details list. You can install it by hand from github.com/LizardByte/Sunshine."
  ${EndIf}
SectionEnd

Section "-Windows setup"
  StrCpy $1 ""
  ${If} $IsServer == 1
    StrCpy $1 "-Server"
  ${EndIf}
  ${If} ${SectionIsSelected} ${SEC_LUMA}
    StrCpy $1 '$1 -LumaDir "$INSTDIR"'
    ${If} $StartAtLogon == 1
      StrCpy $1 "$1 -Autostart"
    ${EndIf}
    ${If} $SeparateAccount == 1
      StrCpy $1 '$1 -Account "$AccountName"'
      ${If} $AutoLogon == 1
        StrCpy $1 "$1 -AutoLogon"
      ${EndIf}
      ${If} $AccountPass != ""
        ; The password goes through a file (deleted by the script), never
        ; on a command line other programs can read.
        FileOpen $3 "$PLUGINSDIR\account.txt" w
        FileWriteWord $3 0xFEFF
        FileWriteUTF16LE $3 $AccountPass
        FileClose $3
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
    MessageBox MB_ICONEXCLAMATION|MB_OK "Part of the Windows setup failed - see the details list."
  ${EndIf}
SectionEnd

!insertmacro MUI_FUNCTION_DESCRIPTION_BEGIN
  !insertmacro MUI_DESCRIPTION_TEXT ${SEC_LUMA} "The Luma Arcade website: sign-in, the browser game streaming client (moonlight-web-stream), and who may play when."
  !insertmacro MUI_DESCRIPTION_TEXT ${SEC_SUNSHINE} "Sunshine captures this PC's screen, sound and controllers for streaming. Skipped if it's already installed."
  !insertmacro MUI_DESCRIPTION_TEXT ${SEC_ESDE} "ES-DE: a game library you browse with a controller. Finds and starts the emulators below."
  !insertmacro MUI_DESCRIPTION_TEXT ${SEC_EMUS} "Emulators, downloaded from their official releases. BIOS and firmware files are not included."
  !insertmacro MUI_DESCRIPTION_TEXT ${SEC_RETROARCH} "RetroArch with cores for NES, SNES, Mega Drive, Master System, Game Boy (Color/Advance), N64, PC Engine, Atari 2600 and arcade."
  !insertmacro MUI_DESCRIPTION_TEXT ${SEC_SHADPS4} "shadPS4: PlayStation 4, experimental - many games don't run yet."
!insertmacro MUI_FUNCTION_DESCRIPTION_END

; ---------------------------------------------------------------- init
Function .onInit
  ${IfNot} ${RunningX64}
    MessageBox MB_ICONSTOP "${APP_TITLE} needs 64-bit Windows."
    Abort
  ${EndIf}
  SetRegView 64
  InitPluginsDir
  SetOutPath "$PLUGINSDIR\scripts"
  File "scripts\*.ps1"

  ReadEnvStr $CurrentUser "USERNAME"
  StrCpy $SetupType 0
  StrCpy $SetupTypeApplied -1
  StrCpy $GamesDir "C:\Games"
  StrCpy $SeparateAccount 1
  StrCpy $AccountName "Arcade"
  StrCpy $AutoLogon 1
  StrCpy $StartAtLogon 1

  ReadRegStr $0 HKLM "SOFTWARE\Microsoft\Windows NT\CurrentVersion" "InstallationType"
  StrCpy $DetectedServer 0
  ${If} $0 == "Server"
    StrCpy $DetectedServer 1
  ${EndIf}
  StrCpy $IsServer $DetectedServer

  StrCpy $HasXusb 0
  ${DisableX64FSRedirection}
  ${If} ${FileExists} "$SYSDIR\drivers\xusb22.sys"
  ${OrIf} ${FileExists} "$SYSDIR\drivers\xusb21.sys"
    StrCpy $HasXusb 1
  ${EndIf}
  ${EnableX64FSRedirection}
  StrCpy $Ds4 0
  ${If} $IsServer == 1
  ${AndIf} $HasXusb == 0
    StrCpy $Ds4 1
  ${EndIf}
FunctionEnd

; ---------------------------------------------------------------- setup type
Function SetupTypePage
  !insertmacro MUI_HEADER_TEXT "What do you want to install?" "You can change the exact list on the next page."
  nsDialogs::Create 1018
  Pop $0

  ${NSD_CreateRadioButton} 0 0 100% 12u "Everything: stream games to a web browser (recommended)"
  Pop $hType0
  ${NSD_CreateLabel} 12u 13u -12u 26u "Luma Arcade + Sunshine + ES-DE + emulators. Play this PC's games from a browser on any device, share it with friends, with sign-in, play time limits and co-op."
  Pop $0

  ${NSD_CreateRadioButton} 0 44u 100% 12u "ES-DE and emulators: play on this PC"
  Pop $hType1
  ${NSD_CreateLabel} 12u 57u -12u 26u "A console-style game library for this PC, with a TV and controller. No streaming: no Sunshine, no website."
  Pop $0

  ${NSD_CreateRadioButton} 0 88u 100% 12u "Just the emulators"
  Pop $hType2
  ${NSD_CreateLabel} 12u 101u -12u 26u "Only the emulators, in one folder with Start menu shortcuts. For people who already use another front-end (or none)."
  Pop $0

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

; Sets the component list up for the chosen type (only when it changed, so
; going Back and Next keeps someone's own ticks).
Function ComponentsPre
  ${If} $SetupType == $SetupTypeApplied
    Return
  ${EndIf}
  StrCpy $SetupTypeApplied $SetupType
  ${If} $SetupType == 0
    !insertmacro Pick ${SEC_LUMA} 1
    !insertmacro Pick ${SEC_SUNSHINE} 1
    !insertmacro Pick ${SEC_ESDE} 1
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
FunctionEnd

; ---------------------------------------------------------------- Windows edition
Function WindowsPage
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
  ${NSD_CreateRadioButton} 0 13u 100% 12u "Windows Server (2019, 2022, 2025)$2"
  Pop $hServer
  ${If} $IsServer == 1
    ${NSD_Check} $hServer
  ${Else}
    ${NSD_Check} $hClient
  ${EndIf}

  ${NSD_CreateLabel} 0 30u 100% 76u "Most people should use normal Windows 10 or 11. Windows Server is worth it for a PC that does nothing but host games, 24/7: it doesn't force feature updates or restart on its own, has no ads or consumer apps running in the background, lets several people be signed in at once over Remote Desktop, and can give virtual machines a slice of the graphics card (GPU partitioning) for more players at once.$\r$\n$\r$\nThe catch: it has no Xbox 360 controller driver and its sound is switched off, some games' anti-cheat and Microsoft Store / Game Pass games won't run, and it costs more to license. On Server, Setup turns the sound on for you."
  Pop $0

  ${NSD_CreateCheckbox} 0 110u 100% 24u "Server only: have Sunshine emulate PlayStation 4 controllers - they work without the Xbox 360 driver (Xbox-only PC games won't see them)"
  Pop $hDs4
  ${If} $Ds4 == 1
    ${NSD_Check} $hDs4
  ${EndIf}
  ${IfNot} ${SectionIsSelected} ${SEC_SUNSHINE}
    EnableWindow $hDs4 0
  ${EndIf}
  nsDialogs::Show
FunctionEnd

Function WindowsLeave
  ${NSD_GetState} $hServer $0
  StrCpy $IsServer 0
  ${If} $0 == ${BST_CHECKED}
    StrCpy $IsServer 1
  ${EndIf}
  ${NSD_GetState} $hDs4 $0
  StrCpy $Ds4 0
  ${If} $0 == ${BST_CHECKED}
  ${AndIf} $IsServer == 1
  ${AndIf} ${SectionIsSelected} ${SEC_SUNSHINE}
    StrCpy $Ds4 1
  ${EndIf}
FunctionEnd

; ---------------------------------------------------------------- account
Function AccountPage
  ${IfNot} ${SectionIsSelected} ${SEC_LUMA}
    Abort
  ${EndIf}
  !insertmacro MUI_HEADER_TEXT "Which Windows account should run the games?" "What people who stream from this PC will see and control."
  nsDialogs::Create 1018
  Pop $0

  ${NSD_CreateLabel} 0 0 100% 42u "Anyone who streams from this PC sees and controls that account's desktop: whatever is open on it, its files, its browser sessions and saved passwords. A separate account has only the games on it and can't change the PC, so your own account stays private. It can also sign in by itself when the PC starts - Sunshine can only stream a signed-in desktop - without leaving your own account signed in."
  Pop $0

  ${NSD_CreateRadioButton} 0 44u 100% 12u "A separate account just for games (recommended)"
  Pop $hSeparate
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
  ; itself) needs one.
  nsExec::Exec 'net.exe user "$AccountName"'
  Pop $4
  ${If} $AccountPass == ""
    ${If} $4 != 0
      MessageBox MB_ICONEXCLAMATION "Choose a password for the new account."
      Abort
    ${ElseIf} $AutoLogon == 1
      MessageBox MB_ICONEXCLAMATION "To sign $AccountName in automatically, type its password."
      Abort
    ${EndIf}
  ${EndIf}
FunctionEnd

; ---------------------------------------------------------------- folders
Function LumaDirPre
  ${IfNot} ${SectionIsSelected} ${SEC_LUMA}
    Abort
  ${EndIf}
FunctionEnd

Function GamesDirPre
  StrCpy $EmuList ""
  !insertmacro EmuArg ${SEC_RETROARCH} "x"
  !insertmacro EmuArg ${SEC_DOLPHIN} "x"
  !insertmacro EmuArg ${SEC_PCSX2} "x"
  !insertmacro EmuArg ${SEC_DUCKSTATION} "x"
  !insertmacro EmuArg ${SEC_PPSSPP} "x"
  !insertmacro EmuArg ${SEC_RPCS3} "x"
  !insertmacro EmuArg ${SEC_XENIA} "x"
  !insertmacro EmuArg ${SEC_XEMU} "x"
  !insertmacro EmuArg ${SEC_CEMU} "x"
  !insertmacro EmuArg ${SEC_AZAHAR} "x"
  !insertmacro EmuArg ${SEC_MELONDS} "x"
  !insertmacro EmuArg ${SEC_VITA3K} "x"
  !insertmacro EmuArg ${SEC_FLYCAST} "x"
  !insertmacro EmuArg ${SEC_SHADPS4} "x"
  ${IfNot} ${SectionIsSelected} ${SEC_ESDE}
  ${AndIf} $EmuList == ""
    Abort
  ${EndIf}
FunctionEnd

; ---------------------------------------------------------------- finish
Function FinishShow
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

; ---------------------------------------------------------------- uninstall
Section "Uninstall"
  SetRegView 64
  nsExec::Exec 'schtasks.exe /delete /tn "\LumaArcade\LumaArcade" /f'
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "LumaArcade"
  nsExec::Exec '"${POWERSHELL}" -NoProfile -Command "Remove-NetFirewallRule -DisplayName ''Luma Arcade*'' -ErrorAction SilentlyContinue"'
  DeleteRegKey HKLM "${UNINST_KEY}"

  SetShellVarContext all
  Delete "$SMPROGRAMS\${APP_TITLE}\${APP_TITLE}.lnk"
  Delete "$SMPROGRAMS\${APP_TITLE}\Uninstall ${APP_TITLE}.lnk"
  RMDir "$SMPROGRAMS\${APP_TITLE}"

  ; /SD IDYES: under a silent uninstall (/S) there's no one to click the box,
  ; so default to the safe choice (keep data).
  IfFileExists "$INSTDIR\server\luma-arcade.db" 0 keepdata
    MessageBox MB_YESNO|MB_ICONQUESTION "Keep your Luma Arcade accounts and settings?" /SD IDYES IDYES keepdata
    ; Backed up to Documents either way - a deleted database can't come back.
    CreateDirectory "$DOCUMENTS\LumaArcade-backup"
    CopyFiles /SILENT "$INSTDIR\server\luma-arcade.db*" "$DOCUMENTS\LumaArcade-backup\"
    CopyFiles /SILENT "$INSTDIR\moonlight-web-stream\server\data.json" "$DOCUMENTS\LumaArcade-backup\"
    Delete "$INSTDIR\server\luma-arcade.db"
    Delete "$INSTDIR\server\luma-arcade.db-wal"
    Delete "$INSTDIR\server\luma-arcade.db-shm"
    Delete "$INSTDIR\moonlight-web-stream\server\data.json"
  keepdata:

  RMDir /r "$INSTDIR\server\dist"
  RMDir /r "$INSTDIR\server\assets"
  RMDir /r "$INSTDIR\server\node_modules"
  Delete "$INSTDIR\server\package.json"
  Delete "$INSTDIR\server\package-lock.json"
  RMDir /r "$INSTDIR\moonlight-web-stream\static"
  Delete "$INSTDIR\moonlight-web-stream\*.exe"
  Delete "$INSTDIR\moonlight-web-stream\*.log"
  Delete "$INSTDIR\moonlight-web-stream\server\config.json"
  Delete "$INSTDIR\moonlight-web-stream\server\turn_ice_script.*"
  RMDir "$INSTDIR\moonlight-web-stream\server"
  RMDir "$INSTDIR\moonlight-web-stream"
  Delete "$INSTDIR\node.exe"
  Delete "$INSTDIR\LumaArcade.vbs"
  Delete "$INSTDIR\NEXT-STEPS.txt"
  Delete "$INSTDIR\Uninstall.exe"
  RMDir "$INSTDIR\server"
  RMDir "$INSTDIR"

  MessageBox MB_ICONINFORMATION "Luma Arcade is removed. Sunshine, ES-DE, the emulators, your games folder and any games account were left in place - remove them yourself if you don't need them." /SD IDOK
SectionEnd
