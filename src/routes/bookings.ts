import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { toUtcIso, withTransaction } from '../db.js';
import { hashRequestBody, runOnce, type StoredResponse } from '../idempotency.js';
import { RateLimitedError, recordAttempt } from '../rateLimit.js';

interface NewBooking {
  slotId: string;
  name: string;
  email: string;
}

interface BookingListQuery {
  email?: string | string[];
  limit?: string | string[];
  cursor?: string | string[];
}

interface BookingCursor {
  createdAt: string;
  id: string;
}

interface ListParams {
  email: string;
  limit: number;
  cursor: BookingCursor | null;
}

const defaultListLimit = 10;
const maxListLimit = 50;

// Digits only, so "1.5", "1e1", "+5" and "" are all rejected. Range-checked separately.
const limitPattern = /^[1-9][0-9]*$/;

// The exact form this API writes. Postgres has no year 0000, so the first digit can't be 0.
const cursorTimestampPattern = /^[1-9]\d{3}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;

// Requires a dot in the domain. Each part excludes the separators around it, so
// the pattern can't backtrack badly on very long input.
const emailPattern = /^[^\s@]+@[^\s@.]+(?:\.[^\s@.]+)+$/;

interface BookingRow {
  id: string;
  slot_id: string;
  name: string;
  email: string;
  status: 'confirmed' | 'cancelled';
  created_at: Date;
}

interface BookingListRow extends BookingRow {
  cursor_created_at: string;
}

function toBooking(row: BookingRow): Omit<BookingRow, 'created_at'> & { created_at: string } {
  return { ...row, created_at: toUtcIso(row.created_at) };
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

// The rate limit runs before validation, so a badly formed email still counts as an attempt
// against itself. A missing or non-string email has nothing to count against, and gets a 400.
function emailToRateLimit(body: unknown): string | null {
  const email = typeof body === 'object' && body !== null && 'email' in body ? body.email : undefined;
  return isNonEmptyString(email) ? normalizeEmail(email) : null;
}

// Reports the first invalid field. Any body that isn't an object counts as all fields missing.
function parseNewBooking(body: unknown): NewBooking | { error: string } {
  const fields: Record<string, unknown> = typeof body === 'object' && body !== null ? { ...body } : {};
  const { slot_id: slotId, name, email } = fields;

  if (!isNonEmptyString(slotId)) return { error: 'slot_id must be a non-empty string' };
  if (!isNonEmptyString(name)) return { error: 'name must be a non-empty string' };
  if (!isNonEmptyString(email)) return { error: 'email must be a non-empty string' };

  const normalizedEmail = normalizeEmail(email);
  if (!emailPattern.test(normalizedEmail)) return { error: 'email is invalid' };

  return { slotId, name: name.trim(), email: normalizedEmail };
}

// Checks the index name too, so no other unique violation is reported as "slot already booked".
function isConfirmedSlotConflict(err: unknown): boolean {
  return (
    err instanceof Error &&
    'code' in err &&
    err.code === '23505' &&
    'constraint' in err &&
    err.constraint === 'one_confirmed_per_slot'
  );
}

// Returns the response rather than sending it, so an idempotent request can store it first.
async function createBooking(client: pg.PoolClient, body: unknown): Promise<StoredResponse> {
  const newBooking = parseNewBooking(body);
  if ('error' in newBooking) {
    return { statusCode: 400, body: { error: newBooking.error } };
  }
  const { slotId, name, email } = newBooking;

  // now() is the database clock, so the app server's clock doesn't matter.
  const slotResult = await client.query<{ hasStarted: boolean }>(
    'SELECT start <= now() AS "hasStarted" FROM slots WHERE id = $1',
    [slotId],
  );
  const slot = slotResult.rows[0];
  if (!slot) {
    return { statusCode: 404, body: { error: 'slot not found' } };
  }
  if (slot.hasStarted) {
    return { statusCode: 400, body: { error: 'slot has already started' } };
  }

  // No check for an existing booking first: the unique index is what stops double booking,
  // including when many requests arrive at the same moment.
  try {
    const result = await client.query<BookingRow>(
      `INSERT INTO bookings (id, slot_id, name, email, status)
       VALUES ($1, $2, $3, $4, 'confirmed')
       RETURNING id, slot_id, name, email, status, created_at`,
      [randomUUID(), slotId, name, email],
    );
    return { statusCode: 201, body: toBooking(result.rows[0]) };
  } catch (err) {
    if (isConfirmedSlotConflict(err)) {
      return { statusCode: 409, body: { error: 'slot already booked' } };
    }
    throw err;
  }
}

// Everything after an idempotent replay: the rate limit, then the booking rules.
async function attemptBooking(client: pg.PoolClient, body: unknown): Promise<StoredResponse> {
  const email = emailToRateLimit(body);
  if (email) {
    await recordAttempt(client, email);
  }

  // A unique violation aborts the whole transaction, but the attempt must still count and an
  // idempotent 409 must still be stored. Rolling back to here recovers the transaction and keeps both.
  await client.query('SAVEPOINT attempt');
  const response = await createBooking(client, body);
  if (response.statusCode >= 400) {
    await client.query('ROLLBACK TO SAVEPOINT attempt');
  }
  return response;
}

function encodeCursor(cursor: BookingCursor): string {
  return Buffer.from(JSON.stringify([cursor.createdAt, cursor.id])).toString('base64url');
}

// A cursor is opaque to clients, so anything this didn't produce is rejected with a 400
// before it can reach the database and fail there as a 500.
function decodeCursor(raw: string): BookingCursor | null {
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (!Array.isArray(decoded) || decoded.length !== 2) return null;

  const [createdAt, id] = decoded;
  if (typeof createdAt !== 'string' || typeof id !== 'string' || id.includes('\0')) return null;
  if (!cursorTimestampPattern.test(createdAt)) return null;

  // Date rolls an impossible day such as Feb 31 into March, so check it comes back unchanged.
  const parsed = new Date(createdAt);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 19) !== createdAt.slice(0, 19)) return null;

  return { createdAt, id };
}

function parseListQuery(query: BookingListQuery): ListParams | { error: string } {
  const { email, limit: rawLimit, cursor: rawCursor } = query;

  // A repeated query parameter arrives as an array, which fails these string checks.
  if (typeof email !== 'string' || email.trim() === '') return { error: 'email is required' };
  if (email.includes('\0')) return { error: 'email is invalid' };

  let limit = defaultListLimit;
  if (rawLimit !== undefined) {
    if (typeof rawLimit !== 'string' || !limitPattern.test(rawLimit) || Number(rawLimit) > maxListLimit) {
      return { error: `limit must be an integer from 1 to ${maxListLimit}` };
    }
    limit = Number(rawLimit);
  }

  let cursor: BookingCursor | null = null;
  if (rawCursor !== undefined) {
    cursor = typeof rawCursor === 'string' ? decodeCursor(rawCursor) : null;
    if (!cursor) return { error: 'cursor is invalid' };
  }

  // Stored emails are always trimmed and lower-case, so normalizing here makes the match ignore case.
  return { email: normalizeEmail(email), limit, cursor };
}

export function registerBookingRoutes(app: FastifyInstance, pool: pg.Pool): void {
  app.post('/bookings', async (request, reply) => {
    const key = request.headers['idempotency-key'];

    try {
      const response = await withTransaction(pool, request.log, (client) =>
        typeof key === 'string' && key !== ''
          ? runOnce(client, key, hashRequestBody(request.body), () => attemptBooking(client, request.body))
          : attemptBooking(client, request.body),
      );
      return reply.code(response.statusCode).send(response.body);
    } catch (err) {
      if (err instanceof RateLimitedError) {
        return reply.code(429).header('Retry-After', String(err.retryAfterSeconds)).send({ error: err.message });
      }
      throw err;
    }
  });

  app.get<{ Querystring: BookingListQuery }>('/bookings', async (request, reply) => {
    const params = parseListQuery(request.query);
    if ('error' in params) {
      return reply.code(400).send({ error: params.error });
    }
    const { email, limit, cursor } = params;

    // cursor_created_at keeps Postgres's microseconds. A JS Date only holds milliseconds, so a
    // cursor built from one would sort before its own row and return that row again.
    // One row more than the page tells us whether another page exists.
    const result = await pool.query<BookingListRow>(
      `SELECT id, slot_id, name, email, status, created_at,
              to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_created_at
       FROM bookings
       WHERE email = $1
         AND ($2::timestamptz IS NULL OR (created_at, id) > ($2::timestamptz, $3::text))
       ORDER BY created_at, id
       LIMIT $4`,
      [email, cursor?.createdAt ?? null, cursor?.id ?? null, limit + 1],
    );

    const page = result.rows.slice(0, limit);
    const last = page.at(-1);
    return {
      bookings: page.map(({ cursor_created_at: _cursorCreatedAt, ...row }) => toBooking(row)),
      next_cursor:
        result.rows.length > limit && last ? encodeCursor({ createdAt: last.cursor_created_at, id: last.id }) : null,
    };
  });

  app.get<{ Params: { id: string } }>('/bookings/:id', async (request, reply) => {
    const result = await pool.query<BookingRow>(
      `SELECT id, slot_id, name, email, status, created_at
       FROM bookings
       WHERE id = $1`,
      [request.params.id],
    );

    const booking = result.rows[0];
    if (!booking) {
      return reply.code(404).send({ error: 'booking not found' });
    }
    return toBooking(booking);
  });

  app.delete<{ Params: { id: string } }>(
    '/bookings/:id',
    {
      // Fastify rejects an empty body sent with a JSON Content-Type, and DELETE has no body.
      // Clients that set that header on every request must still be able to cancel.
      onRequest: async (request) => {
        delete request.headers['content-type'];
      },
    },
    async (request, reply) => {
      // One statement, so of two simultaneous cancels only one can match status = 'confirmed'.
      const cancelled = await pool.query<BookingRow>(
        `UPDATE bookings SET status = 'cancelled'
         WHERE id = $1 AND status = 'confirmed'
         RETURNING id, slot_id, name, email, status, created_at`,
        [request.params.id],
      );
      const booking = cancelled.rows[0];
      if (booking) {
        return toBooking(booking);
      }

      const existing = await pool.query('SELECT 1 FROM bookings WHERE id = $1', [request.params.id]);
      if (existing.rows.length > 0) {
        return reply.code(409).send({ error: 'booking already cancelled' });
      }
      return reply.code(404).send({ error: 'booking not found' });
    },
  );
}
