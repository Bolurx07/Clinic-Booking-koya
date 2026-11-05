import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { toUtcIso } from '../db.js';

interface SlotsQuery {
  provider?: string;
}

interface SlotRow {
  id: string;
  provider: string;
  start: Date;
  end: Date;
  available: boolean;
}

const slotsQuerySchema = {
  type: 'object',
  properties: {
    provider: { type: 'string' },
  },
};

export function registerSlotsRoute(app: FastifyInstance, pool: pg.Pool): void {
  app.get<{ Querystring: SlotsQuery }>('/slots', { schema: { querystring: slotsQuerySchema } }, async (request) => {
    // EXISTS rather than a join, so a slot can never appear twice in the list.
    const result = await pool.query<SlotRow>(
      `SELECT s.id, s.provider, s.start, s."end",
              NOT EXISTS (
                SELECT 1 FROM bookings b WHERE b.slot_id = s.id AND b.status = 'confirmed'
              ) AS available
       FROM slots s
       WHERE ($1::text IS NULL OR s.provider = $1)
       ORDER BY s.start, s.id`,
      [request.query.provider ?? null],
    );

    const slots = result.rows.map((row) => ({
      ...row,
      start: toUtcIso(row.start),
      end: toUtcIso(row.end),
    }));
    return { slots };
  });
}
