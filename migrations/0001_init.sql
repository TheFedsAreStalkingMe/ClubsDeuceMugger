-- Clubs Deuce Mugger: initial schema

CREATE TABLE users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT    NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT    NOT NULL,           -- base64 PBKDF2-SHA256 output
  salt          TEXT    NOT NULL,           -- base64 random 16-byte salt
  iterations    INTEGER NOT NULL,
  status        TEXT    NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'active')),
  created_at    INTEGER NOT NULL,           -- unix seconds
  approved_at   INTEGER
);

CREATE TABLE sessions (
  token_hash TEXT    PRIMARY KEY,           -- SHA-256 of the cookie token
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX idx_sessions_user    ON sessions(user_id);
CREATE INDEX idx_sessions_expires ON sessions(expires_at);

CREATE TABLE approval_tokens (
  token_hash TEXT    PRIMARY KEY,           -- SHA-256 of the emailed token
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  action     TEXT    NOT NULL CHECK (action IN ('approve', 'deny')),
  expires_at INTEGER NOT NULL
);
CREATE INDEX idx_approval_user    ON approval_tokens(user_id);
CREATE INDEX idx_approval_expires ON approval_tokens(expires_at);

CREATE TABLE rate_limits (
  key        TEXT    PRIMARY KEY,           -- "<bucket>:<id>:<window start>"
  count      INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX idx_rate_expires ON rate_limits(expires_at);
