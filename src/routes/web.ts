import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { FastifyInstance, InjectOptions, LightMyRequestResponse } from 'fastify';

const pageFiles = [
  { url: '/', file: 'index.html', type: 'text/html; charset=utf-8' },
  { url: '/app.js', file: 'app.js', type: 'text/javascript; charset=utf-8' },
  { url: '/styles.css', file: 'styles.css', type: 'text/css; charset=utf-8' },
];

const contentSecurityPolicy = "default-src 'self'; img-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

// These need no X-API-Key, because a browser must never hold it. They only list slots and create
// bookings. /reset and cancelling have no route here, so they still require the key.
export const webRoutes: readonly string[] = [...pageFiles.map(({ url }) => url), '/web/slots', '/web/bookings'];

export function registerWebRoutes(app: FastifyInstance, apiKey: string): void {
  for (const { url, file, type } of pageFiles) {
    // Read once at start-up, so a missing file stops the deploy instead of breaking the page later.
    const content = readFileSync(path.join(process.cwd(), 'public', file), 'utf8');
    app.get(url, async (_request, reply) =>
      reply.type(type).header('Content-Security-Policy', contentSecurityPolicy).send(content),
    );
  }

  // The real routes handle these, so the page gets exactly the same rules and errors as API clients.
  async function callApi(options: InjectOptions): Promise<LightMyRequestResponse> {
    return app.inject({ ...options, headers: { ...options.headers, 'x-api-key': apiKey } });
  }

  app.get('/web/slots', async (_request, reply) => {
    const response = await callApi({ method: 'GET', url: '/slots' });
    return reply.code(response.statusCode).type('application/json').send(response.body);
  });

  app.post('/web/bookings', async (request, reply) => {
    const idempotencyKey = request.headers['idempotency-key'];

    const response = await callApi({
      method: 'POST',
      url: '/bookings',
      headers: {
        'content-type': 'application/json',
        ...(typeof idempotencyKey === 'string' ? { 'idempotency-key': idempotencyKey } : {}),
      },
      payload: JSON.stringify(request.body ?? {}),
    });

    const retryAfter = response.headers['retry-after'];
    if (retryAfter !== undefined) {
      reply.header('Retry-After', retryAfter);
    }
    return reply.code(response.statusCode).type('application/json').send(response.body);
  });
}
