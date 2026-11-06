-- status_code and response_body are NULL only inside the transaction that claimed the key.
-- Other transactions wait for that one to finish, so they never see the NULLs.
-- json rather than jsonb: jsonb reorders keys, and a replay should match the original response.
CREATE TABLE idempotency_keys (
  key text PRIMARY KEY,
  request_hash text NOT NULL,
  status_code integer,
  response_body json,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Serves GET /bookings: one person's bookings in (created_at, id) order.
CREATE INDEX bookings_email_created_at_id ON bookings(email, created_at, id);
