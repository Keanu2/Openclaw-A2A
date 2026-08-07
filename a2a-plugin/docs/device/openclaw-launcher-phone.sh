#!/bin/sh
# OpenClaw launcher with permanent env (HarmonyOS phone)
export HOME=/data/local
export OPENCLAW_HOME=/data/local
export OPENCLAW_STATE_DIR=/data/local/.openclaw
export OPENCLAW_CONFIG_PATH=/data/local/.openclaw/openclaw.json
export PATH="/data/local/npm/bin:/data/local/tools/node-v24.2.0-openharmony-arm64/bin:/usr/local/bin:$PATH"
exec node /data/local/npm/lib/node_modules/openclaw/openclaw.mjs "$@"
