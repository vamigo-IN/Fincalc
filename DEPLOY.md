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

## Putting it behind a domain

The API binds to `127.0.0.1:8087` and speaks plain HTTP. Terminate TLS at the host's existing reverse
proxy:

```nginx
location / {
    proxy_pass http://127.0.0.1:8087;
    proxy_set_header Host              $host;
    proxy_set_header X-Real-IP         $remote_addr;
    proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
}
```

`X-Forwarded-For` matters: rate limiting and the audit log record an IP **prefix**, and without the
header every request looks like it came from the proxy — which turns per-IP limits into one shared
bucket for the whole internet.

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
| Exits at boot naming a variable | That variable is missing from `.env`. The message says which. |
| Exits complaining about a port | A blocked port is set in `.env`. Pick another. |
| `/health/ready` reports postgres down | `fincalc_migrate` may not have run; check `docker compose ps`. |
| Admin login fails for an allowlisted email | The account does not exist. Run `reset-admin.ts`. |
| `RATES_UNAVAILABLE` | No `EXCHANGERATE_API_KEY`, or upstream is down and the cache is cold. The API says so rather than serving a made-up rate. |
| Every request rate-limited together | The proxy is not sending `X-Forwarded-For`. |
