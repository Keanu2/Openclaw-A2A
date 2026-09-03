#!/bin/sh
# Copy base64-era TOOLS.md templates to device workspace (HarmonyOS).
# Usage on device:
#   sh copy-tools-template.sh pc
#   sh copy-tools-template.sh phone
#
# Templates live next to this script under workspace-snapshots/.

set -e
ROLE="${1:-}"
SNAPSHOT_DIR="$(dirname "$0")/workspace-snapshots"
TARGET="/data/local/.openclaw/workspace/TOOLS.md"

case "$ROLE" in
  pc|PC|HW-PC1)
    SRC="$SNAPSHOT_DIR/TOOLS-HW-PC1.md"
    ;;
  phone|Phone|HW-Phone1)
    SRC="$SNAPSHOT_DIR/TOOLS-HW-Phone1.md"
    ;;
  *)
    echo "Usage: $0 pc|phone" >&2
    exit 1
    ;;
esac

if [ ! -f "$SRC" ]; then
  echo "Missing template: $SRC" >&2
  exit 1
fi

mkdir -p "$(dirname "$TARGET")"
cp "$SRC" "$TARGET"
echo "Installed $SRC -> $TARGET"
echo "Restart gateway if running."
