ALTER TABLE events ADD COLUMN source TEXT NOT NULL DEFAULT 'manual';
ALTER TABLE events ADD COLUMN external_event_id TEXT;
ALTER TABLE events ADD COLUMN external_channel_id TEXT;

CREATE UNIQUE INDEX events_external_event_id_idx ON events(external_event_id);

INSERT OR IGNORE INTO members (id, token_hash, character_name, world_name, created_at, last_seen_at)
VALUES ('raid-helper', 'raid-helper-system', 'Raid Helper', 'Discord', '1970-01-01T00:00:00.000Z', '1970-01-01T00:00:00.000Z');
