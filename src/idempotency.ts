import { createHash } from 'node:crypto';
import type { FastifyBaseLogger } from 'fastify';
import type pg from 'pg';
import { withTransaction } from './db.js';

export interface StoredResponse {
  statusCode: number;
  body: object;
}

interface IdempotencyRow {
  request_hash: string;
  status_code: number;
  response_body: object;
}

// Object keys are sorted at every depth, so key order in the request doesn't change the hash.
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`;
  }
  if (typeof value === 'object' && value !== null) {
    const members = Object.entries(value)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, member]) => `${JSON.stringify(key)}:${canonicalJson(member)}`);
    return `{${members.join(',')}}`;
  }
  // A request with no body parses to undefined, which JSON.stringify doesn't turn into a string.
  return JSON.stringify(value) ?? 'null';
}

export function hashRequestBody(body: unknown): string {
  return createHash('sha256').update(canonicalJson(body)).digest('hex');
}

// Runs handler at most once per key and stores what it returns. An error from handler rolls
// everything back, key included, so a 500 is never stored and the client can retry.
export function runOnce(
  pool: pg.Pool,
  log: FastifyBaseLogger,
  key: string,
  requestHash: string,
  handler: (client: pg.PoolClient) => Promise<StoredResponse>,
): Promise<StoredResponse> {
  return withTransaction(pool, log, async (client) => {
    // If another transaction holds this key, this waits for it to finish. That is what stops
    // two simultaneous requests with the same key from both creating a booking.
    const claim = await client.query(
      `INSERT INTO idempotency_keys (key, request_hash)
       VALUES ($1, $2)
       ON CONFLICT (key) DO NOTHING
       RETURNING key`,
      [key, requestHash],
    );

    if (claim.rows.length === 0) {
      const existing = await client.query<IdempotencyRow>(
        'SELECT request_hash, status_code, response_body FROM idempotency_keys WHERE key = $1',
        [key],
      );
      const stored = existing.rows[0];
      if (!stored) {
        throw new Error('idempotency key vanished after a conflict');
      }
      if (stored.request_hash !== requestHash) {
        return { statusCode: 422, body: { error: 'Idempotency-Key was already used with a different body' } };
      }
      return { statusCode: stored.status_code, body: stored.response_body };
    }

    // A unique violation aborts the whole transaction, but its 409 still has to be stored.
    // Rolling back to here recovers the transaction and keeps the claimed key.
    await client.query('SAVEPOINT attempt');
    const response = await handler(client);
    if (response.statusCode >= 400) {
      await client.query('ROLLBACK TO SAVEPOINT attempt');
    }

    await client.query('UPDATE idempotency_keys SET status_code = $2, response_body = $3 WHERE key = $1', [
      key,
      response.statusCode,
      JSON.stringify(response.body),
    ]);
    return response;
  });
}
