import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { withTransaction } from '../db.js';

interface ResetBody {
  slots: {
    id: string;
    provider: string;
    start: string;
    end: string;
  }[];
}

const resetBodySchema = {
  type: 'object',
  required: ['slots'],
  properties: {
    slots: {
      type: 'array',
      items: {
        type: 'object',
        required: ['id', 'provider', 'start', 'end'],
        properties: {
          id: { type: 'string' },
          provider: { type: 'string' },
          start: { type: 'string', format: 'date-time' },
          end: { type: 'string', format: 'date-time' },
        },
      },
    },
  },
};

export function registerResetRoute(app: FastifyInstance, pool: pg.Pool): void {
  app.post<{ Body: ResetBody }>('/reset', { schema: { body: resetBodySchema } }, async (request) => {
    await withTransaction(pool, request.log, async (client) => {
      // Stored keys would otherwise replay bookings that no longer exist, or return stale 422s.
      await client.query('DELETE FROM idempotency_keys');
      // Bookings first: their foreign key to slots has no cascade.
      await client.query('DELETE FROM bookings');
      await client.query('DELETE FROM slots');
      for (const slot of request.body.slots) {
        await client.query('INSERT INTO slots (id, provider, start, "end") VALUES ($1, $2, $3, $4)', [
          slot.id,
          slot.provider,
          slot.start,
          slot.end,
        ]);
      }
    });

    return { status: 'ok' };
  });
}
