import { createHash, timingSafeEqual } from 'node:crypto';
import Fastify, { type FastifyError, type FastifyInstance } from 'fastify';
import type pg from 'pg';
import { registerBookingRoutes } from './routes/bookings.js';
import { registerHealthRoute } from './routes/health.js';
import { registerResetRoute } from './routes/reset.js';
import { registerSlotsRoute } from './routes/slots.js';

function sha256(value: string): Buffer {
  return createHash('sha256').update(value).digest();
}

function isValidApiKey(candidate: unknown, apiKey: string): boolean {
  if (typeof candidate !== 'string') return false;
  // timingSafeEqual throws on different lengths, so compare fixed-length hashes.
  return timingSafeEqual(sha256(candidate), sha256(apiKey));
}

export function buildApp(pool: pg.Pool, apiKey: string): FastifyInstance {
  const app = Fastify({ logger: true });

  // onRequest runs before the body is parsed, so a missing key beats a malformed body.
  app.addHook('onRequest', async (request, reply) => {
    // Public on purpose: Render's health check and keep-alive pingers can't send X-API-Key.
    if (request.routeOptions.url === '/health') return;

    if (!isValidApiKey(request.headers['x-api-key'], apiKey)) {
      return reply.code(401).send({ error: 'missing or invalid API key' });
    }
  });

  // The contract requires every error body to be {"error": "<message>"}.
  app.setNotFoundHandler((_request, reply) => {
    reply.code(404).send({ error: 'not found' });
  });

  app.setErrorHandler<FastifyError>((err, request, reply) => {
    const statusCode = err.statusCode ?? 500;
    if (statusCode >= 500) {
      request.log.error({ err }, 'unhandled error');
      reply.code(500).send({ error: 'internal server error' });
      return;
    }
    reply.code(statusCode).send({ error: err.message });
  });

  registerHealthRoute(app, pool);
  registerResetRoute(app, pool);
  registerSlotsRoute(app, pool);
  registerBookingRoutes(app, pool);

  return app;
}
