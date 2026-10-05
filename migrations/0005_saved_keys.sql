-- Optional: a member's API keys, encrypted (AES-GCM) with a Worker secret. NULL = not saved.
ALTER TABLE users ADD COLUMN key_enc TEXT;
