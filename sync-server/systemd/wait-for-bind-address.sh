#!/usr/bin/env bash
# Block until the host actually HAS the address the published port binds to.
#
# WHY THIS EXISTS. `docker-compose.yml` publishes the container's port on
# `AEGIS_SYNC_BIND`, which on a tailnet deployment is the node's Tailscale
# address (e.g. 100.103.103.103). Docker's port allocator `bind()`s that
# address on the host when it starts the container, so the address MUST already
# exist or the start fails with:
#
#   failed to set up container networking: driver failed programming external
#   connectivity on endpoint ...: failed to bind host port
#   100.103.103.103:8787/tcp: cannot assign requested address
#
# That failure happens during ENDPOINT SETUP, before the container's process is
# ever started. `restart: unless-stopped` therefore cannot recover from it: there
# is no process for the restart manager to restart, so the container stays down
# until a human runs `docker compose up` by hand. Measured on this host: after a
# reboot on 2026-10-04 the sync server stayed down for 23 hours.
#
# ORDERING ALONE IS NOT ENOUGH. A `After=tailscaled.service` dependency looks like
# it fixes this and does not: `tailscaled` is `Type=notify` and was already
# `active` TWELVE SECONDS before the bind failed, because the unit going active
# only means the daemon is up — the tailnet IP lands on `tailscale0` later, after
# the control-plane handshake. So the wait has to be on the ADDRESS, not on the
# unit, and it has to be a real condition poll rather than a `sleep`.
#
# Loopback and wildcard binds are always satisfiable, so the documented default
# (`AEGIS_SYNC_BIND` unset -> 127.0.0.1) returns immediately and never adds
# latency to a normal start. Only a specific unicast address waits.
#
# Reads the same variable compose interpolates, with the same default, so the two
# can never disagree about which address is being waited for.
#
# Usage:  wait-for-bind-address.sh            (honours the env vars below)
# Exit:   0 once the address is present, 1 on timeout.
#
# Env:
#   AEGIS_SYNC_BIND           address to wait for   (default 127.0.0.1)
#   AEGIS_SYNC_WAIT_TIMEOUT   seconds to wait       (default 120)

set -uo pipefail

ADDR="${AEGIS_SYNC_BIND:-127.0.0.1}"
TIMEOUT="${AEGIS_SYNC_WAIT_TIMEOUT:-120}"

# Always-satisfiable binds: nothing to wait for, and waiting would only add
# startup latency to the safe default. `localhost` is a name, not an address, so
# it is satisfiable by definition too.
case "$ADDR" in
  0.0.0.0 | :: | '[::]' | localhost | 127.* | ::1) exit 0 ;;
esac

# `inet <addr>/<prefix>` is how `ip addr show` renders a configured address, so
# matching on that prefix cannot be satisfied by a route, a neighbour entry, or a
# substring of a longer address (100.103.103.10 does not match 100.103.103.1).
has_addr() {
  ip -o addr show 2>/dev/null | grep -q "inet ${ADDR}/"
}

if has_addr; then
  echo "wait-for-bind-address: ${ADDR} is already present"
  exit 0
fi

echo "wait-for-bind-address: waiting up to ${TIMEOUT}s for ${ADDR} to appear on this host"
deadline=$((SECONDS + TIMEOUT))
while ((SECONDS < deadline)); do
  sleep 1
  if has_addr; then
    echo "wait-for-bind-address: ${ADDR} is present after $((SECONDS))s"
    exit 0
  fi
done

# Fail LOUDLY. A silent success here is the whole bug: the caller would go on to
# `docker compose up`, the bind would fail, and the server would be down with a
# unit that claims to have started.
echo "wait-for-bind-address: TIMEOUT after ${TIMEOUT}s — ${ADDR} never appeared on this host." >&2
echo "  If this address is a Tailscale node address, the tailnet is not up yet or" >&2
echo "  the node is logged out. Check: systemctl status tailscaled; tailscale status." >&2
exit 1
