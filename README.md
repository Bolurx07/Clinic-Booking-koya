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

To change the schema, add a new file with the next number (e.g. `002_add_something.sql`).
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
| `POST /bookings`         | X-API-Key | Phase 1 done; 2 to 5 next       |
| `GET /bookings/{id}`     | X-API-Key | done (Phase 1)                  |
| `DELETE /bookings/{id}`  | X-API-Key | Phase 3                         |
| `GET /bookings`          | X-API-Key | Phase 4                         |

The `X-API-Key` check arrives in Phase 2. Until then, these endpoints are not protected.

`/health` is not part of the API contract. It is public on purpose: Render's health
check and keep-alive pingers can't send custom headers, and it reveals nothing except "ok".

Every error response is `{"error": "<message>"}`.

## Design decisions

### Concurrency (one confirmed booking per slot)

_To be written in Phase 3._

### Idempotency

_To be written in Phase 4._

### Rate limiting

_To be written in Phase 5. Decision already made: idempotent replays are answered before
the rate-limit check and don't count as attempts._

## Tests

_To be written in Phase 2._
