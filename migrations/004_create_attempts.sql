-- One row per POST /bookings attempt inside the rate-limit window. Older rows are pruned as they expire.
CREATE TABLE attempts (
  email text NOT NULL,
  at timestamptz NOT NULL
);

CREATE INDEX attempts_email_at ON attempts(email, at);
