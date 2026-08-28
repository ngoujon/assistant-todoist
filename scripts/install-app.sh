#!/bin/bash
# Installe « Assistant Todoist.app » dans /Applications et l'ajoute au Dock.
set -euo pipefail
cd "$(dirname "$0")/.."

APP_NAME="Assistant Todoist"
SRC="build/${APP_NAME}-darwin-arm64/${APP_NAME}.app"

# Toujours reconstruire : reutiliser un build precedent installe silencieusement
# une version perimee de l'app.
bash scripts/build-app.sh

if [ -w /Applications ]; then
  DEST_DIR="/Applications"
else
  DEST_DIR="$HOME/Applications"
  mkdir -p "$DEST_DIR"
fi
DEST="$DEST_DIR/${APP_NAME}.app"

# On ne quitte que notre propre application.
pkill -f "${APP_NAME}.app/Contents/MacOS/${APP_NAME}" 2>/dev/null || true
sleep 1

rm -rf "$DEST"
ditto "$SRC" "$DEST"
echo "installee : $DEST"

# Le Dock met en cache les icônes : on force son rafraîchissement.
touch "$DEST"

# Ajout au Dock, sans doublon (le Dock stocke l'URL encodee : « Assistant%20Todoist.app »).
DOCK_NEEDLE="$(printf '%s' "${APP_NAME}.app" | sed 's/ /%20/g')"
if defaults read com.apple.dock persistent-apps 2>/dev/null | grep -q "$DOCK_NEEDLE"; then
  echo "deja presente dans le Dock"
else
  defaults write com.apple.dock persistent-apps -array-add \
    "<dict><key>tile-data</key><dict><key>file-data</key><dict><key>_CFURLString</key><string>${DEST}/</string><key>_CFURLStringType</key><integer>0</integer></dict></dict><key>tile-type</key><string>file-tile</string></dict>"
  killall Dock
  echo "ajoutee au Dock"
fi
