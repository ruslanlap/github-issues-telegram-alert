CREATE TABLE IF NOT EXISTS deliveries (id TEXT PRIMARY KEY, event TEXT NOT NULL, payload TEXT NOT NULL, status TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, next_at INTEGER NOT NULL DEFAULT 0, lease_until INTEGER NOT NULL DEFAULT 0);
CREATE INDEX IF NOT EXISTS deliveries_pending ON deliveries(status, next_at, lease_until);
CREATE TABLE IF NOT EXISTS messages (chat_id TEXT NOT NULL, message_id INTEGER NOT NULL, owner TEXT NOT NULL, repo TEXT NOT NULL, issue_number INTEGER NOT NULL, installation INTEGER NOT NULL, PRIMARY KEY(chat_id, message_id));
CREATE TABLE IF NOT EXISTS updates (id TEXT PRIMARY KEY, status TEXT NOT NULL, lease_until INTEGER NOT NULL);
