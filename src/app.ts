import Fastify, { type FastifyError, type FastifyInstance } from 'fastify';
import type pg from 'pg';
import { registerHealthRoute } from './routes/health.js';

export function buildApp(pool: pg.Pool): FastifyInstance {
  const app = Fastify({ logger: true });

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

  return app;
}
