import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { createPool } from './db.js';

const config = loadConfig();
const pool = createPool(config.databaseUrl);
const app = buildApp(pool);

try {
  // 0.0.0.0 so Render (and containers) can reach the server, not just localhost.
  await app.listen({ host: '0.0.0.0', port: config.port });
} catch (err) {
  app.log.error({ err }, 'failed to start server');
  await pool.end();
  process.exit(1);
}
