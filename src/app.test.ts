import assert from 'node:assert/strict';
import { describe, mock, test } from 'node:test';
import type { InjectOptions } from 'fastify';
import pg from 'pg';
import { buildApp } from './app.js';

const apiKey = 'test-api-key';
const validHeaders = { 'x-api-key': apiKey };
const validBooking = { slot_id: 's1', name: 'Ada Obi', email: 'ada@example.com' };

// Never contacted: every pool method used is replaced below. If one were missed, the call
// would fail against this address, so it could never reach a real database.
const unreachableDatabaseUrl = 'postgres://placeholder:placeholder@127.0.0.1:1/none';

function createTestApp(slotRows: { hasStarted: boolean }[] = [{ hasStarted: false }]) {
  const pool = new pg.Pool({ connectionString: unreachableDatabaseUrl });

  const query = mock.method(pool, 'query', async (sql: string, params: unknown[] = []) => {
    if (sql.includes('FROM slots WHERE id')) return { rows: slotRows };
    if (sql.includes('INSERT INTO bookings')) {
      const [id, slotId, name, email] = params;
      const createdAt = new Date('2026-11-05T12:00:00Z');
      return { rows: [{ id, slot_id: slotId, name, email, status: 'confirmed', created_at: createdAt }] };
    }
    if (sql.includes('FROM bookings')) return { rows: [] };
    if (sql.includes('FROM slots s')) return { rows: [] };
    if (sql === 'SELECT 1') return { rows: [{}] };
    throw new Error(`unexpected query: ${sql}`);
  });
  const connect = mock.method(pool, 'connect', async () => {
    throw new Error('connect must not be called');
  });

  const app = buildApp(pool, apiKey);
  app.log.level = 'silent';

  const countInserts = (): number =>
    query.mock.calls.filter((call) => String(call.arguments[0]).includes('INSERT INTO bookings')).length;

  return { app, query, connect, countInserts };
}

function postBooking(payload: object): InjectOptions {
  return { method: 'POST', url: '/bookings', headers: validHeaders, payload };
}

describe('401: X-API-Key', () => {
  const routes: InjectOptions[] = [
    { method: 'POST', url: '/reset', payload: { slots: [] } },
    { method: 'GET', url: '/slots' },
    { method: 'POST', url: '/bookings', payload: validBooking },
    { method: 'GET', url: '/bookings/some-id' },
  ];

  for (const route of routes) {
    for (const [label, headers] of [
      ['missing key', {}],
      ['wrong key', { 'x-api-key': 'wrong-key' }],
      ['empty key', { 'x-api-key': '' }],
    ] as const) {
      test(`${route.method} ${route.url}: ${label}`, async () => {
        const { app, query, connect } = createTestApp();

        const response = await app.inject({ ...route, headers });

        assert.equal(response.statusCode, 401);
        assert.deepEqual(response.json(), { error: 'missing or invalid API key' });
        assert.equal(query.mock.callCount(), 0);
        assert.equal(connect.mock.callCount(), 0);
      });
    }
  }

  test('a malformed body with no key is still 401', async () => {
    const { app } = createTestApp();

    const response = await app.inject({
      method: 'POST',
      url: '/bookings',
      headers: { 'content-type': 'application/json' },
      payload: '{oops',
    });

    assert.equal(response.statusCode, 401);
  });

  test('an unknown route is 401 with no key and 404 with a valid key', async () => {
    const { app } = createTestApp();

    const withoutKey = await app.inject({ method: 'GET', url: '/nope' });
    const withKey = await app.inject({ method: 'GET', url: '/nope', headers: validHeaders });

    assert.equal(withoutKey.statusCode, 401);
    assert.equal(withKey.statusCode, 404);
    assert.deepEqual(withKey.json(), { error: 'not found' });
  });

  test('/health needs no key', async () => {
    const { app } = createTestApp();

    const response = await app.inject({ method: 'GET', url: '/health' });

    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), { status: 'ok', db: 'ok' });
  });

  test('a valid key reaches the route', async () => {
    const { app } = createTestApp();

    const slots = await app.inject({ method: 'GET', url: '/slots', headers: validHeaders });
    const booking = await app.inject({ method: 'GET', url: '/bookings/some-id', headers: validHeaders });

    assert.equal(slots.statusCode, 200);
    assert.equal(booking.statusCode, 404);
    assert.deepEqual(booking.json(), { error: 'booking not found' });
  });
});

describe('400: POST /bookings fields', () => {
  for (const field of ['slot_id', 'name', 'email'] as const) {
    const error = `${field} must be a non-empty string`;
    const { [field]: _omitted, ...withoutField } = validBooking;

    const cases: [string, object][] = [
      ['missing', withoutField],
      ['empty', { ...validBooking, [field]: '' }],
      ['only spaces', { ...validBooking, [field]: '   ' }],
      ['a number', { ...validBooking, [field]: 123 }],
      ['null', { ...validBooking, [field]: null }],
    ];

    for (const [label, payload] of cases) {
      test(`${field} is ${label}`, async () => {
        const { app, query } = createTestApp();

        const response = await app.inject(postBooking(payload));

        assert.equal(response.statusCode, 400);
        assert.deepEqual(response.json(), { error });
        assert.equal(query.mock.callCount(), 0);
      });
    }
  }

  for (const email of ['not-an-email', 'a@b', '@b.c', 'a@', 'a b@c.d', 'a@b@c.d', 'a@b..c', 'a@.b.c', 'a@b.c.']) {
    test(`email "${email}" is invalid`, async () => {
      const { app, query } = createTestApp();

      const response = await app.inject(postBooking({ ...validBooking, email }));

      assert.equal(response.statusCode, 400);
      assert.deepEqual(response.json(), { error: 'email is invalid' });
      assert.equal(query.mock.callCount(), 0);
    });
  }

  test('no body counts as all fields missing', async () => {
    const { app } = createTestApp();

    const response = await app.inject({ method: 'POST', url: '/bookings', headers: validHeaders });

    assert.equal(response.statusCode, 400);
    assert.deepEqual(response.json(), { error: 'slot_id must be a non-empty string' });
  });

  test('a JSON array counts as all fields missing', async () => {
    const { app } = createTestApp();

    const response = await app.inject({
      method: 'POST',
      url: '/bookings',
      headers: { ...validHeaders, 'content-type': 'application/json' },
      payload: '[]',
    });

    assert.equal(response.statusCode, 400);
    assert.deepEqual(response.json(), { error: 'slot_id must be a non-empty string' });
  });

  test('malformed JSON is 400 in the error format', async () => {
    const { app } = createTestApp();

    const response = await app.inject({
      method: 'POST',
      url: '/bookings',
      headers: { ...validHeaders, 'content-type': 'application/json' },
      payload: '{oops',
    });

    assert.equal(response.statusCode, 400);
    assert.equal(typeof response.json().error, 'string');
  });
});

describe('POST /bookings: slot checks', () => {
  test('404 for an unknown slot, creating nothing', async () => {
    const { app, countInserts } = createTestApp([]);

    const response = await app.inject(postBooking(validBooking));

    assert.equal(response.statusCode, 404);
    assert.deepEqual(response.json(), { error: 'slot not found' });
    assert.equal(countInserts(), 0);
  });

  test('400 for a slot that has already started, creating nothing', async () => {
    const { app, countInserts } = createTestApp([{ hasStarted: true }]);

    const response = await app.inject(postBooking(validBooking));

    assert.equal(response.statusCode, 400);
    assert.deepEqual(response.json(), { error: 'slot has already started' });
    assert.equal(countInserts(), 0);
  });

  test('field errors come before slot checks', async () => {
    const { app, countInserts } = createTestApp([{ hasStarted: true }]);

    const response = await app.inject(postBooking({ ...validBooking, name: '' }));

    assert.deepEqual(response.json(), { error: 'name must be a non-empty string' });
    assert.equal(countInserts(), 0);
  });
});

describe('201: POST /bookings', () => {
  test('creates a confirmed booking', async () => {
    const { app, countInserts } = createTestApp();

    const response = await app.inject(postBooking(validBooking));
    const booking = response.json();

    assert.equal(response.statusCode, 201);
    assert.equal(typeof booking.id, 'string');
    assert.equal(booking.slot_id, 's1');
    assert.equal(booking.status, 'confirmed');
    assert.equal(booking.created_at, '2026-11-05T12:00:00Z');
    assert.equal(countInserts(), 1);
  });

  test('trims name and email and lower-cases email, in the insert and the response', async () => {
    const { app, query } = createTestApp();

    const response = await app.inject(
      postBooking({ slot_id: 's1', name: '  Ada Obi  ', email: '  ADA@Example.COM  ' }),
    );
    const booking = response.json();
    const insert = query.mock.calls.find((call) => String(call.arguments[0]).includes('INSERT INTO bookings'));

    assert.equal(booking.name, 'Ada Obi');
    assert.equal(booking.email, 'ada@example.com');
    assert.deepEqual(insert?.arguments[1]?.slice(1), ['s1', 'Ada Obi', 'ada@example.com']);
  });

  test('stores slot_id as sent', async () => {
    const { app } = createTestApp();

    const response = await app.inject(postBooking({ ...validBooking, slot_id: ' s1 ' }));

    assert.equal(response.statusCode, 201);
    assert.equal(response.json().slot_id, ' s1 ');
  });

  test('accepts a longer valid email', async () => {
    const { app } = createTestApp();

    const response = await app.inject(postBooking({ ...validBooking, email: 'a.b+c@sub.example.co' }));

    assert.equal(response.statusCode, 201);
    assert.equal(response.json().email, 'a.b+c@sub.example.co');
  });
});
