; Deskwisp's own steps in its Windows installer (electron-builder.win.json "nsis.include"). electron-builder's
; templates (node_modules/app-builder-lib/templates/nsis) call these macros when they're defined.

; Before files are replaced (installing, updating, uninstalling): close everything of Deskwisp's that
; could hold them. Not only Deskwisp.exe: every process running from its folder (the windows' helpers,
; the server, the tools it ran) or started with a path in it, and the bots' own Chrome windows (their
; profiles are under ~\.deskwisp). For up to 20 seconds, without asking: it's an installer for Deskwisp,
; started on purpose. This process and the installer that started it are left alone. Only what can't be
; stopped (one running as administrator) brings the "close it manually" question.
!macro customCheckAppRunning
  Push $9
  System::Call 'kernel32::GetCurrentProcessId() i .r9'
  closeDeskwisp:
  DetailPrint `Closing Deskwisp...`
  nsExec::Exec `"$PowerShellPath" -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "$$d = '$INSTDIR\'; $$me = $9; $$up = (Get-CimInstance Win32_Process -Filter ('ProcessId=' + $$me)).ParentProcessId; $$until = (Get-Date).AddSeconds(20); do { $$left = @(Get-CimInstance Win32_Process | Where-Object { $$_.ProcessId -ne $$me -and $$_.ProcessId -ne $$up -and $$_.ProcessId -ne $$PID -and (($$_.ExecutablePath -and $$_.ExecutablePath.StartsWith($$d, [StringComparison]::OrdinalIgnoreCase)) -or ($$_.CommandLine -and $$_.CommandLine.IndexOf($$d, [StringComparison]::OrdinalIgnoreCase) -ge 0) -or ($$_.Name -eq 'chrome.exe' -and $$_.CommandLine -match '\\\.deskwisp\\')) }); if ($$left.Count -eq 0) { exit 0 }; $$left | ForEach-Object { Stop-Process -Id $$_.ProcessId -Force -ErrorAction SilentlyContinue }; Start-Sleep -Milliseconds 700 } while ((Get-Date) -lt $$until); exit 1"`
  Pop $0
  ${if} $0 == 1
    MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "$(appCannotBeClosed)" /SD IDCANCEL IDRETRY closeDeskwisp
    Quit
  ${endIf}
  ; Windows lets go of a closed program's files a moment after it ends.
  Sleep 500
  Pop $9
!macroend

; The old version's uninstaller didn't finish (a file it couldn't move, most often): install over it
; rather than stopping. The new files replace the old ones either way, and Deskwisp's data isn't in its
; folder. (Without this, the installer stops with "Failed to uninstall old application files".)
!macro customUnInstallCheck
  ${if} $R0 != 0
    DetailPrint `The old version's uninstaller ended with $R0: installing over it.`
  ${endIf}
  ClearErrors
!macroend

!macro customUnInstallCheckCurrentUser
  !insertmacro customUnInstallCheck
!macroend
