; Deskwisp's own steps in its Windows installer (electron-builder.win.json "nsis.include"). electron-builder's
; templates (node_modules/app-builder-lib/templates/nsis) call these macros when they're defined.

; What the installer (and the uninstaller an update runs) did, a line at a time, in the app's own update log,
; %APPDATA%\Deskwisp\logs\updates.log, next to what the app wrote (desktop/win-update.cjs): when an update
; doesn't happen, that file says how far it got. Never stops anything: no log, no line.
!macro deskwispLog text
  Push $R0
  Push $R1
  Push $R2
  Push $R3
  Push $R4
  Push $R5
  Push $R6
  Push $R7
  Push $R8
  ReadEnvStr $R8 APPDATA
  ${if} $R8 != ""
    CreateDirectory "$R8\Deskwisp\logs"
    ${GetTime} "" "LS" $R0 $R1 $R2 $R3 $R4 $R5 $R6
    IntFmt $R0 "%02d" $R0
    IntFmt $R1 "%02d" $R1
    IntFmt $R4 "%02d" $R4
    IntFmt $R5 "%02d" $R5
    IntFmt $R6 "%02d" $R6
    ClearErrors
    FileOpen $R7 "$R8\Deskwisp\logs\updates.log" a
    ${ifNot} ${Errors}
      FileSeek $R7 0 END
      !ifdef BUILD_UNINSTALLER
        FileWrite $R7 "$R2-$R1-$R0T$R4:$R5:$R6Z (the uninstaller of Deskwisp ${VERSION}) ${text}$\r$\n"
      !else
        FileWrite $R7 "$R2-$R1-$R0T$R4:$R5:$R6Z (the installer of Deskwisp ${VERSION}) ${text}$\r$\n"
      !endif
      FileClose $R7
    ${endIf}
  ${endIf}
  ClearErrors
  Pop $R8
  Pop $R7
  Pop $R6
  Pop $R5
  Pop $R4
  Pop $R3
  Pop $R2
  Pop $R1
  Pop $R0
!macroend

!macro customInit
  Push $R9
  ${GetParameters} $R9
  !insertmacro deskwispLog "started ($R9)"
  Pop $R9
!macroend

; Before files are replaced (installing, updating, uninstalling): close everything of Deskwisp's that
; could hold them. Not only Deskwisp.exe: every process running from its folder (the windows' helpers,
; the server, the tools it ran) or started with a path in it, and the bots' own Chrome windows (their
; profiles are under ~\.deskwisp). The first 3 seconds they may close by themselves (the app starts this
; installer for "Restart to update" and then closes), after that they're stopped, for up to 25 seconds,
; without asking: it's an installer for Deskwisp, started on purpose. This process is left alone, and the
; one that started it unless that's Deskwisp itself (an update's installer, the uninstaller's installer).
; Only what can't be stopped (one running as administrator) brings the "close it manually" question.
!macro customCheckAppRunning
  Push $9
  System::Call 'kernel32::GetCurrentProcessId() i .r9'
  closeDeskwisp:
  DetailPrint `Closing Deskwisp...`
  nsExec::Exec `"$PowerShellPath" -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "$$d = '$INSTDIR\'; $$me = $9; $$up = (Get-CimInstance Win32_Process -Filter ('ProcessId=' + $$me)).ParentProcessId; $$upPath = (Get-CimInstance Win32_Process -Filter ('ProcessId=' + $$up)).ExecutablePath; if ($$upPath -and $$upPath.StartsWith($$d, [StringComparison]::OrdinalIgnoreCase)) { $$up = -1 }; $$start = Get-Date; do { $$left = @(Get-CimInstance Win32_Process | Where-Object { $$_.ProcessId -ne $$me -and $$_.ProcessId -ne $$up -and $$_.ProcessId -ne $$PID -and (($$_.ExecutablePath -and $$_.ExecutablePath.StartsWith($$d, [StringComparison]::OrdinalIgnoreCase)) -or ($$_.CommandLine -and $$_.CommandLine.IndexOf($$d, [StringComparison]::OrdinalIgnoreCase) -ge 0) -or ($$_.Name -eq 'chrome.exe' -and $$_.CommandLine -match '\\\.deskwisp\\')) }); if ($$left.Count -eq 0) { exit 0 }; if (((Get-Date) - $$start).TotalSeconds -ge 3) { $$left | ForEach-Object { Stop-Process -Id $$_.ProcessId -Force -ErrorAction SilentlyContinue } }; Start-Sleep -Milliseconds 500 } while (((Get-Date) - $$start).TotalSeconds -lt 25); exit 1"`
  Pop $0
  ${if} $0 == 1
    !insertmacro deskwispLog "couldn't close everything of Deskwisp's in $INSTDIR"
    MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "$(appCannotBeClosed)" /SD IDCANCEL IDRETRY closeDeskwisp
    !insertmacro deskwispLog "stopped: Deskwisp is still running"
    Quit
  ${endIf}
  !insertmacro deskwispLog "Deskwisp is closed ($0)"
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
    Push $R9
    StrCpy $R9 $R0
    !insertmacro deskwispLog "the old version's uninstaller ended with $R9: installing over it"
    Pop $R9
  ${endIf}
  ClearErrors
!macroend

!macro customUnInstallCheckCurrentUser
  !insertmacro customUnInstallCheck
!macroend

!macro customInstall
  !insertmacro deskwispLog "installed in $INSTDIR"
!macroend

; An update ("Restart to update" in the app starts this installer with --updated) shows only the
; installing page: no choice of who it's for (the one already installed), no folder, and no last page
; to click: when it's done Deskwisp opens and this window closes, at the same moment. A fresh install
; from the website keeps every page, and the last one's "Run Deskwisp".
!macro customInstallMode
  ${if} ${isUpdated}
    ${if} $hasPerMachineInstallation == "1"
      StrCpy $isForceMachineInstall "1"
    ${else}
      StrCpy $isForceCurrentInstall "1"
    ${endif}
  ${endif}
!macroend

!macro customFinishPage
  Function StartApp
    ${if} ${isUpdated}
      StrCpy $1 "--updated"
    ${else}
      StrCpy $1 ""
    ${endif}
    ${StdUtils.ExecShellAsUser} $0 "$launchLink" "open" "$1"
  FunctionEnd

  Function deskwispFinishPre
    ${if} ${isUpdated}
      !insertmacro deskwispLog "opening the new version"
      Call StartApp
      Abort
    ${endif}
  FunctionEnd

  !define MUI_PAGE_CUSTOMFUNCTION_PRE deskwispFinishPre
  !define MUI_FINISHPAGE_RUN
  !define MUI_FINISHPAGE_RUN_FUNCTION "StartApp"
  !insertmacro MUI_PAGE_FINISH
!macroend

