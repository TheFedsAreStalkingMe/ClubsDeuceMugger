-- Saved API keys are now locked with the member's own password, so no server secret is needed.
-- Anything saved the old way (with a server secret) is dropped; members just save it again.

UPDATE users SET key_enc = NULL;
ALTER TABLE users ADD COLUMN key_salt TEXT;

-- The unlock key for this session, wrapped with a key made from the session cookie (never stored).
ALTER TABLE sessions ADD COLUMN vault_key TEXT;
