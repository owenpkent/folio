; Folio NSIS installer hooks (wired via tauri.conf.json -> bundle.windows.nsis.installerHooks).
;
; Everything here exists to make Folio *selectable* as the Windows handler for
; `.pdf`. It deliberately does not try to *become* the handler: since Windows 8
; the current default lives in
;
;   HKCU\Software\Microsoft\Windows\CurrentVersion\Explorer\FileExts\.pdf\UserChoice
;
; whose `ProgId` value is protected by a per-user, per-extension hash that only
; Explorer can produce. An installer that writes it is (rightly) treated as
; hijacking, and Windows resets the association. So a machine with Acrobat or
; Edge already owning `.pdf` keeps it until the *user* changes it, and every
; hand-off that goes through ShellExecute -- double-click, "Open with" defaults,
; and Chrome's "open downloaded file" / "always open with system viewer" --
; follows UserChoice, not us.
;
; What we can do is make that user choice possible and obvious. Tauri's
; `bundle.fileAssociations` (see tauri.conf.json) only writes the ProgID itself
; plus the `.pdf` default value; on its own that leaves Folio missing from the
; "Open with" list and showing up in Settings under its *file-type* description
; rather than its name. The three blocks below close those gaps.
;
; Per-user install -> SHCTX resolves to HKCU (Tauri sets it from the install
; mode; this matches what its own APP_ASSOCIATE macro writes). ${MAINBINARYNAME}
; is "folio" and $INSTDIR the install root, both defined by the generated script
; that includes this file.

!define FOLIO_PROGID "PDF Document" ; must match bundle.fileAssociations[].name
!define FOLIO_DESCRIPTION "A world-class, open-source PDF viewer."

!macro NSIS_HOOK_POSTINSTALL
  ; 1. Registered application -> Folio gets its own page in Settings > Default
  ;    apps, which the in-app "Set as default PDF viewer" action deep-links to
  ;    via `ms-settings:defaultapps?registeredAppUser=Folio`.
  WriteRegStr SHCTX "Software\Folio\Capabilities" "ApplicationName" "Folio"
  WriteRegStr SHCTX "Software\Folio\Capabilities" "ApplicationDescription" "${FOLIO_DESCRIPTION}"
  WriteRegStr SHCTX "Software\Folio\Capabilities" "ApplicationIcon" "$INSTDIR\${MAINBINARYNAME}.exe,0"
  WriteRegStr SHCTX "Software\Folio\Capabilities\FileAssociations" ".pdf" "${FOLIO_PROGID}"
  WriteRegStr SHCTX "Software\RegisteredApplications" "Folio" "Software\Folio\Capabilities"

  ; 2. Advertise the ProgID against `.pdf` so Folio appears in Explorer's
  ;    "Open with" / "Choose another app" list -- the shortest route a user has
  ;    to flipping UserChoice, and the one they reach from a downloaded file.
  ;    Tauri's APP_ASSOCIATE writes the `.pdf` *default* value but never this
  ;    subkey, so without it Folio is absent from the picker entirely.
  WriteRegStr SHCTX "Software\Classes\.pdf\OpenWithProgids" "${FOLIO_PROGID}" ""

  ; 3. Name the app, not the format. The ProgID's own default value is its file
  ;    *type* description ("Portable Document Format document"), which is what
  ;    the picker and Settings would otherwise label the entry -- unrecognisable
  ;    as Folio. An Application subkey overrides that with the app's identity.
  WriteRegStr SHCTX "Software\Classes\${FOLIO_PROGID}\Application" "ApplicationName" "Folio"
  WriteRegStr SHCTX "Software\Classes\${FOLIO_PROGID}\Application" "ApplicationDescription" "${FOLIO_DESCRIPTION}"
  WriteRegStr SHCTX "Software\Classes\${FOLIO_PROGID}\Application" "ApplicationIcon" "$INSTDIR\${MAINBINARYNAME}.exe,0"
  WriteRegStr SHCTX "Software\Classes\${FOLIO_PROGID}" "FriendlyTypeName" "PDF document"

  ; 4. The other half of the picker. Explorer builds "Open with" from both the
  ;    extension's OpenWithProgids and the per-executable Applications key; the
  ;    latter is also what "Look for another app on this PC" binds to, and what
  ;    supplies the friendly name when a user browses to folio.exe by hand.
  ;    SupportedTypes keeps Folio out of the picker for non-PDF files.
  WriteRegStr SHCTX "Software\Classes\Applications\${MAINBINARYNAME}.exe" "FriendlyAppName" "Folio"
  WriteRegStr SHCTX "Software\Classes\Applications\${MAINBINARYNAME}.exe\DefaultIcon" "" "$\"$INSTDIR\${MAINBINARYNAME}.exe$\",0"
  WriteRegStr SHCTX "Software\Classes\Applications\${MAINBINARYNAME}.exe\shell\open" "FriendlyAppName" "Folio"
  WriteRegStr SHCTX "Software\Classes\Applications\${MAINBINARYNAME}.exe\shell\open\command" "" "$\"$INSTDIR\${MAINBINARYNAME}.exe$\" $\"%1$\""
  WriteRegStr SHCTX "Software\Classes\Applications\${MAINBINARYNAME}.exe\SupportedTypes" ".pdf" ""

  ; Explorer caches associations per session. Without SHCNE_ASSOCCHANGED
  ; (0x08000000) the new entries do not show up in "Open with" until the shell
  ; restarts, so a user who installs and immediately right-clicks a PDF would
  ; still not see Folio.
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, i 0, i 0)'
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  DeleteRegValue SHCTX "Software\RegisteredApplications" "Folio"
  DeleteRegKey SHCTX "Software\Folio"
  ; Only our own value: OpenWithProgids is shared, and every other value in it
  ; belongs to a different application. (`DeleteRegKey /ifempty` would not do
  ; here -- it keys off subkeys, not values, so it would take the siblings with
  ; it.) An empty leftover key is harmless. Tauri's APP_UNASSOCIATE has already
  ; restored the previous `.pdf` default value.
  DeleteRegValue SHCTX "Software\Classes\.pdf\OpenWithProgids" "${FOLIO_PROGID}"
  DeleteRegKey SHCTX "Software\Classes\${FOLIO_PROGID}\Application"
  DeleteRegKey SHCTX "Software\Classes\Applications\${MAINBINARYNAME}.exe"
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, i 0, i 0)'
!macroend
