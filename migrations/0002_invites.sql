-- Invite-only signup, sponsor email flow, member emails

ALTER TABLE users ADD COLUMN email TEXT;
ALTER TABLE users ADD COLUMN invited_by INTEGER REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE users ADD COLUMN approval_sent INTEGER NOT NULL DEFAULT 0;

-- Existing accounts (made before invites existed) never need the sponsor step.
UPDATE users SET approval_sent = 1;

CREATE TABLE invites (
  token_hash TEXT    PRIMARY KEY,           -- SHA-256 of the invite token in the link
  inviter_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_by    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  used_at    INTEGER
);
CREATE INDEX idx_invites_inviter ON invites(inviter_id);

-- Lets an applicant finish the "who invited you?" step.
CREATE TABLE apply_sessions (
  token_hash TEXT    PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);
CREATE INDEX idx_apply_user ON apply_sessions(user_id);
