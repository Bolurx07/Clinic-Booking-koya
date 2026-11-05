CREATE TABLE slots (
  id text PRIMARY KEY,
  provider text NOT NULL,
  start timestamptz NOT NULL,
  "end" timestamptz NOT NULL
);

CREATE TABLE bookings (
  id text PRIMARY KEY,
  slot_id text NOT NULL REFERENCES slots(id),
  name text NOT NULL,
  email text NOT NULL,
  status text NOT NULL CHECK (status IN ('confirmed', 'cancelled')),
  created_at timestamptz NOT NULL DEFAULT now()
);
