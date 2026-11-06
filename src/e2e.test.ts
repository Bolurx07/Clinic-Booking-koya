// End-to-end tests against a running server, normally the deployed one. See "Tests" in the README.
//
// WARNING: these call POST /reset, which deletes every booking and replaces every slot on the target.
// BASE_URL and API_KEY must be set by hand. .env is never read, so a run can't pick a target by accident.

import assert from 'node:assert/strict';
import { before, beforeEach, describe, test } from 'node:test';

const baseUrl = process.env.BASE_URL?.replace(/\/+$/, '');
const apiKey = process.env.API_KEY;
if (!baseUrl || !apiKey) {
  throw new Error('Set BASE_URL and API_KEY to run the end-to-end tests. They wipe the data on the target.');
}

interface ApiResponse {
  status: number;
  text: string;
  // Tests assert the shape of each response, so a precise type would add nothing here.
  json: any; // eslint-disable-line @typescript-eslint/no-explicit-any
  headers: Headers;
}

interface CallOptions {
  body?: unknown;
  headers?: Record<string, string>;
  apiKey?: string | null;
}

async function call(method: string, path: string, options: CallOptions = {}): Promise<ApiResponse> {
  const key = options.apiKey === undefined ? apiKey : options.apiKey;
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      ...(key === null ? {} : { 'x-api-key': key }),
      ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
      ...options.headers,
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const text = await response.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  return { status: response.status, text, json, headers: response.headers };
}

function assertError(response: ApiResponse, status: number): void {
  assert.equal(response.status, status, response.text);
  assert.equal(typeof response.json?.error, 'string', response.text);
  assert.deepEqual(Object.keys(response.json), ['error']);
}

function countStatuses(responses: ApiResponse[]): Record<number, number> {
  const counts: Record<number, number> = {};
  for (const { status } of responses) counts[status] = (counts[status] ?? 0) + 1;
  return counts;
}

function makeSlot(id: string, provider = 'Dr Ade', hoursAhead = 24 * 30) {
  const start = new Date(Date.now() + hoursAhead * 3_600_000);
  start.setUTCMinutes(0, 0, 0);
  const end = new Date(start.getTime() + 30 * 60_000);
  return { id, provider, start: start.toISOString(), end: end.toISOString() };
}

const pastSlot = { id: 'past', provider: 'Dr Ade', start: '2020-01-01T09:00:00Z', end: '2020-01-01T09:30:00Z' };
const standardSlots = [...Array.from({ length: 30 }, (_, i) => makeSlot(`s${i}`, 'Dr Ade', 24 * 30 + i)), pastSlot];

let emailCounter = 0;
// The rate limit is per email, so a test only shares an email when that is what it is checking.
function freshEmail(): string {
  emailCounter += 1;
  return `e2e-${emailCounter}-${Date.now()}@example.com`;
}

function newBooking(slotId: string, email = freshEmail(), name = 'Ada Obi') {
  return { slot_id: slotId, name, email };
}

const book = (body: unknown, headers: Record<string, string> = {}) => call('POST', '/bookings', { body, headers });
const withKey = (key: string) => ({ 'idempotency-key': key });

async function reset(slots: unknown[] = standardSlots): Promise<void> {
  const response = await call('POST', '/reset', { body: { slots } });
  assert.equal(response.status, 200, response.text);
}

before(async () => {
  // A sleeping free-tier host can take a while to wake, so this waits before anything is measured.
  const response = await call('GET', '/health', { apiKey: null });
  assert.equal(response.status, 200, response.text);
});

beforeEach(() => reset());

describe('401: every endpoint needs X-API-Key', () => {
  const routes: [string, string, unknown][] = [
    ['POST', '/reset', { slots: [] }],
    ['GET', '/slots', undefined],
    ['POST', '/bookings', newBooking('s0')],
    ['GET', '/bookings?email=a@example.com', undefined],
    ['GET', '/bookings/some-id', undefined],
    ['DELETE', '/bookings/some-id', undefined],
  ];

  for (const [method, path, body] of routes) {
    for (const [label, key] of [
      ['missing', null],
      ['wrong', 'wrong-key'],
    ] as const) {
      test(`${method} ${path}: ${label} key`, async () => {
        assertError(await call(method, path, { body, apiKey: key }), 401);
      });
    }
  }

  test('401 comes before idempotency and validation', async () => {
    assertError(await call('POST', '/bookings', { body: {}, headers: withKey('k'), apiKey: 'wrong-key' }), 401);
  });
});

describe('POST /reset and GET /slots', () => {
  test('replaces slots, past ones included, and deletes bookings', async () => {
    const created = await book(newBooking('s0'));
    assert.equal(created.status, 201);

    await reset([makeSlot('only'), pastSlot]);

    const slots = await call('GET', '/slots');
    assert.deepEqual(slots.json.slots.map((slot: { id: string }) => slot.id).sort(), ['only', 'past']);
    assertError(await call('GET', `/bookings/${created.json.id}`), 404);
  });

  test('sorts earliest first and returns UTC timestamps', async () => {
    await reset([makeSlot('later', 'Dr Ade', 48), makeSlot('sooner', 'Dr Ade', 24)]);

    const { json } = await call('GET', '/slots');

    assert.deepEqual(json.slots.map((slot: { id: string }) => slot.id), ['sooner', 'later']);
    assert.match(json.slots[0].start, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/);
  });

  test('the provider filter is an exact match', async () => {
    await reset([makeSlot('a', 'Dr Ade'), makeSlot('b', 'Dr Bello'), makeSlot('c', 'Dr Ade Jr')]);

    const { json } = await call('GET', '/slots?provider=Dr%20Ade');

    assert.deepEqual(json.slots.map((slot: { id: string }) => slot.id), ['a']);
  });

  test('available is false only while a booking is confirmed', async () => {
    const isAvailable = async () =>
      (await call('GET', '/slots')).json.slots.find((slot: { id: string }) => slot.id === 's0').available;

    assert.equal(await isAvailable(), true);
    const { json: booking } = await book(newBooking('s0'));
    assert.equal(await isAvailable(), false);
    await call('DELETE', `/bookings/${booking.id}`);
    assert.equal(await isAvailable(), true);
  });

  test('a duplicate slot id is 400 and changes nothing', async () => {
    await reset([makeSlot('keep')]);

    assertError(await call('POST', '/reset', { body: { slots: [makeSlot('x'), makeSlot('x')] } }), 400);

    const { json } = await call('GET', '/slots');
    assert.deepEqual(json.slots.map((slot: { id: string }) => slot.id), ['keep']);
  });

  test('a body with no slots is 400', async () => {
    assertError(await call('POST', '/reset', { body: {} }), 400);
  });

  test('clears idempotency keys and rate-limit attempts', async () => {
    const email = freshEmail();
    await book(newBooking('s0', email), withKey('reused-key'));
    for (let i = 1; i < 5; i++) await book(newBooking(`s${i}`, email));
    assertError(await book(newBooking('s5', email)), 429);

    await reset();

    const afterReset = await book(newBooking('s6', email), withKey('reused-key'));
    assert.equal(afterReset.status, 201, afterReset.text);
  });
});

describe('POST /bookings: 201 and GET /bookings/{id}', () => {
  test('creates a confirmed booking that can be looked up', async () => {
    const created = await book({ slot_id: 's0', name: '  Ada Obi ', email: '  ADA@Example.COM ' });

    assert.equal(created.status, 201, created.text);
    assert.equal(created.json.slot_id, 's0');
    assert.equal(created.json.name, 'Ada Obi');
    assert.equal(created.json.email, 'ada@example.com');
    assert.equal(created.json.status, 'confirmed');
    assert.match(created.json.created_at, /Z$/);

    const found = await call('GET', `/bookings/${created.json.id}`);
    assert.equal(found.status, 200);
    assert.deepEqual(found.json, created.json);
  });

  test('an unknown booking id is 404', async () => {
    assertError(await call('GET', '/bookings/does-not-exist'), 404);
  });
});

describe('POST /bookings: 400 and 404', () => {
  for (const field of ['slot_id', 'name', 'email'] as const) {
    test(`${field} missing, empty or only spaces`, async () => {
      const valid = newBooking('s0');
      const { [field]: _omitted, ...without } = valid;

      assertError(await book(without), 400);
      assertError(await book({ ...newBooking('s0'), [field]: '' }), 400);
      assertError(await book({ ...newBooking('s0'), [field]: '   ' }), 400);
    });
  }

  for (const email of ['not-an-email', 'a@b', '@b.c', 'a b@c.d']) {
    test(`invalid email "${email}"`, async () => {
      assertError(await book(newBooking('s0', email)), 400);
    });
  }

  test('malformed JSON', async () => {
    const response = await fetch(`${baseUrl}/bookings`, {
      method: 'POST',
      headers: { 'x-api-key': apiKey, 'content-type': 'application/json' },
      body: '{oops',
    });
    assert.equal(response.status, 400);
    assert.equal(typeof (await response.json()).error, 'string');
  });

  test('an unknown slot is 404', async () => {
    assertError(await book(newBooking('no-such-slot')), 404);
  });

  test('a slot that has already started is 400', async () => {
    assertError(await book(newBooking('past')), 400);
  });

  test('field errors come before slot errors', async () => {
    const response = await book({ slot_id: 'no-such-slot', name: '', email: freshEmail() });
    assertError(response, 400);
  });

  test('a null character is 400, not 500', async () => {
    assertError(await book({ slot_id: 's0', name: 'a\u0000b', email: freshEmail() }), 400);
    assertError(await book({ slot_id: 's0\u0000', name: 'Ada', email: freshEmail() }), 400);
    assertError(await book({ slot_id: 's0', name: 'Ada', email: `a\u0000${freshEmail()}` }), 400);
    assertError(await call('GET', '/bookings/a%00b'), 400);
    assertError(await call('DELETE', '/bookings/a%00b'), 400);
    assertError(await call('GET', '/slots?provider=a%00b'), 400);
    assertError(await call('GET', '/bookings?email=a%00b'), 400);
    assertError(await call('POST', '/reset', { body: { slots: [makeSlot('a\u0000b')] } }), 400);
  });
});

describe('409: concurrency and cancellation', () => {
  test('20 parallel bookings for one slot: one 201, nineteen 409', async () => {
    const responses = await Promise.all(Array.from({ length: 20 }, () => book(newBooking('s0'))));

    assert.deepEqual(countStatuses(responses), { 201: 1, 409: 19 });
    for (const response of responses.filter(({ status }) => status === 409)) assertError(response, 409);
  });

  test('cancelling frees the slot, which can then be rebooked', async () => {
    const { json: first } = await book(newBooking('s0'));
    assertError(await book(newBooking('s0')), 409);

    const cancelled = await call('DELETE', `/bookings/${first.id}`);
    assert.equal(cancelled.status, 200, cancelled.text);
    assert.equal(cancelled.json.status, 'cancelled');
    assert.equal((await call('GET', `/bookings/${first.id}`)).json.status, 'cancelled');

    const second = await book(newBooking('s0'));
    assert.equal(second.status, 201, second.text);
    assert.notEqual(second.json.id, first.id);
  });

  test('cancelling twice is 409, and an unknown id is 404', async () => {
    const { json: booking } = await book(newBooking('s0'));

    await call('DELETE', `/bookings/${booking.id}`);

    assertError(await call('DELETE', `/bookings/${booking.id}`), 409);
    assertError(await call('DELETE', '/bookings/does-not-exist'), 404);
  });

  test('two parallel cancels: one 200, one 409', async () => {
    const { json: booking } = await book(newBooking('s0'));

    const responses = await Promise.all([
      call('DELETE', `/bookings/${booking.id}`),
      call('DELETE', `/bookings/${booking.id}`),
    ]);

    assert.deepEqual(countStatuses(responses), { 200: 1, 409: 1 });
  });
});

describe('422: Idempotency-Key', () => {
  test('a retry replays the same status and body, creating one booking', async () => {
    const body = newBooking('s0');

    const first = await book(body, withKey('retry'));
    const retry = await book(body, withKey('retry'));

    assert.equal(first.status, 201, first.text);
    assert.equal(retry.status, 201);
    assert.equal(retry.text, first.text);
    const list = await call('GET', `/bookings?email=${encodeURIComponent(body.email)}`);
    assert.equal(list.json.bookings.length, 1);
  });

  test('key order in the body does not matter', async () => {
    const body = newBooking('s0');

    const first = await book(body, withKey('order'));
    const retry = await book({ email: body.email, name: body.name, slot_id: body.slot_id }, withKey('order'));

    assert.equal(retry.json.id, first.json.id);
  });

  test('the same key with a different body is 422', async () => {
    await book(newBooking('s0'), withKey('reused'));

    assertError(await book(newBooking('s1'), withKey('reused')), 422);

    const slots = (await call('GET', '/slots')).json.slots;
    assert.equal(slots.find((slot: { id: string }) => slot.id === 's1').available, true);
  });

  test('20 parallel requests with one key: all 201 with one id', async () => {
    const body = newBooking('s0');

    const responses = await Promise.all(Array.from({ length: 20 }, () => book(body, withKey('parallel'))));

    assert.deepEqual(countStatuses(responses), { 201: 20 });
    assert.equal(new Set(responses.map(({ json }) => json.id)).size, 1);
  });

  test('20 parallel requests with different keys on one slot: one 201, nineteen 409', async () => {
    const responses = await Promise.all(
      Array.from({ length: 20 }, (_, i) => book(newBooking('s0'), withKey(`different-${i}`))),
    );

    assert.deepEqual(countStatuses(responses), { 201: 1, 409: 19 });
  });

  for (const [label, makeBody, status] of [
    ['a 400', () => newBooking('s0', 'not-an-email-for-replay'), 400],
    ['a 404', () => newBooking('no-such-slot'), 404],
    ['a started-slot 400', () => newBooking('past'), 400],
  ] as const) {
    test(`${label} is stored and replayed`, async () => {
      const body = makeBody();

      const first = await book(body, withKey('stored'));
      const retry = await book(body, withKey('stored'));

      assert.equal(first.status, status);
      assert.equal(retry.status, status);
      assert.equal(retry.text, first.text);
    });
  }

  test('a stored 409 is replayed even after the slot is freed', async () => {
    const { json: winner } = await book(newBooking('s0'));
    const body = newBooking('s0');
    assertError(await book(body, withKey('conflict')), 409);

    await call('DELETE', `/bookings/${winner.id}`);

    assertError(await book(body, withKey('conflict')), 409);
  });

  test('an empty key counts as no key', async () => {
    const body = newBooking('s0');

    assert.equal((await book(body, withKey(''))).status, 201);
    assertError(await book(body, withKey('')), 409);
  });
});

describe('GET /bookings: pagination', () => {
  test('pages oldest first, ignores email case, and ends with null', async () => {
    const email = freshEmail();
    for (let i = 0; i < 5; i++) {
      assert.equal((await book(newBooking(`s${i}`, email))).status, 201);
    }

    const pages = [];
    let cursor: string | null = null;
    do {
      const query: string = `email=${encodeURIComponent(email.toUpperCase())}&limit=2${
        cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''
      }`;
      const page: ApiResponse = await call('GET', `/bookings?${query}`);
      assert.equal(page.status, 200, page.text);
      pages.push(page.json.bookings);
      cursor = page.json.next_cursor;
    } while (cursor);

    assert.deepEqual(pages.map((page) => page.length), [2, 2, 1]);
    assert.deepEqual(pages.flat().map((booking) => booking.slot_id), ['s0', 's1', 's2', 's3', 's4']);
  });

  test('the default limit is 10, an exact full page has no next page, and no match is empty', async () => {
    const email = freshEmail();
    for (let i = 0; i < 5; i++) await book(newBooking(`s${i}`, email));

    const fullPage = await call('GET', `/bookings?email=${encodeURIComponent(email)}&limit=5`);
    assert.equal(fullPage.json.bookings.length, 5);
    assert.equal(fullPage.json.next_cursor, null);

    const defaulted = await call('GET', `/bookings?email=${encodeURIComponent(email)}`);
    assert.equal(defaulted.json.bookings.length, 5);

    const none = await call('GET', `/bookings?email=${encodeURIComponent(freshEmail())}`);
    assert.deepEqual(none.json, { bookings: [], next_cursor: null });
  });

  test('cancelled bookings are included', async () => {
    const email = freshEmail();
    const { json: booking } = await book(newBooking('s0', email));
    await call('DELETE', `/bookings/${booking.id}`);

    const { json } = await call('GET', `/bookings?email=${encodeURIComponent(email)}`);

    assert.equal(json.bookings[0].status, 'cancelled');
  });

  for (const query of [
    'email=a@example.com&limit=0',
    'email=a@example.com&limit=51',
    'email=a@example.com&limit=abc',
    'email=a@example.com&limit=1.5',
    'email=a@example.com&limit=',
    'limit=5',
    'email=',
    'email=a@example.com&cursor=not-a-cursor',
  ]) {
    test(`400: ${query}`, async () => {
      assertError(await call('GET', `/bookings?${query}`), 400);
    });
  }

  // 25 bookings for one email take over 4 minutes at 5 per minute, so this only runs when asked for.
  test(
    '25 bookings at limit=10 page 10, 10, 5, then null',
    { skip: process.env.E2E_LONG ? false : 'set E2E_LONG=1 to run: takes over 4 minutes' },
    async () => {
      const email = freshEmail();
      for (let i = 0; i < 25; i++) {
        let response = await book(newBooking(`s${i}`, email));
        if (response.status === 429) {
          await sleep(Number(response.headers.get('retry-after')) * 1000 + 250);
          response = await book(newBooking(`s${i}`, email));
        }
        assert.equal(response.status, 201, response.text);
      }

      const sizes = [];
      const ids = new Set<string>();
      let cursor: string | null = null;
      do {
        const query: string = `email=${encodeURIComponent(email)}&limit=10${
          cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''
        }`;
        const page: ApiResponse = await call('GET', `/bookings?${query}`);
        sizes.push(page.json.bookings.length);
        for (const booking of page.json.bookings) ids.add(booking.id);
        cursor = page.json.next_cursor;
      } while (cursor);

      assert.deepEqual(sizes, [10, 10, 5]);
      assert.equal(ids.size, 25);
    },
  );
});

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('429: rate limit', () => {
  async function useUpAttempts(email: string): Promise<void> {
    for (let i = 0; i < 5; i++) {
      assert.equal((await book(newBooking(`s${i}`, email))).status, 201);
    }
  }

  test('the 6th attempt is 429 with Retry-After, and another email still gets through', async () => {
    const email = freshEmail();
    await useUpAttempts(email);

    const sixth = await book(newBooking('s5', email));

    assertError(sixth, 429);
    assert.match(sixth.headers.get('retry-after') ?? '', /^\d+$/);
    const retryAfter = Number(sixth.headers.get('retry-after'));
    assert.ok(retryAfter >= 1 && retryAfter <= 60, String(retryAfter));
    assert.equal((await book(newBooking('s5'))).status, 201);
  });

  test('the same email in a different case counts together', async () => {
    const email = freshEmail();
    await useUpAttempts(email);

    assertError(await book(newBooking('s5', `  ${email.toUpperCase()} `)), 429);
  });

  test('failed attempts count', async () => {
    const email = freshEmail();
    assert.equal((await book(newBooking('s0'))).status, 201);

    assertError(await book({ slot_id: 's1', name: '', email }), 400);
    assertError(await book(newBooking('no-such-slot', email)), 404);
    assertError(await book(newBooking('past', email)), 400);
    assertError(await book(newBooking('s0', email)), 409);
    assertError(await book({ name: 'Ada', email }), 400);

    assertError(await book(newBooking('s1', email)), 429);
  });

  test('a badly formed email is limited too', async () => {
    for (let i = 0; i < 5; i++) assertError(await book(newBooking('s0', 'not-an-email')), 400);

    assertError(await book(newBooking('s0', 'not-an-email')), 429);
  });

  test('20 parallel attempts for one email: five 201, fifteen 429', async () => {
    const email = freshEmail();

    const responses = await Promise.all(Array.from({ length: 20 }, (_, i) => book(newBooking(`s${i}`, email))));

    assert.deepEqual(countStatuses(responses), { 201: 5, 429: 15 });
  });

  test('replays do not count, and work at the limit', async () => {
    const email = freshEmail();
    const body = newBooking('s0', email);
    const first = await book(body, withKey('replay'));
    for (let i = 0; i < 10; i++) await book(body, withKey('replay'));
    for (let i = 1; i < 5; i++) assert.equal((await book(newBooking(`s${i}`, email))).status, 201);
    assertError(await book(newBooking('s5', email)), 429);

    const replay = await book(body, withKey('replay'));

    assert.equal(replay.status, 201);
    assert.equal(replay.json.id, first.json.id);
  });

  test('a reused key with a different body is 422 at the limit, not 429', async () => {
    const email = freshEmail();
    await book(newBooking('s0', email), withKey('reused'));
    for (let i = 1; i < 5; i++) await book(newBooking(`s${i}`, email));

    assertError(await book(newBooking('s9', email), withKey('reused')), 422);
  });

  test('blocked attempts do not extend the wait, and a 429 is not stored', async () => {
    const email = freshEmail();
    await useUpAttempts(email);
    const body = newBooking('s5', email);

    const blocked = await book(body, withKey('blocked'));
    assertError(blocked, 429);
    await book(newBooking('s6', email));

    await sleep(Number(blocked.headers.get('retry-after')) * 1000 + 250);

    const retried = await book(body, withKey('blocked'));
    assert.equal(retried.status, 201, retried.text);
  });
});

describe('web page', () => {
  test('the page and its files are public and never contain the key', async () => {
    for (const path of ['/', '/app.js', '/styles.css']) {
      const response = await call('GET', path, { apiKey: null });
      assert.equal(response.status, 200, path);
      assert.ok(!response.text.includes(apiKey), `${path} contains the API key`);
    }
  });

  test('the page routes work with no key, with the same rules', async () => {
    const options = (body: unknown) => ({ body, apiKey: null });
    const email = freshEmail();

    const slots = await call('GET', '/web/slots', { apiKey: null });
    assert.equal(slots.status, 200);
    assert.equal(slots.json.slots.length, standardSlots.length);

    const created = await call('POST', '/web/bookings', options(newBooking('s0', email)));
    assert.equal(created.status, 201, created.text);
    assertError(await call('POST', '/web/bookings', options(newBooking('s0'))), 409);
    assertError(await call('POST', '/web/bookings', options(newBooking('no-such-slot'))), 404);
    assertError(await call('POST', '/web/bookings', options(newBooking('s1', 'not-an-email'))), 400);

    for (let i = 1; i < 5; i++) await call('POST', '/web/bookings', options(newBooking(`s${i}`, email)));
    const limited = await call('POST', '/web/bookings', options(newBooking('s5', email)));
    assertError(limited, 429);
    assert.ok(Number(limited.headers.get('retry-after')) >= 1);
  });

  test('the page routes give no way to cancel or reset', async () => {
    assertError(await call('POST', '/web/reset', { body: { slots: [] }, apiKey: null }), 401);
    assertError(await call('DELETE', '/web/bookings/some-id', { apiKey: null }), 401);
  });
});
