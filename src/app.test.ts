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

interface FakeBookingResults {
  insertError?: Error;
  cancelledRows?: object[];
  existingRows?: object[];
  listRows?: object[];
}

interface StoredKey {
  request_hash: string;
  status_code: number | null;
  response_body: object | null;
}

function createTestApp(
  slotRows: { hasStarted: boolean }[] = [{ hasStarted: false }],
  { insertError, cancelledRows = [], existingRows = [], listRows = [] }: FakeBookingResults = {},
) {
  const pool = new pg.Pool({ connectionString: unreachableDatabaseUrl });
  const storedKeys = new Map<string, StoredKey>();

  const query = mock.method(pool, 'query', async (sql: string, params: unknown[] = []) => {
    if (sql.includes('cursor_created_at')) return { rows: listRows };
    if (sql.includes('FROM slots WHERE id')) return { rows: slotRows };
    if (sql.includes('UPDATE bookings')) return { rows: cancelledRows };
    if (sql.includes('SELECT 1 FROM bookings')) return { rows: existingRows };
    if (sql.includes('INSERT INTO bookings')) {
      if (insertError) throw insertError;
      const [id, slotId, name, email] = params;
      const createdAt = new Date('2026-11-05T12:00:00Z');
      return { rows: [{ id, slot_id: slotId, name, email, status: 'confirmed', created_at: createdAt }] };
    }
    if (sql.includes('FROM bookings')) return { rows: [] };
    if (sql.includes('FROM slots s')) return { rows: [] };
    if (sql === 'SELECT 1') return { rows: [{}] };
    throw new Error(`unexpected query: ${sql}`);
  });

  // A client that handles the key table and passes everything else to the fake query above.
  // ROLLBACK forgets a key claimed in that transaction, like the real one.
  const connect = mock.method(pool, 'connect', async () => {
    let claimed: string | undefined;
    return {
      on: () => {},
      removeListener: () => {},
      release: () => {},
      query: async (sql: string, params: unknown[] = []) => {
        if (sql === 'BEGIN' || sql === 'COMMIT' || sql.startsWith('SAVEPOINT') || sql.startsWith('ROLLBACK TO')) {
          return { rows: [] };
        }
        if (sql === 'ROLLBACK') {
          if (claimed) storedKeys.delete(claimed);
          return { rows: [] };
        }
        if (sql.includes('INSERT INTO idempotency_keys')) {
          const [key, hash] = params as [string, string];
          if (storedKeys.has(key)) return { rows: [] };
          storedKeys.set(key, { request_hash: hash, status_code: null, response_body: null });
          claimed = key;
          return { rows: [{ key }] };
        }
        if (sql.includes('SELECT request_hash')) {
          const stored = storedKeys.get(params[0] as string);
          return { rows: stored ? [stored] : [] };
        }
        if (sql.includes('UPDATE idempotency_keys')) {
          const [key, statusCode, body] = params as [string, number, string];
          const stored = storedKeys.get(key);
          assert.ok(stored);
          stored.status_code = statusCode;
          stored.response_body = JSON.parse(body);
          return { rows: [] };
        }
        return (pool.query as unknown as (text: string, values: unknown[]) => Promise<unknown>)(sql, params);
      },
    };
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
    { method: 'GET', url: '/bookings?email=ada@example.com' },
    { method: 'GET', url: '/bookings/some-id' },
    { method: 'DELETE', url: '/bookings/some-id' },
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

// These prove how the route reacts to a violation. Only a real database can prove the index causes one.
describe('409: POST /bookings when the slot is already booked', () => {
  function databaseError(code: string, constraint: string): Error {
    return Object.assign(new Error('simulated database error'), { code, constraint });
  }

  test('a violation of one_confirmed_per_slot is 409', async () => {
    const { app } = createTestApp(undefined, { insertError: databaseError('23505', 'one_confirmed_per_slot') });

    const response = await app.inject(postBooking(validBooking));

    assert.equal(response.statusCode, 409);
    assert.deepEqual(response.json(), { error: 'slot already booked' });
  });

  test('a started slot is 400, without trying to insert', async () => {
    const { app, countInserts } = createTestApp([{ hasStarted: true }], {
      insertError: databaseError('23505', 'one_confirmed_per_slot'),
    });

    const response = await app.inject(postBooking(validBooking));

    assert.deepEqual(response.json(), { error: 'slot has already started' });
    assert.equal(countInserts(), 0);
  });

  for (const [label, insertError] of [
    ['a unique violation on another constraint', databaseError('23505', 'bookings_pkey')],
    ['another error on the same constraint', databaseError('23503', 'one_confirmed_per_slot')],
    ['a non-database error', new Error('simulated failure')],
  ] as const) {
    test(`${label} stays a 500`, async () => {
      const { app } = createTestApp(undefined, { insertError });

      const response = await app.inject(postBooking(validBooking));

      assert.equal(response.statusCode, 500);
      assert.deepEqual(response.json(), { error: 'internal server error' });
    });
  }
});

describe('POST /bookings: Idempotency-Key', () => {
  function keyedBooking(payload: object, key = 'key-1'): InjectOptions {
    return { ...postBooking(payload), headers: { ...validHeaders, 'idempotency-key': key } };
  }

  test('the same key and body replays the status and id, creating one booking', async () => {
    const { app, countInserts } = createTestApp();

    const first = await app.inject(keyedBooking(validBooking));
    const second = await app.inject(keyedBooking(validBooking));

    assert.equal(first.statusCode, 201);
    assert.equal(second.statusCode, 201);
    assert.equal(second.json().id, first.json().id);
    assert.deepEqual(second.json(), first.json());
    assert.equal(countInserts(), 1);
  });

  test('key order in the body does not matter', async () => {
    const { app, countInserts } = createTestApp();

    const first = await app.inject(keyedBooking(validBooking));
    const second = await app.inject(
      keyedBooking({ email: validBooking.email, name: validBooking.name, slot_id: validBooking.slot_id }),
    );

    assert.equal(second.statusCode, 201);
    assert.equal(second.json().id, first.json().id);
    assert.equal(countInserts(), 1);
  });

  test('the same key with a different body is 422', async () => {
    const { app, countInserts } = createTestApp();

    await app.inject(keyedBooking(validBooking));
    const second = await app.inject(keyedBooking({ ...validBooking, name: 'Someone Else' }));

    assert.equal(second.statusCode, 422);
    assert.equal(typeof second.json().error, 'string');
    assert.equal(countInserts(), 1);
  });

  test('a different key creates a separate booking', async () => {
    const { app, countInserts } = createTestApp();

    await app.inject(keyedBooking(validBooking, 'key-1'));
    await app.inject(keyedBooking(validBooking, 'key-2'));

    assert.equal(countInserts(), 2);
  });

  test('a stored 400 is replayed', async () => {
    const { app, query } = createTestApp();
    const invalid = { ...validBooking, name: '' };

    const first = await app.inject(keyedBooking(invalid));
    const callsAfterFirst = query.mock.callCount();
    const second = await app.inject(keyedBooking(invalid));

    assert.equal(first.statusCode, 400);
    assert.equal(second.statusCode, 400);
    assert.deepEqual(second.json(), first.json());
    assert.equal(query.mock.callCount(), callsAfterFirst);
  });

  test('a stored 409 is replayed without inserting again', async () => {
    const insertError = Object.assign(new Error('simulated'), { code: '23505', constraint: 'one_confirmed_per_slot' });
    const { app, countInserts } = createTestApp(undefined, { insertError });

    const first = await app.inject(keyedBooking(validBooking));
    const second = await app.inject(keyedBooking(validBooking));

    assert.equal(first.statusCode, 409);
    assert.equal(second.statusCode, 409);
    assert.deepEqual(second.json(), first.json());
    assert.equal(countInserts(), 1);
  });

  test('a 500 is not stored, so the key can be retried', async () => {
    const { app, countInserts } = createTestApp(undefined, { insertError: new Error('simulated failure') });

    const first = await app.inject(keyedBooking(validBooking));
    const second = await app.inject(keyedBooking(validBooking));

    assert.equal(first.statusCode, 500);
    assert.equal(second.statusCode, 500);
    assert.equal(countInserts(), 2);
  });

  test('a 401 touches nothing, even with a key', async () => {
    const { app, query, connect } = createTestApp();

    const response = await app.inject({
      method: 'POST',
      url: '/bookings',
      headers: { 'idempotency-key': 'key-1' },
      payload: validBooking,
    });

    assert.equal(response.statusCode, 401);
    assert.equal(query.mock.callCount(), 0);
    assert.equal(connect.mock.callCount(), 0);
  });

  for (const [label, headers] of [
    ['no key', validHeaders],
    ['an empty key', { ...validHeaders, 'idempotency-key': '' }],
  ] as const) {
    test(`${label} needs no transaction and is not idempotent`, async () => {
      const { app, connect, countInserts } = createTestApp();
      const request = { ...postBooking(validBooking), headers };

      await app.inject(request);
      await app.inject(request);

      assert.equal(connect.mock.callCount(), 0);
      assert.equal(countInserts(), 2);
    });
  }
});

describe('GET /bookings', () => {
  function listRow(id: string) {
    return {
      id,
      slot_id: 's1',
      name: 'Ada Obi',
      email: 'ada@example.com',
      status: 'confirmed',
      created_at: new Date('2026-11-05T12:00:00.123Z'),
      cursor_created_at: '2026-11-05T12:00:00.123456Z',
    };
  }

  function list(queryString: string): InjectOptions {
    return { method: 'GET', url: `/bookings?${queryString}`, headers: validHeaders };
  }

  function encodeCursor(value: unknown): string {
    return Buffer.from(JSON.stringify(value)).toString('base64url');
  }

  test('returns a page, without internal fields, and null on the last page', async () => {
    const { app } = createTestApp(undefined, { listRows: [listRow('b1')] });

    const response = await app.inject(list('email=ada@example.com'));

    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), {
      bookings: [
        {
          id: 'b1',
          slot_id: 's1',
          name: 'Ada Obi',
          email: 'ada@example.com',
          status: 'confirmed',
          created_at: '2026-11-05T12:00:00.123Z',
        },
      ],
      next_cursor: null,
    });
  });

  test('normalizes the email and asks for one row more than the default limit', async () => {
    const { app, query } = createTestApp();

    await app.inject(list(`email=${encodeURIComponent('  ADA@Example.COM ')}`));

    assert.deepEqual(query.mock.calls[0].arguments[1], ['ada@example.com', null, null, 11]);
  });

  test('an extra row means another page, whose cursor keeps the microseconds', async () => {
    const { app, query } = createTestApp(undefined, { listRows: [listRow('b1'), listRow('b2'), listRow('b3')] });

    const first = await app.inject(list('email=ada@example.com&limit=2'));
    const body = first.json();

    assert.deepEqual(
      body.bookings.map((booking: { id: string }) => booking.id),
      ['b1', 'b2'],
    );
    assert.equal(body.next_cursor, encodeCursor(['2026-11-05T12:00:00.123456Z', 'b2']));

    await app.inject(list(`email=ada@example.com&limit=2&cursor=${body.next_cursor}`));

    assert.deepEqual(query.mock.calls[1].arguments[1], [
      'ada@example.com',
      '2026-11-05T12:00:00.123456Z',
      'b2',
      3,
    ]);
  });

  for (const limit of ['1', '50']) {
    test(`limit ${limit} is accepted`, async () => {
      const { app } = createTestApp();

      const response = await app.inject(list(`email=ada@example.com&limit=${limit}`));

      assert.equal(response.statusCode, 200);
    });
  }

  for (const limit of ['0', '51', '-1', '1.5', 'abc', '', '1e1', '%2B5', '007']) {
    test(`limit "${limit}" is 400`, async () => {
      const { app, query } = createTestApp();

      const response = await app.inject(list(`email=ada@example.com&limit=${limit}`));

      assert.equal(response.statusCode, 400);
      assert.deepEqual(response.json(), { error: 'limit must be an integer from 1 to 50' });
      assert.equal(query.mock.callCount(), 0);
    });
  }

  test('a repeated limit is 400', async () => {
    const { app } = createTestApp();

    const response = await app.inject(list('email=ada@example.com&limit=1&limit=2'));

    assert.equal(response.statusCode, 400);
  });

  for (const queryString of ['', 'email=', 'email=%20%20', 'email=a@b.c&email=d@e.f']) {
    test(`query "${queryString}" is 400 for email`, async () => {
      const { app, query } = createTestApp();

      const response = await app.inject(list(queryString));

      assert.equal(response.statusCode, 400);
      assert.deepEqual(response.json(), { error: 'email is required' });
      assert.equal(query.mock.callCount(), 0);
    });
  }

  for (const [label, cursor] of [
    ['not base64 JSON', '!!!'],
    ['not an array', encodeCursor({ id: 'b1' })],
    ['the wrong length', encodeCursor(['2026-11-05T12:00:00.123456Z'])],
    ['a non-string id', encodeCursor(['2026-11-05T12:00:00.123456Z', 1])],
    ['a NUL in the id', encodeCursor(['2026-11-05T12:00:00.123456Z', 'b\0'])],
    ['a non-timestamp', encodeCursor(['yesterday', 'b1'])],
    ['an impossible date', encodeCursor(['2026-02-31T12:00:00.123456Z', 'b1'])],
    ['year zero', encodeCursor(['0000-01-01T12:00:00.123456Z', 'b1'])],
  ] as const) {
    test(`a cursor with ${label} is 400`, async () => {
      const { app, query } = createTestApp();

      const response = await app.inject(list(`email=ada@example.com&cursor=${encodeURIComponent(cursor)}`));

      assert.equal(response.statusCode, 400);
      assert.deepEqual(response.json(), { error: 'cursor is invalid' });
      assert.equal(query.mock.callCount(), 0);
    });
  }
});

describe('DELETE /bookings/{id}', () => {
  const cancelledRow = {
    id: 'b1',
    slot_id: 's1',
    name: 'Ada Obi',
    email: 'ada@example.com',
    status: 'cancelled',
    created_at: new Date('2026-11-05T12:00:00Z'),
  };
  const cancelRequest: InjectOptions = { method: 'DELETE', url: '/bookings/b1', headers: validHeaders };

  test('200 with the cancelled booking', async () => {
    const { app, query } = createTestApp(undefined, { cancelledRows: [cancelledRow] });

    const response = await app.inject(cancelRequest);
    const update = query.mock.calls[0];

    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), { ...cancelledRow, created_at: '2026-11-05T12:00:00Z' });
    assert.equal(query.mock.callCount(), 1);
    assert.match(String(update.arguments[0]), /WHERE id = \$1 AND status = 'confirmed'/);
    assert.deepEqual(update.arguments[1], ['b1']);
  });

  test('409 if already cancelled', async () => {
    const { app } = createTestApp(undefined, { existingRows: [{}] });

    const response = await app.inject(cancelRequest);

    assert.equal(response.statusCode, 409);
    assert.deepEqual(response.json(), { error: 'booking already cancelled' });
  });

  test('404 if not found', async () => {
    const { app } = createTestApp();

    const response = await app.inject(cancelRequest);

    assert.equal(response.statusCode, 404);
    assert.deepEqual(response.json(), { error: 'booking not found' });
  });

  test('a JSON Content-Type with no body still cancels', async () => {
    const { app } = createTestApp(undefined, { cancelledRows: [cancelledRow] });

    const response = await app.inject({
      ...cancelRequest,
      headers: { ...validHeaders, 'content-type': 'application/json' },
    });

    assert.equal(response.statusCode, 200);
    assert.equal(response.json().status, 'cancelled');
  });

  test('a JSON Content-Type with no key is still 401', async () => {
    const { app, query } = createTestApp();

    const response = await app.inject({
      method: 'DELETE',
      url: '/bookings/b1',
      headers: { 'content-type': 'application/json' },
    });

    assert.equal(response.statusCode, 401);
    assert.equal(query.mock.callCount(), 0);
  });
});
