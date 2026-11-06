# Clinic Booking API

A clinic booking API and a simple web page that uses it (Koya Cohort 4, Task 1).
The contract is the OpenAPI spec at https://koyaacademy.com/assessment-api/openapi.json.

Stack: Node 24, TypeScript (ESM), Fastify, Postgres on Neon, hosted on Render.

## Setup

```sh
npm install
cp .env.example .env    # then fill in DATABASE_URL and API_KEY
npm run migrate         # create or upgrade the database schema
npm run dev             # start the server on http://localhost:3000 with auto-reload
```

Check it's working:

```sh
curl -i http://localhost:3000/health
# 200 {"status":"ok","db":"ok"}
```

## Environment variables

| Name           | Required | Description                                                                 |
| -------------- | -------- | --------------------------------------------------------------------------- |
| `DATABASE_URL` | yes      | Neon pooled Postgres connection string.                                     |
| `API_KEY`      | yes      | The value clients must send in the `X-API-Key` header. Use a long random string. |
| `PORT`         | no       | Port to listen on. Defaults to 3000. Render sets it automatically.          |

The server refuses to start if `DATABASE_URL` or `API_KEY` is missing.
Never commit `.env`. It is already listed in `.gitignore`.

To generate a key:

```sh
node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"
```

## Scripts

| Script                 | What it does                                           |
| ---------------------- | ------------------------------------------------------ |
| `npm run dev`          | Run from TypeScript source with auto-reload, using `.env`. |
| `npm run build`        | Compile TypeScript to `dist/`.                         |
| `npm start`            | Run the compiled server (`dist/server.js`).            |
| `npm run typecheck`    | Type-check without writing files.                      |
| `npm run migrate`      | Apply pending migrations, using `.env` (local).        |
| `npm run migrate:prod` | Apply pending migrations from `dist/` (used on Render). |

## Database migrations

Migrations are plain SQL files in `migrations/`, applied in name order by `src/migrate.ts`.
Applied files are recorded in the `schema_migrations` table, so running it again is safe.
Each file runs in its own transaction.

To change the schema, add a new file with the next number (e.g. `004_add_something.sql`).
Never edit a migration that has already been applied.

## Deploying to Render

`render.yaml` defines one free web service:

- Build: `npm ci && npm run build`
- Start: `npm run migrate:prod && npm start` (migrations run on every start; Render's pre-deploy step is paid-only)
- Health check: `GET /health`

Set `DATABASE_URL` and `API_KEY` in the Render dashboard.

### Keep-alive

Render's free tier sleeps after about 15 minutes idle. A free external pinger
(e.g. cron-job.org or UptimeRobot) calls `GET /health` every 10 minutes to keep it awake.

## Endpoints

| Method and path          | Auth      | Status                          |
| ------------------------ | --------- | ------------------------------- |
| `GET /health`            | public    | done (Phase 0)                  |
| `POST /reset`            | X-API-Key | done (Phase 1)                  |
| `GET /slots`             | X-API-Key | done (Phase 1)                  |
| `POST /bookings`         | X-API-Key | Phases 1-4 done; 5 next         |
| `GET /bookings/{id}`     | X-API-Key | done (Phase 1)                  |
| `DELETE /bookings/{id}`  | X-API-Key | done (Phase 3)                  |
| `GET /bookings`          | X-API-Key | done (Phase 4)                  |

Every route except `/health` requires the `X-API-Key` header. A missing or wrong key returns 401.

`/health` is not part of the API contract. It is public on purpose: Render's health
check and keep-alive pingers can't send custom headers, and it reveals nothing except "ok".

Every error response is `{"error": "<message>"}`.

## Design decisions

### Concurrency (one confirmed booking per slot)

The database enforces this, not the app. A partial unique index allows only one `confirmed`
row per slot, while cancelled rows don't count:

```sql
CREATE UNIQUE INDEX one_confirmed_per_slot ON bookings(slot_id) WHERE status = 'confirmed';
```

`POST /bookings` doesn't check for an existing booking first, because two requests could both
pass that check at the same moment. It just inserts, and a violation of this index returns 409.

`DELETE /bookings/{id}` cancels with a single `UPDATE ... WHERE id = $1 AND status = 'confirmed'`,
so of two simultaneous cancels, one gets 200 and the other 409. Cancelling frees the slot, and
rebooking it creates a new booking with a new id. The cancelled booking stays readable by its id.

### Idempotency

`POST /bookings` accepts an optional `Idempotency-Key` header. An empty header counts as no key.

The key is inserted into `idempotency_keys` in the same transaction as the booking. If another
request holds the same key, Postgres makes this one wait until that transaction finishes, so two
simultaneous requests can't both create a booking. The waiting request then reads the stored result:

- Same body: it replays the stored status and body, including the booking `id`.
- Different body: it returns 422.

Bodies are compared by the SHA-256 of their canonical JSON (object keys sorted at every depth), so
key order doesn't matter. The comparison uses the body as sent, before trimming, so `"Ada"` and
`" Ada "` count as different bodies.

Every 201 and 4xx from the booking rules is stored, so a 409 or a 400 replays as well, even if the
slot has since been freed. These are not stored:

- 401, because it is answered before the route runs.
- 500, because the transaction rolls back and removes the key, so the client can retry.
- Malformed JSON, because there is no parsed body to hash.

A unique violation aborts a Postgres transaction, so the booking attempt runs inside a savepoint.
Rolling back to it keeps the claimed key, so the 409 can still be stored.

`POST /reset` clears the stored keys, so repeated runs don't get stale replays or 422s.

### Pagination

`GET /bookings` orders by `(created_at, id)`, so bookings with the same timestamp still have a stable
order. It uses keyset pagination, so a booking created between pages can't shift the results.

`next_cursor` is the base64url of the last row's `(created_at, id)`. The timestamp in it comes from
Postgres as text with microseconds. A JS `Date` only holds milliseconds, so a cursor built from one
would sort before its own row and return that row again. A cursor this API didn't issue returns 400.

### Rate limiting

_To be written in Phase 5. Decision already made: idempotent replays are answered before
the rate-limit check and don't count as attempts._

## Tests

```sh
npm test
```

Tests live in `src/app.test.ts` and use Node's built-in test runner. They replace the database
pool's methods with fakes and never read `.env`, so they can't touch a real database. They need
no setup, but they also can't prove the SQL itself works: check that against the deployed URL.
