!macro customInit
  ; Prefer D:\ClipNest on a fresh install. Keep a valid existing install and
  ; an explicit /D command-line path, but repair stale registry-only paths.
  ${StdUtils.GetParameter} $R0 "D" ""
  ${If} $R0 == ""
    ${If} $perUserInstallationFolder == ""
      Goto clipnest_prefer_d
    ${Else}
      IfFileExists "$perUserInstallationFolder\ClipNest.exe" clipnest_custom_init_done
      Goto clipnest_prefer_d
    ${EndIf}
  ${EndIf}

  Goto clipnest_custom_init_done

  clipnest_prefer_d:
    IfFileExists "D:\*" 0 clipnest_custom_init_done
      StrCpy $INSTDIR "D:\ClipNest"

  clipnest_custom_init_done:
!macroend
