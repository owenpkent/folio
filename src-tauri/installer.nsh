; Folio NSIS installer hooks (wired via tauri.conf.json -> bundle.windows.nsis.installerHooks).
;
; Registers Folio as a "registered application" with a Capabilities key that
; advertises its .pdf file association. This does two things:
;   1. Folio shows up under Settings > Default apps as a selectable app.
;   2. The in-app "Set as default PDF viewer" action can deep-link straight to
;      Folio's page there via `ms-settings:defaultapps?registeredAppUser=Folio`,
;      so the user doesn't have to type ".pdf" to find the association.
;
; Per-user install -> HKCU. The .pdf ProgID ("PDF Document") is the one Tauri's
; fileAssociations registers; its shell\open\command already points at folio.exe.

!macro NSIS_HOOK_POSTINSTALL
  WriteRegStr HKCU "Software\Folio\Capabilities" "ApplicationName" "Folio"
  WriteRegStr HKCU "Software\Folio\Capabilities" "ApplicationDescription" "A world-class, open-source PDF viewer."
  WriteRegStr HKCU "Software\Folio\Capabilities\FileAssociations" ".pdf" "PDF Document"
  WriteRegStr HKCU "Software\RegisteredApplications" "Folio" "Software\Folio\Capabilities"
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  DeleteRegValue HKCU "Software\RegisteredApplications" "Folio"
  DeleteRegKey HKCU "Software\Folio"
!macroend
