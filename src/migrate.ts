import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { loadConfig } from './config.js';
import { createPool } from './db.js';

// Runs every migrations/*.sql file not yet recorded in schema_migrations, in name order.
// Each file runs in its own transaction, so a failing migration leaves no partial changes.
// Safe to run repeatedly: already-applied files are skipped.

const migrationsDir = path.join(process.cwd(), 'migrations');

async function runMigrations(): Promise<void> {
  const config = loadConfig();
  const pool = createPool(config.databaseUrl);

  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `);

    const applied = await pool.query<{ name: string }>('SELECT name FROM schema_migrations');
    const appliedNames = new Set(applied.rows.map((row) => row.name));

    const files = (await readdir(migrationsDir)).filter((file) => file.endsWith('.sql')).sort();
    const pending = files.filter((file) => !appliedNames.has(file));

    if (pending.length === 0) {
      console.log('migrate: database is up to date');
      return;
    }

    for (const file of pending) {
      const sql = await readFile(path.join(migrationsDir, file), 'utf8');
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
        await client.query('COMMIT');
        console.log(`migrate: applied ${file}`);
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`migration ${file} failed`, { cause: err });
      } finally {
        client.release();
      }
    }
  } finally {
    await pool.end();
  }
}

try {
  await runMigrations();
} catch (err) {
  console.error('migrate: failed', err);
  process.exit(1);
}
