#!/bin/sh
# OpenClaw launcher with permanent env (HarmonyOS)
export HOME=/data/local
export OPENCLAW_HOME=/data/local
export OPENCLAW_STATE_DIR=/data/local/.openclaw
export OPENCLAW_CONFIG_PATH=/data/local/.openclaw/openclaw.json
export PATH=/usr/local/bin:/data/local/npm/bin:$PATH
exec /usr/local/bin/node /usr/local/npm/lib/node_modules/openclaw/openclaw.mjs "$@"