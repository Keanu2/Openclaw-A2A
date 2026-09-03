#!/bin/sh
export LD_LIBRARY_PATH=/system/lib64/ndk:/data/local/tmp/a2a-rcp
TS=$(date +%Y%m%d-%H%M%S)
URL="https://121.37.53.35:8001/a2a/h3/put100m-4mbuf-${TS}"
LOG="/data/local/tmp/a2a-rcp/put100m-4mbuf-${TS}.log"
BIN=/data/local/tmp/a2a-rcp/gitcode-h3client-getpump
FILE=/data/local/tmp/a2a-rcp/gitcode-upload-100m.bin

echo "START ts=${TS}"
echo "url=${URL}"
echo "bin=${BIN}"
"$BIN" "$URL" \
  --method PUT \
  --upload-file "$FILE" \
  --stall-timeout 180 \
  --upload-timeout 600 \
  --log-level info 2>&1 | tee "$LOG"
echo "EXIT=$?"
echo "LOG=${LOG}"
