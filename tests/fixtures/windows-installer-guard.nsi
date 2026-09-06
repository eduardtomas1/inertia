Unicode true
Name "Inertia installer guard fixture"
OutFile "$%INERTIA_GUARD_FIXTURE_OUTPUT%"
RequestExecutionLevel user
SilentInstall silent
!include "LogicLib.nsh"
!define PRODUCT_NAME "Inertia"
Var PowerShellPath
; Retain the actual plug-in result before the shipped guard maps every
; unavailable query to silent exit 2. Production installers omit this macro.
!macro INERTIA_TEST_INSTALL_ROOT_QUERY_RESULT
  Push $R2
  Push $R3
  ReadEnvStr $R2 "INERTIA_GUARD_FIXTURE_QUERY_RESULT"
  FileOpen $R3 "$R2" w
  FileWrite $R3 "$R0"
  FileClose $R3
  Pop $R3
  Pop $R2
!macroend
!include "$%INERTIA_GUARD_FIXTURE_INCLUDE%"

; Execute the actual shipped guard, including preparing an empty destination,
; without installing files, touching the registry, or stopping any process.
Section
  ReadEnvStr $INSTDIR "INERTIA_GUARD_FIXTURE_ROOT"
  StrCpy $PowerShellPath "$SYSDIR\WindowsPowerShell\v1.0\powershell.exe"
  !insertmacro customCheckAppRunning
  SetErrorLevel 0
SectionEnd
