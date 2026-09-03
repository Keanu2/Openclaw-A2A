#!/bin/sh
# Sweep http3_stream_buffer_size for fastest stable GET.
# Run on phone via: sh /data/local/tmp/a2a-rcp/get-buffer-sweep-client.sh <obj> <tag>
export LD_LIBRARY_PATH=/system/lib64/ndk:/data/local/tmp/a2a-rcp
OBJ="${1:?object name}"
TAG="${2:-run}"
URL="https://121.37.53.35:8001/a2a/h3/${OBJ}"
OUT="/data/local/tmp/a2a-rcp/get-sweep-${TAG}.bin"
LOG="/data/local/tmp/a2a-rcp/get-sweep-${TAG}.log"
BIN=/data/local/tmp/a2a-rcp/gitcode-h3client-getpump

rm -f "$OUT" "$OUT.part" "$LOG"
"$BIN" "$URL" \
  --method GET \
  --download-file "$OUT" \
  --download-stall-timeout 30 \
  --download-timeout 0 \
  --log-level info >"$LOG" 2>&1
RC=$?
# Print RESULT line for host parser
grep '^RESULT ' "$LOG" || true
echo "EXIT=${RC}"
ls -l "$OUT" "$OUT.part" 2>/dev/null || true
