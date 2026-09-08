-- NeoJutsu database.
-- Projects are seed-based, so `data` holds a few KB of JSON rather than media.

CREATE TABLE IF NOT EXISTS users (
  id         TEXT PRIMARY KEY,          -- Google account id (sub)
  email      TEXT NOT NULL DEFAULT '',
  name       TEXT NOT NULL DEFAULT '',
  picture    TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  seen_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS projects (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL CHECK (kind IN ('audio', 'video', 'game')),
  title      TEXT NOT NULL,
  slug       TEXT NOT NULL,
  data       TEXT NOT NULL,
  public     INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS projects_by_user ON projects (user_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS projects_by_kind ON projects (user_id, kind, updated_at DESC);
