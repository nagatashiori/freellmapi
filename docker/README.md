# Docker Guide

Docker Compose is the recommended way to run FreeLLMAPI for personal use. The container serves the Express API and the built React dashboard from one process on port 3001, with SQLite persisted in a named volume.

## Prerequisites

- Docker
- Docker Compose
- OpenSSL for generating `ENCRYPTION_KEY`

## Quick Start

Create a `.env` file with a 32-byte encryption key:

```bash
ENCRYPTION_KEY="$(openssl rand -hex 32)"
printf "ENCRYPTION_KEY=%s\nPORT=3001\n" "$ENCRYPTION_KEY" > .env
```

Start the app:

```bash
docker compose up -d
```

Open http://localhost:3001, add provider keys on the **Keys** page, then use the generated `freellmapi-...` key with any OpenAI-compatible client.

## Example API Call

```bash
curl http://localhost:3001/v1/chat/completions \
  -H "Authorization: Bearer freellmapi-your-unified-key" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "auto",
    "messages": [{"role": "user", "content": "Say hello from FreeLLMAPI."}]
  }'
```

## Operations

Check status:

```bash
docker compose ps
```

Tail logs:

```bash
docker compose logs -f freellmapi
```

Stop the app:

```bash
docker compose down
```

Update to the latest GHCR image after a release:

```bash
docker compose pull
docker compose up -d
```

Rebuild locally from source:

```bash
docker compose up -d --build
```

## Configuration

| Variable | Required | Default | Description |
| --- | --- | --- | --- |
| `ENCRYPTION_KEY` | Yes | None | 64-character hex key used to encrypt provider API keys at rest. Generate it once and keep it stable. |
| `PORT` | No | `3001` | Host port exposed by Docker Compose. The container listens on port 3001. |
| `FREEAPI_DB_PATH` | No | `/app/server/data/freellmapi.db` | SQLite file path. Set this when your host only persists one mounted directory. |
| `FREEAPI_DB_BACKUP_PATH` | No | None | Local encrypted backup file. Restored on startup if the DB file is missing, then refreshed while the app runs. |
| `FREEAPI_DB_BACKUP_URL` | No | None | HTTP(S) encrypted backup target. Startup uses `GET`; periodic backups use `PUT`. |
| `FREEAPI_DB_BACKUP_TOKEN` | No | None | Optional bearer token for `FREEAPI_DB_BACKUP_URL`. |
| `FREEAPI_DB_BACKUP_KEY` | No | `ENCRYPTION_KEY` | 64-character hex key for backup encryption. Use a separate stable key if possible. |
| `FREEAPI_CONFIG_PATH` | No | None | JSON config file applied idempotently after migrations on every boot. |
| `FREEAPI_CONFIG_JSON` | No | None | Inline JSON config. Takes precedence over `FREEAPI_CONFIG_PATH`. |
| `TRUST_PROXY_HOPS` | No | `0` | Number of reverse-proxy hops to trust for caller identity. `0` (default) ignores `X-Forwarded-For`; set `1` when nginx fronts the container (see below). |

The `freellmapi-data` volume stores SQLite data at `/app/server/data`. Keep the same volume and `ENCRYPTION_KEY` when upgrading, otherwise existing encrypted provider keys cannot be decrypted.

Example `freellmapi.config.json`:

```json
{
  "keys": [
    { "platform": "groq", "key": "gsk_...", "label": "main" }
  ],
  "customProviders": [
    {
      "baseUrl": "http://host.docker.internal:11434/v1",
      "label": "Ollama",
      "models": [
        { "model": "llama3.1:8b", "displayName": "Local Llama", "supportsTools": true }
      ]
    }
  ],
  "routing": { "strategy": "balanced" }
}
```

## Public reverse proxy (nginx)

The container is built for localhost/LAN use: by default it publishes on
`127.0.0.1` and serves plain HTTP with no CSP/HSTS (the SPA relies on inline
styles). If you put it on the internet behind nginx, the *reverse proxy* must
own the transport and security-header concerns — the application does not:

1. **Terminate TLS at nginx** and proxy to the container (keep
   `HOST_BIND=127.0.0.1` so the container itself is never reachable directly).
2. **Overwrite, never append, the client-supplied `X-Forwarded-For`.** nginx
   must set the header from the real remote address and drop whatever the
   client sent. Appending with the default `$proxy_add_x_forwarded_for` leaves
   an attacker-controlled value in the chain; `proxy_set_header
   X-Forwarded-For $remote_addr;` replaces it entirely.
3. **Set `TRUST_PROXY_HOPS=1`** in the container's `.env`. With `0` (the
   default) the app ignores `X-Forwarded-For` and would rate-limit and log
   every caller as the nginx address; with `1` it resolves the real client IP
   from the hop nginx wrote.
4. **Provide HTTPS + HSTS + security headers at nginx.** The app disables
   helmet's HSTS and CSP because it runs over plain HTTP on localhost by
   design. A public deployment must add them at the proxy layer, e.g.:

   ```nginx
   server {
     listen 443 ssl http2;
     server_name proxy.example.com;
     # ssl_certificate / ssl_certificate_key ...

     add_header Strict-Transport-Security "max-age=63072000; includeSubDomains" always;
     add_header X-Content-Type-Options nosniff always;
     add_header X-Frame-Options DENY always;

     location / {
       proxy_pass http://127.0.0.1:3001;
       proxy_set_header Host $host;
       proxy_set_header X-Real-IP $remote_addr;
       proxy_set_header X-Forwarded-For $remote_addr;   # overwrite, not append
       proxy_set_header X-Forwarded-Proto $scheme;
     }
   }
   ```

   Do not enable an application-level CSP that the built SPA does not already
   satisfy — the React bundle uses inline styles and same-origin assets.

First-run setup follows the same rule as a bare install: a browser on the host
machine can claim the dashboard without the setup code; anyone remote needs the
one-time code printed at boot. Behind nginx, "on the host machine" means the
resolved client IP (what nginx overwrote the header with) is loopback — a
forged `X-Forwarded-For: 127.0.0.1` never counts, because the header is
replaced before it reaches the app.

## Multiple API accounts

Every enabled key for a provider is an independent account in the routing pool.
Before a request starts, FreeLLMAPI skips disabled, unhealthy, cooling-down,
model-incompatible, rate-limited, or already-full accounts. It prefers a
reliable and fast account when history exists, and uses stable round-robin
rotation when there is no history yet. The selected key is held by a short
lease and released on success, failure, timeout, or client disconnect.

Optional environment limits are:

```dotenv
MAX_CONCURRENT_REQUESTS_PER_KEY=2
MAX_CONCURRENT_REQUESTS_PER_KEY_GROQ=2
PROVIDER_MINUTE_REQUEST_CAP_NVIDIA=40
PROVIDER_DAILY_REQUEST_CAP_MODELSCOPE=1800
PROVIDER_DAILY_TOKEN_CAP_NAVY=150000
```

The platform-specific value overrides the global per-key value. Set a cap to
`0` to disable that cap. API-key records can also carry `model_scope_json`:
`NULL` means all models for that provider, while a JSON array such as
`["model-a", "model-b"]` restricts that account to exact model IDs. The API
and Analytics expose only the key ID and label; the real key and encrypted
key material are never returned.

## Published Image

Images are published to GitHub Container Registry:

```bash
docker pull ghcr.io/tashfeenahmed/freellmapi:latest
```

The Docker workflow builds pull requests without pushing. After this repository receives the workflow on `main`, pushes to `main` and version tags publish images to GHCR automatically.
