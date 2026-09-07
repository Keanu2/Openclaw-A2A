#!/bin/sh
# Install Openclaw-A2A into the OpenClaw *bundled* extension slot on HarmonyOS-style devices.
# Keeps only bundled live; renames other a2a-gateway copies to *.disabled.
#
# Usage (on device):
#   TGZ=/data/local/tmp/openclaw-a2a.tgz /bin/sh /data/local/tmp/install-harmony-bundled.sh
#
set -e

TGZ="${TGZ:-/data/local/tmp/openclaw-a2a.tgz}"
BUNDLED="${BUNDLED:-/data/local/npm/lib/node_modules/openclaw/extensions/a2a-gateway}"
EXT="/data/local/.openclaw/extensions/a2a-gateway"
WS="/data/local/.openclaw/workspace/plugins/a2a-gateway"
TOOLS="/data/local/tools/openclaw-a2a-gateway-tunnel"
CONF="${OPENCLAW_CONFIG_PATH:-/data/local/.openclaw/openclaw.json}"
STAGE="/data/local/tmp/a2a-gateway-install-stage"
NODE_BIN="${NODE_BIN:-}"
NPM_BIN="${NPM_BIN:-}"

if [ -z "$NODE_BIN" ]; then
  for c in \
    /data/local/tools/node-v24.2.0-openharmony-arm64/bin/node \
    /data/local/npm/bin/node \
    node
  do
    if command -v "$c" >/dev/null 2>&1 || [ -x "$c" ]; then
      NODE_BIN="$c"
      break
    fi
  done
fi

if [ -z "$NPM_BIN" ]; then
  for c in /data/local/npm/bin/npm npm; do
    if command -v "$c" >/dev/null 2>&1 || [ -x "$c" ]; then
      NPM_BIN="$c"
      break
    fi
  done
fi

echo "TGZ=$TGZ"
echo "BUNDLED=$BUNDLED"
echo "NODE_BIN=$NODE_BIN"
echo "NPM_BIN=$NPM_BIN"

if [ ! -f "$TGZ" ]; then
  echo "FATAL: tarball not found: $TGZ"
  exit 1
fi

if [ ! -d "$(dirname "$BUNDLED")" ]; then
  echo "FATAL: openclaw extensions parent missing: $(dirname "$BUNDLED")"
  exit 1
fi

rm -rf "$STAGE"
mkdir -p "$STAGE"
# npm pack layout: package/*
tar -tzf "$TGZ" >/dev/null
tar -xzf "$TGZ" -C "$STAGE"
PKG_JSON="$(find "$STAGE" -maxdepth 2 -type f -name package.json 2>/dev/null | head -n 1)"
PKG_DIR="$(dirname "$PKG_JSON")"
if [ -z "$PKG_JSON" ] || [ ! -f "$PKG_DIR/index.ts" ]; then
  echo "FATAL: cannot find package root with index.ts under $STAGE"
  exit 1
fi
echo "PKG_DIR=$PKG_DIR"

mkdir -p "$BUNDLED"
# Sync package files into bundled (do not wipe unrelated local state blindly)
cp -f "$PKG_DIR/index.ts" "$BUNDLED/index.ts"
cp -f "$PKG_DIR/package.json" "$BUNDLED/package.json"
cp -f "$PKG_DIR/openclaw.plugin.json" "$BUNDLED/openclaw.plugin.json"
[ -f "$PKG_DIR/LICENSE" ] && cp -f "$PKG_DIR/LICENSE" "$BUNDLED/LICENSE"
[ -f "$PKG_DIR/INSTALL.md" ] && cp -f "$PKG_DIR/INSTALL.md" "$BUNDLED/INSTALL.md"
[ -f "$PKG_DIR/README.md" ] && cp -f "$PKG_DIR/README.md" "$BUNDLED/README.md"

# src + skill trees
rm -rf "$BUNDLED/src" "$BUNDLED/skill"
cp -R "$PKG_DIR/src" "$BUNDLED/src"
[ -d "$PKG_DIR/skill" ] && cp -R "$PKG_DIR/skill" "$BUNDLED/skill"

disable_dir() {
  src="$1"
  if [ -d "$src" ]; then
    if [ -d "${src}.disabled" ]; then
      rm -rf "${src}.disabled"
    fi
    mv "$src" "${src}.disabled"
    echo "disabled $src -> ${src}.disabled"
  else
    echo "skip missing $src"
  fi
}

disable_dir "$EXT"
disable_dir "$WS"
disable_dir "$TOOLS"

if [ -n "$NPM_BIN" ] && [ -x "$NPM_BIN" ] || command -v "$NPM_BIN" >/dev/null 2>&1; then
  echo "npm install --omit=dev in $BUNDLED"
  (cd "$BUNDLED" && "$NPM_BIN" install --omit=dev --no-fund --no-audit) || echo "WARN: npm install failed; continuing if node_modules already present"
else
  echo "WARN: npm not found; skipping dependency install"
fi

if [ -f "$CONF" ] && [ -n "$NODE_BIN" ]; then
  "$NODE_BIN" -e '
const fs=require("fs");
const confPath=process.argv[1];
const bundled=process.argv[2];
const c=JSON.parse(fs.readFileSync(confPath,"utf8"));
c.plugins=c.plugins||{};
c.plugins.load=c.plugins.load||{};
c.plugins.load.paths=[];
c.plugins.installs=c.plugins.installs||{};
c.plugins.installs["a2a-gateway"]={
  source:"path",
  sourcePath:bundled,
  installPath:bundled,
  version:(()=>{try{return JSON.parse(fs.readFileSync(bundled+"/package.json","utf8")).version}catch(e){return"unknown"}})(),
  installedAt:new Date().toISOString()
};
fs.writeFileSync(confPath, JSON.stringify(c,null,2)+"\n");
console.log("updated installs ->", bundled);
' "$CONF" "$BUNDLED" || echo "WARN: could not update openclaw.json installs"
else
  echo "WARN: skip openclaw.json update (missing conf or node)"
fi

rm -rf "$STAGE"
echo "INSTALL OK: live copy is $BUNDLED"
echo "Next: sh /data/local/tmp/start-openclaw.sh"
