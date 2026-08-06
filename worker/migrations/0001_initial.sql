CREATE TABLE members (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  character_name TEXT NOT NULL,
  world_name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL
);

CREATE TABLE events (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  starts_at TEXT NOT NULL,
  ends_at TEXT,
  created_by_member_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (created_by_member_id) REFERENCES members(id) ON DELETE CASCADE
);

CREATE INDEX events_starts_at_idx ON events(starts_at);

CREATE TABLE registrations (
  event_id TEXT NOT NULL,
  member_id TEXT NOT NULL,
  character_name TEXT NOT NULL,
  world_name TEXT NOT NULL,
  registered_at TEXT NOT NULL,
  PRIMARY KEY (event_id, member_id),
  FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE CASCADE,
  FOREIGN KEY (member_id) REFERENCES members(id) ON DELETE CASCADE
);
