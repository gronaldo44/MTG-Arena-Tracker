; Custom NSIS hooks for MTG Arena Tracker
;
; customUnInstall runs after the app files are removed. It deletes the
; user-data directory so no stale settings, card database, or match history
; are left behind after the user uninstalls.

!macro customUnInstall
  RMDir /r "$APPDATA\MTG Arena Tracker"
  RMDir /r "$LOCALAPPDATA\MTG Arena Tracker"
  ; Legacy folder name before app.setName() was added
  RMDir /r "$APPDATA\mtg-arena-auto-tracker"
  RMDir /r "$LOCALAPPDATA\mtg-arena-auto-tracker"
!macroend
