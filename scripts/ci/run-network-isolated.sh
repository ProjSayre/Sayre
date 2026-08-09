#!/usr/bin/env bash
# Runs the given command with outbound traffic blocked except to
# localhost/loopback, recording any blocked-connection attempts to
# /tmp/egress-attempts.log. Used to prove W3-07 / PRD §4.2: when an org is
# configured for a self-hosted model provider, the adapter must make zero
# outbound calls to any third-party endpoint.
set -euo pipefail

if [[ "${1:-}" != "--" ]]; then
  echo "Usage: run-network-isolated.sh -- <command...>"
  exit 2
fi
shift

LOGFILE=/tmp/egress-attempts.log
: > "$LOGFILE"

echo "Locking egress to loopback only (allow-listing localhost for the fake self-hosted endpoint)..."

sudo iptables -N EGRESS_AUDIT 2>/dev/null || true
sudo iptables -F EGRESS_AUDIT
sudo iptables -A EGRESS_AUDIT -d 127.0.0.0/8 -j RETURN
sudo iptables -A EGRESS_AUDIT -j LOG --log-prefix "BLOCKED-EGRESS: " --log-level 4
sudo iptables -A EGRESS_AUDIT -j REJECT
sudo iptables -I OUTPUT -j EGRESS_AUDIT

# Tail the kernel log for our marker in the background so REJECTed
# attempts get captured even though the process itself just sees a
# connection error.
( sudo dmesg -w | grep --line-buffered "BLOCKED-EGRESS:" >> "$LOGFILE" & echo $! > /tmp/dmesg-tail.pid )

set +e
"$@"
status=$?
set -e

kill "$(cat /tmp/dmesg-tail.pid)" 2>/dev/null || true
sudo iptables -D OUTPUT -j EGRESS_AUDIT
sudo iptables -F EGRESS_AUDIT

exit "$status"
