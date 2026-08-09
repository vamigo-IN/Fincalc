# FinCalc 2.0 — Backend

Node 22 · Express 5 · TypeScript (strict) · Prisma 6 · PostgreSQL 17 · Redis 7

Design documents live in [`../docs/fincalc-2.0/`](../docs/fincalc-2.0/00-README.md). Where this code and
a document disagree, the code is what runs — open an issue and fix the document.

---

## Ports

The VPS already runs other Docker projects. **These host ports are occupied and must never be used:**

```
5432, 5433   postgres        3000, 3050, 5050   apps        6379, 5678   redis, n8n
```

Ours:

| Service | Host | Container |
|---|---|---|
| `fincalc_api` | **8087** (loopback only) | 8087 |
| `fincalc_postgres` | **5442** (dev only) | 5432 |
| `fincalc_redis` | **6389** (dev only) | 6379 |

`src/config.ts` holds the blocked list and **refuses to boot** on a collision, so a careless edit fails
with a readable message instead of taking down a neighbour's service.

In production the datastores publish nothing at all and the API binds to loopback behind the host's
existing reverse proxy.

---

## Quick start

```bash
cp .env.example .env          # then set EXCHANGERATE_API_KEY (see below)
npm install
docker compose up -d          # postgres + redis + migrate + api
curl http://127.0.0.1:8087/v1/health/ready
```

Local development against the containerised datastores:

```bash
docker compose up -d fincalc_postgres fincalc_redis
npm run dev                   # tsx watch, loads .env
```

| Command | Does |
|---|---|
| `npm run dev` | Watch-mode API |
| `npm test` | All tests |
| `npm run test:golden` | The financial golden vectors only |
| `npm run typecheck` | `tsc --noEmit` over src + tests |
| `npm run build` | Compile to `dist/` (excludes tests) |
| `npm run infra:up` / `infra:down` | Just the datastores |

---

## What exists today

| Area | Status |
|---|---|
| Config, fail-fast validation, port blocklist | ✅ |
| Structured logging with PII + money redaction | ✅ |
| Error catalogue + envelope (`{data,meta}` / `{error}`) | ✅ |
| BigInt→string money serialisation | ✅ |
| **SIP engine** — top-up, daily/weekly, lumpsum, inverse | ✅ 23 golden vectors |
| **FX rate service** — Redis cache, single-flight, cooldown | ✅ |
| Prisma schema — 44 tables, 39 enums | ✅ migrates clean |
| `uuidv7()` + `next_sync_rev()` | ✅ |
| **Auth** — register, login, refresh rotation + reuse detection, /me | ✅ verified end to end |
| **Tenancy** — Prisma extension, fail-closed on unclassified models | ✅ cross-tenant tests pass |
| **Goals** — CRUD, free-tier cap, soft delete + tombstone, projection | ✅ |
| **Rate limiting** — Redis, per bucket | ✅ |
| **Admin dashboard** — `/admin`, server-rendered | ✅ users, entitlements, rules, flags, system |
| Sync, budget, net worth, dashboard, advisor | ⛔ not started |
| Flutter integration | ⛔ not started |

The API is deliberately **narrow and deep** rather than wide and hollow: two real features that work end
to end, on foundations the rest can be built on.

---

## The currency key

`app/lib/assets/currency_service.dart:7` contains a live exchangerate-api key that ships inside every
published APK. Extracting it takes about two minutes.

**Rotate it at exchangerate-api.com and put the new key in `.env` — server-side only.** Deleting the
constant from the app does not undo the exposure: the key remains in git history and on every phone that
already has FinCalc installed. See [docs 18 §10](../docs/fincalc-2.0/18-currency-rate-service.md).

Without a key the API still starts; `/v1/reference/rates` serves from cache or Postgres and reports
`RATES_UNAVAILABLE` honestly if it has neither.

---

## Two things that will bite you

**`fincalc_migrate` is not optional.** It runs `prisma migrate deploy` once and exits — that is what
creates the 44 tables. It is not a running service and costs nothing after it exits. Without it the
database is empty and the API has nothing to talk to.

**`fincalc_net` is `internal: true`, so Docker silently ignores `ports:` on anything attached only to
it.** That is why `docker-compose.override.yml` also puts Postgres and Redis on `fincalc_edge` for
development. Production keeps them internal and publishes nothing.

Three Prisma-in-Docker traps are already handled in the `Dockerfile`, each with a comment: the CLI is a
runtime dependency (not dev), the schema engine is cached at build time, and
`PRISMA_ENGINES_CHECKSUM_IGNORE_MISSING` stops it fetching a checksum for a binary it already has.

---

## Layout

```
src/
  config.ts                    Zod-validated env; port blocklist; fails fast
  errors.ts                    The error catalogue (append-only codes)
  obs/logger.ts                pino + redaction allowlist
  db/redis.ts                  client, health, compare-and-delete lock release
  http/envelope.ts             request id, {data,meta}, error handler, BigInt JSON
  engines/
    money.ts                   BIGINT paise, micro-rates, Indian formatting
    sip.ts                     the SIP engine (docs 19)
  modules/
    reference/fx.service.ts    cache-aside + single-flight + cooldown (docs 18)
    reference/fx.routes.ts     GET /v1/reference/rates
    calculators/sip.routes.ts  POST /v1/calculators/sip/compute
  server.ts                    wiring, health, graceful shutdown
prisma/
  schema.prisma                44 models, 39 enums
  migrations/
    0000_bootstrap             extensions + uuidv7()
    0001_init                  tables
    0002_sync_rev_allocator    next_sync_rev() — must follow the tables
test/golden/sip.test.ts        23 vectors, independently recomputed
```

---

## Endpoints

| Method | Path | Auth |
|---|---|---|
| GET | `/v1/health` · `/v1/health/ready` | public |
| POST | `/v1/auth/register` · `login` · `refresh` · `logout` · `logout-all` | public / user |
| GET | `/v1/me` | user |
| GET·POST | `/v1/goals` | user |
| GET·PATCH·DELETE | `/v1/goals/:id` | user |
| GET | `/v1/goals/:id/projection` | user |
| GET | `/v1/reference/rates?base=INR&symbols=USD,EUR` | guest |
| POST | `/v1/calculators/sip/compute` | guest |
| GET | `/admin` | admin session cookie |

### Admin dashboard

`http://127.0.0.1:8087/admin` — server-rendered, no build step. Sign in with an account whose email is
in `ADMIN_EMAILS`. It manages users and entitlements (grant/revoke premium), advisor rules (pause is a
live kill switch, no deploy), feature flags with rollout %, and a system page showing FX cache age,
the daily upstream call count, applied migrations and the active tax ruleset.

Every mutation writes an `audit_log` row with the admin's id.

```bash
# "How much must I invest?" — the default mode
curl -X POST http://127.0.0.1:8087/v1/calculators/sip/compute \
  -H 'content-type: application/json' \
  -d '{"targetPaise":"500000000","years":15,"expectedReturnMicro":120000}'

# With a lumpsum and a 10% annual top-up capped at ₹25,000
curl -X POST http://127.0.0.1:8087/v1/calculators/sip/compute \
  -H 'content-type: application/json' \
  -d '{"targetPaise":"500000000","lumpsumPaise":"50000000","years":15,
       "expectedReturnMicro":120000,
       "escalation":{"type":"percent","annualRateMicro":100000,"capPaise":"2500000"}}'
```

Money is a **string of integer paise** on the wire (`"500000000"` = ₹50,00,000.00); rates are integer
micro-units (`120000` = 12.000000 %). Both conventions are enforced by the field-name suffix — `…Paise`
is a string, `…Micro` is a number.
