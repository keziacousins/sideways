-- Space-level watch subscriptions
CREATE TABLE space_watches (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  space_id uuid NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, space_id)
);
CREATE INDEX space_watches_space_idx ON space_watches(space_id);
