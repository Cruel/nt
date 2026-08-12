!include "LogicLib.nsh"
!include "StrFunc.nsh"
!include "WinMessages.nsh"

!ifdef BUILD_UNINSTALLER
  ${UnStrRep}
!else
  ${StrStr}
!endif

!define NOVELTEA_CLI_PATH_VALUE "NovelTeaCliPathEntry"

!macro ReadNovelTeaPath output
  ${If} $installMode == "all"
    ReadRegStr ${output} HKLM "SYSTEM\CurrentControlSet\Control\Session Manager\Environment" "Path"
  ${Else}
    ReadRegStr ${output} HKCU "Environment" "Path"
  ${EndIf}
!macroend

!macro WriteNovelTeaPath value
  ${If} $installMode == "all"
    WriteRegExpandStr HKLM "SYSTEM\CurrentControlSet\Control\Session Manager\Environment" "Path" ${value}
  ${Else}
    WriteRegExpandStr HKCU "Environment" "Path" ${value}
  ${EndIf}
!macroend

!macro BroadcastNovelTeaPathChange
  SendMessage ${HWND_BROADCAST} ${WM_SETTINGCHANGE} 0 "STR:Environment" /TIMEOUT=5000
!macroend

!macro customInstall
  StrCpy $R0 "$INSTDIR\resources\bin"
  !insertmacro ReadNovelTeaPath $R1
  StrCpy $R2 ";$R1;"
  ${StrStr} $R3 $R2 ";$R0;"
  ${If} $R3 == ""
    SearchPath $R4 "noveltea.exe"
    ${If} $R4 != ""
    ${AndIf} $R4 != "$R0\noveltea.exe"
      MessageBox MB_YESNO|MB_ICONEXCLAMATION|MB_DEFBUTTON2 \
        "Another noveltea.exe is already available on PATH at:$\r$\n$R4$\r$\n$\r$\nUse the NovelTea Editor CLI by default instead?" \
        /SD IDNO IDNO noveltea_cli_path_done
    ${EndIf}
    ${If} $R1 == ""
      StrCpy $R1 "$R0"
    ${Else}
      StrCpy $R1 "$R0;$R1"
    ${EndIf}
    !insertmacro WriteNovelTeaPath $R1
    WriteRegStr SHELL_CONTEXT "${INSTALL_REGISTRY_KEY}" "${NOVELTEA_CLI_PATH_VALUE}" "$R0"
    !insertmacro BroadcastNovelTeaPathChange
  ${EndIf}
  noveltea_cli_path_done:
!macroend

!macro customUnInstall
  ReadRegStr $R0 SHELL_CONTEXT "${INSTALL_REGISTRY_KEY}" "${NOVELTEA_CLI_PATH_VALUE}"
  ${If} $R0 == "$INSTDIR\resources\bin"
    !insertmacro ReadNovelTeaPath $R1
    StrCpy $R2 ";$R1;"
    ${UnStrRep} $R2 $R2 ";$R0;" ";"
    StrCpy $R3 $R2 1
    ${If} $R3 == ";"
      StrCpy $R2 $R2 "" 1
    ${EndIf}
    StrLen $R3 $R2
    ${If} $R3 > 0
      IntOp $R3 $R3 - 1
      StrCpy $R4 $R2 1 $R3
      ${If} $R4 == ";"
        StrCpy $R2 $R2 $R3
      ${EndIf}
    ${EndIf}
    !insertmacro WriteNovelTeaPath $R2
    DeleteRegValue SHELL_CONTEXT "${INSTALL_REGISTRY_KEY}" "${NOVELTEA_CLI_PATH_VALUE}"
    !insertmacro BroadcastNovelTeaPathChange
  ${EndIf}
!macroend
