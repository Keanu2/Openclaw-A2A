#!/bin/sh
# Parallel multi-object GET bandwidth test (each object = one QUIC/H3 stream).
# Usage: sh parallel-get-bw-test.sh <N> [prefix]
export LD_LIBRARY_PATH=/system/lib64/ndk:/data/local/tmp/a2a-rcp

N="${1:-4}"
PREFIX="${2:-parallel100m}"
HOST="https://121.37.53.35:8001/a2a/h3"
BIN=/data/local/tmp/a2a-rcp/gitcode-h3client-getpump
DIR=/data/local/tmp/a2a-rcp
TS=$(date +%Y%m%d-%H%M%S)
RUN="${DIR}/parallel-get-n${N}-${TS}"
mkdir -p "$RUN"

file_size() {
  # shellcheck disable=SC2046
  set -- $(ls -l "$1" 2>/dev/null)
  echo "$5"
}

mibps_x1000() {
  # bytes, seconds -> throughput * 1000 (MiB/s milli)
  # rate = bytes / 1048576 / sec = bytes / (1048576 * sec)
  _b=$1
  _s=$2
  if [ "$_s" -le 0 ]; then _s=1; fi
  # avoid 32-bit overflow: divide stepwise
  # milli = bytes * 1000 / 1048576 / s
  echo $(( (_b / 1048576) * 1000 / _s + ((_b % 1048576) * 1000 / 1048576) / _s ))
}

fmt_x1000() {
  _v=$1
  _whole=$((_v / 1000))
  _frac=$((_v % 1000))
  printf "%d.%03d\n" "$_whole" "$_frac"
}

echo "START n=${N} prefix=${PREFIX} ts=${TS}"
echo "bin=${BIN}"
echo "run_dir=${RUN}"

START_S=$(date +%s)

i=0
while [ "$i" -lt "$N" ]; do
  OBJ="${PREFIX}-n${N}-c${i}"
  OUT="${RUN}/c${i}.bin"
  LOG="${RUN}/c${i}.log"
  (
    "$BIN" "${HOST}/${OBJ}" \
      --method GET \
      --download-file "$OUT" \
      --download-stall-timeout 120 \
      --download-timeout 0 \
      --log-level warn >"$LOG" 2>&1
    echo $? >"${RUN}/c${i}.rc"
  ) &
  i=$((i + 1))
done

wait
END_S=$(date +%s)
DUR_S=$((END_S - START_S))
if [ "$DUR_S" -le 0 ]; then DUR_S=1; fi

TOTAL=0
OK=0
FAIL=0
i=0
while [ "$i" -lt "$N" ]; do
  OUT="${RUN}/c${i}.bin"
  RC=$(cat "${RUN}/c${i}.rc" 2>/dev/null || echo 99)
  SZ=0
  if [ -f "$OUT" ]; then
    SZ=$(file_size "$OUT")
  fi
  case "$SZ" in
    ''|*[!0-9]*) SZ=0 ;;
  esac
  TOTAL=$((TOTAL + SZ))
  RATE=$(grep 'RESULT ' "${RUN}/c${i}.log" 2>/dev/null | sed -n 's/.*rate_mib_s=\([0-9.]*\).*/\1/p' | head -1)
  [ -z "$RATE" ] && RATE=0
  echo "c${i} rc=${RC} size=${SZ} client_rate_mib_s=${RATE}"
  if [ "$RC" = "0" ] && [ "$SZ" -gt 0 ]; then
    OK=$((OK + 1))
  else
    FAIL=$((FAIL + 1))
    echo "FAIL c${i}"
    grep 'RESULT\|error\|stall' "${RUN}/c${i}.log" 2>/dev/null | tail -3
  fi
  i=$((i + 1))
done

AGG_X=$(mibps_x1000 "$TOTAL" "$DUR_S")
AGG=$(fmt_x1000 "$AGG_X")

echo "==== RESULT ===="
echo "n=${N}"
echo "ok=${OK} fail=${FAIL}"
echo "total_bytes=${TOTAL}"
echo "wall_s=${DUR_S}"
echo "agg_mibps=${AGG}"
echo "run_dir=${RUN}"
