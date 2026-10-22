Unicode true
RequestExecutionLevel user
SetCompressor /SOLID lzma
ShowInstDetails show
ShowUninstDetails show

!ifndef APP_VERSION
  !error "APP_VERSION is required"
!endif
!ifndef STAGE
  !error "STAGE is required"
!endif
!ifndef OUTPUT
  !error "OUTPUT is required"
!endif
!ifndef INSTALL_DIR
  !define INSTALL_DIR "$LOCALAPPDATA\Programs\Mingle"
!endif
!ifndef EXPECTED_INSTALL_DIR
  !define EXPECTED_INSTALL_DIR "${INSTALL_DIR}"
!endif

Name "Mingle ${APP_VERSION}"
OutFile "${OUTPUT}"
InstallDir "${INSTALL_DIR}"
VIProductVersion "${APP_VERSION}.0"
VIAddVersionKey "ProductName" "Mingle"
VIAddVersionKey "FileDescription" "Mingle desktop installer"
VIAddVersionKey "ProductVersion" "${APP_VERSION}"
VIAddVersionKey "LegalCopyright" "Mingle"

Page instfiles
UninstPage un.confirm
UninstPage instfiles

Function .onInit
  StrCmp "$INSTDIR" "${EXPECTED_INSTALL_DIR}" install_dir_is_expected 0
  MessageBox MB_ICONSTOP|MB_OK "Mingle installs per-user under LocalAppData. A custom /D path is not supported."
  Abort
  install_dir_is_expected:
FunctionEnd

Section "Install Mingle"
  SetShellVarContext current
  SetOutPath "$INSTDIR"
  File /r "${STAGE}\*"

  WriteUninstaller "$INSTDIR\Uninstall.exe"
  CreateDirectory "$SMPROGRAMS\Mingle"
  CreateShortcut "$SMPROGRAMS\Mingle\Mingle.lnk" "$INSTDIR\mingle.exe" "" "$INSTDIR\mingle.exe"
  CreateShortcut "$DESKTOP\Mingle.lnk" "$INSTDIR\mingle.exe" "" "$INSTDIR\mingle.exe"

  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Mingle" "DisplayName" "Mingle"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Mingle" "DisplayVersion" "${APP_VERSION}"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Mingle" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Mingle" "DisplayIcon" "$INSTDIR\mingle.exe"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Mingle" "UninstallString" '"$INSTDIR\Uninstall.exe"'
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Mingle" "QuietUninstallString" '"$INSTDIR\Uninstall.exe" /S'
  WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Mingle" "NoModify" 1
  WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Mingle" "NoRepair" 1
SectionEnd

Function un.onInit
  SetShellVarContext current
  StrCmp "$INSTDIR" "${EXPECTED_INSTALL_DIR}" install_dir_is_expected 0
  MessageBox MB_ICONSTOP|MB_OK "Refusing to uninstall files outside the Mingle installation directory."
  Abort
  install_dir_is_expected:
FunctionEnd

Section "Uninstall"
  SetShellVarContext current
  Delete "$DESKTOP\Mingle.lnk"
  Delete "$SMPROGRAMS\Mingle\Mingle.lnk"
  RMDir "$SMPROGRAMS\Mingle"
  DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Mingle"
  RMDir /r "$INSTDIR"
SectionEnd
