-- Username-vouch signup (no approval links), account emails, password recovery

DROP TABLE approval_tokens;

CREATE TABLE password_resets (
  token_hash TEXT    PRIMARY KEY,           -- SHA-256 of the emailed token
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);
CREATE INDEX idx_resets_user    ON password_resets(user_id);
CREATE INDEX idx_resets_expires ON password_resets(expires_at);

CREATE UNIQUE INDEX idx_users_email ON users(lower(email)) WHERE email IS NOT NULL;
