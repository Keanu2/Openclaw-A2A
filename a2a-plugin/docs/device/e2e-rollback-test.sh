#!/bin/sh
set -e
export HOME=/data/local
export OPENCLAW_HOME=/data/local
export OPENCLAW_STATE_DIR=/data/local/.openclaw
export OPENCLAW_CONFIG_PATH=/data/local/.openclaw/openclaw.json
export PATH=/usr/local/npm/bin:/usr/local/bin:/data/local/npm/bin:/data/local/tools/node-v24.2.0-openharmony-arm64/bin:/bin:/system/bin:$PATH

TOKEN=$(node -e "const c=require('/data/local/.openclaw/openclaw.json'); process.stdout.write(c.gateway.auth.token)")
PEER=${1:-HW-Phone1}
MSG=${2:-rollback-ping}

echo "=== a2a.registry.list ==="
openclaw gateway call a2a.registry.list --token "$TOKEN" --timeout 60000 --json | head -c 2000
echo
echo
echo "=== a2a.send text ==="
openclaw gateway call a2a.send --token "$TOKEN" --timeout 180000 --params "{\"peer\":\"$PEER\",\"message\":{\"text\":\"$MSG\"}}"
echo
echo
FIXDIR=/data/local/.openclaw/workspace/a2a-fixtures
mkdir -p "$FIXDIR"
FIX="$FIXDIR/rollback-base64-test.txt"
printf 'rollback-base64-test %s\n' "$(date -Iseconds 2>/dev/null || date)" > "$FIX"
echo "=== a2a.send_local_file ==="
openclaw gateway call a2a.send_local_file --token "$TOKEN" --timeout 300000 --params "{\"peer\":\"$PEER\",\"path\":\"$FIX\"}"
echo
echo
echo "=== a2a.send_file TCP should fail ==="
openclaw gateway call a2a.send_file --token "$TOKEN" --timeout 60000 --params "{\"peer\":\"$PEER\",\"path\":\"$FIX\"}" || true
