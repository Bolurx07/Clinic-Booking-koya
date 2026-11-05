import pg from 'pg';

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
