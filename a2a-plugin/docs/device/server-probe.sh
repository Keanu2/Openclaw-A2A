# Server rollback probe + actions for edge@121.37.53.35
# Keep WS tunnel on TCP 8001; stop h3/artifact/stream-proxy file paths.

echo "=== listeners 8000/8001 ==="
ss -ltnp 2>/dev/null | grep -E ':8000|:8001' || netstat -ltnp 2>/dev/null | grep -E ':8000|:8001' || true
ss -lunp 2>/dev/null | grep -E ':8001' || true

echo "=== systemd units ==="
systemctl list-units --type=service --all 2>/dev/null | grep -iE 'agent|registry|tunnel|h3|nginx|stream|artifact' || true

echo "=== env files ==="
ls -la /etc/agent-registry/ 2>/dev/null || true
for f in /etc/agent-registry/*.env; do
  [ -f "$f" ] || continue
  echo "-- $f --"
  grep -E '^[A-Z0-9_]+=|^#' "$f" | sed -E 's/(TOKEN|KEY|PASSWORD|SECRET)=.*/\1=<redacted>/'
done

echo "=== h3 dir ==="
ls -la /opt/agent-registry/deploy/h3-nginx 2>/dev/null || ls -la ~/agent-registry-relay/deploy/h3-nginx 2>/dev/null || ls -la /home/edge/*/deploy/h3-nginx 2>/dev/null || echo "no h3-nginx dir found"
