import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { toUtcIso } from '../db.js';

// Not checked at runtime yet: field validation arrives in Phase 2.
interface NewBooking {
  slot_id: string;
  name: string;
  email: string;
}

interface BookingRow {
  id: string;
  slot_id: string;
  name: string;
  email: string;
  status: 'confirmed' | 'cancelled';
  created_at: Date;
}

function toBooking(row: BookingRow): Omit<BookingRow, 'created_at'> & { created_at: string } {
  return { ...row, created_at: toUtcIso(row.created_at) };
}

export function registerBookingRoutes(app: FastifyInstance, pool: pg.Pool): void {
  app.post<{ Body: NewBooking }>('/bookings', async (request, reply) => {
    const { slot_id: slotId, name, email } = request.body;
    const result = await pool.query<BookingRow>(
      `INSERT INTO bookings (id, slot_id, name, email, status)
       VALUES ($1, $2, $3, $4, 'confirmed')
       RETURNING id, slot_id, name, email, status, created_at`,
      [randomUUID(), slotId, name, email],
    );
    return reply.code(201).send(toBooking(result.rows[0]));
  });

  app.get<{ Params: { id: string } }>('/bookings/:id', async (request, reply) => {
    const result = await pool.query<BookingRow>(
      `SELECT id, slot_id, name, email, status, created_at
       FROM bookings
       WHERE id = $1`,
      [request.params.id],
    );

    const booking = result.rows[0];
    if (!booking) {
      return reply.code(404).send({ error: 'booking not found' });
    }
    return toBooking(booking);
  });
}
