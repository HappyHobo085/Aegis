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
