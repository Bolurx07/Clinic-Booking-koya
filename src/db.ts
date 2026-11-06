import type { FastifyBaseLogger } from 'fastify';
import pg from 'pg';

// Commits if work resolves and rolls back if it throws.
export async function withTransaction<T>(
  pool: pg.Pool,
  log: FastifyBaseLogger,
  work: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  // The pool stops listening while a client is checked out, so a connection dropping
  // between queries would otherwise crash the process. The next query still fails and rolls back.
  const onClientError = (err: Error): void => {
    log.error({ err }, 'database connection error during a transaction');
  };
  client.on('error', onClientError);

  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    // If the connection is gone this fails too. The original error is the one worth reporting.
    await client.query('ROLLBACK').catch((rollbackErr: unknown) => {
      log.error({ err: rollbackErr }, 'rollback failed');
    });
    throw err;
  } finally {
    // Clients are reused, so leave no listener behind.
    client.removeListener('error', onClientError);
    client.release();
  }
}

export function createPool(databaseUrl: string): pg.Pool {
  const pool = new pg.Pool({ connectionString: databaseUrl });

  // Without a listener, an idle connection failing (e.g. Neon dropping it) would crash the process.
  // The pool has already discarded that connection, so logging is all that is needed.
  pool.on('error', (err) => {
    console.error('database pool: idle connection error', err);
  });

  return pool;
}

// The contract's timestamps have no ".000": 2026-12-10T09:00:00Z.
export function toUtcIso(date: Date): string {
  return date.toISOString().replace('.000Z', 'Z');
}
