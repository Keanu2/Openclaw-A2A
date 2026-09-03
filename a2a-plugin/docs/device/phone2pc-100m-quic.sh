#!/bin/sh
# Phone -> server PUT 100MiB (QUIC/H3)
export LD_LIBRARY_PATH=/system/lib64/ndk:/data/local/tmp/a2a-rcp
ID="${1:-p2pc-100m-$(date +%Y%m%d-%H%M%S)}"
URL="https://121.37.53.35:8001/a2a/h3/${ID}"
FILE=/data/local/tmp/a2a-rcp/gitcode-upload-100m.bin
LOG="/data/local/tmp/a2a-rcp/${ID}-put.log"
BIN=/data/local/tmp/a2a-rcp/gitcode-h3client-getpump

echo "ID=${ID}"
echo "URL=${URL}"
echo "FILE=${FILE}"
"$BIN" "$URL" \
  --method PUT \
  --upload-file "$FILE" \
  --stall-timeout 180 \
  --upload-timeout 900 \
  --log-level info 2>&1 | tee "$LOG"
echo "PUT_EXIT=$?"
echo "LOG=${LOG}"
