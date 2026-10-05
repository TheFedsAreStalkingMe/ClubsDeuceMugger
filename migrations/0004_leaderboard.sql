-- Mugging leaderboard: link members to their Torn player, track Attack clicks, record verified mugs

ALTER TABLE users ADD COLUMN torn_id INTEGER;
ALTER TABLE users ADD COLUMN torn_name TEXT;
CREATE UNIQUE INDEX idx_users_torn_id ON users(torn_id) WHERE torn_id IS NOT NULL;

-- Each time a member taps Attack on a card
CREATE TABLE clicks (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  target_id  INTEGER NOT NULL,
  clicked_at INTEGER NOT NULL,
  matched    INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_clicks_user ON clicks(user_id, matched, clicked_at);

-- Mugs verified against Torn's attack log. One row per attack, so nothing counts twice.
CREATE TABLE mugs (
  attack_code TEXT    PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  target_id   INTEGER NOT NULL,
  amount      INTEGER NOT NULL,
  mugged_at   INTEGER NOT NULL
);
CREATE INDEX idx_mugs_user ON mugs(user_id);
CREATE INDEX idx_mugs_time ON mugs(mugged_at);
