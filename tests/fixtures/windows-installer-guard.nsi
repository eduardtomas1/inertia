Unicode true
Name "Inertia installer guard fixture"
OutFile "$%INERTIA_GUARD_FIXTURE_OUTPUT%"
RequestExecutionLevel user
SilentInstall silent
!include "LogicLib.nsh"
!define PRODUCT_NAME "Inertia"
Var PowerShellPath
!include "$%INERTIA_GUARD_FIXTURE_INCLUDE%"

; Execute the actual shipped guard, including preparing an empty destination,
; without installing files, touching the registry, or stopping any process.
Section
  ReadEnvStr $INSTDIR "INERTIA_GUARD_FIXTURE_ROOT"
  StrCpy $PowerShellPath "$SYSDIR\WindowsPowerShell\v1.0\powershell.exe"
  !insertmacro customCheckAppRunning
  SetErrorLevel 0
SectionEnd
