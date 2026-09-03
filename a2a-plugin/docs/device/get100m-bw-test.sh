#!/bin/sh
export LD_LIBRARY_PATH=/system/lib64/ndk:/data/local/tmp/a2a-rcp
# Default: the 100MiB object just uploaded in the 4m-buffer PUT test.
OBJ="${1:-put100m-4mbuf-20260825-111535}"
URL="https://121.37.53.35:8001/a2a/h3/${OBJ}"
OUT="/data/local/tmp/a2a-rcp/get100m-${OBJ}.bin"
LOG="/data/local/tmp/a2a-rcp/get100m-${OBJ}.log"
BIN=/data/local/tmp/a2a-rcp/gitcode-h3client-getpump

rm -f "$OUT" "$OUT.part"
echo "START obj=${OBJ}"
echo "url=${URL}"
echo "out=${OUT}"
echo "bin=${BIN}"
"$BIN" "$URL" \
  --method GET \
  --download-file "$OUT" \
  --download-stall-timeout 30 \
  --download-timeout 0 \
  --log-level info 2>&1 | tee "$LOG"
echo "EXIT=$?"
echo "LOG=${LOG}"
ls -l "$OUT" "$OUT.part" 2>/dev/null || true
