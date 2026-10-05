# Running the Aegis sync server with Docker

A durable, self-hosted deployment of the end-to-end-encrypted sync server. The container
stores **opaque ciphertext only** — it can never read your bookmarks, saved items, or
allowlist. Data is persisted to a named Docker volume, so it survives restarts and upgrades.

## Quick start

```bash
cd sync-server
docker compose up -d           # build + start in the background
curl http://localhost:8787/healthz   # -> {"ok":true}
```

That is the whole setup, and it stays on your own machine: the published port binds to
**loopback by default** (`127.0.0.1:8787`), so nothing on your LAN can reach the sync
server until you deliberately change that. This is not ceremony — the server speaks
plain HTTP and its auth is an application-level Ed25519 token, not a transport-level
one, so a broadly-published port is an unencrypted endpoint anyone on the network can
talk to.

That default also needs no boot ordering, because a loopback address always exists. If
you change `AEGIS_SYNC_BIND` to a specific address — a LAN or Tailscale address — read
[Starting it automatically](#starting-it-automatically) first, because `restart: unless-stopped`
will **not** bring it back after a reboot on its own.

To publish on a different **host port**, copy `.env.example` to `.env` and set
`AEGIS_SYNC_PORT`.

## Exposing it to another machine (read this first)

If the server has to be reachable from somewhere other than the machine it runs on,
put a **TLS reverse proxy** in front of it (see "HTTPS via a reverse proxy" below) and
bind the published port to the proxy's address — not to every interface:

```bash
# .env
AEGIS_SYNC_BIND=127.0.0.1   # the default — a local Caddy/nginx can reach it
AEGIS_SYNC_PORT=8787
```

```bash
# .env — only when the proxy is on a DIFFERENT host and the port is firewalled
AEGIS_SYNC_BIND=0.0.0.0
```

`AEGIS_SYNC_BIND=0.0.0.0` publishes 8787 to every interface the host has. Do that only
behind TLS and a firewall rule, never as a shortcut to "make it work".

## Starting it automatically

**Read this before changing `AEGIS_SYNC_BIND` to anything but loopback.**

Docker publishes the port by `bind()`-ing the address **on the host**, at the moment it
starts the container. If the address does not exist yet, the start fails with:

```
failed to set up container networking: driver failed programming external
connectivity on endpoint …: failed to bind host port 100.103.103.103:8787/tcp:
cannot assign requested address
```

`restart: unless-stopped` **cannot recover from this.** The failure happens during
endpoint setup, *before* the container's process is started, so there is no process for
Docker's restart manager to restart — the container just stays down until a human runs
`docker compose up` by hand. On the machine this was found on, the server was down for
**23 hours** after a reboot, reporting `healthy` the whole time (see the healthcheck note
below).

A Tailscale address is exactly this case: at boot the docker daemon restores containers
*before* `tailscale0` has been given its tailnet IP. Ordering `docker.service` after
`tailscaled.service` does **not** fix it — `tailscaled` is `Type=notify`, so the unit is
already `active` while the IP is still missing (measured: active 12 seconds before the
bind failed). The wait has to be on the *address*.

### The unit

```bash
cd sync-server
sudo sed "s|@SYNC_SERVER_DIR@|$PWD|g" \
  systemd/aegis-sync-server.service \
  | sudo tee /etc/systemd/system/aegis-sync-server.service >/dev/null
sudo chmod 644 /etc/systemd/system/aegis-sync-server.service   # see the note below
sudo systemctl daemon-reload
sudo systemctl enable --now aegis-sync-server.service
```

The `chmod` is not fussiness: systemd warns `marked executable` for an executable unit,
and a checkout on a **vfat** mount (which stores no permission bits, so every file reads
as `0755` however you `chmod` it) will hand you an executable unit. The copy under
`/etc` is on a normal filesystem, where the mode is real.

It is a **system** unit and must be one: a `systemctl --user` unit only starts at login
(so the server stays down on a headless boot — the case this exists to fix) and cannot
see the system `docker.service` at all. `@SYNC_SERVER_DIR@` is a placeholder because a
unit needs an absolute path and this file is tracked in git.

What it does, in order: wait for `AEGIS_SYNC_BIND` to actually exist on the host
(`systemd/wait-for-bind-address.sh`, a real poll with a 120 s cap that **fails loudly**
rather than proceeding), then `docker compose up -d --force-recreate`, then **prove the
published port actually answers**. The `--force-recreate` is load-bearing: a container
left behind by a failed restore keeps its stale, networkless endpoint, and a plain `up -d`
only *starts* that container again — still unreachable. Recreating is what re-runs
endpoint setup.

With the default loopback bind the wait returns immediately, so the unit costs nothing.

```bash
systemctl status aegis-sync-server.service
sudo journalctl -u aegis-sync-server.service -f   # the wait prints why it is waiting
```

### Two things the unit's own status does NOT tell you

Both were measured on this host, and both are the same mistake one layer up from the
loopback-only healthcheck: a green signal that does not mean the server is reachable.

- **`systemctl start` is a no-op once the unit has run.** `RemainAfterExit=yes` latches
  the unit `active (exited)`, and systemd then treats `start` on an already-active unit as
  already-done: observed returning `0` and logging **nothing at all** while the container
  was down. Use **`systemctl restart`** to re-run it.
- **`systemctl is-active` means "the last start attempt succeeded", not "the server is
  up."** It cannot mean the latter, because the unit has already exited by the time you
  look. This is why the unit has an `ExecStartPost` that connects to the published port
  and **fails the unit** if nothing answers — so a start that did not really work shows up
  as `failed`, not as a comfortable `active`.

The reachability check is still yours to run, because only you know which address your
devices use:

```bash
curl http://<AEGIS_SYNC_BIND>:8787/healthz   # -> {"ok":true}
```

### Why the healthcheck has an `ip` clause

The healthcheck is not just a liveness probe, and the extra clause is not decoration:

```yaml
test: [CMD-SHELL, ip -o -4 addr show scope global | grep -q . && wget -qO- …/healthz]
```

A container whose endpoint setup failed has only `lo`, so a bare `/healthz` probe
against loopback **passes** on a container that nothing outside can reach. That is how
this outage stayed invisible for 23 hours behind a green `docker ps`. `scope global`
excludes `lo` (which is `scope host`); note the discriminator is `grep -q .` finding a
line, not `ip`'s exit status — `ip` exits 0 either way.

So: `docker ps` showing `healthy` means the container is serving **and** has a network
interface. It is still not a reachability proof from any particular host — for that, curl
the published address:

```bash
curl http://<AEGIS_SYNC_BIND>:8787/healthz   # -> {"ok":true}
```

Note that the container's own listener is always bound to `0.0.0.0:8787`
(`AEGIS_SYNC_ADDR`) — Docker reaches the container over its bridge IP, so a loopback
listener inside the container would be unreachable. That is an internal detail and is
deliberately independent of `AEGIS_SYNC_BIND`, which is the knob that controls
exposure.

## Point Aegis at it

In Aegis: **Settings → Sync → Server URL** = `http://<host>:8787`, then **Start new sync**.
On another device, paste the same URL and **Restore from a recovery phrase**.

> Over the public internet, use HTTPS via a reverse proxy (below). On a LAN or localhost,
> plain HTTP is fine.

## Where the data lives & backups

Records + device registrations are written to `/data/aegis-sync.json` inside the container,
backed by the `aegis-sync-data` named volume. The contents are opaque ciphertext plus a small
device list, so a backup is safe to store anywhere.

```bash
# Back up the data file out of the running container:
docker compose cp sync:/data/aegis-sync.json ./aegis-sync.backup.json
```

If the data file is ever corrupted, the server **fails to start** (loud, by design) rather
than silently losing data — restore the file from a backup.

## Updating

```bash
docker compose build && docker compose up -d   # data persists in the volume
```

## HTTPS via a reverse proxy

The container speaks plain HTTP on 8787 and has no TLS listener of its own; terminate
TLS in front of it. Both examples below proxy to `127.0.0.1:8787`, which is exactly
what the default `AEGIS_SYNC_BIND=127.0.0.1` mapping provides — so no compose change is
needed when the proxy runs on the same host.

**Caddy** (automatic Let's Encrypt — needs a domain pointing at the host, ports 80/443 open):

```caddyfile
sync.example.com {
    reverse_proxy localhost:8787
}
```

**nginx** (with your own cert):

```nginx
server {
    listen 443 ssl;
    server_name sync.example.com;
    ssl_certificate     /etc/ssl/certs/sync.crt;
    ssl_certificate_key /etc/ssl/private/sync.key;
    location / {
        proxy_pass http://127.0.0.1:8787;
    }
}
```

Then use `https://sync.example.com` as the Aegis Server URL.

If you have no TLS terminator at all and must expose this over the internet, the app will
refuse an `http://` server by default — that is deliberate. You can point the client at a
plaintext server by ticking **Settings → Sync → "Allow an unencrypted HTTP sync server
(insecure)"**, which is per-device and never synced. Understand what that costs before you
do: your synced data stays end-to-end encrypted either way, but without TLS the network path
learns which server you talk to and when, and can drop, delay or replay traffic.

## Notes & limits

- **Scale:** the JSON store is rewritten in full on each change — ideal for personal/family
  use. A very large multi-user deployment would want a database backend (the code keeps the
  HTTP contract identical, so that's a drop-in future change).
- **Security:** the server stores ciphertext only, but its transport-level auth is nil
  (the Ed25519 `AegisSig` token is application-level, checked after the bytes arrive in
  the clear), so who can reach the port is a real security boundary, not a formality.
  The default loopback binding plus a TLS reverse proxy is the intended posture;
  `AEGIS_SYNC_BIND=0.0.0.0` without both is not.
- The runtime image includes `wget` (Alpine busybox) for the compose healthcheck. If you slim
  to a `scratch`/distroless image, replace the healthcheck accordingly.
