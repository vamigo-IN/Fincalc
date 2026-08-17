# Deploying the FinCalc API

Target: an existing VPS already running other Docker projects. Everything below assumes that — the
port choices, the loopback binding and the internal network exist because this stack is a guest on a
machine it does not own.

---

## Before the first deploy

### 1. Ports

These are **already in use** on the VPS and must never be claimed:

```
5432, 5433   postgres        3000, 3050, 5050   apps        6379, 5678   redis, n8n
```

This stack uses **8087** (API, loopback only), **5442** (postgres) and **6389** (redis).
`src/config.ts` holds the blocked list and refuses to boot on a collision, so a careless edit fails
with a readable message instead of taking down a neighbour's service.

In production the datastores publish **nothing**; only the API binds, and only to `127.0.0.1`.

### 2. Generate the secrets

Three are mandatory. The API **exits at boot** without them when `NODE_ENV=production` — deliberately,
so a misconfigured deploy never starts and then breaks at the first login.

```bash
openssl rand -base64 48   # PASSWORD_PEPPER
openssl rand -base64 48   # AUDIT_PEPPER
```

`PASSWORD_PEPPER` is mixed into every password hash. **Rotating it invalidates every existing
password.** Treat it as permanent and back it up somewhere you would back up a database.

The JWT signing key is a JSON **object** mapping kid → base64 of a PKCS8 PEM:

```bash
echo "JWT_SIGNING_KEYS={\"k1\":\"$(openssl genpkey -algorithm ed25519 | base64 -w0)\"}"
```

Paste that whole line into `.env` and leave `JWT_CURRENT_KID=k1`.

> **This section previously described a JWK array** (`[{"kid":"k1","kty":"OKP",…}]`). That is the
> wrong shape — it parses as JSON and then fails inside the key import, so the API bound its port,
> logged `listening`, and died. `restart: unless-stopped` then repeated that once a minute. The value
> is validated at startup now, so a wrong shape is a readable boot error instead.

**Rotation** — add the new key alongside the old so tokens signed with the old one still verify:

```bash
npm run keygen -- --add k2      # prints both keys plus the new JWT_CURRENT_KID
```

Drop the retired kid only after every token signed with it has expired (`REFRESH_TOKEN_TTL_S`,
30 days by default). Removing it earlier signs every user out at once.

### 3. Write `.env`

```bash
cp .env.example .env
```

Fill in the three secrets above, `POSTGRES_PASSWORD`, `EXCHANGERATE_API_KEY`, and set
`NODE_ENV=production`. Every variable the app reads is in the template — if something is missing at
boot, the error names it.

`.env` is gitignored **by this repository's own `.gitignore`**. Do not remove that rule: it is the only
thing standing between a `git add .` on the VPS and your signing keys being published.

---

## Deploying

```bash
git clone https://github.com/vamigo-IN/Fincalc.git fincalc-api
cd fincalc-api
cp .env.example .env && $EDITOR .env      # see above
docker compose up -d --build
curl http://127.0.0.1:8087/v1/health/ready
```

`docker compose up` starts four things:

| Container | Role |
|---|---|
| `fincalc_postgres` | PostgreSQL 17 |
| `fincalc_redis` | Redis 7 — FX cache, rate limits, admin sessions |
| `fincalc_migrate` | Runs `prisma migrate deploy` **once**, then exits |
| `fincalc_api` | The API |

**`fincalc_migrate` is not optional and is not a failure when it exits.** It creates the tables and
stops; a stopped `fincalc_migrate` in `docker ps -a` is the expected end state. Without it the database
is empty and the API has nothing to talk to.

It runs `prisma migrate deploy` followed by the seed, which inserts the 18 expense categories, the
learning categories and the feature flags. It does **not** create any account. Every statement is an
upsert on a natural key, so running it again on an existing database changes nothing.
It exists as a separate one-shot container rather than as a step inside the API so that N API replicas
can never race each other for Prisma's advisory lock.

**Plain `docker compose up -d` is the production configuration.** Development needs the flags:

```bash
docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d    # or: npm run dev:up
```

That direction is deliberate. Forgetting the flag in development gets you production settings locally,
which is harmless; the reverse would give you `NODE_ENV=development` on the VPS, with fail-fast on
missing secrets disabled.

### Updating

```bash
git pull
docker compose up -d --build
```

Migrations run automatically on the way up. They are additive and ordered; `prisma migrate deploy`
never resets and never drops.

---

## The live market feed

Six Indian indices (Nifty 50, Bank Nifty, Nifty Financial, Nifty Next 50, Sensex, BSE Bankex) and four
MCX commodities (Gold, Silver, Crude Oil, Natural Gas), streamed over Socket.IO from the StockVirtue
backend's `/fincalc` namespace.

**Prices never pass through this server.** The app connects to the feed directly. This server's only
job is to mint a short-lived signed token, because a shipped APK cannot keep a secret — anyone who
unpacks the binary reads a key compiled into it, and revoking it would mean a Play Store release for
every existing install.

```
FinCalc app ──GET /v1/market/feed──▶ this server   (mint sv1.… token, 15 min)
     └────────wss + token──────────▶ api.stockvirtue.com/fincalc
```

### Setup

**1.** On the **StockVirtue** backend, generate the pair and enable the feed:

```bash
node -e "console.log('fincalc-app:'+require('crypto').randomBytes(32).toString('base64url'))"
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
```

```bash
# stockvirtue backend/.env
FEED_ENABLED=true
FEED_API_KEYS=fincalc-app:<first line>
FEED_TOKEN_SECRET=<second line>
FEED_REQUIRE_SIGNED_TOKENS=false   # flip to true once FinCalc is minting
```

```bash
npm run build && pm2 restart stockvirtue-api
```

Two log lines confirm it:

```
[FeedGateway] Public market feed live on /fincalc — 10 instruments, 1000ms broadcast
[FeedService] Feed universe resolved: 10/10 instruments (+10 / -0)
```

**2.** On **this** server, set the same secret:

```bash
# fincalc/.env
FEED_TOKEN_SECRET=<the SAME second line>
```

```bash
docker compose up -d
curl -s https://fincalc.vamigo.in/v1/market/feed | jq
```

**3.** Once prices appear in the app, set `FEED_REQUIRE_SIGNED_TOKENS=true` on the StockVirtue backend
and restart. Raw keys stop being accepted entirely from that point.

> Keep `fincalc-app` in the feed server's `FEED_API_KEYS` even in signed-token-only mode — it checks
> the client id is known **before** it checks the signature. Its secret simply stops being usable.

### Things that will bite

| | |
|---|---|
| `FEED_CLIENT_ID` containing a `.` | The dot is the token field separator. The feed reads a different client id and refuses. Rejected at mint time here rather than becoming a mystery `unauthorized`. |
| Secrets not identical on both sides | Every connection refused. `unauthorized` says nothing about why, on purpose — it is not an oracle for guessing a key. |
| `expiresAt` in milliseconds | Would mint a token valid until the year 58000. Pinned by a test; seconds only. |
| nginx not upgrading WebSockets | Already fine if StockVirtue's own live prices work — both namespaces share `/socket.io/`. |

### Rotating or revoking

Change `FEED_TOKEN_SECRET` on both sides and restart both. Outstanding tokens die within 15 minutes
with no app release. To cut FinCalc off entirely, remove its `clientId:secret` from the feed server's
`FEED_API_KEYS`; existing sockets survive until they reconnect, so restart that process to drop them.

`FEED_ENABLED=false` there, or an unset `FEED_TOKEN_SECRET` here, disables the feature cleanly — this
endpoint then returns 503 and the app falls back to its cached FX strip rather than an empty screen.

---

## The admin account

The dashboard at `/admin` is gated by `ADMIN_EMAILS`, but that allowlist grants a **role** — it does
not create a user. An email on the list with no matching account cannot sign in, because there is
nothing to sign in as.

**Nothing in this stack creates or resets an admin password automatically.** There is no
`ADMIN_PASSWORD`, no seeded account and no `reset-admin` script. Those all existed and were removed on
purpose: each one meant that shell access to the container, or a value sitting in `.env`, was enough
to take over the account that can read every user's financial data.

### Changing your password

Sign in, go to **`/admin/account`**, and enter your current password alongside the new one. That is
the only path.

Changing it signs out **every** admin session including your own, and revokes the account's app
refresh tokens — so if someone else had access, they lose it at that moment.

### Creating the first admin on a fresh database

A deliberate one-time SQL step. It is rare, manual and shows up in the database's own audit trail,
which is the point.

**1.** Generate a bcrypt hash of your chosen password. It must be **peppered exactly as the API does
it** — HMAC-SHA256 with `PASSWORD_PEPPER`, base64, then bcrypt — or the hash will never verify:

```bash
docker compose exec fincalc_api node -e '
const c = require("crypto"), b = require("bcryptjs");
const pw = process.argv[1], pepper = process.env.PASSWORD_PEPPER;
if (!pw || pw.length < 10) { console.error("Pass a password of at least 10 characters."); process.exit(1); }
if (!pepper) { console.error("PASSWORD_PEPPER is not set in this container."); process.exit(1); }
const peppered = c.createHmac("sha256", pepper).update(pw).digest("base64");
console.log(b.hashSync(peppered, Number(process.env.BCRYPT_COST || 11)));
' 'your-chosen-password'
```

**2.** Insert the account, using the hash from step 1:

```bash
docker compose exec -T fincalc_postgres psql -U fincalc_owner -d fincalc -v ON_ERROR_STOP=1 <<'SQL'
BEGIN;
WITH new_admin AS (
  INSERT INTO users (id, email, password_hash, email_verified_at, status)
  VALUES (uuidv7(), 'admin@vamigo.in', '<PASTE THE HASH FROM STEP 1>', now(), 'active')
  RETURNING id
), profile AS (
  INSERT INTO user_profiles (id, user_id) SELECT uuidv7(), id FROM new_admin
)
-- sync_state is written too: Prisma normally creates it alongside the account,
-- and the mobile app's first sync expects the row to exist.
INSERT INTO sync_state (user_id, updated_at) SELECT id, now() FROM new_admin;
COMMIT;
SQL
```

`email_verified_at` is set because there is no inbox for this account, and an unverified admin cannot
sign in to verify itself. `-T` disables TTY allocation so the heredoc reaches `psql`.

**3.** Confirm the address is in `ADMIN_EMAILS` in `.env`, then sign in at `/admin` and change the
password from `/admin/account` so the value you typed into a shell is no longer the live one.

### If the password is lost

There is **no recovery path short of the database** — that is the deliberate cost of removing the
reset script. Repeat the two steps above with a fresh hash, using `UPDATE` instead of `INSERT`:

```sql
UPDATE users
   SET password_hash = '<NEW HASH>',
       password_changed_at = now(),
       failed_login_count = 0,
       locked_until = NULL,
       status = 'active'
 WHERE email = 'admin@vamigo.in';
```

Then clear the account's sessions so nothing survives the reset:

```bash
docker compose exec fincalc_redis redis-cli --scan --pattern 'admin:sess:*' | xargs -r docker compose exec -T fincalc_redis redis-cli DEL
```

### Locked out by failed attempts

Five failures locks the account for an escalating period, capped at 15 minutes — just wait, or clear
it directly:

```sql
UPDATE users SET failed_login_count = 0, locked_until = NULL WHERE email = 'admin@vamigo.in';
```

Resetting bumps `passwordChangedAt` and revokes refresh tokens, so existing sessions die — a reset that
left old sessions alive would not actually lock anyone out.

---

## Putting it on `fincalc.vamigo.in`

The API binds to `127.0.0.1:8087` and speaks plain HTTP. It never terminates TLS itself — that is the
host's reverse proxy's job, and it already has one.

### 1. DNS

An **A record** for `fincalc` on `vamigo.in`, pointing at the VPS's public IPv4. Add an **AAAA** too
if the box has IPv6, or clients on v6-only networks will fail in ways that look like an app bug.

Wait for it to resolve before asking for a certificate — Let's Encrypt validates over HTTP and will
fail against a stale record:

```bash
dig +short fincalc.vamigo.in
```

### 2. nginx

A ready-to-use file is in this repo at
[`deploy/nginx/fincalc.vamigo.in.conf`](deploy/nginx/fincalc.vamigo.in.conf):

```bash
sudo cp deploy/nginx/fincalc.vamigo.in.conf /etc/nginx/sites-available/fincalc
sudo ln -s /etc/nginx/sites-available/fincalc /etc/nginx/sites-enabled/fincalc
sudo nginx -t && sudo systemctl reload nginx
```

It is **HTTP-only on purpose** — certbot answers a challenge on port 80 before a certificate exists,
then rewrites the file to add TLS. A TLS block referencing a certificate that is not there yet makes
`nginx -t` fail and blocks issuance.

It is also a **separate site file**, not an addition to an existing one, so a certbot rewrite for this
name can never touch the block serving another site on the same box.

The full block, for reference:

```nginx
server {
    listen 80;
    listen [::]:80;
    server_name fincalc.vamigo.in;

    # certbot writes its challenge here; everything else goes to HTTPS.
    location /.well-known/acme-challenge/ { root /var/www/certbot; }
    location / { return 301 https://$host$request_uri; }
}

server {
    listen 443 ssl;
    listen [::]:443 ssl;
    http2 on;
    server_name fincalc.vamigo.in;

    ssl_certificate     /etc/letsencrypt/live/fincalc.vamigo.in/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/fincalc.vamigo.in/privkey.pem;
    include /etc/letsencrypt/options-ssl-nginx.conf;
    ssl_dhparam /etc/letsencrypt/ssl-dhparams.pem;

    # The API sets its own security headers via helmet. Do not duplicate them
    # here — two sources for one header is how they end up contradicting.

    # Report bodies and sync batches are the largest things sent; 256kb matches
    # BODY_LIMIT so a rejection comes from the API with a readable error rather
    # than from nginx with a bare 413.
    client_max_body_size 256k;

    location / {
        proxy_pass http://127.0.0.1:8087;
        proxy_http_version 1.1;

        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        # $remote_addr, not $proxy_add_x_forwarded_for — the latter APPENDS to
        # whatever the client sent, leaving everything before the last entry
        # under their control. See the note in deploy/nginx/.
        proxy_set_header X-Forwarded-For   $remote_addr;
        proxy_set_header X-Forwarded-Proto $scheme;

        # Longer than the API's own 15s REQUEST_TIMEOUT_MS, so the API decides
        # when a request has taken too long and can say why.
        proxy_read_timeout 30s;
    }
}
```

`X-Forwarded-For` is not optional, and **which form you use matters**.

Without the header at all, every request looks like it came from the proxy — per-IP rate limits become
one shared bucket for the entire internet and the audit log records nothing useful.

With `$proxy_add_x_forwarded_for`, nginx appends to whatever the client sent, so the client controls
every entry but the last. The API runs with `trust proxy = 1` and reads the rightmost entry, so it
would still resolve correctly today — but that safety depends on the trust setting and the header form
agreeing, and one of them changing later silently turns a client-written header into an identity the
server believes.

`$remote_addr` is the real TCP peer. Nothing forged can enter the header, so there is nothing to
reason about.

> **If another site on this host uses `$proxy_add_x_forwarded_for` and its application reads the
> FIRST entry, that application's per-IP limits are bypassable** — a fresh `X-Forwarded-For` per
> request defeats them, including on a login endpoint. Worth checking separately; it is not something
> this repository can fix.

### 3. Certificate

```bash
sudo certbot --nginx -d fincalc.vamigo.in
```

Certbot installs a renewal timer. Confirm it works now rather than discovering it in 90 days:

```bash
sudo certbot renew --dry-run
```

### 4. Check it end to end

```bash
curl -s https://fincalc.vamigo.in/v1/health/ready
```

Then confirm the app's own path works, since that is what actually matters:

```bash
curl -s -X POST https://fincalc.vamigo.in/v1/calculators/sip/compute \
  -H 'content-type: application/json' \
  -d '{"targetPaise":"500000000","years":15,"expectedReturnMicro":120000}'
```

The admin dashboard is then at `https://fincalc.vamigo.in/admin`.

---

## Checking it works

```bash
curl -s http://127.0.0.1:8087/v1/health/ready
```

`ready` reports Postgres and Redis separately. The API deliberately starts in a **degraded** state
rather than crash-looping when a datastore is down: calculators are pure functions and keep working, so
a Redis outage should not take the whole thing offline.

```bash
docker compose logs -f fincalc_api      # structured JSON; PII and money are redacted
docker compose ps                       # fincalc_migrate exited 0 is correct
```

---

## Sizing it for the host

Defaults suit **1 vCPU and about 2GB**, shared with whatever else the machine
already runs. Check what you have:

```bash
nproc                  # cores
free -m                # memory
docker stats --no-stream
```

**No `*_CPUS` value may exceed the core count.** Docker refuses to create the
container and the stack does not start:

```
Error response from daemon: range of CPUs is from 0.01 to 1.00,
as there are only 1 CPUs available
```

The limits are ceilings, not reservations, so they may sum to more than the host
has — each says "no more than this", not "set this aside". The memory ceilings
do add up in practice though, and their total should leave room for the OS, the
reverse proxy and any neighbouring stacks.

| | Default (1 vCPU) | 4 vCPU / 8GB |
|---|---|---|
| `API_CPUS` / `API_MEMORY` | 0.9 / 384M | 2 / 512M |
| `PG_CPUS` / `PG_MEMORY` | 0.7 / 640M | 2 / 1536M |
| `REDIS_CPUS` / `REDIS_MEMORY` | 0.3 / 160M | 0.5 / 256M |
| `PG_SHARED_BUFFERS` | 160MB | 384MB |
| `PG_EFFECTIVE_CACHE` | 384MB | 1GB |
| `PG_MAX_CONNECTIONS` | 50 | 100 |

Set them in `.env` and `docker compose up -d` again. Nothing needs rebuilding —
these are runtime limits, not baked into the image.

A single core is enough for this workload: the app is offline-first, so the
device holds a full local replica and the server sees sync batches rather than
every read. What a small box will feel first is **bcrypt on login** — if sign-in
gets slow under load, lower `BCRYPT_COST` to 10 before adding hardware.

---

## Backups

The data worth protecting is Postgres. Redis holds only cache, rate-limit counters and admin sessions —
losing it signs admins out and costs one upstream FX call.

```bash
docker compose exec -T fincalc_postgres \
  pg_dump -U fincalc_owner fincalc | gzip > "fincalc-$(date +%F).sql.gz"
```

Schedule this away from the nightly batch window so the two do not contend for the same disk.

**Back up `.env` separately and encrypted.** Losing `PASSWORD_PEPPER` means no existing password can
ever be verified again — a database backup without it is unusable for logging anyone in.

---

## If something is wrong

| Symptom | Cause |
|---|---|
| `range of CPUs is from 0.01 to 1.00, as there are only 1 CPUs available` | A `*_CPUS` value exceeds the host's core count. Check `nproc` and lower it in `.env`. See below. |
| `service "fincalc_migrate" didn't complete successfully: exit 1` | Read `docker compose logs fincalc_migrate`. Almost always a missing variable: the seed imports `config.ts`, which validates the **whole** environment and exits naming what it wants. |
| `fincalc_redis failed to start` alongside a migrate failure | Compose reports the dependency, not the cause. The migrate container is the one to read logs from. |
| Exits at boot naming a variable | That variable is missing from `.env`. The message says which. |
| Exits complaining about a port | A blocked port is set in `.env`. Pick another. |
| `/health/ready` reports postgres down | `fincalc_migrate` may not have run; check `docker compose ps`. |
| Admin login fails for an allowlisted email | The account does not exist. See "Creating the first admin". |
| Admin login says "Those details did not work" for a correct password | Five failures locks the account for up to 15 minutes. Wait, or clear `locked_until`. |
| Admin login says "Too many attempts" | Per-IP ceiling: 10 attempts per 15 minutes. |
| Admin POST returns "CSRF check failed" | The page was loaded before a sign-out/sign-in. Reload and retry. |
| Admin redirected to login on every request | Redis is down — sessions fail closed. Check `docker compose ps fincalc_redis`. |
| `/v1/market/feed` returns 503 | `FEED_TOKEN_SECRET` is unset here. The log line is `feed.not_configured`. |
| Feed connects then immediately closes with `unauthorized` | Secret mismatch, or `fincalc-app` missing from the feed server's `FEED_API_KEYS`. |
| `RATES_UNAVAILABLE` | No `EXCHANGERATE_API_KEY`, or upstream is down and the cache is cold. The API says so rather than serving a made-up rate. |
| Every request rate-limited together | The proxy is not sending `X-Forwarded-For`. |
