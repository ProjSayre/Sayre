#!/usr/bin/env bash
# Fails if the egress log captured any attempt (blocked or not) to reach
# one of the given hostnames/domains. Pass the hosted-provider domains
# that a self-hosted-configured org must never contact.
set -euo pipefail

LOGFILE=/tmp/egress-attempts.log

if [[ ! -f "$LOGFILE" ]]; then
  echo "::error::No egress log found — run-network-isolated.sh must run first."
  exit 1
fi

found=0
for host in "$@"; do
  if grep -qi "$host" "$LOGFILE"; then
    echo "::error::Detected an outbound call attempt to $host from a self-hosted-configured org. This is a release-blocking violation of W3-07 / PRD §4.2."
    found=1
  fi
done

if (( found == 1 )); then
  echo "--- full egress log ---"
  cat "$LOGFILE"
  exit 1
fi

echo "Confirmed zero outbound calls to: $*"
