# Clinic Booking API

A clinic booking API and a simple web page that uses it (Koya Cohort 4, Task 1).
The contract is the OpenAPI spec at https://koyaacademy.com/assessment-api/openapi.json.

Stack: Node 24, TypeScript (ESM), Fastify, Postgres on Neon, hosted on Render.

## Setup

You need Node 24 and a Postgres database (a free Neon project works).

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

The web page is then at http://localhost:3000/. It lists no slots until you load some with `POST /reset`:

```sh
curl -X POST http://localhost:3000/reset \
  -H "X-API-Key: $API_KEY" -H "Content-Type: application/json" \
  -d '{"slots":[{"id":"s1","provider":"Dr Ade","start":"2030-12-10T09:00:00Z","end":"2030-12-10T09:30:00Z"}]}'
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
| `npm test`             | Run the unit tests. No database or setup needed.       |
| `npm run test:e2e`     | Run the end-to-end tests against a running server. See [Tests](#tests). |
| `npm run migrate`      | Apply pending migrations, using `.env` (local).        |
| `npm run migrate:prod` | Apply pending migrations from `dist/` (used on Render). |

## Endpoints

| Method and path                       | Behaviour                                                       |
| ------------------------------------- | --------------------------------------------------------------- |
| `POST /reset`                         | Delete all bookings, replace all slots, clear keys and attempts. |
| `GET /slots?provider=`                | List slots with availability, earliest first.                   |
| `POST /bookings`                      | Book a slot. Accepts an optional `Idempotency-Key` header.      |
| `GET /bookings?email=&limit=&cursor=` | List a person's bookings, oldest first, one page at a time.     |
| `GET /bookings/{id}`                  | Get one booking.                                                |
| `DELETE /bookings/{id}`               | Cancel a booking, which frees its slot.                         |

Every endpoint above requires the `X-API-Key` header. A missing or wrong key returns 401.
Every error response is `{"error": "<message>"}`. Timestamps are ISO-8601 in UTC.

`POST /bookings` checks its rules in this order:

1. 401: missing or wrong key
2. Idempotency: replay the stored response, or 422 if the same key has a different body
3. 429: too many attempts for this email
4. 400: invalid fields
5. 404: unknown slot
6. 400: the slot has already started
7. 409: the slot already has a confirmed booking
8. 201: the booking is created

These routes are outside the API contract and need no key:

| Route                                  | Why it is public                                                       |
| -------------------------------------- | ---------------------------------------------------------------------- |
| `GET /health`                          | Render's health check and keep-alive pingers can't send custom headers. |
| `GET /`, `GET /app.js`, `GET /styles.css` | The web page.                                                       |
| `GET /web/slots`, `POST /web/bookings` | What the web page calls. See [Web page](#web-page).                    |

## Web page

The app serves the booking page at `/`, from the files in `public/`. It lists slots with a provider
filter, books a slot and shows a confirmation with the booking id, provider and time. Only slots that
can be booked are enabled, and API errors are shown next to the form.

The page never holds the API key. It calls these public routes on the same server, which add
`X-API-Key` and pass the request through the real API routes, so the same rules and errors apply:

| Page route           | Calls            |
| -------------------- | ---------------- |
| `GET /web/slots`     | `GET /slots`     |
| `POST /web/bookings` | `POST /bookings` |

`/reset`, cancelling and looking up bookings have no public route, so they still require the key.
Anyone can book through the page, as on any public booking page, and the per-email rate limit still
applies. It can't stop someone using many different email addresses.

The page sends a new `Idempotency-Key` with each new submission. It reuses the key only when the
outcome is unknown (a network failure or a 5xx), so retrying can't create a second booking.

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
- 429 and 500, because the transaction rolls back and removes the key, so the client can retry.
- Malformed JSON, because there is no parsed body to hash.

A unique violation aborts a Postgres transaction, so the booking attempt runs inside a savepoint.
Rolling back to it keeps the claimed key and the rate-limit attempt, so the 409 can still be stored
and still counts. Responses are stored as `json` rather than `jsonb`, because `jsonb` reorders keys
and a replay should match the original.

### Pagination

`GET /bookings` orders by `(created_at, id)`, so bookings with the same timestamp still have a stable
order. It uses keyset pagination, so a booking created between pages can't shift the results.

`next_cursor` is the base64url of the last row's `(created_at, id)`. The timestamp in it comes from
Postgres as text with microseconds. A JS `Date` only holds milliseconds, so a cursor built from one
would sort before its own row and return that row again. A cursor this API didn't issue returns 400.

### Rate limiting

`POST /bookings` allows 5 attempts per normalized email in a sliding 60-second window. The 6th gets
429 with `Retry-After`: the seconds until the oldest attempt in the window expires, rounded up and at
least 1. Attempts are stored in the `attempts` table, so the limit holds across restarts and instances.

**Decision: idempotent replays are answered before the rate-limit check and don't count as attempts.**
A client retrying after a lost response shouldn't use up its allowance. The same goes for a reused
key with a different body: its 422 is also answered first and doesn't count.

What counts:

- Every attempt that reaches the booking rules, including ones that fail with 400, 404 or 409.
  Each attempt is recorded before a savepoint, so a failed booking doesn't undo it.
- A badly formed email, which counts against itself, because the limit runs before validation.

What doesn't count:

- A blocked attempt. Otherwise a client that keeps retrying would never get through, and
  `Retry-After` would be wrong.
- A missing or non-string email, which has nothing to count against and returns 400.
- Malformed JSON, which is rejected before the route runs.
- A 500, because its transaction rolls back. It's a server failure rather than a client attempt.
- A value Postgres rejects, such as a null character, which also rolls back and returns 400.

A per-email Postgres advisory lock, held until the transaction ends, makes the count and insert
atomic. Without it, simultaneous requests could all count 4 and all pass. Other emails don't wait.
Locks are always taken in the same order (idempotency key, then email, then slot), so two requests
can't deadlock.

### Limit on the pagination example

The rate limit means one email can only create 5 bookings a minute, so 25 bookings for one email take
over 4 minutes to create. Pagination is tested at that size by `E2E_LONG=1 npm run test:e2e`.

### Invalid values

Postgres rejects some values that pass validation, such as a null character in text. The global error
handler returns these (error class 22) as 400 rather than 500, whichever route they reach. On
`GET` and `DELETE /bookings/{id}` this means a 400 rather than a 404. Such an id can't exist either way.

## Database migrations

Migrations are plain SQL files in `migrations/`, applied in name order by `src/migrate.ts`.
Applied files are recorded in the `schema_migrations` table, so running it again is safe.
Each file runs in its own transaction.

To change the schema, add a new file with the next number (e.g. `005_add_something.sql`).
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

## Tests

### Unit tests

```sh
npm test
```

These live in `src/app.test.ts` and use Node's built-in test runner. They replace the database
pool's methods with fakes and never read `.env`, so they can't touch a real database. They need
no setup, but they also can't prove the SQL itself works. The end-to-end tests do that.

### End-to-end tests

**These call `POST /reset`, which deletes every booking and replaces every slot on the target.**
Only point them at a server whose data you can lose.

They live in `src/e2e.test.ts` and call a running server over HTTP, normally the deployed one. They
cover every status code in the contract (200, 201, 400, 401, 404, 409, 422 and 429), the parallel
cases and the web page routes. They never read `.env`, so you must set the target yourself:

```sh
BASE_URL=https://your-app.onrender.com API_KEY=your-key npm run test:e2e
```

In PowerShell:

```powershell
$env:BASE_URL="https://your-app.onrender.com"
$env:API_KEY="your-key"
npm run test:e2e
```

A run takes just over a minute, because one test waits out a real `Retry-After`. To also page through
25 bookings for one email, set `E2E_LONG=1`. That adds over 4 minutes because of the rate limit.
