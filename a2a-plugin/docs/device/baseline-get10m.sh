#!/bin/sh
export LD_LIBRARY_PATH=/system/lib64/ndk:/data/local/tmp/a2a-rcp
BIN=/data/local/tmp/a2a-rcp/gitcode-h3client-getpump
OUT=/data/local/tmp/a2a-rcp/baseline-10m.bin
rm -f "$OUT" "$OUT.part"
"$BIN" "https://121.37.53.35:8001/a2a/h3/get-sweep-src-10m" \
  --method GET \
  --download-file "$OUT" \
  --download-stall-timeout 60 \
  --download-timeout 0 \
  --log-level warn 2>&1 | grep RESULT
ls -l "$OUT" 2>/dev/null
