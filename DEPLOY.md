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

The JWT signing key is an Ed25519 JWK array:

```bash
node --input-type=module -e "
import { generateKeyPair, exportJWK } from 'jose';
const { privateKey } = await generateKeyPair('EdDSA', { crv: 'Ed25519', extractable: true });
const jwk = await exportJWK(privateKey);
console.log(JSON.stringify([{ kid: 'k1', ...jwk }]));
"
```

Put the output in `JWT_SIGNING_KEYS` and leave `JWT_CURRENT_KID=k1`.

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

### Updating

```bash
git pull
docker compose up -d --build
```

Migrations run automatically on the way up. They are additive and ordered; `prisma migrate deploy`
never resets and never drops.

---

## The admin account

The dashboard at `/admin` is gated by `ADMIN_EMAILS`, but that allowlist grants a **role** — it does
not create a user. An email on the list with no matching account cannot sign in, because there is
nothing to sign in as.

```bash
# Creates or resets the admin, verifies it, and revokes existing sessions.
docker compose exec fincalc_api npx tsx scripts/reset-admin.ts
```

With `ADMIN_PASSWORD` unset it generates one and prints it **once**. In production the seed refuses to
generate: a credential that exists only in a deploy log cannot be rotated and can be read by anyone
with log access. Set `ADMIN_PASSWORD` to a value you control.

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
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # Longer than the API's own 15s REQUEST_TIMEOUT_MS, so the API decides
        # when a request has taken too long and can say why.
        proxy_read_timeout 30s;
    }
}
```

`X-Forwarded-For` is not optional. Rate limiting and the audit log record an IP **prefix**, and
without the header every request looks like it came from the proxy — which turns per-IP limits into
one shared bucket for the entire internet, and makes the audit log useless. The API already runs with
`trust proxy = 1`, which trusts exactly one hop: the proxy in front of it, and nothing further out.

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
| Exits at boot naming a variable | That variable is missing from `.env`. The message says which. |
| Exits complaining about a port | A blocked port is set in `.env`. Pick another. |
| `/health/ready` reports postgres down | `fincalc_migrate` may not have run; check `docker compose ps`. |
| Admin login fails for an allowlisted email | The account does not exist. Run `reset-admin.ts`. |
| `RATES_UNAVAILABLE` | No `EXCHANGERATE_API_KEY`, or upstream is down and the cache is cold. The API says so rather than serving a made-up rate. |
| Every request rate-limited together | The proxy is not sending `X-Forwarded-For`. |
