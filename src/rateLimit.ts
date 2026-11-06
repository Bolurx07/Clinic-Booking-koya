import type pg from 'pg';

const maxAttempts = 5;
const windowSeconds = 60;

// Thrown rather than returned so the whole transaction rolls back. That keeps a blocked attempt
// out of the count and releases any Idempotency-Key claimed earlier in the transaction.
export class RateLimitedError extends Error {
  readonly retryAfterSeconds: number;

  constructor(retryAfterSeconds: number) {
    super('too many attempts for this email');
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

// Must run inside a transaction: the attempt only counts once that transaction commits.
export async function recordAttempt(client: pg.PoolClient, email: string): Promise<void> {
  // Without this, simultaneous requests could all count 4 and all pass. The lock is per email,
  // so other emails aren't slowed down, and it is released when the transaction ends.
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [email]);

  // clock_timestamp(), not now(): now() is when the transaction began, which could be long before
  // this request got the lock.
  await client.query(
    `DELETE FROM attempts WHERE email = $1 AND at <= clock_timestamp() - $2::int * interval '1 second'`,
    [email, windowSeconds],
  );

  const result = await client.query<{ attempts: number; retry_after: number | null }>(
    `SELECT count(*)::int AS attempts,
            ceil(extract(epoch FROM min(at) + $2::int * interval '1 second' - clock_timestamp()))::int AS retry_after
     FROM attempts
     WHERE email = $1`,
    [email, windowSeconds],
  );
  const { attempts, retry_after: retryAfter } = result.rows[0];

  if (attempts >= maxAttempts) {
    throw new RateLimitedError(Math.max(retryAfter ?? 1, 1));
  }

  await client.query('INSERT INTO attempts (email, at) VALUES ($1, clock_timestamp())', [email]);
}
