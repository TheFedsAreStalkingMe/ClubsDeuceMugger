-- Background search: a member can let the site run the Inactive Earners search on a schedule while their page is closed,
-- and email them the best targets. The Torn key is sealed (AES-GCM) with a Worker secret (BG_SECRET) so the scheduled
-- job can use it; it is deleted when the member turns the search off.
CREATE TABLE bg_hunts (
  user_id    INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  enabled    INTEGER NOT NULL DEFAULT 1,
  key_enc    TEXT    NOT NULL,
  config     TEXT    NOT NULL,           -- filters, wages, mug bonuses, alert threshold (JSON)
  state      TEXT    NOT NULL DEFAULT '{}', -- where the search is up to, candidates, who was already emailed (JSON)
  last_run   INTEGER NOT NULL DEFAULT 0,
  last_msg   TEXT    NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_bg_hunts_run ON bg_hunts(enabled, last_run);
