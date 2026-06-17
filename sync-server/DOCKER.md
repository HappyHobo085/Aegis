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

To publish on a different host port, copy `.env.example` to `.env` and set `AEGIS_SYNC_PORT`.

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

The container speaks plain HTTP on 8787; terminate TLS in front of it.

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

## Notes & limits

- **Scale:** the JSON store is rewritten in full on each change — ideal for personal/family
  use. A very large multi-user deployment would want a database backend (the code keeps the
  HTTP contract identical, so that's a drop-in future change).
- **Security:** the server stores ciphertext only, but still restrict who can reach it
  (firewall / reverse-proxy auth) as defense in depth.
- The runtime image includes `wget` (Alpine busybox) for the compose healthcheck. If you slim
  to a `scratch`/distroless image, replace the healthcheck accordingly.
