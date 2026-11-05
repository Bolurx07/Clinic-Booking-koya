import type { FastifyInstance } from 'fastify';
import type pg from 'pg';

// Public on purpose: Render's health check and keep-alive pingers can't send X-API-Key.
export function registerHealthRoute(app: FastifyInstance, pool: pg.Pool): void {
  app.get('/health', async (request, reply) => {
    try {
      await pool.query('SELECT 1');
      return { status: 'ok', db: 'ok' };
    } catch (err) {
      request.log.error({ err }, 'health check: database query failed');
      return reply.code(503).send({ error: 'database unavailable' });
    }
  });
}
