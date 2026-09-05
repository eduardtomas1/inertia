!macro customCheckAppRunning
  !insertmacro IS_POWERSHELL_AVAILABLE

  inertia_check_install_root:
    ${if} $IsPowerShellAvailable == 0
      System::Call 'kernel32::SetEnvironmentVariableW(w, w)i("INERTIA_NSIS_INSTALL_ROOT", "$INSTDIR").r0'
      ${if} $0 == 0
        StrCpy $R0 2
      ${else}
        nsExec::Exec `"$PowerShellPath" -NoLogo -NoProfile -NonInteractive -Command "try { $$root = [IO.Path]::GetFullPath($$env:INERTIA_NSIS_INSTALL_ROOT).TrimEnd([char[]]'\/'); $$prefix = $$root + [IO.Path]::DirectorySeparatorChar; $$match = Get-CimInstance -ClassName Win32_Process -ErrorAction Stop | Where-Object { -not [String]::IsNullOrEmpty($$_.ExecutablePath) -and [IO.Path]::GetFullPath($$_.ExecutablePath).StartsWith($$prefix, [StringComparison]::OrdinalIgnoreCase) } | Select-Object -First 1; if ($$null -eq $$match) { exit 1 }; exit 0 } catch { exit 2 }"`
        Pop $R0
        System::Call 'kernel32::SetEnvironmentVariableW(w, p)i("INERTIA_NSIS_INSTALL_ROOT", 0).r1'
      ${endIf}
    ${else}
      StrCpy $R0 2
    ${endIf}

    ${if} $R0 == 1
      Goto inertia_install_root_clear
    ${endIf}
    ${if} $R0 == 0
      StrCpy $R1 "${PRODUCT_NAME} is still running. Close it, wait for safe shutdown, then click Retry. Setup will not force-close it."
    ${else}
      StrCpy $R1 "Setup could not verify that all installed ${PRODUCT_NAME} processes are closed. Close ${PRODUCT_NAME}, then click Retry. Setup will not force-close it."
    ${endIf}
    ${if} ${Silent}
      DetailPrint "$R1"
      SetErrorLevel 1
      Quit
    ${endIf}
    MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "$R1" /SD IDCANCEL IDRETRY inertia_check_install_root
    SetErrorLevel 1
    Quit

  inertia_install_root_clear:
!macroend
