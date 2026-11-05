import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { toUtcIso } from '../db.js';

interface NewBooking {
  slotId: string;
  name: string;
  email: string;
}

// Requires a dot in the domain. Each part excludes the separators around it, so
// the pattern can't backtrack badly on very long input.
const emailPattern = /^[^\s@]+@[^\s@.]+(?:\.[^\s@.]+)+$/;

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

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

// Reports the first invalid field. Any body that isn't an object counts as all fields missing.
function parseNewBooking(body: unknown): NewBooking | { error: string } {
  const fields: Record<string, unknown> = typeof body === 'object' && body !== null ? { ...body } : {};
  const { slot_id: slotId, name, email } = fields;

  if (!isNonEmptyString(slotId)) return { error: 'slot_id must be a non-empty string' };
  if (!isNonEmptyString(name)) return { error: 'name must be a non-empty string' };
  if (!isNonEmptyString(email)) return { error: 'email must be a non-empty string' };

  const normalizedEmail = email.trim().toLowerCase();
  if (!emailPattern.test(normalizedEmail)) return { error: 'email is invalid' };

  return { slotId, name: name.trim(), email: normalizedEmail };
}

export function registerBookingRoutes(app: FastifyInstance, pool: pg.Pool): void {
  app.post('/bookings', async (request, reply) => {
    const newBooking = parseNewBooking(request.body);
    if ('error' in newBooking) {
      return reply.code(400).send({ error: newBooking.error });
    }
    const { slotId, name, email } = newBooking;

    // now() is the database clock, so the app server's clock doesn't matter.
    const slotResult = await pool.query<{ hasStarted: boolean }>(
      'SELECT start <= now() AS "hasStarted" FROM slots WHERE id = $1',
      [slotId],
    );
    const slot = slotResult.rows[0];
    if (!slot) {
      return reply.code(404).send({ error: 'slot not found' });
    }
    if (slot.hasStarted) {
      return reply.code(400).send({ error: 'slot has already started' });
    }

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
